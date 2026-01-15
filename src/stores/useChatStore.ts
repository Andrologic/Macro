import { create } from 'zustand';
import { ChatMessage, Conversation } from '../types';
import { mockChatMessages, mockConversations } from '../mock-data/auth-scenario';

interface ChatStore {
  messages: ChatMessage[];
  conversations: Conversation[];
  selectedConversationId: string | null;
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
}

export const useChatStore = create<ChatStore>((set, get) => {
  const initialConversations = mockConversations;
  const initialSelectedId = initialConversations.length > 0 ? initialConversations[0].id : null;

  return {
    messages: mockChatMessages,
    conversations: initialConversations,
    selectedConversationId: initialSelectedId,

    addMessage: (message) =>
      set((state) => ({
        messages: [...state.messages, message],
      })),

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
  };
});
