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

const macroBranchEnsureMock = mock(async () => createMacroResult({
  output: 'ensured',
}));
const macroBranchStatusMock = mock(async () => createMacroResult({
  state: 'pending',
  behind: 2,
  reason: 'behind',
  next_action: 'pull',
}));
const macroBranchCommitIfDirtyMock = mock(async () => createMacroResult({
  state: 'pending',
  has_upstream: false,
  committed: true,
  commit_hash: 'abc123',
  reason: 'missing_upstream',
  next_action: 'push',
  output: 'commit ok',
}));
const macroBranchPullMock = mock(async () => createMacroResult({
  output: 'pull ok',
}));
const macroBranchPushMock = mock(async () => createMacroResult({
  output: 'push ok',
}));

const loadMacroSyncService = () => createMacroSyncService({
  tauriIpc: {
    isTauriAvailable: () => true,
    macroBranchEnsure: macroBranchEnsureMock,
    macroBranchStatus: macroBranchStatusMock,
    macroBranchCommitIfDirty: macroBranchCommitIfDirtyMock,
    macroBranchPull: macroBranchPullMock,
    macroBranchPush: macroBranchPushMock,
  },
  getAppState: () => ({
    metadataAutoPush: false,
    setMetadataSyncStatus: setMetadataSyncStatusMock,
  }),
  toServiceError,
});

describe('macroSyncService', () => {
  beforeEach(() => {
    setMetadataSyncStatusMock.mockReset();
    macroBranchEnsureMock.mockReset();
    macroBranchEnsureMock.mockImplementation(async () => createMacroResult({
      output: 'ensured',
    }));

    macroBranchStatusMock.mockReset();
    macroBranchStatusMock.mockImplementation(async () => createMacroResult({
      state: 'pending',
      behind: 2,
      reason: 'behind',
      next_action: 'pull',
    }));

    macroBranchCommitIfDirtyMock.mockReset();
    macroBranchCommitIfDirtyMock.mockImplementation(async () => createMacroResult({
      state: 'pending',
      has_upstream: false,
      committed: true,
      commit_hash: 'abc123',
      reason: 'missing_upstream',
      next_action: 'push',
      output: 'commit ok',
    }));

    macroBranchPullMock.mockReset();
    macroBranchPullMock.mockImplementation(async () => createMacroResult({
      output: 'pull ok',
    }));

    macroBranchPushMock.mockReset();
    macroBranchPushMock.mockImplementation(async () => createMacroResult({
      output: 'push ok',
    }));
  });

  it('maps structured metadata diagnostics into the app store on refresh', async () => {
    const service = loadMacroSyncService();

    const result = await service.refreshMacroSyncStatus();

    expect(result?.reason).toBe('behind');
    expect(result?.next_action).toBe('pull');
    expect(setMetadataSyncStatusMock).toHaveBeenCalledWith({
      state: 'pending',
      error: null,
      reason: 'behind',
      nextAction: 'pull',
      conflictFiles: [],
    });
  });

  it('blocks pull when metadata must be committed first', async () => {
    macroBranchEnsureMock.mockImplementation(async () => createMacroResult({
      state: 'pending',
      is_dirty: true,
      reason: 'dirty',
      next_action: 'commit',
    }));

    const service = loadMacroSyncService();
    const result = await service.pullMacroMetadata();

    expect(result?.reason).toBe('dirty');
    expect(macroBranchPullMock).not.toHaveBeenCalled();
  });

  it('commits metadata explicitly without pushing', async () => {
    const service = loadMacroSyncService();

    const result = await service.commitMacroMetadata({
      commitMessage: 'chore(metadata): manual commit',
    });

    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledWith({
      message: 'chore(metadata): manual commit',
    });
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(result?.committed).toBe(true);
    expect(result?.next_action).toBe('push');
  });

  it('does not auto-commit during manual push', async () => {
    macroBranchEnsureMock.mockImplementation(async () => createMacroResult({
      state: 'pending',
      is_dirty: true,
      reason: 'dirty',
      next_action: 'commit',
    }));

    const service = loadMacroSyncService();
    const result = await service.pushMacroMetadata();

    expect(result?.reason).toBe('dirty');
    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
  });

  it('normalizes thrown failures into actionable metadata diagnostics', async () => {
    macroBranchStatusMock.mockImplementation(async () => {
      throw new Error('fatal: could not read from remote repository');
    });

    const service = loadMacroSyncService();
    const result = await service.refreshMacroSyncStatus();

    expect(result?.state).toBe('failed');
    expect(result?.reason).toBe('auth_required');
    expect(result?.next_action).toBe('configure_auth');
    expect(getMacroSyncDescription(result!)).toContain('authentication');
  });
});
