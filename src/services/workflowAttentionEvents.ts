import type {
  AppMode,
  ChatMessage,
  Conversation,
  ConversationQuestionnaireDraft,
  PendingToolApproval,
  TaskStatus,
} from '../types';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import { resolveActiveConversationQuestionnaire } from './chatQuestionnaires';
import {
  resolveTaskReference,
  taskReferenceMatches,
} from './durableIdentity';

export interface WorkflowAttentionContext {
  mode: AppMode;
  selectedTaskId: string | null;
  selectedConversationId: string | null;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  scopedProjectIds: string[];
  tasks: CatalogedImplementTask[];
}

export interface WorkflowChatAttentionState {
  messages: ChatMessage[];
  messagesByConversationId: Record<string, ChatMessage[]>;
  conversations: Conversation[];
  questionnaireDraftsByConversationId: Record<string, ConversationQuestionnaireDraft>;
  pendingToolApprovalByConversationId: Record<string, PendingToolApproval | undefined>;
}

export type WorkflowAttentionEvent =
  | {
      kind: 'questionnaire';
      key: string;
      conversationId: string;
      conversationTitle: string;
      mode: AppMode;
      taskId: string | null;
      groupId: string | null;
      projectId: string | null;
      prompt: string;
    }
  | {
      kind: 'approval';
      key: string;
      conversationId: string;
      conversationTitle: string;
      mode: AppMode;
      taskId: string | null;
      groupId: string | null;
      projectId: string | null;
      summary: string;
      isDestructive: boolean;
    }
  | {
      kind: 'review';
      key: string;
      taskId: string;
      taskTitle: string;
      conversationId: string | null;
    };

const getConversationMessages = (
  state: WorkflowChatAttentionState,
  conversationId: string,
): ChatMessage[] =>
  state.messagesByConversationId[conversationId] ??
  state.messages.filter((message) => message.conversation_id === conversationId);

const isArchitectConversationInScope = (
  context: WorkflowAttentionContext,
  conversation: Conversation,
): boolean => {
  if (context.selectedGroupId) {
    if (conversation.group_id) {
      return conversation.group_id === context.selectedGroupId;
    }

    return Boolean(
      conversation.project_id &&
      context.scopedProjectIds.includes(conversation.project_id),
    );
  }

  return Boolean(
    context.selectedProjectId &&
    conversation.project_id === context.selectedProjectId,
  );
};

const isImplementConversationInScope = (
  context: WorkflowAttentionContext,
  conversation: Conversation,
): boolean => {
  if (!context.selectedTaskId) {
    return !conversation.task_id;
  }

  const selectedTask = resolveTaskReference(context.tasks, context.selectedTaskId);
  return Boolean(
    selectedTask &&
    taskReferenceMatches(context.tasks, selectedTask, conversation.task_id),
  );
};

const isConversationContextVisible = (
  context: WorkflowAttentionContext,
  conversation: Conversation,
): boolean =>
  context.mode === conversation.scope_mode &&
  context.selectedConversationId === conversation.id &&
  (conversation.scope_mode === 'Chat' ||
    (conversation.scope_mode === 'Architect' &&
      !conversation.task_id &&
      isArchitectConversationInScope(context, conversation)) ||
    (conversation.scope_mode === 'Implement' &&
      isImplementConversationInScope(context, conversation)));

const getQuestionnaireKeys = (state: WorkflowChatAttentionState): Set<string> => {
  const keys = new Set<string>();
  for (const conversation of state.conversations) {
    const questionnaire = resolveActiveConversationQuestionnaire(
      conversation.id,
      getConversationMessages(state, conversation.id),
      state.questionnaireDraftsByConversationId[conversation.id],
    );
    if (questionnaire?.mode === 'pending_reply') {
      keys.add(`${conversation.id}:${questionnaire.assistantMessageId}`);
    }
  }
  return keys;
};

export const detectNewChatAttentionEvents = (
  previousState: WorkflowChatAttentionState,
  nextState: WorkflowChatAttentionState,
  context: WorkflowAttentionContext,
): WorkflowAttentionEvent[] => {
  const events: WorkflowAttentionEvent[] = [];
  const previousQuestionnaireKeys = getQuestionnaireKeys(previousState);

  for (const conversation of nextState.conversations) {
    const isVisible = isConversationContextVisible(context, conversation);
    const questionnaire = resolveActiveConversationQuestionnaire(
      conversation.id,
      getConversationMessages(nextState, conversation.id),
      nextState.questionnaireDraftsByConversationId[conversation.id],
    );
    if (questionnaire?.mode === 'pending_reply') {
      const requestKey = `${conversation.id}:${questionnaire.assistantMessageId}`;
      if (!previousQuestionnaireKeys.has(requestKey) && !isVisible) {
        events.push({
          kind: 'questionnaire',
          key: `workflow-attention:questionnaire:${requestKey}`,
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          mode: conversation.scope_mode,
          taskId: conversation.task_id,
          groupId: conversation.group_id ?? null,
          projectId: conversation.project_id,
          prompt: questionnaire.currentStep.prompt,
        });
      }
    }

    const previousApproval =
      previousState.pendingToolApprovalByConversationId[conversation.id];
    const nextApproval = nextState.pendingToolApprovalByConversationId[conversation.id];
    if (
      nextApproval &&
      nextApproval.toolCallId !== previousApproval?.toolCallId &&
      !isVisible
    ) {
      events.push({
        kind: 'approval',
        key: `workflow-attention:approval:${conversation.id}:${nextApproval.toolCallId}`,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        mode: conversation.scope_mode,
        taskId: conversation.task_id,
        groupId: conversation.group_id ?? null,
        projectId: conversation.project_id,
        summary: nextApproval.summary,
        isDestructive: nextApproval.isDestructive === true,
      });
    }
  }

  return events;
};

const indexTaskStatuses = (
  tasks: Array<Pick<CatalogedImplementTask, 'id' | 'status'>>,
): Map<string, TaskStatus> =>
  new Map(tasks.map((task) => [task.id, task.status]));

export const detectNewReviewAttentionEvents = (
  previousTasks: CatalogedImplementTask[],
  nextTasks: CatalogedImplementTask[],
  context: WorkflowAttentionContext,
  conversations: Conversation[],
): WorkflowAttentionEvent[] => {
  const previousStatuses = indexTaskStatuses(previousTasks);

  return nextTasks.flatMap<WorkflowAttentionEvent>((task) => {
    const selectedTask = context.selectedTaskId
      ? resolveTaskReference(nextTasks, context.selectedTaskId)
      : undefined;
    if (
      task.status !== 'InReview' ||
      previousStatuses.get(task.id) === undefined ||
      previousStatuses.get(task.id) === 'InReview' ||
      (context.mode === 'Implement' && selectedTask?.id === task.id)
    ) {
      return [];
    }

    const conversationId =
      task.conversation_id ??
      conversations.find(
        (conversation) =>
          conversation.scope_mode === 'Implement' &&
          taskReferenceMatches(nextTasks, task, conversation.task_id),
      )?.id ??
      null;

    return [
      {
        kind: 'review',
        key: `workflow-attention:review:${task.id}`,
        taskId: task.id,
        taskTitle: task.title,
        conversationId,
      },
    ];
  });
};
