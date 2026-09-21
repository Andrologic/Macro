import { useAppStore } from '../../stores/useAppStore';
import { desktopTaskCompletionSource } from './desktopTaskCompletionSource';
import { desktopPilotTasks } from './desktopTaskCatalog';
import { pilotTaskId, findPilotTask } from './taskIdentity';
import { gitBranchList, pilotContentPolicy, pilotReviewCommit, dbGetAppSetting, dbCompareAndSwapAppSetting } from '../tauriIpc';
import { ContentHost, CONTENT_BUDGET, type ReviewTarget } from './contentHost';
import { ConversationCaptures } from './conversationCaptures';
import { conversationCaptureStorage, desktopConversationCaptureSource } from './conversationCaptureSource';
import type { TextPolicy } from './conversationText';
import { createReviewCaptureService } from './reviewCapture';
import type { PilotKernel } from './kernel';
import type { ContentReviewRef } from './contentProtocol';
import { object } from './protocol';

/** Stable local review IDs, scoped by the real task/project; no invented run. */
export const LOCAL_REVIEW_IDS = { staged: 'review:staged', unstaged: 'review:unstaged', local_total: 'review:local_total' } as const;
export interface DesktopContentOptions {
  configurationId: string; accountId: string; instanceId: string;
  signal: AbortSignal; kernel: PilotKernel; transportSecrets(): Promise<string[]>;
}
export function secretForms(values: string[]): string[] {
  const result = new Set<string>();
  const add = (value: string) => {
    if (!value) return;
    result.add(value); result.add(encodeURIComponent(value)); result.add(JSON.stringify(value).slice(1, -1));
    const bytes = new TextEncoder().encode(value);
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const base64 = btoa(binary); result.add(base64); result.add(base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''));
  };
  for (const value of values) {
    add(value);
    // Some existing vault entries are JSON OAuth token bundles.
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        const pending: unknown[] = [JSON.parse(value)];
        while (pending.length) {
          const item = pending.pop();
          if (typeof item === 'string') add(item);
          else if (item && typeof item === 'object') pending.push(...Object.values(item));
        }
      } catch { /* The raw non-JSON value is still checked. */ }
    }
  }
  const forms = [...result].sort();
  if (forms.length > 4096 || forms.reduce((size, value) => size + new TextEncoder().encode(value).length, 0) > 1024 * 1024) throw new Error('resource_limit');
  return forms;
}
export function createDesktopContentHost(options: DesktopContentOptions): ContentHost {
  const { configurationId, instanceId, accountId, signal } = options;
  const workspaceId = `workspace:${configurationId}`;
  let policy: TextPolicy = { revision: 'visible-1', secrets: [] };
  const key = `macroPilot:content-host:v2:${JSON.stringify([configurationId, instanceId, accountId])}`;
  const resolveReview = async (ref: ContentReviewRef): Promise<ReviewTarget> => {
    if (ref.instance_id !== instanceId || ref.workspace_id !== workspaceId) throw new Error('not_found');
    const workspace = useAppStore.getState();
    const projects = [...workspace.standaloneProjects, ...workspace.projectGroups.flatMap(group => group.projects)];
    const project = projects.find(project => project.id === ref.project_id);
    const task = findPilotTask(desktopPilotTasks(), ref.task_id);
    const target = task?.execution_targets?.find(target => target.projectId === ref.project_id);
    if (!project || !task || (task.project_id !== ref.project_id && !target)) throw new Error('not_found');
    const repoPath = target?.repoPath ?? project.path;
    if (!repoPath) throw new Error('content_unavailable');
    const localKind = (Object.keys(LOCAL_REVIEW_IDS) as Array<keyof typeof LOCAL_REVIEW_IDS>).find(kind => LOCAL_REVIEW_IDS[kind] === ref.review_id);
    if (localKind) {
      if (ref.run_id) throw new Error('not_found');
      return { repoPath, source: { kind: localKind } };
    }
    const review = options.kernel.getReviews().find(review => review.ref.review_id === ref.review_id && review.ref.task_id === ref.task_id && review.ref.project_id === ref.project_id && review.ref.run_id === ref.run_id && review.ref.workspace_id === ref.workspace_id);
    if (!review || !target || task.status !== 'InReview' || target.executionMode === 'direct' || !target.targetBranchName) throw new Error('not_found');
    const revision = object(review.git_revision);
    const branches = await gitBranchList(repoPath);
    if (typeof revision.base_sha !== 'string' || typeof revision.head_sha !== 'string' ||
      branches.local.find(branch => branch.name === target.targetBranchName)?.commit !== revision.base_sha ||
      branches.local.find(branch => branch.name === target.branchName)?.commit !== revision.head_sha) throw new Error('stale_revision');
    return { repoPath, source: { kind: 'commits', base_sha: revision.base_sha, head_sha: revision.head_sha }, branches: { base: target.targetBranchName, head: target.branchName! } };
  };
  const conversations = new ConversationCaptures({ instanceId, workspaceId, source: desktopConversationCaptureSource(),
      storage: conversationCaptureStorage(configurationId, instanceId), policy: () => policy, quotaBytes: CONTENT_BUDGET.conversations });
  const taskKey = `${key}:task-completion:1`;
  return new ContentHost({ accountId, instanceId, signal, conversations,
    taskCompletion: { source: desktopTaskCompletionSource(instanceId, workspaceId, conversations, signal), storage: {
      load: async () => (await dbGetAppSetting(taskKey))?.value_json ?? null,
      compareAndSwap: async (previous, next) => (await dbCompareAndSwapAppSetting({ key: taskKey, expectedValueJson: previous, valueJson: next })).applied,
    } },
    reviews: createReviewCaptureService(), resolveReview,
    reviewRefs: async () => {
      const tasks = desktopPilotTasks();
      const refs: ContentReviewRef[] = [];
      for (const task of tasks) {
        for (const projectId of new Set([task.project_id, ...(task.execution_targets ?? []).map(target => target.projectId)])) {
          if (!projectId) continue;
          for (const reviewId of Object.values(LOCAL_REVIEW_IDS)) refs.push({ instance_id: instanceId, workspace_id: workspaceId, task_id: pilotTaskId(task.id), project_id: projectId, review_id: reviewId });
        }
      }
      for (const review of options.kernel.getReviews()) {
        const { instance_id, workspace_id, task_id, project_id, review_id, run_id } = review.ref;
        refs.push({ instance_id, workspace_id, task_id, project_id, review_id, ...(run_id ? { run_id } : {}) });
      }
      return refs;
    },
    commitReview: (snapshotId, request, previous, value, executeBefore, target) => pilotReviewCommit({ snapshotId, request, key, expectedValueJson: previous, valueJson: value, executeBefore, branches: target.branches }),
    storage: { load: async () => (await dbGetAppSetting(key))?.value_json ?? null,
      compareAndSwap: async (previous, next) => (await dbCompareAndSwapAppSetting({ key, expectedValueJson: previous, valueJson: next })).applied },
    policy: async () => {
      // The native boundary also rejects unsupported review platforms before the
      // first v2 producer poll can advertise the complete content extension.
      const values = await pilotContentPolicy();
      policy = { revision: 'visible-1', secrets: secretForms([...values, ...await options.transportSecrets()]) };
      return policy;
    },
  });
}
