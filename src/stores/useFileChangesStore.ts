import { create } from 'zustand';
import i18n from '../i18n';
import {
  type ParsedDiffContent,
  type ParsedDiffHunk,
  buildParsedDiffFromTextPair,
  buildStableLineNumberMap,
} from '../services/gitDiffParser';
import * as tauriIpc from '../services/tauriIpc';
import { useTaskStore, type TaskCompletionRepositoryRecord } from './useTaskStore';
import type { Project, ProjectGroup, TaskExecutionTarget, TaskStatus } from '../types';
import {
  buildReviewTaskSummary,
  type ReviewTaskSummary,
} from '../services/implementMultiRepoSummary';
import { useAppStore } from './useAppStore';
import { getGitFlowBaseBranch } from '../services/architectPlanService';
import {
  SERVICE_ERROR_CODES,
  isReviewSuspendingError,
  toServiceError,
  type ServiceError,
} from '../services/contracts/errors';
import {
  buildFileChangesRepositoryId,
  getFileChangesExecutionTargets,
} from '../services/fileChangesReviewScope';
import {
  resolveCachedPreparedTaskWorktreePath,
  resolvePreparedTaskWorktreePath,
} from '../services/preparedTaskWorktrees';
import { resolveProjectExecutionMode } from '../services/projectExecutionMode';
import { getGlobalProjectById, getRepositoryScopedProjectIds } from '../services/globalProjects';
import { resolveStandaloneTargetBranchName } from '../services/standaloneTargetBranch';
import {
  SmartCommitMessageGenerationError,
  formatGeneratedCommitMessageForRepository,
  generateSmartCommitMessages,
  isSmartCommitMessageGenerationError,
  stripGeneratedCommitScopes,
  type GeneratedCommitMessages,
  type GenerateSmartCommitMessagesOptions,
  type GenerateSmartCommitMessagesInput,
} from '../services/smartCommitMessageGenerator';
import {
  validateConventionalCommitMessage,
} from '../services/conventionalCommit';
import type { MetadataModelConfig } from '../services/metadataModelConfig';
import {
  buildDefaultCommitMessage,
  getReadyCommitRepositories,
  isRepositoryReadyToCommit,
} from '../services/smartCommitDrafts';

export type DiffPresentationMode = 'focused' | 'full';
export type FileChangeContextMode = DiffPresentationMode;
export type ReviewRepositoryCommitState = 'idle' | 'committing' | 'committed' | 'no_changes';
const EMPTY_FILE_CHANGES_REVIEW_SUMMARY: ReviewTaskSummary = {
  repositoryCount: 0,
  stateCounts: {
    pending_validation: 0,
    ready_to_commit: 0,
    committed: 0,
    no_changes: 0,
  },
  actionCounts: {
    pending_validation: 0,
    ready_to_commit: 0,
  },
  repositories: [],
  nextRepositoryId: null,
  nextAction: 'none',
  hasCommittedRepositories: false,
  hasActionableRepositories: false,
  allRepositoriesResolved: false,
  allRepositoriesNoChanges: false,
};
export type FileChangesTaskLoadState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'out_of_scope'
  | 'awaiting_worktree'
  | 'invalid_mapping';

export interface FileChangeEntry {
  id: string;
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  originalContent: string;
  indexContent: string;
  modifiedContent: string;
  language: string;
  hunks: ParsedDiffHunk[];
  contextMode: DiffPresentationMode;
  canEdit: boolean;
  hasPendingVisibleChange: boolean;
  hasValidatedStage: boolean;
  validatedRemovedLineNumbers: number[];
  validatedAddedLineNumbers: number[];
  isBinary?: boolean;
  tooLarge?: boolean;
  requiresHydration?: boolean;
}

export interface ReviewRepositoryStats {
  pendingVisibleFileCount: number;
  validatedStagedFileCount: number;
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
  executionMode?: 'git' | 'direct';
  executionKind?: 'worktree' | 'repository_root';
  checkpointId?: string;
  baseCommitHash?: string;
  directSnapshotId?: string;
  restoreRevisions?: Record<string, string>;
  changes: FileChangeEntry[];
  stagedPaths: string[];
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
  pendingChangeIds: string[];
  stagedChangeIds: string[];
  hasPendingVisibleChanges: boolean;
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

export interface CommitTaskRepositoriesResult {
  taskId: string;
  taskCompleted: boolean;
  taskStatus: TaskStatus | null;
  commits: CommitTaskChangesResult[];
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
  directSnapshotId?: string;
  restoreRevision?: string;
}

interface LoadCurrentChangesOptions {
  silent?: boolean;
  preserveDiffModalSession?: boolean;
  preserveReviewSuspension?: boolean;
}

const DEBUG_FILE_DIFF_STORAGE_KEY = 'debug:file-diff';

const isFileDiffDebugEnabled = (): boolean =>
  Boolean(import.meta.env?.DEV) &&
  typeof window !== 'undefined' &&
  window.localStorage.getItem(DEBUG_FILE_DIFF_STORAGE_KEY) === '1';

const debugFileDiffStoreLog = (event: string, details?: Record<string, unknown>): void => {
  if (!isFileDiffDebugEnabled()) {
    return;
  }

  console.debug(`[FileChangesStore] ${event}`, details ?? {});
};

const EMPTY_STATS: ReviewRepositoryStats = {
  pendingVisibleFileCount: 0,
  validatedStagedFileCount: 0,
  additions: 0,
  deletions: 0,
};

interface FileChangesProjectRef {
  id: string;
  path: string;
  name?: string | null;
  directEdit?: boolean;
  gitSetupState?: Project['gitSetupState'];
  userReadOnly?: boolean;
  isReadOnly?: boolean;
}

interface FileChangesTaskLike {
  id: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  task_source: 'architect' | 'mixed' | 'fallback' | 'empty' | 'standalone' | 'plan_finalization';
  project_id?: string | null;
  assigned_branch: string;
  base_branch?: string | null;
  execution_targets?: TaskExecutionTarget[];
}

interface FileChangesGitStatus {
  branch: string;
  head_commit?: { id?: string; hash: string } | null;
  staged_files: Array<{ path: string; status: string }>;
  unstaged_files: Array<{ path: string; status: string }>;
  untracked_files: Array<{ path: string; status: string }>;
  is_clean: boolean;
}

const hasHeadMovedFromBase = (
  headCommit: FileChangesGitStatus['head_commit'],
  baseCommitHash: string,
): boolean => Boolean(
  headCommit && headCommit.id !== baseCommitHash && headCommit.hash !== baseCommitHash
);

type FileChangesTauriDeps = Pick<
  typeof tauriIpc,
  | 'isTauriAvailable'
  | 'gitDiff'
  | 'gitMergeCheck'
  | 'gitReadFilePair'
  | 'fsExists'
  | 'fsReadFileWithOptions'
  | 'fsWriteFile'
  | 'gitAdd'
  | 'gitCommit'
  | 'gitRestorePaths'
  | 'gitWorktreeInspect'
> & {
  gitStatus: (repoPath: string) => Promise<FileChangesGitStatus>;
  gitReviewSnapshot?: typeof tauriIpc.gitReviewSnapshot;
  gitCancelReview?: typeof tauriIpc.gitCancelReview;
  gitReviewFile?: typeof tauriIpc.gitReviewFile;
  directReviewSnapshot?: typeof tauriIpc.directReviewSnapshot;
  directCheckpointEnsure?: typeof tauriIpc.directCheckpointEnsure;
  directCheckpointResolveId?: typeof tauriIpc.directCheckpointResolveId;
  workspaceBindManualFeatureDirectCheckpoint?:
    typeof tauriIpc.workspaceBindManualFeatureDirectCheckpoint;
  directReviewFile?: typeof tauriIpc.directReviewFile;
  directStagePaths?: typeof tauriIpc.directStagePaths;
  directUnstagePaths?: typeof tauriIpc.directUnstagePaths;
  directRestoreWorktreePaths?: typeof tauriIpc.directRestoreWorktreePaths;
  directAcceptChanges?: typeof tauriIpc.directAcceptChanges;
};

interface FileChangesAppState {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  standaloneProjects?: Project[];
  projectGroups: ProjectGroup[];
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
  activeBranchName?: string | null;
  activeRepositoryPath?: string | null;
  branchWorktrees?: Record<string, string>;
}) => void;

export interface FileChangesStoreDependencies {
  tauri: FileChangesTauriDeps;
  getGitFlowBaseBranch: typeof getGitFlowBaseBranch;
  getAppState: () => FileChangesAppState;
  getTaskState: () => FileChangesTaskStoreState;
  setTaskState: FileChangesSetTaskState;
  generateCommitMessages: (
    input: GenerateSmartCommitMessagesInput,
    options?: GenerateSmartCommitMessagesOptions
  ) => Promise<GeneratedCommitMessages>;
}

const getDefaultFileChangesStoreDependencies = (): FileChangesStoreDependencies => ({
  get tauri() {
    return tauriIpc;
  },
  get getGitFlowBaseBranch() {
    return getGitFlowBaseBranch;
  },
  getAppState: () => useAppStore.getState(),
  getTaskState: () => useTaskStore.getState(),
  setTaskState: (partial) => useTaskStore.setState(partial),
  get generateCommitMessages() {
    return generateSmartCommitMessages;
  },
});

const resolveReviewRepositoryIntegrationBranch = (
  deps: FileChangesStoreDependencies,
  task: FileChangesTaskLike,
  options: {
    existingPlanBranchName?: string | null;
    repositoryId?: string | null;
    target?: TaskExecutionTarget | null;
  } = {}
): string | null => {
  if (options.existingPlanBranchName) {
    return options.existingPlanBranchName;
  }

  if (task.task_source !== 'standalone') {
    return null;
  }

  const executionTarget =
    options.target ||
    getFileChangesExecutionTargets(task, deps.getGitFlowBaseBranch).find(
      (target) =>
        buildFileChangesRepositoryId(target) === options.repositoryId
    ) ||
    null;

  return resolveStandaloneTargetBranchName(task, executionTarget);
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
          pendingChangeIds: isFile && change.hasPendingVisibleChange ? [change.id] : [],
          stagedChangeIds: isFile && change.hasValidatedStage ? [change.id] : [],
          hasPendingVisibleChanges: isFile && change.hasPendingVisibleChange,
          children: isFile ? undefined : [],
          fileChange: isFile ? change : undefined,
        };
        current.push(existing);
      }

      if (!isFile) {
        existing.changeIds = [...existing.changeIds, change.id];
        if (change.hasPendingVisibleChange) {
          existing.pendingChangeIds = [...existing.pendingChangeIds, change.id];
        }
        if (change.hasValidatedStage) {
          existing.stagedChangeIds = [...existing.stagedChangeIds, change.id];
        }
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
        pendingChangeIds: node.fileChange?.hasPendingVisibleChange ? [node.fileChange.id] : [],
        stagedChangeIds: node.fileChange?.hasValidatedStage ? [node.fileChange.id] : [],
        hasPendingVisibleChanges: Boolean(node.fileChange?.hasPendingVisibleChange),
      };
    }

    const children = (node.children || []).map(annotateNode);
    return {
      ...node,
      children,
      changeIds: children.flatMap((child) => child.changeIds),
      pendingChangeIds: children.flatMap((child) => child.pendingChangeIds),
      stagedChangeIds: children.flatMap((child) => child.stagedChangeIds),
      hasPendingVisibleChanges: children.some((child) => child.hasPendingVisibleChanges),
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

const isUnsupportedGitReviewCommandError = (error: unknown): boolean => {
  const message = toServiceError(error).message.toLowerCase();
  if (!message) return false;
  const mentionsReviewCommand =
    message.includes('git_review_snapshot') ||
    message.includes('git_review_file') ||
    message.includes('gitreviewsnapshot') ||
    message.includes('gitreviewfile');
  const isUnsupported =
    message.includes('unknown command') ||
    message.includes('command not found') ||
    message.includes('unsupported') ||
    message.includes('not implemented');
  return mentionsReviewCommand && isUnsupported;
};

const mergeFileChangesTauriDeps = (
  defaults: FileChangesTauriDeps,
  overrides?: Partial<FileChangesTauriDeps>
): FileChangesTauriDeps => {
  if (!overrides) {
    return defaults;
  }

  return {
    ...defaults,
    ...overrides,
    ...(!('gitReviewSnapshot' in overrides) ? { gitReviewSnapshot: undefined } : {}),
    ...(!('gitReviewFile' in overrides) ? { gitReviewFile: undefined } : {}),
    ...(!('gitCancelReview' in overrides) ? { gitCancelReview: undefined } : {}),
  };
};

const normalizeBranchName = (value?: string | null): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || 'work';
};

const computeStats = (changes: FileChangeEntry[], stagedPathCount: number): ReviewRepositoryStats => {
  const pendingChanges = changes.filter((change) => change.hasPendingVisibleChange);
  return {
    // These counts intentionally describe two independent Git buckets.
    // A partially staged file can therefore contribute to both numbers.
    pendingVisibleFileCount: pendingChanges.length,
    validatedStagedFileCount: stagedPathCount,
    additions: pendingChanges.reduce((sum, change) => sum + change.additions, 0),
    deletions: pendingChanges.reduce((sum, change) => sum + change.deletions, 0),
  };
};

const MAX_COMMIT_FILE_SUMMARY_CHARS = 1200;
const SMART_COMMIT_MESSAGE_GENERATION_ATTEMPTS = 3;

const summarizeLineChanges = (before: string, after: string): string => {
  if (before === after) {
    return 'No textual difference detected.';
  }

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  const snippets: string[] = [];

  for (let index = 0; index < maxLines && snippets.join('\n').length < MAX_COMMIT_FILE_SUMMARY_CHARS; index += 1) {
    const beforeLine = beforeLines[index] ?? '';
    const afterLine = afterLines[index] ?? '';
    if (beforeLine === afterLine) {
      continue;
    }
    if (beforeLine) {
      snippets.push(`- ${beforeLine}`);
    }
    if (afterLine) {
      snippets.push(`+ ${afterLine}`);
    }
  }

  return snippets.join('\n').slice(0, MAX_COMMIT_FILE_SUMMARY_CHARS) || 'Binary or metadata-only change.';
};

const buildSmartCommitMessageInput = async (
  deps: FileChangesStoreDependencies,
  task: FileChangesTaskLike,
  repositories: ReviewRepositoryState[]
): Promise<GenerateSmartCommitMessagesInput> => {
  const appState = deps.getAppState();

  return {
    task: {
      id: task.id,
      title: task.title,
      description: task.description ?? null,
    },
    repositories: await Promise.all(repositories.map(async (repository) => {
      const project = appState.getProjectById(repository.projectId);
      const files = await Promise.all(repository.stagedPaths.map(async (path) => {
        if (repository.executionMode === 'direct') {
          const change = repository.changes.find((candidate) => candidate.path === path);
          return {
            path,
            summary: change
              ? summarizeLineChanges(change.originalContent, change.indexContent)
              : 'Unable to inspect validated file content; summarize from the path.',
          };
        }
        try {
          const pair = await deps.tauri.gitReadFilePair({
            repoPath: repository.worktreePath,
            path,
          });
          return {
            path,
            summary: summarizeLineChanges(pair.headContent ?? '', pair.indexContent ?? ''),
          };
        } catch {
          return {
            path,
            summary: 'Unable to inspect staged file content; summarize from the path.',
          };
        }
      }));

      return {
        repositoryId: repository.id,
        projectId: repository.projectId,
        projectName: project?.name ?? null,
        branchName: repository.branchName,
        stagedPaths: repository.stagedPaths,
        additions: repository.stats.additions,
        deletions: repository.stats.deletions,
        files,
      };
    })),
  };
};

const generateCommitMessagesWithRetry = async (
  deps: FileChangesStoreDependencies,
  input: GenerateSmartCommitMessagesInput,
  options: GenerateSmartCommitMessagesOptions = {}
): Promise<GeneratedCommitMessages> => {
  let lastError: unknown = null;
  let validationFeedback = options.validationFeedback ?? null;
  for (let attempt = 0; attempt < SMART_COMMIT_MESSAGE_GENERATION_ATTEMPTS; attempt += 1) {
    try {
      return await deps.generateCommitMessages(input, {
        ...options,
        validationFeedback,
      });
    } catch (error) {
      lastError = error;
      if (isSmartCommitMessageGenerationError(error) && error.generatedMessages) {
        validationFeedback = error.message;
      }
    }
  }

  if (isSmartCommitMessageGenerationError(lastError)) {
    throw lastError;
  }

  const message = toServiceError(lastError).message ||
    tChanges('implement.errors.commitMessageGenerationFailed', 'Could not generate commit messages.');
  throw new SmartCommitMessageGenerationError(message);
};

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

const collectChangedLineNumbers = (parsed: ParsedDiffContent) => {
  const removed = new Set<number>();
  const added = new Set<number>();

  parsed.hunks.forEach((hunk) => {
    hunk.lines.forEach((line) => {
      if (line.type === 'removed' && typeof line.oldLineNumber === 'number') {
        removed.add(line.oldLineNumber);
      }
      if (line.type === 'added' && typeof line.newLineNumber === 'number') {
        added.add(line.newLineNumber);
      }
    });
  });

  return {
    removed: Array.from(removed).sort((left, right) => left - right),
    added: Array.from(added).sort((left, right) => left - right),
  };
};

const buildValidatedStageDecorations = (params: {
  headContent: string;
  indexContent: string;
  worktreeContent: string;
}) => {
  const stagedParsed = buildParsedDiffFromTextPair(params.headContent, params.indexContent);
  if (stagedParsed.hunks.length === 0) {
    return {
      hasValidatedStage: false,
      validatedRemovedLineNumbers: [] as number[],
      validatedAddedLineNumbers: [] as number[],
    };
  }

  const stagedLineNumbers = collectChangedLineNumbers(stagedParsed);
  const stableIndexToWorktree = buildStableLineNumberMap(params.indexContent, params.worktreeContent);
  const validatedAddedLineNumbers = stagedLineNumbers.added
    .map((lineNumber) => stableIndexToWorktree.get(lineNumber) ?? null)
    .filter((lineNumber): lineNumber is number => typeof lineNumber === 'number');

  return {
    hasValidatedStage:
      stagedLineNumbers.removed.length > 0 || validatedAddedLineNumbers.length > 0,
    validatedRemovedLineNumbers: stagedLineNumbers.removed,
    validatedAddedLineNumbers,
  };
};

const mapReviewChangeToEntry = (
  repositoryId: string,
  change: tauriIpc.GitReviewChangeDto,
  previousChange?: FileChangeEntry
): FileChangeEntry => ({
  id: `${repositoryId}::${change.path}`,
  path: change.path,
  status: normalizeStatus(change.status),
  additions: change.additions,
  deletions: change.deletions,
  originalContent: change.originalContent,
  indexContent: change.indexContent,
  modifiedContent: change.modifiedContent,
  language: change.language || deriveLanguage(change.path),
  hunks: change.hunks,
  contextMode: previousChange?.contextMode ?? 'focused',
  canEdit: normalizeStatus(change.status) !== 'deleted' && !change.isBinary && !change.tooLarge,
  hasPendingVisibleChange: change.hasPendingVisibleChange,
  hasValidatedStage: change.hasValidatedStage,
  validatedRemovedLineNumbers: change.validatedRemovedLineNumbers,
  validatedAddedLineNumbers: change.validatedAddedLineNumbers,
  isBinary: change.isBinary,
  tooLarge: change.tooLarge,
  requiresHydration: change.requiresHydration,
});

const mapReviewFileToEntry = (
  repositoryId: string,
  file: tauriIpc.GitReviewFileDto,
  hasPendingVisibleChange: boolean,
  previousChange?: FileChangeEntry
): FileChangeEntry => ({
  id: `${repositoryId}::${file.path}`,
  path: file.path,
  status: normalizeStatus(file.status),
  additions: file.pendingDiff.additions,
  deletions: file.pendingDiff.deletions,
  originalContent: file.fullDiff.originalContent,
  indexContent: file.indexContent,
  modifiedContent: file.fullDiff.modifiedContent,
  language: file.language || deriveLanguage(file.path),
  hunks: file.fullDiff.hunks,
  contextMode: previousChange?.contextMode ?? 'focused',
  canEdit: normalizeStatus(file.status) !== 'deleted' && !file.isBinary && !file.tooLarge,
  hasPendingVisibleChange,
  hasValidatedStage: file.hasValidatedStage,
  validatedRemovedLineNumbers: file.validatedRemovedLineNumbers,
  validatedAddedLineNumbers: file.validatedAddedLineNumbers,
  isBinary: file.isBinary,
  tooLarge: file.tooLarge,
  requiresHydration: false,
});

const getScopedExecutionTargets = (
  deps: FileChangesStoreDependencies,
  task: FileChangesTaskLike
): TaskExecutionTarget[] => {
  const executionTargets = getFileChangesExecutionTargets(
    task,
    deps.getGitFlowBaseBranch
  );
  const appState = deps.getAppState();
  const shouldFilterByScope = Boolean(appState.selectedGroupId || appState.selectedProjectId);

  if (!shouldFilterByScope) {
    return executionTargets;
  }

  const scopedProjectIds = getRepositoryScopedProjectIds(
    {
      standaloneProjects: appState.standaloneProjects ?? [],
      projectGroups: appState.projectGroups,
    },
    appState.selectedGroupId,
    appState.selectedProjectId
  );
  const scopedProjectIdSet = new Set(scopedProjectIds);
  return executionTargets.filter((target) => scopedProjectIdSet.has(target.projectId));
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
  target: TaskExecutionTarget
): string | null => {
  const taskState = deps.getTaskState();
  return resolveCachedPreparedTaskWorktreePath(target, taskState.branchWorktrees);
};

const buildDirectModeConfigurationError = (
  target: TaskExecutionTarget,
  project: FileChangesProjectRef | null | undefined,
): ServiceError => ({
  code: SERVICE_ERROR_CODES.DIRECT_MODE_CONFIGURATION_REQUIRED,
  message: 'Direct review must be enabled for this non-Git project.',
  details: {
    projectId: target.projectId,
    gitSetupState: project?.gitSetupState ?? null,
    directEdit: project?.directEdit ?? null,
    targetExecutionMode: target.executionMode ?? null,
  },
});

const resolveRepositoryWorktreePaths = async (
  deps: FileChangesStoreDependencies,
  targets: TaskExecutionTarget[]
): Promise<{
  unresolvedTargets: TaskExecutionTarget[];
  hydratedWorktrees: Record<string, string>;
}> => {
  const task = ensureReviewTask(deps);
  const hydratedWorktrees: Record<string, string> = {};
  const unresolvedTargets: TaskExecutionTarget[] = [];

  for (const target of targets) {
    const taskState = deps.getTaskState();
    const branchWorktrees = {
      ...taskState.branchWorktrees,
      ...hydratedWorktrees,
    };
    const project = deps.getAppState().getProjectById(target.projectId);
    const executionResolution = resolveProjectExecutionMode({ project, target });
    if (executionResolution.mode !== 'git' && executionResolution.mode !== 'direct') {
      if (project?.gitSetupState === 'not_git') {
        throw buildDirectModeConfigurationError(target, project);
      }
      const projectPath = project?.path ?? target.repoPath ?? null;
      if (projectPath) {
        hydratedWorktrees[target.worktreeKey] = projectPath;
      } else {
        unresolvedTargets.push(target);
      }
      continue;
    }

    const resolvedPath = await resolvePreparedTaskWorktreePath({
      taskId: task.id,
      target,
      branchWorktrees,
      getProjectById: deps.getAppState().getProjectById,
      tauri: deps.tauri,
    });

    if (resolvedPath) {
      hydratedWorktrees[target.worktreeKey] = resolvedPath;
    } else {
      unresolvedTargets.push(target);
    }
  }

  return { unresolvedTargets, hydratedWorktrees };
};

const buildFirstChangesMessage = (): string =>
  tChanges(
    'implement.changesAppearAfterFirstEdit',
    'Make your first changes to this task to see them here.'
  );

const buildMissingWorktreeMessage = (
  _task: FileChangesTaskLike,
  targets: TaskExecutionTarget[]
): string => {
  const targetBranches = targets
    .map((target) => target.branchName || target.worktreeKey)
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const targetLabel = targetBranches.length > 0
    ? targetBranches.join(', ')
    : tChanges('implement.taskWorkspace', 'the task workspace');

  return tChanges(
    'implement.missingTaskWorktreeMapping',
    'Macro could not find the prepared task worktree for {{target}}.',
    { target: targetLabel }
  );
};

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

const buildOutOfScopeMessage = (deps: FileChangesStoreDependencies): string => {
  const appState = deps.getAppState();
  const selectedGroup = getGlobalProjectById(
    appState.projectGroups,
    appState.selectedGroupId
  );
  const selectedProject = appState.selectedProjectId
    ? appState.getProjectById(appState.selectedProjectId)
    : null;
  const selectedProjectInGroup =
    Boolean(selectedGroup) &&
    Boolean(
      appState.selectedProjectId &&
      selectedGroup?.subProjectIds.includes(appState.selectedProjectId)
    );

  if (selectedProjectInGroup) {
    return tChanges(
      'implement.taskOutsideSelectedSubprojectScope',
      'This task has no changes in {{project}}.',
      {
        project: selectedProject?.name || tChanges(
          'implement.selectedSubproject',
          'the selected project'
        ),
      }
    );
  }

  if (selectedGroup) {
    return tChanges(
      'implement.taskOutsideSelectedGlobalProjectScope',
      'This task has no changes in {{project}}.',
      {
        project: selectedGroup.name || tChanges(
          'implement.selectedGlobalProject',
          'the selected group'
        ),
      }
    );
  }

  if (selectedProject) {
    return tChanges(
      'implement.taskOutsideSelectedSubprojectScope',
      'This task has no changes in {{project}}.',
      {
        project: selectedProject.name || tChanges(
          'implement.selectedSubproject',
          'the selected project'
        ),
      }
    );
  }

  return tChanges(
    'implement.taskOutsideCurrentRepositoryScope',
    'This task has no changes in the current repository scope.'
  );
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
  file: { path: string; status: string; hasPendingVisibleChange: boolean },
  previousChange?: FileChangeEntry
): Promise<FileChangeEntry> => {
  const id = `${repositoryId}::${file.path}`;
  const status = normalizeStatus(file.status);
  const pair = await deps.tauri.gitReadFilePair({
    repoPath: worktreePath,
    path: file.path,
  });
  const headContent = pair.headExists ? pair.headContent : '';
  const indexContent = pair.indexExists ? pair.indexContent : '';
  const worktreeContent = pair.worktreeExists ? pair.worktreeContent : '';
  const pendingParsed = buildParsedDiffFromTextPair(indexContent, worktreeContent);
  const fullParsed = buildParsedDiffFromTextPair(headContent, worktreeContent);
  const validatedStageDecorations = buildValidatedStageDecorations({
    headContent,
    indexContent,
    worktreeContent,
  });

  return {
    id,
    path: file.path,
    status,
    additions: pendingParsed.additions,
    deletions: pendingParsed.deletions,
    originalContent: fullParsed.originalContent,
    indexContent,
    modifiedContent: fullParsed.modifiedContent,
    language: deriveLanguage(file.path),
    hunks: fullParsed.hunks,
    contextMode: previousChange?.contextMode ?? 'focused',
    canEdit: status !== 'deleted',
    hasPendingVisibleChange: file.hasPendingVisibleChange,
    hasValidatedStage: validatedStageDecorations.hasValidatedStage,
    validatedRemovedLineNumbers: validatedStageDecorations.validatedRemovedLineNumbers,
    validatedAddedLineNumbers: validatedStageDecorations.validatedAddedLineNumbers,
    isBinary: false,
    tooLarge: false,
    requiresHydration: false,
  };
};

const loadRepositoryState = async (params: {
  deps: FileChangesStoreDependencies;
  task: FileChangesTaskLike;
  target: TaskExecutionTarget;
  previousRepository?: ReviewRepositoryState;
  committedRecord?: TaskCompletionRepositoryRecord;
  reviewRequestId?: string;
}): Promise<ReviewRepositoryState> => {
  const { deps, task, target, previousRepository, committedRecord, reviewRequestId } = params;
  const appState = deps.getAppState();
  const project = appState.getProjectById(target.projectId);
  const repoPath = project?.path ?? target.repoPath ?? null;
  const worktreePath = resolveRepositoryWorktreePath(deps, target);

  if (!repoPath || !worktreePath) {
    throw new Error(
      tChanges('implement.errors.cannotResolveTaskProject', 'Cannot resolve project for task {{taskId}}', {
        taskId: task.id,
      })
    );
  }

  const repositoryId = buildFileChangesRepositoryId(target);
  const previousById = new Map((previousRepository?.changes || []).map((change) => [change.id, change]));
  const executionResolution = resolveProjectExecutionMode({ project, target });
  if (executionResolution.mode !== 'git' && executionResolution.mode !== 'direct') {
    if (project?.gitSetupState === 'not_git') {
      throw buildDirectModeConfigurationError(target, project);
    }
    throw new Error(
      tChanges(
        'implement.errors.projectExecutionInvalid',
        'The task execution metadata conflicts with the current project state. Reopen the project settings before retrying.',
      ),
    );
  }
  const executionMode = executionResolution.mode;
  if (executionMode === 'direct' || deps.tauri.gitReviewSnapshot) {
    try {
      const snapshot = executionMode === 'direct'
        ? await deps.tauri.directReviewSnapshot!({
            taskId: task.id,
            projectPath: worktreePath,
            checkpointId: target.checkpointId,
            requestId: reviewRequestId,
          })
        : await deps.tauri.gitReviewSnapshot!(worktreePath, reviewRequestId);
      const changes = snapshot.changes.map((change) =>
        mapReviewChangeToEntry(
          repositoryId,
          change,
          previousById.get(`${repositoryId}::${change.path}`)
        )
      );
      const stagedPaths = [...snapshot.stagedPaths].sort((left, right) => left.localeCompare(right));
      const selectedChangeId = previousRepository?.selectedChangeId &&
        changes.some((change) => change.id === previousRepository.selectedChangeId)
        ? previousRepository.selectedChangeId
        : changes[0]?.id ?? null;
      const normalizedBranchName = executionMode === 'direct' ? 'direct' : normalizeBranchName(target.branchName);
      const planBranchName = executionMode === 'direct'
        ? null
        : target.planBranchName || resolveReviewRepositoryIntegrationBranch(deps, task, { target });
      let hasCommittedSnapshot = Boolean(committedRecord || previousRepository?.commitState === 'committed');
      if (
        executionMode === 'direct' &&
        'hasAcceptedChanges' in snapshot &&
        snapshot.hasAcceptedChanges
      ) {
        hasCommittedSnapshot = true;
      }
      if (
        executionMode === 'git' &&
        target.executionKind === 'repository_root' &&
        target.baseCommitHash &&
        changes.length === 0 &&
        stagedPaths.length === 0 &&
        snapshot.isClean
      ) {
        const status = await deps.tauri.gitStatus(worktreePath);
        hasCommittedSnapshot = hasHeadMovedFromBase(status.head_commit, target.baseCommitHash);
      }
      if (
        executionMode === 'git' &&
        !hasCommittedSnapshot &&
        changes.length === 0 &&
        stagedPaths.length === 0 &&
        snapshot.isClean &&
        planBranchName &&
        normalizedBranchName &&
        normalizedBranchName !== planBranchName
      ) {
        try {
          const mergeCheck = await deps.tauri.gitMergeCheck({
            repoPath: worktreePath,
            branchName: normalizedBranchName,
            intoBranch: planBranchName,
          });
          hasCommittedSnapshot =
            typeof mergeCheck.ahead === 'number'
              ? mergeCheck.ahead > 0
              : mergeCheck.hasChanges;
        } catch {
          hasCommittedSnapshot = false;
        }
      }
      const commitState: ReviewRepositoryCommitState = changes.length === 0 && stagedPaths.length === 0
        ? (hasCommittedSnapshot ? 'committed' : 'no_changes')
        : 'idle';
      return {
        id: repositoryId,
        projectId: target.projectId,
        repoPath,
        worktreePath,
        branchName: normalizedBranchName,
        planBranchName,
        executionMode,
        executionKind: target.executionKind,
        checkpointId: target.checkpointId,
        baseCommitHash: target.baseCommitHash,
        directSnapshotId:
          executionMode === 'direct'
            ? (snapshot as tauriIpc.DirectReviewSnapshotDto).snapshotId
            : undefined,
        restoreRevisions:
          executionMode === 'direct'
            ? (snapshot as tauriIpc.DirectReviewSnapshotDto).restoreRevisions
            : undefined,
        changes,
        stagedPaths,
        selectedChangeId,
        stats: computeStats(changes, stagedPaths.length),
        commitMessageDraft: previousRepository?.commitMessageDraft || buildDefaultCommitMessage(task.title),
        commitState,
        loadingChangeId: null,
        savingChangeId: null,
        lastError: previousRepository?.lastError ?? null,
        lastCommitHash: previousRepository?.lastCommitHash ?? null,
      };
    } catch (error) {
      if (executionMode === 'direct' || !isUnsupportedGitReviewCommandError(error)) {
        throw error;
      }
      // Fall back to the legacy per-file IPC path when running against an older backend.
    }
  }

  const status = await deps.tauri.gitStatus(worktreePath);
  const stagedFiles = status.staged_files
    .filter((file) => typeof file.path === 'string' && file.path.trim().length > 0)
    .map((file) => ({
      path: file.path,
      status: file.status,
    }));
  const stagedPaths = Array.from(
    new Set(
      stagedFiles.map((file) => file.path)
    )
  ).sort((left, right) => left.localeCompare(right));
  const visibleByPath = new Map<string, { path: string; status: string; hasPendingVisibleChange: boolean }>();
  const addVisibleFile = (file: { path?: string | null; status: string }, hasPendingVisibleChange: boolean) => {
    if (!file.path) return;
    const previous = visibleByPath.get(file.path);
    visibleByPath.set(file.path, {
      path: file.path,
      status: hasPendingVisibleChange ? file.status : previous?.status ?? file.status,
      hasPendingVisibleChange: Boolean(previous?.hasPendingVisibleChange || hasPendingVisibleChange),
    });
  };
  [...status.unstaged_files, ...status.untracked_files].forEach((file) => addVisibleFile(file, true));
  stagedFiles.forEach((file) => addVisibleFile(file, false));

  const changes: FileChangeEntry[] = [];
  const visibleFiles = Array.from(visibleByPath.values()).sort((left, right) => left.path.localeCompare(right.path));
  for (const file of visibleFiles) {
    const changeId = `${repositoryId}::${file.path}`;
    const previousChange = previousById.get(changeId);
    changes.push(await loadFileChangeEntry(deps, repositoryId, worktreePath, file, previousChange));
  }

  const selectedChangeId = previousRepository?.selectedChangeId &&
    changes.some((change) => change.id === previousRepository.selectedChangeId)
    ? previousRepository.selectedChangeId
    : changes[0]?.id ?? null;
  const normalizedBranchName = normalizeBranchName(target.branchName);
  const planBranchName =
    target.planBranchName ||
    resolveReviewRepositoryIntegrationBranch(deps, task, { target });
  let hasCommittedSnapshot = Boolean(committedRecord || previousRepository?.commitState === 'committed');
  if (
    !hasCommittedSnapshot &&
    target.executionKind === 'repository_root' &&
    target.baseCommitHash &&
    changes.length === 0 &&
    stagedPaths.length === 0 &&
    status.is_clean
  ) {
    hasCommittedSnapshot = hasHeadMovedFromBase(status.head_commit, target.baseCommitHash);
  }
  if (
    !hasCommittedSnapshot &&
    changes.length === 0 &&
    stagedPaths.length === 0 &&
    status.is_clean &&
    planBranchName &&
    normalizedBranchName &&
    normalizedBranchName !== planBranchName
  ) {
    try {
      const mergeCheck = await deps.tauri.gitMergeCheck({
        repoPath: worktreePath,
        branchName: normalizedBranchName,
        intoBranch: planBranchName,
      });
      hasCommittedSnapshot =
        typeof mergeCheck.ahead === 'number'
          ? mergeCheck.ahead > 0
          : mergeCheck.hasChanges;
    } catch {
      hasCommittedSnapshot = false;
    }
  }
  const commitState: ReviewRepositoryCommitState = changes.length === 0 && stagedPaths.length === 0
    ? (hasCommittedSnapshot ? 'committed' : 'no_changes')
    : 'idle';

  return {
    id: repositoryId,
    projectId: target.projectId,
    repoPath,
    worktreePath,
    branchName: normalizeBranchName(target.branchName),
    planBranchName,
    executionMode: 'git',
    executionKind: target.executionKind,
    checkpointId: target.checkpointId,
    baseCommitHash: target.baseCommitHash,
    changes,
    stagedPaths,
    selectedChangeId,
    stats: computeStats(changes, stagedPaths.length),
    commitMessageDraft: previousRepository?.commitMessageDraft || buildDefaultCommitMessage(task.title),
    commitState,
    loadingChangeId: null,
    savingChangeId: null,
    lastError: previousRepository?.lastError ?? null,
    lastCommitHash: previousRepository?.lastCommitHash ?? null,
  };
};

const withReviewProjectContext = (error: unknown, projectId: string): ServiceError => {
  const serviceError = toServiceError(error);
  const details = serviceError.details && typeof serviceError.details === 'object' &&
    !Array.isArray(serviceError.details)
    ? serviceError.details as Record<string, unknown>
    : { cause: serviceError.details ?? null };
  return {
    ...serviceError,
    details: {
      ...details,
      reviewProjectId: projectId,
    },
  };
};

const ensureNoForeignStagedFiles = async (
  deps: FileChangesStoreDependencies,
  worktreePath: string,
  allowedStagedPaths: string[]
): Promise<void> => {
  const status = await deps.tauri.gitStatus(worktreePath);
  const validatedSet = new Set(allowedStagedPaths);
  const foreignStaged = status.staged_files
    .map((file) => file.path)
    .filter((path) => !validatedSet.has(path));

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
  task: FileChangesTaskLike,
  repository: ReviewRepositoryState,
  existingRecord?: TaskCompletionRepositoryRecord
): TaskCompletionRepositoryRecord => ({
  projectId: repository.projectId,
  repoPath: repository.repoPath,
  branchName: repository.branchName,
  planBranchName:
    repository.executionMode === 'direct'
      ? 'direct'
      : resolveReviewRepositoryIntegrationBranch(deps, task, {
          repositoryId: repository.id,
          existingPlanBranchName: repository.planBranchName,
        }) || deps.getGitFlowBaseBranch(),
  mergeOutput: existingRecord?.mergeOutput,
});

const deriveReviewState = (
  repositories: ReviewRepositoryState[]
): Pick<FileChangesState, 'reviewSummary'> => ({
  reviewSummary: buildReviewTaskSummary(repositories),
});

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

const findDiffTargetChange = (
  repositories: ReviewRepositoryState[],
  target: SelectedDiffTarget | null
): FileChangeEntry | null => {
  if (!target) {
    return null;
  }

  return repositories
    .find((repository) => repository.id === target.repositoryId)
    ?.changes.find((change) => change.id === target.changeId) ?? null;
};

const resolveLatestDiffModalSessionAfterRefresh = ({
  repositories,
  latestState,
  taskId,
  shouldPreserve,
}: {
  repositories: ReviewRepositoryState[];
  latestState: FileChangesState;
  taskId: string;
  shouldPreserve: boolean;
}): Pick<FileChangesState, 'selectedDiffTarget' | 'diffModalSession' | 'isDiffModalOpen'> => {
  if (!shouldPreserve || latestState.currentTaskId !== taskId || !latestState.isDiffModalOpen) {
    return {
      selectedDiffTarget: null,
      diffModalSession: null,
      isDiffModalOpen: false,
    };
  }

  const session = latestState.diffModalSession;
  const target = latestState.selectedDiffTarget;
  if (!session || !target) {
    return {
      selectedDiffTarget: null,
      diffModalSession: null,
      isDiffModalOpen: false,
    };
  }

  const refreshedChange = findDiffTargetChange(repositories, target);
  if (!refreshedChange) {
    debugFileDiffStoreLog('loadCurrentChanges.modalClosedAfterRefresh', {
      repositoryId: target.repositoryId,
      changeId: target.changeId,
      reason: 'change_missing',
    });
    return {
      selectedDiffTarget: null,
      diffModalSession: null,
      isDiffModalOpen: false,
    };
  }

  return {
    selectedDiffTarget: target,
    diffModalSession: {
      ...session,
      originalContent: refreshedChange.originalContent,
      rightDraftContent: session.isDirty
        ? session.rightDraftContent
        : refreshedChange.modifiedContent,
      lastLoadedModifiedContent: refreshedChange.modifiedContent,
      isSaving: false,
      isHydratingFullContext: false,
    },
    isDiffModalOpen: true,
  };
};

interface FileChangesState {
  currentTaskId: string | null;
  currentTaskLoadState: FileChangesTaskLoadState;
  currentTaskLoadMessage: string | null;
  loadRequestId: number;
  repositories: ReviewRepositoryState[];
  reviewSummary: ReviewTaskSummary;
  selectedDiffTarget: SelectedDiffTarget | null;
  diffModalSession: FileDiffModalSession | null;
  isDiffModalOpen: boolean;
  isLoading: boolean;
  isGeneratingCommitMessages: boolean;
  isCommitting: boolean;
  lastError: string | null;
  reviewSuspension: { taskId: string; error: ServiceError; retrying: boolean } | null;
  lastCommitHash: string | null;
  executionRecords: Record<string, TaskCompletionRepositoryRecord>;

  loadCurrentChanges: (options?: LoadCurrentChangesOptions) => Promise<void>;
  retrySuspendedReview: (taskId?: string) => Promise<void>;
  cancelReviewLoad: () => void;
  resetReviewState: () => void;
  openDiffModal: (repositoryId: string, changeId: string) => void;
  closeDiffModal: () => void;
  stageChanges: (repositoryId: string, changeIds: string[]) => Promise<void>;
  unstageChanges: (repositoryId: string, changeIds: string[]) => Promise<void>;
  stageAllChanges: (repositoryId?: string) => Promise<void>;
  stageAllTaskChanges: () => Promise<void>;
  revertChanges: (repositoryId: string, changeIds: string[]) => Promise<void>;
  updateRightDraft: (content: string) => void;
  resetRightDraft: () => void;
  saveRightDraft: () => Promise<void>;
  goToAdjacentDiff: (direction: 'previous' | 'next') => void;
  commitStagedChanges: (
    repositoryId: string,
    message?: string,
    internalOptions?: { refreshChanges?: boolean }
  ) => Promise<CommitTaskChangesResult>;
  commitAllReadyTaskRepositories: (options?: {
    modelConfig?: MetadataModelConfig | null;
    messagesByRepositoryId?: Record<string, string>;
  }) => Promise<CommitTaskRepositoriesResult>;
  setCommitMessageDraft: (repositoryId: string, message: string) => void;
  getRepository: (repositoryId: string) => ReviewRepositoryState | undefined;
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
  const defaultFileChangesStoreDependencies = getDefaultFileChangesStoreDependencies();
  const deps = Object.create(
    defaultFileChangesStoreDependencies,
    Object.getOwnPropertyDescriptors(overrides),
  ) as FileChangesStoreDependencies;
  if (overrides.tauri) {
    Object.defineProperty(deps, 'tauri', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: mergeFileChangesTauriDeps(
        defaultFileChangesStoreDependencies.tauri,
        overrides.tauri,
      ),
    });
  }

  return create<FileChangesState>((set, get) => {
    let reviewRequestSequence = 0;
    const reviewRequestNamespace = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const activeReviewRequestIds = new Set<string>();
    const nextReviewRequestId = (scope: string): string => {
      reviewRequestSequence += 1;
      const requestId = `review-${reviewRequestNamespace}-${scope}-${reviewRequestSequence}`;
      activeReviewRequestIds.add(requestId);
      return requestId;
    };
    const cancelActiveReviewRequests = () => {
      for (const requestId of activeReviewRequestIds) {
        void deps.tauri.gitCancelReview?.(requestId);
      }
      activeReviewRequestIds.clear();
    };
    const hydrateDiffModalFile = async (repositoryId: string, changeId: string) => {
      const repository = get().getRepository(repositoryId);
      const change = get().getChange(repositoryId, changeId);
      if (!repository || !change) {
        return;
      }
      const requestTaskId = resolveSelectedTask(deps)?.id ?? null;
      const requestLoadId = get().loadRequestId;

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
        let hydratedChange: FileChangeEntry;
        if (repository.executionMode === 'direct') {
          const task = ensureReviewTask(deps);
          const reviewRequestId = nextReviewRequestId('direct-file');
          try {
            const reviewFile = await deps.tauri.directReviewFile!({
              taskId: task.id,
              projectPath: repository.worktreePath,
              checkpointId: repository.checkpointId,
              path: change.path,
              status: change.status,
              requestId: reviewRequestId,
            });
            hydratedChange = mapReviewFileToEntry(
              repositoryId,
              reviewFile,
              change.hasPendingVisibleChange,
              change
            );
          } finally {
            activeReviewRequestIds.delete(reviewRequestId);
          }
        } else if (deps.tauri.gitReviewFile) {
          const reviewRequestId = nextReviewRequestId('file');
          try {
            const reviewFile = await deps.tauri.gitReviewFile({
              repoPath: repository.worktreePath,
              path: change.path,
              requestId: reviewRequestId,
            });
            hydratedChange = mapReviewFileToEntry(
              repositoryId,
              reviewFile,
              change.hasPendingVisibleChange,
              change
            );
          } catch (error) {
            if (!isUnsupportedGitReviewCommandError(error)) {
              throw error;
            }
            hydratedChange = await loadFileChangeEntry(
              deps,
              repository.id,
              repository.worktreePath,
              {
                path: change.path,
                status: change.status,
                hasPendingVisibleChange: change.hasPendingVisibleChange,
              },
              change
            );
          } finally {
            activeReviewRequestIds.delete(reviewRequestId);
          }
        } else {
          const pair = await deps.tauri.gitReadFilePair({
            repoPath: repository.worktreePath,
            path: change.path,
          });
          const headContent = pair.headExists ? pair.headContent : '';
          const indexContent = pair.indexExists ? pair.indexContent : '';
          const worktreeContent = pair.worktreeExists ? pair.worktreeContent : '';
          const validatedStageDecorations = buildValidatedStageDecorations({
            headContent,
            indexContent,
            worktreeContent,
          });
          hydratedChange = {
            ...change,
            originalContent: headContent,
            indexContent,
            modifiedContent: worktreeContent,
            hasValidatedStage: validatedStageDecorations.hasValidatedStage,
            validatedRemovedLineNumbers: validatedStageDecorations.validatedRemovedLineNumbers,
            validatedAddedLineNumbers: validatedStageDecorations.validatedAddedLineNumbers,
            requiresHydration: false,
          };
        }

        if (get().loadRequestId !== requestLoadId) {
          return;
        }

        set((state) => {
          const isCurrentSession =
            state.diffModalSession &&
            state.diffModalSession.repositoryId === repositoryId &&
            state.diffModalSession.changeId === changeId;

          return {
            repositories: updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
              ...currentRepository,
              changes: updateChangeEntry(currentRepository.changes, changeId, () => hydratedChange),
              loadingChangeId: null,
              lastError: null,
            })),
            diffModalSession: isCurrentSession && state.diffModalSession
              ? {
                ...state.diffModalSession,
                originalContent: hydratedChange.originalContent,
                rightDraftContent: state.diffModalSession.isDirty
                  ? state.diffModalSession.rightDraftContent
                  : hydratedChange.modifiedContent,
                lastLoadedModifiedContent: hydratedChange.modifiedContent,
                isHydratingFullContext: false,
              }
              : state.diffModalSession,
            lastError: null,
          };
        });
      } catch (error) {
        if (get().loadRequestId !== requestLoadId) {
          return;
        }
        const serviceError = withReviewProjectContext(error, repository.projectId);
        if (isReviewSuspendingError(serviceError)) {
          const currentTaskId = resolveSelectedTask(deps)?.id ?? null;
          if (!requestTaskId || currentTaskId !== requestTaskId) {
            return;
          }
          set((state) => ({
            repositories: updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
              ...currentRepository,
              loadingChangeId: null,
              lastError: null,
            })),
            diffModalSession:
              state.diffModalSession &&
              state.diffModalSession.repositoryId === repositoryId &&
              state.diffModalSession.changeId === changeId
                ? { ...state.diffModalSession, isHydratingFullContext: false }
                : state.diffModalSession,
            lastError: null,
            reviewSuspension: {
              taskId: requestTaskId,
              error: serviceError,
              retrying: false,
            },
          }));
          return;
        }
        const message = serviceError.message ||
          tChanges('implement.errors.loadChangesFailed', 'Failed to load repository changes.');
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
    reviewSummary: EMPTY_FILE_CHANGES_REVIEW_SUMMARY,
    selectedDiffTarget: null,
    diffModalSession: null,
    isDiffModalOpen: false,
    isLoading: false,
    isGeneratingCommitMessages: false,
    isCommitting: false,
    lastError: null,
    reviewSuspension: null,
    lastCommitHash: null,
    executionRecords: {},

  loadCurrentChanges: async (options) => {
    cancelActiveReviewRequests();
    const previousState = get();
    const task = resolveSelectedTask(deps);
    const nextLoadRequestId = previousState.loadRequestId + 1;

    const resetLoadState = {
      repositories: [],
      reviewSummary: EMPTY_FILE_CHANGES_REVIEW_SUMMARY,
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
    const scopedExecutionTargets = getScopedExecutionTargets(deps, task);
    const requestedRepositoryIds = new Set(
      scopedExecutionTargets.map((target) => buildFileChangesRepositoryId(target))
    );
    const sameScope = sameTask &&
      previousState.repositories.length === requestedRepositoryIds.size &&
      previousState.repositories.every((repository) => requestedRepositoryIds.has(repository.id));
    const silentReload = sameTask && options?.silent === true;
    const previousRepositories = new Map(
      (sameTask ? previousState.repositories : []).map((repository) => [repository.id, repository])
    );
    const executionRecords = sameTask ? previousState.executionRecords : {};
    const shouldPreserveModalAfterRefresh = silentReload || options?.preserveDiffModalSession === true;

    debugFileDiffStoreLog('loadCurrentChanges.start', {
      taskId: task.id,
      silent: options?.silent === true,
      preserveDiffModalSession: options?.preserveDiffModalSession === true,
      isDiffModalOpen: previousState.isDiffModalOpen,
      selectedDiffTarget: previousState.selectedDiffTarget,
    });

    if (silentReload) {
      set({
        currentTaskId: task.id,
        lastError: null,
        ...(!options?.preserveReviewSuspension ? { reviewSuspension: null } : {}),
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
      const executionTargets = getFileChangesExecutionTargets(
        task,
        deps.getGitFlowBaseBranch
      );
      if (executionTargets.length > 0 && scopedExecutionTargets.length === 0) {
        if (isStaleRequest(nextLoadRequestId, task.id)) {
          return;
        }

        set({
          ...resetLoadState,
          currentTaskId: task.id,
          currentTaskLoadState: 'out_of_scope',
          currentTaskLoadMessage: buildOutOfScopeMessage(deps),
          isLoading: false,
          lastError: null,
          executionRecords,
        });
        return;
      }

      const { unresolvedTargets, hydratedWorktrees } =
        await resolveRepositoryWorktreePaths(deps, scopedExecutionTargets);

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

      if (Object.keys(hydratedWorktrees).length > 0) {
        if (isStaleRequest(nextLoadRequestId, task.id)) {
          return;
        }

        deps.setTaskState({
          branchWorktrees: {
            ...deps.getTaskState().branchWorktrees,
            ...hydratedWorktrees,
          },
        });
      }

      const repositories = await Promise.all(
        scopedExecutionTargets.map(async (target, targetIndex) => {
          const repositoryId = buildFileChangesRepositoryId(target);
          const reviewRequestId = nextReviewRequestId(`snapshot-${targetIndex}`);
          try {
            return await loadRepositoryState({
              deps,
              task,
              target,
              previousRepository: previousRepositories.get(repositoryId),
              committedRecord: executionRecords[repositoryId],
              reviewRequestId,
            });
          } catch (error) {
            throw withReviewProjectContext(error, target.projectId);
          } finally {
            activeReviewRequestIds.delete(reviewRequestId);
          }
        })
      );

      if (isStaleRequest(nextLoadRequestId, task.id)) {
        return;
      }

      const derivedReviewState = deriveReviewState(repositories);
      const latestDiffModalState = resolveLatestDiffModalSessionAfterRefresh({
        repositories,
        latestState: get(),
        taskId: task.id,
        shouldPreserve: shouldPreserveModalAfterRefresh,
      });

      debugFileDiffStoreLog('loadCurrentChanges.finish', {
        taskId: task.id,
        repositoryCount: repositories.length,
        preservedDiffModal: latestDiffModalState.isDiffModalOpen,
        selectedDiffTarget: latestDiffModalState.selectedDiffTarget,
      });

      set({
        currentTaskId: task.id,
        currentTaskLoadState: 'ready',
        currentTaskLoadMessage: null,
        repositories,
        reviewSummary: derivedReviewState.reviewSummary,
        ...latestDiffModalState,
        isLoading: false,
        lastError: null,
        reviewSuspension: null,
        executionRecords,
      });
    } catch (error) {
      cancelActiveReviewRequests();
      if (isStaleRequest(nextLoadRequestId, task.id)) {
        return;
      }

      const serviceError = toServiceError(error);
      if (isReviewSuspendingError(serviceError)) {
        const preservedState = sameScope
          ? {
              repositories: previousState.repositories,
              reviewSummary: previousState.reviewSummary,
              selectedDiffTarget: previousState.selectedDiffTarget,
              diffModalSession: previousState.diffModalSession,
              isDiffModalOpen: previousState.isDiffModalOpen,
            }
          : resetLoadState;
        set({
          currentTaskId: task.id,
          currentTaskLoadState: sameScope && previousState.repositories.length > 0 ? 'ready' : 'invalid_mapping',
          currentTaskLoadMessage: null,
          ...preservedState,
          isLoading: false,
          executionRecords,
          lastError: null,
          reviewSuspension: { taskId: task.id, error: serviceError, retrying: false },
        });
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
          serviceError.message ||
          tChanges('implement.errors.loadChangesFailed', 'Failed to load repository changes.'),
      });
    }
  },

  retrySuspendedReview: async (taskId) => {
    const suspension = get().reviewSuspension;
    if (!suspension) return;
    const selectedTask = resolveSelectedTask(deps);
    if (taskId && taskId !== suspension.taskId) return;
    if (selectedTask?.id !== suspension.taskId || suspension.retrying) return;
    set({ reviewSuspension: { ...suspension, retrying: true } });
    await get().loadCurrentChanges({
      silent: get().repositories.length > 0,
      preserveReviewSuspension: true,
    });
  },

  cancelReviewLoad: () => {
    cancelActiveReviewRequests();
    set({ loadRequestId: get().loadRequestId + 1, isLoading: false });
  },

  resetReviewState: () => {
    cancelActiveReviewRequests();
    set({
      currentTaskId: null,
      currentTaskLoadState: 'idle',
      currentTaskLoadMessage: null,
      loadRequestId: get().loadRequestId + 1,
      repositories: [],
      reviewSummary: EMPTY_FILE_CHANGES_REVIEW_SUMMARY,
      selectedDiffTarget: null,
      diffModalSession: null,
      isDiffModalOpen: false,
      isLoading: false,
      isGeneratingCommitMessages: false,
      isCommitting: false,
      lastError: null,
      reviewSuspension: null,
      lastCommitHash: null,
      executionRecords: {},
    });
  },

  openDiffModal: (repositoryId, changeId) => {
    const repositories = get().repositories;
    const repository = repositories.find((candidate) => candidate.id === repositoryId);
    const change = repository?.changes.find((candidate) => candidate.id === changeId);
    if (!change) {
      return;
    }
    debugFileDiffStoreLog('openDiffModal', {
      repositoryId,
      changeId,
      path: change.path,
    });
    set({
      ...deriveReviewState(repositories),
      selectedDiffTarget: { repositoryId, changeId },
      diffModalSession: buildDiffModalSession(repositoryId, change, {
        isHydratingFullContext: change.requiresHydration && !change.tooLarge && !change.isBinary,
        directSnapshotId: repository?.directSnapshotId,
        restoreRevision: repository?.restoreRevisions?.[change.path],
      }),
      isDiffModalOpen: true,
    });
    if (change.requiresHydration && !change.tooLarge && !change.isBinary) {
      void hydrateDiffModalFile(repositoryId, changeId);
    }
  },

  closeDiffModal: () => {
    const state = get();
    debugFileDiffStoreLog('closeDiffModal', {
      selectedDiffTarget: state.selectedDiffTarget,
      hadSession: Boolean(state.diffModalSession),
    });
    set({
      selectedDiffTarget: null,
      diffModalSession: null,
      isDiffModalOpen: false,
    });
  },

  stageChanges: async (repositoryId, changeIds) => {
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
    const targetChanges = repository.changes.filter((change) =>
      targetIds.has(change.id) && change.hasPendingVisibleChange
    );
    if (targetChanges.length === 0) {
      return;
    }

    const selectedDiffTarget = get().selectedDiffTarget;
    const affectsOpenModal =
      selectedDiffTarget?.repositoryId === repositoryId && targetIds.has(selectedDiffTarget.changeId);

    set((state) => ({
      repositories: updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
        ...currentRepository,
        savingChangeId:
          targetChanges.length === 1 ? targetChanges[0]?.id ?? currentRepository.savingChangeId : '__batch_stage__',
        lastError: null,
      })),
      diffModalSession:
        state.diffModalSession && state.diffModalSession.repositoryId === repositoryId
          ? {
              ...state.diffModalSession,
              isSaving: affectsOpenModal,
            }
          : state.diffModalSession,
      lastError: null,
    }));

    try {
      const paths = targetChanges.map((change) => change.path);
      if (repository.executionMode === 'direct') {
        const task = ensureReviewTask(deps);
        const modalSnapshotId = affectsOpenModal && targetChanges.length === 1
          ? get().diffModalSession?.directSnapshotId
          : undefined;
        const snapshotId = modalSnapshotId ?? repository.directSnapshotId;
        if (!snapshotId) {
          throw new Error('The direct-review snapshot is unavailable. Refresh the review.');
        }
        await deps.tauri.directStagePaths!({
          taskId: task.id,
          projectPath: repository.worktreePath,
          checkpointId: repository.checkpointId,
          snapshotId,
          paths,
        });
      } else {
        await deps.tauri.gitAdd({ repoPath: repository.worktreePath, paths });
      }

      await get().loadCurrentChanges({ silent: true, preserveDiffModalSession: true });

      if (affectsOpenModal) {
        get().closeDiffModal();
      }
    } catch (error) {
      const message = toServiceError(error).message ||
        tChanges('implement.errors.loadChangesFailed', 'Failed to load repository changes.');
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

  unstageChanges: async (repositoryId, changeIds) => {
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
    const targetChanges = repository.changes.filter((change) =>
      targetIds.has(change.id) && change.hasValidatedStage
    );
    if (targetChanges.length === 0) {
      return;
    }

    const selectedDiffTarget = get().selectedDiffTarget;
    const affectsOpenModal =
      selectedDiffTarget?.repositoryId === repositoryId && targetIds.has(selectedDiffTarget.changeId);

    set((state) => ({
      repositories: updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
        ...currentRepository,
        savingChangeId:
          targetChanges.length === 1 ? targetChanges[0]?.id ?? currentRepository.savingChangeId : '__batch_unstage__',
        lastError: null,
      })),
      diffModalSession:
        state.diffModalSession && state.diffModalSession.repositoryId === repositoryId
          ? {
              ...state.diffModalSession,
              isSaving: affectsOpenModal,
            }
          : state.diffModalSession,
      lastError: null,
    }));

    try {
      const paths = targetChanges.map((change) => change.path);
      if (repository.executionMode === 'direct') {
        const task = ensureReviewTask(deps);
        await deps.tauri.directUnstagePaths!({
          taskId: task.id,
          projectPath: repository.worktreePath,
          checkpointId: repository.checkpointId,
          paths,
        });
      } else {
        await deps.tauri.gitRestorePaths({
          repoPath: repository.worktreePath,
          paths,
          target: 'staged',
        });
      }

      await get().loadCurrentChanges({ silent: true, preserveDiffModalSession: true });
    } catch (error) {
      const message = toServiceError(error).message ||
        tChanges('implement.errors.unstageChangesFailed', 'Failed to unstage changes.');
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

  stageAllChanges: async (repositoryId) => {
    if (!repositoryId) return;
    const repository = get().getRepository(repositoryId);
    if (!repository) return;
    await get().stageChanges(
      repositoryId,
      repository.changes
        .filter((change) => change.hasPendingVisibleChange)
        .map((change) => change.id)
    );
  },

  stageAllTaskChanges: async () => {
    const targetRepositoryIds = get().repositories
      .filter((repository) =>
        repository.commitState === 'idle' &&
        repository.stats.pendingVisibleFileCount > 0 &&
        repository.changes.length > 0
      )
      .map((repository) => repository.id);

    for (const repositoryId of targetRepositoryIds) {
      const repository = get().getRepository(repositoryId);
      if (
        !repository ||
        repository.commitState !== 'idle' ||
        repository.stats.pendingVisibleFileCount === 0 ||
        repository.changes.length === 0
      ) {
        continue;
      }

      await get().stageAllChanges(repositoryId);
    }
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
    const targetChanges = repository.changes.filter((change) =>
      targetIds.has(change.id) && change.hasPendingVisibleChange
    );
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
      const paths = targetChanges.map((change) => change.path);
      if (repository.executionMode === 'direct') {
        const task = ensureReviewTask(deps);
        const modalSnapshotId = affectsOpenModal && targetChanges.length === 1
          ? get().diffModalSession?.directSnapshotId
          : undefined;
        const snapshotId = modalSnapshotId ?? repository.directSnapshotId;
        if (!snapshotId) {
          throw new Error('The direct-review snapshot is unavailable. Refresh the review.');
        }
        const requestId = nextReviewRequestId('direct-restore');
        try {
          await deps.tauri.directRestoreWorktreePaths!({
            taskId: task.id,
            projectPath: repository.worktreePath,
            checkpointId: repository.checkpointId,
            snapshotId,
            paths,
            requestId,
          });
        } finally {
          activeReviewRequestIds.delete(requestId);
        }
      } else {
        await deps.tauri.gitRestorePaths({
          repoPath: repository.worktreePath,
          paths,
          target: 'worktree',
        });
      }

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
      const serviceError = toServiceError(error);
      const message = serviceError.code === 'REVISION_CONFLICT'
        ? tChanges(
          'implement.errors.reviewChangedSinceLoad',
          'The file changed after this review loaded. Refresh the review before retrying.'
        )
        : serviceError.message ||
          tChanges('implement.errors.revertChangesFailed', 'Failed to revert changes.');
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
      const path = resolveChangeFilePath(repository.worktreePath, change.path);
      const workspaceOptions = {
        workspacePath: repository.worktreePath,
      };
      const exists = await deps.tauri.fsExists(path, workspaceOptions);
      let expectedRevision = 'absent';
      if (exists) {
        const current = await deps.tauri.fsReadFileWithOptions({
          path,
          allowOutsideWorkspace: false,
          ...workspaceOptions,
        });
        if (!current.revision) {
          throw new Error(
            `Cannot safely save ${change.path}: the current revision is unavailable. Reload the diff and retry.`,
          );
        }
        expectedRevision = current.revision;
      }

      await deps.tauri.fsWriteFile({
        path,
        content: nextContent,
        createDirs: true,
        allowOutsideWorkspace: false,
        workspacePath: repository.worktreePath,
        expectedRevision,
      });

      set((state) => ({
        ...(() => {
          const repositories = updateRepositoryState(state.repositories, session.repositoryId, (currentRepository) => ({
            ...currentRepository,
            savingChangeId: null,
            lastError: null,
          }));
          return {
            repositories,
            ...deriveReviewState(repositories),
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
      const message = toServiceError(error).message ||
        tChanges('implement.errors.loadChangesFailed', 'Failed to load repository changes.');
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

  commitStagedChanges: async (repositoryId, message, internalOptions = {}) => {
    const task = ensureReviewTask(deps);
    const repository = get().getRepository(repositoryId);
    const commitMessage = (
      message || repository?.commitMessageDraft || buildDefaultCommitMessage(task.title)
    ).trim();
    if (!commitMessage) {
      throw new Error(tChanges('implement.errors.commitMessageRequired', 'Commit message is required.'));
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

    if (repository.stagedPaths.length === 0) {
      throw new Error(tChanges('implement.errors.commitNoChanges', 'No file changes available for this task.'));
    }

    const integrationBranchName = repository.executionMode === 'direct'
      ? 'direct'
      : resolveReviewRepositoryIntegrationBranch(deps, task, {
          repositoryId,
          existingPlanBranchName: repository.planBranchName,
        });
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
          ...deriveReviewState(repositories),
        };
      })(),
    }));

    try {
      let hash: string;
      if (repository.executionMode === 'direct') {
        hash = await deps.tauri.directAcceptChanges!({
          taskId: task.id,
          projectPath: repository.worktreePath,
          checkpointId: repository.checkpointId,
        });
      } else {
        if (repository.executionKind === 'repository_root') {
          const status = await deps.tauri.gitStatus(repository.worktreePath);
          if (status.branch !== repository.branchName) {
            throw new Error(
              tChanges(
                'implement.errors.directTaskBranchChanged',
                'The current branch changed from {{expected}} to {{actual}}. Switch back before committing this direct task.',
                { expected: repository.branchName, actual: status.branch },
              ),
            );
          }
        }
        await ensureNoForeignStagedFiles(deps, repository.worktreePath, repository.stagedPaths);
        hash = await deps.tauri.gitCommit({
          repoPath: repository.worktreePath,
          message: commitMessage,
          stageAll: false,
        });
      }

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

      set({
        executionRecords: nextExecutionRecords,
        lastCommitHash: hash,
        lastError: null,
      });

      const refreshChanges = internalOptions.refreshChanges !== false;
      if (refreshChanges) {
        await get().loadCurrentChanges({ silent: true, preserveDiffModalSession: true });
      }

      const refreshedState = get();
      const nextRepositories = refreshedState.repositories.map((currentRepository) => (
        currentRepository.id === repositoryId
          ? {
              ...currentRepository,
              ...(refreshChanges
                ? {}
                : {
                    changes: [],
                    stagedPaths: [],
                    commitState: 'committed' as const,
                  }),
              commitMessageDraft: commitMessage,
              lastCommitHash: hash,
            }
          : currentRepository
      ));
      const derivedReviewState = deriveReviewState(nextRepositories);

      set({
        repositories: nextRepositories,
        reviewSummary: derivedReviewState.reviewSummary,
        executionRecords: nextExecutionRecords,
        isCommitting: false,
        lastCommitHash: hash,
        lastError: null,
      });

      const completionRecords = nextRepositories.map((currentRepository) =>
        nextExecutionRecords[currentRepository.id] ||
        buildCompletionRepositoryRecord(deps, task, currentRepository)
      );
      let taskCompleted = false;
      const taskStatus: TaskStatus | null = deps.getTaskState().getTaskById(task.id)?.status ?? null;

      return {
        hash,
        taskId: task.id,
        taskCompleted,
        taskStatus,
        committedRepositoryId: repositoryId,
        repositories: completionRecords,
      };
    } catch (error) {
      const messageText = toServiceError(error).message;
      set((state) => ({
        isCommitting: false,
        lastError: messageText,
        ...(() => {
          const repositories = updateRepositoryState(state.repositories, repositoryId, (currentRepository) => ({
            ...currentRepository,
            commitState:
              currentRepository.changes.length === 0 && currentRepository.stagedPaths.length === 0
                ? 'no_changes'
                : 'idle',
            lastError: messageText,
          }));
          return {
            repositories,
            ...deriveReviewState(repositories),
          };
        })(),
      }));
      throw error;
    }
  },

  commitAllReadyTaskRepositories: async (options = {}) => {
    const task = ensureReviewTask(deps);

    const targetRepositories = getReadyCommitRepositories(get().repositories);
    const targetRepositoryIds = targetRepositories.map((repository) => repository.id);

    if (targetRepositoryIds.length === 0) {
      throw new Error(tChanges('implement.errors.commitNoChanges', 'No file changes available for this task.'));
    }

    let messagesByRepositoryId = options.messagesByRepositoryId ?? null;

    if (!messagesByRepositoryId && targetRepositories.every((repository) => repository.executionMode === 'direct')) {
      messagesByRepositoryId = Object.fromEntries(
        targetRepositoryIds.map((repositoryId) => [
          repositoryId,
          'chore(checkpoint): accept direct workspace changes',
        ])
      );
    }

    if (!messagesByRepositoryId) {
      set({ isGeneratingCommitMessages: true, lastError: null });
      let generatedMessages: GeneratedCommitMessages;
      const commitMessageInput = await buildSmartCommitMessageInput(deps, task, targetRepositories);
      try {
        generatedMessages = await generateCommitMessagesWithRetry(
          deps,
          commitMessageInput,
          { modelConfig: options.modelConfig ?? null }
        );
        generatedMessages = stripGeneratedCommitScopes(generatedMessages);
      } catch (error) {
        const messageText = toServiceError(error).message ||
          tChanges('implement.errors.commitMessageGenerationFailed', 'Could not generate commit messages.');
        set({
          isGeneratingCommitMessages: false,
          lastError: null,
        });
        if (isSmartCommitMessageGenerationError(error)) {
          throw new SmartCommitMessageGenerationError(messageText, {
            generatedMessages: error.generatedMessages
              ? stripGeneratedCommitScopes(error.generatedMessages)
              : undefined,
          });
        }
        throw new SmartCommitMessageGenerationError(messageText);
      } finally {
        set({ isGeneratingCommitMessages: false });
      }

      messagesByRepositoryId = Object.fromEntries(
        targetRepositoryIds.map((repositoryId) => [
          repositoryId,
          formatGeneratedCommitMessageForRepository(generatedMessages, repositoryId),
        ])
      );
    }

    const commits: CommitTaskChangesResult[] = [];
    let batchError: unknown = null;
    let attemptedCommit = false;

    for (const repositoryId of targetRepositoryIds) {
      const repository = get().getRepository(repositoryId);
      if (!repository || !isRepositoryReadyToCommit(repository)) {
        continue;
      }

      const repositoryMessage = messagesByRepositoryId[repositoryId]?.trim() || '';
      const validation = validateConventionalCommitMessage(repositoryMessage);
      if (!validation.ok) {
        throw new SmartCommitMessageGenerationError(
          validation.message || tChanges(
            'implement.errors.commitMessageInvalid',
            'Commit message must follow Conventional Commits.'
          )
        );
      }

      try {
        attemptedCommit = true;
        const result = await get().commitStagedChanges(repositoryId, repositoryMessage, {
          refreshChanges: false,
        });
        commits.push(result);
      } catch (error) {
        const messageText = toServiceError(error).message;
        const repositoryLabel = repository.projectId || repository.repoPath || repositoryId;
        batchError = new Error(
          tChanges(
            'implement.errors.repositoryCommitFailed',
            '{{repository}}: {{message}}',
            {
              repository: repositoryLabel,
              message: messageText || tChanges('implement.commitFailed', 'Failed to commit changes'),
            }
          )
        );
        break;
      }
    }

    if (attemptedCommit) {
      try {
        await get().loadCurrentChanges({ silent: true, preserveDiffModalSession: true });
      } catch (refreshError) {
        if (!batchError) {
          throw refreshError;
        }
      }
    }

    if (batchError) {
      throw batchError;
    }

    if (commits.length === 0) {
      throw new Error(tChanges('implement.errors.commitNoChanges', 'No file changes available for this task.'));
    }

    const currentState = get();
    const repositories = currentState.repositories.map((repository) =>
      currentState.executionRecords[repository.id] ||
      buildCompletionRepositoryRecord(deps, task, repository)
    );
    const lastCommit = commits[commits.length - 1];

    return {
      taskId: task.id,
      taskCompleted: false,
      taskStatus: lastCommit?.taskStatus ?? deps.getTaskState().getTaskById(task.id)?.status ?? null,
      commits,
      repositories,
    };
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

  getChange: (repositoryId, changeId) => {
    return get().repositories
      .find((repository) => repository.id === repositoryId)
      ?.changes.find((change) => change.id === changeId);
  },

  getDiffModalSession: () => get().diffModalSession,

  getSelectedDiffTarget: () => get().selectedDiffTarget,

  getStats: (repositoryId) => {
    if (!repositoryId) return EMPTY_STATS;
    return get().repositories.find((repository) => repository.id === repositoryId)?.stats || EMPTY_STATS;
  },

  getOverallStats: () => {
    const repositories = get().repositories;
    return repositories.reduce<ReviewRepositoryStats>((aggregate, repository) => ({
      pendingVisibleFileCount:
        aggregate.pendingVisibleFileCount + repository.stats.pendingVisibleFileCount,
      validatedStagedFileCount:
        aggregate.validatedStagedFileCount + repository.stats.validatedStagedFileCount,
      additions: aggregate.additions + repository.stats.additions,
      deletions: aggregate.deletions + repository.stats.deletions,
    }), { ...EMPTY_STATS });
  },

  getReviewSummary: () => get().reviewSummary,
    });
  });
};

export const useFileChangesStore = createFileChangesStore();
