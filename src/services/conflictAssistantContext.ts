import type { AppMode, Conversation, Project, ProjectGroup } from '../types';
import type { ProjectExecutionContext } from './projectExecutionContext';
import type * as ipc from './tauriIpc';

export interface ConflictAssistantRepositoryRequest {
  projectId: string;
  repoPath: string;
  branch?: string;
  upstreamBranch?: string;
  worktreePath?: string | null;
  taskId?: string;
}
export interface ConflictAssistantContextRequest {
  kind: 'code' | 'metadata';
  repositories: ConflictAssistantRepositoryRequest[];
}
export interface VerifiedConflictAssistantContext {
  conversationId: string;
  kind: 'code' | 'metadata';
  projectId: string;
  groupId: string | null;
  repositories: Array<{
    projectId: string;
    projectPath: string;
    repoPath: string;
    branch: string;
    head: string;
    conflictFiles: string[];
    mergeInProgress: boolean;
    upstreamBranch?: string;
    taskId?: string;
  }>;
}
export interface ConflictAssistantSelection {
  mode: AppMode;
  selectedTaskId: string | null;
  selectedProjectId: string | null;
  selectedGroupId: string | null;
  conversation?: Pick<Conversation, 'id' | 'task_id' | 'project_id' | 'group_id' | 'scope_mode'> | null;
  projects: Pick<Project, 'id' | 'path'>[];
  groups: Pick<ProjectGroup, 'id' | 'projects'>[];
  selectedConversationId: string | null;
}
const contexts = new Map<string, VerifiedConflictAssistantContext>();
export const getConflictAssistantContext = (id: string): VerifiedConflictAssistantContext | undefined => contexts.get(id);
export const registerConflictAssistantContext = (context: VerifiedConflictAssistantContext): void => { contexts.set(context.conversationId, context); };
export const clearConflictAssistantContext = (id: string): void => { contexts.delete(id); };

export const isConflictAssistantContextAllowed = (
  context: VerifiedConflictAssistantContext | undefined,
  selection: ConflictAssistantSelection,
): boolean => Boolean(context && context.repositories.length &&
  selection.mode === 'Implement' && !selection.selectedTaskId &&
  selection.selectedConversationId === context.conversationId &&
  selection.conversation?.id === context.conversationId &&
  selection.conversation.scope_mode === 'Implement' && !selection.conversation.task_id &&
  selection.conversation.project_id === context.projectId &&
  (selection.conversation.group_id ?? null) === context.groupId &&
  selection.selectedProjectId === context.projectId && selection.selectedGroupId === context.groupId &&
  (!context.groupId || selection.groups.some(group => group.id === context.groupId &&
    context.repositories.every(repo => group.projects.some(project => project.id === repo.projectId)))) &&
  context.repositories.every(repo => selection.projects.some(project => project.id === repo.projectId && project.path === repo.projectPath)));

export type ConflictAssistantGitPorts = Pick<typeof ipc,
  'gitStatus' | 'gitMergeCheck' | 'gitRebaseCheck' | 'macroBranchStatus' | 'gitWorktreeInspect'>;

export const verifyConflictAssistantRepositories = async (
  request: ConflictAssistantContextRequest,
  projects: Pick<Project, 'id' | 'path'>[],
  ports: ConflictAssistantGitPorts,
  tasks: Array<{ id: string; branch_name?: string | null; project_id?: string | null; project_ids?: string[] }> = [],
): Promise<VerifiedConflictAssistantContext['repositories']> => {
  if (!request.repositories.length || new Set(request.repositories.map(repo => repo.projectId)).size !== request.repositories.length) {
    throw new Error('Conflict context must identify distinct registered projects.');
  }
  return Promise.all(request.repositories.map(async requested => {
    const project = projects.find(project => project.id === requested.projectId);
    if (!project) throw new Error('Conflict project is no longer registered.');
    let repoPath = requested.repoPath;
    if (request.kind === 'metadata') {
      if (repoPath !== project.path) throw new Error('Metadata context does not match the registered project.');
      const metadata = await ports.macroBranchStatus({ workspacePath: project.path });
      if (metadata.branch !== '@macro' || !metadata.worktree_path ||
        (requested.worktreePath && requested.worktreePath !== metadata.worktree_path) ||
        !(metadata.state === 'conflict' || metadata.reason === 'diverged')) {
        throw new Error('Metadata conflict could not be verified.');
      }
      repoPath = metadata.worktree_path;
    } else if (repoPath !== project.path) {
      const task = tasks.find(task => task.id === requested.taskId);
      if (!task || task.branch_name !== requested.branch ||
        ![task.project_id, ...(task.project_ids ?? [])].includes(project.id)) throw new Error('Code worktree has no verified task identity.');
      const worktree = await ports.gitWorktreeInspect({ repoPath: project.path, taskId: task.id, branchName: requested.branch, readOnly: true });
      if (worktree.status !== 'ready' || worktree.worktreePath !== repoPath || worktree.branchName !== requested.branch) {
        throw new Error('Code worktree could not be verified.');
      }
    }
    const status = await ports.gitStatus(repoPath);
    const branch = request.kind === 'metadata' ? '@macro' : requested.branch;
    if (!branch || status.branch !== branch) throw new Error('Conflict branch changed.');
    if (!status.head_commit?.id) throw new Error('Conflict repository HEAD is unavailable.');
    const conflicts = [...(status.conflicted_files ?? []), ...(status.conflictedFiles ?? [])];
    if (!conflicts.length) {
      if (request.kind === 'metadata') {
        if (status.ahead <= 0 || status.behind <= 0) throw new Error('Metadata divergence no longer exists.');
      } else {
        if (!requested.upstreamBranch || !status.has_upstream || status.ahead <= 0 || status.behind <= 0) {
          throw new Error('Code divergence no longer exists.');
        }
        const [merge, rebase] = await Promise.all([
          ports.gitMergeCheck({ repoPath, branchName: requested.upstreamBranch, intoBranch: branch }).catch(() => null),
          ports.gitRebaseCheck({ repoPath, branchName: branch, ontoBranch: requested.upstreamBranch }).catch(() => null),
        ]);
        conflicts.push(...(merge?.conflictFiles ?? []), ...(rebase?.conflictFiles ?? []));
        if (!conflicts.length) throw new Error('Code conflicts could not be verified.');
      }
    }
    return { projectId: project.id, projectPath: project.path, repoPath, branch, head: status.head_commit.id, conflictFiles: Array.from(new Set(conflicts)),
      mergeInProgress: Boolean(status.merge_in_progress || status.mergeInProgress),
      ...(requested.upstreamBranch ? { upstreamBranch: requested.upstreamBranch } : {}),
      ...(requested.taskId ? { taskId: requested.taskId } : {}) };
  }));
};

export const getConflictAssistantGroupId = (
  repositories: VerifiedConflictAssistantContext['repositories'], groups: Pick<ProjectGroup, 'id' | 'projects'>[],
): string | null => {
  const group = groups.find(group => repositories.every(repo => group.projects.some(project => project.id === repo.projectId)));
  if (repositories.length > 1 && !group) throw new Error('Conflict repositories do not belong to one group.');
  return group?.id ?? null;
};

export const scopeConflictAssistantExecutionContext = (
  base: ProjectExecutionContext, context: VerifiedConflictAssistantContext,
): ProjectExecutionContext => {
  const first = context.repositories[0];
  const paths = Object.fromEntries(context.repositories.map(repo => [repo.projectId, repo.repoPath]));
  if (!first) throw new Error('Conflict context is empty.');
  return { ...base, groupId: context.groupId, taskId: null,
    projectId: first.projectId, focusedProjectId: first.projectId, projectIds: Object.keys(paths),
    actionableProjectIds: [], contextProjectIds: Object.keys(paths),
    branchName: first.branch, defaultWorkspacePath: first.repoPath, workspacePath: first.repoPath,
    workspacePathsByProjectId: paths,
    virtualRootEnabled: context.repositories.length > 1,
    projectMounts: context.repositories.map(repo => ({
      ...base.projectMounts.find(mount => mount.projectId === repo.projectId),
      projectId: repo.projectId, groupId: context.groupId,
      mountName: base.projectMounts.find(mount => mount.projectId === repo.projectId)?.mountName ?? repo.projectId,
      displayName: base.projectMounts.find(mount => mount.projectId === repo.projectId)?.displayName ?? repo.projectId,
      workspacePath: repo.repoPath, isReadOnly: true, executionMode: 'git',
    })),
  };
};

// A fresh native inspection is required for every send, including queued sends.
// Registry identity and the immutable branch/worktree/HEAD must still agree.
export const revalidateConflictAssistantContext = async (
  context: VerifiedConflictAssistantContext,
  selection: ConflictAssistantSelection,
  ports: ConflictAssistantGitPorts,
  tasks: Parameters<typeof verifyConflictAssistantRepositories>[3],
): Promise<void> => {
  if (!isConflictAssistantContextAllowed(context, selection)) throw new Error('Conflict context is no longer selected or belongs to another task.');
  const repositories = await verifyConflictAssistantRepositories({
    kind: context.kind,
    repositories: context.repositories.map(repo => ({
      projectId: repo.projectId,
      repoPath: context.kind === 'metadata' ? repo.projectPath : repo.repoPath,
      branch: repo.branch, upstreamBranch: repo.upstreamBranch,
      worktreePath: context.kind === 'metadata' ? repo.repoPath : undefined,
      taskId: repo.taskId,
    })),
  }, selection.projects, ports, tasks);
  if (repositories.some((repo, index) => repo.repoPath !== context.repositories[index]?.repoPath ||
    repo.head !== context.repositories[index]?.head || repo.branch !== context.repositories[index]?.branch ||
    repo.mergeInProgress !== context.repositories[index]?.mergeInProgress ||
    JSON.stringify([...repo.conflictFiles].sort()) !== JSON.stringify([...context.repositories[index]!.conflictFiles].sort()))) {
    throw new Error('Conflict repository changed. Open a new assistant from the Git dialog.');
  }
};
