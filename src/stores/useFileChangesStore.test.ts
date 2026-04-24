import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createFileChangesStore, resolveChangeFilePath } from './useFileChangesStore';
import { toBranchWorktreeKey } from '../services/implementTaskDerivation';

const repoAPath = 'C:/repos/project-a';
const repoBPath = 'C:/repos/project-b';
const repoCPath = 'C:/repos/project-c';
const worktreeAPath = 'C:/worktrees/project-a-feature';
const worktreeBPath = 'C:/worktrees/project-b-feature';
const worktreeKeyA = toBranchWorktreeKey('project-a', 'feature/task-a');
const worktreeKeyB = toBranchWorktreeKey('project-b', 'feature/task-b');
const missingWorktreeKey = toBranchWorktreeKey('project-b', 'feature/task-a');
const repositoryIdA = `project-a::${worktreeKeyA}`;
const repositoryIdB = `project-b::${worktreeKeyB}`;
const changeIdA = `${repositoryIdA}::src/main.ts`;
const changeIdB = `${repositoryIdB}::README.md`;

const makeProject = (id: string, name: string, path: string) => ({
  id,
  name,
  mountName: id,
  path,
  created_at: '2026-04-13T00:00:00.000Z',
  status: 'active' as const,
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
});

const initialOriginalFiles: Record<string, Record<string, string>> = {
  [worktreeAPath]: {
    'src/main.ts': 'const value = 1;\nconsole.log(value);',
    'src/deleted.ts': 'export const removed = true;\n',
  },
  [worktreeBPath]: {
    'README.md': 'Hello',
  },
};

let currentFiles: Record<string, Record<string, string | null>> = {};
let stagedFiles: Record<string, Record<string, string | null>> = {};
let pathsWithEmptyGitDiff = new Set<string>();
let taskStatuses: Record<string, 'Pending' | 'InReview' | 'InProgress' | 'Completed'> = {
  'task-1': 'InProgress',
  'task-2': 'InProgress',
  'task-3': 'InProgress',
  'task-4': 'Pending',
};

const getHeadContent = (repoPath: string, path: string): string | undefined =>
  initialOriginalFiles[repoPath]?.[path];

const getIndexContent = (repoPath: string, path: string): string | undefined => {
  const overrides = stagedFiles[repoPath] ?? {};
  if (Object.prototype.hasOwnProperty.call(overrides, path)) {
    return typeof overrides[path] === 'string' ? overrides[path] ?? undefined : undefined;
  }
  return getHeadContent(repoPath, path);
};

const getWorktreeContent = (repoPath: string, path: string): string | undefined => {
  const overrides = currentFiles[repoPath] ?? {};
  if (Object.prototype.hasOwnProperty.call(overrides, path)) {
    return typeof overrides[path] === 'string' ? overrides[path] ?? undefined : undefined;
  }
  return getIndexContent(repoPath, path);
};

const toStatus = (
  leftContent: string | undefined,
  rightContent: string | undefined,
  whenAdded: string = 'added'
): string | null => {
  if (leftContent === rightContent) {
    return null;
  }
  if (leftContent === undefined && rightContent !== undefined) {
    return whenAdded;
  }
  if (leftContent !== undefined && rightContent === undefined) {
    return 'deleted';
  }
  return 'modified';
};

const getRepositoryPaths = (repoPath: string): string[] => {
  const head = Object.keys(initialOriginalFiles[repoPath] ?? {});
  const index = Object.keys(stagedFiles[repoPath] ?? {});
  const worktree = Object.keys(currentFiles[repoPath] ?? {});
  return Array.from(new Set([...head, ...index, ...worktree])).sort((left, right) => left.localeCompare(right));
};

const buildPatch = (repoPath: string, path: string): string => {
  const original = getHeadContent(repoPath, path) ?? '';
  const modified = getWorktreeContent(repoPath, path) ?? '';
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');
  const patchLines = [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${originalLines.length} +1,${modifiedLines.length} @@`,
  ];

  const maxLines = Math.max(originalLines.length, modifiedLines.length);
  for (let index = 0; index < maxLines; index += 1) {
    const originalLine = originalLines[index];
    const modifiedLine = modifiedLines[index];

    if (originalLine === modifiedLine) {
      patchLines.push(` ${originalLine ?? ''}`);
      continue;
    }

    if (originalLine !== undefined) {
      patchLines.push(`-${originalLine}`);
    }

    if (modifiedLine !== undefined) {
      patchLines.push(`+${modifiedLine}`);
    }
  }

  return patchLines.join('\n');
};

const buildGitStatus = (repoPath: string) => {
  const paths = getRepositoryPaths(repoPath);
  const staged = paths.flatMap((path) => {
    const status = toStatus(getHeadContent(repoPath, path), getIndexContent(repoPath, path));
    return status ? [{ path, status }] : [];
  });
  const unstaged = paths.flatMap((path) => {
    const indexContent = getIndexContent(repoPath, path);
    const worktreeContent = getWorktreeContent(repoPath, path);
    const status = toStatus(indexContent, worktreeContent);
    if (!status || status === 'added') {
      return [];
    }
    return [{ path, status }];
  });
  const untracked = paths.flatMap((path) => {
    const indexContent = getIndexContent(repoPath, path);
    const worktreeContent = getWorktreeContent(repoPath, path);
    return indexContent === undefined && worktreeContent !== undefined
      ? [{ path, status: 'untracked' }]
      : [];
  });
  const changes = [...staged, ...unstaged, ...untracked];

  if (repoPath === worktreeAPath) {
    return {
      branch: 'feature/task-a',
      head_commit: null,
      staged_files: staged,
      unstaged_files: unstaged,
      untracked_files: untracked,
      conflicted_files: [],
      conflictedFiles: [],
      merge_in_progress: false,
      mergeInProgress: false,
      is_clean: changes.length === 0,
    };
  }

  if (repoPath === worktreeBPath) {
    return {
      branch: 'feature/task-b',
      head_commit: null,
      staged_files: staged,
      unstaged_files: unstaged,
      untracked_files: untracked,
      conflicted_files: [],
      conflictedFiles: [],
      merge_in_progress: false,
      mergeInProgress: false,
      is_clean: changes.length === 0,
    };
  }

  return {
    branch: 'develop',
    head_commit: null,
    staged_files: [],
    unstaged_files: [],
    untracked_files: [],
    conflicted_files: [],
    conflictedFiles: [],
    merge_in_progress: false,
    mergeInProgress: false,
    is_clean: true,
  };
};

const gitStatusMock = mock(async (repoPath: string) => buildGitStatus(repoPath));

const gitDiffMock = mock(async ({ repoPath, paths }: { repoPath: string; paths?: string[] }) => {
  const path = paths?.[0] || '';
  if (pathsWithEmptyGitDiff.has(`${repoPath}::${path}`)) {
    return '';
  }
  return buildPatch(repoPath, paths?.[0] || '');
});

const gitReadFilePairMock = mock(async ({ repoPath, path }: { repoPath: string; path: string }) => {
  const headContent = getHeadContent(repoPath, path);
  const indexContent = getIndexContent(repoPath, path);
  const worktreeContent = getWorktreeContent(repoPath, path);
  return {
    headExists: headContent !== undefined,
    headContent: headContent ?? '',
    indexExists: indexContent !== undefined,
    indexContent: indexContent ?? '',
    worktreeExists: worktreeContent !== undefined,
    worktreeContent: worktreeContent ?? '',
    originalContent: headContent ?? '',
    modifiedContent: worktreeContent ?? '',
  };
});

const fsWriteFileMock = mock(async ({ path, content }: { path: string; content: string }) => {
  const normalized = path.replace(/\\/g, '/');
  const isWorktreeA = normalized.startsWith(`${worktreeAPath}/`);
  const base = isWorktreeA ? worktreeAPath : worktreeBPath;
  const relative = normalized.slice(base.length + 1);
  currentFiles[base] ||= {};
  currentFiles[base][relative] = content;
  return {
    path: normalized,
    bytes_written: content.length,
    created: false,
    skipped: false,
  };
});

const gitRestorePathsMock = mock(async ({
  repoPath,
  paths,
  target,
}: {
  repoPath: string;
  paths: string[];
  target?: 'worktree' | 'staged_and_worktree';
}) => {
  currentFiles[repoPath] ||= {};
  stagedFiles[repoPath] ||= {};
  for (const path of paths) {
    if (target === 'staged_and_worktree') {
      delete stagedFiles[repoPath][path];
    }
    delete currentFiles[repoPath][path];
  }
});

const gitAddMock = mock(async ({ repoPath, paths }: { repoPath: string; paths: string[] }) => {
  stagedFiles[repoPath] ||= {};
  currentFiles[repoPath] ||= {};
  for (const path of paths) {
    const headContent = getHeadContent(repoPath, path);
    const worktreeContent = getWorktreeContent(repoPath, path);
    if (worktreeContent === headContent) {
      delete stagedFiles[repoPath][path];
    } else {
      stagedFiles[repoPath][path] = worktreeContent ?? null;
    }
    delete currentFiles[repoPath][path];
  }
});
const commitRepository = async ({ repoPath }: { repoPath: string }) => {
  stagedFiles[repoPath] = {};
  return repoPath === worktreeAPath ? 'hash-a' : 'hash-b';
};

const buildGeneratedCommitMessages = async (input: {
  repositories: Array<{ repositoryId: string }>;
}) => ({
  title: 'feat: implement multi repo flow',
  repositories: input.repositories.map((repository) => ({
    repositoryId: repository.repositoryId,
    body: `Update ${repository.repositoryId}.`,
  })),
});

const gitCommitMock = mock(commitRepository);
const generateCommitMessagesMock = mock(buildGeneratedCommitMessages);

const tasksById = {
  'task-1': {
    id: 'task-1',
    title: 'Implement multi repo flow',
    description: 'Test task',
    status: 'InProgress' as const,
    task_source: 'architect' as const,
    project_id: 'project-a',
    project_ids: ['project-a', 'project-b'],
    assigned_branch: 'feature/task-a',
    execution_targets: [
      {
        projectId: 'project-a',
        branchName: 'feature/task-a',
        worktreeKey: worktreeKeyA,
        planBranchName: 'plan/integration',
      },
      {
        projectId: 'project-b',
        branchName: 'feature/task-b',
        worktreeKey: worktreeKeyB,
        planBranchName: 'plan/integration',
      },
    ],
  },
  'task-2': {
    id: 'task-2',
    title: 'Follow-up review task',
    description: 'Second task',
    status: 'InProgress' as const,
    task_source: 'architect' as const,
    project_id: 'project-a',
    project_ids: ['project-a', 'project-b'],
    assigned_branch: 'feature/task-a',
    execution_targets: [
      {
        projectId: 'project-a',
        branchName: 'feature/task-a',
        worktreeKey: worktreeKeyA,
        planBranchName: 'plan/integration',
      },
      {
        projectId: 'project-b',
        branchName: 'feature/task-b',
        worktreeKey: worktreeKeyB,
        planBranchName: 'plan/integration',
      },
    ],
  },
  'task-3': {
    id: 'task-3',
    title: 'Same branch without dedicated worktree',
    description: 'Missing worktree mapping',
    status: 'InProgress' as const,
    task_source: 'architect' as const,
    project_id: 'project-b',
    project_ids: ['project-b'],
    assigned_branch: 'feature/task-a',
    execution_targets: [
      {
        projectId: 'project-b',
        branchName: 'feature/task-a',
        worktreeKey: missingWorktreeKey,
        planBranchName: 'plan/integration',
      },
    ],
  },
  'task-4': {
    id: 'task-4',
    title: 'Integrate GCC Compiler',
    description: 'Pending task without worktree yet',
    status: 'Pending' as const,
    task_source: 'architect' as const,
    project_id: 'project-b',
    project_ids: ['project-b'],
    assigned_branch: 'feature/task-a',
    execution_targets: [
      {
        projectId: 'project-b',
        branchName: 'feature/task-a',
        worktreeKey: missingWorktreeKey,
        planBranchName: 'plan/integration',
      },
    ],
  },
  'task-5': {
    id: 'task-5',
    title: 'Standalone release merge',
    description: 'Standalone task with a repo-specific target branch',
    status: 'InProgress' as const,
    task_source: 'standalone' as const,
    project_id: 'project-a',
    project_ids: ['project-a'],
    assigned_branch: 'feature/task-a',
    base_branch: 'develop',
    execution_targets: [
      {
        projectId: 'project-a',
        branchName: 'feature/task-a',
        targetBranchName: 'release/project-a',
        worktreeKey: worktreeKeyA,
      },
    ],
  },
};

const setTaskStatusMock = mock(async (taskId: string, status: string) => {
  if (taskId in taskStatuses) {
    taskStatuses[taskId] = status as typeof taskStatuses[string];
  }
});

const taskStoreState = {
  activeRepositoryPath: worktreeAPath,
  activeBranchName: 'feature/task-a',
  branchWorktrees: {
    [worktreeKeyA]: worktreeAPath,
    [worktreeKeyB]: worktreeBPath,
  },
  getTaskById: (taskId: string) => {
    const task = tasksById[taskId as keyof typeof tasksById];
    if (!task) return undefined;
    return { ...task, status: taskStatuses[taskId] ?? task.status };
  },
  setTaskStatus: setTaskStatusMock,
  completeTask: async () => undefined,
};

const appStoreState = {
  selectedProjectId: null as string | null,
  selectedGroupId: 'group-1' as string | null,
  selectedTaskId: 'task-1' as string | null,
  projectGroups: [
    {
      id: 'group-1',
      name: 'Group 1',
      isOpen: true,
      projects: [
        makeProject('project-a', 'Project A', repoAPath),
        makeProject('project-b', 'Project B', repoBPath),
      ],
    },
    {
      id: 'group-2',
      name: 'Group 2',
      isOpen: true,
      projects: [
        makeProject('project-c', 'Project C', repoCPath),
      ],
    },
  ],
  getProjectById: (projectId: string) => {
    if (projectId === 'project-a') return { id: 'project-a', name: 'Project A', path: repoAPath };
    if (projectId === 'project-b') return { id: 'project-b', name: 'Project B', path: repoBPath };
    if (projectId === 'project-c') return { id: 'project-c', name: 'Project C', path: repoCPath };
    return undefined;
  },
};

let useFileChangesStore: ReturnType<typeof createFileChangesStore>;

describe('useFileChangesStore', () => {
  beforeEach(() => {
    currentFiles = {
      [worktreeAPath]: {
        'src/main.ts': 'const value = 2;\nconsole.log(value);',
      },
      [worktreeBPath]: {
        'README.md': 'Hello\nupdated',
      },
    };
    stagedFiles = {
      [worktreeAPath]: {},
      [worktreeBPath]: {},
    };
    taskStatuses = {
      'task-1': 'InProgress',
      'task-2': 'InProgress',
      'task-3': 'InProgress',
      'task-4': 'Pending',
      'task-5': 'InProgress',
    };
    pathsWithEmptyGitDiff = new Set();
    appStoreState.selectedGroupId = 'group-1';
    appStoreState.selectedProjectId = null;
    appStoreState.selectedTaskId = 'task-1';

    gitStatusMock.mockClear();
    gitDiffMock.mockClear();
    gitReadFilePairMock.mockClear();
    fsWriteFileMock.mockClear();
    gitRestorePathsMock.mockClear();
    gitAddMock.mockClear();
    gitCommitMock.mockClear();
    gitCommitMock.mockImplementation(commitRepository);
    generateCommitMessagesMock.mockClear();
    generateCommitMessagesMock.mockImplementation(buildGeneratedCommitMessages);
    setTaskStatusMock.mockClear();

    useFileChangesStore = createFileChangesStore({
      tauri: {
        isTauriAvailable: () => true,
        gitStatus: gitStatusMock,
        gitDiff: gitDiffMock,
        gitReadFilePair: gitReadFilePairMock,
        fsWriteFile: fsWriteFileMock,
        gitRestorePaths: gitRestorePathsMock,
        gitAdd: gitAddMock,
        gitCommit: gitCommitMock,
      },
      getGitFlowBaseBranch: () => 'develop',
      getAppState: () => appStoreState,
      getTaskState: () => taskStoreState,
      setTaskState: () => undefined,
      generateCommitMessages: generateCommitMessagesMock,
    });

    useFileChangesStore.getState().resetReviewState();
  });

  it('builds absolute file paths with normalized separators', () => {
    expect(resolveChangeFilePath('C:\\repos\\macro\\', 'src\\main.ts')).toBe('C:/repos/macro/src/main.ts');
  });

  it('loads one review repository per execution target', async () => {
    await useFileChangesStore.getState().loadCurrentChanges();

    const { repositories, reviewSummary } = useFileChangesStore.getState();
    expect(repositories).toHaveLength(2);
    expect(repositories.map((repository: { projectId: string }) => repository.projectId)).toEqual(['project-a', 'project-b']);
    expect(
      repositories.map((repository: { stats: { pendingVisibleFileCount: number } }) =>
        repository.stats.pendingVisibleFileCount
      )
    ).toEqual([1, 1]);
    expect(reviewSummary.repositoryCount).toBe(2);
    expect(reviewSummary.nextAction).toBe('validate_repository');
    expect(reviewSummary.currentRepositoryId).toBe(repositoryIdA);
  });

  it('uses the execution target branch as the standalone integration branch', async () => {
    appStoreState.selectedTaskId = 'task-5';

    await useFileChangesStore.getState().loadCurrentChanges();

    const repository = useFileChangesStore.getState().getRepository(repositoryIdA);
    expect(repository?.planBranchName).toBe('release/project-a');
  });

  it('narrows loaded repositories to the selected subproject scope', async () => {
    appStoreState.selectedProjectId = 'project-b';

    await useFileChangesStore.getState().loadCurrentChanges();

    const { repositories, reviewSummary, selectedRepositoryId } = useFileChangesStore.getState();
    expect(repositories).toHaveLength(1);
    expect(repositories[0]?.projectId).toBe('project-b');
    expect(reviewSummary.repositoryCount).toBe(1);
    expect(selectedRepositoryId).toBe(repositoryIdB);
    expect(gitStatusMock.mock.calls.map((call) => call[0])).toEqual([worktreeBPath]);
  });

  it('marks the task as out of scope when the selected global project has no matching repositories', async () => {
    appStoreState.selectedGroupId = 'group-2';

    await useFileChangesStore.getState().loadCurrentChanges();

    const nextState = useFileChangesStore.getState();
    expect(nextState.currentTaskId).toBe('task-1');
    expect(nextState.currentTaskLoadState).toBe('out_of_scope');
    expect(nextState.currentTaskLoadMessage).toBe('This task has no changes in Group 2.');
    expect(nextState.repositories).toHaveLength(0);
    expect(nextState.reviewSummary.repositoryCount).toBe(0);
    expect(gitStatusMock).not.toHaveBeenCalled();
  });

  it('recomputes the scoped repository selection when the focused subproject changes on the same task', async () => {
    appStoreState.selectedProjectId = 'project-a';
    const store = useFileChangesStore.getState();

    await store.loadCurrentChanges();
    expect(useFileChangesStore.getState().selectedRepositoryId).toBe(repositoryIdA);

    appStoreState.selectedProjectId = 'project-b';
    await store.loadCurrentChanges();

    const nextState = useFileChangesStore.getState();
    expect(nextState.currentTaskId).toBe('task-1');
    expect(nextState.repositories).toHaveLength(1);
    expect(nextState.repositories[0]?.projectId).toBe('project-b');
    expect(nextState.selectedRepositoryId).toBe(repositoryIdB);
    expect(nextState.reviewSummary.currentRepositoryId).toBe(repositoryIdB);
  });

  it('reads repository changes from the task worktrees and reloads external edits', async () => {
    const store = useFileChangesStore.getState();

    await store.loadCurrentChanges();

    expect(gitStatusMock.mock.calls.map((call) => call[0])).toEqual([worktreeAPath, worktreeBPath]);
    expect(gitStatusMock.mock.calls.map((call) => call[0])).not.toContain(repoAPath);
    expect(gitStatusMock.mock.calls.map((call) => call[0])).not.toContain(repoBPath);

    currentFiles[worktreeAPath]['src/main.ts'] = 'const value = 3;\nconsole.log(value);';

    await store.loadCurrentChanges();

    const refreshedRepository = useFileChangesStore.getState().getRepository(repositoryIdA);
    expect(refreshedRepository?.worktreePath).toBe(worktreeAPath);
    expect(refreshedRepository?.changes[0]?.modifiedContent).toContain('const value = 3;');
  });

  it('builds a synthetic textual diff for untracked created files when git diff is empty', async () => {
    currentFiles[worktreeAPath]['src/new.ts'] = 'export const created = true;\n';
    pathsWithEmptyGitDiff.add(`${worktreeAPath}::src/new.ts`);
    const store = useFileChangesStore.getState();

    await store.loadCurrentChanges();

    const repository = useFileChangesStore.getState().getRepository(repositoryIdA);
    const newChange = repository?.changes.find((change) => change.path === 'src/new.ts');

    expect(newChange?.status).toBe('added');
    expect(newChange?.modifiedContent).toBe('export const created = true;\n');
    expect(newChange?.additions).toBeGreaterThan(0);
    expect(newChange?.deletions).toBe(0);
    expect(newChange?.hunks).toHaveLength(1);
    expect(newChange?.hunks[0]?.lines.every((line) => line.type === 'added')).toBe(true);
    expect(gitReadFilePairMock).toHaveBeenCalledWith({
      repoPath: worktreeAPath,
      path: 'src/new.ts',
    });
  });

  it('builds a synthetic textual diff for deleted files when git diff is empty', async () => {
    currentFiles[worktreeAPath]['src/deleted.ts'] = null;
    pathsWithEmptyGitDiff.add(`${worktreeAPath}::src/deleted.ts`);
    const store = useFileChangesStore.getState();

    await store.loadCurrentChanges();

    const repository = useFileChangesStore.getState().getRepository(repositoryIdA);
    const deletedChange = repository?.changes.find((change) => change.path === 'src/deleted.ts');

    expect(deletedChange?.status).toBe('deleted');
    expect(deletedChange?.originalContent).toBe('export const removed = true;\n');
    expect(deletedChange?.additions).toBe(0);
    expect(deletedChange?.deletions).toBeGreaterThan(0);
    expect(deletedChange?.hunks).toHaveLength(1);
    expect(deletedChange?.hunks[0]?.lines.every((line) => line.type === 'removed')).toBe(true);
    expect(gitReadFilePairMock).toHaveBeenCalledWith({
      repoPath: worktreeAPath,
      path: 'src/deleted.ts',
    });
  });

  it('keeps the current repository list visible during silent refreshes', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    let releaseStatuses: () => void = () => undefined;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatuses = resolve;
    });

    gitStatusMock.mockImplementation(async (repoPath: string) => {
      await statusGate;
      return buildGitStatus(repoPath);
    });

    const silentRefresh = store.loadCurrentChanges({ silent: true });

    const stateWhileRefreshing = useFileChangesStore.getState();
    expect(stateWhileRefreshing.currentTaskLoadState).toBe('ready');
    expect(stateWhileRefreshing.isLoading).toBe(false);
    expect(stateWhileRefreshing.repositories).toHaveLength(2);

    releaseStatuses();
    await silentRefresh;
  });

  it('clears stale diff state when switching to another task', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    store.openDiffModal(repositoryIdA, changeIdA);
    await Promise.resolve();
    expect(useFileChangesStore.getState().selectedDiffTarget).toEqual({
      repositoryId: repositoryIdA,
      changeId: changeIdA,
    });
    expect(useFileChangesStore.getState().isDiffModalOpen).toBe(true);

    appStoreState.selectedTaskId = 'task-2';
    await useFileChangesStore.getState().loadCurrentChanges();

    const nextState = useFileChangesStore.getState();
    expect(nextState.currentTaskId).toBe('task-2');
    expect(nextState.currentTaskLoadState).toBe('ready');
    expect(nextState.selectedDiffTarget).toBeNull();
    expect(nextState.diffModalSession).toBeNull();
    expect(nextState.isDiffModalOpen).toBe(false);
  });

  it('creates an independent right-side draft session when opening the diff modal', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    store.openDiffModal(repositoryIdA, changeIdA);
    await Promise.resolve();
    await Promise.resolve();

    const session = useFileChangesStore.getState().getDiffModalSession();
    expect(session).not.toBeNull();
    expect(session?.repositoryId).toBe(repositoryIdA);
    expect(session?.changeId).toBe(changeIdA);
    expect(session?.originalContent).toContain('const value = 1;');
    expect(session?.rightDraftContent).toContain('const value = 2;');
    expect(session?.isDirty).toBe(false);

    store.updateRightDraft('const value = 42;\nconsole.log(value);');

    const updatedSession = useFileChangesStore.getState().getDiffModalSession();
    expect(updatedSession?.rightDraftContent).toContain('const value = 42;');
    expect(updatedSession?.isDirty).toBe(true);
    expect(useFileChangesStore.getState().getChange(repositoryIdA, changeIdA)?.modifiedContent).toContain('const value = 2;');
  });

  it('opens the diff modal with full file hydration while keeping focused as the initial presentation mode', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();
    const initialGitDiffCalls = gitDiffMock.mock.calls.length;

    store.openDiffModal(repositoryIdA, changeIdA);
    await Promise.resolve();
    await Promise.resolve();

    const session = useFileChangesStore.getState().getDiffModalSession();
    const change = useFileChangesStore.getState().getChange(repositoryIdA, changeIdA);

    expect(session?.isHydratingFullContext).toBe(false);
    expect(change?.contextMode).toBe('focused');
    expect(session?.originalContent).toContain('const value = 1;');
    expect(gitReadFilePairMock).toHaveBeenCalledWith({
      repoPath: worktreeAPath,
      path: 'src/main.ts',
    });
    expect(gitDiffMock.mock.calls.length).toBe(initialGitDiffCalls);
  });

  it('resets only the right-side draft content', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    store.openDiffModal(repositoryIdA, changeIdA);
    await Promise.resolve();
    await Promise.resolve();
    store.updateRightDraft('const value = 7;\nconsole.log(value);');

    expect(useFileChangesStore.getState().getDiffModalSession()?.isDirty).toBe(true);

    store.resetRightDraft();

    const session = useFileChangesStore.getState().getDiffModalSession();
    expect(session?.isDirty).toBe(false);
    expect(session?.rightDraftContent).toContain('const value = 2;');
  });

  it('saves the right-side draft, reloads the diff, and keeps the file pending', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    await store.stageChanges(repositoryIdA, [changeIdA]);
    currentFiles[worktreeAPath]['src/main.ts'] = 'const value = 8;\nconsole.log(value);';
    await store.loadCurrentChanges();
    store.openDiffModal(repositoryIdA, changeIdA);
    await Promise.resolve();
    await Promise.resolve();
    store.updateRightDraft('const value = 9;\nconsole.log(value);');

    await store.saveRightDraft();

    const session = useFileChangesStore.getState().getDiffModalSession();
    const change = useFileChangesStore.getState().getChange(repositoryIdA, changeIdA);
    const repository = useFileChangesStore.getState().getRepository(repositoryIdA);
    expect(fsWriteFileMock).toHaveBeenCalledTimes(1);
    expect(session?.isDirty).toBe(false);
    expect(session?.rightDraftContent).toContain('const value = 9;');
    expect(change?.modifiedContent).toContain('const value = 9;');
    expect(repository?.stats.pendingVisibleFileCount).toBe(1);
  });

  it('stages visible changes in batch for a repository scope', async () => {
    currentFiles[worktreeAPath]['src/new.ts'] = 'export const created = true;\n';
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    const repository = useFileChangesStore.getState().getRepository(repositoryIdA);
    const changeIds = repository?.changes.map((change) => change.id) ?? [];
    expect(changeIds).toHaveLength(2);

    await store.stageChanges(repositoryIdA, changeIds);

    const updatedRepository = useFileChangesStore.getState().getRepository(repositoryIdA);
    expect(updatedRepository?.stats.validatedStagedFileCount).toBe(2);
    expect(updatedRepository?.changes).toHaveLength(0);
  });

  it('reverts modified, added, and deleted files then reloads the repository state', async () => {
    currentFiles[worktreeAPath]['src/new.ts'] = 'export const created = true;\n';
    currentFiles[worktreeAPath]['src/deleted.ts'] = null;
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    const repository = useFileChangesStore.getState().getRepository(repositoryIdA);
    expect(repository?.changes.map((change) => change.path)).toEqual([
      'src/deleted.ts',
      'src/main.ts',
      'src/new.ts',
    ]);

    await store.revertChanges(
      repositoryIdA,
      repository?.changes.map((change) => change.id) ?? []
    );

    expect(gitRestorePathsMock).toHaveBeenCalledTimes(1);
    expect(gitRestorePathsMock).toHaveBeenCalledWith({
      repoPath: worktreeAPath,
      paths: ['src/deleted.ts', 'src/main.ts', 'src/new.ts'],
      target: 'worktree',
    });

    const refreshedRepository = useFileChangesStore.getState().getRepository(repositoryIdA);
    expect(refreshedRepository?.changes).toHaveLength(0);
    expect(useFileChangesStore.getState().reviewSummary.stateCounts.no_changes).toBe(1);
  });

  it('opens the next file in the diff modal when reverting the currently opened file', async () => {
    currentFiles[worktreeAPath]['src/new.ts'] = 'export const created = true;\n';
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    const repository = useFileChangesStore.getState().getRepository(repositoryIdA);
    const mainChange = repository?.changes.find((change) => change.path === 'src/main.ts');
    const newChange = repository?.changes.find((change) => change.path === 'src/new.ts');
    expect(mainChange).toBeDefined();
    expect(newChange).toBeDefined();

    store.openDiffModal(repositoryIdA, mainChange!.id);
    await Promise.resolve();

    await store.revertChanges(repositoryIdA, [mainChange!.id]);

    const selectedTarget = useFileChangesStore.getState().getSelectedDiffTarget();
    expect(selectedTarget).toEqual({
      repositoryId: repositoryIdA,
      changeId: newChange!.id,
    });
  });

  it('does not reuse the active repository path when the dedicated worktree mapping is missing', async () => {
    appStoreState.selectedTaskId = 'task-3';

    await useFileChangesStore.getState().loadCurrentChanges();

    const nextState = useFileChangesStore.getState();
    expect(nextState.currentTaskId).toBe('task-3');
    expect(nextState.currentTaskLoadState).toBe('invalid_mapping');
    expect(nextState.currentTaskLoadMessage).toBe('Make your first changes to this task to see them here.');
    expect(nextState.currentTaskLoadMessage?.toLowerCase()).not.toContain('worktree');
    expect(nextState.repositories).toHaveLength(0);
    expect(gitStatusMock).not.toHaveBeenCalled();
  });

  it('shows an awaiting-worktree state for a pending task that has not started yet', async () => {
    appStoreState.selectedTaskId = 'task-4';

    await useFileChangesStore.getState().loadCurrentChanges();

    const nextState = useFileChangesStore.getState();
    expect(nextState.currentTaskId).toBe('task-4');
    expect(nextState.currentTaskLoadState).toBe('awaiting_worktree');
    expect(nextState.currentTaskLoadMessage).toBe('Make your first changes to this task to see them here.');
    expect(nextState.currentTaskLoadMessage?.toLowerCase()).not.toContain('worktree');
    expect(nextState.repositories).toHaveLength(0);
    expect(gitStatusMock).not.toHaveBeenCalled();
  });

  it('ignores stale async results when a newer task selection has already won', async () => {
    let releaseTaskOneStatuses: () => void = () => undefined;
    const taskOneStatusGate = new Promise<void>((resolve) => {
      releaseTaskOneStatuses = resolve;
    });

    gitStatusMock.mockImplementation(async (repoPath: string) => {
      if (appStoreState.selectedTaskId === 'task-1') {
        await taskOneStatusGate;
      }
      return buildGitStatus(repoPath);
    });

    const firstLoad = useFileChangesStore.getState().loadCurrentChanges();
    expect(useFileChangesStore.getState().currentTaskId).toBe('task-1');
    expect(useFileChangesStore.getState().currentTaskLoadState).toBe('loading');
    expect(useFileChangesStore.getState().repositories).toHaveLength(0);

    appStoreState.selectedTaskId = 'task-3';
    await useFileChangesStore.getState().loadCurrentChanges();

    let state = useFileChangesStore.getState();
    expect(state.currentTaskId).toBe('task-3');
    expect(state.currentTaskLoadState).toBe('invalid_mapping');
    expect(state.repositories).toHaveLength(0);

    releaseTaskOneStatuses();
    await firstLoad;

    state = useFileChangesStore.getState();
    expect(state.currentTaskId).toBe('task-3');
    expect(state.currentTaskLoadState).toBe('invalid_mapping');
    expect(state.repositories).toHaveLength(0);
  });

  it('keeps the task in progress after repository commits complete', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    await store.stageChanges(repositoryIdA, [changeIdA]);
    await store.stageChanges(repositoryIdB, [changeIdB]);

    const firstCommit = await store.commitStagedChanges(
      repositoryIdA,
      'feat: commit project a'
    );
    expect(firstCommit.taskCompleted).toBe(false);
    expect(firstCommit.taskStatus).toBe('InProgress');
    expect(setTaskStatusMock).not.toHaveBeenCalled();
    expect(useFileChangesStore.getState().selectedRepositoryId).toBe(repositoryIdB);
    expect(useFileChangesStore.getState().reviewSummary.hasCommittedRepositories).toBe(true);
    expect(useFileChangesStore.getState().reviewSummary.currentRepositoryId).toBe(repositoryIdB);

    const secondCommit = await store.commitStagedChanges(
      repositoryIdB,
      'feat: commit project b'
    );
    expect(secondCommit.taskCompleted).toBe(false);
    expect(secondCommit.taskStatus).toBe('InProgress');
    expect(setTaskStatusMock).not.toHaveBeenCalled();
  });

  it('validates pending changes across all task repositories', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    await store.stageAllTaskChanges();

    expect(gitAddMock).toHaveBeenCalledWith({
      repoPath: worktreeAPath,
      paths: ['src/main.ts'],
    });
    expect(gitAddMock).toHaveBeenCalledWith({
      repoPath: worktreeBPath,
      paths: ['README.md'],
    });
    expect(useFileChangesStore.getState().reviewSummary.actionCounts.pending_validation).toBe(0);
    expect(useFileChangesStore.getState().reviewSummary.actionCounts.ready_to_commit).toBe(2);
  });

  it('commits all ready task repositories with one logical action', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();
    await store.stageAllTaskChanges();

    const result = await store.commitAllReadyTaskRepositories();

    expect(result.commits).toHaveLength(2);
    expect(result.commits.map((commit) => commit.committedRepositoryId)).toEqual([
      repositoryIdA,
      repositoryIdB,
    ]);
    expect(gitCommitMock).toHaveBeenCalledTimes(2);
    expect(gitCommitMock).toHaveBeenCalledWith({
      repoPath: worktreeAPath,
      message: `feat: implement multi repo flow\n\nUpdate ${repositoryIdA}.`,
      stageAll: false,
    });
    expect(gitCommitMock).toHaveBeenCalledWith({
      repoPath: worktreeBPath,
      message: `feat: implement multi repo flow\n\nUpdate ${repositoryIdB}.`,
      stageAll: false,
    });
    expect(generateCommitMessagesMock).toHaveBeenCalledTimes(1);
    expect(useFileChangesStore.getState().executionRecords[repositoryIdA]?.projectId).toBe('project-a');
    expect(useFileChangesStore.getState().executionRecords[repositoryIdB]?.projectId).toBe('project-b');
    expect(setTaskStatusMock).not.toHaveBeenCalled();
  });

  it('keeps successful commits when a later repository commit fails', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();
    await store.stageAllTaskChanges();

    gitCommitMock.mockImplementationOnce(async ({ repoPath }: { repoPath: string }) => {
      stagedFiles[repoPath] = {};
      return 'hash-a';
    });
    gitCommitMock.mockImplementationOnce(async () => {
      throw new Error('Commit rejected');
    });

    await expect(
      store.commitAllReadyTaskRepositories()
    ).rejects.toThrow('project-b: Commit rejected');

    const nextState = useFileChangesStore.getState();
    expect(nextState.executionRecords[repositoryIdA]?.projectId).toBe('project-a');
    expect(nextState.executionRecords[repositoryIdB]).toBeUndefined();
    expect(nextState.getRepository(repositoryIdB)?.lastError).toBe('Commit rejected');
  });

  it('retries generated commit messages before creating commits', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();
    await store.stageAllTaskChanges();

    generateCommitMessagesMock.mockImplementationOnce(async () => {
      throw new Error('invalid json');
    });
    generateCommitMessagesMock.mockImplementationOnce(async () => {
      throw new Error('missing repo');
    });
    generateCommitMessagesMock.mockImplementationOnce(async (input: {
      repositories: Array<{ repositoryId: string }>;
    }) => ({
      title: 'feat: recover generated messages',
      repositories: input.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        body: `Recovered ${repository.repositoryId}.`,
      })),
    }));

    const result = await store.commitAllReadyTaskRepositories();

    expect(result.commits).toHaveLength(2);
    expect(generateCommitMessagesMock).toHaveBeenCalledTimes(3);
    expect(gitCommitMock).toHaveBeenCalledTimes(2);
  });

  it('does not create commits when generated commit messages keep failing', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();
    await store.stageAllTaskChanges();

    generateCommitMessagesMock.mockImplementation(async () => {
      throw new Error('model unavailable');
    });

    await expect(store.commitAllReadyTaskRepositories()).rejects.toThrow('model unavailable');

    expect(generateCommitMessagesMock).toHaveBeenCalledTimes(3);
    expect(gitCommitMock).not.toHaveBeenCalled();
    expect(useFileChangesStore.getState().lastError).toBeNull();
  });

  it('does not change the task status when only the focused subproject is resolved', async () => {
    appStoreState.selectedProjectId = 'project-a';
    const store = useFileChangesStore.getState();

    await store.loadCurrentChanges();
    await store.stageChanges(repositoryIdA, [changeIdA]);

    const result = await store.commitStagedChanges(
      repositoryIdA,
      'feat: commit project a'
    );

    expect(result.taskStatus).toBe('InProgress');
    expect(setTaskStatusMock).not.toHaveBeenCalled();
  });

  it('shows new unstaged changes again after a file was already validated', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    await store.stageChanges(repositoryIdA, [changeIdA]);
    expect(useFileChangesStore.getState().reviewSummary.actionCounts.ready_to_commit).toBe(1);

    currentFiles[worktreeAPath]['src/main.ts'] = 'const value = 4;\nconsole.log(value);';
    await store.loadCurrentChanges();

    const repository = useFileChangesStore.getState().getRepository(repositoryIdA);
    expect(repository?.changes[0]?.hasValidatedStage).toBe(true);
    expect(repository?.stats.validatedStagedFileCount).toBe(1);
    expect(useFileChangesStore.getState().reviewSummary.actionCounts.pending_validation).toBe(2);

    const commitResult = await store.commitStagedChanges(repositoryIdA, 'feat: commit project a');
    expect(commitResult.hash).toBe('hash-a');
  });

  it('stores the normalized backend message when commit fails with an object payload', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();
    await store.stageChanges(repositoryIdA, [changeIdA]);

    gitCommitMock.mockImplementationOnce(async () => {
      throw { message: 'Backend exploded' };
    });

    await expect(
      store.commitStagedChanges(repositoryIdA, 'feat: commit project a')
    ).rejects.toEqual({ message: 'Backend exploded' });

    const nextState = useFileChangesStore.getState();
    expect(nextState.lastError).toBe('Backend exploded');
    expect(nextState.getRepository(repositoryIdA)?.lastError).toBe('Backend exploded');
  });
});
