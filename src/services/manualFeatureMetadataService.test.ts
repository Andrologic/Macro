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
  project: { id: 'project-1', path: '/repo/app', gitSetupState: 'ready' as const, directEdit: false },
  getProjectById: (projectId: string) =>
    projectId === 'project-1'
      ? appState.project
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
    appState.project = {
      id: 'project-1',
      path: '/repo/app',
      gitSetupState: 'ready' as const,
      directEdit: false,
    };
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

  it('uses existing metadata roots for every guarded write', async () => {
    const { syncManualFeatureMetadataFromTask } = await loadService();
    await syncManualFeatureMetadataFromTask({
      id: 'task-1', title: 'Renamed', description: '', status: 'Pending', draft: false,
      base_branch: 'develop', project_id: 'project-1', project_ids: ['project-1'],
      standalone_kind: 'manual_feature', execution_targets: [],
    }, async () => undefined);
    expect(fsWriteFileMock).toHaveBeenCalledTimes(3);
    for (const [params] of fsWriteFileMock.mock.calls) expect(params.workspaceScope).toBe('metadata_existing');
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

  it('writes direct task metadata to the current project .macro scope without Git', async () => {
    appState.project = {
      id: 'project-1',
      path: '/repo/moved-app',
      gitSetupState: 'ready' as const,
      directEdit: true,
    };
    const { syncManualFeatureMetadataFromTask } = await loadService();

    await syncManualFeatureMetadataFromTask({
      id: 'task-direct',
      title: 'Direct task',
      description: 'Edit without Git.',
      status: 'InProgress',
      draft: false,
      feature_slug: 'direct-task',
      task_kind: 'feature',
      branch_name: '',
      base_branch: 'develop',
      conversation_id: null,
      project_id: 'project-1',
      project_ids: ['project-1'],
      standalone_kind: 'manual_feature',
      execution_targets: [{
        projectId: 'project-1',
        executionMode: 'direct',
        branchName: '',
        worktreeKey: 'direct:task-direct',
        repoPath: '/repo/old-app',
        executionKind: 'repository_root',
      }],
    });

    expect(fsWriteFileMock).toHaveBeenCalledTimes(3);
    for (const [params] of fsWriteFileMock.mock.calls) {
      expect(params.workspacePath).toBe('/repo/moved-app');
      expect(params.workspaceScope).toBe('direct');
    }
    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
  });
  it('reauthorizes each project metadata commit and stops after revocation', async () => {
    const saved = appState.getProjectById;
    const projects = ['project-1', 'project-2'].map((id, index) => ({ ...appState.project, id, path: `/synthetic/project-${index}`, name: id }));
    appState.getProjectById = id => projects.find(project => project.id === id);
    const { registerAppStateGetter } = await import('./appStateRuntime');
    registerAppStateGetter(() => ({ standaloneProjects: projects, projectGroups: [] }));
    let revoked = false;
    macroBranchCommitIfDirtyMock.mockImplementation(async () => { revoked = true; });
    try {
      const { commitManualFeatureMetadata } = await loadService();
      await expect(commitManualFeatureMetadata({ id: 'task:fixture', standalone_kind: 'manual_feature', project_id: 'project-1',
        project_ids: ['project-1', 'project-2'], execution_targets: [], base_branch: 'develop' }, 'Fixture commit', async () => {
        if (revoked) throw new Error('authorization revoked');
      })).rejects.toThrow('authorization revoked');
      expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(1);
      expect(macroBranchCommitIfDirtyMock.mock.calls[0]?.[0]).toMatchObject({ pilotOnly: true });
    } finally { appState.getProjectById = saved; }
  });

  it.each(['exists', 'delete', 'authorization'])('propagates %s failures during metadata cleanup', async stage => {
    fsExistsMock.mockImplementation(async () => true);
    const failure = new Error(`${stage} denied`);
    if (stage === 'exists') fsExistsMock.mockImplementation(async () => { throw failure; });
    if (stage === 'delete') fsDeleteMock.mockImplementation(async () => { throw failure; });
    const { removeManualFeatureMetadata } = await loadService();
    await expect(removeManualFeatureMetadata({ id: 'task-1', base_branch: 'develop', project_id: 'project-1',
      project_ids: ['project-1'], standalone_kind: 'manual_feature', execution_targets: [] }, async () => {
      if (stage === 'authorization') throw failure;
    })).rejects.toThrow(`${stage} denied`);
    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
    if (stage !== 'delete') expect(fsDeleteMock).not.toHaveBeenCalled();
    for (const call of fsExistsMock.mock.calls) expect(call[1]).toMatchObject({ workspaceScope: 'metadata_existing' });
  });

  it('accepts only a typed missing-file error when a metadata root disappears during deletion', async () => {
    fsExistsMock.mockImplementation(async () => true);
    fsDeleteMock.mockImplementation(async () => { throw { code: 'FilesystemNotFound', message: 'Already removed' }; });
    const { removeManualFeatureMetadata } = await loadService();
    await removeManualFeatureMetadata({ id: 'task-1', base_branch: 'develop', project_id: 'project-1',
      project_ids: ['project-1'], standalone_kind: 'manual_feature', execution_targets: [] });
    expect(fsDeleteMock).toHaveBeenCalledTimes(2);
  });

});
