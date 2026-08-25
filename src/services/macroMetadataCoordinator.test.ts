import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { registerAppStateGetter } from './appStateRuntime';
import {
  clearMacroMetadataCoordinatorForTests,
  flushMacroMetadata,
  recordMacroMetadataMutation,
} from './macroMetadataCoordinator';
import type { MacroBranchSyncDto } from './tauriIpc';

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

const macroBranchCommitIfDirtyMock = mock(
  async ({ message, workspacePath }: { message?: string; workspacePath?: string | null } = {}) =>
    createMacroResult({
      committed: true,
      commit_hash: `${workspacePath || 'default'}:${message || 'default'}`,
    })
);

const deps = {
  tauri: {
    isTauriAvailable: () => true,
    macroBranchCommitIfDirty: macroBranchCommitIfDirtyMock,
  },
  debounceMs: 0,
};

describe('macroMetadataCoordinator', () => {
  beforeEach(() => {
    clearMacroMetadataCoordinatorForTests();
    macroBranchCommitIfDirtyMock.mockClear();
  });

  afterEach(() => {
    clearMacroMetadataCoordinatorForTests();
  });

  it('keeps light mutations dirty until an explicit flush', async () => {
    recordMacroMetadataMutation({
      workspacePath: '/repos/web',
      kind: 'chat_synced',
      importance: 'light',
    }, deps);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();

    await flushMacroMetadata({
      trigger: 'code_push',
      workspacePaths: ['/repos/web'],
    }, deps);

    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(1);
    expect(macroBranchCommitIfDirtyMock.mock.calls[0]?.[0]).toEqual({
      workspacePath: '/repos/web',
      message: 'chore(@macro): sync project state',
    });
  });

  it('skips WSL workspace metadata flushes', async () => {
    recordMacroMetadataMutation({
      workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\oscar\\repo',
      kind: 'plan_updated',
      label: 'wsl-plan',
      importance: 'structural',
    }, deps);

    await flushMacroMetadata({
      trigger: 'code_push',
      workspacePaths: [
        '\\\\wsl.localhost\\Ubuntu\\home\\oscar\\repo',
        '/repos/web',
      ],
    }, deps);

    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(1);
    expect(macroBranchCommitIfDirtyMock.mock.calls[0]?.[0]).toEqual({
      workspacePath: '/repos/web',
      message: 'chore(@macro): sync project state',
    });
  });

  it('commits structural mutations immediately', async () => {
    recordMacroMetadataMutation({
      workspacePath: '/repos/web',
      kind: 'plan_updated',
      label: 'first-plan',
      importance: 'structural',
    }, deps);
    recordMacroMetadataMutation({
      workspacePath: '/repos/web',
      kind: 'plan_updated',
      label: 'final-plan',
      importance: 'structural',
    }, deps);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(2);
    expect(macroBranchCommitIfDirtyMock.mock.calls[0]?.[0]).toEqual({
      workspacePath: '/repos/web',
      message: 'chore(@macro): update plan first-plan',
    });
    expect(macroBranchCommitIfDirtyMock.mock.calls[1]?.[0]).toEqual({
      workspacePath: '/repos/web',
      message: 'chore(@macro): update plan final-plan',
    });
  });

  it('does not let light mutations cancel a pending structural checkpoint', async () => {
    recordMacroMetadataMutation({
      workspacePath: '/repos/web',
      kind: 'plan_created',
      label: 'checkout-flow',
      importance: 'structural',
    }, {
      ...deps,
      debounceMs: 10,
    });
    recordMacroMetadataMutation({
      workspacePath: '/repos/web',
      kind: 'chat_synced',
      importance: 'light',
    }, deps);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(1);
    expect(macroBranchCommitIfDirtyMock.mock.calls[0]?.[0]).toEqual({
      workspacePath: '/repos/web',
      message: 'chore(@macro): create plan checkout-flow',
    });
  });

  it('skips pending metadata flushes for non-Git-actionable projects', async () => {
    const guardedDeps = {
      ...deps,
      debounceMs: 10,
      isWorkspaceGitActionable: (workspacePath: string) => workspacePath !== '/repos/direct',
    };

    recordMacroMetadataMutation({
      workspacePath: '/repos/direct',
      kind: 'plan_updated',
      label: 'direct-project',
      importance: 'structural',
    }, guardedDeps);

    await flushMacroMetadata({
      trigger: 'app_close',
      workspacePaths: ['/repos/direct'],
    }, guardedDeps);

    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
  });

  it('keeps Git projects and unknown external folders flushable', async () => {
    const guardedDeps = {
      ...deps,
      isWorkspaceGitActionable: (workspacePath: string) => workspacePath === '/repos/git',
    };

    await flushMacroMetadata({
      trigger: 'code_push',
      workspacePaths: ['/repos/git'],
    }, guardedDeps);

    await flushMacroMetadata({
      trigger: 'code_push',
      workspacePaths: ['/external/folder'],
    }, deps);

    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(2);
    expect(macroBranchCommitIfDirtyMock.mock.calls.map(([params]) => params?.workspacePath)).toEqual([
      '/repos/git',
      '/external/folder',
    ]);
  });

  it('resolves registered direct-edit projects by normalized workspace path', async () => {
    registerAppStateGetter(() => ({
      standaloneProjects: [],
      projectGroups: [{
        projects: [{
          path: 'C:\\repos\\direct',
          isReadOnly: false,
          gitSetupState: 'not_git' as const,
          directEdit: true,
        }],
      }],
    }));

    await flushMacroMetadata({
      trigger: 'app_close',
      workspacePaths: ['C:/repos/direct/'],
    }, deps);

    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
  });
});
