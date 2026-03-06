import type { AppMode, Conversation, Project } from '../types';

export interface ExecutionTaskLike {
  id: string;
  project_id: string;
  assigned_branch?: string | null;
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
  const taskId =
    conversationTaskId ||
    (input.mode === 'Implement' ? selectedTaskId : null);
  const task = taskId ? taskById.get(taskId) || null : null;

  const projectId =
    cleanString(task?.project_id) ||
    cleanString(conversation?.project_id) ||
    cleanString(input.selectedProjectId) ||
    null;
  const project = projectId ? projectById.get(projectId) || null : null;
  const branchName = cleanString(task?.assigned_branch);

  const branchWorktree =
    branchName && input.branchWorktrees
      ? cleanString(input.branchWorktrees[branchName])
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
