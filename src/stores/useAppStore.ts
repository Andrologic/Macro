import { create } from 'zustand';
import { AppMode, Plan, ProjectGroup, Project, PlanNode, PredictedBranch } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';
import {
  loadPreference,
  savePreference,
  PREF_KEYS,
} from '../services/preferences';

export type TaskSortOption = 'status' | 'date' | 'title' | 'project';
export type SettingsTab = 'general' | 'appearance' | 'ai' | 'tools' | 'shortcuts';
export type UiZoomMode = 'auto' | 'override';

interface AppStore {
  mode: AppMode;
  currentPlan: Plan | null;
  projectGroups: ProjectGroup[];
  selectedGroupId: string | null;
  selectedProjectId: string | null; // null = entire group view
  selectedTaskId: string | null;
  taskSortOption: TaskSortOption;
  isLoading: boolean;
  lastError: string | null;
  settingsOpen: boolean;
  activeSettingsTab: SettingsTab; // Added
  accountOpen: boolean;
  projectModalOpen: boolean;
  activeThemeId: string;
  leftPanelWidth: number;
  rightPanelWidth: number;
  isLeftPanelOpen: boolean;
  isRightPanelOpen: boolean;
  enabledModes: AppMode[];
  uiZoomMode: UiZoomMode;
  uiZoomLevel: number;
  // Architect mode state
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  setMode: (mode: AppMode) => void;
  setTheme: (themeId: string) => void;
  setCurrentPlan: (plan: Plan | null) => void;
  setProjectGroups: (groups: ProjectGroup[]) => void;
  setSelectedGroup: (groupId: string | null) => void;
  setSelectedProject: (projectId: string | null) => void;
  setSelectedTask: (taskId: string | null) => void;
  setTaskSortOption: (option: TaskSortOption) => void;
  toggleProjectGroup: (groupId: string) => void;
  getProjectById: (id: string) => Project | undefined;
  setEnabledModes: (modes: AppMode[]) => void;
  setUiZoomMode: (mode: UiZoomMode) => void;
  setUiZoomLevel: (level: number) => void;
  setPlanNodes: (nodes: PlanNode[]) => void;
  setPredictedBranches: (branches: PredictedBranch[]) => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  openAccount: () => void;
  closeAccount: () => void;
  openProjectModal: () => void;
  closeProjectModal: () => void;
  createProject: (data: CreateProjectData) => Promise<void>;
  importProject: (data: ImportProjectData) => Promise<void>;
  setLeftPanelWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  initialize: () => Promise<void>;
}

interface CreateProjectData {
  name: string;
  description: string;
  groupId: string | null;
  path?: string;
}

interface ImportProjectData {
  gitUrl: string;
  projectName: string;
  branch: string;
  groupId: string | null;
  path?: string;
}

const derivePlanNodesFromPlan = (plan: Plan | null): PlanNode[] => {
  if (!plan?.tasks?.length) {
    return [];
  }

  return plan.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    type: 'task',
    status:
      task.status === 'Completed'
        ? 'completed'
        : task.status === 'InProgress'
          ? 'in-progress'
          : task.status === 'Blocked'
            ? 'blocked'
            : 'pending',
    dependencies: task.dependencies,
    projectId: task.project_id,
  }));
};

export const useAppStore = create<AppStore>((set, get) => ({
  mode: 'Implement',
  currentPlan: null,
  projectGroups: [],
  selectedGroupId: null,
  selectedProjectId: null,
  selectedTaskId: null,
  taskSortOption: 'date',
  isLoading: false,
  lastError: null,
  settingsOpen: false,
  activeSettingsTab: 'general',
  accountOpen: false,
  projectModalOpen: false,
  activeThemeId: localStorage.getItem('theme-id') || 'macro-dark',
  leftPanelWidth: 280,
  rightPanelWidth: 320,
  isLeftPanelOpen: true,
  isRightPanelOpen: true,
  enabledModes: ['Architect', 'Implement', 'Chat', 'Debug'],
  uiZoomMode: 'auto',
  uiZoomLevel: 1,
  planNodes: [],
  predictedBranches: [],

  setMode: (mode) => set({ mode }),
  setTheme: (themeId) => {
    localStorage.setItem('theme-id', themeId);
    set({ activeThemeId: themeId });
  },

  setCurrentPlan: (plan) => set({ currentPlan: plan }),

  setProjectGroups: (groups) => set({ projectGroups: groups }),

  setSelectedGroup: (groupId) => {
    set({ selectedGroupId: groupId, selectedProjectId: null });
    void savePreference(PREF_KEYS.LAST_SELECTED_GROUP_ID, groupId);
    void savePreference(PREF_KEYS.LAST_SELECTED_PROJECT_ID, null);
  },

  setSelectedProject: (projectId) => {
    set({ selectedProjectId: projectId });
    void savePreference(PREF_KEYS.LAST_SELECTED_PROJECT_ID, projectId);

    if (projectId) {
      const state = get();
      const matchingGroup = state.projectGroups.find((group) =>
        group.projects.some((project) => project.id === projectId)
      );
      if (matchingGroup) {
        set({ selectedGroupId: matchingGroup.id });
        void savePreference(PREF_KEYS.LAST_SELECTED_GROUP_ID, matchingGroup.id);
      }
    }
  },

  setSelectedTask: (taskId) => set({ selectedTaskId: taskId }),

  setEnabledModes: (modes) => set({ enabledModes: modes }),

  setUiZoomMode: (mode) => {
    set({ uiZoomMode: mode });
    void savePreference(PREF_KEYS.UI_ZOOM_MODE, mode);
  },

  setUiZoomLevel: (level) => {
    const clampedLevel = Math.max(0.75, Math.min(2, level));
    set({ uiZoomLevel: clampedLevel });
    void savePreference(PREF_KEYS.UI_ZOOM_LEVEL, clampedLevel);
  },

  setPlanNodes: (nodes) => set({ planNodes: nodes }),

  setPredictedBranches: (branches) => set({ predictedBranches: branches }),

  setTaskSortOption: (option) => set({ taskSortOption: option }),

  toggleProjectGroup: (groupId) =>
    set((state) => ({
      projectGroups: state.projectGroups.map((group) =>
        group.id === groupId
          ? { ...group, isOpen: !group.isOpen }
          : group
      ),
    })),

  // Settings modal
  openSettings: (tab = 'general') => set({ settingsOpen: true, activeSettingsTab: tab }),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (tab) => set({ activeSettingsTab: tab }),

  openAccount: () => set({ accountOpen: true }),

  closeAccount: () => set({ accountOpen: false }),

  openProjectModal: () => set({ projectModalOpen: true }),

  closeProjectModal: () => set({ projectModalOpen: false }),

  createProject: async (data: CreateProjectData) => {
    set({ isLoading: true, lastError: null });
    try {
      const { project: newProject } = await services.createProject(data);
      let targetGroupId = data.groupId;

      if (data.groupId) {
        set((state) => ({
          projectGroups: state.projectGroups.map((group) =>
            group.id === data.groupId
              ? { ...group, projects: [...group.projects, newProject] }
              : group
          ),
        }));
      } else {
        targetGroupId = `group_${Date.now()}`;
        const newGroup: ProjectGroup = {
          id: targetGroupId,
          name: data.name,
          isOpen: true,
          projects: [newProject],
        };
        set((state) => ({
          projectGroups: [...state.projectGroups, newGroup],
        }));
      }

      set((state) => ({
        currentPlan: state.currentPlan
          ? {
              ...state.currentPlan,
              project_ids: state.currentPlan.project_ids.includes(newProject.id)
                ? state.currentPlan.project_ids
                : [...state.currentPlan.project_ids, newProject.id],
            }
          : state.currentPlan,
      }));

      set({
        selectedGroupId: targetGroupId,
        selectedProjectId: newProject.id,
      });
      void savePreference(PREF_KEYS.LAST_SELECTED_GROUP_ID, targetGroupId);
      void savePreference(PREF_KEYS.LAST_SELECTED_PROJECT_ID, newProject.id);

      set({ isLoading: false, lastError: null });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      throw normalized;
    }
  },

  importProject: async (data: ImportProjectData) => {
    set({ isLoading: true, lastError: null });
    try {
      const { project: newProject } = await services.importGitRepo(data);
      let targetGroupId = data.groupId;

      if (data.groupId) {
        set((state) => ({
          projectGroups: state.projectGroups.map((group) =>
            group.id === data.groupId
              ? { ...group, projects: [...group.projects, newProject] }
              : group
          ),
        }));
      } else {
        targetGroupId = `group_${Date.now()}`;
        const newGroup: ProjectGroup = {
          id: targetGroupId,
          name: data.projectName,
          isOpen: true,
          projects: [newProject],
        };
        set((state) => ({
          projectGroups: [...state.projectGroups, newGroup],
        }));
      }

      set((state) => ({
        currentPlan: state.currentPlan
          ? {
              ...state.currentPlan,
              project_ids: state.currentPlan.project_ids.includes(newProject.id)
                ? state.currentPlan.project_ids
                : [...state.currentPlan.project_ids, newProject.id],
            }
          : state.currentPlan,
      }));

      set({
        selectedGroupId: targetGroupId,
        selectedProjectId: newProject.id,
      });
      void savePreference(PREF_KEYS.LAST_SELECTED_GROUP_ID, targetGroupId);
      void savePreference(PREF_KEYS.LAST_SELECTED_PROJECT_ID, newProject.id);

      set({ isLoading: false, lastError: null });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      throw normalized;
    }
  },

  setLeftPanelWidth: (width) => {
    const clampedWidth = Math.max(200, Math.min(600, width));
    set({ leftPanelWidth: clampedWidth });
    // Persist asynchronously (fire and forget)
    void savePreference(PREF_KEYS.LEFT_PANEL_WIDTH, clampedWidth);
  },

  setRightPanelWidth: (width) => {
    const clampedWidth = Math.max(200, Math.min(600, width));
    set({ rightPanelWidth: clampedWidth });
    // Persist asynchronously (fire and forget)
    void savePreference(PREF_KEYS.RIGHT_PANEL_WIDTH, clampedWidth);
  },

  setLeftPanelOpen: (open) => {
    set({ isLeftPanelOpen: open });
    void savePreference(PREF_KEYS.IS_LEFT_PANEL_OPEN, open);
  },

  setRightPanelOpen: (open) => {
    set({ isRightPanelOpen: open });
    void savePreference(PREF_KEYS.IS_RIGHT_PANEL_OPEN, open);
  },

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
      // Load persisted panel preferences
      const [leftWidth, rightWidth, leftOpen, rightOpen, uiZoomMode, uiZoomLevel, lastSelectedGroupId, lastSelectedProjectId] = await Promise.all([
        loadPreference<number>(PREF_KEYS.LEFT_PANEL_WIDTH),
        loadPreference<number>(PREF_KEYS.RIGHT_PANEL_WIDTH),
        loadPreference<boolean>(PREF_KEYS.IS_LEFT_PANEL_OPEN),
        loadPreference<boolean>(PREF_KEYS.IS_RIGHT_PANEL_OPEN),
        loadPreference<UiZoomMode>(PREF_KEYS.UI_ZOOM_MODE),
        loadPreference<number>(PREF_KEYS.UI_ZOOM_LEVEL),
        loadPreference<string | null>(PREF_KEYS.LAST_SELECTED_GROUP_ID),
        loadPreference<string | null>(PREF_KEYS.LAST_SELECTED_PROJECT_ID),
      ]);

      const normalizedZoomMode: UiZoomMode = uiZoomMode === 'override' ? 'override' : 'auto';
      const normalizedZoomLevel = Math.max(0.75, Math.min(2, uiZoomLevel));

      const { plan, projectGroups, planNodes, predictedBranches } = await services.getAppBootstrap();

      let resolvedGroupId: string | null = null;
      let resolvedProjectId: string | null = null;

      if (lastSelectedProjectId) {
        const groupForProject = projectGroups.find((group) =>
          group.projects.some((project) => project.id === lastSelectedProjectId)
        );
        if (groupForProject) {
          resolvedGroupId = groupForProject.id;
          resolvedProjectId = lastSelectedProjectId;
        }
      }

      if (!resolvedGroupId && lastSelectedGroupId) {
        const existingGroup = projectGroups.find((group) => group.id === lastSelectedGroupId);
        if (existingGroup) {
          resolvedGroupId = existingGroup.id;
        }
      }

      if (!resolvedGroupId) {
        resolvedGroupId = projectGroups[0]?.id ?? null;
      }

      set({
        currentPlan: plan,
        projectGroups,
        planNodes: planNodes?.length ? planNodes : derivePlanNodesFromPlan(plan),
        predictedBranches: predictedBranches ?? [],
        selectedGroupId: resolvedGroupId,
        selectedProjectId: resolvedProjectId,
        leftPanelWidth: leftWidth,
        rightPanelWidth: rightWidth,
        isLeftPanelOpen: leftOpen,
        isRightPanelOpen: rightOpen,
        uiZoomMode: normalizedZoomMode,
        uiZoomLevel: normalizedZoomLevel,
        isLoading: false,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    }
  },
}));
