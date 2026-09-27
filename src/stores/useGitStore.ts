import { create } from 'zustand';
import { PredictedGitTree, GitCommit } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';

interface GitWorktreeEnsureResult {
  taskId: string;
  worktreePath: string;
  branchName: string;
  createdByThisCall?: boolean;
  status: 'created' | 'reused' | 'repaired';
}

interface GitWorktreeRemoveResult {
  taskId: string;
  worktreePath: string;
  removedPath: boolean;
  prunedRegistration: boolean;
  alreadyAbsent: boolean;
}

interface GitStore {
  trees: Record<string, PredictedGitTree>;
  commitsByProject: Record<string, GitCommit[]>;
  isLoading: boolean;
  lastError: string | null;
  invalidateProject: (projectId: string) => void;
  loadTree: (projectId: string) => Promise<void>;
  loadCommits: (projectId: string) => Promise<void>;
  createWorktree: (
    projectId: string,
    taskId: string,
    branchName: string,
    fromRef?: string | null,
    preferredCommitBranch?: string | null,
    fallbackBranches?: string[] | null
  ) => Promise<GitWorktreeEnsureResult | null>;
  removeWorktree: (projectId: string, taskId: string) => Promise<GitWorktreeRemoveResult | null>;
}

export const useGitStore = create<GitStore>((set) => {
  const treeRequests = new Map<string, object>();
  const commitRequests = new Map<string, object>();
  return ({
  trees: {},
  commitsByProject: {},
  isLoading: false,
  lastError: null,

  invalidateProject: (projectId) => {
    treeRequests.delete(projectId);
    commitRequests.delete(projectId);
    set((state) => {
      const trees = { ...state.trees };
      const commitsByProject = { ...state.commitsByProject };
      delete trees[projectId];
      delete commitsByProject[projectId];
      return { trees, commitsByProject, isLoading: treeRequests.size + commitRequests.size > 0 };
    });
  },

  loadTree: async (projectId) => {
    const request = {};
    treeRequests.set(projectId, request);
    set({ isLoading: true, lastError: null });
    try {
      const { tree } = await services.getGitTreeForProject(projectId);
      if (treeRequests.get(projectId) !== request) return;
      if (tree) {
        set((state) => ({
          trees: { ...state.trees, [projectId]: tree },
          isLoading: false,
        }));
      } else {
        set({ isLoading: false });
      }
    } catch (error) {
      if (treeRequests.get(projectId) !== request) return;
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    } finally {
      if (treeRequests.get(projectId) === request) {
        treeRequests.delete(projectId);
        set({ isLoading: treeRequests.size + commitRequests.size > 0 });
      }
    }
  },

  loadCommits: async (projectId) => {
    const request = {};
    commitRequests.set(projectId, request);
    set({ isLoading: true, lastError: null });
    try {
      const { commits } = await services.listCommits(projectId);
      if (commitRequests.get(projectId) !== request) return;
      set((state) => ({
        commitsByProject: { ...state.commitsByProject, [projectId]: commits },
        isLoading: false,
      }));
    } catch (error) {
      if (commitRequests.get(projectId) !== request) return;
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    } finally {
      if (commitRequests.get(projectId) === request) {
        commitRequests.delete(projectId);
        set({ isLoading: treeRequests.size + commitRequests.size > 0 });
      }
    }
  },

  createWorktree: async (
    projectId: string,
    taskId: string,
    branchName: string,
    fromRef?: string | null,
    preferredCommitBranch?: string | null,
    fallbackBranches?: string[] | null
  ) => {
    set({ isLoading: true, lastError: null });
    try {
      const result = await services.gitWorktreeCreate(
        projectId,
        taskId,
        branchName,
        fromRef,
        preferredCommitBranch,
        fallbackBranches
      );
      set({ isLoading: false });
      return result;
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      return null;
    }
  },

  removeWorktree: async (projectId: string, taskId: string) => {
    set({ isLoading: true, lastError: null });
    try {
      const result = await services.gitWorktreeRemove(projectId, taskId);
      set({ isLoading: false });
      return result;
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      return null;
    }
  },
});
});
