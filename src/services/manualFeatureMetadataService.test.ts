import { beforeEach, describe, expect, it, mock } from 'bun:test';

let importCounter = 0;
let fsExistsMock: ReturnType<typeof mock>;
let fsWriteFileMock: ReturnType<typeof mock>;
let fsDeleteMock: ReturnType<typeof mock>;
let listMessagesMock: ReturnType<typeof mock>;
let macroBranchCommitIfDirtyMock: ReturnType<typeof mock>;
let macroBranchPushMock: ReturnType<typeof mock>;

const appState = {
  metadataAutoPush: false,
  getProjectById: (projectId: string) =>
    projectId === 'project-1'
      ? { id: 'project-1', path: '/repo/app', gitSetupState: 'ready' as const, directEdit: false }
      : undefined,
};

const loadService = async () => {
  importCounter += 1;
  mock.restore();

  mock.module('./tauriIpc', () => ({
    isTauriAvailable: () => true,
    fsExists: fsExistsMock,
    fsWriteFile: fsWriteFileMock,
    fsDelete: fsDeleteMock,
    listMessages: listMessagesMock,
    macroBranchCommitIfDirty: macroBranchCommitIfDirtyMock,
    macroBranchPush: macroBranchPushMock,
  }));

  mock.module('../stores/useAppStore', () => ({
    useAppStore: {
      getState: () => appState,
    },
  }));

  return import(
    `./manualFeatureMetadataService.ts?manual-feature-metadata-test=${importCounter}`
  );
};

describe('manualFeatureMetadataService', () => {
  beforeEach(() => {
    const existingPaths = new Set<string>([
      'branches/develop/manual-features/task-1',
    ]);

    fsExistsMock = mock(
      async (
        path: string,
        _options?: { workspacePath?: string | null; workspaceScope?: string }
      ) => existingPaths.has(path)
    );
    fsWriteFileMock = mock(
      async ({ path, content }: { path: string; content: string }) => ({
        path,
        bytes_written: content.length,
        created: true,
        skipped: false,
      })
    );
    fsDeleteMock = mock(async ({ path }: { path: string }) => {
      existingPaths.delete(path);
    });
    listMessagesMock = mock(async () => [
      {
        id: 'message-1',
        role: 'user',
        content: 'Ship it',
        created_at: '2026-04-23T09:00:00.000Z',
      },
    ]);
    macroBranchCommitIfDirtyMock = mock(async () => undefined);
    macroBranchPushMock = mock(async () => undefined);
  });

  it('writes manual feature metadata to the canonical root and keeps execution targets readable', async () => {
    const { syncManualFeatureMetadataFromTask } = await loadService();

    await syncManualFeatureMetadataFromTask({
      id: 'task-1',
      title: 'Quick export',
      description: 'Add CSV export.',
      status: 'InProgress',
      draft: false,
      feature_slug: 'quick-export',
      task_kind: 'bugfix',
      branch_name: 'bugfix/quick-export',
      base_branch: 'develop',
      conversation_id: 'conversation-1',
      project_id: 'project-1',
      project_ids: ['project-1'],
      standalone_kind: 'manual_feature',
      execution_targets: [
        {
          projectId: 'project-1',
          executionMode: 'git',
          branchName: 'bugfix/quick-export',
          targetBranchName: 'release/app',
          worktreeKey: 'project-1::feature/quick-export',
          repoPath: '/repo/app',
          executionKind: 'worktree',
        },
      ],
    });

    const writtenPaths = fsWriteFileMock.mock.calls.map(([params]) => params.path);
    expect(writtenPaths).toEqual([
      'manual-features/task-1/feature.json',
      'manual-features/task-1/feature.md',
      'manual-features/task-1/chat.jsonl',
    ]);

    const markdownWrite = fsWriteFileMock.mock.calls.find(
      ([params]) => params.path === 'manual-features/task-1/feature.md'
    )?.[0];
    expect(markdownWrite?.content).toContain('Base Branch (legacy snapshot): develop');
    expect(markdownWrite?.content).toContain('Task Kind: bugfix');
    expect(markdownWrite?.content).toContain('## Execution Targets');
    expect(markdownWrite?.content).toContain(
      '- project-1 (/repo/app): bugfix/quick-export -> release/app'
    );

    const jsonWrite = fsWriteFileMock.mock.calls.find(
      ([params]) => params.path === 'manual-features/task-1/feature.json'
    )?.[0];
    expect(JSON.parse(jsonWrite?.content || '{}')).toMatchObject({ taskKind: 'bugfix' });

    expect(fsDeleteMock).toHaveBeenCalledWith({
      path: 'branches/develop/manual-features/task-1',
      recursive: true,
      workspaceScope: 'metadata',
      workspacePath: '/repo/app',
    });
  });

  it('removes both canonical and legacy metadata roots when deleting a manual feature snapshot', async () => {
    fsExistsMock.mockImplementation(
      async (path: string) =>
        path === 'branches/develop/manual-features/task-1' ||
        path === 'manual-features/task-1'
    );
    const { removeManualFeatureMetadata } = await loadService();

    await removeManualFeatureMetadata({
      id: 'task-1',
      base_branch: 'develop',
      project_id: 'project-1',
      project_ids: ['project-1'],
      standalone_kind: 'manual_feature',
      execution_targets: [
        {
          projectId: 'project-1',
          executionMode: 'git',
          branchName: 'feature/quick-export',
          targetBranchName: 'release/app',
          worktreeKey: 'project-1::feature/quick-export',
          repoPath: '/repo/app',
          executionKind: 'worktree',
        },
      ],
    });

    const deletedPaths = fsDeleteMock.mock.calls.map(([params]) => params.path).sort();
    expect(deletedPaths).toEqual([
      'branches/develop/manual-features/task-1',
      'manual-features/task-1',
    ]);
  });
});
