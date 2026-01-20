import { create } from 'zustand';
import { AppMode, Plan, ProjectGroup, Project } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';

export type TaskSortOption = 'status' | 'date' | 'title' | 'project';

interface AppStore {
  mode: AppMode;
  currentPlan: Plan | null;
  projectGroups: ProjectGroup[];
  selectedGroupId: string | null;
  selectedTaskId: string | null;
  taskSortOption: TaskSortOption;
  isLoading: boolean;
  lastError: string | null;
  settingsOpen: boolean;
  accountOpen: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  setMode: (mode: AppMode) => void;
  setCurrentPlan: (plan: Plan | null) => void;
  setProjectGroups: (groups: ProjectGroup[]) => void;
  setSelectedGroup: (groupId: string | null) => void;
  setSelectedTask: (taskId: string | null) => void;
  setTaskSortOption: (option: TaskSortOption) => void;
  toggleProjectGroup: (groupId: string) => void;
  getProjectById: (id: string) => Project | undefined;
  openSettings: () => void;
  closeSettings: () => void;
  openAccount: () => void;
  closeAccount: () => void;
  setLeftPanelWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
  initialize: () => Promise<void>;
}

export const useAppStore = create<AppStore>((set, get) => ({
  mode: 'Implement',
  currentPlan: null,
  projectGroups: [],
  selectedGroupId: null,
  selectedTaskId: null,
  taskSortOption: 'date',
  isLoading: false,
  lastError: null,
  settingsOpen: false,
  accountOpen: false,
  leftPanelWidth: 280,
  rightPanelWidth: 320,

  setMode: (mode) => set({ mode }),

  setCurrentPlan: (plan) => set({ currentPlan: plan }),

  setProjectGroups: (groups) => set({ projectGroups: groups }),

  setSelectedGroup: (groupId) => set({ selectedGroupId: groupId }),

  setSelectedTask: (taskId) => set({ selectedTaskId: taskId }),

  setTaskSortOption: (option) => set({ taskSortOption: option }),

  toggleProjectGroup: (groupId) =>
    set((state) => ({
      projectGroups: state.projectGroups.map((group) =>
        group.id === groupId
          ? { ...group, isOpen: !group.isOpen }
          : group
      ),
    })),

  openSettings: () => set({ settingsOpen: true }),

  closeSettings: () => set({ settingsOpen: false }),

  openAccount: () => set({ accountOpen: true }),

  closeAccount: () => set({ accountOpen: false }),

  setLeftPanelWidth: (width) => set({ leftPanelWidth: Math.max(200, Math.min(600, width)) }),

  setRightPanelWidth: (width) => set({ rightPanelWidth: Math.max(200, Math.min(600, width)) }),

  getProjectById: (id) => {
    const state = get();
    for (const group of state.projectGroups) {
      const project = group.projects.find((p) => p.id === id);
      if (project) return project;
    }
    return undefined;
  },

  initialize: async () => {
    set({ isLoading: true, lastError: null });
    try {
      const { plan, projectGroups } = await services.getAppBootstrap();
      set({
        currentPlan: plan,
        projectGroups,
        selectedGroupId: projectGroups[0]?.id ?? null,
        isLoading: false,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    }
  },
}));
