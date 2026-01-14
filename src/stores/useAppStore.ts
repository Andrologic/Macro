import { create } from 'zustand';
import { AppMode, Plan, ProjectGroup, Project } from '../types';
import { mockAuthPlan, mockProjects } from '../mock-data/auth-scenario';

interface AppStore {
  mode: AppMode;
  currentPlan: Plan | null;
  projectGroups: ProjectGroup[];
  selectedGroupId: string | null;
  setMode: (mode: AppMode) => void;
  setCurrentPlan: (plan: Plan | null) => void;
  setProjectGroups: (groups: ProjectGroup[]) => void;
  setSelectedGroup: (groupId: string | null) => void;
  toggleProjectGroup: (groupId: string) => void;
  getProjectById: (id: string) => Project | undefined;
}

export const useAppStore = create<AppStore>((set, get) => ({
  mode: 'Implement',
  currentPlan: mockAuthPlan,
  projectGroups: mockProjects,
  selectedGroupId: 'group-1',

  setMode: (mode) => set({ mode }),

  setCurrentPlan: (plan) => set({ currentPlan: plan }),

  setProjectGroups: (groups) => set({ projectGroups: groups }),

  setSelectedGroup: (groupId) => set({ selectedGroupId: groupId }),

  toggleProjectGroup: (groupId) =>
    set((state) => ({
      projectGroups: state.projectGroups.map((group) =>
        group.id === groupId
          ? { ...group, isOpen: !group.isOpen }
          : group
      ),
    })),

  getProjectById: (id) => {
    const state = get();
    for (const group of state.projectGroups) {
      const project = group.projects.find((p) => p.id === id);
      if (project) return project;
    }
    return undefined;
  },
}));
