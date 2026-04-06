import type { InternalAgentProfile } from "./internalAgentProfile";
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';

export const openConflictAssistant = async (
  prompt: string,
  internalAgentProfile: InternalAgentProfile = "repo_auditor"
): Promise<string> => {
  const appState = useAppStore.getState();
  appState.setMode('Implement');
  const chatStore = useChatStore.getState();
  const conversationId =
    (await chatStore.ensureConversationForCurrentMode()) ||
    (
      await chatStore.createConversation(
        'Repository review',
        null,
        appState.selectedProjectId,
        appState.selectedGroupId
      )
    ).id;

  await chatStore.sendMessage({
    conversationId,
    content: prompt,
    internalAgentProfile,
  });
  return conversationId;
};
