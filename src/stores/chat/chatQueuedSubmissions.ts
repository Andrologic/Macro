import type { ChatSendInput, ChatSendSnapshot } from '../../services/chatSend/contracts';
import { clearPersistenceIssue, reportPersistenceIssue } from '../../services/persistenceHealth';
import { parseComposerDraft } from './chatLocalSessionState';

// The same local storage used by composer recovery. Never persist provider credentials
// or a previously granted tool policy in the deferred business intent.
export const QUEUED_SUBMISSIONS_STORAGE_KEY = 'macro_chat_queued_submissions_v1';
export type QueuedSendIntent = Omit<ChatSendSnapshot, 'provider' | 'composerRevision'> & {
  provider: Pick<ChatSendSnapshot['provider'],
    'selectedProviderId' | 'selectedModelId' | 'selectedReasoningEffort'>;
};
export interface QueuedSubmission {
  id: string;
  input: ChatSendInput;
  intent: QueuedSendIntent;
}

export function captureQueuedSubmission(
  id: string, input: ChatSendInput, snapshot: ChatSendSnapshot,
): QueuedSubmission {
  return structuredClone({
    id,
    input: {
      conversationId: input.conversationId, content: input.content,
      taskId: input.taskId, images: input.images,
      internalAgentProfile: input.internalAgentProfile,
      contextRefs: input.contextRefs ?? snapshot.composerContextRefs,
    },
    intent: {
      mode: snapshot.mode, agentType: snapshot.agentType,
      architectPlan: snapshot.architectPlan,
      conversationTaskId: snapshot.conversationTaskId,
      selectedTaskId: snapshot.selectedTaskId,
      executionContext: {
        ...snapshot.executionContext,
        // These are runtime permissions, not part of the user's queued intent.
        actionableProjectIds: [], contextProjectIds: [],
        projectMounts: snapshot.executionContext.projectMounts.map(mount => ({
          projectId: mount.projectId, groupId: mount.groupId, mountName: mount.mountName,
          displayName: mount.displayName, workspacePath: mount.workspacePath,
        })),
      },
      composerContextRefs: input.contextRefs ?? snapshot.composerContextRefs,
      provider: {
        selectedProviderId: snapshot.provider.selectedProviderId,
        selectedModelId: snapshot.provider.selectedModelId,
        selectedReasoningEffort: snapshot.provider.selectedReasoningEffort,
      },
    },
  });
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 4096;
const nullableText = (v: unknown) => v === null || text(v);
const strings = (v: unknown) => Array.isArray(v) && v.every(text);

function parseQueue(raw: string): QueuedSubmission[] {
  if (raw.length > 40_000_000) throw new Error('Queued submissions exceed the recovery limit. Original data preserved.');
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > 50) throw new Error('Invalid queued submissions. Original data preserved.');
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!record(entry) || !text(entry.id) || !entry.id || ids.has(entry.id) ||
      !record(entry.input) || !record(entry.intent)) throw new Error('Invalid queued submission. Original data preserved.');
    ids.add(entry.id);
    const input = entry.input;
    const intent = entry.intent;
    const scope = intent.executionContext;
    if (!text(input.conversationId) || !input.conversationId ||
      (input.taskId !== undefined && !nullableText(input.taskId)) ||
      (input.internalAgentProfile != null && !['default_executor', 'plan_explorer', 'task_reviewer', 'repo_auditor', 'goal_auditor'].includes(String(input.internalAgentProfile))) ||
      !parseComposerDraft({ text: input.content, images: input.images ?? [], contextRefs: input.contextRefs ?? [] }) ||
      !['Chat', 'Architect', 'Implement'].includes(String(intent.mode)) ||
      !(intent.agentType === null || intent.agentType === 'build' || intent.agentType === 'plan') ||
      !nullableText(intent.conversationTaskId) || !text(intent.selectedTaskId) ||
      (intent.architectPlan !== undefined && (!record(intent.architectPlan) || !text(intent.architectPlan.planId) || !text(intent.architectPlan.targetBranch))) ||
      !record(intent.provider) || Object.keys(intent.provider).some(key => !['selectedProviderId', 'selectedModelId', 'selectedReasoningEffort'].includes(key)) ||
      !nullableText(intent.provider.selectedProviderId) || !nullableText(intent.provider.selectedModelId) || !nullableText(intent.provider.selectedReasoningEffort) ||
      !record(scope) || !strings(scope.projectIds) || !strings(scope.actionableProjectIds) || !strings(scope.contextProjectIds) ||
      !Array.isArray(scope.projectMounts) || !scope.projectMounts.every(mount =>
        record(mount) && text(mount.projectId) && nullableText(mount.groupId) &&
        text(mount.mountName) && text(mount.displayName) && nullableText(mount.workspacePath) &&
        (mount.isReadOnly === undefined || typeof mount.isReadOnly === 'boolean') &&
        (mount.executionMode === undefined || ['git', 'direct', 'blocked', 'invalid'].includes(String(mount.executionMode)))) ||
      !record(scope.workspacePathsByProjectId) ||
      !Object.values(scope.workspacePathsByProjectId).every(text) ||
      !['groupId', 'groupName', 'focusedProjectId', 'defaultWorkspacePath', 'projectId', 'projectName', 'taskId', 'branchName', 'workspacePath'].every(key => nullableText(scope[key])) ||
      typeof scope.virtualRootEnabled !== 'boolean') {
      throw new Error('Invalid queued submission. Original data preserved.');
    }
  }
  return entries as QueuedSubmission[];
}

export function loadQueuedSubmissions(): QueuedSubmission[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(QUEUED_SUBMISSIONS_STORAGE_KEY);
    return raw === null ? [] : parseQueue(raw);
  } catch (error) {
    reportPersistenceIssue(QUEUED_SUBMISSIONS_STORAGE_KEY, String(error));
    return [];
  }
}

export function saveQueuedSubmissions(entries: QueuedSubmission[]): boolean {
  try {
    if (typeof window === 'undefined') throw new Error('Local storage is unavailable.');
    const previous = window.localStorage.getItem(QUEUED_SUBMISSIONS_STORAGE_KEY);
    if (previous !== null) parseQueue(previous);
    const raw = JSON.stringify(entries);
    parseQueue(raw);
    window.localStorage.setItem(QUEUED_SUBMISSIONS_STORAGE_KEY, raw);
    clearPersistenceIssue(QUEUED_SUBMISSIONS_STORAGE_KEY);
    return true;
  } catch (error) {
    reportPersistenceIssue(QUEUED_SUBMISSIONS_STORAGE_KEY, `Queued messages could not be saved. Keep this session open. ${String(error)}`);
    return false;
  }
}
