import { create } from 'zustand';
import { AppMode, Plan, ProjectGroup, Project } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';
import {
  loadPreference,
  savePreference,
  PREF_KEYS,
} from '../services/preferences';

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
  projectModalOpen: boolean;
  toolsSettingsOpen: boolean;
  providersSettingsOpen: boolean;
  activeThemeId: string;
  leftPanelWidth: number;
  rightPanelWidth: number;
  isLeftPanelOpen: boolean;
  isRightPanelOpen: boolean;
  setMode: (mode: AppMode) => void;
  setTheme: (themeId: string) => void;
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
  openProjectModal: () => void;
  closeProjectModal: () => void;
  openToolsSettings: () => void;
  closeToolsSettings: () => void;
  openProvidersSettings: () => void;
  closeProvidersSettings: () => void;
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
  projectModalOpen: false,
  toolsSettingsOpen: false,
  providersSettingsOpen: false,
  activeThemeId: localStorage.getItem('theme-id') || 'macro-dark',
  leftPanelWidth: 280,
  rightPanelWidth: 320,
  isLeftPanelOpen: true,
  isRightPanelOpen: true,

  setMode: (mode) => set({ mode }),
  setTheme: (themeId) => {
    localStorage.setItem('theme-id', themeId);
    set({ activeThemeId: themeId });
  },

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

  // Settings modal
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  openToolsSettings: () => set({ toolsSettingsOpen: true }),

  closeToolsSettings: () => set({ toolsSettingsOpen: false }),

  openProvidersSettings: () => set({ providersSettingsOpen: true }),

  closeProvidersSettings: () => set({ providersSettingsOpen: false }),

  openAccount: () => set({ accountOpen: true }),

  closeAccount: () => set({ accountOpen: false }),

  openProjectModal: () => set({ projectModalOpen: true }),

  closeProjectModal: () => set({ projectModalOpen: false }),

  createProject: async (data: CreateProjectData) => {
    set({ isLoading: true, lastError: null });
    try {
      // Generate a new project ID
      const projectId = `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const newProject: Project = {
        id: projectId,
        name: data.name,
        path: data.path || data.name.toLowerCase().replace(/\s+/g, '-'),
        created_at: new Date().toISOString(),
        status: 'active',
        metadata: {
          description: data.description,
          tags: [],
          team_members: [],
          api_contracts: [],
          dependencies: [],
        },
      };

      if (data.groupId) {
        // Add project to existing group
        set((state) => ({
          projectGroups: state.projectGroups.map((group) =>
            group.id === data.groupId
              ? { ...group, projects: [...group.projects, newProject] }
              : group
          ),
        }));
      } else {
        // Create new group with this project
        const groupId = `group_${Date.now()}`;
        const newGroup: ProjectGroup = {
          id: groupId,
          name: data.name,
          isOpen: true,
          projects: [newProject],
        };
        set((state) => ({
          projectGroups: [...state.projectGroups, newGroup],
        }));
      }

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
      // Generate a new project ID
      const projectId = `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const newProject: Project = {
        id: projectId,
        name: data.projectName,
        path: data.path || data.projectName.toLowerCase().replace(/\s+/g, '-'),
        created_at: new Date().toISOString(),
        status: 'active',
        metadata: {
          description: `Imported from ${data.gitUrl}`,
          tags: [],
          team_members: [],
          api_contracts: [],
          dependencies: [],
        },
      };

      if (data.groupId) {
        // Add project to existing group
        set((state) => ({
          projectGroups: state.projectGroups.map((group) =>
            group.id === data.groupId
              ? { ...group, projects: [...group.projects, newProject] }
              : group
          ),
        }));
      } else {
        // Create new group with this project
        const groupId = `group_${Date.now()}`;
        const newGroup: ProjectGroup = {
          id: groupId,
          name: data.projectName,
          isOpen: true,
          projects: [newProject],
        };
        set((state) => ({
          projectGroups: [...state.projectGroups, newGroup],
        }));
      }

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
      const [leftWidth, rightWidth, leftOpen, rightOpen] = await Promise.all([
        loadPreference<number>(PREF_KEYS.LEFT_PANEL_WIDTH),
        loadPreference<number>(PREF_KEYS.RIGHT_PANEL_WIDTH),
        loadPreference<boolean>(PREF_KEYS.IS_LEFT_PANEL_OPEN),
        loadPreference<boolean>(PREF_KEYS.IS_RIGHT_PANEL_OPEN),
      ]);

      const { plan, projectGroups } = await services.getAppBootstrap();
      set({
        currentPlan: plan,
        projectGroups,
        selectedGroupId: projectGroups[0]?.id ?? null,
        leftPanelWidth: leftWidth,
        rightPanelWidth: rightWidth,
        isLeftPanelOpen: leftOpen,
        isRightPanelOpen: rightOpen,
        isLoading: false,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    }
  },
}));
