import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createFileChangesStore, resolveChangeFilePath } from './useFileChangesStore';
import { toBranchWorktreeKey } from '../services/implementTaskDerivation';

const repoAPath = 'C:/repos/project-a';
const repoBPath = 'C:/repos/project-b';
const worktreeAPath = 'C:/worktrees/project-a-feature';
const worktreeBPath = 'C:/worktrees/project-b-feature';
const worktreeKeyA = toBranchWorktreeKey('project-a', 'feature/task-a');
const worktreeKeyB = toBranchWorktreeKey('project-b', 'feature/task-b');
const missingWorktreeKey = toBranchWorktreeKey('project-b', 'feature/task-a');
const repositoryIdA = `project-a::${worktreeKeyA}`;
const repositoryIdB = `project-b::${worktreeKeyB}`;
const changeIdA = `${repositoryIdA}::src/main.ts`;
const changeIdB = `${repositoryIdB}::README.md`;

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
let taskStatuses: Record<string, 'Pending' | 'InReview' | 'InProgress' | 'Completed'> = {
  'task-1': 'InReview',
  'task-2': 'InReview',
  'task-3': 'InReview',
  'task-4': 'Pending',
};

const getChangedFiles = (repoPath: string): Array<{ path: string; status: string }> => {
  const original = initialOriginalFiles[repoPath] ?? {};
  const current = currentFiles[repoPath] ?? {};
  const paths = new Set([...Object.keys(original), ...Object.keys(current)]);
  const changes: Array<{ path: string; status: string }> = [];

  for (const path of paths) {
    const hasOverride = Object.prototype.hasOwnProperty.call(current, path);
    if (!hasOverride) {
      continue;
    }

    const originalValue = original[path];
    const currentValue = current[path];

    if (originalValue === undefined && typeof currentValue === 'string') {
      changes.push({ path, status: 'untracked' });
      continue;
    }

    if (originalValue !== undefined && currentValue === null) {
      changes.push({ path, status: 'deleted' });
      continue;
    }

    if (originalValue !== undefined && typeof currentValue === 'string' && originalValue !== currentValue) {
      changes.push({ path, status: 'modified' });
    }
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path));
};

const buildPatch = (repoPath: string, path: string): string => {
  const original = initialOriginalFiles[repoPath]?.[path] ?? '';
  const override = currentFiles[repoPath]?.[path];
  const modified = override === null ? '' : override ?? original;
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
  const changes = getChangedFiles(repoPath);

  if (repoPath === worktreeAPath) {
    return {
      branch: 'feature/task-a',
      head_commit: null,
      staged_files: [],
      unstaged_files: changes.filter((change) => change.status !== 'untracked'),
      untracked_files: changes.filter((change) => change.status === 'untracked'),
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
      staged_files: [],
      unstaged_files: changes.filter((change) => change.status !== 'untracked'),
      untracked_files: changes.filter((change) => change.status === 'untracked'),
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
  return buildPatch(repoPath, paths?.[0] || '');
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
  };
});

const gitRestorePathsMock = mock(async ({ repoPath, paths }: { repoPath: string; paths: string[] }) => {
  currentFiles[repoPath] ||= {};
  for (const path of paths) {
    delete currentFiles[repoPath][path];
  }
});

const gitAddMock = mock(async () => undefined);
const gitCommitMock = mock(async ({ repoPath }: { repoPath: string }) => {
  currentFiles[repoPath] = {};
  return repoPath === worktreeAPath ? 'hash-a' : 'hash-b';
});

const tasksById = {
  'task-1': {
    id: 'task-1',
    title: 'Implement multi repo flow',
    description: 'Test task',
    status: 'InReview' as const,
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
    status: 'InReview' as const,
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
    status: 'InReview' as const,
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
  selectedProjectId: null,
  selectedGroupId: 'group-1',
  selectedTaskId: 'task-1',
  projectGroups: [],
  getProjectById: (projectId: string) => {
    if (projectId === 'project-a') return { id: 'project-a', name: 'Project A', path: repoAPath };
    if (projectId === 'project-b') return { id: 'project-b', name: 'Project B', path: repoBPath };
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
    taskStatuses = {
      'task-1': 'InReview',
      'task-2': 'InReview',
      'task-3': 'InReview',
      'task-4': 'Pending',
    };
    appStoreState.selectedTaskId = 'task-1';

    gitStatusMock.mockClear();
    gitDiffMock.mockClear();
    fsWriteFileMock.mockClear();
    gitRestorePathsMock.mockClear();
    gitAddMock.mockClear();
    gitCommitMock.mockClear();
    setTaskStatusMock.mockClear();

    useFileChangesStore = createFileChangesStore({
      tauri: {
        isTauriAvailable: () => true,
        gitStatus: gitStatusMock,
        gitDiff: gitDiffMock,
        fsWriteFile: fsWriteFileMock,
        gitRestorePaths: gitRestorePathsMock,
        gitAdd: gitAddMock,
        gitCommit: gitCommitMock,
      },
      getGitFlowBaseBranch: () => 'develop',
      getAppState: () => appStoreState,
      getTaskState: () => taskStoreState,
      setTaskState: () => undefined,
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
    expect(repositories.map((repository: { stats: { total: number } }) => repository.stats.total)).toEqual([1, 1]);
    expect(reviewSummary.repositoryCount).toBe(2);
    expect(reviewSummary.nextAction).toBe('review_repository');
    expect(reviewSummary.currentRepositoryId).toBe(repositoryIdA);
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

    const session = useFileChangesStore.getState().getDiffModalSession();
    expect(session).not.toBeNull();
    expect(session?.repositoryId).toBe(repositoryIdA);
    expect(session?.changeId).toBe(changeIdA);
    expect(session?.rightDraftContent).toContain('const value = 2;');
    expect(session?.isDirty).toBe(false);

    store.updateRightDraft('const value = 42;\nconsole.log(value);');

    const updatedSession = useFileChangesStore.getState().getDiffModalSession();
    expect(updatedSession?.rightDraftContent).toContain('const value = 42;');
    expect(updatedSession?.isDirty).toBe(true);
    expect(useFileChangesStore.getState().getChange(repositoryIdA, changeIdA)?.modifiedContent).toContain('const value = 2;');
  });

  it('opens the diff modal in focused mode without auto-loading the full file', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();
    const initialGitDiffCalls = gitDiffMock.mock.calls.length;

    store.openDiffModal(repositoryIdA, changeIdA);
    await Promise.resolve();

    const session = useFileChangesStore.getState().getDiffModalSession();
    const change = useFileChangesStore.getState().getChange(repositoryIdA, changeIdA);

    expect(session?.isHydratingFullContext).toBe(false);
    expect(change?.contextMode).toBe('default');
    expect(gitDiffMock.mock.calls.length).toBe(initialGitDiffCalls);
  });

  it('resets only the right-side draft content', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    store.openDiffModal(repositoryIdA, changeIdA);
    await Promise.resolve();
    store.updateRightDraft('const value = 7;\nconsole.log(value);');

    expect(useFileChangesStore.getState().getDiffModalSession()?.isDirty).toBe(true);

    store.resetRightDraft();

    const session = useFileChangesStore.getState().getDiffModalSession();
    expect(session?.isDirty).toBe(false);
    expect(session?.rightDraftContent).toContain('const value = 2;');
  });

  it('saves the right-side draft, reloads the diff, and marks the file as unreviewed again', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    store.markAsReviewed(repositoryIdA, changeIdA);
    store.openDiffModal(repositoryIdA, changeIdA);
    await Promise.resolve();
    store.updateRightDraft('const value = 9;\nconsole.log(value);');

    await store.saveRightDraft();

    const session = useFileChangesStore.getState().getDiffModalSession();
    const change = useFileChangesStore.getState().getChange(repositoryIdA, changeIdA);
    expect(fsWriteFileMock).toHaveBeenCalledTimes(1);
    expect(session?.isDirty).toBe(false);
    expect(session?.rightDraftContent).toContain('const value = 9;');
    expect(change?.modifiedContent).toContain('const value = 9;');
    expect(change?.reviewed).toBe(false);
  });

  it('applies reviewed state in batch for a repository scope', async () => {
    currentFiles[worktreeAPath]['src/new.ts'] = 'export const created = true;\n';
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    const repository = useFileChangesStore.getState().getRepository(repositoryIdA);
    const changeIds = repository?.changes.map((change) => change.id) ?? [];
    expect(changeIds).toHaveLength(2);

    store.setReviewedState(repositoryIdA, changeIds, true);

    const updatedRepository = useFileChangesStore.getState().getRepository(repositoryIdA);
    expect(updatedRepository?.stats.reviewed).toBe(2);
    expect(updatedRepository?.changes.every((change) => change.reviewed)).toBe(true);

    store.setReviewedState(repositoryIdA, changeIds, false);

    const resetRepository = useFileChangesStore.getState().getRepository(repositoryIdA);
    expect(resetRepository?.stats.reviewed).toBe(0);
    expect(resetRepository?.changes.every((change) => !change.reviewed)).toBe(true);
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

  it('returns the task to in-progress after the last repository commit', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    store.markAsReviewed(repositoryIdA, changeIdA);
    store.markAsReviewed(repositoryIdB, changeIdB);

    const firstCommit = await store.commitReviewedChanges(
      repositoryIdA,
      'feat: commit project a'
    );
    expect(firstCommit.taskCompleted).toBe(false);
    expect(setTaskStatusMock).not.toHaveBeenCalled();
    expect(useFileChangesStore.getState().selectedRepositoryId).toBe(repositoryIdB);
    expect(useFileChangesStore.getState().reviewSummary.hasCommittedRepositories).toBe(true);
    expect(useFileChangesStore.getState().reviewSummary.currentRepositoryId).toBe(repositoryIdB);

    const secondCommit = await store.commitReviewedChanges(
      repositoryIdB,
      'feat: commit project b'
    );
    expect(secondCommit.taskCompleted).toBe(false);
    expect(secondCommit.taskStatus).toBe('InProgress');
    expect(setTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(setTaskStatusMock).toHaveBeenCalledWith('task-1', 'InProgress');
  });
});
