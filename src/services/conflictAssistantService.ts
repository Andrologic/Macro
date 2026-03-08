import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';

export const openConflictAssistant = async (prompt: string): Promise<string> => {
  useAppStore.getState().setMode('Debug');
  const chatStore = useChatStore.getState();
  const conversationId = await chatStore.ensureConversationForCurrentMode();
  if (!conversationId) {
    throw new Error('No Debug conversation available.');
  }

  await chatStore.sendMessage({ conversationId, content: prompt });
  return conversationId;
};
