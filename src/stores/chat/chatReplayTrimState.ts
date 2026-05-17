import type {
  ChatMessage,
  Conversation,
  ConversationQuestionnaireDraft,
} from "../../types";
import type {
  ConversationReplayPlan,
  ReplayCompactionMarker,
} from "../../services/conversationReplayService";
import {
  buildMessageState,
  indexMessagesByConversation,
  type ChatMessageStateShape,
} from "./chatMessageState";
import {
  clearQuestionnaireDraftsForConversations,
  type MessageImageAttachment,
} from "./chatLocalSessionState";

export interface ReplayTrimStateShape<
  TMarker extends ReplayCompactionMarker = ReplayCompactionMarker,
> extends ChatMessageStateShape {
  conversations: Conversation[];
  messageImagesByMessageId: Record<string, MessageImageAttachment[]>;
  questionnaireDraftsByConversationId: Record<
    string,
    ConversationQuestionnaireDraft
  >;
  sessionCompactionEventsByConversationId: Record<
    string,
    TMarker[] | undefined
  >;
}

export interface ReplayTrimStatePatchResult<
  TMarker extends ReplayCompactionMarker,
> {
  patch: ChatMessageStateShape & {
    conversations: Conversation[];
    messageImagesByMessageId: Record<string, MessageImageAttachment[]>;
    questionnaireDraftsByConversationId: Record<
      string,
      ConversationQuestionnaireDraft
    >;
    sessionCompactionEventsByConversationId: Record<
      string,
      TMarker[] | undefined
    >;
    lastError: null;
  };
  keptConversationMessageIds: string[];
  shouldPersistMessageImages: boolean;
  shouldPersistQuestionnaireDrafts: boolean;
}

const recalcConversationFromMessages = (
  conversationId: string,
  messages: ChatMessage[],
  updatedAt: string,
) => {
  const conversationMessages =
    indexMessagesByConversation(messages)[conversationId] ?? [];
  const lastMessage = conversationMessages[conversationMessages.length - 1];
  return {
    message_count: conversationMessages.length,
    last_message: lastMessage?.content ?? "",
    updated_at: updatedAt,
  };
};

export const buildReplayTrimStatePatch = <
  TMarker extends ReplayCompactionMarker,
>(params: {
  state: ReplayTrimStateShape<TMarker>;
  conversationId: string;
  plan: ConversationReplayPlan<TMarker>;
  updatedMessage?: ChatMessage;
  clearQuestionnaireSession?: boolean;
  now?: () => Date;
}): ReplayTrimStatePatchResult<TMarker> => {
  const currentMessages = params.updatedMessage
    ? params.state.messages.map((message) =>
        message.id === params.updatedMessage!.id
          ? params.updatedMessage!
          : message,
      )
    : params.state.messages;

  const trimmedMessages = currentMessages.filter((message) =>
    message.conversation_id === params.conversationId
      ? params.plan.keptMessageIds.has(message.id)
      : true,
  );
  const updatedAt = (params.now?.() ?? new Date()).toISOString();
  const conversationMeta = recalcConversationFromMessages(
    params.conversationId,
    trimmedMessages,
    updatedAt,
  );
  const conversations = params.state.conversations.map((conversation) =>
    conversation.id === params.conversationId
      ? { ...conversation, ...conversationMeta }
      : conversation,
  );

  const keptConversationMessageIds = trimmedMessages
    .filter((message) => message.conversation_id === params.conversationId)
    .map((message) => message.id);
  const keptConversationMessageIdSet = new Set(keptConversationMessageIds);
  const nextImages = { ...params.state.messageImagesByMessageId };
  let shouldPersistMessageImages = false;
  Object.keys(nextImages).forEach((messageId) => {
    const message = trimmedMessages.find((candidate) => candidate.id === messageId);
    if (
      !message ||
      (message.conversation_id === params.conversationId &&
        !keptConversationMessageIdSet.has(messageId))
    ) {
      delete nextImages[messageId];
      shouldPersistMessageImages = true;
    }
  });

  const nextQuestionnaireDrafts = params.clearQuestionnaireSession
    ? clearQuestionnaireDraftsForConversations(
        params.state.questionnaireDraftsByConversationId,
        [params.conversationId],
      )
    : params.state.questionnaireDraftsByConversationId;
  const nextSessionCompactionEvents = {
    ...params.state.sessionCompactionEventsByConversationId,
  };
  if (params.plan.sessionCompactionEvents?.length) {
    nextSessionCompactionEvents[params.conversationId] =
      params.plan.sessionCompactionEvents;
  } else {
    delete nextSessionCompactionEvents[params.conversationId];
  }

  return {
    patch: {
      ...buildMessageState(trimmedMessages),
      conversations,
      messageImagesByMessageId: nextImages,
      questionnaireDraftsByConversationId: nextQuestionnaireDrafts,
      sessionCompactionEventsByConversationId: nextSessionCompactionEvents,
      lastError: null,
    },
    keptConversationMessageIds,
    shouldPersistMessageImages,
    shouldPersistQuestionnaireDrafts: Boolean(params.clearQuestionnaireSession),
  };
};
