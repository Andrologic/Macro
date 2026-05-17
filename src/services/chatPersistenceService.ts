import type {
  ChatMessage,
  Conversation,
  ProviderTurnState,
  ToolTrace,
} from "../types";
import type {
  DbChatBootstrapSnapshot,
  DbConversation,
  DbMessage,
} from "./tauriIpc";
import {
  buildAssistantMessagePresentation,
  buildUserMessagePresentation,
  mapDbConversationToConversation,
  mapDbMessageToChatMessage,
  parseDbProviderInputItems,
  parseDbProviderTurnState,
} from "./chatDbMappers";
import { parseToolTracesJson } from "./toolTraceState";

export interface ChatPersistenceIpc {
  getChatBootstrapSnapshot: () => Promise<DbChatBootstrapSnapshot>;
  listConversations: () => Promise<DbConversation[]>;
  listMessages: (conversationId: string) => Promise<DbMessage[]>;
  createMessage: (
    conversationId: string,
    role: string,
    content: string,
    options?: {
      id?: string;
      turnId?: string | null;
      tokenCount?: number;
      toolTraces?: ToolTrace[];
      hiddenContext?: string;
      providerInputItems?: unknown[];
      providerTurnState?: ProviderTurnState;
    },
  ) => Promise<DbMessage>;
  updateMessage: (
    id: string,
    content: string,
    options?: {
      turnId?: string | null;
      tokenCount?: number;
      toolTraces?: ToolTrace[];
      hiddenContext?: string;
      providerInputItems?: unknown[];
      providerTurnState?: ProviderTurnState;
    },
  ) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  deleteConversations: (ids: string[]) => Promise<void>;
  deleteMessagesAfter: (
    conversationId: string,
    messageId: string,
  ) => Promise<void>;
}

export interface ChatPersistenceAdapters {
  isTauriAvailable: () => boolean;
  ipc: ChatPersistenceIpc;
  now?: () => Date;
  randomIdSuffix?: () => string;
}

export interface ChatBootstrapLoadResult {
  conversations: Conversation[];
  messages: ChatMessage[];
  loadedConversationIds: Set<string>;
  bootstrapError?: unknown;
}

export interface AssistantCompletionPersistenceResult {
  visibleContent: string;
  hiddenContext?: string;
  providerInputItems?: unknown[];
  providerTurnState?: ProviderTurnState;
  toolTraces?: ToolTrace[];
}

const cloneProviderInputItems = (
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

const defaultNow = (): Date => new Date();

const defaultRandomIdSuffix = (): string =>
  Math.random().toString(36).slice(2, 8);

const buildConversationById = (
  conversations: Conversation[],
): Map<string, Conversation> =>
  new Map(conversations.map((conversation) => [conversation.id, conversation]));

export const loadChatBootstrapSnapshot = async (
  adapters: ChatPersistenceAdapters,
): Promise<ChatBootstrapLoadResult> => {
  if (!adapters.isTauriAvailable()) {
    return {
      conversations: [],
      messages: [],
      loadedConversationIds: new Set(),
    };
  }

  try {
    const snapshot = await adapters.ipc.getChatBootstrapSnapshot();
    const conversations = snapshot.conversations.map(
      mapDbConversationToConversation,
    );
    const conversationById = buildConversationById(conversations);
    const messages = Object.values(snapshot.messages_by_conversation_id)
      .flatMap((items) => items ?? [])
      .map((message) => mapDbMessageToChatMessage(message, conversationById));
    return {
      conversations,
      messages,
      loadedConversationIds: new Set(
        messages.map((message) => message.conversation_id),
      ),
    };
  } catch (bootstrapError) {
    const conversations = (await adapters.ipc.listConversations()).map(
      mapDbConversationToConversation,
    );
    return {
      conversations,
      messages: [],
      loadedConversationIds: new Set(),
      bootstrapError,
    };
  }
};

export const loadConversationMessages = async (
  adapters: ChatPersistenceAdapters,
  params: {
    conversationId: string;
    conversations: Conversation[];
  },
): Promise<ChatMessage[]> => {
  if (!adapters.isTauriAvailable()) {
    return [];
  }

  const dbMessages = await adapters.ipc.listMessages(params.conversationId);
  return dbMessages.map((message) =>
    mapDbMessageToChatMessage(message, buildConversationById(params.conversations)),
  );
};

export const createUserMessage = async (
  adapters: ChatPersistenceAdapters,
  params: {
    conversationId: string;
    turnId: string;
    taskId: string;
    content: string;
    hiddenContext?: string;
    providerInputItems?: unknown[];
  },
): Promise<ChatMessage> => {
  const now = adapters.now ?? defaultNow;
  const presentation = buildUserMessagePresentation(
    params.content,
    params.hiddenContext,
  );

  if (!adapters.isTauriAvailable()) {
    return {
      id: `msg-${now().getTime()}`,
      turn_id: params.turnId,
      task_id: params.taskId,
      conversation_id: params.conversationId,
      role: "user",
      content: presentation.content,
      timestamp: now().toISOString(),
      hidden_context: params.hiddenContext,
      provider_input_items: cloneProviderInputItems(params.providerInputItems),
      questionnaire_response_summary:
        presentation.questionnaire_response_summary,
    };
  }

  const dbMessage = await adapters.ipc.createMessage(
    params.conversationId,
    "user",
    params.content,
    {
      turnId: params.turnId,
      hiddenContext: params.hiddenContext,
      providerInputItems: params.providerInputItems,
    },
  );
  const dbPresentation = buildUserMessagePresentation(
    dbMessage.content,
    dbMessage.hidden_context ?? undefined,
  );
  return {
    id: dbMessage.id,
    turn_id: dbMessage.turn_id ?? params.turnId,
    task_id: params.taskId,
    conversation_id: dbMessage.conversation_id,
    role: "user",
    content: dbPresentation.content,
    timestamp: dbMessage.created_at,
    hidden_context: dbMessage.hidden_context ?? undefined,
    provider_input_items: parseDbProviderInputItems(
      dbMessage.provider_input_items_json,
    ),
    questionnaire_response_summary:
      dbPresentation.questionnaire_response_summary,
  };
};

export const createAssistantPlaceholderMessage = async (
  adapters: ChatPersistenceAdapters,
  params: {
    conversationId: string;
    turnId: string;
    taskId: string;
  },
): Promise<ChatMessage> => {
  const now = adapters.now ?? defaultNow;
  const randomIdSuffix = adapters.randomIdSuffix ?? defaultRandomIdSuffix;
  const clientMessageId = `msg-${now().getTime()}-${randomIdSuffix()}-assistant`;

  if (!adapters.isTauriAvailable()) {
    return {
      id: clientMessageId,
      turn_id: params.turnId,
      task_id: params.taskId,
      conversation_id: params.conversationId,
      role: "assistant",
      content: "",
      tool_traces: [],
      timestamp: now().toISOString(),
    };
  }

  const dbMessage = await adapters.ipc.createMessage(
    params.conversationId,
    "assistant",
    "",
    {
      id: clientMessageId,
      turnId: params.turnId,
      toolTraces: [],
    },
  );
  const presentation = buildAssistantMessagePresentation(
    dbMessage.content,
    dbMessage.hidden_context ?? undefined,
  );
  return {
    id: dbMessage.id,
    turn_id: dbMessage.turn_id ?? params.turnId,
    task_id: params.taskId,
    conversation_id: dbMessage.conversation_id,
    role: "assistant",
    content: presentation.content,
    timestamp: dbMessage.created_at,
    choices: presentation.choices,
    allow_free_response: presentation.allow_free_response,
    questionnaire: presentation.questionnaire,
    tool_traces: parseToolTracesJson(dbMessage.tool_traces_json) ?? [],
    hidden_context: dbMessage.hidden_context ?? undefined,
    provider_input_items: parseDbProviderInputItems(
      dbMessage.provider_input_items_json,
    ),
    provider_turn_state: parseDbProviderTurnState(
      dbMessage.provider_turn_state_json,
    ),
  };
};

export const updateProviderInputItemsForMessage = async (
  adapters: ChatPersistenceAdapters,
  params: {
    message: ChatMessage;
    providerInputItems: unknown[] | undefined;
  },
): Promise<unknown[] | undefined> => {
  if (
    !Array.isArray(params.providerInputItems) ||
    params.providerInputItems.length === 0
  ) {
    return undefined;
  }

  if (adapters.isTauriAvailable()) {
    await adapters.ipc.updateMessage(params.message.id, params.message.content, {
      turnId: params.message.turn_id ?? null,
      toolTraces: params.message.tool_traces,
      hiddenContext: params.message.hidden_context,
      providerInputItems: params.providerInputItems,
      providerTurnState: params.message.provider_turn_state,
    });
  }

  return params.providerInputItems;
};

export const updateEditedUserMessage = async (
  adapters: ChatPersistenceAdapters,
  params: {
    message: ChatMessage;
    content: string;
    turnId?: string | null;
    hiddenContext?: string;
    providerInputItems?: unknown[];
  },
): Promise<void> => {
  if (!adapters.isTauriAvailable()) {
    return;
  }

  await adapters.ipc.updateMessage(params.message.id, params.content, {
    turnId: params.turnId ?? params.message.turn_id ?? null,
    toolTraces: params.message.tool_traces,
    hiddenContext: params.hiddenContext,
    providerInputItems: params.providerInputItems,
    providerTurnState: params.message.provider_turn_state,
  });
};

export const persistAssistantPartialResult = async (
  adapters: ChatPersistenceAdapters,
  assistantMessage: ChatMessage,
): Promise<void> => {
  if (!adapters.isTauriAvailable()) return;
  if (
    assistantMessage.content.trim().length === 0 &&
    (assistantMessage.tool_traces?.length ?? 0) === 0
  ) {
    return;
  }

  await adapters.ipc.updateMessage(assistantMessage.id, assistantMessage.content, {
    turnId: assistantMessage.turn_id ?? null,
    toolTraces: assistantMessage.tool_traces,
    hiddenContext: assistantMessage.hidden_context,
    providerInputItems: assistantMessage.provider_input_items,
    providerTurnState: assistantMessage.provider_turn_state,
  });
};

export const persistAssistantCompletionResult = async (
  adapters: ChatPersistenceAdapters,
  params: {
    assistantMessageId: string;
    persistedAssistant?: ChatMessage | null;
    result: AssistantCompletionPersistenceResult;
  },
): Promise<void> => {
  if (!adapters.isTauriAvailable()) return;

  await adapters.ipc.updateMessage(
    params.assistantMessageId,
    params.result.visibleContent,
    {
      turnId: params.persistedAssistant?.turn_id ?? null,
      toolTraces:
        params.persistedAssistant?.tool_traces ?? params.result.toolTraces,
      hiddenContext: params.result.hiddenContext,
      providerInputItems: params.result.providerInputItems,
      providerTurnState: params.result.providerTurnState,
    },
  );
};

export const renameConversation = async (
  adapters: ChatPersistenceAdapters,
  conversationId: string,
  title: string,
): Promise<void> => {
  if (!adapters.isTauriAvailable()) return;
  await adapters.ipc.renameConversation(conversationId, title);
};

export const deleteConversation = async (
  adapters: ChatPersistenceAdapters,
  conversationId: string,
): Promise<void> => {
  if (!adapters.isTauriAvailable()) return;
  await adapters.ipc.deleteConversation(conversationId);
};

export const deleteConversations = async (
  adapters: ChatPersistenceAdapters,
  conversationIds: string[],
): Promise<void> => {
  if (!adapters.isTauriAvailable()) return;
  await adapters.ipc.deleteConversations(conversationIds);
};

export const deleteMessagesAfter = async (
  adapters: ChatPersistenceAdapters,
  conversationId: string,
  messageId: string,
): Promise<void> => {
  if (!adapters.isTauriAvailable()) return;
  await adapters.ipc.deleteMessagesAfter(conversationId, messageId);
};
