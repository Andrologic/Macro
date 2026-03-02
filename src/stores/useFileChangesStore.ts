import { create } from 'zustand';
import { useAppStore } from './useAppStore';
import { useTaskStore } from './useTaskStore';
import * as tauriIpc from '../services/tauriIpc';
import { parseUnifiedDiff } from '../services/gitDiffParser';

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
}

export interface FolderNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children?: FolderNode[];
  fileChange?: FileChangeEntry;
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

      let existing = current.find((n) => n.name === part);

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
    const group = appState.projectGroups.find((g) => g.id === appState.selectedGroupId);
    return group?.projects[0]?.path ?? null;
  }

  return appState.projectGroups[0]?.projects[0]?.path ?? null;
};

interface FileChangesState {
  changes: FileChangeEntry[];
  selectedChangeId: string | null;
  isDiffModalOpen: boolean;
  isLoading: boolean;
  lastError: string | null;

  // Actions
  loadCurrentChanges: () => Promise<void>;
  selectChange: (id: string | null) => void;
  openDiffModal: (id: string) => void;
  closeDiffModal: () => void;
  markAsReviewed: (id: string) => void;
  markAllAsReviewed: () => void;
  getChange: (id: string) => FileChangeEntry | undefined;

  // Stats
  getStats: () => { total: number; reviewed: number; additions: number; deletions: number };
}

export const useFileChangesStore = create<FileChangesState>((set, get) => ({
  changes: [],
  selectedChangeId: null,
  isDiffModalOpen: false,
  isLoading: false,
  lastError: null,

  loadCurrentChanges: async () => {
    set({ isLoading: true, lastError: null });

    if (!tauriIpc.isTauriAvailable()) {
      set({ isLoading: false, changes: [], lastError: null });
      return;
    }

    try {
      const repoPath = resolveActiveProjectPath();
      if (!repoPath) {
        set({ isLoading: false, changes: [], lastError: null });
        return;
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

      const reviewedById = new Map(get().changes.map((change) => [change.id, change.reviewed]));

      const entries: FileChangeEntry[] = [];
      for (const file of uniqueByPath.values()) {
        const patch = await tauriIpc.gitDiff({
          repoPath,
          paths: [file.path],
          contextLines: 3,
        });

        const parsed = parseUnifiedDiff(patch || '');
        const id = `change-${file.path}`;

        entries.push({
          id,
          path: file.path,
          status: normalizeStatus(file.status),
          additions: parsed.additions,
          deletions: parsed.deletions,
          reviewed: reviewedById.get(id) ?? false,
          originalContent: parsed.originalContent,
          modifiedContent: parsed.modifiedContent,
          language: deriveLanguage(file.path),
        });
      }

      set({ changes: entries, isLoading: false, lastError: null });
    } catch (error) {
      set({
        isLoading: false,
        changes: [],
        lastError: error instanceof Error ? error.message : String(error),
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
    set({ isDiffModalOpen: false });
  },

  markAsReviewed: (id) => {
    set((state) => ({
      changes: state.changes.map((c) =>
        c.id === id ? { ...c, reviewed: true } : c
      ),
    }));
  },

  markAllAsReviewed: () => {
    set((state) => ({
      changes: state.changes.map((c) => ({ ...c, reviewed: true })),
    }));
  },

  getChange: (id) => {
    return get().changes.find((c) => c.id === id);
  },

  getStats: () => {
    const changes = get().changes;
    return {
      total: changes.length,
      reviewed: changes.filter((c) => c.reviewed).length,
      additions: changes.reduce((sum, c) => sum + c.additions, 0),
      deletions: changes.reduce((sum, c) => sum + c.deletions, 0),
    };
  },
}));
