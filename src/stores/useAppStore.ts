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

interface RememberedProject {
  projectId: string;
  groupId: string;
  name: string;
  path: string;
  lastOpenedAt: string;
}

const MAX_REMEMBERED_PROJECTS = 50;

const upsertRememberedProject = (
  projects: RememberedProject[],
  nextProject: RememberedProject
): RememberedProject[] => {
  const filtered = projects.filter((project) =>
    project.projectId !== nextProject.projectId && project.path !== nextProject.path
  );
  return [nextProject, ...filtered].slice(0, MAX_REMEMBERED_PROJECTS);
};

const insertProjectInGroups = (
  groups: ProjectGroup[],
  project: Project,
  requestedGroupId: string | null
): { projectGroups: ProjectGroup[]; targetGroupId: string } => {
  if (requestedGroupId) {
    const hasRequestedGroup = groups.some((group) => group.id === requestedGroupId);
    if (hasRequestedGroup) {
      return {
        projectGroups: groups.map((group) =>
          group.id === requestedGroupId
            ? { ...group, projects: [...group.projects, project] }
            : group
        ),
        targetGroupId: requestedGroupId,
      };
    }
  }

  const newGroupId = `group_${Date.now()}`;
  const newGroup: ProjectGroup = {
    id: newGroupId,
    name: project.name,
    isOpen: true,
    projects: [project],
  };

  return {
    projectGroups: [...groups, newGroup],
    targetGroupId: newGroupId,
  };
};

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/$/, '');

const projectNameFromPath = (path: string): string => {
  const normalized = normalizePath(path);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
};

const isLegacyWorkspaceMockPath = (path?: string): boolean => {
  const normalized = normalizePath(path || '');
  return normalized.startsWith('/path/to/');
};

const pruneLegacyWorkspaceMocks = (groups: ProjectGroup[]): ProjectGroup[] => {
  return groups
    .map((group) => ({
      ...group,
      projects: group.projects.filter((project) => !isLegacyWorkspaceMockPath(project.path)),
    }))
    .filter((group) => group.projects.length > 0);
};

const pruneLegacyRememberedProjects = (
  projects: RememberedProject[]
): RememberedProject[] => projects.filter((project) => !isLegacyWorkspaceMockPath(project.path));

const mergeRememberedProjectsIntoGroups = (
  groups: ProjectGroup[],
  rememberedProjects: RememberedProject[]
): ProjectGroup[] => {
  const existingPaths = new Set(
    groups
      .flatMap((group) => group.projects)
      .map((project) => normalizePath(project.path))
  );

  const missingPaths = new Set<string>();

  const missingRemembered = rememberedProjects.filter((remembered) => {
    const normalizedPath = normalizePath(remembered.path);
    if (!normalizedPath) return false;
    if (existingPaths.has(normalizedPath)) return false;
    if (missingPaths.has(normalizedPath)) return false;

    missingPaths.add(normalizedPath);
    return true;
  });

  if (missingRemembered.length === 0) {
    return groups;
  }

  const sessionGroups = missingRemembered.map((remembered, index) => {
    const normalizedPath = normalizePath(remembered.path);
    const sessionProjectId = `session-project-${Date.now()}-${index}`;
    const sessionGroupId = `session-group-${Date.now()}-${index}`;
    const projectName = remembered.name?.trim() || projectNameFromPath(normalizedPath);

    return {
      id: sessionGroupId,
      name: projectName,
      isOpen: true,
      projects: [
        {
          id: sessionProjectId,
          name: projectName,
          path: normalizedPath,
          created_at: new Date().toISOString(),
          status: 'active' as const,
          metadata: {
            description: 'Restored from session history',
            tags: [],
            team_members: [],
            api_contracts: [],
            dependencies: [],
          },
        },
      ],
    };
  });

  return [...groups, ...sessionGroups];
};

const dedupeProjectGroupsByPath = (groups: ProjectGroup[]): ProjectGroup[] => {
  const seenPaths = new Set<string>();

  return groups
    .map((group) => {
      const dedupedProjects = group.projects.filter((project) => {
        const normalizedPath = normalizePath(project.path);
        if (!normalizedPath) return false;
        if (seenPaths.has(normalizedPath)) return false;
        seenPaths.add(normalizedPath);
        return true;
      });

      return {
        ...group,
        projects: dedupedProjects,
      };
    })
    .filter((group) => group.projects.length > 0);
};

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
  recentProjects: RememberedProject[];
  macroEnabledProjects: RememberedProject[];
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
  renameProjectGroup: (groupId: string, name: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  archiveProjectGroup: (groupId: string) => Promise<void>;
  archiveProject: (projectId: string) => Promise<void>;
  closeProject: (projectId: string) => Promise<void>;
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
  recentProjects: [],
  macroEnabledProjects: [],
  planNodes: [],
  predictedBranches: [],

  setMode: (mode) => {
    set({ mode });
    void savePreference(PREF_KEYS.LAST_ACTIVE_MODE, mode);
  },
  setTheme: (themeId) => {
    localStorage.setItem('theme-id', themeId);
    set({ activeThemeId: themeId });
  },

  setCurrentPlan: (plan) => set({ currentPlan: plan }),

  setProjectGroups: (groups) => set({ projectGroups: groups }),

  setSelectedGroup: (groupId) => {
    set({ selectedGroupId: groupId, selectedProjectId: null });
    void savePreference(PREF_KEYS.LAST_SELECTED_GROUP_ID, groupId);
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
        const matchingProject = matchingGroup.projects.find((project) => project.id === projectId);
        set({ selectedGroupId: matchingGroup.id });
        void savePreference(PREF_KEYS.LAST_SELECTED_GROUP_ID, matchingGroup.id);

        if (matchingProject) {
          const rememberedProject: RememberedProject = {
            projectId: matchingProject.id,
            groupId: matchingGroup.id,
            name: matchingProject.name,
            path: matchingProject.path,
            lastOpenedAt: new Date().toISOString(),
          };

          const nextRecentProjects = upsertRememberedProject(state.recentProjects, rememberedProject);
          const nextMacroEnabledProjects = upsertRememberedProject(state.macroEnabledProjects, rememberedProject);

          set({
            recentProjects: nextRecentProjects,
            macroEnabledProjects: nextMacroEnabledProjects,
          });

          void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
          void savePreference(PREF_KEYS.MACRO_ENABLED_PROJECTS, nextMacroEnabledProjects);
          void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, matchingProject.path);
        }
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

  renameProjectGroup: async (groupId, name) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    set({ isLoading: true, lastError: null });
    try {
      const { projectGroup } = await services.renameProjectGroup({
        groupId,
        name: trimmedName,
      });

      set((state) => ({
        projectGroups: state.projectGroups.map((group) =>
          group.id === groupId ? projectGroup : group
        ),
        isLoading: false,
        lastError: null,
      }));
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      throw normalized;
    }
  },

  renameProject: async (projectId, name) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    set({ isLoading: true, lastError: null });
    try {
      const { project: updatedProject } = await services.renameProject({
        projectId,
        name: trimmedName,
      });

      set((state) => ({
        projectGroups: state.projectGroups.map((group) => ({
          ...group,
          projects: group.projects.map((project) =>
            project.id === projectId ? updatedProject : project
          ),
        })),
        isLoading: false,
        lastError: null,
      }));
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      throw normalized;
    }
  },

  archiveProjectGroup: async (groupId) => {
    set({ isLoading: true, lastError: null });
    try {
      const { projectGroup } = await services.archiveProjectGroup({ groupId });

      set((state) => ({
        projectGroups: state.projectGroups.map((group) =>
          group.id === groupId ? projectGroup : group
        ),
        isLoading: false,
        lastError: null,
      }));
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      throw normalized;
    }
  },

  archiveProject: async (projectId) => {
    set({ isLoading: true, lastError: null });
    try {
      const { project: updatedProject } = await services.archiveProject({ projectId });

      set((state) => ({
        projectGroups: state.projectGroups.map((group) => ({
          ...group,
          projects: group.projects.map((project) =>
            project.id === projectId ? updatedProject : project
          ),
        })),
        isLoading: false,
        lastError: null,
      }));
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      throw normalized;
    }
  },

  closeProject: async (projectId) => {
    set({ isLoading: true, lastError: null });
    try {
      const { projectGroups } = await services.closeProject({ projectId });
      const previousState = get();

      const nextSelectedProjectId = previousState.selectedProjectId === projectId
        ? null
        : previousState.selectedProjectId;

      let nextSelectedGroupId = previousState.selectedGroupId;
      if (!projectGroups.some((group) => group.id === nextSelectedGroupId)) {
        nextSelectedGroupId = projectGroups[0]?.id ?? null;
      }

      const nextRecentProjects = previousState.recentProjects.filter((project) => project.projectId !== projectId);
      const nextMacroEnabledProjects = previousState.macroEnabledProjects.filter((project) => project.projectId !== projectId);

      set({
        projectGroups,
        selectedGroupId: nextSelectedGroupId,
        selectedProjectId: nextSelectedProjectId,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        isLoading: false,
        lastError: null,
      });

      void savePreference(PREF_KEYS.LAST_SELECTED_GROUP_ID, nextSelectedGroupId);
      void savePreference(PREF_KEYS.LAST_SELECTED_PROJECT_ID, nextSelectedProjectId);
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(PREF_KEYS.MACRO_ENABLED_PROJECTS, nextMacroEnabledProjects);
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      throw normalized;
    }
  },

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
      const state = get();
      const { projectGroups: syncedGroups, plan, planNodes, predictedBranches } = await services.getAppBootstrap();
      const groupForProject = syncedGroups.find((group) =>
        group.projects.some((project) => project.id === newProject.id)
      );
      const hasSyncedProject = Boolean(groupForProject);

      const {
        projectGroups: nextProjectGroups,
        targetGroupId,
      } = hasSyncedProject
        ? {
            projectGroups: syncedGroups,
            targetGroupId: groupForProject?.id ?? data.groupId ?? `group_${Date.now()}`,
          }
        : insertProjectInGroups(state.projectGroups, newProject, data.groupId);

      const rememberedProject: RememberedProject | null = targetGroupId
        ? {
            projectId: newProject.id,
            groupId: targetGroupId,
            name: newProject.name,
            path: newProject.path,
            lastOpenedAt: new Date().toISOString(),
          }
        : null;

      const nextRecentProjects = rememberedProject
        ? upsertRememberedProject(state.recentProjects, rememberedProject)
        : state.recentProjects;
      const nextMacroEnabledProjects = rememberedProject
        ? upsertRememberedProject(state.macroEnabledProjects, rememberedProject)
        : state.macroEnabledProjects;

      const nextPlan = hasSyncedProject
        ? plan
        : state.currentPlan
          ? {
              ...state.currentPlan,
              project_ids: state.currentPlan.project_ids.includes(newProject.id)
                ? state.currentPlan.project_ids
                : [...state.currentPlan.project_ids, newProject.id],
            }
          : state.currentPlan;

      set({
        currentPlan: nextPlan,
        projectGroups: nextProjectGroups,
        planNodes: hasSyncedProject ? (planNodes?.length ? planNodes : derivePlanNodesFromPlan(plan)) : state.planNodes,
        predictedBranches: hasSyncedProject ? (predictedBranches ?? []) : state.predictedBranches,
        selectedGroupId: targetGroupId,
        selectedProjectId: newProject.id,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
      });
      void savePreference(PREF_KEYS.LAST_SELECTED_GROUP_ID, targetGroupId);
      void savePreference(PREF_KEYS.LAST_SELECTED_PROJECT_ID, newProject.id);
      void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, newProject.path);
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(PREF_KEYS.MACRO_ENABLED_PROJECTS, nextMacroEnabledProjects);

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
      const state = get();
      const { projectGroups: syncedGroups, plan, planNodes, predictedBranches } = await services.getAppBootstrap();
      const groupForProject = syncedGroups.find((group) =>
        group.projects.some((project) => project.id === newProject.id)
      );
      const hasSyncedProject = Boolean(groupForProject);

      const {
        projectGroups: nextProjectGroups,
        targetGroupId,
      } = hasSyncedProject
        ? {
            projectGroups: syncedGroups,
            targetGroupId: groupForProject?.id ?? data.groupId ?? `group_${Date.now()}`,
          }
        : insertProjectInGroups(state.projectGroups, newProject, data.groupId);

      const rememberedProject: RememberedProject | null = targetGroupId
        ? {
            projectId: newProject.id,
            groupId: targetGroupId,
            name: newProject.name,
            path: newProject.path,
            lastOpenedAt: new Date().toISOString(),
          }
        : null;

      const nextRecentProjects = rememberedProject
        ? upsertRememberedProject(state.recentProjects, rememberedProject)
        : state.recentProjects;
      const nextMacroEnabledProjects = rememberedProject
        ? upsertRememberedProject(state.macroEnabledProjects, rememberedProject)
        : state.macroEnabledProjects;

      const nextPlan = hasSyncedProject
        ? plan
        : state.currentPlan
          ? {
              ...state.currentPlan,
              project_ids: state.currentPlan.project_ids.includes(newProject.id)
                ? state.currentPlan.project_ids
                : [...state.currentPlan.project_ids, newProject.id],
            }
          : state.currentPlan;

      set({
        currentPlan: nextPlan,
        projectGroups: nextProjectGroups,
        planNodes: hasSyncedProject ? (planNodes?.length ? planNodes : derivePlanNodesFromPlan(plan)) : state.planNodes,
        predictedBranches: hasSyncedProject ? (predictedBranches ?? []) : state.predictedBranches,
        selectedGroupId: targetGroupId,
        selectedProjectId: newProject.id,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
      });
      void savePreference(PREF_KEYS.LAST_SELECTED_GROUP_ID, targetGroupId);
      void savePreference(PREF_KEYS.LAST_SELECTED_PROJECT_ID, newProject.id);
      void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, newProject.path);
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(PREF_KEYS.MACRO_ENABLED_PROJECTS, nextMacroEnabledProjects);

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
      const [leftWidth, rightWidth, leftOpen, rightOpen, uiZoomMode, uiZoomLevel, lastSelectedGroupId, lastSelectedProjectId, lastOpenProjectPath, lastActiveMode, recentProjects, macroEnabledProjects] = await Promise.all([
        loadPreference<number>(PREF_KEYS.LEFT_PANEL_WIDTH),
        loadPreference<number>(PREF_KEYS.RIGHT_PANEL_WIDTH),
        loadPreference<boolean>(PREF_KEYS.IS_LEFT_PANEL_OPEN),
        loadPreference<boolean>(PREF_KEYS.IS_RIGHT_PANEL_OPEN),
        loadPreference<UiZoomMode>(PREF_KEYS.UI_ZOOM_MODE),
        loadPreference<number>(PREF_KEYS.UI_ZOOM_LEVEL),
        loadPreference<string | null>(PREF_KEYS.LAST_SELECTED_GROUP_ID),
        loadPreference<string | null>(PREF_KEYS.LAST_SELECTED_PROJECT_ID),
        loadPreference<string | null>(PREF_KEYS.LAST_OPEN_PROJECT_PATH),
        loadPreference<AppMode>(PREF_KEYS.LAST_ACTIVE_MODE),
        loadPreference<RememberedProject[]>(PREF_KEYS.RECENT_PROJECTS),
        loadPreference<RememberedProject[]>(PREF_KEYS.MACRO_ENABLED_PROJECTS),
      ]);

      const normalizedZoomMode: UiZoomMode = uiZoomMode === 'override' ? 'override' : 'auto';
      const normalizedZoomLevel = Math.max(0.75, Math.min(2, uiZoomLevel));

      const { plan, projectGroups, planNodes, predictedBranches } = await services.getAppBootstrap();
      const cleanedProjectGroups = pruneLegacyWorkspaceMocks(projectGroups);
      const cleanedRecentProjects = pruneLegacyRememberedProjects(recentProjects);
      const cleanedMacroEnabledProjects = pruneLegacyRememberedProjects(macroEnabledProjects);

      const rememberedCandidates = [...cleanedMacroEnabledProjects]
        .filter((project) => typeof project.path === 'string' && project.path.trim().length > 0)
        .sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime());

      let resolvedProjectGroups = mergeRememberedProjectsIntoGroups(cleanedProjectGroups, rememberedCandidates);
      resolvedProjectGroups = dedupeProjectGroupsByPath(resolvedProjectGroups);

      let resolvedGroupId: string | null = null;
      let resolvedProjectId: string | null = null;

      if (lastSelectedProjectId) {
        const groupForProject = resolvedProjectGroups.find((group) =>
          group.projects.some((project) => project.id === lastSelectedProjectId)
        );
        if (groupForProject) {
          resolvedGroupId = groupForProject.id;
          resolvedProjectId = lastSelectedProjectId;
        }
      }

      if (!resolvedGroupId && lastSelectedGroupId) {
        const existingGroup = resolvedProjectGroups.find((group) => group.id === lastSelectedGroupId);
        if (existingGroup) {
          resolvedGroupId = existingGroup.id;
        }
      }

      if (!resolvedGroupId) {
        const firstValidRecent = cleanedRecentProjects.find((recent) =>
          resolvedProjectGroups.some((group) => group.projects.some((project) => project.path === recent.path))
        );

        if (firstValidRecent) {
          const groupForRecent = resolvedProjectGroups.find((group) =>
            group.projects.some((project) => project.path === firstValidRecent.path)
          );
          const projectForRecent = groupForRecent?.projects.find((project) => project.path === firstValidRecent.path);

          resolvedGroupId = groupForRecent?.id ?? null;
          resolvedProjectId = projectForRecent?.id ?? null;
        }
      }

      if (!resolvedProjectId && lastOpenProjectPath) {
        const normalizedLastPath = normalizePath(lastOpenProjectPath);
        const groupForPath = resolvedProjectGroups.find((group) =>
          group.projects.some((project) => normalizePath(project.path) === normalizedLastPath)
        );

        if (groupForPath) {
          const projectForPath = groupForPath.projects.find(
            (project) => normalizePath(project.path) === normalizedLastPath
          );
          resolvedGroupId = groupForPath.id;
          resolvedProjectId = projectForPath?.id ?? null;
        } else {
          const sessionProjectId = `session-project-${Date.now()}`;
          const sessionGroupId = `session-group-${Date.now()}`;
          resolvedProjectGroups = [
            ...resolvedProjectGroups,
            {
              id: sessionGroupId,
              name: projectNameFromPath(normalizedLastPath),
              isOpen: true,
              projects: [
                {
                  id: sessionProjectId,
                  name: projectNameFromPath(normalizedLastPath),
                  path: normalizedLastPath,
                  created_at: new Date().toISOString(),
                  status: 'active',
                  metadata: {
                    description: 'Restored from last session',
                    tags: [],
                    team_members: [],
                    api_contracts: [],
                    dependencies: [],
                  },
                },
              ],
            },
          ];

          resolvedGroupId = sessionGroupId;
          resolvedProjectId = sessionProjectId;
        }
      }

      if (!resolvedGroupId) {
        resolvedGroupId = resolvedProjectGroups[0]?.id ?? null;
      }

      if (resolvedGroupId && !resolvedProjectId) {
        const selectedGroup = resolvedProjectGroups.find((group) => group.id === resolvedGroupId);
        resolvedProjectId = selectedGroup?.projects[0]?.id ?? null;
      }

      const resolvedMode: AppMode = ['Architect', 'Implement', 'Chat', 'Debug'].includes(lastActiveMode)
        ? lastActiveMode
        : 'Implement';

      set({
        mode: resolvedMode,
        currentPlan: plan,
        projectGroups: resolvedProjectGroups,
        planNodes: planNodes?.length ? planNodes : derivePlanNodesFromPlan(plan),
        predictedBranches: predictedBranches ?? [],
        selectedGroupId: resolvedGroupId,
        selectedProjectId: resolvedProjectId,
        recentProjects: cleanedRecentProjects,
        macroEnabledProjects: cleanedMacroEnabledProjects,
        leftPanelWidth: leftWidth,
        rightPanelWidth: rightWidth,
        isLeftPanelOpen: leftOpen,
        isRightPanelOpen: rightOpen,
        uiZoomMode: normalizedZoomMode,
        uiZoomLevel: normalizedZoomLevel,
        isLoading: false,
      });

      void savePreference(PREF_KEYS.RECENT_PROJECTS, cleanedRecentProjects);
      void savePreference(PREF_KEYS.MACRO_ENABLED_PROJECTS, cleanedMacroEnabledProjects);
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    }
  },
}));
