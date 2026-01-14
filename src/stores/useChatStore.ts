import { create } from 'zustand';
import { ChatMessage } from '../types';
import { mockChatMessages } from '../mock-data/auth-scenario';

interface ChatStore {
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  updateLastMessage: (content: string) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: mockChatMessages,

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
}));
