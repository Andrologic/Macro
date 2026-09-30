import i18n from '../../i18n';
import type { Conversation } from '../../types';
import type { useAppStore } from '../useAppStore';
import type { useTaskStore } from '../useTaskStore';
import { getArchitectPlanVisibleProjectIds, type getArchitectPlan } from '../../services/architectPlanService';
import { resolveProjectExecutionContext, type ProjectExecutionContext } from '../../services/projectExecutionContext';
import type { QueuedSubmission } from './chatQueuedSubmissions';

export async function revalidateQueuedExecutionContext(entry: QueuedSubmission, ports: {
  app: () => ReturnType<typeof useAppStore.getState>;
  tasks: () => ReturnType<typeof useTaskStore.getState>;
  conversations: () => Conversation[];
  getPlan: typeof getArchitectPlan;
}): Promise<ProjectExecutionContext> {
  const captured = entry.intent.executionContext;
  const plan = entry.intent.architectPlan
    ? await ports.getPlan(entry.intent.architectPlan.targetBranch, entry.intent.architectPlan.planId)
    : null;
  if (entry.intent.architectPlan && (!plan || plan.status === 'deleted' || plan.deletedAt || plan.archivedAt ||
    (plan.conversationId && plan.conversationId !== entry.input.conversationId))) {
    throw new Error(i18n.t('chat.queuePlanUnavailable', 'The original plan is unavailable for this queued message.'));
  }
  if (plan && captured.projectIds.some(id => !getArchitectPlanVisibleProjectIds(plan).includes(id))) {
    throw new Error(i18n.t('chat.queueContextChanged', 'The queued message target has changed. Restore its original context before retrying.'));
  }
  const app = ports.app();
  const tasks = ports.tasks();
  const taskId = entry.input.taskId ?? entry.intent.conversationTaskId ?? entry.intent.selectedTaskId;
  const merge = taskId && typeof tasks.getMergeWorkflowRuntime === 'function'
    ? tasks.getMergeWorkflowRuntime(taskId) : null;
  const mergeRepositories = merge?.repositories ?? [];
  const mergeFocus = mergeRepositories.find(repository => repository.projectId === captured.focusedProjectId)
    ?? mergeRepositories[0];
  const current = resolveProjectExecutionContext({
    mode: entry.intent.mode,
    projects: [...(app.standaloneProjects ?? []), ...app.projectGroups.flatMap(group => group.projects)],
    projectGroups: app.projectGroups,
    tasks: tasks.tasks,
    conversations: ports.conversations(),
    conversationId: entry.input.conversationId,
    selectedGroupId: captured.groupId,
    selectedProjectId: captured.focusedProjectId,
    selectedTaskId: taskId,
    branchWorktrees: tasks.branchWorktrees,
    workspacePathOverridesByProjectId: Object.fromEntries(mergeRepositories.map(repository => [repository.projectId, repository.repoPath])),
    activeRepositoryPath: mergeFocus?.repoPath,
    architectExecutionModesByProjectId: plan?.executionModesByProjectId,
  });
  // A changed target requires the user to resolve the queued intent, never a
  // silent switch to a different repository. Access modes come from live state.
  if (current.taskId !== captured.taskId ||
    JSON.stringify([...current.projectIds].sort()) !== JSON.stringify([...captured.projectIds].sort()) ||
    captured.projectIds.some(id => current.workspacePathsByProjectId[id] !== captured.workspacePathsByProjectId[id])) {
    throw new Error(i18n.t('chat.queueContextChanged', 'The queued message target has changed. Restore its original context before retrying.'));
  }
  return { ...current, branchName: captured.branchName };
}
