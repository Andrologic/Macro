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
  },
  [worktreeBPath]: {
    'README.md': 'Hello',
  },
};

let currentFiles: Record<string, Record<string, string>> = {};
let taskStatuses: Record<string, 'Pending' | 'InReview' | 'Completed'> = {
  'task-1': 'InReview',
  'task-2': 'InReview',
  'task-3': 'InReview',
  'task-4': 'Pending',
};

const buildPatch = (repoPath: string, path: string): string => {
  const original = initialOriginalFiles[repoPath]?.[path] ?? '';
  const modified = currentFiles[repoPath]?.[path] ?? '';
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
  if (repoPath === worktreeAPath) {
    return {
      branch: 'feature/task-a',
      head_commit: null,
      staged_files: [],
      unstaged_files: currentFiles[repoPath]?.['src/main.ts']
        ? [{ path: 'src/main.ts', status: 'modified' }]
        : [],
      untracked_files: [],
      conflicted_files: [],
      conflictedFiles: [],
      merge_in_progress: false,
      mergeInProgress: false,
      is_clean: !currentFiles[repoPath]?.['src/main.ts'],
    };
  }

  if (repoPath === worktreeBPath) {
    return {
      branch: 'feature/task-b',
      head_commit: null,
      staged_files: [],
      unstaged_files: currentFiles[repoPath]?.['README.md']
        ? [{ path: 'README.md', status: 'modified' }]
        : [],
      untracked_files: [],
      conflicted_files: [],
      conflictedFiles: [],
      merge_in_progress: false,
      mergeInProgress: false,
      is_clean: !currentFiles[repoPath]?.['README.md'],
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
  currentFiles[base][relative] = content;
  return {
    path: normalized,
    bytes_written: content.length,
    created: false,
  };
});

const gitAddMock = mock(async () => undefined);
const gitCommitMock = mock(async ({ repoPath }: { repoPath: string }) => {
  currentFiles[repoPath] = {};
  return repoPath === worktreeAPath ? 'hash-a' : 'hash-b';
});

const mergeFeatureBranchIntoPlanBranchMock = mock(async ({ projectId }: { projectId: string }) =>
  `merged-${projectId}`
);

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

const completeTaskMock = mock(async (taskId: string) => {
  if (taskId in taskStatuses) {
    taskStatuses[taskId] = 'Completed';
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
  completeTask: completeTaskMock,
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

const setTaskStateMock = mock(() => undefined);
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
    gitAddMock.mockClear();
    gitCommitMock.mockClear();
    mergeFeatureBranchIntoPlanBranchMock.mockClear();
    completeTaskMock.mockClear();
    setTaskStateMock.mockClear();

    useFileChangesStore = createFileChangesStore({
      tauri: {
        isTauriAvailable: () => true,
        gitStatus: gitStatusMock,
        gitDiff: gitDiffMock,
        fsWriteFile: fsWriteFileMock,
        gitAdd: gitAddMock,
        gitCommit: gitCommitMock,
      },
      mergeFeatureBranchIntoPlanBranch: mergeFeatureBranchIntoPlanBranchMock,
      getGitFlowBaseBranch: () => 'develop',
      getAppState: () => appStoreState,
      getTaskState: () => taskStoreState,
      setTaskState: setTaskStateMock,
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

  it('clears stale diff state when switching to another task', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    store.openDiffModal(repositoryIdA, changeIdA);
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
    expect(nextState.isDiffModalOpen).toBe(false);
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

  it('completes the task only after the last repository commit', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    store.markAsReviewed(repositoryIdA, changeIdA);
    store.markAsReviewed(repositoryIdB, changeIdB);

    const firstCommit = await store.commitReviewedChanges(
      repositoryIdA,
      'feat: commit project a'
    );
    expect(firstCommit.taskCompleted).toBe(false);
    expect(completeTaskMock).not.toHaveBeenCalled();
    expect(useFileChangesStore.getState().selectedRepositoryId).toBe(repositoryIdB);
    expect(useFileChangesStore.getState().reviewSummary.hasCommittedRepositories).toBe(true);
    expect(useFileChangesStore.getState().reviewSummary.currentRepositoryId).toBe(repositoryIdB);

    const secondCommit = await store.commitReviewedChanges(
      repositoryIdB,
      'feat: commit project b'
    );
    expect(secondCommit.taskCompleted).toBe(true);
    expect(completeTaskMock).toHaveBeenCalledTimes(1);
    expect(mergeFeatureBranchIntoPlanBranchMock).toHaveBeenCalledTimes(2);
  });
});
