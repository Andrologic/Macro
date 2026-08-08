import type { InternalAgentProfile } from "./internalAgentProfile";
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';

export interface ConflictAssistantOptions {
  prompt: string;
  internalAgentProfile?: InternalAgentProfile;
  conversationTitle?: string;
}

const DEFAULT_CONFLICT_ASSISTANT_TITLE = 'Resolve merge conflicts';

// Conflict conversations are intentionally prepared in the composer instead
// of being sent immediately. Keep the profile alongside the pending
// conversation so the eventual composer send still uses the repo auditor
// contract.
const pendingConflictAssistantProfiles = new Map<
  string,
  InternalAgentProfile
>();

export const getConflictAssistantInternalAgentProfile = (
  conversationId: string,
): InternalAgentProfile | undefined =>
  pendingConflictAssistantProfiles.get(conversationId);

export const clearConflictAssistantInternalAgentProfile = (
  conversationId: string,
): void => {
  pendingConflictAssistantProfiles.delete(conversationId);
};

export const openConflictAssistant = async (
  options: ConflictAssistantOptions
): Promise<string> => {
  const { prompt, conversationTitle } = options;

  const appState = useAppStore.getState();
  appState.setMode('Implement');

  // Clear the currently selected task so the new conversation (which has
  // no task_id) is allowed in Implement mode by isConversationAllowedForMode.
  // Without this, selectConversation returns false silently when the user
  // has a task selected (the typical case for a merge conflict).
  if (appState.selectedTaskId !== null) {
    appState.setSelectedTask(null);
  }

  const chatStore = useChatStore.getState();
  const title = conversationTitle ?? DEFAULT_CONFLICT_ASSISTANT_TITLE;
  const conversation = await chatStore.createConversation(
    title,
    null,
    appState.selectedProjectId,
    appState.selectedGroupId
  );

  pendingConflictAssistantProfiles.set(
    conversation.id,
    options.internalAgentProfile ?? 'repo_auditor',
  );

  chatStore.setComposerDraft(conversation.id, prompt);
  const selected = await chatStore.selectConversation(conversation.id);
  if (!selected) {
    // Surface a warning so the caller can react. The draft is still in the
    // store; if the user retries or the next selection picks the same
    // conversation, the draft will be applied.
    console.warn(
      `[conflictAssistant] selectConversation returned false for ${conversation.id}; draft will be applied on the next mount.`
    );
  }

  // The internalAgentProfile (if any) is consumed at send time by the
  // ChatZone composer. The draft is only prepared; the user reviews and
  // sends manually.
  return conversation.id;
};
