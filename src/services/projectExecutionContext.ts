import type { AppMode, Conversation, Project, TaskExecutionTarget } from '../types';

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
  tasks?: ExecutionTaskLike[];
  conversations?: Conversation[];
  conversationId?: string | null;
  selectedProjectId?: string | null;
  selectedTaskId?: string | null;
  activeRepositoryPath?: string | null;
  branchWorktrees?: Record<string, string>;
}

export interface ProjectExecutionContext {
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

export const resolveProjectExecutionContext = (
  input: ResolveProjectExecutionContextInput
): ProjectExecutionContext => {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const taskById = new Map((input.tasks || []).map((task) => [task.id, task]));
  const conversationId = cleanString(input.conversationId);
  const conversation = conversationId
    ? (input.conversations || []).find((candidate) => candidate.id === conversationId) || null
    : null;

  const selectedTaskId = cleanString(input.selectedTaskId);
  const conversationTaskId = cleanString(conversation?.task_id);
  const taskId = conversationTaskId || (input.mode === 'Implement' ? selectedTaskId : null);
  const task = taskId ? taskById.get(taskId) || null : null;

  const selectedProjectId = cleanString(input.selectedProjectId);
  const executionTarget = task?.execution_targets?.find((target) => target.projectId === selectedProjectId)
    || task?.execution_targets?.[0]
    || null;

  const projectId =
    cleanString(executionTarget?.projectId) ||
    cleanString(task?.project_id) ||
    cleanString(conversation?.project_id) ||
    selectedProjectId ||
    null;
  const project = projectId ? projectById.get(projectId) || null : null;
  const branchName = cleanString(executionTarget?.branchName || task?.assigned_branch);

  const branchWorktree = input.branchWorktrees
    ? cleanString(
        (executionTarget?.worktreeKey ? input.branchWorktrees[executionTarget.worktreeKey] : null)
          || (branchName ? input.branchWorktrees[branchName] : null)
      )
    : null;
  const canReuseActiveRepository =
    input.mode === 'Implement' &&
    (!taskId || !selectedTaskId || taskId === selectedTaskId);
  const workspacePath =
    branchWorktree ||
    (canReuseActiveRepository ? cleanString(input.activeRepositoryPath) : null) ||
    cleanString(project?.path) ||
    null;

  return {
    projectId,
    projectName: cleanString(project?.name),
    taskId,
    branchName,
    workspacePath,
  };
};
