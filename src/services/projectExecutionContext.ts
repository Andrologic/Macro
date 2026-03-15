import type { AppMode, Conversation, Project, ProjectGroup, ProjectMount, TaskExecutionTarget } from '../types';
import { buildProjectMounts } from './projectMounts';
import { getFocusedProjectForGroup, getGlobalProjectById, getProjectGroupByProjectId } from './globalProjects';

export interface ExecutionTaskLike {
  id: string;
  project_id: string;
  project_ids?: string[];
  assigned_branch?: string | null;
  execution_targets?: TaskExecutionTarget[];
}

export interface ResolveProjectExecutionContextInput {
  mode: AppMode;
  projects: Project[];
  projectGroups?: ProjectGroup[];
  tasks?: ExecutionTaskLike[];
  conversations?: Conversation[];
  conversationId?: string | null;
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
  selectedTaskId?: string | null;
  activeRepositoryPath?: string | null;
  branchWorktrees?: Record<string, string>;
}

export interface ProjectExecutionContext {
  groupId: string | null;
  groupName: string | null;
  projectIds: string[];
  projectMounts: ProjectMount[];
  focusedProjectId: string | null;
  virtualRootEnabled: boolean;
  workspacePathsByProjectId: Record<string, string>;
  defaultWorkspacePath: string | null;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  branchName: string | null;
  workspacePath: string | null;
}

const cleanString = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const normalized = cleanString(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
};

const getExecutionTargets = (task: ExecutionTaskLike | null): TaskExecutionTarget[] => {
  if (!task?.execution_targets?.length) return [];
  return task.execution_targets;
};

export const resolveProjectExecutionContext = (
  input: ResolveProjectExecutionContextInput
): ProjectExecutionContext => {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const taskById = new Map((input.tasks || []).map((task) => [task.id, task]));
  const projectGroups = input.projectGroups || [];

  const conversationId = cleanString(input.conversationId);
  const conversation = conversationId
    ? (input.conversations || []).find((candidate) => candidate.id === conversationId) || null
    : null;

  const selectedTaskId = cleanString(input.selectedTaskId);
  const conversationTaskId = cleanString(conversation?.task_id);
  const taskId = conversationTaskId || (input.mode === 'Implement' ? selectedTaskId : null);
  const task = taskId ? taskById.get(taskId) || null : null;

  const selectedProjectId = cleanString(input.selectedProjectId);
  const selectedGroupId = cleanString(input.selectedGroupId);
  const executionTargets = getExecutionTargets(task);
  const selectedExecutionTarget = executionTargets.find((target) => target.projectId === selectedProjectId) || null;
  const executionTarget = selectedExecutionTarget || executionTargets[0] || null;

  const taskProjectIds = uniqueStrings([
    ...executionTargets.map((target) => target.projectId),
    ...(task?.project_ids || []),
    task?.project_id,
  ]);
  const conversationProjectId = cleanString(conversation?.project_id);
  const conversationGroupId = cleanString(conversation?.group_id);

  const inferredGroupId =
    conversationGroupId ||
    getProjectGroupByProjectId(projectGroups, executionTarget?.projectId)?.id ||
    getProjectGroupByProjectId(projectGroups, task?.project_id)?.id ||
    selectedGroupId ||
    getProjectGroupByProjectId(projectGroups, conversationProjectId)?.id ||
    getProjectGroupByProjectId(projectGroups, selectedProjectId)?.id ||
    null;

  const globalProject = getGlobalProjectById(projectGroups, inferredGroupId);
  const focusedProjectId =
    selectedProjectId ||
    cleanString(executionTarget?.projectId) ||
    conversationProjectId ||
    cleanString(task?.project_id) ||
    (inferredGroupId
      ? getFocusedProjectForGroup(
          projectGroups,
          inferredGroupId,
          selectedProjectId || conversationProjectId || cleanString(executionTarget?.projectId)
        )?.id
      : null) ||
    null;
  const scopedProjectIds = uniqueStrings([
    ...(taskProjectIds.length > 0 ? taskProjectIds : []),
    ...(globalProject?.subProjectIds || []),
    conversationProjectId,
    focusedProjectId,
  ]);

  const projectId =
    cleanString(executionTarget?.projectId) ||
    cleanString(task?.project_id) ||
    conversationProjectId ||
    focusedProjectId ||
    globalProject?.primarySubProjectId ||
    scopedProjectIds[0] ||
    null;
  const project = projectId ? projectById.get(projectId) || null : null;

  const branchName = cleanString(
    (projectId
      ? executionTargets.find((target) => target.projectId === projectId)?.branchName
      : null) ||
      executionTarget?.branchName ||
      task?.assigned_branch
  );

  const canReuseActiveRepository =
    input.mode === 'Implement' &&
    (!taskId || !selectedTaskId || taskId === selectedTaskId);

  const workspacePathsByProjectId = scopedProjectIds.reduce<Record<string, string>>((acc, scopedProjectId) => {
    const matchingTarget = executionTargets.find((target) => target.projectId === scopedProjectId) || null;
    const branchWorktree = input.branchWorktrees
      ? cleanString(
          (matchingTarget?.worktreeKey ? input.branchWorktrees[matchingTarget.worktreeKey] : null) ||
            (matchingTarget?.branchName ? input.branchWorktrees[matchingTarget.branchName] : null)
        )
      : null;
    const resolvedPath =
      branchWorktree ||
      cleanString(matchingTarget?.repoPath) ||
      cleanString(projectById.get(scopedProjectId)?.path) ||
      null;

    if (resolvedPath) {
      acc[scopedProjectId] = resolvedPath;
    }
    return acc;
  }, {});

  const defaultWorkspacePath =
    (projectId ? workspacePathsByProjectId[projectId] : null) ||
    (canReuseActiveRepository ? cleanString(input.activeRepositoryPath) : null) ||
    cleanString(project?.path) ||
    Object.values(workspacePathsByProjectId)[0] ||
    null;
  const projectMounts = buildProjectMounts({
    projectGroups,
    groupId: inferredGroupId,
    projectIds: scopedProjectIds,
    workspacePathsByProjectId,
  });
  const fallbackProjectMounts =
    projectMounts.length > 0
      ? projectMounts
      : scopedProjectIds
          .map((scopedProjectId) => {
            const scopedProject = projectById.get(scopedProjectId);
            if (!scopedProject) return null;
            return {
              projectId: scopedProject.id,
              groupId: getProjectGroupByProjectId(projectGroups, scopedProject.id)?.id || null,
              mountName: scopedProject.mountName,
              displayName: scopedProject.name,
              workspacePath: workspacePathsByProjectId[scopedProject.id] || cleanString(scopedProject.path),
            };
          })
          .filter((mount): mount is ProjectMount => Boolean(mount));
  const virtualRootEnabled = Boolean(inferredGroupId && fallbackProjectMounts.length > 0);

  return {
    groupId: inferredGroupId,
    groupName: cleanString(globalProject?.name),
    projectIds: scopedProjectIds,
    projectMounts: fallbackProjectMounts,
    focusedProjectId,
    virtualRootEnabled,
    workspacePathsByProjectId,
    defaultWorkspacePath,
    projectId,
    projectName: cleanString(project?.name),
    taskId,
    branchName,
    workspacePath: defaultWorkspacePath,
  };
};
