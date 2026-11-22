import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
const actualTauriIpc = await import('./tauriIpc');

type MockAppState = {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  projectGroups: Array<{
    id: string;
    name: string;
    isOpen: boolean;
    projects: Array<{
      id: string;
      name: string;
      mountName: string;
      path: string;
      gitSetupState: 'ready';
      directEdit: false;
    }>;
  }>;
};

const appState: MockAppState = {
  selectedGroupId: 'group-main',
  selectedProjectId: 'web',
  projectGroups: [
    {
      id: 'group-main',
      name: 'Main',
      isOpen: true,
      projects: [
        {
          id: 'web',
          name: 'Web',
          mountName: 'web',
          path: '/repos/web',
          gitSetupState: 'ready',
          directEdit: false,
        },
      ],
    },
  ],
};

const workspaceFiles = new Map<string, Map<string, string>>();
let importCounter = 0;
let originalConsoleInfo: typeof console.info;
const gitWorktreeInspectMock = mock(
  async (params: { repoPath: string; taskId: string; branchName?: string | null }) => ({
    taskId: params.taskId,
    worktreePath: `${params.repoPath}/.macro/worktrees/task${params.taskId}`,
    branchName: params.branchName ?? 'develop',
    status: 'ready' as const,
    isDirty: false,
  })
);
const gitBranchWorktreeInspectMock = mock(
  async (params: { repoPath: string; worktreeKey: string; branchName?: string | null }) => ({
    worktreeKey: params.worktreeKey,
    worktreePath: `${params.repoPath}/.macro/worktrees/${params.worktreeKey}`,
    branchName: params.branchName ?? 'develop',
    status: 'ready' as const,
    isDirty: false,
  })
);

const normalizeFsPath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');

const ensureWorkspace = (workspacePath?: string | null): Map<string, string> => {
  const key = (workspacePath && workspacePath.trim() ? workspacePath : '__workspace__')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const workspace = workspaceFiles.get(key);
  if (workspace) {
    return workspace;
  }
  const next = new Map<string, string>();
  workspaceFiles.set(key, next);
  return next;
};

const writeWorkspaceFile = (workspacePath: string | null | undefined, path: string, content: string): void => {
  ensureWorkspace(workspacePath).set(normalizeFsPath(path), content);
};

const writeWorkspaceJson = (workspacePath: string | null | undefined, path: string, value: unknown): void => {
  writeWorkspaceFile(workspacePath, path, JSON.stringify(value, null, 2));
};

const readWorkspaceFile = (workspacePath: string | null | undefined, path: string): string | null =>
  ensureWorkspace(workspacePath).get(normalizeFsPath(path)) ?? null;

const deleteWorkspacePrefix = (workspacePath: string | null | undefined, path: string): void => {
  const prefix = normalizeFsPath(path);
  const workspace = ensureWorkspace(workspacePath);
  for (const key of workspace.keys()) {
    if (key === prefix || key.startsWith(`${prefix}/`)) {
      workspace.delete(key);
    }
  }
};

const listWorkspaceFiles = (
  workspacePath: string | null | undefined,
  path: string
): Array<{ kind: 'file'; relative_path: string }> => {
  const prefix = normalizeFsPath(path);
  const normalizedPrefix = prefix.length > 0 ? `${prefix}/` : '';
  return Array.from(ensureWorkspace(workspacePath).keys())
    .filter((key) => key.startsWith(normalizedPrefix))
    .map((key) => ({
      kind: 'file' as const,
      relative_path: key.slice(normalizedPrefix.length),
    }));
};

const buildStoredPlan = () => ({
  id: 'plan-1',
  slug: 'checkout',
  title: 'Checkout',
  description: 'Stored with a stale session project id.',
  status: 'validated',
  targetBranch: 'develop',
  projectId: 'web',
  projectIds: ['web', 'session-project-ghost'],
  createdAt: '2026-03-15T00:00:00.000Z',
  updatedAt: '2026-03-16T00:00:00.000Z',
  nodes: [
    {
      id: 'task-web',
      title: 'Build checkout UI',
      type: 'task',
      status: 'completed',
      dependencies: [],
      assignedBranch: 'feature/checkout/checkout-web',
      projectId: 'web',
      projectIds: ['web', 'session-project-ghost'],
    },
  ],
  predictedBranches: [
    {
      id: 'branch-web',
      name: 'feature/checkout/checkout-web',
      color: '#3b82f6',
      parentBranch: 'plan/checkout',
      projectId: 'web',
      taskIds: ['task-web'],
      status: 'completed',
    },
    {
      id: 'branch-ghost',
      name: 'feature/ghost',
      color: '#000000',
      parentBranch: 'plan/checkout',
      projectId: 'session-project-ghost',
      taskIds: ['task-web'],
      status: 'planned',
    },
  ],
});

const seedReplica = (plan: ReturnType<typeof buildStoredPlan> & Pick<
  import('./architectPlanService').ArchitectPlanRecord, 'agsdl'
> = buildStoredPlan()): void => {
  writeWorkspaceJson('/repos/web', 'branches/develop/plans/index.json', {
    version: 2,
    activePlanId: plan.id,
    plans: [
      {
        id: plan.id,
        slug: plan.slug,
        title: plan.title,
        description: plan.description,
        status: plan.status,
        targetBranch: plan.targetBranch,
        projectId: plan.projectId,
        projectIds: plan.projectIds,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        nodeCount: plan.nodes.length,
      },
    ],
    reservedPlanSlugs: [plan.slug],
  });
  writeWorkspaceJson('/repos/web', `branches/develop/plans/${plan.id}/plan.json`, plan);
};

const gitStatusMock = mock(async () => ({
  branch: 'develop',
  head_commit: null,
  staged_files: [],
  unstaged_files: [],
  untracked_files: [],
  conflicted_files: [],
  conflictedFiles: [],
  merge_in_progress: false,
  mergeInProgress: false,
  modified_files: [],
  is_clean: true,
  ahead: 0,
  behind: 0,
}));
const gitDiffMock = mock(async () => 'diff --git a/file.ts b/file.ts');
const gitMergeCheckMock = mock(async () => ({
  mergeable: true,
  conflictFiles: [],
  hasChanges: true,
}));
const gitPullMock = mock(async () => ({
  branch: 'develop',
  remote: 'origin',
  output: 'Already up to date.',
}));
const gitMergeMock = mock(async () => 'merge-ok');
const gitGuardedMergeStateMock = mock(async (params: { expectedIntoCommit: string }) => ({
  status: gitMergeMock.mock.calls.length > 0 ? 'integrated' as const : 'pending' as const,
  targetCommit: params.expectedIntoCommit,
}));
const gitPrepareGuardedBranchSyncMock = mock(async (params: { expectedBranchCommit: string }) => ({
  targetCommit: params.expectedBranchCommit,
}));
const gitGuardedBranchSyncMock = mock(async (params: { syncTargetCommit: string }) => ({
  status: 'integrated' as const,
  targetCommit: params.syncTargetCommit,
}));
const gitBranchListMock = mock(async () => ({
  current: 'develop',
  local: [
    { name: 'develop', is_head: true, commit: 'develop-sha' },
    { name: 'plan/checkout', is_head: false, commit: 'plan-sha' },
    { name: 'feature/checkout/checkout-web', is_head: false, commit: 'feature-sha' },
  ],
  remote: [],
}));
const gitBranchDeleteMock = mock(async () => undefined);
const gitCheckoutMock = mock(async () => undefined);
const gitBranchCreateMock = mock(async () => undefined);
const dbAppSettings = new Map<string, string>();
const dbGetAppSettingMock = mock(async (key: string) => {
  const valueJson = dbAppSettings.get(key);
  return valueJson === undefined
    ? null
    : { key, value_json: valueJson, updated_at: '2026-08-13T00:00:00.000Z' };
});
const dbSetAppSettingMock = mock(async ({ key, valueJson }: { key: string; valueJson: string }) => {
  dbAppSettings.set(key, valueJson);
  return { key, value_json: valueJson, updated_at: '2026-08-13T00:00:00.000Z' };
});
const compareAndSwapAppSetting = async ({ key, expectedValueJson, valueJson }: Parameters<typeof actualTauriIpc.dbCompareAndSwapAppSetting>[0]) => {
  if ((dbAppSettings.get(key) ?? null) !== expectedValueJson) return { applied: false };
  dbAppSettings.set(key, valueJson);
  return { applied: true };
};
const dbCompareAndSwapAppSettingMock = mock(compareAndSwapAppSetting);
const metadataCommitResult = {
  branch: '@macro',
  state: 'clean',
  worktree_path: '/repos/web/.git/macro-metadata-worktree',
  is_dirty: false,
  has_origin: false,
  has_upstream: false,
  ahead: 0,
  behind: 0,
  conflicted_files: [],
  committed: false,
  commit_hash: null,
  reason: null,
  next_action: null,
  output: null,
  error: null,
} satisfies import('./tauriIpc').MacroBranchSyncDto;
const macroBranchCommitIfDirtyMock = mock<typeof actualTauriIpc.macroBranchCommitIfDirty>(
  async () => metadataCommitResult,
);
const gitWorktreeRemoveMock = mock(async (params: { repoPath: string; taskId: string; branchName?: string | null }) => ({
  taskId: params.taskId,
  worktreePath: `${params.repoPath}/.macro/worktrees/task${params.taskId}`,
  removedPath: true,
  prunedRegistration: true,
  alreadyAbsent: false,
}));
const gitBranchWorktreeRemoveMock = mock(
  async (params: { repoPath: string; worktreeKey: string; branchName: string }) => ({
    worktreeKey: params.worktreeKey,
    worktreePath: `${params.repoPath}/.macro/worktrees/${params.worktreeKey}`,
    branchName: params.branchName,
    removedPath: true,
    prunedRegistration: true,
    alreadyAbsent: false,
  })
);

const registerModuleMocks = () => {
  mock.restore();

  mock.module('./tauriIpc', () => ({
    ...actualTauriIpc,
    isTauriAvailable: () => true,
    dbGetAppSetting: dbGetAppSettingMock,
    dbSetAppSetting: dbSetAppSettingMock,
    dbCompareAndSwapAppSetting: dbCompareAndSwapAppSettingMock,
    workspaceGetActiveRoot: async () => '/repos/web',
    macroBranchCommitIfDirty: macroBranchCommitIfDirtyMock,
    workspaceAcquirePlanLifecycleLock: async () => 'plan-lifecycle-lease',
    workspaceReleasePlanLifecycleLock: async () => undefined,
    fsReadFileWithOptions: async ({
      path,
      workspacePath,
    }: {
      path: string;
      workspacePath?: string | null;
    }) => {
      const content = readWorkspaceFile(workspacePath, path);
      if (content === null) {
        throw new Error(`Missing file: ${workspacePath ?? 'local'}:${path}`);
      }
      return {
        content,
        language: path.endsWith('.json') ? 'json' : 'text',
        is_binary: false,
        size: content.length,
        encoding: 'utf-8',
      };
    },
    fsWriteFile: async ({
      path,
      content,
      workspacePath,
    }: {
      path: string;
      content: string;
      workspacePath?: string | null;
    }) => {
      writeWorkspaceFile(workspacePath, path, content);
      return {
        path,
        bytes_written: content.length,
        created: true,
      };
    },
    fsDelete: async ({
      path,
      workspacePath,
    }: {
      path: string;
      workspacePath?: string | null;
    }) => {
      deleteWorkspacePrefix(workspacePath, path);
    },
    fsListDir: async ({
      path,
      workspacePath,
    }: {
      path: string;
      workspacePath?: string | null;
    }) => listWorkspaceFiles(workspacePath, path),
    gitStatus: gitStatusMock,
    gitDiff: gitDiffMock,
    gitMergeCheck: gitMergeCheckMock,
    gitPull: gitPullMock,
    gitMerge: gitMergeMock,
    gitGuardedMergeState: gitGuardedMergeStateMock,
    gitPrepareGuardedBranchSync: gitPrepareGuardedBranchSyncMock,
    gitGuardedBranchSync: gitGuardedBranchSyncMock,
    gitBranchList: gitBranchListMock,
    gitBranchDelete: gitBranchDeleteMock,
    gitCheckout: gitCheckoutMock,
    gitBranchCreate: gitBranchCreateMock,
    gitWorktreeInspect: gitWorktreeInspectMock,
    gitBranchWorktreeInspect: gitBranchWorktreeInspectMock,
    gitWorktreeRemove: gitWorktreeRemoveMock,
    gitBranchWorktreeRemove: gitBranchWorktreeRemoveMock,
  }));

  const appStoreState = {
    ...appState,
    getProjectById: (projectId: string) =>
      appState.projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId) || null,
  };

  mock.module('../stores/useAppStore', () => ({
    useAppStore: Object.assign(
      <TSelected = typeof appStoreState>(
        selector?: (state: typeof appStoreState) => TSelected
      ) =>
        selector
          ? selector(appStoreState)
          : (appStoreState as unknown as TSelected),
      {
        getState: () => appStoreState,
        setState: (
          patch:
            | Partial<typeof appStoreState>
            | ((state: typeof appStoreState) => Partial<typeof appStoreState>)
        ) => {
          Object.assign(
            appStoreState,
            typeof patch === 'function' ? patch(appStoreState) : patch
          );
        },
        subscribe: () => () => undefined,
      }
    ),
  }));
};

const loadIntegrationModules = async () => {
  registerModuleMocks();
  importCounter += 1;
  const planService = await import(`./architectPlanService.ts?gitflow-replica=${importCounter}`);
  const gitFlowService = await import(`./architectGitFlowService.ts?gitflow-replica=${importCounter}`);
  return {
    planService,
    gitFlowService,
  };
};

const legacyArchiveCheckpoint = {
  branchName: 'develop', planId: 'plan-1', operation: 'archive', phase: 'metadata_commit_pending',
  requiresMetadataCommit: true, createdAt: '2026-03-17T00:00:00.000Z', updatedAt: '2026-03-17T00:00:00.000Z',
} as const;
const legacyFinalization = {
  branchName: 'develop', planId: 'plan-1', operation: 'finalize', phase: 'metadata_written',
  finalizationRepositories: [], createdAt: '2026-03-16T00:00:00.000Z', updatedAt: '2026-03-16T00:00:00.000Z',
} as const;
const lifecycleJournalKey = 'pendingPlanLifecycles:v1';
const readLifecycleJournal = () => JSON.parse(dbAppSettings.get(lifecycleJournalKey) ?? '[]');

const loadLifecycleRecovery = async () => {
  const { planService, gitFlowService } = await loadIntegrationModules();
  const getAppState = () => ({
    ...appState,
    getProjectById: (id: string) => appState.projectGroups.flatMap((group) => group.projects)
      .find((project) => project.id === id) ?? null,
  });
  const plans = planService.createArchitectPlanService({ getAppState });
  return gitFlowService.createArchitectGitFlowService({ ...plans, getAppState });
};

const expectNoDevelopmentGit = () => {
  expect(gitBranchListMock).not.toHaveBeenCalled();
  expect(gitBranchDeleteMock).not.toHaveBeenCalled();
  expect(gitGuardedMergeStateMock).not.toHaveBeenCalled();
  expect(gitMergeMock).not.toHaveBeenCalled();
  expect(gitWorktreeRemoveMock).not.toHaveBeenCalled();
  expect(gitBranchWorktreeRemoveMock).not.toHaveBeenCalled();
};

describe('architectGitFlowService replica integration', () => {
  beforeEach(() => {
    installTauriRuntimeMock();
    workspaceFiles.clear();
    dbAppSettings.clear();
    seedReplica();
    originalConsoleInfo = console.info;
    console.info = () => undefined;
    gitStatusMock.mockClear();
    gitDiffMock.mockClear();
    gitMergeCheckMock.mockClear();
    gitPullMock.mockClear();
    gitMergeMock.mockClear();
    gitGuardedMergeStateMock.mockClear();
    gitPrepareGuardedBranchSyncMock.mockClear();
    gitGuardedBranchSyncMock.mockClear();
    gitBranchListMock.mockClear();
    gitBranchDeleteMock.mockClear();
    gitCheckoutMock.mockClear();
    gitBranchCreateMock.mockClear();
    dbGetAppSettingMock.mockClear();
    dbSetAppSettingMock.mockClear();
    dbCompareAndSwapAppSettingMock.mockReset();
    dbCompareAndSwapAppSettingMock.mockImplementation(compareAndSwapAppSetting);
    macroBranchCommitIfDirtyMock.mockReset();
    macroBranchCommitIfDirtyMock.mockImplementation(async () => metadataCommitResult);
    gitWorktreeInspectMock.mockClear();
    gitBranchWorktreeInspectMock.mockClear();
    gitWorktreeRemoveMock.mockClear();
    gitBranchWorktreeRemoveMock.mockClear();
  });

  afterEach(() => {
    console.info = originalConsoleInfo;
    removeTauriRuntimeMock();
    mock.restore();
  });

  it('leaves an AgSDL replica with stale project ids byte-for-byte intact during legacy archive recovery', async () => {
    seedReplica({
      ...buildStoredPlan(), status: 'archived',
      agsdl: { source: '{ "opaque": 900719925474099312345 }', annexes: { notes: '{ "keep": true }' }, revision: 4 },
    });
    writeWorkspaceFile('/repos/web', 'branches/develop/plans/plan-1/chat.jsonl', '{"content":"Keep this chat"}\n');
    const before = new Map(ensureWorkspace('/repos/web'));
    const journal = JSON.stringify([legacyFinalization, legacyArchiveCheckpoint]);
    dbAppSettings.set(lifecycleJournalKey, journal);
    const service = await loadLifecycleRecovery();

    await service.resumePlanLifecycleSagas();

    expect(ensureWorkspace('/repos/web')).toEqual(before);
    expect(dbAppSettings.get(lifecycleJournalKey)).toBe(journal);
    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
    expectNoDevelopmentGit();
  });

  it.each(['metadata_commit_pending', 'metadata_committed'] as const)(
    'closes a legacy finalization and its archive at %s without development actions',
    async (phase) => {
      seedReplica({ ...buildStoredPlan(), status: 'archived' });
      const before = new Map(ensureWorkspace('/repos/web'));
      dbAppSettings.set(lifecycleJournalKey, JSON.stringify([
        legacyFinalization, { ...legacyArchiveCheckpoint, phase, requiresMetadataCommit: undefined },
      ]));
      const service = await loadLifecycleRecovery();

      expect(await service.readPlanFinalizationRecovery(legacyFinalization)).toMatchObject({
        phase, nextActions: [phase === 'metadata_commit_pending' ? 'commit_metadata' : 'close_journal'],
      });
      await service.resumePlanLifecycleSagas();
      await service.resumePlanLifecycleSagas();

      expect(readLifecycleJournal()).toEqual([]);
      expect(await service.readPlanFinalizationRecovery(legacyFinalization)).toBeNull();
      expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(phase === 'metadata_commit_pending' ? 1 : 0);
      expect(ensureWorkspace('/repos/web')).toEqual(before);
      expectNoDevelopmentGit();
    },
  );

  it('keeps both journals pending when the metadata checkpoint returns an error', async () => {
    seedReplica({ ...buildStoredPlan(), status: 'archived' });
    dbAppSettings.set(lifecycleJournalKey, JSON.stringify([legacyFinalization, legacyArchiveCheckpoint]));
    macroBranchCommitIfDirtyMock.mockImplementationOnce(async () => ({
      ...metadataCommitResult, is_dirty: true, error: 'Metadata checkpoint rejected',
    }));
    const service = await loadLifecycleRecovery();

    await service.resumePlanLifecycleSagas();

    expect(readLifecycleJournal()).toEqual([
      legacyFinalization,
      expect.objectContaining({ phase: 'metadata_commit_pending', lastError: 'Metadata checkpoint rejected' }),
    ]);
    expect(await service.readPlanFinalizationRecovery(legacyFinalization)).toMatchObject({
      nextActions: ['commit_metadata'],
    });
    await service.resumePlanLifecycleSagas();
    expect(readLifecycleJournal()).toEqual([]);
    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(2);
    expectNoDevelopmentGit();
  });

  it.each(['finalize', 'archive'])('restarts closure after interruption before closing %s', async (operation) => {
    seedReplica({ ...buildStoredPlan(), status: 'archived' });
    dbAppSettings.set(lifecycleJournalKey, JSON.stringify([legacyFinalization, legacyArchiveCheckpoint]));
    let interrupted = false;
    dbCompareAndSwapAppSettingMock.mockImplementation(async (change) => {
      if (!interrupted && change.key === 'completedPlanLifecycles:v1' && change.valueJson.includes(`:${operation}"`)) {
        interrupted = true;
        throw new Error('Interrupted before closing the journal');
      }
      return compareAndSwapAppSetting(change);
    });
    const service = await loadLifecycleRecovery();

    await service.resumePlanLifecycleSagas();

    expect(readLifecycleJournal()).toEqual([
      ...(operation === 'finalize' ? [legacyFinalization] : []),
      expect.objectContaining({ phase: 'metadata_committed', lastError: 'Interrupted before closing the journal' }),
    ]);
    expect(await service.readPlanFinalizationRecovery(legacyFinalization)).toMatchObject({
      nextActions: ['close_journal'],
    });
    const restarted = await loadLifecycleRecovery();
    await restarted.resumePlanLifecycleSagas();
    expect(readLifecycleJournal()).toEqual([]);
    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(1);
    expectNoDevelopmentGit();
  });

  it('keeps a replacement finalization generation introduced during the archive checkpoint', async () => {
    seedReplica({ ...buildStoredPlan(), status: 'archived' });
    const original = { ...legacyFinalization, generation: 1 };
    const replacement = { ...legacyFinalization, generation: 2 };
    dbAppSettings.set(lifecycleJournalKey, JSON.stringify([original, legacyArchiveCheckpoint]));
    macroBranchCommitIfDirtyMock.mockImplementationOnce(async () => {
      dbAppSettings.set(lifecycleJournalKey, JSON.stringify([replacement, legacyArchiveCheckpoint]));
      return metadataCommitResult;
    });
    const service = await loadLifecycleRecovery();

    await service.resumePlanLifecycleSagas();

    expect(readLifecycleJournal()).toEqual([replacement]);
    expect(macroBranchCommitIfDirtyMock).toHaveBeenCalledTimes(1);
    expectNoDevelopmentGit();
  });

  it('does not fail closed during finalization when replica noise is only a stale session project id', async () => {
    const { planService, gitFlowService } = await loadIntegrationModules();
    const service = gitFlowService.createArchitectGitFlowService({
      tauri: {
        isTauriAvailable: () => true,
        gitStatus: gitStatusMock,
        gitDiff: gitDiffMock,
        gitMergeCheck: gitMergeCheckMock,
        gitPull: gitPullMock,
        gitMerge: gitMergeMock,
        gitGuardedMergeState: gitGuardedMergeStateMock,
        gitPrepareGuardedBranchSync: gitPrepareGuardedBranchSyncMock,
        gitGuardedBranchSync: gitGuardedBranchSyncMock,
        gitBranchList: gitBranchListMock,
        gitBranchDelete: gitBranchDeleteMock,
        gitCheckout: gitCheckoutMock,
        gitBranchCreate: gitBranchCreateMock,
        gitWorktreeInspect: gitWorktreeInspectMock,
        gitBranchWorktreeInspect: gitBranchWorktreeInspectMock,
        gitWorktreeRemove: gitWorktreeRemoveMock,
        gitBranchWorktreeRemove: gitBranchWorktreeRemoveMock,
        workspaceAcquirePlanLifecycleLock: async () => 'plan-lifecycle-lease',
        workspaceReleasePlanLifecycleLock: async () => undefined,
      },
      getAppState: () => ({
        selectedGroupId: 'group-main',
        selectedProjectId: 'web',
        projectGroups: appState.projectGroups,
        getProjectById: (projectId: string) =>
          appState.projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId) || null,
      }),
      getArchitectPlan: planService.getArchitectPlan,
      archiveArchitectPlan: async (branchName: string, planId: string) => {
        const plan = await planService.getArchitectPlan(branchName, planId);
        return {
          ...plan!,
          status: 'archived',
        };
      },
      updateArchitectPlan: async (params: { branchName: string; planId: string; status?: string }) => {
        const plan = await planService.getArchitectPlan(params.branchName, params.planId);
        return {
          ...plan!,
          status: params.status ?? plan?.status ?? 'validated',
        };
      },
      deleteArchitectPlan: async () => undefined,
      getGitFlowBaseBranch: () => 'develop',
    });

    const result = await service.finalizePlanIntoBaseBranch({
      branchName: 'develop',
      planId: 'plan-1',
    });

    expect(result.plan.projectIds).toEqual(['web']);
    expect(result.plan.predictedBranches).toHaveLength(1);
    expect(gitStatusMock).toHaveBeenCalled();
    expect(gitPullMock).not.toHaveBeenCalled();
    expect(gitPrepareGuardedBranchSyncMock).toHaveBeenCalledTimes(1);
    expect(gitGuardedBranchSyncMock).toHaveBeenCalledTimes(1);
    expect(gitMergeCheckMock).toHaveBeenCalled();
    expect(gitMergeMock).toHaveBeenCalledTimes(1);
    expect(gitBranchDeleteMock).toHaveBeenCalled();
    expect(gitWorktreeRemoveMock).toHaveBeenCalled();
    expect(gitBranchWorktreeRemoveMock).toHaveBeenCalled();

    const persistedPlan = JSON.parse(
      readWorkspaceFile('/repos/web', 'branches/develop/plans/plan-1/plan.json') || 'null'
    );
    expect(persistedPlan.projectIds).toEqual(['web']);
    expect(persistedPlan.predictedBranches).toHaveLength(1);
  });

  it('ignores stale expectedProjectIds when they are the only remaining metadata noise', async () => {
    const basePlan = buildStoredPlan();
    const noisyExpectedOnlyPlan = {
      ...basePlan,
      projectIds: ['web'],
      nodes: basePlan.nodes.map((node) => ({
        ...node,
        projectIds: ['web'],
      })),
      predictedBranches: basePlan.predictedBranches.filter((branch) => branch.projectId === 'web'),
      expectedProjectIds: ['web', 'session-project-ghost'],
    };
    seedReplica(noisyExpectedOnlyPlan);

    const { planService, gitFlowService } = await loadIntegrationModules();
    const service = gitFlowService.createArchitectGitFlowService({
      tauri: {
        isTauriAvailable: () => true,
        gitStatus: gitStatusMock,
        gitDiff: gitDiffMock,
        gitMergeCheck: gitMergeCheckMock,
        gitPull: gitPullMock,
        gitMerge: gitMergeMock,
        gitGuardedMergeState: gitGuardedMergeStateMock,
        gitPrepareGuardedBranchSync: gitPrepareGuardedBranchSyncMock,
        gitGuardedBranchSync: gitGuardedBranchSyncMock,
        gitBranchList: gitBranchListMock,
        gitBranchDelete: gitBranchDeleteMock,
        gitCheckout: gitCheckoutMock,
        gitBranchCreate: gitBranchCreateMock,
        gitWorktreeInspect: gitWorktreeInspectMock,
        gitBranchWorktreeInspect: gitBranchWorktreeInspectMock,
        gitWorktreeRemove: gitWorktreeRemoveMock,
        gitBranchWorktreeRemove: gitBranchWorktreeRemoveMock,
        workspaceAcquirePlanLifecycleLock: async () => 'plan-lifecycle-lease',
        workspaceReleasePlanLifecycleLock: async () => undefined,
      },
      getAppState: () => ({
        selectedGroupId: 'group-main',
        selectedProjectId: 'web',
        projectGroups: appState.projectGroups,
        getProjectById: (projectId: string) =>
          appState.projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId) || null,
      }),
      getArchitectPlan: planService.getArchitectPlan,
      archiveArchitectPlan: async (branchName: string, planId: string) => {
        const plan = await planService.getArchitectPlan(branchName, planId);
        return {
          ...plan!,
          status: 'archived',
        };
      },
      updateArchitectPlan: async (params: { branchName: string; planId: string; status?: string }) => {
        const plan = await planService.getArchitectPlan(params.branchName, params.planId);
        return {
          ...plan!,
          status: params.status ?? plan?.status ?? 'validated',
        };
      },
      deleteArchitectPlan: async () => undefined,
      getGitFlowBaseBranch: () => 'develop',
    });

    const review = await service.loadPlanReview({
      branchName: 'develop',
      planId: 'plan-1',
    });

    expect(review.repositories.map((repository: { projectId: string }) => repository.projectId)).toEqual(['web']);
    expect(gitStatusMock).toHaveBeenCalledWith('/repos/web');
  });
});
