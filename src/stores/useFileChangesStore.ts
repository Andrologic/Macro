import { create } from 'zustand';
import i18n from '../i18n';
import { useAppStore } from './useAppStore';
import { useTaskStore } from './useTaskStore';
import type { ImplementTask } from './useTaskStore';
import type { TaskStatus } from '../types';
import * as tauriIpc from '../services/tauriIpc';
import { parseUnifiedDiff, type ParsedDiffHunk } from '../services/gitDiffParser';

export type FileChangeContextMode = 'default' | 'expanded' | 'full';

const FILE_CHANGE_CONTEXT_LINES: Record<FileChangeContextMode, number> = {
  default: 3,
  expanded: 12,
  full: 100000,
};

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
  contextMode: FileChangeContextMode;
  isEditing: boolean;
  editingContent: string | null;
  canEdit: boolean;
}

export interface FolderNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children?: FolderNode[];
  fileChange?: FileChangeEntry;
}

export interface CommitTaskChangesResult {
  hash: string;
  branch: string;
  repoPath: string;
  committedPaths: string[];
  taskId: string;
  taskCompleted: boolean;
  taskStatus: TaskStatus | null;
}

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
          children: isFile ? undefined : [],
          fileChange: isFile ? change : undefined,
        };
        current.push(existing);
      }

      if (!isFile && existing.children) {
        current = existing.children;
      }
    }
  }

  return root;
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
  if (value.includes('added') || value === 'a' || value === 'new') return 'added';
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

const resolveActiveProjectPath = (): string | null => {
  const activeRepositoryPath = useTaskStore.getState().activeRepositoryPath;
  if (activeRepositoryPath) {
    return activeRepositoryPath;
  }

  const appState = useAppStore.getState();

  if (appState.selectedProjectId) {
    return appState.getProjectById(appState.selectedProjectId)?.path ?? null;
  }

  if (appState.selectedGroupId) {
    const group = appState.projectGroups.find((candidate) => candidate.id === appState.selectedGroupId);
    return group?.projects[0]?.path ?? null;
  }

  return appState.projectGroups[0]?.projects[0]?.path ?? null;
};

interface CommitContext {
  repoPath: string;
  task: ImplementTask;
  reviewedPaths: string[];
}

const tChanges = (key: string, fallback: string, options?: Record<string, unknown>): string =>
  i18n.t(key, { defaultValue: fallback, ...(options || {}) });

const updateChangeEntry = (
  changes: FileChangeEntry[],
  changeId: string,
  updater: (change: FileChangeEntry) => FileChangeEntry
): FileChangeEntry[] =>
  changes.map((change) => (change.id === changeId ? updater(change) : change));

const resolveCommitContext = (changes: FileChangeEntry[]): CommitContext => {
  if (!tauriIpc.isTauriAvailable()) {
    throw new Error(
      tChanges('implement.errors.commitDesktopOnly', 'Git commit flow is only available in desktop mode.')
    );
  }

  const repoPath = resolveActiveProjectPath();
  if (!repoPath) {
    throw new Error(
      tChanges('implement.errors.noActiveRepositoryPath', 'No active repository path found for this task.')
    );
  }

  const appState = useAppStore.getState();
  if (!appState.selectedTaskId) {
    throw new Error(
      tChanges('implement.errors.selectTaskBeforeCommit', 'Select a task before committing changes.')
    );
  }

  const task = useTaskStore.getState().getTaskById(appState.selectedTaskId);
  if (!task) {
    throw new Error(
      tChanges('implement.errors.unknownTask', 'Unknown task: {{taskId}}', {
        taskId: appState.selectedTaskId,
      })
    );
  }

  if (task.status !== 'InReview') {
    throw new Error(
      tChanges(
        'implement.errors.commitRequiresActiveTaskStatus',
        'Task must be In Review before committing changes.'
      )
    );
  }

  if (changes.length === 0) {
    throw new Error(tChanges('implement.errors.commitNoChanges', 'No changes available to commit for this task.'));
  }

  const reviewedPaths = Array.from(
    new Set(
      changes
        .filter((change) => change.reviewed)
        .map((change) => change.path)
        .filter((path) => path.trim().length > 0)
    )
  );

  if (reviewedPaths.length !== changes.length) {
    throw new Error(
      tChanges('implement.errors.commitNeedsReview', 'Review all file changes before committing this task.')
    );
  }

  return {
    repoPath,
    task,
    reviewedPaths,
  };
};

const ensureNoForeignStagedFiles = async (repoPath: string, reviewedPaths: string[]): Promise<void> => {
  const status = await tauriIpc.gitStatus(repoPath);
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

const loadFileChangeEntry = async (
  repoPath: string,
  file: { path: string; status: string },
  previousChange?: FileChangeEntry,
  contextModeOverride?: FileChangeContextMode
): Promise<FileChangeEntry> => {
  const id = `change-${file.path}`;
  const status = normalizeStatus(file.status);
  const contextMode = contextModeOverride ?? previousChange?.contextMode ?? 'default';
  const patch = await tauriIpc.gitDiff({
    repoPath,
    paths: [file.path],
    contextLines: FILE_CHANGE_CONTEXT_LINES[contextMode],
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
    contextMode,
    isEditing: false,
    editingContent: null,
    canEdit: status !== 'deleted',
  };
};

const loadCurrentChangesInternal = async (
  previousChanges: FileChangeEntry[],
  previousSelectedChangeId: string | null
): Promise<{ entries: FileChangeEntry[]; selectedChangeId: string | null }> => {
  const repoPath = resolveActiveProjectPath();
  if (!repoPath) {
    return { entries: [], selectedChangeId: null };
  }

  const status = await tauriIpc.gitStatus(repoPath);
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

  const previousById = new Map(previousChanges.map((change) => [change.id, change]));
  const entries: FileChangeEntry[] = [];

  for (const file of uniqueByPath.values()) {
    const id = `change-${file.path}`;
    const previousChange = previousById.get(id);
    entries.push(await loadFileChangeEntry(repoPath, file, previousChange));
  }

  const hasPreviousSelection =
    previousSelectedChangeId && entries.some((change) => change.id === previousSelectedChangeId);
  const selectedChangeId = hasPreviousSelection
    ? previousSelectedChangeId
    : entries[0]?.id ?? null;

  return { entries, selectedChangeId };
};

const loadCurrentChangesWithRetry = async (
  previousChanges: FileChangeEntry[],
  previousSelectedChangeId: string | null
): Promise<{ entries: FileChangeEntry[]; selectedChangeId: string | null }> => {
  try {
    return await loadCurrentChangesInternal(previousChanges, previousSelectedChangeId);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return loadCurrentChangesInternal(previousChanges, previousSelectedChangeId);
  }
};

interface FileChangesState {
  changes: FileChangeEntry[];
  selectedChangeId: string | null;
  isDiffModalOpen: boolean;
  isLoading: boolean;
  isCommitting: boolean;
  loadingChangeId: string | null;
  savingChangeId: string | null;
  lastError: string | null;
  lastCommitHash: string | null;

  // Actions
  loadCurrentChanges: () => Promise<void>;
  loadChangeContext: (id: string, contextMode: FileChangeContextMode) => Promise<void>;
  selectChange: (id: string | null) => void;
  openDiffModal: (id: string) => void;
  closeDiffModal: () => void;
  markAsReviewed: (id: string) => void;
  markAllAsReviewed: () => void;
  startEditingChange: (id: string) => Promise<void>;
  updateEditingBuffer: (id: string, content: string) => void;
  cancelEditingChange: (id: string) => void;
  saveEditedChange: (id: string) => Promise<void>;
  stageReviewedChanges: () => Promise<string[]>;
  commitReviewedChanges: (message: string) => Promise<CommitTaskChangesResult>;
  getChange: (id: string) => FileChangeEntry | undefined;

  // Stats
  getStats: () => { total: number; reviewed: number; additions: number; deletions: number };
}

export const useFileChangesStore = create<FileChangesState>((set, get) => ({
  changes: [],
  selectedChangeId: null,
  isDiffModalOpen: false,
  isLoading: false,
  isCommitting: false,
  loadingChangeId: null,
  savingChangeId: null,
  lastError: null,
  lastCommitHash: null,

  loadCurrentChanges: async () => {
    set({ isLoading: true, lastError: null });

    if (!tauriIpc.isTauriAvailable()) {
      set({ isLoading: false, changes: [], lastError: null });
      return;
    }

    try {
      const previousState = get();
      const { entries, selectedChangeId } = await loadCurrentChangesWithRetry(
        previousState.changes,
        previousState.selectedChangeId
      );

      set({ changes: entries, selectedChangeId, isLoading: false, lastError: null });
    } catch (error) {
      set({
        isLoading: false,
        changes: [],
        selectedChangeId: null,
        lastError:
          error instanceof Error
            ? error.message
            : tChanges('implement.errors.loadChangesFailed', 'Failed to load repository changes.'),
      });
    }
  },

  loadChangeContext: async (id, contextMode) => {
    const currentChange = get().getChange(id);
    if (!currentChange || currentChange.contextMode === contextMode || currentChange.isEditing) {
      return;
    }

    const repoPath = resolveActiveProjectPath();
    if (!repoPath) {
      set({
        lastError: tChanges('implement.errors.noActiveRepositoryPath', 'No active repository path found for this task.'),
      });
      return;
    }

    set({ loadingChangeId: id, lastError: null });

    try {
      const reloaded = await loadFileChangeEntry(
        repoPath,
        { path: currentChange.path, status: currentChange.status },
        currentChange,
        contextMode
      );

      set((state) => ({
        changes: updateChangeEntry(state.changes, id, () => reloaded),
        loadingChangeId: null,
        lastError: null,
      }));
    } catch (error) {
      set({
        loadingChangeId: null,
        lastError:
          error instanceof Error
            ? error.message
            : tChanges('implement.errors.loadChangesFailed', 'Failed to load repository changes.'),
      });
    }
  },

  selectChange: (id) => {
    set({ selectedChangeId: id });
  },

  openDiffModal: (id) => {
    set({ selectedChangeId: id, isDiffModalOpen: true });
  },

  closeDiffModal: () => {
    const selectedChangeId = get().selectedChangeId;
    set((state) => ({
      isDiffModalOpen: false,
      changes: selectedChangeId
        ? updateChangeEntry(state.changes, selectedChangeId, (change) => ({
          ...change,
          isEditing: false,
          editingContent: null,
        }))
        : state.changes,
    }));
  },

  markAsReviewed: (id) => {
    set((state) => ({
      changes: updateChangeEntry(state.changes, id, (change) => ({
        ...change,
        reviewed: true,
      })),
    }));
  },

  markAllAsReviewed: () => {
    set((state) => ({
      changes: state.changes.map((change) => ({ ...change, reviewed: true })),
    }));
  },

  startEditingChange: async (id) => {
    const currentChange = get().getChange(id);
    if (!currentChange) return;

    if (!currentChange.canEdit) {
      set({
        lastError: tChanges(
          'implement.errors.deletedChangeReadOnly',
          'Deleted files are read-only during review. Restore them from the task flow instead.'
        ),
      });
      return;
    }

    if (currentChange.contextMode !== 'full') {
      await get().loadChangeContext(id, 'full');
    }

    const latest = get().getChange(id);
    if (!latest) return;

    set((state) => ({
      changes: updateChangeEntry(state.changes, id, (change) => ({
        ...change,
        isEditing: true,
        editingContent: latest.modifiedContent,
      })),
      lastError: null,
    }));
  },

  updateEditingBuffer: (id, content) => {
    set((state) => ({
      changes: updateChangeEntry(state.changes, id, (change) => ({
        ...change,
        editingContent: content,
      })),
    }));
  },

  cancelEditingChange: (id) => {
    set((state) => ({
      changes: updateChangeEntry(state.changes, id, (change) => ({
        ...change,
        isEditing: false,
        editingContent: null,
      })),
    }));
  },

  saveEditedChange: async (id) => {
    const change = get().getChange(id);
    if (!change || !change.canEdit) return;

    if (!tauriIpc.isTauriAvailable()) {
      throw new Error(
        tChanges('implement.errors.commitDesktopOnly', 'Git commit flow is only available in desktop mode.')
      );
    }

    const repoPath = resolveActiveProjectPath();
    if (!repoPath) {
      throw new Error(
        tChanges('implement.errors.noActiveRepositoryPath', 'No active repository path found for this task.')
      );
    }

    const nextContent = change.editingContent ?? change.modifiedContent;

    set({ savingChangeId: id, lastError: null });

    try {
      await tauriIpc.fsWriteFile({
        path: resolveChangeFilePath(repoPath, change.path),
        content: nextContent,
        createDirs: true,
        allowOutsideWorkspace: true,
      });

      set((state) => ({
        changes: updateChangeEntry(state.changes, id, (entry) => ({
          ...entry,
          reviewed: false,
          isEditing: false,
          editingContent: null,
        })),
      }));

      await get().loadCurrentChanges();

      set({ savingChangeId: null, lastError: null });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : tChanges('implement.errors.loadChangesFailed', 'Failed to load repository changes.');
      set({ savingChangeId: null, lastError: message });
      throw error;
    }
  },

  stageReviewedChanges: async () => {
    set({ lastError: null });

    const { repoPath, reviewedPaths } = resolveCommitContext(get().changes);
    await ensureNoForeignStagedFiles(repoPath, reviewedPaths);
    await tauriIpc.gitAdd({ repoPath, paths: reviewedPaths });
    return reviewedPaths;
  },

  commitReviewedChanges: async (message) => {
    const commitMessage = message.trim();
    if (!commitMessage) {
      throw new Error(tChanges('implement.errors.commitMessageRequired', 'Commit message is required.'));
    }

    set({ isCommitting: true, lastError: null });

    try {
      const { repoPath, task, reviewedPaths } = resolveCommitContext(get().changes);
      await ensureNoForeignStagedFiles(repoPath, reviewedPaths);
      await tauriIpc.gitAdd({ repoPath, paths: reviewedPaths });

      const hash = await tauriIpc.gitCommit({
        repoPath,
        message: commitMessage,
        stageAll: false,
      });

      await get().loadCurrentChanges();
      await useTaskStore.getState().completeTask(task.id);

      const latestTask = useTaskStore.getState().getTaskById(task.id);
      const taskCompleted = latestTask?.status === 'Completed';

      set({
        isCommitting: false,
        lastError: taskCompleted
          ? null
          : tChanges(
            'implement.errors.commitSucceededTaskNotCompleted',
            'Changes were committed, but the task could not be completed automatically.'
          ),
        lastCommitHash: hash,
      });

      return {
        hash,
        branch: task.branch_name,
        repoPath,
        committedPaths: reviewedPaths,
        taskId: task.id,
        taskCompleted,
        taskStatus: latestTask?.status ?? null,
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      set({
        isCommitting: false,
        lastError: messageText,
      });
      throw error;
    }
  },

  getChange: (id) => {
    return get().changes.find((change) => change.id === id);
  },

  getStats: () => {
    const changes = get().changes;
    return {
      total: changes.length,
      reviewed: changes.filter((change) => change.reviewed).length,
      additions: changes.reduce((sum, change) => sum + change.additions, 0),
      deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
    };
  },
}));
