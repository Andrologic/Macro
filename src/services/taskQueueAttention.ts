import type { ChatMessage, ConversationQuestionnaireDraft, TaskStatus } from '../types';
import { resolveActiveConversationQuestionnaire } from './chatQuestionnaires';
import type { MergeWorkflowRuntimeState } from './mergeWorkflow';
import type { MergeWorkflowSummary } from './mergeWorkflowPersistence';
import { resolveTaskMergeWorkflowPresentationState } from './taskMergeWorkflowPresentation';
import { resolveTaskReference } from './durableIdentity';

interface AttentionTask {
  id: string;
  node_id?: string | null;
  conversation_id?: string | null;
  status: TaskStatus;
  archived_at?: string | null;
  is_blocked?: boolean;
  merge_workflow_summary?: MergeWorkflowSummary | null;
}

export interface TaskQueueAttention {
  kind: 'approval' | 'questionnaire' | 'reply' | 'review';
  conversationId: string | null;
}

export interface TaskQueueAttentionInput {
  tasks: AttentionTask[];
  conversations: Array<{ id: string; task_id?: string | null; scope_mode?: string | null }>;
  messages?: ChatMessage[];
  messagesByConversationId?: Record<string, ChatMessage[]>;
  requestStateByConversationId?: Record<string, ConversationRequestState>;
  questionnaireDraftsByConversationId: Record<string, ConversationQuestionnaireDraft>;
  pendingToolApprovalByConversationId: Record<string, unknown>;
  runningTaskIds: Set<string>;
  mergeWorkflowRuntimeByTaskId?: Record<string, MergeWorkflowRuntimeState | undefined>;
}

export type ConversationRequestState = 'pending' | 'resolved' | 'unknown';

// Only semantic request changes affect the queue, never ordinary text fragments.
export const selectTaskQueueRequestSignature = (state: Pick<TaskQueueAttentionInput,
  'messages' | 'messagesByConversationId' | 'questionnaireDraftsByConversationId'>): string => {
  const transcripts = { ...state.messagesByConversationId };
  for (const message of state.messages ?? []) {
    if (!state.messagesByConversationId?.[message.conversation_id]) {
      (transcripts[message.conversation_id] ??= []).push(message);
    }
  }
  return JSON.stringify(Object.entries(transcripts).map(([id, transcript]) => {
    const pending = resolveActiveConversationQuestionnaire(id, transcript)?.mode === 'pending_reply';
    let sawReply = false;
    let resolved = false;
    for (let index = transcript.length - 1; index >= 0; index--) {
      const message = transcript[index]!;
      if (message.role === 'user') sawReply = true;
      if (message.role === 'assistant' && message.questionnaire) {
        resolved = sawReply;
        break;
      }
    }
    return [id, pending ? 'pending' : resolved ? 'resolved' : 'unknown'];
  }).sort(([left], [right]) => left!.localeCompare(right!)));
};

// Derive one row per task from durable links, including before transcripts load.
export const resolveTaskQueueSupervision = ({
  tasks, conversations, messages = [], messagesByConversationId = {}, requestStateByConversationId,
  questionnaireDraftsByConversationId, pendingToolApprovalByConversationId, runningTaskIds, mergeWorkflowRuntimeByTaskId = {},
}: TaskQueueAttentionInput): { attentionByTaskId: Map<string, TaskQueueAttention>; resolvedWaitTaskIds: Set<string> } => {
  const result = new Map<string, TaskQueueAttention>();
  const resolvedWaitTaskIds = new Set<string>();
  const requestStates: Record<string, ConversationRequestState> = requestStateByConversationId ?? Object.fromEntries(JSON.parse(
    selectTaskQueueRequestSignature({ messages, messagesByConversationId, questionnaireDraftsByConversationId }),
  ));
  const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const conversationIdsByTaskId = new Map<string, string[]>();
  for (const conversation of conversations) {
    if (conversation.scope_mode && conversation.scope_mode !== 'Implement') continue;
    const task = conversation.task_id ? resolveTaskReference(tasks, conversation.task_id) : null;
    if (!task || (task.conversation_id && task.conversation_id !== conversation.id)) continue;
    conversationIdsByTaskId.set(task.id, [...(conversationIdsByTaskId.get(task.id) ?? []), conversation.id]);
  }

  for (const task of tasks) {
    if (task.archived_at || task.status === 'Completed') continue;
    const conversationIds = new Set(conversationIdsByTaskId.get(task.id) ?? []);
    if (task.conversation_id) {
      const conversation = conversationsById.get(task.conversation_id);
      if ((!conversation?.scope_mode || conversation.scope_mode === 'Implement') &&
        (!conversation?.task_id || resolveTaskReference(tasks, conversation.task_id)?.id === task.id)) {
        conversationIds.add(task.conversation_id);
      }
    }
    let hasResolvedRequest = false;
    for (const conversationId of conversationIds) {
      if (Object.hasOwn(pendingToolApprovalByConversationId, conversationId)) {
        result.set(task.id, { kind: 'approval', conversationId });
        break;
      }
      const requestState = requestStates[conversationId];
      hasResolvedRequest ||= requestState === 'resolved';
      if (requestState === 'pending') {
        result.set(task.id, { kind: 'questionnaire', conversationId });
      }
    }
    if (result.has(task.id)) continue;
    if (hasResolvedRequest) resolvedWaitTaskIds.add(task.id);
    // A dependency block alone is not a request. A live request above still is.
    if (task.is_blocked || task.status === 'Blocked' || runningTaskIds.has(task.id)) continue;
    const mergePresentation = resolveTaskMergeWorkflowPresentationState(
      mergeWorkflowRuntimeByTaskId[task.id], task.merge_workflow_summary, task.status,
    );
    if (mergePresentation && mergePresentation.phase !== 'ready') continue;
    if (task.status === 'AwaitingResponse' && !hasResolvedRequest && !mergePresentation) {
      result.set(task.id, { kind: 'reply', conversationId: conversationIds.values().next().value ?? null });
    } else if (task.status === 'InReview') {
      result.set(task.id, { kind: 'review', conversationId: null });
    }
  }
  return { attentionByTaskId: result, resolvedWaitTaskIds };
};

export const resolveTaskQueueAttention = (input: TaskQueueAttentionInput): Map<string, TaskQueueAttention> =>
  resolveTaskQueueSupervision(input).attentionByTaskId;
