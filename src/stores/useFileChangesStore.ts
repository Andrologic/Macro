import { create } from 'zustand';
import { mockFileChanges, FileChangeEntry } from '../mock-data/file-changes';

interface FileChangesState {
  changes: FileChangeEntry[];
  selectedChangeId: string | null;
  isDiffModalOpen: boolean;

  // Actions
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
  changes: mockFileChanges,
  selectedChangeId: null,
  isDiffModalOpen: false,

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
