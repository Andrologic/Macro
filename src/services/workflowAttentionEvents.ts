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
  appForeground: boolean;
  mode: AppMode;
  selectedTaskId: string | null;
  selectedConversationId: string | null;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  scopedProjectIds: string[];
  tasks: CatalogedImplementTask[];
}

export interface WorkflowChatAttentionState {
  hydrationStatus?: "idle" | "hydrating" | "ready" | "error";
  messageLoadStatusByConversationId?: Record<string, "idle" | "loading" | "ready" | "error" | undefined>;
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
      catalogScope: {
        selectedGroupId: string | null;
        selectedProjectId: string | null;
      };
    };

const haveSameConversationAttentionShape = (
  previous: Conversation[],
  next: Conversation[],
): boolean => {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;

  return previous.every((conversation, index) => {
    const candidate = next[index];
    return Boolean(
      candidate &&
      conversation.id === candidate.id &&
      conversation.scope_mode === candidate.scope_mode &&
      conversation.task_id === candidate.task_id &&
      conversation.group_id === candidate.group_id &&
      conversation.project_id === candidate.project_id,
    );
  });
};

const haveSameQuestionnaireShape = (
  previous: ChatMessage['questionnaire'],
  next: ChatMessage['questionnaire'],
): boolean => {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  if (previous.questions.length !== next.questions.length) return false;

  return previous.questions.every((question, index) => {
    const candidate = next.questions[index];
    return Boolean(
      candidate &&
      question.id === candidate.id &&
      question.prompt === candidate.prompt,
    );
  });
};

const haveSameMessageAttentionShape = (
  previous: ChatMessage[],
  next: ChatMessage[],
): boolean => {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;

  return previous.every((message, index) => {
    const candidate = next[index];
    return Boolean(
      candidate &&
      message.id === candidate.id &&
      message.conversation_id === candidate.conversation_id &&
      message.role === candidate.role &&
      haveSameQuestionnaireShape(message.questionnaire, candidate.questionnaire),
    );
  });
};

const haveSameConversationMessageAttentionShape = (
  previous: Record<string, ChatMessage[]>,
  next: Record<string, ChatMessage[]>,
): boolean => {
  if (previous === next) return true;
  const previousIds = Object.keys(previous);
  const nextIds = Object.keys(next);
  if (previousIds.length !== nextIds.length) return false;

  return previousIds.every((conversationId) =>
    Object.prototype.hasOwnProperty.call(next, conversationId) &&
    haveSameMessageAttentionShape(previous[conversationId]!, next[conversationId]!),
  );
};

const haveSameQuestionnaireDraftAttentionShape = (
  previous: Record<string, ConversationQuestionnaireDraft>,
  next: Record<string, ConversationQuestionnaireDraft>,
): boolean => {
  if (previous === next) return true;
  const previousIds = Object.keys(previous);
  const nextIds = Object.keys(next);
  if (previousIds.length !== nextIds.length) return false;

  return previousIds.every((conversationId) => {
    const previousDraft = previous[conversationId];
    const nextDraft = next[conversationId];
    return Boolean(
      previousDraft &&
      nextDraft &&
      previousDraft.mode === nextDraft.mode &&
      previousDraft.assistantMessageId === nextDraft.assistantMessageId &&
      previousDraft.responseMessageId === nextDraft.responseMessageId,
    );
  });
};

const haveSameApprovalAttentionShape = (
  previous: Record<string, PendingToolApproval | undefined>,
  next: Record<string, PendingToolApproval | undefined>,
): boolean => {
  if (previous === next) return true;
  const conversationIds = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const conversationId of conversationIds) {
    if (previous[conversationId]?.toolCallId !== next[conversationId]?.toolCallId) {
      return false;
    }
  }
  return true;
};

const haveSameLoadStatus = (
  previous: WorkflowChatAttentionState['messageLoadStatusByConversationId'],
  next: WorkflowChatAttentionState['messageLoadStatusByConversationId'],
): boolean => {
  if (previous === next) return true;
  const previousEntries = Object.entries(previous ?? {});
  const nextEntries = Object.entries(next ?? {});
  if (previousEntries.length !== nextEntries.length) return false;
  return previousEntries.every(([conversationId, status]) => next?.[conversationId] === status);
};

export const hasChatAttentionStateChanged = (
  previous: WorkflowChatAttentionState,
  next: WorkflowChatAttentionState,
): boolean =>
  previous.hydrationStatus !== next.hydrationStatus ||
  !haveSameLoadStatus(
    previous.messageLoadStatusByConversationId,
    next.messageLoadStatusByConversationId,
  ) ||
  !haveSameConversationAttentionShape(previous.conversations, next.conversations) ||
  !haveSameMessageAttentionShape(previous.messages, next.messages) ||
  !haveSameConversationMessageAttentionShape(
    previous.messagesByConversationId,
    next.messagesByConversationId,
  ) ||
  !haveSameQuestionnaireDraftAttentionShape(
    previous.questionnaireDraftsByConversationId,
    next.questionnaireDraftsByConversationId,
  ) ||
  !haveSameApprovalAttentionShape(
    previous.pendingToolApprovalByConversationId,
    next.pendingToolApprovalByConversationId,
  );

export const hasReviewAttentionStateChanged = (
  previous: CatalogedImplementTask[],
  next: CatalogedImplementTask[],
): boolean => {
  if (previous === next) return false;
  if (previous.length !== next.length) return true;

  return previous.some((task, index) => {
    const candidate = next[index];
    return !candidate ||
      task.id !== candidate.id ||
      task.node_id !== candidate.node_id ||
      task.status !== candidate.status ||
      task.title !== candidate.title ||
      task.conversation_id !== candidate.conversation_id;
  });
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
  context.appForeground &&
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

export const getActiveChatAttentionKeys = (state: WorkflowChatAttentionState): Set<string> => {
  const keys = new Set([...getQuestionnaireKeys(state)].map((key) => `workflow-attention:questionnaire:${key}`));
  for (const [conversationId, approval] of Object.entries(state.pendingToolApprovalByConversationId)) {
    if (approval) keys.add(`workflow-attention:approval:${conversationId}:${approval.toolCallId}`);
  }
  return keys;
};

export const detectNewChatAttentionEvents = (
  previousState: WorkflowChatAttentionState,
  nextState: WorkflowChatAttentionState,
  context: WorkflowAttentionContext,
): WorkflowAttentionEvent[] => {
  const events: WorkflowAttentionEvent[] = [];
  if (previousState.hydrationStatus === "hydrating" || nextState.hydrationStatus === "hydrating" ||
      nextState.hydrationStatus === "idle") return events;
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
      const wasLoading = previousState.messageLoadStatusByConversationId?.[conversation.id] === 'loading';
      const isLoading = nextState.messageLoadStatusByConversationId?.[conversation.id] === 'loading';
      if (!wasLoading && !isLoading && !previousQuestionnaireKeys.has(requestKey) && !isVisible) {
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
      (context.appForeground && context.mode === 'Implement' && selectedTask?.id === task.id)
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
        catalogScope: {
          selectedGroupId: context.selectedGroupId,
          selectedProjectId: context.selectedProjectId,
        },
      },
    ];
  });
};
