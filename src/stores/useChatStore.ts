import { create } from 'zustand';
import { ChatMessage, Conversation } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';
import { useAIStore } from './useAIStore';

interface ChatStore {
  messages: ChatMessage[];
  conversations: Conversation[];
  selectedConversationId: string | null;
  isLoading: boolean;
  lastError: string | null;
  addMessage: (message: ChatMessage) => void;
  updateMessageContent: (messageId: string, content: string) => void;
  updateLastMessage: (content: string) => void;
  clearMessages: () => void;
  selectConversation: (conversationId: string) => void;
  createConversation: (
    title: string,
    taskId: string | null,
    projectId: string | null
  ) => Conversation;
  markAsRead: (conversationId: string) => void;
  getConversationByTask: (taskId: string) => Conversation | undefined;
  getConversationMessages: (conversationId: string) => ChatMessage[];
  sendMessage: (payload: {
    conversationId: string;
    content: string;
    taskId?: string | null;
  }) => Promise<void>;
  editMessage: (messageId: string, newContent: string) => Promise<void>;
  initialize: () => Promise<void>;
}

export const useChatStore = create<ChatStore>((set, get) => {
  const getOrderedConversationMessages = (conversationId: string) => {
    const state = get();
    return state.messages
      .filter((msg) => msg.conversation_id === conversationId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  };

  const recalcConversation = (conversationId: string, messages: ChatMessage[]) => {
    const conversationMessages = messages.filter(
      (message) => message.conversation_id === conversationId
    );
    const lastMessage = conversationMessages[conversationMessages.length - 1];
    return {
      message_count: conversationMessages.length,
      last_message: lastMessage?.content ?? '',
      updated_at: new Date().toISOString(),
    };
  };

  return {
    messages: [],
    conversations: [],
    selectedConversationId: null,
    isLoading: false,
    lastError: null,

    addMessage: (message) =>
      set((state) => {
        const conversations = state.conversations.map((conv) =>
          conv.id === message.conversation_id
            ? {
                ...conv,
                last_message: message.content,
                message_count: conv.message_count + 1,
                updated_at: new Date().toISOString(),
                is_unread: message.role === 'assistant' ? true : conv.is_unread,
              }
            : conv
        );
        return {
          messages: [...state.messages, message],
          conversations,
        };
      }),

    updateMessageContent: (messageId, content) =>
      set((state) => {
        const updatedMessages = state.messages.map((message) =>
          message.id === messageId ? { ...message, content } : message
        );

        const updatedMessage = state.messages.find((message) => message.id === messageId);
        if (!updatedMessage) {
          return { messages: updatedMessages };
        }

        const conversationMeta = recalcConversation(
          updatedMessage.conversation_id,
          updatedMessages
        );

        const conversations = state.conversations.map((conv) =>
          conv.id === updatedMessage.conversation_id
            ? { ...conv, ...conversationMeta }
            : conv
        );

        return { messages: updatedMessages, conversations };
      }),

    updateLastMessage: (content) =>
      set((state) => {
        const updatedMessages = [...state.messages];
        if (updatedMessages.length > 0) {
          const lastIndex = updatedMessages.length - 1;
          updatedMessages[lastIndex] = {
            ...updatedMessages[lastIndex],
            content,
          };
        }
        return { messages: updatedMessages };
      }),

    clearMessages: () => set({ messages: [] }),

    selectConversation: (conversationId) =>
      set((state) => {
        const updatedConversations = state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, is_unread: false } : conv
        );
        return { selectedConversationId: conversationId, conversations: updatedConversations };
      }),

    createConversation: (title, taskId, projectId) => {
      const newConversation: Conversation = {
        id: `conv-${Date.now()}`,
        title,
        task_id: taskId,
        project_id: projectId,
        last_message: '',
        message_count: 0,
        updated_at: new Date().toISOString(),
        is_unread: true,
      };
      set((state) => ({
        conversations: [newConversation, ...state.conversations],
        selectedConversationId: newConversation.id,
      }));
      return newConversation;
    },

    markAsRead: (conversationId) =>
      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, is_unread: false } : conv
        ),
      })),

    getConversationByTask: (taskId) => {
      const state = get();
      return state.conversations.find((conv) => conv.task_id === taskId);
    },

    getConversationMessages: (conversationId) => {
      const state = get();
      return state.messages.filter((msg) => msg.conversation_id === conversationId);
    },

    sendMessage: async ({ conversationId, content, taskId }) => {
      const { selectedProviderId, selectedModelId } = useAIStore.getState();

      if (!selectedProviderId || !selectedModelId) {
        set({ lastError: 'Select a provider and model before sending a message.' });
        return;
      }

      const userMessage: ChatMessage = {
        id: `msg-${Date.now()}`,
        task_id: taskId ?? '',
        conversation_id: conversationId,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };

      set({ lastError: null });
      get().addMessage(userMessage);

      const messagesForRequest = getOrderedConversationMessages(conversationId).map(
        (message) => ({
          role: message.role,
          content: message.content,
        })
      );

      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        task_id: taskId ?? '',
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
      };

      get().addMessage(assistantMessage);
      set({ isLoading: true });

      try {
        const response = await services.sendChat({
          providerId: selectedProviderId,
          modelId: selectedModelId,
          messages: messagesForRequest,
        });

        get().updateMessageContent(assistantMessage.id, response.message.content);
        set({ isLoading: false });
      } catch (error) {
        const normalized = toServiceError(error);
        get().updateMessageContent(
          assistantMessage.id,
          `Error: ${normalized.message}`
        );
        set({ isLoading: false, lastError: normalized.message });
      }
    },

    editMessage: async (messageId, newContent) => {
      const { selectedProviderId, selectedModelId } = useAIStore.getState();
      if (!selectedProviderId || !selectedModelId) {
        set({ lastError: 'Select a provider and model before sending a message.' });
        return;
      }

      const state = get();
      const target = state.messages.find((message) => message.id === messageId);
      if (!target) return;

      const conversationId = target.conversation_id;

      set((current) => {
        const updatedMessages = current.messages.map((message) =>
          message.id === messageId ? { ...message, content: newContent } : message
        );

        const conversationMessages = updatedMessages
          .filter((message) => message.conversation_id === conversationId)
          .sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );

        const targetIndex = conversationMessages.findIndex(
          (message) => message.id === messageId
        );

        const allowedIds = new Set(
          conversationMessages.slice(0, targetIndex + 1).map((message) => message.id)
        );

        const trimmedMessages = updatedMessages.filter((message) =>
          message.conversation_id === conversationId ? allowedIds.has(message.id) : true
        );

        const conversationMeta = recalcConversation(conversationId, trimmedMessages);

        const conversations = current.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, ...conversationMeta } : conv
        );

        return { messages: trimmedMessages, conversations, lastError: null };
      });

      const messagesForRequest = getOrderedConversationMessages(conversationId).map(
        (message) => ({
          role: message.role,
          content: message.content,
        })
      );

      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        task_id: target.task_id,
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
      };

      get().addMessage(assistantMessage);
      set({ isLoading: true });

      try {
        const response = await services.sendChat({
          providerId: selectedProviderId,
          modelId: selectedModelId,
          messages: messagesForRequest,
        });

        get().updateMessageContent(assistantMessage.id, response.message.content);
        set({ isLoading: false });
      } catch (error) {
        const normalized = toServiceError(error);
        get().updateMessageContent(
          assistantMessage.id,
          `Error: ${normalized.message}`
        );
        set({ isLoading: false, lastError: normalized.message });
      }
    },

    initialize: async () => {
      set({ isLoading: true, lastError: null });
      try {
        const [{ conversations }, { messages }] = await Promise.all([
          services.listConversations(),
          services.listMessages(),
        ]);
        set({
          conversations,
          messages,
          selectedConversationId: conversations[0]?.id ?? null,
          isLoading: false,
        });
      } catch (error) {
        const normalized = toServiceError(error);
        set({ isLoading: false, lastError: normalized.message });
      }
    },
  };
});
