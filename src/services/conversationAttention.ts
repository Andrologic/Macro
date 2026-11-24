import type {
  AppMode,
  ChatMessage,
  Conversation,
  ConversationQuestionnaireDraft,
  PendingToolApproval,
} from '../types';
import { resolveActiveConversationQuestionnaire } from './chatQuestionnaires';

export interface ConversationAttentionContext {
  appForeground: boolean;
  mode: AppMode;
  selectedConversationId: string | null;
  architectLibraryConversationId?: string | null;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  scopedProjectIds: string[];
}

export interface ConversationAttentionState {
  hydrationStatus?: "idle" | "hydrating" | "ready" | "error";
  messageLoadStatusByConversationId?: Record<string, "idle" | "loading" | "ready" | "error" | undefined>;
  messages: ChatMessage[];
  messagesByConversationId: Record<string, ChatMessage[]>;
  conversations: Conversation[];
  questionnaireDraftsByConversationId: Record<string, ConversationQuestionnaireDraft>;
  pendingToolApprovalByConversationId: Record<string, PendingToolApproval | undefined>;
}

export type ConversationRequestState = 'pending' | 'resolved' | 'unknown';

// The queue follows transcript evidence. The notification detector also reads
// the draft to identify the current prompt.
export const resolveConversationRequestStates = ({
  messages,
  messagesByConversationId,
}: Partial<Pick<ConversationAttentionState, 'messages' | 'messagesByConversationId'>>): Record<string, ConversationRequestState> => {
  const transcripts = { ...messagesByConversationId };
  for (const message of messages ?? []) {
    if (!messagesByConversationId?.[message.conversation_id]) {
      (transcripts[message.conversation_id] ??= []).push(message);
    }
  }
  return Object.fromEntries(Object.entries(transcripts).map(([id, transcript]) => {
    if (resolveActiveConversationQuestionnaire(id, transcript)?.mode === 'pending_reply') {
      return [id, 'pending'];
    }
    let sawReply = false;
    for (let index = transcript.length - 1; index >= 0; index--) {
      const message = transcript[index]!;
      if (message.role === 'user') sawReply = true;
      if (message.role === 'assistant' && message.questionnaire) {
        return [id, sawReply ? 'resolved' : 'unknown'];
      }
    }
    return [id, 'unknown'];
  }));
};

export const resolveConversationAttentionKind = (
  conversationId: string,
  requestState: ConversationRequestState | undefined,
  pendingToolApprovalByConversationId: Record<string, unknown>,
): 'approval' | 'questionnaire' | undefined => {
  if (Object.hasOwn(pendingToolApprovalByConversationId, conversationId)) return 'approval';
  if (requestState === 'pending') return 'questionnaire';
  return undefined;
};

export type ConversationAttentionEvent =
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
  previous: ConversationAttentionState['messageLoadStatusByConversationId'],
  next: ConversationAttentionState['messageLoadStatusByConversationId'],
): boolean => {
  if (previous === next) return true;
  const previousEntries = Object.entries(previous ?? {});
  const nextEntries = Object.entries(next ?? {});
  if (previousEntries.length !== nextEntries.length) return false;
  return previousEntries.every(([conversationId, status]) => next?.[conversationId] === status);
};

export const hasChatAttentionStateChanged = (
  previous: ConversationAttentionState,
  next: ConversationAttentionState,
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

const getConversationMessages = (
  state: ConversationAttentionState,
  conversationId: string,
): ChatMessage[] =>
  state.messagesByConversationId[conversationId] ??
  state.messages.filter((message) => message.conversation_id === conversationId);

const isArchitectConversationInScope = (
  context: ConversationAttentionContext,
  conversation: Conversation,
): boolean => {
  if (context.architectLibraryConversationId === conversation.id) return true;
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

const isConversationContextVisible = (
  context: ConversationAttentionContext,
  conversation: Conversation,
  isOtherConversationInScope?: (conversation: Conversation) => boolean,
): boolean =>
  context.appForeground &&
  context.mode === conversation.scope_mode &&
  context.selectedConversationId === conversation.id &&
  (conversation.scope_mode === 'Chat' ||
    (conversation.scope_mode === 'Architect' &&
      !conversation.task_id &&
      isArchitectConversationInScope(context, conversation)) ||
    isOtherConversationInScope?.(conversation) === true);

const getQuestionnaireKeys = (state: ConversationAttentionState): Set<string> => {
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

export const getActiveChatAttentionKeys = (state: ConversationAttentionState): Set<string> => {
  const keys = new Set([...getQuestionnaireKeys(state)].map((key) => `workflow-attention:questionnaire:${key}`));
  for (const [conversationId, approval] of Object.entries(state.pendingToolApprovalByConversationId)) {
    if (approval) keys.add(`workflow-attention:approval:${conversationId}:${approval.toolCallId}`);
  }
  return keys;
};

export const detectNewConversationAttentionEvents = (
  previousState: ConversationAttentionState,
  nextState: ConversationAttentionState,
  context: ConversationAttentionContext,
  isOtherConversationInScope?: (conversation: Conversation) => boolean,
): ConversationAttentionEvent[] => {
  const events: ConversationAttentionEvent[] = [];
  if (previousState.hydrationStatus === "hydrating" || nextState.hydrationStatus === "hydrating" ||
      nextState.hydrationStatus === "idle") return events;
  const previousQuestionnaireKeys = getQuestionnaireKeys(previousState);

  for (const conversation of nextState.conversations) {
    const isVisible = isConversationContextVisible(context, conversation, isOtherConversationInScope);
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
