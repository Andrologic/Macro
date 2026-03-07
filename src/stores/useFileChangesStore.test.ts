import { beforeEach, describe, expect, it, mock } from 'bun:test';

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
let taskStatus: 'InReview' | 'Completed' = 'InReview';

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

const task = {
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
};

const completeTaskMock = mock(async () => {
  taskStatus = 'Completed';
});

const taskStoreState = {
  activeRepositoryPath: worktreeAPath,
  activeBranchName: 'feature/task-a',
  branchWorktrees: {
    'project-a::feature-task-a': worktreeAPath,
    'project-b::feature-task-b': worktreeBPath,
  },
  getTaskById: (taskId: string) => (taskId === task.id ? { ...task, status: taskStatus } : undefined),
  completeTask: completeTaskMock,
};

mock.module('./useTaskStore', () => ({
  useTaskStore: {
    getState: () => taskStoreState,
    setState: mock(() => undefined),
  },
}));

const appStoreState = {
  selectedProjectId: null,
  selectedGroupId: 'group-1',
  selectedTaskId: task.id,
  projectGroups: [],
  getProjectById: (projectId: string) => {
    if (projectId === 'project-a') return { id: 'project-a', name: 'Project A', path: repoAPath };
    if (projectId === 'project-b') return { id: 'project-b', name: 'Project B', path: repoBPath };
    return null;
  },
};

mock.module('./useAppStore', () => ({
  useAppStore: {
    getState: () => appStoreState,
  },
}));

const { resolveChangeFilePath, useFileChangesStore } = await import('./useFileChangesStore');

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
    taskStatus = 'InReview';

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

    const repositories = useFileChangesStore.getState().repositories;
    expect(repositories).toHaveLength(2);
    expect(repositories.map((repository) => repository.projectId)).toEqual(['project-a', 'project-b']);
    expect(repositories.map((repository) => repository.stats.total)).toEqual([1, 1]);
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

    const secondCommit = await store.commitReviewedChanges(
      'project-b::project-b::feature-task-b',
      'feat: commit project b'
    );
    expect(secondCommit.taskCompleted).toBe(true);
    expect(completeTaskMock).toHaveBeenCalledTimes(1);
    expect(mergeFeatureBranchIntoPlanBranchMock).toHaveBeenCalledTimes(2);
  });
});
