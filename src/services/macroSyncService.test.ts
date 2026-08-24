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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((deferredResolve, deferredReject) => {
    resolve = deferredResolve;
    reject = deferredReject;
  });
  return { promise, resolve, reject };
};

const waitForMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const createDeferredWorkspaceGates = (): {
  gates: Map<string, Deferred<MacroBranchSyncDto>>;
  implementation: (params?: { workspacePath?: string | null }) => Promise<MacroBranchSyncDto>;
} => {
  const gates = new Map<string, Deferred<MacroBranchSyncDto>>();
  const implementation = async ({ workspacePath }: { workspacePath?: string | null } = {}) => {
    const gate = createDeferred<MacroBranchSyncDto>();
    gates.set(workspacePath || '', gate);
    return gate.promise;
  };
  return { gates, implementation };
};

const createAppState = (overrides?: {
  metadataAutoPush?: boolean;
  metadataMissingUpstreamPolicy?: 'ask' | 'ignore';
  activeArchitectPlanId?: string | null;
  activePlanContext?: { targetBranch: string } | null;
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
  directEditProjectId?: string | null;
}) => ({
  metadataAutoPush: overrides?.metadataAutoPush ?? false,
  metadataMissingUpstreamPolicy: overrides?.metadataMissingUpstreamPolicy ?? 'ask',
  activeArchitectPlanId: overrides?.activeArchitectPlanId ?? 'plan-1',
  activePlanContext: overrides?.activePlanContext ?? { targetBranch: 'develop' },
  selectedGroupId: overrides?.selectedGroupId ?? 'group-1',
  selectedProjectId: overrides?.selectedProjectId ?? 'web',
  projectGroups: [
    {
      id: 'group-1',
      name: 'Suite',
      isOpen: true,
      projects: [
        {
          id: 'web',
          name: 'Web',
          mountName: 'web',
          path: '/repos/web',
          directEdit: overrides?.directEditProjectId === 'web',
          created_at: '2026-03-14T00:00:00.000Z',
          status: 'active' as const,
          metadata: {
            description: '',
            tags: [],
            team_members: [],
            api_contracts: [],
            dependencies: [],
          },
        },
        {
          id: 'api',
          name: 'API',
          mountName: 'api',
          path: '/repos/api',
          directEdit: overrides?.directEditProjectId === 'api',
          created_at: '2026-03-14T00:00:00.000Z',
          status: 'active' as const,
          metadata: {
            description: '',
            tags: [],
            team_members: [],
            api_contracts: [],
            dependencies: [],
          },
        },
      ],
    },
  ],
  getProjectById: (_projectId: string) => undefined,
  setMetadataSyncStatus: setMetadataSyncStatusMock,
});

const loadMacroSyncService = (overrides?: {
  metadataAutoPush?: boolean;
  metadataMissingUpstreamPolicy?: 'ask' | 'ignore';
  directEditProjectId?: string | null;
}) => createMacroSyncService({
  tauriIpc: {
    isTauriAvailable: () => true,
    macroBranchEnsure: macroBranchEnsureMock,
    macroBranchStatus: macroBranchStatusMock,
    macroBranchCommitIfDirty: macroBranchCommitIfDirtyMock,
    macroBranchPull: macroBranchPullMock,
    macroBranchPush: macroBranchPushMock,
  },
  getAppState: () => createAppState({
    metadataAutoPush: overrides?.metadataAutoPush,
    metadataMissingUpstreamPolicy: overrides?.metadataMissingUpstreamPolicy,
    directEditProjectId: overrides?.directEditProjectId,
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

  it('does not invoke Git metadata sync for direct-edit projects', async () => {
    const service = loadMacroSyncService({ directEditProjectId: 'web' });

    await service.refreshMacroSyncStatus();

    expect(macroBranchStatusMock.mock.calls.map(([params]) => params?.workspacePath)).toEqual([
      '/repos/api',
    ]);
  });

  it('skips WSL repositories when syncing @macro metadata', async () => {
    const service = createMacroSyncService({
      tauriIpc: {
        isTauriAvailable: () => true,
        macroBranchEnsure: macroBranchEnsureMock,
        macroBranchStatus: macroBranchStatusMock,
        macroBranchCommitIfDirty: macroBranchCommitIfDirtyMock,
        macroBranchPull: macroBranchPullMock,
        macroBranchPush: macroBranchPushMock,
      },
      getAppState: () => createAppState(),
      resolveTargets: async () => [
        { repoPath: '\\\\wsl.localhost\\Ubuntu\\home\\oscar\\repo', projectId: 'wsl' },
        { repoPath: '/repos/api', projectId: 'api' },
      ],
      toServiceError,
    });

    await service.refreshMacroSyncStatus();

    expect(macroBranchStatusMock.mock.calls.map(([params]) => params?.workspacePath)).toEqual([
      '/repos/api',
    ]);
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

  it('treats a missing remote @macro branch as a pull no-op', async () => {
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      createMacroResult({
        state: 'pending',
        has_upstream: false,
        ahead: 1,
        reason: 'missing_upstream',
        next_action: 'push',
        output: `missing upstream:${workspacePath || 'default'}`,
      })
    );

    const service = loadMacroSyncService();
    const result = await service.pullMacroMetadata();

    expect(macroBranchPullMock).not.toHaveBeenCalled();
    expect(result?.state).toBe('pending');
    expect(result?.reason).toBe('missing_upstream');
    expect(result?.error).toBeNull();
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

  it('records stream metadata without committing or pushing even when auto-push is enabled', async () => {
    const service = loadMacroSyncService({ metadataAutoPush: true });

    const result = await service.syncMacroMetadataAfterStream({
      mode: 'Architect',
      conversationId: 'conv-1',
      trigger: 'send',
    });

    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(macroBranchStatusMock).toHaveBeenCalledTimes(2);
    expect(result?.reason).toBe('behind');
  });

  it('surfaces stream metadata conflicts without committing or pushing', async () => {
    macroBranchStatusMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      workspacePath?.includes('web')
        ? createMacroResult({
            state: 'conflict',
            reason: 'merge_conflict',
            next_action: 'resolve_conflict',
            conflicted_files: ['macro/state.json'],
            error: 'Metadata has unresolved merge conflicts.',
          })
        : createMacroResult({
            output: `status ok:${workspacePath || 'default'}`,
          })
    );

    const service = loadMacroSyncService({ metadataAutoPush: true });
    const result = await service.syncMacroMetadataAfterStream({
      mode: 'Architect',
      conversationId: 'conv-1',
      trigger: 'send',
    });

    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(result?.state).toBe('conflict');
    expect(result?.conflicted_files).toEqual(['macro/state.json']);
  });

  it('flushes dirty metadata before code-triggered pull without pushing', async () => {
    const ensureCallsByPath = new Map<string, number>();
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) => {
      const key = workspacePath || 'default';
      const calls = ensureCallsByPath.get(key) || 0;
      ensureCallsByPath.set(key, calls + 1);
      if (workspacePath?.includes('web') && calls === 0) {
        return createMacroResult({
          state: 'pending',
          is_dirty: true,
          reason: 'dirty',
          next_action: 'commit',
        });
      }
      return createMacroResult({
        output: `ensured:${workspacePath || 'default'}`,
      });
    });
    macroBranchCommitIfDirtyMock.mockImplementation(async ({ workspacePath, message }: { message?: string; workspacePath?: string | null } = {}) =>
      createMacroResult({
        committed: true,
        commit_hash: workspacePath?.includes('api') ? 'api123' : 'web123',
        output: `commit ${message}:${workspacePath || 'default'}`,
      })
    );

    const service = loadMacroSyncService();
    const result = await service.syncMacroMetadataForCodeAction({ action: 'pull' });

    expect(macroBranchCommitIfDirtyMock.mock.calls.map(([params]) => params?.message)).toEqual([
      'chore(@macro): sync project state',
      'chore(@macro): sync project state',
    ]);
    expect(macroBranchPullMock).toHaveBeenCalledTimes(2);
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(result?.state).toBe('clean');
  });

  it('skips only repositories without a remote @macro branch during code-triggered pull', async () => {
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      workspacePath?.includes('web')
        ? createMacroResult({
            state: 'pending',
            has_upstream: false,
            ahead: 1,
            reason: 'missing_upstream',
            next_action: 'push',
          })
        : createMacroResult({
            output: `ensured:${workspacePath || 'default'}`,
          })
    );

    const service = loadMacroSyncService();
    const result = await service.syncMacroMetadataForCodeAction({ action: 'pull' });

    expect(macroBranchPullMock).toHaveBeenCalledTimes(1);
    expect(macroBranchPullMock).toHaveBeenCalledWith({ workspacePath: '/repos/api' });
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(result?.state).toBe('pending');
    expect(result?.reason).toBe('missing_upstream');
    expect(result?.error).toBeNull();
  });

  it('blocks code-triggered push when metadata must pull first', async () => {
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      workspacePath?.includes('web')
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
    const result = await service.syncMacroMetadataForCodeAction({ action: 'push' });

    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(macroBranchPullMock).not.toHaveBeenCalled();
    expect(result?.reason).toBe('behind');
  });

  it('does not auto-push metadata when code-triggered push finds a missing upstream', async () => {
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      createMacroResult({
        state: 'pending',
        has_upstream: false,
        ahead: 1,
        reason: 'missing_upstream',
        next_action: 'push',
        output: `missing upstream:${workspacePath || 'default'}`,
      })
    );

    const service = loadMacroSyncService();
    const result = await service.syncMacroMetadataForCodeAction({ action: 'push' });

    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(result?.state).toBe('pending');
    expect(result?.reason).toBe('missing_upstream');
    expect(result?.next_action).toBe('push');
  });

  it('leaves missing upstream non-published when the policy is ignored', async () => {
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      createMacroResult({
        state: 'pending',
        has_upstream: false,
        ahead: 1,
        reason: 'missing_upstream',
        next_action: 'push',
        output: `missing upstream:${workspacePath || 'default'}`,
      })
    );

    const service = loadMacroSyncService({ metadataMissingUpstreamPolicy: 'ignore' });
    const result = await service.syncMacroMetadataForCodeAction({ action: 'push' });

    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(macroBranchPullMock).not.toHaveBeenCalled();
    expect(result?.reason).toBe('missing_upstream');
    expect(result?.next_action).toBe('push');
  });

  it('pushes metadata explicitly even when upstream is missing', async () => {
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      createMacroResult({
        state: 'pending',
        has_upstream: false,
        ahead: 1,
        reason: 'missing_upstream',
        next_action: 'push',
        output: `missing upstream:${workspacePath || 'default'}`,
      })
    );

    const service = loadMacroSyncService();
    const result = await service.pushMacroMetadata();

    expect(macroBranchPushMock).toHaveBeenCalledTimes(2);
    expect(result?.state).toBe('clean');
  });

  it('flushes dirty metadata before code-triggered push without pulling', async () => {
    const ensureCallsByPath = new Map<string, number>();
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) => {
      const key = workspacePath || 'default';
      const calls = ensureCallsByPath.get(key) || 0;
      ensureCallsByPath.set(key, calls + 1);
      if (workspacePath?.includes('web') && calls === 0) {
        return createMacroResult({
          state: 'pending',
          is_dirty: true,
          reason: 'dirty',
          next_action: 'commit',
        });
      }
      return createMacroResult({
        output: `ensured:${workspacePath || 'default'}`,
      });
    });

    const service = loadMacroSyncService();
    const result = await service.syncMacroMetadataForCodeAction({ action: 'push' });

    expect(macroBranchCommitIfDirtyMock.mock.calls.map(([params]) => params?.message)).toEqual([
      'chore(@macro): sync project state',
      'chore(@macro): sync project state',
    ]);
    expect(macroBranchPushMock).toHaveBeenCalledTimes(2);
    expect(macroBranchPullMock).not.toHaveBeenCalled();
    expect(result?.state).toBe('clean');
  });

  it('blocks code-triggered pull when dirty metadata still needs a commit after flushing', async () => {
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) =>
      createMacroResult({
        state: 'pending',
        is_dirty: true,
        reason: 'dirty',
        next_action: 'commit',
        output: `still dirty:${workspacePath || 'default'}`,
      })
    );

    const service = loadMacroSyncService();
    const result = await service.syncMacroMetadataForCodeAction({ action: 'pull' });

    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(2);
    expect(macroBranchPullMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(result?.next_action).toBe('commit');
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

  it('falls back to all repositories in the selected group when no plan targets are active', async () => {
    const service = createMacroSyncService({
      tauriIpc: {
        isTauriAvailable: () => true,
        macroBranchEnsure: macroBranchEnsureMock,
        macroBranchStatus: macroBranchStatusMock,
        macroBranchCommitIfDirty: macroBranchCommitIfDirtyMock,
        macroBranchPull: macroBranchPullMock,
        macroBranchPush: macroBranchPushMock,
      },
      getAppState: () =>
        createAppState({
          activeArchitectPlanId: null,
          activePlanContext: null,
          selectedProjectId: 'api',
        }),
      toServiceError,
    });

    await service.refreshMacroSyncStatus();

    expect(macroBranchStatusMock.mock.calls.map(([params]) => params?.workspacePath)).toEqual([
      '/repos/api',
      '/repos/web',
    ]);
  });

  it('runs distinct repositories concurrently within one sync action', async () => {
    const { gates, implementation } = createDeferredWorkspaceGates();
    macroBranchStatusMock.mockImplementation(implementation);

    const service = loadMacroSyncService();
    const pending = service.refreshMacroSyncStatus();
    await waitForMicrotasks();

    expect(Array.from(gates.keys())).toEqual(['/repos/web', '/repos/api']);
    expect(setMetadataSyncStatusMock).not.toHaveBeenCalled();

    gates.get('/repos/web')!.resolve(
      createMacroResult({ behind: 2, reason: 'behind', next_action: 'pull' })
    );
    gates.get('/repos/api')!.resolve(createMacroResult());
    await pending;

    expect(macroBranchStatusMock).toHaveBeenCalledTimes(2);
  });

  it('keeps aggregated repositories in input order when syncs complete out of order', async () => {
    const { gates, implementation } = createDeferredWorkspaceGates();
    macroBranchPullMock.mockImplementation(implementation);

    const service = loadMacroSyncService();
    const pending = service.pullMacroMetadata();
    await waitForMicrotasks();

    gates.get('/repos/api')!.resolve(createMacroResult({ output: 'pull ok:/repos/api' }));
    await waitForMicrotasks();

    gates.get('/repos/web')!.resolve(
      createMacroResult({
        state: 'pending',
        behind: 3,
        reason: 'behind',
        next_action: 'pull',
        output: 'pull ok:/repos/web',
      })
    );
    const result = await pending;

    expect(result?.state).toBe('pending');
    expect(result?.reason).toBe('behind');
    expect(result?.output).toBe('/repos/web: pull ok:/repos/web\n/repos/api: pull ok:/repos/api');
    const lastStatusCall = setMetadataSyncStatusMock.mock.calls.at(-1)?.[0] as {
      repositories: Array<{
        repoPath: string;
        state: string;
        reason: string | null;
        nextAction: string | null;
        error: string | null;
      }>;
    };
    expect(lastStatusCall.repositories.map((repository) => repository.repoPath)).toEqual([
      '/repos/web',
      '/repos/api',
    ]);
    expect(lastStatusCall.repositories[0]).toMatchObject({
      state: 'pending',
      reason: 'behind',
      nextAction: 'pull',
      error: null,
    });
    expect(lastStatusCall.repositories[1]).toMatchObject({
      state: 'clean',
      reason: 'clean',
      nextAction: null,
      error: null,
    });
  });

  it('isolates per-repository failures when syncs run in parallel', async () => {
    const { gates, implementation } = createDeferredWorkspaceGates();
    macroBranchPushMock.mockImplementation(implementation);

    const service = loadMacroSyncService();
    const pending = service.pushMacroMetadata();
    await waitForMicrotasks();

    gates.get('/repos/web')!.reject(new Error('fatal: Authentication failed'));
    gates.get('/repos/api')!.resolve(createMacroResult({ output: 'push ok:/repos/api' }));
    const result = await pending;

    expect(result?.state).toBe('failed');
    expect(result?.reason).toBe('auth_required');
    expect(result?.next_action).toBe('configure_auth');
    const lastStatusCall = setMetadataSyncStatusMock.mock.calls.at(-1)?.[0] as {
      repositories: Array<{
        repoPath: string;
        state: string;
        reason: string | null;
        nextAction: string | null;
        error: string | null;
      }>;
    };
    expect(lastStatusCall.repositories.map((repository) => repository.repoPath)).toEqual([
      '/repos/web',
      '/repos/api',
    ]);
    expect(lastStatusCall.repositories[0]).toMatchObject({
      state: 'failed',
      reason: 'auth_required',
      nextAction: 'configure_auth',
    });
    expect(lastStatusCall.repositories[1]).toMatchObject({
      state: 'clean',
      reason: 'clean',
      error: null,
    });
  });

  it('keeps separate top-level sync actions serialized while overlapping repositories within each action', async () => {
    const callLog: string[] = [];
    const firstEnsureGate = createDeferred<MacroBranchSyncDto>();
    let ensureCallCount = 0;
    macroBranchEnsureMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) => {
      ensureCallCount += 1;
      callLog.push(`ensure:${workspacePath}`);
      return ensureCallCount === 1
        ? firstEnsureGate.promise
        : createMacroResult({ output: `ensured:${workspacePath}` });
    });
    macroBranchPullMock.mockImplementation(async ({ workspacePath }: { workspacePath?: string | null } = {}) => {
      callLog.push(`pull:${workspacePath}`);
      return createMacroResult({ output: `pull ok:${workspacePath}` });
    });

    const service = loadMacroSyncService();
    const firstAction = service.pullMacroMetadata();
    const secondAction = service.pullMacroMetadata();
    await waitForMicrotasks();

    expect(callLog).toEqual(['ensure:/repos/web', 'ensure:/repos/api']);

    firstEnsureGate.resolve(createMacroResult());
    await Promise.all([firstAction, secondAction]);

    expect(callLog).toEqual([
      'ensure:/repos/web',
      'ensure:/repos/api',
      'pull:/repos/web',
      'pull:/repos/api',
      'ensure:/repos/web',
      'ensure:/repos/api',
      'pull:/repos/web',
      'pull:/repos/api',
    ]);
  });
});
