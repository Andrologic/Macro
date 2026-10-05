import type { InternalAgentProfile } from "./internalAgentProfile";
import { useAppStore } from '../stores/useAppStore';
import * as tauriIpc from './tauriIpc';
import { useTaskStore } from '../stores/useTaskStore';
import { buildCodeConflictAssistantPrompt, buildMacroConflictAssistantPrompt } from './conflictResolution';
import { getConflictAssistantContext, clearConflictAssistantContext, registerConflictAssistantContext, verifyConflictAssistantRepositories, getConflictAssistantGroupId, type ConflictAssistantContextRequest } from './conflictAssistantContext';
import { useChatStore } from '../stores/useChatStore';

export interface ConflictAssistantOptions {
  prompt: string;
  context?: ConflictAssistantContextRequest;
  internalAgentProfile?: InternalAgentProfile;
  conversationTitle?: string;
  scope?: { projectId: string; groupId: string | null };
}

const DEFAULT_CONFLICT_ASSISTANT_TITLE = 'Resolve merge conflicts';

// Drafts wait for an explicit composer send. Verified contexts retain their
// read-only profile for the whole session; legacy drafts keep a pending profile.
const pendingConflictAssistantProfiles = new Map<
  string,
  InternalAgentProfile
>();

export const getConflictAssistantInternalAgentProfile = (
  conversationId: string,
): InternalAgentProfile | undefined =>
  getConflictAssistantContext(conversationId) ? 'repo_auditor' : pendingConflictAssistantProfiles.get(conversationId);

export const clearConflictAssistantInternalAgentProfile = (
  conversationId: string,
): void => {
  pendingConflictAssistantProfiles.delete(conversationId);
};

export const openConflictAssistant = async (
  options: ConflictAssistantOptions
): Promise<string> => {
  const { conversationTitle } = options;
  let prompt = options.prompt;

  const appState = useAppStore.getState();
  const initialSelection = [appState.mode, appState.selectedTaskId, appState.selectedProjectId, appState.selectedGroupId];
  const projects = [...(appState.standaloneProjects ?? []), ...(appState.projectGroups ?? []).flatMap(group => group.projects)];
  const repositories = options.context
    ? await verifyConflictAssistantRepositories(options.context, projects, tauriIpc, useTaskStore.getState().tasks)
    : undefined;
  if (repositories) {
    const current = useAppStore.getState();
    if ([current.mode, current.selectedTaskId, current.selectedProjectId, current.selectedGroupId].some((value, index) => value !== initialSelection[index])) {
      throw new Error('Selection changed while verifying the conflict context.');
    }
  }
  const scope = repositories ? {
    projectId: repositories[0]!.projectId,
    groupId: getConflictAssistantGroupId(repositories, appState.projectGroups),
  } : options.scope;
  if (repositories && scope) {
    await appState.switchProjectContext(scope.projectId, { restoreProjectContext: false, ensureAutoPlan: false });
    const current = useAppStore.getState();
    if (current.mode !== initialSelection[0] || current.selectedProjectId !== scope.projectId || current.selectedGroupId !== scope.groupId ||
      (current.selectedTaskId !== null && current.selectedTaskId !== initialSelection[1])) {
      throw new Error('Selection changed while opening the conflict context.');
    }
    if (options.context?.kind === 'code') prompt = buildCodeConflictAssistantPrompt({
      repositories: repositories.map(repo => ({ ...repo, upstreamBranch: repo.upstreamBranch ?? '' })),
    });
    else prompt = buildMacroConflictAssistantPrompt({ repositories: repositories.map(repo => ({
      projectId: repo.projectId, repoPath: repo.projectPath, worktreePath: repo.repoPath,
      state: 'conflict', reason: repo.mergeInProgress ? 'merge_conflict' : 'diverged',
      nextAction: 'resolve_conflict', error: null, conflictFiles: repo.conflictFiles,
    })) });
  }
  // Footer actions explicitly announce Implement before entering this mode.
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
    scope?.projectId ?? appState.selectedProjectId,
    scope ? scope.groupId : appState.selectedGroupId
  );

  if (repositories && scope && options.context) registerConflictAssistantContext({
    conversationId: conversation.id, kind: options.context.kind, ...scope, repositories,
  });

  pendingConflictAssistantProfiles.set(
    conversation.id,
    repositories ? 'repo_auditor' : options.internalAgentProfile ?? 'repo_auditor',
  );

  chatStore.setComposerDraft(conversation.id, prompt);
  const selected = await chatStore.selectConversation(conversation.id);
  if (!selected && repositories) {
    clearConflictAssistantContext(conversation.id);
    throw new Error('The verified conflict conversation could not be selected.');
  }
  if (!selected) {
    // Surface a warning so the caller can react. The draft is still in the
    // store; if the user retries or the next selection picks the same
    // conversation, the draft will be applied.
    console.warn(
      `[conflictAssistant] selectConversation returned false for ${conversation.id}; draft will be applied on the next mount.`
    );
  }

  // The user reviews the draft and sends it manually. The store also enforces
  // the profile and revalidates the Git context on every send.
  return conversation.id;
};
