import { create } from 'zustand';
import { ChatMessage, Conversation } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';

interface ChatStore {
  messages: ChatMessage[];
  conversations: Conversation[];
  selectedConversationId: string | null;
  isLoading: boolean;
  lastError: string | null;
  addMessage: (message: ChatMessage) => void;
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
  initialize: () => Promise<void>;
}

export const useChatStore = create<ChatStore>((set, get) => {
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
