import { describe, expect, it, mock } from 'bun:test';
import {
  verifyConflictAssistantRepositories, isConflictAssistantContextAllowed,
  revalidateConflictAssistantContext, scopeConflictAssistantExecutionContext, getConflictAssistantGroupId,
  type ConflictAssistantGitPorts, type ConflictAssistantSelection, type VerifiedConflictAssistantContext,
} from './conflictAssistantContext';
import type { ProjectExecutionContext } from './projectExecutionContext';

const projects = [{ id: 'api', path: '/repo/api' }, { id: 'web', path: '/repo/web' }];
const request = { kind: 'code' as const, repositories: [{ projectId: 'api', repoPath: '/repo/api', branch: 'feature/api', upstreamBranch: 'origin/feature/api' }] };
const status = (branch = 'feature/api', conflicts = ['src/api.ts']) => ({
  branch, head_commit: { hash: 'abc' }, conflicted_files: conflicts, merge_in_progress: conflicts.length > 0,
  ahead: 2, behind: 1, has_upstream: true,
});
const ports = () => ({
  gitStatus: mock(async () => status()),
  gitMergeCheck: mock(async () => ({ conflictFiles: ['src/merge.ts'] })),
  gitRebaseCheck: mock(async () => ({ conflictFiles: ['src/rebase.ts'] })),
  macroBranchStatus: mock(async () => ({ branch: '@macro', worktree_path: '/metadata/api', state: 'conflict' })),
  gitWorktreeInspect: mock(async () => ({ status: 'ready', worktreePath: '/worktree/api', branchName: 'feature/api' })),
}) as unknown as ConflictAssistantGitPorts;
const context = async (git = ports()): Promise<VerifiedConflictAssistantContext> => ({
  conversationId: 'conflict', projectId: 'api', groupId: null, kind: 'code',
  repositories: await verifyConflictAssistantRepositories(request, projects, git),
});
const selection = (): ConflictAssistantSelection => ({
  mode: 'Implement', selectedTaskId: null, selectedProjectId: 'api', selectedGroupId: null,
  selectedConversationId: 'conflict',
  conversation: { id: 'conflict', task_id: null, project_id: 'api', group_id: null, scope_mode: 'Implement' },
  projects, groups: [],
});

describe('verified conflict assistant context', () => {
  it('verifies live code conflicts and unions hypothetical merge/rebase conflicts', async () => {
    const git = ports();
    const active = await context(git);
    expect(active.repositories[0]?.conflictFiles).toEqual(['src/api.ts']);
    expect(active.repositories[0]?.mergeInProgress).toBe(true);
    git.gitStatus = mock(async () => status('feature/api', [])) as unknown as typeof git.gitStatus;
    const preflight = await context(git);
    expect(preflight.repositories[0]?.conflictFiles).toEqual(['src/merge.ts', 'src/rebase.ts']);
    expect(preflight.repositories[0]?.mergeInProgress).toBe(false);
  });

  it('rejects missing projects, duplicate targets, changed branches and unavailable HEAD', async () => {
    const git = ports();
    await expect(verifyConflictAssistantRepositories(request, [], git)).rejects.toThrow('registered');
    await expect(verifyConflictAssistantRepositories({ ...request, repositories: [...request.repositories, ...request.repositories] }, projects, git)).rejects.toThrow('distinct');
    git.gitStatus = mock(async () => status('develop')) as unknown as typeof git.gitStatus;
    await expect(context(git)).rejects.toThrow('branch changed');
    git.gitStatus = mock(async () => ({ ...status(), head_commit: null })) as unknown as typeof git.gitStatus;
    await expect(context(git)).rejects.toThrow('HEAD');
  });

  it('rejects a resolved divergence and inconclusive native preflight', async () => {
    const git = ports();
    git.gitStatus = mock(async () => ({ ...status('feature/api', []), ahead: 0 })) as unknown as typeof git.gitStatus;
    await expect(context(git)).rejects.toThrow('no longer');
    git.gitStatus = mock(async () => status('feature/api', [])) as unknown as typeof git.gitStatus;
    git.gitMergeCheck = mock(async () => { throw new Error('unavailable'); });
    git.gitRebaseCheck = mock(async () => { throw new Error('unavailable'); });
    await expect(context(git)).rejects.toThrow('could not be verified');
  });

  it('requires task provenance and a native read-only inspection for a code worktree', async () => {
    const git = ports();
    const worktreeRequest = { ...request, repositories: [{ ...request.repositories[0]!, repoPath: '/worktree/api', taskId: 'task-api' }] };
    await expect(verifyConflictAssistantRepositories(worktreeRequest, projects, git)).rejects.toThrow('task identity');
    await expect(verifyConflictAssistantRepositories(worktreeRequest, projects, git, [{ id: 'task-api', branch_name: 'feature/api', project_id: 'web' }])).rejects.toThrow('task identity');
    await verifyConflictAssistantRepositories(worktreeRequest, projects, git, [{ id: 'task-api', branch_name: 'feature/api', project_id: 'api' }]);
    expect(git.gitWorktreeInspect).toHaveBeenCalledWith({ repoPath: '/repo/api', taskId: 'task-api', branchName: 'feature/api', readOnly: true });
    git.gitWorktreeInspect = mock(async () => ({ status: 'ready', worktreePath: '/foreign/api', branchName: 'feature/api' })) as unknown as typeof git.gitWorktreeInspect;
    await expect(verifyConflictAssistantRepositories(worktreeRequest, projects, git, [{ id: 'task-api', branch_name: 'feature/api', project_id: 'api' }])).rejects.toThrow('could not be verified');
  });

  it('resolves metadata to its native @macro worktree rather than the code root', async () => {
    const git = ports();
    git.gitStatus = mock(async () => status('@macro')) as unknown as typeof git.gitStatus;
    const metadata = { kind: 'metadata' as const, repositories: [{ projectId: 'api', repoPath: '/repo/api', worktreePath: '/metadata/api' }] };
    const repos = await verifyConflictAssistantRepositories(metadata, projects, git);
    expect(repos[0]?.repoPath).toBe('/metadata/api');
    expect(git.gitStatus).toHaveBeenCalledWith('/metadata/api');
    await expect(verifyConflictAssistantRepositories({ ...metadata, repositories: [{ ...metadata.repositories[0]!, worktreePath: '/foreign/api' }] }, projects, git)).rejects.toThrow('could not be verified');
    git.gitStatus = mock(async () => status('feature/api')) as unknown as typeof git.gitStatus;
    await expect(verifyConflictAssistantRepositories(metadata, projects, git)).rejects.toThrow('branch changed');
  });

  it('requires one registered group for multiple repositories and excludes unrelated mounts', async () => {
    const verified = await context();
    const repositories = [...verified.repositories, { ...verified.repositories[0]!, projectId: 'web', projectPath: '/repo/web', repoPath: '/repo/web' }];
    expect(() => getConflictAssistantGroupId(repositories, [])).toThrow('one group');
    const group = { id: 'group', projects: projects as never };
    expect(getConflictAssistantGroupId(repositories, [group])).toBe('group');
    const groupContext = { ...verified, groupId: 'group', repositories };
    const state = { ...selection(), groups: [group], selectedGroupId: 'group', conversation: { ...selection().conversation!, group_id: 'group' } };
    expect(isConflictAssistantContextAllowed(groupContext, state)).toBe(true);
    expect(isConflictAssistantContextAllowed(groupContext, { ...state, groups: [] })).toBe(false);
    const base = { projectMounts: [{ projectId: 'api', mountName: 'api', displayName: 'API' }, { projectId: 'other', workspacePath: '/foreign' }] } as unknown as ProjectExecutionContext;
    const execution = scopeConflictAssistantExecutionContext(base, groupContext);
    expect(execution.taskId).toBeNull();
    expect(execution.actionableProjectIds).toEqual([]);
    expect(execution.projectIds).toEqual(['api', 'web']);
    expect(execution.workspacePathsByProjectId).toEqual({ api: '/repo/api', web: '/repo/web' });
    expect(execution.projectMounts.every(mount => mount.isReadOnly)).toBe(true);
    expect(execution.projectMounts[0]?.displayName).toBe('API');
  });

  it('refuses ordinary conversations, foreign task, project, group, mode, registry path or selection', async () => {
    const verified = await context();
    const state = selection();
    expect(isConflictAssistantContextAllowed(verified, state)).toBe(true);
    expect(isConflictAssistantContextAllowed(undefined, state)).toBe(false);
    for (const patch of [
      { mode: 'Chat' as const }, { selectedTaskId: 'foreign' }, { selectedProjectId: 'web' },
      { selectedGroupId: 'foreign' }, { selectedConversationId: 'foreign' },
      { projects: [{ id: 'api', path: '/foreign' }] },
      { conversation: { ...state.conversation!, task_id: 'foreign' } },
      { conversation: { ...state.conversation!, project_id: 'web' } },
    ]) expect(isConflictAssistantContextAllowed(verified, { ...state, ...patch })).toBe(false);
  });

  it('revalidates HEAD and conflict existence before every send', async () => {
    const git = ports();
    const verified = await context(git);
    await revalidateConflictAssistantContext(verified, selection(), git, []);
    git.gitStatus = mock(async () => ({ ...status(), head_commit: { hash: 'different' } })) as unknown as typeof git.gitStatus;
    await expect(revalidateConflictAssistantContext(verified, selection(), git, [])).rejects.toThrow('repository changed');
    git.gitStatus = mock(async () => ({ ...status(), conflicted_files: ['src/new-conflict.ts'] })) as unknown as typeof git.gitStatus;
    await expect(revalidateConflictAssistantContext(verified, selection(), git, [])).rejects.toThrow('repository changed');
    git.gitStatus = mock(async () => ({ ...status('feature/api', []), ahead: 0 })) as unknown as typeof git.gitStatus;
    await expect(revalidateConflictAssistantContext(verified, selection(), git, [])).rejects.toThrow('no longer');
  });
});
