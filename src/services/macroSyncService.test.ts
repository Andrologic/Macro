import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { toServiceError } from './contracts/errors';
import {
  createMacroSyncService,
  getMacroSyncDescription,
} from './macroSyncService';
import type { MacroBranchSyncDto } from './tauriIpc';

const setMetadataSyncStatusMock = mock((_params: unknown) => undefined);

const createMacroResult = (overrides: Partial<MacroBranchSyncDto> = {}): MacroBranchSyncDto => ({
  branch: '@macro',
  state: 'clean',
  worktree_path: '/workspace/.git/macro-metadata-worktree',
  is_dirty: false,
  has_origin: true,
  has_upstream: true,
  ahead: 0,
  behind: 0,
  conflicted_files: [],
  committed: false,
  commit_hash: null,
  reason: 'clean',
  next_action: null,
  output: null,
  error: null,
  ...overrides,
});

const macroBranchEnsureMock = mock(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
  createMacroResult({
    output: `ensured:${workspacePath || 'default'}`,
  })
);
const macroBranchStatusMock = mock(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
  createMacroResult({
    state: workspacePath?.includes('api') ? 'clean' : 'pending',
    behind: workspacePath?.includes('api') ? 0 : 2,
    reason: workspacePath?.includes('api') ? 'clean' : 'behind',
    next_action: workspacePath?.includes('api') ? null : 'pull',
  })
);
const macroBranchCommitIfDirtyMock = mock(async ({ workspacePath }: { message?: string; workspacePath?: string | null } = {}) =>
  createMacroResult({
    state: 'pending',
    has_upstream: false,
    committed: true,
    commit_hash: workspacePath?.includes('api') ? 'api123' : 'web123',
    reason: 'missing_upstream',
    next_action: 'push',
    output: `commit ok:${workspacePath || 'default'}`,
  })
);
const macroBranchPullMock = mock(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
  createMacroResult({
    output: `pull ok:${workspacePath || 'default'}`,
  })
);
const macroBranchPushMock = mock(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
  createMacroResult({
    output: `push ok:${workspacePath || 'default'}`,
  })
);

const metadataTargets = [
  { repoPath: '/repos/web', projectId: 'web' },
  { repoPath: '/repos/api', projectId: 'api' },
];

const loadMacroSyncService = (overrides?: {
  metadataAutoPush?: boolean;
}) => createMacroSyncService({
  tauriIpc: {
    isTauriAvailable: () => true,
    macroBranchEnsure: macroBranchEnsureMock,
    macroBranchStatus: macroBranchStatusMock,
    macroBranchCommitIfDirty: macroBranchCommitIfDirtyMock,
    macroBranchPull: macroBranchPullMock,
    macroBranchPush: macroBranchPushMock,
  },
  getAppState: () => ({
    metadataAutoPush: overrides?.metadataAutoPush ?? false,
    activeArchitectPlanId: 'plan-1',
    activePlanContext: { targetBranch: 'develop' },
    selectedProjectId: 'web',
    getProjectById: (_projectId: string) => undefined,
    setMetadataSyncStatus: setMetadataSyncStatusMock,
  }),
  resolveTargets: async () => metadataTargets,
  toServiceError,
});

describe('macroSyncService', () => {
  beforeEach(() => {
    setMetadataSyncStatusMock.mockReset();

    macroBranchEnsureMock.mockReset();
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      createMacroResult({
        output: `ensured:${workspacePath || 'default'}`,
      })
    );

    macroBranchStatusMock.mockReset();
    macroBranchStatusMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      createMacroResult({
        state: workspacePath?.includes('api') ? 'clean' : 'pending',
        behind: workspacePath?.includes('api') ? 0 : 2,
        reason: workspacePath?.includes('api') ? 'clean' : 'behind',
        next_action: workspacePath?.includes('api') ? null : 'pull',
      })
    );

    macroBranchCommitIfDirtyMock.mockReset();
    macroBranchCommitIfDirtyMock.mockImplementation(async ({ workspacePath }: { message?: string; workspacePath?: string | null } = {}) =>
      createMacroResult({
        state: 'pending',
        has_upstream: false,
        committed: true,
        commit_hash: workspacePath?.includes('api') ? 'api123' : 'web123',
        reason: 'missing_upstream',
        next_action: 'push',
        output: `commit ok:${workspacePath || 'default'}`,
      })
    );

    macroBranchPullMock.mockReset();
    macroBranchPullMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      createMacroResult({
        output: `pull ok:${workspacePath || 'default'}`,
      })
    );

    macroBranchPushMock.mockReset();
    macroBranchPushMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      createMacroResult({
        output: `push ok:${workspacePath || 'default'}`,
      })
    );
  });

  it('aggregates metadata diagnostics across all active-plan repositories on refresh', async () => {
    const service = loadMacroSyncService();

    const result = await service.refreshMacroSyncStatus();

    expect(result?.reason).toBe('behind');
    expect(result?.next_action).toBe('pull');
    expect(macroBranchStatusMock.mock.calls.map(([params]) => params?.workspacePath)).toEqual([
      '/repos/web',
      '/repos/api',
    ]);
    expect(setMetadataSyncStatusMock).toHaveBeenLastCalledWith({
      state: 'pending',
      error: null,
      reason: 'behind',
      nextAction: 'pull',
      conflictFiles: [],
      repositories: [
        {
          repoPath: '/repos/web',
          projectId: 'web',
          worktreePath: '/workspace/.git/macro-metadata-worktree',
          state: 'pending',
          error: null,
          reason: 'behind',
          nextAction: 'pull',
          conflictFiles: [],
        },
        {
          repoPath: '/repos/api',
          projectId: 'api',
          worktreePath: '/workspace/.git/macro-metadata-worktree',
          state: 'clean',
          error: null,
          reason: 'clean',
          nextAction: null,
          conflictFiles: [],
        },
      ],
    });
  });

  it('blocks pull across all repositories when one target still requires a commit', async () => {
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      workspacePath?.includes('web')
        ? createMacroResult({
            state: 'pending',
            is_dirty: true,
            reason: 'dirty',
            next_action: 'commit',
          })
        : createMacroResult({
            output: `ensured:${workspacePath || 'default'}`,
          })
    );

    const service = loadMacroSyncService();
    const result = await service.pullMacroMetadata();

    expect(result?.reason).toBe('dirty');
    expect(result?.next_action).toBe('commit');
    expect(macroBranchPullMock).not.toHaveBeenCalled();
    expect(setMetadataSyncStatusMock).toHaveBeenLastCalledWith({
      state: 'pending',
      error: null,
      reason: 'dirty',
      nextAction: 'commit',
      conflictFiles: [],
      repositories: [
        {
          repoPath: '/repos/web',
          projectId: 'web',
          worktreePath: '/workspace/.git/macro-metadata-worktree',
          state: 'pending',
          error: null,
          reason: 'dirty',
          nextAction: 'commit',
          conflictFiles: [],
        },
        {
          repoPath: '/repos/api',
          projectId: 'api',
          worktreePath: '/workspace/.git/macro-metadata-worktree',
          state: 'clean',
          error: null,
          reason: 'clean',
          nextAction: null,
          conflictFiles: [],
        },
      ],
    });
  });

  it('blocks commit across all repositories when one target already has conflicts', async () => {
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      workspacePath?.includes('web')
        ? createMacroResult({
            state: 'conflict',
            reason: 'merge_conflict',
            next_action: 'resolve_conflict',
            conflicted_files: ['macro/state.json'],
            error: 'Metadata has unresolved merge conflicts.',
          })
        : createMacroResult({
            output: `ensured:${workspacePath || 'default'}`,
          })
    );

    const service = loadMacroSyncService();
    const result = await service.commitMacroMetadata({
      commitMessage: 'chore(metadata): manual commit',
    });

    expect(result?.state).toBe('conflict');
    expect(result?.reason).toBe('merge_conflict');
    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
  });

  it('commits metadata in every targeted repository without pushing', async () => {
    const service = loadMacroSyncService();

    const result = await service.commitMacroMetadata({
      commitMessage: 'chore(metadata): manual commit',
    });

    expect(macroBranchCommitIfDirtyMock.mock.calls.map(([params]) => ({
      message: params?.message,
      workspacePath: params?.workspacePath,
    }))).toEqual([
      { message: 'chore(metadata): manual commit', workspacePath: '/repos/web' },
      { message: 'chore(metadata): manual commit', workspacePath: '/repos/api' },
    ]);
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(result?.committed).toBe(true);
    expect(result?.next_action).toBe('push');
  });

  it('blocks push across all repositories when one target must pull first', async () => {
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      workspacePath?.includes('api')
        ? createMacroResult({
            state: 'pending',
            behind: 2,
            reason: 'behind',
            next_action: 'pull',
          })
        : createMacroResult({
            output: `ensured:${workspacePath || 'default'}`,
          })
    );

    const service = loadMacroSyncService();
    const result = await service.pushMacroMetadata();

    expect(result?.state).toBe('pending');
    expect(result?.reason).toBe('behind');
    expect(result?.next_action).toBe('pull');
    expect(macroBranchPushMock).not.toHaveBeenCalled();
  });

  it('auto-pushes stream metadata updates across all repositories when enabled', async () => {
    const service = loadMacroSyncService({ metadataAutoPush: true });

    const result = await service.syncMacroMetadataAfterStream({
      mode: 'Architect',
      conversationId: 'conv-1',
      trigger: 'send',
    });

    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(2);
    expect(macroBranchPushMock).toHaveBeenCalledTimes(2);
    expect(result?.state).toBe('clean');
  });

  it('blocks stream auto-push globally when a committed repository still has merge conflicts', async () => {
    macroBranchCommitIfDirtyMock.mockImplementation(async ({ workspacePath }: { message?: string; workspacePath?: string | null } = {}) =>
      workspacePath?.includes('web')
        ? createMacroResult({
            state: 'conflict',
            reason: 'merge_conflict',
            next_action: 'resolve_conflict',
            conflicted_files: ['macro/state.json'],
            error: 'Metadata has unresolved merge conflicts.',
          })
        : createMacroResult({
            state: 'pending',
            has_upstream: false,
            committed: true,
            commit_hash: 'api123',
            reason: 'missing_upstream',
            next_action: 'push',
            output: `commit ok:${workspacePath || 'default'}`,
          })
    );

    const service = loadMacroSyncService({ metadataAutoPush: true });
    const result = await service.syncMacroMetadataAfterStream({
      mode: 'Architect',
      conversationId: 'conv-1',
      trigger: 'send',
    });

    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(2);
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(result?.state).toBe('conflict');
    expect(result?.conflicted_files).toEqual(['macro/state.json']);
  });

  it('normalizes thrown failures into actionable metadata diagnostics', async () => {
    macroBranchStatusMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) => {
      if (workspacePath?.includes('web')) {
        throw new Error('fatal: could not read from remote repository');
      }
      return createMacroResult();
    });

    const service = loadMacroSyncService();
    const result = await service.refreshMacroSyncStatus();

    expect(result?.state).toBe('failed');
    expect(result?.reason).toBe('auth_required');
    expect(result?.next_action).toBe('configure_auth');
    expect(getMacroSyncDescription(result!)).toContain('authentication');
  });
});
