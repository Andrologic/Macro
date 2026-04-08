import { create } from 'zustand';
import i18n from '../i18n';
import { parseUnifiedDiff, type ParsedDiffHunk } from '../services/gitDiffParser';
import * as tauriIpc from '../services/tauriIpc';
import { useTaskStore, type TaskCompletionRepositoryRecord } from './useTaskStore';
import type { TaskExecutionTarget, TaskStatus } from '../types';
import {
  EMPTY_REVIEW_TASK_SUMMARY,
  buildReviewTaskSummary,
  selectReviewRepositoryId,
  type ReviewTaskSummary,
} from '../services/implementMultiRepoSummary';
import { toBranchWorktreeKey } from '../services/implementTaskDerivation';
import { useAppStore } from './useAppStore';
import { getGitFlowBaseBranch } from '../services/architectPlanService';

export type DiffPresentationMode = 'focused' | 'full';
export type FileChangeContextMode = DiffPresentationMode;
export type ReviewRepositoryCommitState = 'idle' | 'committing' | 'committed' | 'no_changes';
export type FileChangesTaskLoadState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'awaiting_worktree'
  | 'invalid_mapping';

export interface FileChangeEntry {
  id: string;
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  reviewed: boolean;
  originalContent: string;
  modifiedContent: string;
  language: string;
  hunks: ParsedDiffHunk[];
  contextMode: DiffPresentationMode;
  canEdit: boolean;
}

export interface ReviewRepositoryStats {
  total: number;
  reviewed: number;
  additions: number;
  deletions: number;
}

export interface ReviewRepositoryState {
  id: string;
  projectId: string;
  repoPath: string;
  worktreePath: string;
  branchName: string;
  planBranchName: string | null;
  changes: FileChangeEntry[];
  selectedChangeId: string | null;
  stats: ReviewRepositoryStats;
  commitMessageDraft: string;
  commitState: ReviewRepositoryCommitState;
  loadingChangeId: string | null;
  savingChangeId: string | null;
  lastError: string | null;
  lastCommitHash: string | null;
}

export interface FolderNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  changeIds: string[];
  allReviewed: boolean;
  hasPendingReview: boolean;
  children?: FolderNode[];
  fileChange?: FileChangeEntry;
}

export interface CommitTaskChangesResult {
  hash: string;
  taskId: string;
  taskCompleted: boolean;
  taskStatus: TaskStatus | null;
  committedRepositoryId: string;
  repositories: TaskCompletionRepositoryRecord[];
}

interface SelectedDiffTarget {
  repositoryId: string;
  changeId: string;
}

export interface FileDiffModalSession {
  repositoryId: string;
  changeId: string;
  originalContent: string;
  rightDraftContent: string;
  lastLoadedModifiedContent: string;
  isDirty: boolean;
  isSaving: boolean;
  isHydratingFullContext: boolean;
}

interface LoadCurrentChangesOptions {
  silent?: boolean;
  preserveDiffModalSession?: boolean;
}

const EMPTY_STATS: ReviewRepositoryStats = {
  total: 0,
  reviewed: 0,
  additions: 0,
  deletions: 0,
};

interface FileChangesProjectRef {
  path?: string | null;
}

interface FileChangesTaskLike {
  id: string;
  title: string;
  status: TaskStatus;
  task_source: 'architect' | 'mixed' | 'fallback' | 'empty' | 'standalone';
  project_id?: string | null;
  assigned_branch: string;
  execution_targets?: TaskExecutionTarget[];
}

interface FileChangesGitStatus {
  branch: string;
  staged_files: Array<{ path: string; status: string }>;
  unstaged_files: Array<{ path: string; status: string }>;
  untracked_files: Array<{ path: string; status: string }>;
  is_clean: boolean;
}

type FileChangesTauriDeps = Pick<
  typeof tauriIpc,
  'isTauriAvailable' | 'gitDiff' | 'gitReadFilePair' | 'fsWriteFile' | 'gitAdd' | 'gitCommit' | 'gitRestorePaths'
> & {
  gitStatus: (repoPath: string) => Promise<FileChangesGitStatus>;
};

interface FileChangesAppState {
  selectedTaskId: string | null;
  getProjectById: (projectId: string) => FileChangesProjectRef | null | undefined;
}

interface FileChangesTaskStoreState {
  activeRepositoryPath: string | null;
  activeBranchName: string | null;
  branchWorktrees: Record<string, string>;
  getTaskById: (taskId: string) => FileChangesTaskLike | undefined;
  setTaskStatus: (taskId: string, status: TaskStatus) => Promise<void> | void;
  completeTask: (taskId: string, options?: {
    skipIntegration?: boolean;
    repositories?: TaskCompletionRepositoryRecord[];
  }) => Promise<void> | void;
}

type FileChangesSetTaskState = (partial: {
  activeBranchName: string | null;
  activeRepositoryPath: string | null;
}) => void;

export interface FileChangesStoreDependencies {
  tauri: FileChangesTauriDeps;
  getGitFlowBaseBranch: typeof getGitFlowBaseBranch;
  getAppState: () => FileChangesAppState;
  getTaskState: () => FileChangesTaskStoreState;
  setTaskState: FileChangesSetTaskState;
}

const defaultFileChangesStoreDependencies: FileChangesStoreDependencies = {
  tauri: tauriIpc,
  getGitFlowBaseBranch,
  getAppState: () => useAppStore.getState(),
  getTaskState: () => useTaskStore.getState(),
  setTaskState: (partial) => useTaskStore.setState(partial),
};

export function buildFolderTree(changes: FileChangeEntry[]): FolderNode[] {
  const root: FolderNode[] = [];

  for (const change of changes) {
    const parts = change.path.split('/').filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      let existing = current.find((node) => node.name === part);

      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          type: isFile ? 'file' : 'folder',
          changeIds: isFile ? [change.id] : [],
          allReviewed: isFile ? change.reviewed : false,
          hasPendingReview: isFile ? !change.reviewed : false,
          children: isFile ? undefined : [],
          fileChange: isFile ? change : undefined,
        };
        current.push(existing);
      }

      if (!isFile) {
        existing.changeIds = [...existing.changeIds, change.id];
      }

      if (!isFile && existing.children) {
        current = existing.children;
      }
    }
  }

  const annotateNode = (node: FolderNode): FolderNode => {
    if (node.type === 'file') {
      return {
        ...node,
        changeIds: node.fileChange ? [node.fileChange.id] : node.changeIds,
        allReviewed: node.fileChange?.reviewed === true,
        hasPendingReview: node.fileChange?.reviewed !== true,
      };
    }

    const children = (node.children || []).map(annotateNode);
    return {
      ...node,
      children,
      changeIds: children.flatMap((child) => child.changeIds),
      allReviewed: children.length > 0 && children.every((child) => child.allReviewed),
      hasPendingReview: children.some((child) => child.hasPendingReview),
    };
  };

  return root.map(annotateNode);
}

const deriveLanguage = (path: string): string => {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  if (!extension) return 'text';
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'js' || extension === 'jsx') return 'javascript';
  if (extension === 'rs') return 'rust';
  if (extension === 'json') return 'json';
  if (extension === 'md') return 'markdown';
  return extension;
};

const normalizeStatus = (status: string): FileChangeEntry['status'] => {
  const value = status.toLowerCase();
  if (value.includes('added') || value === 'a' || value === 'new' || value === 'untracked') return 'added';
  if (value.includes('deleted') || value === 'd' || value === 'removed') return 'deleted';
  return 'modified';
};

const normalizePortablePath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/, '');

export const resolveChangeFilePath = (repoPath: string, relativePath: string): string => {
  const base = normalizePortablePath(repoPath);
  const relative = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${base}/${relative}`;
};

const tChanges = (key: string, fallback: string, options?: Record<string, unknown>): string =>
  i18n.t(key, { defaultValue: fallback, ...(options || {}) });

const buildRepositoryId = (target: TaskExecutionTarget): string =>
  `${target.projectId}::${target.worktreeKey}`;

const normalizeBranchName = (value?: string | null): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || 'work';
};

const toDefaultCommitMessage = (title?: string | null): string => {
  const trimmed = title?.trim();
  if (!trimmed) return 'chore: update task changes';
  const normalized = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  return `feat: ${normalized}`;
};

const computeStats = (changes: FileChangeEntry[]): ReviewRepositoryStats => ({
  total: changes.length,
  reviewed: changes.filter((change) => change.reviewed).length,
  additions: changes.reduce((sum, change) => sum + change.additions, 0),
  deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
});

const updateChangeEntry = (
  changes: FileChangeEntry[],
  changeId: string,
  updater: (change: FileChangeEntry) => FileChangeEntry
): FileChangeEntry[] =>
  changes.map((change) => (change.id === changeId ? updater(change) : change));

const updateRepositoryState = (
  repositories: ReviewRepositoryState[],
  repositoryId: string,
  updater: (repository: ReviewRepositoryState) => ReviewRepositoryState
): ReviewRepositoryState[] =>
  repositories.map((repository) => (
    repository.id === repositoryId ? updater(repository) : repository
  ));

const updateReviewedStateForChangeIds = (
  changes: FileChangeEntry[],
  changeIds: string[],
  reviewed: boolean
): FileChangeEntry[] => {
  const targetIds = new Set(changeIds);
  return changes.map((change) => (
    targetIds.has(change.id)
      ? { ...change, reviewed }
      : change
  ));
};

const syncActiveReviewRepository = (
  deps: FileChangesStoreDependencies,
  repository: ReviewRepositoryState | null | undefined
): void => {
  if (!repository) return;
  deps.setTaskState({
    activeBranchName: repository.branchName,
    activeRepositoryPath: repository.worktreePath,
  });
};

const getExecutionTargets = (
  deps: FileChangesStoreDependencies,
  task: FileChangesTaskLike
): TaskExecutionTarget[] => {
  if (task.execution_targets?.length) {
    return task.execution_targets;
  }

  if (!task.project_id) {
    return [];
  }

  return [{
    projectId: task.project_id,
    branchName: task.assigned_branch,
    worktreeKey: toBranchWorktreeKey(task.project_id, task.assigned_branch),
    planBranchName: task.task_source === 'standalone' ? deps.getGitFlowBaseBranch() : undefined,
  }];
};

const resolveSelectedTask = (deps: FileChangesStoreDependencies): FileChangesTaskLike | null => {
  const selectedTaskId = deps.getAppState().selectedTaskId;
  if (!selectedTaskId) return null;
  return deps.getTaskState().getTaskById(selectedTaskId) ?? null;
};

const ensureReviewTask = (deps: FileChangesStoreDependencies): FileChangesTaskLike => {
  const task = resolveSelectedTask(deps);
  if (!task) {
    throw new Error(
      tChanges('implement.errors.selectTaskBeforeCommit', 'Select a task before reviewing changes.')
    );
  }
  return task;
};

const resolveRepositoryWorktreePath = (
  deps: FileChangesStoreDependencies,
  target: TaskExecutionTarget,
  _task: FileChangesTaskLike
): string | null => {
  const taskState = deps.getTaskState();
  return taskState.branchWorktrees[target.worktreeKey] ?? null;
};

const buildFirstChangesMessage = (): string =>
  tChanges(
    'implement.changesAppearAfterFirstEdit',
    'Make your first changes to this task to see them here.'
  );

const buildMissingWorktreeMessage = (
  _task: FileChangesTaskLike,
  _targets: TaskExecutionTarget[]
): string => buildFirstChangesMessage();

const buildAwaitingWorktreeMessage = (task: FileChangesTaskLike): string => {
  if (task.status === 'Blocked') {
    return tChanges(
      'implement.worktreeBlockedTask',
      'Unblock this task to see its changes here.'
    );
  }

  if (task.status === 'Failed') {
    return tChanges(
      'implement.worktreeFailedTask',
      'Retry this task to continue. Its changes will appear here.'
    );
  }

  if (task.status === 'Completed') {
    return tChanges(
      'implement.worktreeCompletedTask',
      'This task is complete. New changes will appear here if work resumes.'
    );
  }

  return buildFirstChangesMessage();
};

const shouldTreatMissingWorktreeAsPending = (task: FileChangesTaskLike): boolean =>
  task.status === 'Pending' ||
  task.status === 'Blocked' ||
  task.status === 'Failed' ||
  task.status === 'Completed';

const loadFileChangeEntry = async (
  deps: FileChangesStoreDependencies,
  repositoryId: string,
  worktreePath: string,
  file: { path: string; status: string },
  previousChange?: FileChangeEntry
): Promise<FileChangeEntry> => {
  const id = `${repositoryId}::${file.path}`;
  const status = normalizeStatus(file.status);
  const patch = await deps.tauri.gitDiff({
    repoPath: worktreePath,
    paths: [file.path],
    contextLines: 3,
  });
  const parsed = parseUnifiedDiff(patch || '');

  return {
    id,
    path: file.path,
    status,
    additions: parsed.additions,
    deletions: parsed.deletions,
    reviewed: previousChange?.reviewed ?? false,
    originalContent: parsed.originalContent,
    modifiedContent: parsed.modifiedContent,
    language: deriveLanguage(file.path),
    hunks: parsed.hunks,
    contextMode: previousChange?.contextMode ?? 'focused',
    canEdit: status !== 'deleted',
  };
};

const loadRepositoryState = async (params: {
  deps: FileChangesStoreDependencies;
  task: FileChangesTaskLike;
  target: TaskExecutionTarget;
  previousRepository?: ReviewRepositoryState;
  committedRecord?: TaskCompletionRepositoryRecord;
}): Promise<ReviewRepositoryState> => {
  const { deps, task, target, previousRepository, committedRecord } = params;
  const appState = deps.getAppState();
  const project = appState.getProjectById(target.projectId);
  const repoPath = project?.path ?? target.repoPath ?? null;
  const worktreePath = resolveRepositoryWorktreePath(deps, target, task);

  if (!repoPath || !worktreePath) {
    throw new Error(
      tChanges('implement.errors.cannotResolveTaskProject', 'Cannot resolve project for task {{taskId}}', {
        taskId: task.id,
      })
    );
  }

  const repositoryId = buildRepositoryId(target);
  const status = await deps.tauri.gitStatus(worktreePath);
  const candidates = [
    ...status.staged_files,
    ...status.unstaged_files,
    ...status.untracked_files,
  ];

  const uniqueByPath = new Map<string, { path: string; status: string }>();
  candidates.forEach((file) => {
    if (!file.path) return;
    if (!uniqueByPath.has(file.path)) {
      uniqueByPath.set(file.path, { path: file.path, status: file.status });
    }
  });

  const previousById = new Map((previousRepository?.changes || []).map((change) => [change.id, change]));
  const changes: FileChangeEntry[] = [];
  for (const file of uniqueByPath.values()) {
    const changeId = `${repositoryId}::${file.path}`;
    const previousChange = previousById.get(changeId);
    changes.push(await loadFileChangeEntry(deps, repositoryId, worktreePath, file, previousChange));
  }

  const selectedChangeId = previousRepository?.selectedChangeId &&
    changes.some((change) => change.id === previousRepository.selectedChangeId)
    ? previousRepository.selectedChangeId
    : changes[0]?.id ?? null;
  const hasCommittedSnapshot = Boolean(committedRecord || previousRepository?.commitState === 'committed');
  const commitState: ReviewRepositoryCommitState = changes.length === 0
    ? (hasCommittedSnapshot ? 'committed' : 'no_changes')
    : 'idle';

  return {
    id: repositoryId,
    projectId: target.projectId,
    repoPath,
    worktreePath,
    branchName: normalizeBranchName(target.branchName),
    planBranchName: target.planBranchName || (task.task_source === 'standalone' ? deps.getGitFlowBaseBranch() : null),
    changes,
    selectedChangeId,
    stats: computeStats(changes),
    commitMessageDraft: previousRepository?.commitMessageDraft || toDefaultCommitMessage(task.title),
    commitState,
    loadingChangeId: null,
    savingChangeId: null,
    lastError: previousRepository?.lastError ?? null,
    lastCommitHash: previousRepository?.lastCommitHash ?? null,
  };
};

const ensureNoForeignStagedFiles = async (
  deps: FileChangesStoreDependencies,
  worktreePath: string,
  reviewedPaths: string[]
): Promise<void> => {
  const status = await deps.tauri.gitStatus(worktreePath);
  const reviewedSet = new Set(reviewedPaths);
  const foreignStaged = status.staged_files
    .map((file) => file.path)
    .filter((path) => !reviewedSet.has(path));

  if (foreignStaged.length > 0) {
    throw new Error(
      tChanges(
        'implement.errors.foreignStagedFiles',
        'Staged files outside this task were found: {{paths}}. Unstage them before committing.',
        { paths: foreignStaged.join(', ') }
      )
    );
  }
};

const buildCompletionRepositoryRecord = (
  deps: FileChangesStoreDependencies,
  repository: ReviewRepositoryState,
  existingRecord?: TaskCompletionRepositoryRecord
): TaskCompletionRepositoryRecord => ({
  projectId: repository.projectId,
  repoPath: repository.repoPath,
  branchName: repository.branchName,
  planBranchName: repository.planBranchName || deps.getGitFlowBaseBranch(),
  mergeOutput: existingRecord?.mergeOutput,
});

const deriveReviewState = (
  repositories: ReviewRepositoryState[],
  selectedRepositoryId?: string | null
): Pick<FileChangesState, 'selectedRepositoryId' | 'reviewSummary'> => {
  const nextSelectedRepositoryId = selectReviewRepositoryId(repositories, selectedRepositoryId);
  return {
    selectedRepositoryId: nextSelectedRepositoryId,
    reviewSummary: buildReviewTaskSummary(repositories, nextSelectedRepositoryId),
  };
};

const buildDiffModalSession = (
  repositoryId: string,
  change: FileChangeEntry,
  overrides: Partial<FileDiffModalSession> = {}
): FileDiffModalSession => ({
  repositoryId,
  changeId: change.id,
  originalContent: change.originalContent,
  rightDraftContent: change.modifiedContent,
  lastLoadedModifiedContent: change.modifiedContent,
  isDirty: false,
  isSaving: false,
  isHydratingFullContext: false,
  ...overrides,
});

interface FileChangesState {
  currentTaskId: string | null;
  currentTaskLoadState: FileChangesTaskLoadState;
  currentTaskLoadMessage: string | null;
  loadRequestId: number;
  repositories: ReviewRepositoryState[];
  selectedRepositoryId: string | null;
  reviewSummary: ReviewTaskSummary;
  selectedDiffTarget: SelectedDiffTarget | null;
  diffModalSession: FileDiffModalSession | null;
  isDiffModalOpen: boolean;
  isLoading: boolean;
  isCommitting: boolean;
  lastError: string | null;
  lastCommitHash: string | null;
  executionRecords: Record<string, TaskCompletionRepositoryRecord>;

  loadCurrentChanges: (options?: LoadCurrentChangesOptions) => Promise<void>;
  resetReviewState: () => void;
  selectRepository: (repositoryId: string | null) => void;
  openDiffModal: (repositoryId: string, changeId: string) => void;
  closeDiffModal: () => void;
  setReviewedState: (repositoryId: string, changeIds: string[], reviewed: boolean) => void;
  markAsReviewed: (repositoryId: string, changeId: string) => void;
  markAsUnreviewed: (repositoryId: string, changeId: string) => void;
  markAllAsReviewed: (repositoryId?: string) => void;
  revertChanges: (repositoryId: string, changeIds: string[]) => Promise<void>;
  updateRightDraft: (content: string) => void;
  resetRightDraft: () => void;
  saveRightDraft: () => Promise<void>;
  goToAdjacentDiff: (direction: 'previous' | 'next') => void;
  commitReviewedChanges: (repositoryId: string, message?: string) => Promise<CommitTaskChangesResult>;
  setCommitMessageDraft: (repositoryId: string, message: string) => void;
  getRepository: (repositoryId: string) => ReviewRepositoryState | undefined;
  getSelectedRepository: () => ReviewRepositoryState | undefined;
  getChange: (repositoryId: string, changeId: string) => FileChangeEntry | undefined;
  getDiffModalSession: () => FileDiffModalSession | null;
  getSelectedDiffTarget: () => SelectedDiffTarget | null;
  getStats: (repositoryId?: string | null) => ReviewRepositoryStats;
  getOverallStats: () => ReviewRepositoryStats;
  getReviewSummary: () => ReviewTaskSummary;
}

export const createFileChangesStore = (
  overrides: Partial<FileChangesStoreDependencies> = {}
) => {
  const deps: FileChangesStoreDependencies = {
    ...defaultFileChangesStoreDependencies,
    ...overrides,
    tauri: {
      ...defaultFileChangesStoreDependencies.tauri,
      ...(overrides.tauri || {}),
    },
  };

  return create<FileChangesState>((set, get) => {
    const hydrateDiffModalFile = async (repositoryId: string, changeId: string) => {
      const repository = get().getRepository(repositoryId);
      const change = get().getChange(repositoryId, changeId);
      if (!repository || !change) {
        return;
      }

      set((state) => ({
        repositories: updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
          ...currentRepository,
          loadingChangeId: changeId,
          lastError: null,
        })),
        diffModalSession:
          state.diffModalSession &&
          state.diffModalSession.repositoryId === repositoryId &&
          state.diffModalSession.changeId === changeId
            ? {
              ...state.diffModalSession,
              isHydratingFullContext: true,
            }
            : state.diffModalSession,
        lastError: null,
      }));

      try {
        const pair = await deps.tauri.gitReadFilePair({
          repoPath: repository.worktreePath,
          path: change.path,
        });

        set((state) => {
          const isCurrentSession =
            state.diffModalSession &&
            state.diffModalSession.repositoryId === repositoryId &&
            state.diffModalSession.changeId === changeId;

          return {
            repositories: updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
              ...currentRepository,
              changes: updateChangeEntry(currentRepository.changes, changeId, (entry) => ({
                ...entry,
                originalContent: pair.originalContent,
                modifiedContent: pair.modifiedContent,
              })),
              loadingChangeId: null,
              lastError: null,
            })),
            diffModalSession: isCurrentSession && state.diffModalSession
              ? {
                ...state.diffModalSession,
                originalContent: pair.originalContent,
                rightDraftContent: state.diffModalSession.isDirty
                  ? state.diffModalSession.rightDraftContent
                  : pair.modifiedContent,
                lastLoadedModifiedContent: pair.modifiedContent,
                isHydratingFullContext: false,
              }
              : state.diffModalSession,
            lastError: null,
          };
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : tChanges('implement.errors.loadChangesFailed', 'Failed to load repository changes.');
        set((state) => ({
          repositories: updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
            ...currentRepository,
            loadingChangeId: null,
            lastError: message,
          })),
          diffModalSession:
            state.diffModalSession &&
            state.diffModalSession.repositoryId === repositoryId &&
            state.diffModalSession.changeId === changeId
              ? {
                ...state.diffModalSession,
                isHydratingFullContext: false,
              }
              : state.diffModalSession,
          lastError: message,
        }));
      }
    };

    return ({
    currentTaskId: null,
    currentTaskLoadState: 'idle',
    currentTaskLoadMessage: null,
    loadRequestId: 0,
    repositories: [],
    selectedRepositoryId: null,
    reviewSummary: EMPTY_REVIEW_TASK_SUMMARY,
    selectedDiffTarget: null,
    diffModalSession: null,
    isDiffModalOpen: false,
    isLoading: false,
    isCommitting: false,
    lastError: null,
    lastCommitHash: null,
    executionRecords: {},

  loadCurrentChanges: async (options) => {
    const previousState = get();
    const task = resolveSelectedTask(deps);
    const nextLoadRequestId = previousState.loadRequestId + 1;

    const resetLoadState = {
      repositories: [],
      selectedRepositoryId: null,
      reviewSummary: EMPTY_REVIEW_TASK_SUMMARY,
      selectedDiffTarget: null,
      diffModalSession: null,
      isDiffModalOpen: false,
      lastCommitHash: null,
    } satisfies Partial<FileChangesState>;

    const isStaleRequest = (requestId: number, taskId: string | null): boolean => {
      const latestState = get();
      if (latestState.loadRequestId !== requestId) {
        return true;
      }
      const selectedTask = resolveSelectedTask(deps);
      return (selectedTask?.id ?? null) !== taskId;
    };

    if (!deps.tauri.isTauriAvailable()) {
      set({
        ...resetLoadState,
        currentTaskId: null,
        currentTaskLoadState: 'idle',
        currentTaskLoadMessage: null,
        isLoading: false,
        loadRequestId: nextLoadRequestId,
        executionRecords: {},
      });
      return;
    }

    if (!task) {
      set({
        ...resetLoadState,
        currentTaskId: null,
        currentTaskLoadState: 'idle',
        currentTaskLoadMessage: null,
        isLoading: false,
        loadRequestId: nextLoadRequestId,
        executionRecords: {},
      });
      return;
    }

    const sameTask = previousState.currentTaskId === task.id;
    const silentReload = sameTask && options?.silent === true;
    const previousRepositories = new Map(
      (sameTask ? previousState.repositories : []).map((repository) => [repository.id, repository])
    );
    const executionRecords = sameTask ? previousState.executionRecords : {};
    const previousSelectedRepositoryId = sameTask ? previousState.selectedRepositoryId : null;
    const previousSelectedDiffTarget = sameTask ? previousState.selectedDiffTarget : null;
    const previousDiffModalSession = sameTask ? previousState.diffModalSession : null;
    const previousIsDiffModalOpen = sameTask && previousState.isDiffModalOpen;

    if (silentReload) {
      set({
        currentTaskId: task.id,
        lastError: null,
        loadRequestId: nextLoadRequestId,
        executionRecords,
      });
    } else {
      set({
        ...resetLoadState,
        currentTaskId: task.id,
        currentTaskLoadState: 'loading',
        currentTaskLoadMessage: null,
        isLoading: true,
        lastError: null,
        loadRequestId: nextLoadRequestId,
        executionRecords,
      });
    }

    try {
      const executionTargets = getExecutionTargets(deps, task);
      const unresolvedTargets = executionTargets.filter(
        (target) => !resolveRepositoryWorktreePath(deps, target, task)
      );

      if (unresolvedTargets.length > 0) {
        if (isStaleRequest(nextLoadRequestId, task.id)) {
          return;
        }

        set({
          ...resetLoadState,
          currentTaskId: task.id,
          currentTaskLoadState: shouldTreatMissingWorktreeAsPending(task)
            ? 'awaiting_worktree'
            : 'invalid_mapping',
          currentTaskLoadMessage: shouldTreatMissingWorktreeAsPending(task)
            ? buildAwaitingWorktreeMessage(task)
            : buildMissingWorktreeMessage(task, unresolvedTargets),
          isLoading: false,
          lastError: null,
          executionRecords: {},
        });
        return;
      }

      const repositories = await Promise.all(
        executionTargets.map((target) => {
          const repositoryId = buildRepositoryId(target);
          return loadRepositoryState({
            deps,
            task,
            target,
            previousRepository: previousRepositories.get(repositoryId),
            committedRecord: executionRecords[repositoryId],
          });
        })
      );

      if (isStaleRequest(nextLoadRequestId, task.id)) {
        return;
      }

      const derivedReviewState = deriveReviewState(repositories, previousSelectedRepositoryId);
      const selectedDiffTarget =
        previousSelectedDiffTarget &&
          repositories.some((repository) =>
            repository.id === previousSelectedDiffTarget.repositoryId &&
            repository.changes.some((change) => change.id === previousSelectedDiffTarget.changeId)
          )
          ? previousSelectedDiffTarget
          : null;
      const diffModalSession =
        options?.preserveDiffModalSession &&
        previousDiffModalSession &&
        selectedDiffTarget &&
        previousDiffModalSession.repositoryId === selectedDiffTarget.repositoryId &&
        previousDiffModalSession.changeId === selectedDiffTarget.changeId
          ? {
            ...previousDiffModalSession,
            isSaving: false,
            isHydratingFullContext: false,
          }
          : null;

      set({
        currentTaskId: task.id,
        currentTaskLoadState: 'ready',
        currentTaskLoadMessage: null,
        repositories,
        selectedRepositoryId: derivedReviewState.selectedRepositoryId,
        reviewSummary: derivedReviewState.reviewSummary,
        selectedDiffTarget,
        diffModalSession,
        isDiffModalOpen: Boolean(selectedDiffTarget) && previousIsDiffModalOpen,
        isLoading: false,
        lastError: null,
        executionRecords,
      });

      syncActiveReviewRepository(
        deps,
        repositories.find((repository) => repository.id === derivedReviewState.selectedRepositoryId) || repositories[0]
      );
    } catch (error) {
      if (isStaleRequest(nextLoadRequestId, task.id)) {
        return;
      }

      set({
        ...resetLoadState,
        currentTaskId: task.id,
        currentTaskLoadState: 'invalid_mapping',
        currentTaskLoadMessage: null,
        isLoading: false,
        executionRecords: {},
        lastError:
          error instanceof Error
            ? error.message
            : tChanges('implement.errors.loadChangesFailed', 'Failed to load repository changes.'),
      });
    }
  },

  resetReviewState: () => {
    set({
      currentTaskId: null,
      currentTaskLoadState: 'idle',
      currentTaskLoadMessage: null,
      loadRequestId: get().loadRequestId + 1,
      repositories: [],
      selectedRepositoryId: null,
      reviewSummary: EMPTY_REVIEW_TASK_SUMMARY,
      selectedDiffTarget: null,
      diffModalSession: null,
      isDiffModalOpen: false,
      isLoading: false,
      isCommitting: false,
      lastError: null,
      lastCommitHash: null,
      executionRecords: {},
    });
  },

  selectRepository: (repositoryId) => {
    const derivedReviewState = deriveReviewState(get().repositories, repositoryId);
    const repository = derivedReviewState.selectedRepositoryId
      ? get().repositories.find((candidate) => candidate.id === derivedReviewState.selectedRepositoryId)
      : null;
    set(derivedReviewState);
    syncActiveReviewRepository(deps, repository);
  },

  openDiffModal: (repositoryId, changeId) => {
    const repositories = get().repositories;
    const change = repositories
      .find((candidate) => candidate.id === repositoryId)
      ?.changes.find((candidate) => candidate.id === changeId);
    if (!change) {
      return;
    }
    const derivedReviewState = deriveReviewState(repositories, repositoryId);
    const repository = derivedReviewState.selectedRepositoryId
      ? repositories.find((candidate) => candidate.id === derivedReviewState.selectedRepositoryId) ?? null
      : null;
    set({
      selectedRepositoryId: derivedReviewState.selectedRepositoryId,
      reviewSummary: derivedReviewState.reviewSummary,
      selectedDiffTarget: { repositoryId, changeId },
      diffModalSession: buildDiffModalSession(repositoryId, change, {
        isHydratingFullContext: true,
      }),
      isDiffModalOpen: true,
    });
    void hydrateDiffModalFile(repositoryId, changeId);
    syncActiveReviewRepository(deps, repository);
  },

  closeDiffModal: () => {
    set({
      selectedDiffTarget: null,
      diffModalSession: null,
      isDiffModalOpen: false,
    });
  },

  setReviewedState: (repositoryId, changeIds, reviewed) => {
    if (changeIds.length === 0) {
      return;
    }

    set((state) => ({
      ...(() => {
        const repositories = updateRepositoryState(state.repositories, repositoryId, (repository) => {
          const changes = updateReviewedStateForChangeIds(repository.changes, changeIds, reviewed);
          return {
            ...repository,
            changes,
            stats: computeStats(changes),
          };
        });
        return {
          repositories,
          ...deriveReviewState(repositories, state.selectedRepositoryId),
        };
      })(),
    }));
  },

  markAsReviewed: (repositoryId, changeId) => {
    get().setReviewedState(repositoryId, [changeId], true);
  },

  markAsUnreviewed: (repositoryId, changeId) => {
    get().setReviewedState(repositoryId, [changeId], false);
  },

  markAllAsReviewed: (repositoryId) => {
    const targetRepositoryId = repositoryId || get().selectedRepositoryId;
    if (!targetRepositoryId) return;
    const repository = get().getRepository(targetRepositoryId);
    if (!repository) return;
    get().setReviewedState(targetRepositoryId, repository.changes.map((change) => change.id), true);
  },

  revertChanges: async (repositoryId, changeIds) => {
    if (changeIds.length === 0) {
      return;
    }

    const repository = get().getRepository(repositoryId);
    if (!repository) {
      throw new Error(
        tChanges('implement.errors.noActiveRepositoryPath', 'No active repository path found for this task.')
      );
    }

    if (!deps.tauri.isTauriAvailable()) {
      throw new Error(
        tChanges('implement.errors.commitDesktopOnly', 'Git commit flow is only available in desktop mode.')
      );
    }

    const targetIds = new Set(changeIds);
    const targetChanges = repository.changes.filter((change) => targetIds.has(change.id));
    if (targetChanges.length === 0) {
      return;
    }

    const selectedDiffTarget = get().selectedDiffTarget;
    const affectsOpenModal =
      selectedDiffTarget?.repositoryId === repositoryId && targetIds.has(selectedDiffTarget.changeId);
    const nextChangeIdAfterRevert = (() => {
      if (!affectsOpenModal || !selectedDiffTarget) return null;
      const currentIndex = repository.changes.findIndex((change) => change.id === selectedDiffTarget.changeId);
      if (currentIndex < 0) return null;
      for (let index = currentIndex + 1; index < repository.changes.length; index += 1) {
        const candidate = repository.changes[index];
        if (!targetIds.has(candidate.id)) {
          return candidate.id;
        }
      }
      return null;
    })();

    set((state) => ({
      repositories: updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
        ...currentRepository,
        savingChangeId:
          targetChanges.length === 1 ? targetChanges[0]?.id ?? currentRepository.savingChangeId : '__batch_revert__',
        lastError: null,
      })),
      diffModalSession:
        state.diffModalSession && state.diffModalSession.repositoryId === repositoryId
          ? {
            ...state.diffModalSession,
            isSaving: true,
          }
          : state.diffModalSession,
      lastError: null,
    }));

    try {
      await deps.tauri.gitRestorePaths({
        repoPath: repository.worktreePath,
        paths: targetChanges.map((change) => change.path),
      });

      await get().loadCurrentChanges({ silent: true, preserveDiffModalSession: true });

      if (affectsOpenModal) {
        const refreshedRepository = get().getRepository(repositoryId);
        if (nextChangeIdAfterRevert && refreshedRepository?.changes.some((change) => change.id === nextChangeIdAfterRevert)) {
          get().openDiffModal(repositoryId, nextChangeIdAfterRevert);
        } else {
          get().closeDiffModal();
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : tChanges('implement.errors.revertChangesFailed', 'Failed to revert changes.');
      set((state) => ({
        repositories: updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
          ...currentRepository,
          savingChangeId: null,
          lastError: message,
        })),
        diffModalSession:
          state.diffModalSession && state.diffModalSession.repositoryId === repositoryId
            ? {
              ...state.diffModalSession,
              isSaving: false,
            }
            : state.diffModalSession,
        lastError: message,
      }));
      throw error;
    } finally {
      set((state) => ({
        repositories: updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
          ...currentRepository,
          savingChangeId: null,
        })),
        diffModalSession:
          state.diffModalSession && state.diffModalSession.repositoryId === repositoryId
            ? {
              ...state.diffModalSession,
              isSaving: false,
            }
            : state.diffModalSession,
      }));
    }
  },

  updateRightDraft: (content) => {
    set((state) => {
      const session = state.diffModalSession;
      if (!session) {
        return state;
      }
      return {
        diffModalSession: {
          ...session,
          rightDraftContent: content,
          isDirty: content !== session.lastLoadedModifiedContent,
        },
      };
    });
  },

  resetRightDraft: () => {
    set((state) => {
      const session = state.diffModalSession;
      if (!session) {
        return state;
      }
      return {
        diffModalSession: {
          ...session,
          rightDraftContent: session.lastLoadedModifiedContent,
          isDirty: false,
        },
      };
    });
  },

  saveRightDraft: async () => {
    const session = get().diffModalSession;
    if (!session) return;
    const repository = get().getRepository(session.repositoryId);
    const change = get().getChange(session.repositoryId, session.changeId);
    if (!repository || !change || !change.canEdit) return;

    if (!deps.tauri.isTauriAvailable()) {
      throw new Error(
        tChanges('implement.errors.commitDesktopOnly', 'Git commit flow is only available in desktop mode.')
      );
    }

    const nextContent = session.rightDraftContent;

    set((state) => ({
      repositories: updateRepositoryState(state.repositories, session.repositoryId, (currentRepository) => ({
        ...currentRepository,
        savingChangeId: session.changeId,
        lastError: null,
      })),
      diffModalSession: state.diffModalSession
        ? {
          ...state.diffModalSession,
          isSaving: true,
        }
        : null,
      lastError: null,
    }));

    try {
      await deps.tauri.fsWriteFile({
        path: resolveChangeFilePath(repository.worktreePath, change.path),
        content: nextContent,
        createDirs: true,
        allowOutsideWorkspace: true,
      });

      set((state) => ({
        ...(() => {
          const repositories = updateRepositoryState(state.repositories, session.repositoryId, (currentRepository) => ({
            ...currentRepository,
            changes: updateChangeEntry(currentRepository.changes, session.changeId, (entry) => ({
              ...entry,
              reviewed: false,
            })),
            savingChangeId: null,
            lastError: null,
          }));
          return {
            repositories,
            ...deriveReviewState(repositories, state.selectedRepositoryId),
          };
        })(),
        diffModalSession: state.diffModalSession
          ? {
            ...state.diffModalSession,
            rightDraftContent: nextContent,
            lastLoadedModifiedContent: nextContent,
            isDirty: false,
            isSaving: false,
          }
          : null,
      }));

      await get().loadCurrentChanges({ silent: true, preserveDiffModalSession: true });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : tChanges('implement.errors.loadChangesFailed', 'Failed to load repository changes.');
      set((state) => ({
        repositories: updateRepositoryState(state.repositories, session.repositoryId, (currentRepository) => ({
          ...currentRepository,
          savingChangeId: null,
          lastError: message,
        })),
        diffModalSession: state.diffModalSession
          ? {
            ...state.diffModalSession,
            isSaving: false,
          }
          : null,
        lastError: message,
      }));
      throw error;
    }
  },

  goToAdjacentDiff: (direction) => {
    const state = get();
    const session = state.diffModalSession;
    if (!session) return;
    const repository = state.getRepository(session.repositoryId);
    if (!repository) return;
    const currentIndex = repository.changes.findIndex((change) => change.id === session.changeId);
    if (currentIndex < 0) return;
    const nextIndex = direction === 'previous' ? currentIndex - 1 : currentIndex + 1;
    const nextChange = repository.changes[nextIndex];
    if (!nextChange) return;
    state.openDiffModal(repository.id, nextChange.id);
  },

  commitReviewedChanges: async (repositoryId, message) => {
    const task = ensureReviewTask(deps);
    const repository = get().getRepository(repositoryId);
    const commitMessage = (message || repository?.commitMessageDraft || toDefaultCommitMessage(task.title)).trim();
    if (!commitMessage) {
      throw new Error(tChanges('implement.errors.commitMessageRequired', 'Commit message is required.'));
    }
    if (task.status !== 'InReview') {
      throw new Error(
        tChanges('implement.errors.commitRequiresValidationStage', 'Task must be in validation before commit.')
      );
    }

    if (!repository) {
      throw new Error(
        tChanges('implement.errors.noActiveRepositoryPath', 'No active repository path found for this task.')
      );
    }

    if (repository.commitState === 'committed') {
      throw new Error(
        tChanges('implement.errors.repositoryAlreadyCommitted', 'This repository has already been committed.')
      );
    }

    if (repository.changes.length === 0) {
      throw new Error(tChanges('implement.errors.commitNoChanges', 'No file changes available for this task.'));
    }

    const reviewedPaths = Array.from(
      new Set(
        repository.changes
          .filter((change) => change.reviewed)
          .map((change) => change.path)
          .filter((path) => path.trim().length > 0)
      )
    );

    if (reviewedPaths.length !== repository.changes.length) {
      throw new Error(
        tChanges('implement.errors.commitNeedsValidation', 'Validate all file changes before committing this task.')
      );
    }

    const integrationBranchName = repository.planBranchName || (
      task.task_source === 'standalone' ? deps.getGitFlowBaseBranch() : null
    );
    if (!integrationBranchName) {
      throw new Error(
        tChanges(
          'implement.errors.missingIntegrationBranch',
          'Cannot determine the integration branch for task {{taskId}}.',
          { taskId: task.id }
        )
      );
    }

    set((state) => ({
      isCommitting: true,
      lastError: null,
      ...(() => {
        const repositories = updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
          ...currentRepository,
          commitState: 'committing',
          commitMessageDraft: commitMessage,
          lastError: null,
        }));
        return {
          repositories,
          ...deriveReviewState(repositories, state.selectedRepositoryId),
        };
      })(),
    }));

    try {
      await ensureNoForeignStagedFiles(deps, repository.worktreePath, reviewedPaths);
      await deps.tauri.gitAdd({
        repoPath: repository.worktreePath,
        paths: reviewedPaths,
      });

      const hash = await deps.tauri.gitCommit({
        repoPath: repository.worktreePath,
        message: commitMessage,
        stageAll: false,
      });

      const executionRecord: TaskCompletionRepositoryRecord = {
        projectId: repository.projectId,
        repoPath: repository.repoPath,
        branchName: repository.branchName,
        planBranchName: integrationBranchName,
      };

      const currentState = get();
      const nextExecutionRecords = {
        ...currentState.executionRecords,
        [repositoryId]: executionRecord,
      };
      const nextRepositories = currentState.repositories.map((currentRepository) => {
        if (currentRepository.id !== repositoryId) {
          return currentRepository;
        }
        return {
          ...currentRepository,
          changes: [],
          selectedChangeId: null,
          stats: EMPTY_STATS,
          commitMessageDraft: commitMessage,
          commitState: 'committed' as const,
          loadingChangeId: null,
          savingChangeId: null,
          lastError: null,
          lastCommitHash: hash,
        };
      });

      const derivedReviewState = deriveReviewState(nextRepositories, repositoryId);
      const nextSelectedRepository = derivedReviewState.selectedRepositoryId
        ? nextRepositories.find((candidate) => candidate.id === derivedReviewState.selectedRepositoryId) ?? null
        : null;

      set({
        repositories: nextRepositories,
        selectedRepositoryId: derivedReviewState.selectedRepositoryId,
        reviewSummary: derivedReviewState.reviewSummary,
        executionRecords: nextExecutionRecords,
        isCommitting: false,
        lastCommitHash: hash,
        lastError: null,
      });
      syncActiveReviewRepository(deps, nextSelectedRepository);

      const completionRecords = nextRepositories.map((currentRepository) =>
        nextExecutionRecords[currentRepository.id] ||
        buildCompletionRepositoryRecord(deps, currentRepository)
      );
      const allRepositoriesResolved = nextRepositories.every((currentRepository) =>
        currentRepository.commitState === 'committed' || currentRepository.commitState === 'no_changes'
      );

      let taskCompleted = false;
      let taskStatus: TaskStatus | null = deps.getTaskState().getTaskById(task.id)?.status ?? null;
      if (allRepositoriesResolved) {
        await deps.getTaskState().setTaskStatus(task.id, 'InProgress');
        taskStatus = deps.getTaskState().getTaskById(task.id)?.status ?? null;
      }

      return {
        hash,
        taskId: task.id,
        taskCompleted,
        taskStatus,
        committedRepositoryId: repositoryId,
        repositories: completionRecords,
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      set((state) => ({
        isCommitting: false,
        lastError: messageText,
        ...(() => {
          const repositories = updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
            ...currentRepository,
            commitState: currentRepository.changes.length === 0 ? 'no_changes' : 'idle',
            lastError: messageText,
          }));
          return {
            repositories,
            ...deriveReviewState(repositories, state.selectedRepositoryId),
          };
        })(),
      }));
      throw error;
    }
  },

  setCommitMessageDraft: (repositoryId, message) => {
    set((state) => ({
      repositories: updateRepositoryState(state.repositories, repositoryId, (repository) => ({
        ...repository,
        commitMessageDraft: message,
      })),
    }));
  },

  getRepository: (repositoryId) => {
    return get().repositories.find((repository) => repository.id === repositoryId);
  },

  getSelectedRepository: () => {
    const selectedRepositoryId = get().selectedRepositoryId;
    if (!selectedRepositoryId) return undefined;
    return get().repositories.find((repository) => repository.id === selectedRepositoryId);
  },

  getChange: (repositoryId, changeId) => {
    return get().repositories
      .find((repository) => repository.id === repositoryId)
      ?.changes.find((change) => change.id === changeId);
  },

  getDiffModalSession: () => get().diffModalSession,

  getSelectedDiffTarget: () => get().selectedDiffTarget,

  getStats: (repositoryId) => {
    const targetRepositoryId = repositoryId || get().selectedRepositoryId;
    if (!targetRepositoryId) return EMPTY_STATS;
    return get().repositories.find((repository) => repository.id === targetRepositoryId)?.stats || EMPTY_STATS;
  },

  getOverallStats: () => {
    const repositories = get().repositories;
    return repositories.reduce<ReviewRepositoryStats>((aggregate, repository) => ({
      total: aggregate.total + repository.stats.total,
      reviewed: aggregate.reviewed + repository.stats.reviewed,
      additions: aggregate.additions + repository.stats.additions,
      deletions: aggregate.deletions + repository.stats.deletions,
    }), { ...EMPTY_STATS });
  },

  getReviewSummary: () => get().reviewSummary,
    });
  });
};

export const useFileChangesStore = createFileChangesStore();
