import { create } from 'zustand';
import { PredictedGitTree, GitCommit } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';

interface GitStore {
  trees: Record<string, PredictedGitTree>;
  commits: GitCommit[];
  isLoading: boolean;
  lastError: string | null;
  loadTree: (projectId: string) => Promise<void>;
  loadCommits: () => Promise<void>;
}

export const useGitStore = create<GitStore>((set) => ({
  trees: {},
  commits: [],
  isLoading: false,
  lastError: null,

  loadTree: async (projectId) => {
    set({ isLoading: true, lastError: null });
    try {
      const { tree } = await services.getGitTreeForProject(projectId);
      if (tree) {
        set((state) => ({
          trees: { ...state.trees, [projectId]: tree },
          isLoading: false,
        }));
      } else {
        set({ isLoading: false });
      }
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    }
  },

  loadCommits: async () => {
    set({ isLoading: true, lastError: null });
    try {
      const { commits } = await services.listCommits();
      set({ commits, isLoading: false });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    }
  },
}));
