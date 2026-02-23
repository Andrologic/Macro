import { create } from 'zustand';
import { PredictedGitTree, GitCommit } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';

interface GitStore {
  trees: Record<string, PredictedGitTree>;
  commitsByProject: Record<string, GitCommit[]>;
  isLoading: boolean;
  lastError: string | null;
  loadTree: (projectId: string) => Promise<void>;
  loadCommits: (projectId: string) => Promise<void>;
  createWorktree: (projectId: string, taskId: string, branchName: string) => Promise<string | null>;
  removeWorktree: (projectId: string, taskId: string) => Promise<void>;
}

export const useGitStore = create<GitStore>((set) => ({
  trees: {},
  commitsByProject: {},
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

  loadCommits: async (projectId) => {
    set({ isLoading: true, lastError: null });
    try {
      const { commits } = await services.listCommits(projectId);
      set((state) => ({
        commitsByProject: { ...state.commitsByProject, [projectId]: commits },
        isLoading: false,
      }));
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    }
  },

  createWorktree: async (projectId: string, taskId: string, branchName: string) => {
    set({ isLoading: true, lastError: null });
    try {
      const worktreePath = await services.gitWorktreeCreate(projectId, taskId, branchName);
      set({ isLoading: false });
      return worktreePath;
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      return null;
    }
  },

  removeWorktree: async (projectId: string, taskId: string) => {
    set({ isLoading: true, lastError: null });
    try {
      await services.gitWorktreeRemove(projectId, taskId);
      set({ isLoading: false });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    }
  },
}));
