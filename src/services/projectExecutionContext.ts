import type { AppMode, Conversation, Project, ProjectGroup, ProjectMount, TaskExecutionTarget } from '../types';
import { buildProjectMounts } from './projectMounts';
import {
  getFocusedProjectForGroup,
  getGlobalProjectById,
  getProjectGroupByProjectId,
  isProjectActionable,
  isProjectReadOnly,
} from './globalProjects';
import { resolveCachedPreparedTaskWorktreePath } from './preparedTaskWorktrees';
import { retargetTaskForExecution } from './projectIdentityReconciliation';

export interface ExecutionTaskLike {
  id: string;
  project_id: string;
  project_ids?: string[];
  context_project_ids?: string[];
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
  workspacePathOverridesByProjectId?: Record<string, string>;
  branchWorktrees?: Record<string, string>;
}

export interface ProjectExecutionContext {
  groupId: string | null;
  groupName: string | null;
  projectIds: string[];
  actionableProjectIds: string[];
  contextProjectIds: string[];
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

const resolveSelectedScopeProjectIds = (params: {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  projectGroups: ProjectGroup[];
  projectById: Map<string, Project>;
}): string[] => {
  if (params.selectedGroupId) {
    const groupProjectIds =
      params.projectGroups
        .find((group) => group.id === params.selectedGroupId)
        ?.projects.map((project) => project.id) ?? [];
    if (groupProjectIds.length > 0) {
      return groupProjectIds;
    }
  }
  return params.selectedProjectId && params.projectById.has(params.selectedProjectId)
    ? [params.selectedProjectId]
    : [];
};

export const resolveProjectExecutionContext = (
  input: ResolveProjectExecutionContextInput
): ProjectExecutionContext => {
  if (input.mode === 'Chat') {
    return {
      groupId: null,
      groupName: null,
      projectIds: [],
      actionableProjectIds: [],
      contextProjectIds: [],
      projectMounts: [],
      focusedProjectId: null,
      virtualRootEnabled: false,
      workspacePathsByProjectId: {},
      defaultWorkspacePath: null,
      projectId: null,
      projectName: null,
      taskId: null,
      branchName: null,
      workspacePath: null,
    };
  }

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
  const selectedProjectId = cleanString(input.selectedProjectId);
  const selectedGroupId = cleanString(input.selectedGroupId);
  const selectedKnownProjectId =
    selectedProjectId && projectById.has(selectedProjectId) ? selectedProjectId : null;
  const selectedScopeProjectIds = resolveSelectedScopeProjectIds({
    selectedGroupId,
    selectedProjectId: selectedKnownProjectId,
    projectGroups,
    projectById,
  });
  const rawTask = taskId ? taskById.get(taskId) || null : null;
  const task = rawTask
    ? retargetTaskForExecution(rawTask, {
        scopedProjectIds: selectedScopeProjectIds,
        knownProjectIds: Array.from(projectById.keys()),
      })
    : null;
  const executionTargets = getExecutionTargets(task).filter((target) => projectById.has(target.projectId));
  const selectedExecutionTarget = executionTargets.find((target) => target.projectId === selectedProjectId) || null;
  const executionTarget = selectedExecutionTarget || executionTargets[0] || null;

  const taskProjectIds = uniqueStrings([
    ...executionTargets.map((target) => target.projectId),
    ...(task?.project_ids || []),
    task?.project_id,
  ]).filter((projectId) => projectById.has(projectId));
  const taskContextProjectIds = uniqueStrings(task?.context_project_ids || [])
    .filter((projectId) => projectById.has(projectId));
  const conversationProjectId = cleanString(conversation?.project_id);
  const knownConversationProjectId =
    conversationProjectId && projectById.has(conversationProjectId)
      ? conversationProjectId
      : null;
  const conversationGroupId = cleanString(conversation?.group_id);

  const inferredGroupId =
    conversationGroupId ||
    getProjectGroupByProjectId(projectGroups, executionTarget?.projectId)?.id ||
    getProjectGroupByProjectId(projectGroups, taskProjectIds[0])?.id ||
    selectedGroupId ||
    getProjectGroupByProjectId(projectGroups, knownConversationProjectId)?.id ||
    getProjectGroupByProjectId(projectGroups, selectedKnownProjectId)?.id ||
    null;

  const globalProject = getGlobalProjectById(projectGroups, inferredGroupId);
  const candidateFocusedProjectId =
    selectedKnownProjectId ||
    cleanString(executionTarget?.projectId) ||
    knownConversationProjectId ||
    taskProjectIds[0] ||
    (inferredGroupId
      ? getFocusedProjectForGroup(
          projectGroups,
          inferredGroupId,
          selectedKnownProjectId || knownConversationProjectId || cleanString(executionTarget?.projectId)
        )?.id
      : null) ||
    null;
  const hasTaskScope = taskProjectIds.length > 0 || taskContextProjectIds.length > 0;
  const scopedProjectIds = uniqueStrings([
    ...(hasTaskScope
      ? [...taskProjectIds, ...taskContextProjectIds]
      : [
          ...(globalProject?.subProjectIds || []),
          knownConversationProjectId,
          candidateFocusedProjectId,
        ]),
  ]);
  const focusedProjectId = candidateFocusedProjectId && scopedProjectIds.includes(candidateFocusedProjectId)
    ? candidateFocusedProjectId
    : cleanString(executionTarget?.projectId) ||
      taskProjectIds[0] ||
      scopedProjectIds[0] ||
      null;
  const actionableProjectIds = hasTaskScope
    ? taskProjectIds.filter((scopedProjectId) =>
        isProjectActionable(projectById.get(scopedProjectId) || null)
      )
    : scopedProjectIds.filter((scopedProjectId) =>
        isProjectActionable(projectById.get(scopedProjectId) || null)
      );
  const actionableProjectIdSet = new Set(actionableProjectIds);
  const contextProjectIds = hasTaskScope
    ? taskContextProjectIds.filter((scopedProjectId) => !actionableProjectIdSet.has(scopedProjectId))
    : scopedProjectIds.filter((scopedProjectId) =>
        isProjectReadOnly(projectById.get(scopedProjectId) || null)
      );

  const projectId =
    cleanString(executionTarget?.projectId) ||
    taskProjectIds[0] ||
    knownConversationProjectId ||
    focusedProjectId ||
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
    const workspacePathOverride = input.workspacePathOverridesByProjectId
      ? cleanString(input.workspacePathOverridesByProjectId[scopedProjectId])
      : null;
    const branchWorktree = input.branchWorktrees
      ? cleanString(
          matchingTarget
            ? resolveCachedPreparedTaskWorktreePath(matchingTarget, input.branchWorktrees)
            : null
        )
      : null;
    const resolvedPath =
      workspacePathOverride ||
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
      : scopedProjectIds.reduce<ProjectMount[]>((mounts, scopedProjectId) => {
          const scopedProject = projectById.get(scopedProjectId);
          if (!scopedProject) {
            return mounts;
          }

          mounts.push({
            projectId: scopedProject.id,
            groupId: getProjectGroupByProjectId(projectGroups, scopedProject.id)?.id || null,
            mountName: scopedProject.mountName,
            displayName: scopedProject.name,
            workspacePath: workspacePathsByProjectId[scopedProject.id] || cleanString(scopedProject.path),
            isReadOnly: Boolean(scopedProject.isReadOnly),
          });
          return mounts;
        }, []);
  const scopedProjectMounts = hasTaskScope
    ? fallbackProjectMounts.map((mount) => ({
        ...mount,
        isReadOnly: contextProjectIds.includes(mount.projectId) || mount.isReadOnly,
      }))
    : fallbackProjectMounts;
  const virtualRootEnabled = Boolean(inferredGroupId && fallbackProjectMounts.length > 0);

  return {
    groupId: inferredGroupId,
    groupName: cleanString(globalProject?.name),
    projectIds: scopedProjectIds,
    actionableProjectIds,
    contextProjectIds,
    projectMounts: scopedProjectMounts,
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
