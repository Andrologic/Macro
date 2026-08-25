import type { ChatMessage } from "../../types";

export const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];

export interface ChatMessageStateShape {
  messages: ChatMessage[];
  messagesByConversationId: Record<string, ChatMessage[]>;
  messageIndexById: Record<string, number>;
}

export const sortMessagesChronologically = (
  messages: ChatMessage[],
): ChatMessage[] =>
  [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

export const indexMessagesByConversation = (
  messages: ChatMessage[],
): Record<string, ChatMessage[]> => {
  const grouped: Record<string, ChatMessage[]> = {};

  for (const message of messages) {
    const existing = grouped[message.conversation_id];
    if (existing) {
      existing.push(message);
    } else {
      grouped[message.conversation_id] = [message];
    }
  }

  Object.keys(grouped).forEach((conversationId) => {
    grouped[conversationId] = sortMessagesChronologically(
      grouped[conversationId]!,
    );
  });

  return grouped;
};

export const indexMessagesById = (
  messages: ChatMessage[],
): Record<string, number> =>
  Object.fromEntries(messages.map((message, index) => [message.id, index]));

export const buildMessageState = (
  messages: ChatMessage[],
): ChatMessageStateShape => ({
  messages,
  messagesByConversationId: indexMessagesByConversation(messages),
  messageIndexById: indexMessagesById(messages),
});

export const getConversationMessagesFromState = (
  state: Pick<ChatMessageStateShape, "messages" | "messagesByConversationId">,
  conversationId: string,
): ChatMessage[] => {
  const indexedMessages = state.messagesByConversationId[conversationId];
  if (indexedMessages) {
    return indexedMessages;
  }

  const fallbackMessages = state.messages.filter(
    (message) => message.conversation_id === conversationId,
  );
  return fallbackMessages.length > 0
    ? sortMessagesChronologically(fallbackMessages)
    : EMPTY_CHAT_MESSAGES;
};

export const findChatMessageInState = (
  state: Pick<
    ChatMessageStateShape,
    "messages" | "messagesByConversationId" | "messageIndexById"
  >,
  messageId: string,
): ChatMessage | null => {
  const indexedMessageIndex = state.messageIndexById[messageId];
  const indexedMessage =
    typeof indexedMessageIndex === "number"
      ? state.messages[indexedMessageIndex]
      : undefined;
  if (indexedMessage?.id === messageId) {
    return indexedMessage;
  }

  const directMessage = state.messages.find((message) => message.id === messageId);
  if (directMessage) {
    return directMessage;
  }

  for (const conversationMessages of Object.values(state.messagesByConversationId)) {
    const message = conversationMessages?.find(
      (candidate) => candidate.id === messageId,
    );
    if (message) {
      return message;
    }
  }

  return null;
};
