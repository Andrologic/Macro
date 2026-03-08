import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const repoAPath = 'C:/repos/project-a';
const repoBPath = 'C:/repos/project-b';
const worktreeAPath = 'C:/worktrees/project-a-feature';
const worktreeBPath = 'C:/worktrees/project-b-feature';

const initialOriginalFiles: Record<string, Record<string, string>> = {
  [worktreeAPath]: {
    'src/main.ts': 'const value = 1;\nconsole.log(value);',
  },
  [worktreeBPath]: {
    'README.md': 'Hello',
  },
};

let currentFiles: Record<string, Record<string, string>> = {};
let taskStatuses: Record<string, 'InReview' | 'Completed'> = {
  'task-1': 'InReview',
  'task-2': 'InReview',
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

const gitStatusMock = mock(async (repoPath: string) => {
  if (repoPath === worktreeAPath) {
    return {
      branch: 'feature/task-a',
      head_commit: null,
      staged_files: [],
      unstaged_files: currentFiles[repoPath]?.['src/main.ts']
        ? [{ path: 'src/main.ts', status: 'modified' }]
        : [],
      untracked_files: [],
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
      is_clean: !currentFiles[repoPath]?.['README.md'],
    };
  }

  return {
    branch: 'develop',
    head_commit: null,
    staged_files: [],
    unstaged_files: [],
    untracked_files: [],
    is_clean: true,
  };
});

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
        worktreeKey: 'project-a::feature-task-a',
        planBranchName: 'plan/integration',
      },
      {
        projectId: 'project-b',
        branchName: 'feature/task-b',
        worktreeKey: 'project-b::feature-task-b',
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
        worktreeKey: 'project-a::feature-task-a',
        planBranchName: 'plan/integration',
      },
      {
        projectId: 'project-b',
        branchName: 'feature/task-b',
        worktreeKey: 'project-b::feature-task-b',
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
    'project-a::feature-task-a': worktreeAPath,
    'project-b::feature-task-b': worktreeBPath,
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
    return null;
  },
};

const registerFileChangesStoreMocks = () => {
  mock.restore();
  mock.module('../services/tauriIpc', () => ({
    isTauriAvailable: () => true,
    gitStatus: gitStatusMock,
    gitDiff: gitDiffMock,
    fsWriteFile: fsWriteFileMock,
    gitAdd: gitAddMock,
    gitCommit: gitCommitMock,
  }));

  mock.module('../services/architectGitFlowService', () => ({
    mergeFeatureBranchIntoPlanBranch: mergeFeatureBranchIntoPlanBranchMock,
  }));

  mock.module('./useTaskStore', () => ({
    useTaskStore: {
      getState: () => taskStoreState,
      setState: mock(() => undefined),
    },
  }));

  mock.module('./useAppStore', () => ({
    useAppStore: {
      getState: () => appStoreState,
    },
  }));
};

let fileChangesStoreImportCounter = 0;

const loadFileChangesStore = async () => {
  registerFileChangesStoreMocks();
  fileChangesStoreImportCounter += 1;
  return import(`./useFileChangesStore.ts?test=${fileChangesStoreImportCounter}`);
};

let resolveChangeFilePath: (repoPath: string, filePath: string) => string;
let useFileChangesStore: Awaited<ReturnType<typeof loadFileChangesStore>>['useFileChangesStore'];

describe('useFileChangesStore', () => {
  beforeEach(async () => {
    ({ resolveChangeFilePath, useFileChangesStore } = await loadFileChangesStore());
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
    };
    appStoreState.selectedTaskId = 'task-1';

    gitStatusMock.mockClear();
    gitDiffMock.mockClear();
    fsWriteFileMock.mockClear();
    gitAddMock.mockClear();
    gitCommitMock.mockClear();
    mergeFeatureBranchIntoPlanBranchMock.mockClear();
    completeTaskMock.mockClear();

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
    expect(reviewSummary.currentRepositoryId).toBe('project-a::project-a::feature-task-a');
  });

  it('clears stale diff state when switching to another task', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    store.openDiffModal('project-a::project-a::feature-task-a', 'project-a::project-a::feature-task-a::src/main.ts');
    expect(useFileChangesStore.getState().selectedDiffTarget).toEqual({
      repositoryId: 'project-a::project-a::feature-task-a',
      changeId: 'project-a::project-a::feature-task-a::src/main.ts',
    });
    expect(useFileChangesStore.getState().isDiffModalOpen).toBe(true);

    appStoreState.selectedTaskId = 'task-2';
    await useFileChangesStore.getState().loadCurrentChanges();

    const nextState = useFileChangesStore.getState();
    expect(nextState.currentTaskId).toBe('task-2');
    expect(nextState.selectedDiffTarget).toBeNull();
    expect(nextState.isDiffModalOpen).toBe(false);
  });

  it('completes the task only after the last repository commit', async () => {
    const store = useFileChangesStore.getState();
    await store.loadCurrentChanges();

    store.markAsReviewed('project-a::project-a::feature-task-a', 'project-a::project-a::feature-task-a::src/main.ts');
    store.markAsReviewed('project-b::project-b::feature-task-b', 'project-b::project-b::feature-task-b::README.md');

    const firstCommit = await store.commitReviewedChanges(
      'project-a::project-a::feature-task-a',
      'feat: commit project a'
    );
    expect(firstCommit.taskCompleted).toBe(false);
    expect(completeTaskMock).not.toHaveBeenCalled();
    expect(useFileChangesStore.getState().selectedRepositoryId).toBe('project-b::project-b::feature-task-b');
    expect(useFileChangesStore.getState().reviewSummary.hasCommittedRepositories).toBe(true);
    expect(useFileChangesStore.getState().reviewSummary.currentRepositoryId).toBe('project-b::project-b::feature-task-b');

    const secondCommit = await store.commitReviewedChanges(
      'project-b::project-b::feature-task-b',
      'feat: commit project b'
    );
    expect(secondCommit.taskCompleted).toBe(true);
    expect(completeTaskMock).toHaveBeenCalledTimes(1);
    expect(mergeFeatureBranchIntoPlanBranchMock).toHaveBeenCalledTimes(2);
  });

  afterAll(() => {
    mock.restore();
  });
});
