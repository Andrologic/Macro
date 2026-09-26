import type { ChatMessage } from "../types";
import type { StreamMessage } from "./streamingChat";

export const shouldCountProviderInputItemsForContext = (
  providerType?: string | null,
): boolean => providerType !== "copilot";

export const normalizeMessagesForProviderContext = (
  providerType: string | null | undefined,
  messages: StreamMessage[],
): StreamMessage[] => {
  if (providerType !== "copilot") {
    return messages;
  }

  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image_url") &&
    message.image_metadata
      ? { image_metadata: message.image_metadata.map((metadata) => ({ ...metadata })) }
      : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  }));
};

export const streamContentToPlainText = (content: StreamMessage["content"]): string => {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "image_url"
          ? "[image attachment]"
          : "",
    )
    .filter(Boolean)
    .join("\n");
};

export const splitSystemAndPreparedStreamMessages = (
  messages: StreamMessage[],
): { systemMessage: string; preparedMessages: StreamMessage[] } => {
  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    return {
      systemMessage: first.content,
      preparedMessages: messages.slice(1),
    };
  }
  return {
    systemMessage: "",
    preparedMessages: messages,
  };
};

export const buildSyntheticOrderedMessagesForStreamRequest = (params: {
  conversationId: string;
  taskId: string;
  messages: StreamMessage[];
}): ChatMessage[] => {
  const timestampBase = Date.now();
  return params.messages.map((message, index) => {
    const role: ChatMessage["role"] =
      message.role === "assistant" || message.role === "tool" || message.role === "system"
        ? "assistant"
        : "user";
    const label =
      message.role === "tool"
        ? "Tool result"
        : message.role === "system"
          ? "System instruction"
          : "";
    const content = streamContentToPlainText(message.content);
    return {
      id: `stream-boundary-${index}`,
      task_id: params.taskId,
      conversation_id: params.conversationId,
      role,
      content: label ? `[${label}]\n${content}` : content,
      timestamp: new Date(timestampBase + index).toISOString(),
      provider_input_items: message.provider_input_items,
      provider_turn_state: message.provider_turn_state,
    };
  });
};

export const cloneProviderInputItems = (
  items?: unknown[] | null,
): unknown[] | undefined => {
  if (!Array.isArray(items) || items.length === 0) {
    return undefined;
  }

  return items.map((item) =>
    item && typeof item === "object"
      ? JSON.parse(JSON.stringify(item))
      : item,
  );
};

export const cloneStreamMessage = (message: StreamMessage): StreamMessage => ({
  ...message,
  content: Array.isArray(message.content)
    ? message.content.map((part) =>
        part.type === "image_url"
          ? {
              type: "image_url" as const,
              image_url: { ...part.image_url },
            }
          : { ...part },
      )
    : message.content,
  provider_input_items: cloneProviderInputItems(message.provider_input_items),
  image_metadata: message.image_metadata?.map((metadata) => ({ ...metadata })),
});
