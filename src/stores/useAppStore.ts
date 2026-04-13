import { create } from "zustand";
import { useChatStore } from "./useChatStore";
import { useNeedsStore } from "./useNeedsStore";
import { useTaskStore } from "./useTaskStore";
import {
  AppMode,
  AgentType,
  CodeOverflowMode,
  ImplementExecutionMode,
  Plan,
  ProjectGroup,
  Project,
  ProjectGitFlowSettings,
  ProjectGitSetupAction,
  ProjectGitSetupCommitResult,
  ProjectGitSetupState,
  PlanNode,
  PredictedBranch,
} from "../types";
import { services } from "../services";
import { toServiceError } from "../services/contracts/errors";
import { devLogger } from "../utils/devLogger";
import { clampUiZoomLevel } from "../utils/uiZoom";
import {
  type ProjectSwitchPolicy,
  getLocalProjectContextState,
  getLocalSessionContextState,
  getProjectSwitchPolicy,
  reconcileLocalProjectRegistryState,
  setProjectSwitchPolicy as persistProjectSwitchPolicy,
  upsertLocalProjectContextState,
  upsertLocalSessionContextState,
} from "../services/localProjectContext";
import { getDefaultProjectGitFlowSettings } from "../services/architectGitNaming";
import {
  getArchitectPlan,
  getArchitectPlanNeeds,
  getGitFlowBaseBranch,
  isArchitectPlanVisibleForScope,
  planMatchesProjectId,
  resolveTargetBranch,
} from "../services/architectPlanService";
import { taskMatchesProjectId } from "../services/implementTaskCatalog";
import {
  loadPreference,
  savePreference,
  savePreferenceDebounced,
  PREF_KEYS,
} from "../services/preferences";
import {
  DEFAULT_NOTIFICATION_CHANNEL_MODES,
  sanitizeNotificationChannelMode,
  sanitizeNotificationChannelModes,
  type NotificationCategory,
  type NotificationChannelMode,
  type NotificationChannelModes,
} from "../services/notificationChannels";
import {
  getGlobalProjectById,
  getFocusedProjectIdForGroup,
  getProjectGroupByProjectId,
  resolveExplicitProjectIdForGroup,
  getScopedActionableProjectIds,
  getScopedProjectIds,
  getScopedReadOnlyProjectIds,
} from "../services/globalProjects";
import {
  countProjectsInRegistry,
  formatProjectRegistryRepairSummary,
  normalizeProjectRegistry,
  resolveCanonicalProject,
  resolveCanonicalProjectGroup,
  reconcileRememberedProjects,
} from "../services/projectRegistry";
import { ensureProjectGroupPlan } from "../services/architectAutoPlan";
import type { NormalizeProjectRegistryResult } from "../services/projectRegistry";
import * as tauriIpc from "../services/tauriIpc";
import type {
  MacroSyncNextAction,
  MacroSyncReason,
  WorkspaceMetadataRecoveryReportDto,
} from "../services/tauriIpc";

export type TaskSortOption = "status" | "date" | "title" | "project";
export type SettingsTab =
  | "general"
  | "notifications"
  | "appearance"
  | "providers"
  | "models"
  | "tools"
  | "shortcuts"
  | "prompts"
  | "architect";
export type UiZoomMode = "auto" | "override";
export type MetadataSyncState = "clean" | "pending" | "failed" | "conflict";

const normalizeCodeOverflowMode = (
  value: CodeOverflowMode | string | null | undefined,
): CodeOverflowMode =>
  value === "horizontal_scroll" ? "horizontal_scroll" : "wrap";

export interface MetadataSyncRepositoryStatus {
  repoPath: string;
  projectId: string | null;
  worktreePath: string | null;
  state: MetadataSyncState;
  error: string | null;
  reason: MacroSyncReason | null;
  nextAction: MacroSyncNextAction | null;
  conflictFiles: string[];
}

interface RememberedProject {
  projectId: string;
  groupId: string;
  name: string;
  path: string;
  lastOpenedAt: string;
}

const MAX_REMEMBERED_PROJECTS = 50;
let projectSwitchRequestId = 0;

export interface ArchitectPlanContext {
  id: string;
  slug?: string;
  title: string;
  label?: string;
  description: string;
  status: string;
  targetBranch: string;
  targetBranchesByProjectId?: Record<string, string>;
  hasMixedTargetBranches?: boolean;
}

const upsertRememberedProject = (
  projects: RememberedProject[],
  nextProject: RememberedProject,
): RememberedProject[] => {
  const filtered = projects.filter(
    (project) =>
      project.projectId !== nextProject.projectId &&
      project.path !== nextProject.path,
  );
  return [nextProject, ...filtered].slice(0, MAX_REMEMBERED_PROJECTS);
};

const insertProjectInGroups = (
  groups: ProjectGroup[],
  project: Project,
  requestedGroupId: string | null,
): { projectGroups: ProjectGroup[]; targetGroupId: string } => {
  if (requestedGroupId) {
    const hasRequestedGroup = groups.some(
      (group) => group.id === requestedGroupId,
    );
    if (hasRequestedGroup) {
      return {
        projectGroups: groups.map((group) =>
          group.id === requestedGroupId
            ? { ...group, projects: [...group.projects, project] }
            : group,
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

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/\/$/, "");

const isAppMode = (value: unknown): value is AppMode =>
  value === "Architect" ||
  value === "Implement" ||
  value === "Chat";

const isLegacyWorkspaceMockPath = (path?: string): boolean => {
  const normalized = normalizePath(path || "");
  return normalized.startsWith("/path/to/");
};

const isImplicitWorkspaceRootPath = (path?: string): boolean => {
  const normalized = (path || "").trim().replace(/\\/g, "/");
  return normalized === "." || normalized === "./";
};

const shouldPersistProjectPath = (path?: string | null): boolean => {
  if (!path) return false;
  return !isImplicitWorkspaceRootPath(path);
};

const persistSessionContext = async (input: {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  mode: AppMode;
}): Promise<void> => {
  await upsertLocalSessionContextState(input);
  void savePreference(PREF_KEYS.LAST_SELECTED_GROUP_ID, input.selectedGroupId);
  void savePreference(
    PREF_KEYS.LAST_SELECTED_PROJECT_ID,
    input.selectedProjectId,
  );
  void savePreference(PREF_KEYS.LAST_ACTIVE_MODE, input.mode);
};

const sortByUpdatedAtDesc = <T extends { updated_at?: string }>(
  items: T[],
): T[] =>
  [...items].sort((left, right) => {
    const leftTime = left.updated_at ? new Date(left.updated_at).getTime() : 0;
    const rightTime = right.updated_at
      ? new Date(right.updated_at).getTime()
      : 0;
    return rightTime - leftTime;
  });

const collectProjectRegistryIds = (groups: ProjectGroup[]) => ({
  validGroupIds: groups.map((group) => group.id),
  validProjectIds: groups.flatMap((group) =>
    group.projects.map((project) => project.id),
  ),
});

const filterPlanNodesForRegistry = (
  planNodes: PlanNode[],
  validProjectIds: string[],
): PlanNode[] => {
  const validProjectIdSet = new Set(validProjectIds);
  return planNodes.filter(
    (node) => !node.projectId || validProjectIdSet.has(node.projectId),
  );
};

const filterPredictedBranchesForRegistry = (
  predictedBranches: PredictedBranch[],
  validProjectIds: string[],
): PredictedBranch[] => {
  const validProjectIdSet = new Set(validProjectIds);
  return predictedBranches.filter((branch) =>
    validProjectIdSet.has(branch.projectId),
  );
};

const logProjectRegistryAction = (
  status: "started" | "succeeded" | "failed",
  payload: Record<string, unknown>,
): void => {
  const message = {
    event: `project_registry_action_${status}`,
    at: new Date().toISOString(),
    ...payload,
  };

  if (status === "failed") {
    console.error(JSON.stringify(message));
    return;
  }

  devLogger.info(JSON.stringify(message));
};

const reconcileProjectRegistryDependencies = async (params: {
  projectGroups: ProjectGroup[];
  selectedGroupId: string | null;
  selectedProjectId: string | null;
}): Promise<void> => {
  const { validGroupIds, validProjectIds } = collectProjectRegistryIds(
    params.projectGroups,
  );
  await reconcileLocalProjectRegistryState({
    validGroupIds,
    validProjectIds,
    selectedGroupId: params.selectedGroupId,
    selectedProjectId: params.selectedProjectId,
  });

  useChatStore
    .getState()
    .reconcileProjectRegistry(validGroupIds, validProjectIds);
};

const persistCurrentProjectContext = async (
  groupId: string,
  focusProjectId?: string | null,
): Promise<void> => {
  const appState = useAppStore.getState();
  const globalProject = getGlobalProjectById(appState.projectGroups, groupId);
  if (!globalProject) return;

  const taskStore = useTaskStore.getState();
  const chatStore = useChatStore.getState();
  const scopedProjectIds = new Set(globalProject.subProjectIds);

  const tasksForProject = taskStore.tasks.filter((task) =>
    globalProject.subProjectIds.some((projectId) =>
      taskMatchesProjectId(task, projectId),
    ),
  );
  const selectedTask = appState.selectedTaskId
    ? taskStore.getTaskById(appState.selectedTaskId)
    : undefined;

  let lastTaskId: string | null = null;
  if (
    selectedTask &&
    globalProject.subProjectIds.some((projectId) =>
      taskMatchesProjectId(selectedTask, projectId),
    )
  ) {
    lastTaskId = selectedTask.id;
  } else {
    const preferredTask =
      tasksForProject.find((task) => task.status === "InProgress") ||
      tasksForProject.find((task) => task.status === "AwaitingResponse") ||
      tasksForProject.find((task) => task.status === "Pending") ||
      tasksForProject[0];
    lastTaskId = preferredTask?.id ?? null;
  }

  let lastPlanId: string | null = null;
  const activePlanId = appState.activeArchitectPlanId;
  if (activePlanId) {
    try {
      const targetBranch = resolveTargetBranch(
        appState.activePlanContext?.targetBranch || getGitFlowBaseBranch(),
      );
      const plan = await getArchitectPlan(targetBranch, activePlanId);
      if (
        plan &&
        plan.status !== "deleted" &&
        globalProject.subProjectIds.some((projectId) =>
          planMatchesProjectId(plan, projectId),
        )
      ) {
        lastPlanId = plan.id;
      }
    } catch {
      // Ignore plan lookup failures while persisting local context.
    }
  }

  const architectConversations = sortByUpdatedAtDesc(
    chatStore.conversations.filter(
      (conversation) =>
        conversation.scope_mode === "Architect" &&
        (conversation.group_id === groupId ||
          (conversation.project_id
            ? scopedProjectIds.has(conversation.project_id)
            : false)),
    ),
  );
  const selectedConversation = chatStore.selectedConversationId
    ? chatStore.conversations.find(
        (conversation) => conversation.id === chatStore.selectedConversationId,
      )
    : null;

  const selectedArchitectConversation =
    selectedConversation &&
    selectedConversation.scope_mode === "Architect" &&
    (selectedConversation.group_id === groupId ||
      (selectedConversation.project_id
        ? scopedProjectIds.has(selectedConversation.project_id)
        : false))
      ? selectedConversation.id
      : null;
  const architectConversationId =
    selectedArchitectConversation || architectConversations[0]?.id || null;

  const taskIdSet = new Set(tasksForProject.map((task) => task.id));
  const implementByTask = lastTaskId
    ? sortByUpdatedAtDesc(
        chatStore.conversations.filter(
          (conversation) =>
            conversation.scope_mode === "Implement" &&
            conversation.task_id === lastTaskId,
        ),
      )
    : [];
  const implementByProject = sortByUpdatedAtDesc(
    chatStore.conversations.filter(
      (conversation) =>
        conversation.scope_mode === "Implement" &&
        Boolean(conversation.task_id && taskIdSet.has(conversation.task_id)),
    ),
  );

  const selectedImplementConversation =
    selectedConversation &&
    selectedConversation.scope_mode === "Implement" &&
    selectedConversation.task_id &&
    taskIdSet.has(selectedConversation.task_id)
      ? selectedConversation.id
      : null;
  const implementConversationId =
    selectedImplementConversation ||
    implementByTask[0]?.id ||
    implementByProject[0]?.id ||
    null;

  await upsertLocalProjectContextState({
    projectId: groupId,
    groupId,
    focusProjectId: focusProjectId ?? appState.selectedProjectId ?? null,
    lastPlanId,
    lastTaskId,
    architectConversationId,
    implementConversationId,
  });
};

const restoreProjectContext = async (
  groupId: string,
  preferredFocusProjectId?: string | null,
): Promise<void> => {
  const appState = useAppStore.getState();
  const globalProject = getGlobalProjectById(appState.projectGroups, groupId);
  if (!globalProject) return;

  const context = await getLocalProjectContextState(groupId);
  const taskStore = useTaskStore.getState();

  let restoredTaskId: string | null = null;
  const contextTaskId = context?.lastTaskId;
  if (contextTaskId) {
    const task = taskStore.getTaskById(contextTaskId);
    if (
      task &&
      globalProject.subProjectIds.some((projectId) =>
        taskMatchesProjectId(task, projectId),
      )
    ) {
      restoredTaskId = contextTaskId;
    }
  }

  if (restoredTaskId) {
    useAppStore.setState({ selectedTaskId: restoredTaskId });
    await taskStore.activateTask(restoredTaskId);
  } else {
    useAppStore.setState({ selectedTaskId: null });
  }

  let restoredPlanId: string | null = null;
  const contextPlanId = context?.lastPlanId;
  if (contextPlanId) {
    try {
      const targetBranch = resolveTargetBranch(
        appState.activePlanContext?.targetBranch || getGitFlowBaseBranch(),
      );
      const plan = await getArchitectPlan(targetBranch, contextPlanId);
      if (
        plan &&
        plan.status !== "deleted" &&
        globalProject.subProjectIds.some((projectId) =>
          planMatchesProjectId(plan, projectId),
        )
      ) {
        restoredPlanId = plan.id;
        useAppStore.setState({
          activeArchitectPlanId: plan.id,
          activePlanContext: {
            id: plan.id,
            slug: plan.slug,
            title: plan.title,
            label: plan.label,
            description: plan.description,
            status: plan.status,
            targetBranch: plan.targetBranch,
          },
          planNodes: plan.nodes || [],
          predictedBranches: plan.predictedBranches || [],
        });

        const needs = await getArchitectPlanNeeds(targetBranch, plan.id);
        useNeedsStore.getState().replaceNeedsForPlan(plan.id, needs);
      }
    } catch {
      restoredPlanId = null;
    }
  }

  if (!restoredPlanId) {
    useAppStore.setState({
      activeArchitectPlanId: null,
      activePlanContext: null,
      planNodes: [],
      predictedBranches: [],
    });
  }

  const nextFocusProjectId = resolveExplicitProjectIdForGroup(
    appState.projectGroups,
    groupId,
    preferredFocusProjectId ?? null,
    context,
  );
  if (useAppStore.getState().selectedProjectId !== nextFocusProjectId) {
    useAppStore.setState({ selectedProjectId: nextFocusProjectId });
  }

  await persistSessionContext({
    selectedGroupId: groupId,
    selectedProjectId: nextFocusProjectId,
    mode: useAppStore.getState().mode,
  });
};

const hydrateArchitectPlanInStore = async (input: {
  plan: Awaited<ReturnType<typeof getArchitectPlan>>;
  needs: Awaited<ReturnType<typeof getArchitectPlanNeeds>>;
}): Promise<void> => {
  const plan = input.plan;
  if (!plan || plan.status === "deleted") {
    return;
  }

  useAppStore.setState({
    activeArchitectPlanId: plan.id,
    activePlanContext: {
      id: plan.id,
      slug: plan.slug,
      title: plan.title,
      label: plan.label,
      description: plan.description,
      status: plan.status,
      targetBranch: plan.targetBranch,
    },
    planNodes: plan.nodes || [],
    predictedBranches: plan.predictedBranches || [],
  });
  useNeedsStore.getState().replaceNeedsForPlan(plan.id, input.needs);
};

const ensureAutoPlanForSelection = async (input: {
  groupId: string | null;
  projectId: string | null;
}): Promise<void> => {
  if (!input.groupId && !input.projectId) {
    return;
  }

  const appState = useAppStore.getState();
  if (appState.mode !== "Architect") {
    return;
  }
  const scopedProjectIds = getScopedProjectIds(
    appState.projectGroups,
    input.groupId,
    input.projectId,
  );
  const actionableProjectIds = getScopedActionableProjectIds(
    appState.projectGroups,
    input.groupId,
    input.projectId,
  );
  const readOnlyProjectIds = getScopedReadOnlyProjectIds(
    appState.projectGroups,
    input.groupId,
    input.projectId,
  );
  if (scopedProjectIds.length === 0 || actionableProjectIds.length === 0) {
    return;
  }

  if (appState.activeArchitectPlanId) {
    try {
      const targetBranch = resolveTargetBranch(
        appState.activePlanContext?.targetBranch || getGitFlowBaseBranch(),
      );
      const activePlan = await getArchitectPlan(
        targetBranch,
        appState.activeArchitectPlanId,
      );
      if (activePlan && activePlan.status !== "deleted") {
        const isActivePlanVisibleForScope = isArchitectPlanVisibleForScope(
          activePlan,
          actionableProjectIds,
        );
        if (isActivePlanVisibleForScope) {
          return;
        }
      }
    } catch {
      // Ignore lookup failures and continue with implicit auto-plan resolution.
    }
  }

  const ensuredPlan = await ensureProjectGroupPlan({
    branchName: getGitFlowBaseBranch(),
    scopedProjectIds: actionableProjectIds,
    contextProjectIds: readOnlyProjectIds,
    trigger: "implicit_resume",
  });
  if (!ensuredPlan) {
    return;
  }

  await hydrateArchitectPlanInStore({
    plan: ensuredPlan.plan,
    needs: ensuredPlan.needs,
  });
};

const pruneLegacyWorkspaceMocks = (groups: ProjectGroup[]): ProjectGroup[] => {
  return groups
    .map((group) => ({
      ...group,
      projects: group.projects.filter(
        (project) =>
          !isLegacyWorkspaceMockPath(project.path) &&
          !isImplicitWorkspaceRootPath(project.path),
      ),
    }))
    .filter((group) => group.projects.length > 0);
};

const pruneLegacyRememberedProjects = (
  projects: RememberedProject[],
): RememberedProject[] =>
  projects.filter(
    (project) =>
      !isLegacyWorkspaceMockPath(project.path) &&
      !isImplicitWorkspaceRootPath(project.path),
  );

const buildMetadataRecoveryHints = (
  macroEnabledProjects: RememberedProject[],
  recentProjects: RememberedProject[],
): tauriIpc.WorkspaceMetadataRecoveryHintDto[] =>
  Array.from(
    new Map(
      [...macroEnabledProjects, ...recentProjects]
        .map((project) => ({
          projectId: project.projectId,
          groupId: project.groupId ?? null,
          name: project.name,
          path: project.path,
        }))
        .filter((project) => project.path.trim().length > 0)
        .map((project) => [normalizePath(project.path), project] as const),
    ).values(),
  );

interface AppStore {
  mode: AppMode;
  agentType: AgentType;
  currentPlan: Plan | null;
  projectGroups: ProjectGroup[];
  selectedGroupId: string | null;
  selectedProjectId: string | null; // focused subproject for repo-specific panels/actions
  selectedTaskId: string | null;
  taskSortOption: TaskSortOption;
  isLoading: boolean;
  lastError: string | null;
  settingsOpen: boolean;
  activeSettingsTab: SettingsTab; // Added
  accountOpen: boolean;
  projectModalOpen: boolean;
  projectModalGroupId: string | null;
  projectGitFlowModalProjectId: string | null;
  activeThemeId: string;
  leftPanelWidth: number;
  rightPanelWidth: number;
  isLeftPanelOpen: boolean;
  isRightPanelOpen: boolean;
  enabledModes: AppMode[];
  uiZoomMode: UiZoomMode;
  uiZoomLevel: number;
  codeOverflowMode: CodeOverflowMode;
  projectSwitchPolicy: ProjectSwitchPolicy;
  isProjectSwitching: boolean;
  metadataAutoPush: boolean;
  implementExecutionMode: ImplementExecutionMode;
  notificationChannelModes: NotificationChannelModes;
  pendingAutoLaunchPlanId: string | null;
  pendingAutoLaunchTaskId: string | null;
  metadataSyncState: MetadataSyncState;
  metadataSyncError: string | null;
  metadataSyncReason: MacroSyncReason | null;
  metadataSyncNextAction: MacroSyncNextAction | null;
  metadataConflictFiles: string[];
  metadataSyncRepositories: MetadataSyncRepositoryStatus[];
  recentProjects: RememberedProject[];
  macroEnabledProjects: RememberedProject[];
  projectRegistryRepairSummary: string | null;
  metadataRecoveryReport: WorkspaceMetadataRecoveryReportDto | null;
  // Architect mode state
  activeArchitectPlanId: string | null;
  activePlanContext: ArchitectPlanContext | null;
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  setMode: (mode: AppMode) => void;
  setAgentType: (agentType: AgentType) => void;
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
  updateProjectGitFlow: (
    projectId: string,
    gitFlowSettings: ProjectGitFlowSettings,
  ) => Promise<void>;
  updateProjectGitFlowWithSetup: (
    projectId: string,
    gitFlowSettings: ProjectGitFlowSettings,
    gitSetupActions: ProjectGitSetupAction[],
    expectedRepoRootPath: string | null | undefined,
    expectedSetupState: ProjectGitSetupState,
    expectedRecommendedActionSequence: ProjectGitSetupAction[],
  ) => Promise<ProjectGitSetupCommitResult>;
  updateProjectAccess: (
    projectId: string,
    userReadOnly: boolean,
    confirmedMigration?: boolean,
  ) => Promise<void>;
  removeProjectGroup: (groupId: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  getProjectById: (id: string) => Project | undefined;
  setEnabledModes: (modes: AppMode[]) => void;
  setUiZoomMode: (mode: UiZoomMode) => void;
  setUiZoomLevel: (level: number) => void;
  setCodeOverflowMode: (mode: CodeOverflowMode) => void;
  setProjectSwitchPolicy: (policy: ProjectSwitchPolicy) => Promise<void>;
  setMetadataAutoPush: (enabled: boolean) => void;
  setImplementExecutionMode: (mode: ImplementExecutionMode) => void;
  setNotificationChannelMode: (
    category: NotificationCategory,
    mode: NotificationChannelMode,
  ) => void;
  armPendingAutoLaunch: (planId: string, taskId: string) => void;
  clearPendingAutoLaunch: (params?: {
    planId?: string | null;
    taskId?: string | null;
  }) => void;
  setMetadataSyncStatus: (params: {
    state: MetadataSyncState;
    error?: string | null;
    reason?: MacroSyncReason | null;
    nextAction?: MacroSyncNextAction | null;
    conflictFiles?: string[];
    repositories?: MetadataSyncRepositoryStatus[];
  }) => void;
  switchProjectContext: (
    projectId: string | null,
    options?: SwitchProjectContextOptions,
  ) => Promise<void>;
  setPlanNodes: (nodes: PlanNode[]) => void;
  setPredictedBranches: (branches: PredictedBranch[]) => void;
  setActiveArchitectPlanId: (planId: string | null) => void;
  setActivePlanContext: (plan: ArchitectPlanContext | null) => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  openAccount: () => void;
  closeAccount: () => void;
  openProjectModal: (groupId?: string | null) => void;
  closeProjectModal: () => void;
  openProjectGitFlowModal: (projectId: string) => void;
  closeProjectGitFlowModal: () => void;
  createProject: (data: CreateProjectData) => Promise<void>;
  createProjectWithGitSetup: (
    data: CreateProjectData & {
      path: string;
      gitSetupActions: ProjectGitSetupAction[];
      expectedRepoRootPath?: string | null;
      expectedSetupState: ProjectGitSetupState;
      expectedRecommendedActionSequence: ProjectGitSetupAction[];
    },
  ) => Promise<ProjectGitSetupCommitResult>;
  refreshProjectRegistry: () => Promise<void>;
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
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: ProjectGitFlowSettings;
}

interface SwitchProjectContextOptions {
  restoreProjectContext?: boolean;
  ensureAutoPlan?: boolean;
}

interface ProjectRegistrySnapshot {
  plan: Plan | null;
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  normalizedRegistry: NormalizeProjectRegistryResult;
}

const loadProjectRegistrySnapshot = async (params: {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
}): Promise<ProjectRegistrySnapshot> => {
  const { projectGroups, plan, planNodes, predictedBranches } =
    await services.getAppBootstrap();

  return {
    plan,
    planNodes: planNodes ?? [],
    predictedBranches: predictedBranches ?? [],
    normalizedRegistry: normalizeProjectRegistry({
      projectGroups,
      selectedGroupId: params.selectedGroupId,
      selectedProjectId: params.selectedProjectId,
    }),
  };
};

const derivePlanNodesFromPlan = (plan: Plan | null): PlanNode[] => {
  if (!plan?.tasks?.length) {
    return [];
  }

  return plan.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    type: "task",
    status:
      task.status === "Completed"
        ? "completed"
        : task.status === "InProgress"
          ? "in-progress"
          : task.status === "Blocked"
            ? "blocked"
            : "pending",
    dependencies: task.dependencies,
    projectId: task.project_id,
  }));
};

export const useAppStore = create<AppStore>((set, get) => ({
  mode: "Implement",
  agentType: "build",
  currentPlan: null,
  projectGroups: [],
  selectedGroupId: null,
  selectedProjectId: null,
  selectedTaskId: null,
  taskSortOption: "date",
  isLoading: false,
  lastError: null,
  settingsOpen: false,
  activeSettingsTab: "general",
  accountOpen: false,
  projectModalOpen: false,
  projectModalGroupId: null,
  projectGitFlowModalProjectId: null,
  activeThemeId:
    (typeof window !== "undefined"
      ? window.localStorage.getItem("theme-id")
      : null) || "macro-dark",
  leftPanelWidth: 280,
  rightPanelWidth: 320,
  isLeftPanelOpen: true,
  isRightPanelOpen: true,
  enabledModes: ["Architect", "Implement", "Chat"],
  uiZoomMode: "auto",
  uiZoomLevel: 1,
  codeOverflowMode: "wrap",
  projectSwitchPolicy: "resume_per_project",
  isProjectSwitching: false,
  metadataAutoPush: false,
  implementExecutionMode: "semi_auto",
  notificationChannelModes: DEFAULT_NOTIFICATION_CHANNEL_MODES,
  pendingAutoLaunchPlanId: null,
  pendingAutoLaunchTaskId: null,
  metadataSyncState: "clean",
  metadataSyncError: null,
  metadataSyncReason: null,
  metadataSyncNextAction: null,
  metadataConflictFiles: [],
  metadataSyncRepositories: [],
  recentProjects: [],
  macroEnabledProjects: [],
  projectRegistryRepairSummary: null,
  metadataRecoveryReport: null,
  activeArchitectPlanId: null,
  activePlanContext: null,
  planNodes: [],
  predictedBranches: [],

  setMode: (mode) => {
    set({
      mode,
      ...(mode === "Implement"
        ? {}
        : {
            pendingAutoLaunchPlanId: null,
            pendingAutoLaunchTaskId: null,
          }),
    });
    void savePreference(PREF_KEYS.LAST_ACTIVE_MODE, mode);
    const { selectedGroupId, selectedProjectId } = get();
    void persistSessionContext({
      selectedGroupId,
      selectedProjectId,
      mode,
    });
  },
  setAgentType: (agentType) => {
    set({ agentType });
    void savePreference(PREF_KEYS.AGENT_TYPE, agentType);
  },
  setTheme: (themeId) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("theme-id", themeId);
    }
    set({ activeThemeId: themeId });
  },

  setCurrentPlan: (plan) => set({ currentPlan: plan }),

  setProjectGroups: (groups) =>
    set((state) => {
      const normalized = normalizeProjectRegistry({
        projectGroups: groups,
        selectedGroupId: state.selectedGroupId,
        selectedProjectId: state.selectedProjectId,
      });
      return {
        projectGroups: normalized.projectGroups,
        selectedGroupId: normalized.selectedGroupId,
        selectedProjectId: normalized.selectedProjectId,
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalized.report,
        ),
      };
    }),

  setSelectedGroup: (groupId) => {
    const state = get();
    const previousGroupId = state.selectedGroupId;
    const previousProjectId = state.selectedProjectId;
    if (previousGroupId === groupId) {
      void persistSessionContext({
        selectedGroupId: groupId,
        selectedProjectId: previousProjectId,
        mode: state.mode,
      });
      return;
    }
    const nextFocusProjectId = null;
    set({
      selectedGroupId: groupId,
      selectedProjectId: nextFocusProjectId,
      selectedTaskId: null,
      pendingAutoLaunchPlanId: null,
      pendingAutoLaunchTaskId: null,
      activeArchitectPlanId: null,
      activePlanContext: null,
      planNodes: [],
      predictedBranches: [],
    });
    void (async () => {
      if (previousGroupId) {
        await persistCurrentProjectContext(previousGroupId, previousProjectId);
      }

      await persistSessionContext({
        selectedGroupId: groupId,
        selectedProjectId: nextFocusProjectId,
        mode: state.mode,
      });

      if (groupId && get().projectSwitchPolicy === "resume_per_project") {
        await restoreProjectContext(groupId, nextFocusProjectId);
      }

      await ensureAutoPlanForSelection({
        groupId,
        projectId: nextFocusProjectId,
      });
    })();
  },

  setSelectedProject: (projectId) => {
    void get().switchProjectContext(projectId);
  },

  setProjectSwitchPolicy: async (policy) => {
    const normalized =
      policy === "reset_on_switch" ? "reset_on_switch" : "resume_per_project";
    set({ projectSwitchPolicy: normalized });
    await persistProjectSwitchPolicy(normalized);
  },

  setMetadataAutoPush: (enabled) => {
    set({ metadataAutoPush: enabled });
    void savePreference(PREF_KEYS.METADATA_AUTO_PUSH, enabled);
  },

  setImplementExecutionMode: (mode) => {
    const normalized: ImplementExecutionMode =
      mode === "full_auto" ? "full_auto" : "semi_auto";
    set({
      implementExecutionMode: normalized,
      ...(normalized === "full_auto"
        ? {}
        : {
            pendingAutoLaunchPlanId: null,
            pendingAutoLaunchTaskId: null,
          }),
    });
    void savePreference(PREF_KEYS.IMPLEMENT_EXECUTION_MODE, normalized);
  },

  setNotificationChannelMode: (category, mode) => {
    const normalizedMode = sanitizeNotificationChannelMode(category, mode);
    set((state) => {
      const nextModes = {
        ...state.notificationChannelModes,
        [category]: normalizedMode,
      };
      void savePreference(PREF_KEYS.NOTIFICATION_CHANNEL_MODES, nextModes);
      return { notificationChannelModes: nextModes };
    });
  },

  armPendingAutoLaunch: (planId, taskId) => {
    set({
      pendingAutoLaunchPlanId: planId,
      pendingAutoLaunchTaskId: taskId,
    });
  },

  clearPendingAutoLaunch: (params) => {
    set((state) => {
      if (params?.planId && state.pendingAutoLaunchPlanId !== params.planId) {
        return {};
      }
      if (params?.taskId && state.pendingAutoLaunchTaskId !== params.taskId) {
        return {};
      }
      if (!state.pendingAutoLaunchPlanId && !state.pendingAutoLaunchTaskId) {
        return {};
      }
      return {
        pendingAutoLaunchPlanId: null,
        pendingAutoLaunchTaskId: null,
      };
    });
  },

  setMetadataSyncStatus: ({
    state,
    error,
    reason,
    nextAction,
    conflictFiles,
    repositories,
  }) => {
    set({
      metadataSyncState: state,
      metadataSyncError: error ?? null,
      metadataSyncReason: reason ?? null,
      metadataSyncNextAction: nextAction ?? null,
      metadataConflictFiles: state === "conflict" ? (conflictFiles ?? []) : [],
      metadataSyncRepositories: repositories ?? [],
    });
  },

  switchProjectContext: async (projectId, options) => {
    const requestId = ++projectSwitchRequestId;
    const previous = get();
    const restoreProjectContextOnSwitch =
      options?.restoreProjectContext !== false;
    const ensureAutoPlanOnSwitch = options?.ensureAutoPlan !== false;
    const nextProjectId =
      projectId && previous.getProjectById(projectId) ? projectId : null;
    const nextGroupId = nextProjectId
      ? (previous.projectGroups.find((group) =>
          group.projects.some((project) => project.id === nextProjectId),
        )?.id ?? null)
      : previous.selectedGroupId;

    const hasSelectionChanged =
      previous.selectedProjectId !== nextProjectId ||
      previous.selectedGroupId !== nextGroupId;

    if (!hasSelectionChanged) {
      await persistSessionContext({
        selectedGroupId: previous.selectedGroupId,
        selectedProjectId: previous.selectedProjectId,
        mode: previous.mode,
      });
      return;
    }

    set({ isProjectSwitching: true, lastError: null });

    try {
      const isFocusChangeWithinSameGroup =
        Boolean(nextGroupId) && previous.selectedGroupId === nextGroupId;

      if (
        previous.selectedGroupId &&
        previous.selectedGroupId !== nextGroupId
      ) {
        await persistCurrentProjectContext(
          previous.selectedGroupId,
          previous.selectedProjectId,
        );
      }

      if (requestId !== projectSwitchRequestId) return;

      const selectedProject = nextProjectId
        ? previous.getProjectById(nextProjectId)
        : null;
      const rememberedProject =
        selectedProject && nextGroupId
          ? {
              projectId: selectedProject.id,
              groupId: nextGroupId,
              name: selectedProject.name,
              path: selectedProject.path,
              lastOpenedAt: new Date().toISOString(),
            }
          : null;

      const nextRecentProjects = rememberedProject
        ? upsertRememberedProject(previous.recentProjects, rememberedProject)
        : previous.recentProjects;
      const nextMacroEnabledProjects = rememberedProject
        ? upsertRememberedProject(
            previous.macroEnabledProjects,
            rememberedProject,
          )
        : previous.macroEnabledProjects;

      if (isFocusChangeWithinSameGroup) {
        set({
          selectedGroupId: nextGroupId,
          selectedProjectId: nextProjectId,
          pendingAutoLaunchPlanId: null,
          pendingAutoLaunchTaskId: null,
          recentProjects: nextRecentProjects,
          macroEnabledProjects: nextMacroEnabledProjects,
        });

        void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
        void savePreference(
          PREF_KEYS.MACRO_ENABLED_PROJECTS,
          nextMacroEnabledProjects,
        );
        if (
          selectedProject?.path &&
          shouldPersistProjectPath(selectedProject.path)
        ) {
          void savePreference(
            PREF_KEYS.LAST_OPEN_PROJECT_PATH,
            selectedProject.path,
          );
        } else if (!nextProjectId) {
          void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, null);
        }

        await persistCurrentProjectContext(nextGroupId!, nextProjectId);
        await persistSessionContext({
          selectedGroupId: nextGroupId,
          selectedProjectId: nextProjectId,
          mode: get().mode,
        });
        if (ensureAutoPlanOnSwitch) {
          await ensureAutoPlanForSelection({
            groupId: nextGroupId,
            projectId: nextProjectId,
          });
        }
        return;
      }

      set({
        selectedGroupId: nextGroupId,
        selectedProjectId: nextProjectId,
        selectedTaskId: null,
        pendingAutoLaunchPlanId: null,
        pendingAutoLaunchTaskId: null,
        activeArchitectPlanId: null,
        activePlanContext: null,
        planNodes: [],
        predictedBranches: [],
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
      });

      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );
      if (
        selectedProject?.path &&
        shouldPersistProjectPath(selectedProject.path)
      ) {
        void savePreference(
          PREF_KEYS.LAST_OPEN_PROJECT_PATH,
          selectedProject.path,
        );
      } else {
        void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, null);
      }

      await persistSessionContext({
        selectedGroupId: nextGroupId,
        selectedProjectId: nextProjectId,
        mode: get().mode,
      });

      if (requestId !== projectSwitchRequestId) return;

      if (
        restoreProjectContextOnSwitch &&
        nextGroupId &&
        get().projectSwitchPolicy === "resume_per_project"
      ) {
        await restoreProjectContext(nextGroupId, nextProjectId);
      }

      if (ensureAutoPlanOnSwitch) {
        await ensureAutoPlanForSelection({
          groupId: nextGroupId,
          projectId: nextProjectId,
        });
      }
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message });
    } finally {
      if (requestId === projectSwitchRequestId) {
        set({ isProjectSwitching: false });
      }
    }
  },

  setSelectedTask: (taskId) =>
    set((state) => ({
      selectedTaskId: taskId,
      ...(taskId && state.pendingAutoLaunchTaskId === taskId
        ? {}
        : {
            pendingAutoLaunchPlanId: null,
            pendingAutoLaunchTaskId: null,
          }),
    })),

  setEnabledModes: (modes) => set({ enabledModes: modes }),

  setUiZoomMode: (mode) => {
    set({ uiZoomMode: mode });
    void savePreference(PREF_KEYS.UI_ZOOM_MODE, mode);
  },

  setUiZoomLevel: (level) => {
    const clampedLevel = clampUiZoomLevel(level);
    set({ uiZoomLevel: clampedLevel });
    void savePreference(PREF_KEYS.UI_ZOOM_LEVEL, clampedLevel);
  },

  setCodeOverflowMode: (mode) => {
    const normalizedMode = normalizeCodeOverflowMode(mode);
    set({ codeOverflowMode: normalizedMode });
    void savePreference(PREF_KEYS.CODE_OVERFLOW_MODE, normalizedMode);
  },

  setPlanNodes: (nodes) => set({ planNodes: nodes }),

  setPredictedBranches: (branches) => set({ predictedBranches: branches }),

  setActiveArchitectPlanId: (planId) => set({ activeArchitectPlanId: planId }),

  setActivePlanContext: (plan) => set({ activePlanContext: plan }),

  setTaskSortOption: (option) => set({ taskSortOption: option }),

  toggleProjectGroup: (groupId) =>
    set((state) => ({
      projectGroups: state.projectGroups.map((group) =>
        group.id === groupId ? { ...group, isOpen: !group.isOpen } : group,
      ),
    })),

  renameProjectGroup: async (groupId, name) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const requestedGroup =
        previousState.projectGroups.find((group) => group.id === groupId) ??
        null;
      logProjectRegistryAction("started", {
        action: "rename_group",
        groupId,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const preflightSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const canonicalGroup = resolveCanonicalProjectGroup(
        preflightSnapshot.normalizedRegistry.projectGroups,
        requestedGroup,
      );

      if (!canonicalGroup) {
        const nextRecentProjects = reconcileRememberedProjects(
          preflightSnapshot.normalizedRegistry.projectGroups,
          previousState.recentProjects,
        );
        const nextMacroEnabledProjects = reconcileRememberedProjects(
          preflightSnapshot.normalizedRegistry.projectGroups,
          previousState.macroEnabledProjects,
        );
        const { validProjectIds } = collectProjectRegistryIds(
          preflightSnapshot.normalizedRegistry.projectGroups,
        );
        const missingMessage =
          "Project group no longer exists in Macro. The registry was refreshed.";

        set({
          currentPlan: preflightSnapshot.plan,
          projectGroups: preflightSnapshot.normalizedRegistry.projectGroups,
          selectedGroupId: preflightSnapshot.normalizedRegistry.selectedGroupId,
          selectedProjectId:
            preflightSnapshot.normalizedRegistry.selectedProjectId,
          recentProjects: nextRecentProjects,
          macroEnabledProjects: nextMacroEnabledProjects,
          planNodes: filterPlanNodesForRegistry(
            preflightSnapshot.planNodes.length
              ? preflightSnapshot.planNodes
              : derivePlanNodesFromPlan(preflightSnapshot.plan),
            validProjectIds,
          ),
          predictedBranches: filterPredictedBranchesForRegistry(
            preflightSnapshot.predictedBranches,
            validProjectIds,
          ),
          projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
            preflightSnapshot.normalizedRegistry.report,
          ),
          isLoading: false,
          lastError: missingMessage,
        });
        void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
        void savePreference(
          PREF_KEYS.MACRO_ENABLED_PROJECTS,
          nextMacroEnabledProjects,
        );
        await persistSessionContext({
          selectedGroupId: preflightSnapshot.normalizedRegistry.selectedGroupId,
          selectedProjectId:
            preflightSnapshot.normalizedRegistry.selectedProjectId,
          mode: previousState.mode,
        });
        await reconcileProjectRegistryDependencies({
          projectGroups: preflightSnapshot.normalizedRegistry.projectGroups,
          selectedGroupId: preflightSnapshot.normalizedRegistry.selectedGroupId,
          selectedProjectId:
            preflightSnapshot.normalizedRegistry.selectedProjectId,
        });
        throw {
          code: "PROJECT_GROUP_NOT_FOUND",
          message: missingMessage,
          details: {
            requestedGroupId: groupId,
            repairApplied: preflightSnapshot.normalizedRegistry.report.repaired,
          },
        };
      }

      await services.renameProjectGroup({
        groupId: canonicalGroup.id,
        name: trimmedName,
      });
      const postMutationSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const normalizedRegistry = postMutationSnapshot.normalizedRegistry;
      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry.projectGroups,
      );

      set({
        currentPlan: postMutationSnapshot.plan,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        planNodes: filterPlanNodesForRegistry(
          postMutationSnapshot.planNodes.length
            ? postMutationSnapshot.planNodes
            : derivePlanNodesFromPlan(postMutationSnapshot.plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          postMutationSnapshot.predictedBranches,
          validProjectIds,
        ),
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
        isLoading: false,
        lastError: null,
      });
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );
      await persistSessionContext({
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        mode: previousState.mode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
      });
      logProjectRegistryAction("succeeded", {
        action: "rename_group",
        groupId: canonicalGroup.id,
        requestedGroupId: groupId,
        canonicalized: canonicalGroup.id !== groupId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "rename_group",
        groupId,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      throw normalized;
    }
  },

  renameProject: async (projectId, name) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const requestedProject = previousState.getProjectById(projectId) ?? null;
      logProjectRegistryAction("started", {
        action: "rename_project",
        projectId,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const preflightSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const canonicalProject = resolveCanonicalProject(
        preflightSnapshot.normalizedRegistry.projectGroups,
        requestedProject,
      );

      if (!canonicalProject) {
        const nextRecentProjects = reconcileRememberedProjects(
          preflightSnapshot.normalizedRegistry.projectGroups,
          previousState.recentProjects,
        );
        const nextMacroEnabledProjects = reconcileRememberedProjects(
          preflightSnapshot.normalizedRegistry.projectGroups,
          previousState.macroEnabledProjects,
        );
        const { validProjectIds } = collectProjectRegistryIds(
          preflightSnapshot.normalizedRegistry.projectGroups,
        );
        const missingMessage =
          "Subproject no longer exists in Macro. The registry was refreshed.";

        set({
          currentPlan: preflightSnapshot.plan,
          projectGroups: preflightSnapshot.normalizedRegistry.projectGroups,
          selectedGroupId: preflightSnapshot.normalizedRegistry.selectedGroupId,
          selectedProjectId:
            preflightSnapshot.normalizedRegistry.selectedProjectId,
          recentProjects: nextRecentProjects,
          macroEnabledProjects: nextMacroEnabledProjects,
          planNodes: filterPlanNodesForRegistry(
            preflightSnapshot.planNodes.length
              ? preflightSnapshot.planNodes
              : derivePlanNodesFromPlan(preflightSnapshot.plan),
            validProjectIds,
          ),
          predictedBranches: filterPredictedBranchesForRegistry(
            preflightSnapshot.predictedBranches,
            validProjectIds,
          ),
          projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
            preflightSnapshot.normalizedRegistry.report,
          ),
          isLoading: false,
          lastError: missingMessage,
        });
        void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
        void savePreference(
          PREF_KEYS.MACRO_ENABLED_PROJECTS,
          nextMacroEnabledProjects,
        );
        await persistSessionContext({
          selectedGroupId: preflightSnapshot.normalizedRegistry.selectedGroupId,
          selectedProjectId:
            preflightSnapshot.normalizedRegistry.selectedProjectId,
          mode: previousState.mode,
        });
        await reconcileProjectRegistryDependencies({
          projectGroups: preflightSnapshot.normalizedRegistry.projectGroups,
          selectedGroupId: preflightSnapshot.normalizedRegistry.selectedGroupId,
          selectedProjectId:
            preflightSnapshot.normalizedRegistry.selectedProjectId,
        });
        throw {
          code: "PROJECT_NOT_FOUND",
          message: missingMessage,
          details: {
            requestedProjectId: projectId,
            repairApplied: preflightSnapshot.normalizedRegistry.report.repaired,
          },
        };
      }

      await services.renameProject({
        projectId: canonicalProject.id,
        name: trimmedName,
      });
      const postMutationSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const normalizedRegistry = postMutationSnapshot.normalizedRegistry;
      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry.projectGroups,
      );

      set({
        currentPlan: postMutationSnapshot.plan,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        planNodes: filterPlanNodesForRegistry(
          postMutationSnapshot.planNodes.length
            ? postMutationSnapshot.planNodes
            : derivePlanNodesFromPlan(postMutationSnapshot.plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          postMutationSnapshot.predictedBranches,
          validProjectIds,
        ),
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
        isLoading: false,
        lastError: null,
      });
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );
      await persistSessionContext({
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        mode: previousState.mode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
      });
      logProjectRegistryAction("succeeded", {
        action: "rename_project",
        projectId: canonicalProject.id,
        requestedProjectId: projectId,
        canonicalized: canonicalProject.id !== projectId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "rename_project",
        projectId,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      throw normalized;
    }
  },

  updateProjectGitFlow: async (projectId, gitFlowSettings) => {
    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const requestedProject = previousState.getProjectById(projectId) ?? null;
      logProjectRegistryAction("started", {
        action: "update_project_git_flow",
        projectId,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const preflightSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const canonicalProject = resolveCanonicalProject(
        preflightSnapshot.normalizedRegistry.projectGroups,
        requestedProject,
      );

      if (!canonicalProject) {
        throw {
          code: "PROJECT_NOT_FOUND",
          message: "Subproject no longer exists in Macro.",
        };
      }

      await services.updateProjectGitFlow({
        projectId: canonicalProject.id,
        gitFlowSettings,
      });

      const postMutationSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const normalizedRegistry = postMutationSnapshot.normalizedRegistry;
      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry.projectGroups,
      );

      set({
        currentPlan: postMutationSnapshot.plan,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        planNodes: filterPlanNodesForRegistry(
          postMutationSnapshot.planNodes.length
            ? postMutationSnapshot.planNodes
            : derivePlanNodesFromPlan(postMutationSnapshot.plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          postMutationSnapshot.predictedBranches,
          validProjectIds,
        ),
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
        isLoading: false,
        lastError: null,
      });
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );
      await persistSessionContext({
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        mode: previousState.mode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
      });
      logProjectRegistryAction("succeeded", {
        action: "update_project_git_flow",
        projectId: canonicalProject.id,
        requestedProjectId: projectId,
        canonicalized: canonicalProject.id !== projectId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "update_project_git_flow",
        projectId,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      throw normalized;
    }
  },

  updateProjectAccess: async (
    projectId,
    userReadOnly,
    confirmedMigration = false,
  ) => {
    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const requestedProject = previousState.getProjectById(projectId) ?? null;
      logProjectRegistryAction("started", {
        action: "update_project_access",
        projectId,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
        userReadOnly,
        confirmedMigration,
        requestedProjectState: requestedProject
          ? {
              id: requestedProject.id,
              name: requestedProject.name,
              gitSetupState: requestedProject.gitSetupState ?? null,
              userReadOnly: requestedProject.userReadOnly ?? false,
              isReadOnly: requestedProject.isReadOnly ?? false,
              readOnlyReason: requestedProject.readOnlyReason ?? null,
            }
          : null,
      });
      const preflightSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const canonicalProject = resolveCanonicalProject(
        preflightSnapshot.normalizedRegistry.projectGroups,
        requestedProject,
      );

      if (!canonicalProject) {
        throw {
          code: "PROJECT_NOT_FOUND",
          message: "Subproject no longer exists in Macro.",
        };
      }

      await services.updateProjectAccess({
        projectId: canonicalProject.id,
        userReadOnly,
        confirmedMigration,
      });

      const postMutationSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const normalizedRegistry = postMutationSnapshot.normalizedRegistry;
      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry.projectGroups,
      );

      set({
        currentPlan: postMutationSnapshot.plan,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        planNodes: filterPlanNodesForRegistry(
          postMutationSnapshot.planNodes.length
            ? postMutationSnapshot.planNodes
            : derivePlanNodesFromPlan(postMutationSnapshot.plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          postMutationSnapshot.predictedBranches,
          validProjectIds,
        ),
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
        isLoading: false,
        lastError: null,
      });
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );
      await persistSessionContext({
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        mode: previousState.mode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
      });
      logProjectRegistryAction("succeeded", {
        action: "update_project_access",
        projectId: canonicalProject.id,
        requestedProjectId: projectId,
        canonicalized: canonicalProject.id !== projectId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
        userReadOnly,
        confirmedMigration,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "update_project_access",
        projectId,
        userReadOnly,
        confirmedMigration,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      throw normalized;
    }
  },

  removeProjectGroup: async (groupId) => {
    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const removedGroup =
        previousState.projectGroups.find((group) => group.id === groupId) ??
        null;
      logProjectRegistryAction("started", {
        action: "remove_group",
        groupId,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const preflightSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const canonicalGroup = resolveCanonicalProjectGroup(
        preflightSnapshot.normalizedRegistry.projectGroups,
        removedGroup,
      );
      const removedProjectIds = new Set(
        (canonicalGroup ?? removedGroup)?.projects.map(
          (project) => project.id,
        ) ?? [],
      );
      const didRemoveActiveGroup =
        previousState.selectedGroupId === groupId ||
        previousState.selectedGroupId === canonicalGroup?.id;

      if (!canonicalGroup) {
        const normalizedRegistry = preflightSnapshot.normalizedRegistry;
        const nextRecentProjects = reconcileRememberedProjects(
          normalizedRegistry.projectGroups,
          previousState.recentProjects.filter(
            (project) => !removedProjectIds.has(project.projectId),
          ),
        );
        const nextMacroEnabledProjects = reconcileRememberedProjects(
          normalizedRegistry.projectGroups,
          previousState.macroEnabledProjects.filter(
            (project) => !removedProjectIds.has(project.projectId),
          ),
        );
        const { validProjectIds } = collectProjectRegistryIds(
          normalizedRegistry.projectGroups,
        );

        set({
          currentPlan: preflightSnapshot.plan,
          projectGroups: normalizedRegistry.projectGroups,
          selectedGroupId: normalizedRegistry.selectedGroupId,
          selectedProjectId: normalizedRegistry.selectedProjectId,
          selectedTaskId: didRemoveActiveGroup
            ? null
            : previousState.selectedTaskId,
          activeArchitectPlanId: didRemoveActiveGroup
            ? null
            : previousState.activeArchitectPlanId,
          activePlanContext: didRemoveActiveGroup
            ? null
            : previousState.activePlanContext,
          planNodes: didRemoveActiveGroup
            ? []
            : filterPlanNodesForRegistry(
                preflightSnapshot.planNodes.length
                  ? preflightSnapshot.planNodes
                  : derivePlanNodesFromPlan(preflightSnapshot.plan),
                validProjectIds,
              ),
          predictedBranches: didRemoveActiveGroup
            ? []
            : filterPredictedBranchesForRegistry(
                preflightSnapshot.predictedBranches,
                validProjectIds,
              ),
          recentProjects: nextRecentProjects,
          macroEnabledProjects: nextMacroEnabledProjects,
          projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
            normalizedRegistry.report,
          ),
          isLoading: false,
          lastError: null,
        });

        const nextFocusedProject = normalizedRegistry.selectedProjectId
          ? (normalizedRegistry.projectGroups
              .flatMap((group) => group.projects)
              .find(
                (project) =>
                  project.id === normalizedRegistry.selectedProjectId,
              ) ?? null)
          : null;
        void savePreference(
          PREF_KEYS.LAST_SELECTED_GROUP_ID,
          normalizedRegistry.selectedGroupId,
        );
        void savePreference(
          PREF_KEYS.LAST_SELECTED_PROJECT_ID,
          normalizedRegistry.selectedProjectId,
        );
        void savePreference(
          PREF_KEYS.LAST_OPEN_PROJECT_PATH,
          nextFocusedProject?.path &&
            shouldPersistProjectPath(nextFocusedProject.path)
            ? nextFocusedProject.path
            : null,
        );
        void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
        void savePreference(
          PREF_KEYS.MACRO_ENABLED_PROJECTS,
          nextMacroEnabledProjects,
        );
        await persistSessionContext({
          selectedGroupId: normalizedRegistry.selectedGroupId,
          selectedProjectId: normalizedRegistry.selectedProjectId,
          mode: previousState.mode,
        });
        await reconcileProjectRegistryDependencies({
          projectGroups: normalizedRegistry.projectGroups,
          selectedGroupId: normalizedRegistry.selectedGroupId,
          selectedProjectId: normalizedRegistry.selectedProjectId,
        });

        if (
          normalizedRegistry.selectedGroupId &&
          get().projectSwitchPolicy === "resume_per_project"
        ) {
          await restoreProjectContext(
            normalizedRegistry.selectedGroupId,
            normalizedRegistry.selectedProjectId,
          );
        }
        logProjectRegistryAction("succeeded", {
          action: "remove_group",
          groupId,
          afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
          alreadyRemoved: true,
          repairApplied: normalizedRegistry.report.repaired,
        });
        return;
      }

      await services.removeProjectGroup({ groupId: canonicalGroup.id });
      const postMutationSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: didRemoveActiveGroup
          ? null
          : previousState.selectedGroupId,
        selectedProjectId: removedProjectIds.has(
          previousState.selectedProjectId ?? "",
        )
          ? null
          : previousState.selectedProjectId,
      });
      const normalizedRegistry = postMutationSnapshot.normalizedRegistry;
      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.recentProjects.filter(
          (project) => !removedProjectIds.has(project.projectId),
        ),
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.macroEnabledProjects.filter(
          (project) => !removedProjectIds.has(project.projectId),
        ),
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry.projectGroups,
      );

      set({
        currentPlan: postMutationSnapshot.plan,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        selectedTaskId: didRemoveActiveGroup
          ? null
          : previousState.selectedTaskId,
        activeArchitectPlanId: didRemoveActiveGroup
          ? null
          : previousState.activeArchitectPlanId,
        activePlanContext: didRemoveActiveGroup
          ? null
          : previousState.activePlanContext,
        planNodes: didRemoveActiveGroup
          ? []
          : filterPlanNodesForRegistry(
              postMutationSnapshot.planNodes.length
                ? postMutationSnapshot.planNodes
                : derivePlanNodesFromPlan(postMutationSnapshot.plan),
              validProjectIds,
            ),
        predictedBranches: didRemoveActiveGroup
          ? []
          : filterPredictedBranchesForRegistry(
              postMutationSnapshot.predictedBranches,
              validProjectIds,
            ),
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
        isLoading: false,
        lastError: null,
      });

      const nextFocusedProject = normalizedRegistry.selectedProjectId
        ? (normalizedRegistry.projectGroups
            .flatMap((group) => group.projects)
            .find(
              (project) => project.id === normalizedRegistry.selectedProjectId,
            ) ?? null)
        : null;
      void savePreference(
        PREF_KEYS.LAST_SELECTED_GROUP_ID,
        normalizedRegistry.selectedGroupId,
      );
      void savePreference(
        PREF_KEYS.LAST_SELECTED_PROJECT_ID,
        normalizedRegistry.selectedProjectId,
      );
      void savePreference(
        PREF_KEYS.LAST_OPEN_PROJECT_PATH,
        nextFocusedProject?.path &&
          shouldPersistProjectPath(nextFocusedProject.path)
          ? nextFocusedProject.path
          : null,
      );
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );
      await persistSessionContext({
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        mode: previousState.mode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
      });

      if (
        normalizedRegistry.selectedGroupId &&
        get().projectSwitchPolicy === "resume_per_project"
      ) {
        await restoreProjectContext(
          normalizedRegistry.selectedGroupId,
          normalizedRegistry.selectedProjectId,
        );
      }
      logProjectRegistryAction("succeeded", {
        action: "remove_group",
        groupId: canonicalGroup.id,
        requestedGroupId: groupId,
        canonicalized: canonicalGroup.id !== groupId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "remove_group",
        groupId,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      throw normalized;
    }
  },

  removeProject: async (projectId) => {
    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const removedProject = previousState.getProjectById(projectId) ?? null;
      logProjectRegistryAction("started", {
        action: "remove_project",
        projectId,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const preflightSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const canonicalProject = resolveCanonicalProject(
        preflightSnapshot.normalizedRegistry.projectGroups,
        removedProject,
      );
      const closedProjectGroupId =
        getProjectGroupByProjectId(
          preflightSnapshot.normalizedRegistry.projectGroups,
          canonicalProject?.id ?? projectId,
        )?.id ?? null;
      const didRemoveProjectInActiveGroup =
        Boolean(closedProjectGroupId) &&
        previousState.selectedGroupId === closedProjectGroupId;

      if (!canonicalProject) {
        const normalizedRegistry = preflightSnapshot.normalizedRegistry;
        const nextRecentProjects = reconcileRememberedProjects(
          normalizedRegistry.projectGroups,
          previousState.recentProjects.filter(
            (project) => project.projectId !== projectId,
          ),
        );
        const nextMacroEnabledProjects = reconcileRememberedProjects(
          normalizedRegistry.projectGroups,
          previousState.macroEnabledProjects.filter(
            (project) => project.projectId !== projectId,
          ),
        );
        const { validProjectIds } = collectProjectRegistryIds(
          normalizedRegistry.projectGroups,
        );

        set({
          currentPlan: preflightSnapshot.plan,
          projectGroups: normalizedRegistry.projectGroups,
          selectedGroupId: normalizedRegistry.selectedGroupId,
          selectedProjectId: normalizedRegistry.selectedProjectId,
          selectedTaskId: didRemoveProjectInActiveGroup
            ? null
            : previousState.selectedTaskId,
          activeArchitectPlanId: didRemoveProjectInActiveGroup
            ? null
            : previousState.activeArchitectPlanId,
          activePlanContext: didRemoveProjectInActiveGroup
            ? null
            : previousState.activePlanContext,
          planNodes: didRemoveProjectInActiveGroup
            ? []
            : filterPlanNodesForRegistry(
                preflightSnapshot.planNodes.length
                  ? preflightSnapshot.planNodes
                  : derivePlanNodesFromPlan(preflightSnapshot.plan),
                validProjectIds,
              ),
          predictedBranches: didRemoveProjectInActiveGroup
            ? []
            : filterPredictedBranchesForRegistry(
                preflightSnapshot.predictedBranches,
                validProjectIds,
              ),
          recentProjects: nextRecentProjects,
          macroEnabledProjects: nextMacroEnabledProjects,
          projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
            normalizedRegistry.report,
          ),
          isLoading: false,
          lastError: null,
        });

        const nextFocusedProject = normalizedRegistry.selectedProjectId
          ? (normalizedRegistry.projectGroups
              .flatMap((group) => group.projects)
              .find(
                (project) =>
                  project.id === normalizedRegistry.selectedProjectId,
              ) ?? null)
          : null;
        void savePreference(
          PREF_KEYS.LAST_SELECTED_GROUP_ID,
          normalizedRegistry.selectedGroupId,
        );
        void savePreference(
          PREF_KEYS.LAST_SELECTED_PROJECT_ID,
          normalizedRegistry.selectedProjectId,
        );
        void savePreference(
          PREF_KEYS.LAST_OPEN_PROJECT_PATH,
          nextFocusedProject?.path &&
            shouldPersistProjectPath(nextFocusedProject.path)
            ? nextFocusedProject.path
            : null,
        );
        void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
        void savePreference(
          PREF_KEYS.MACRO_ENABLED_PROJECTS,
          nextMacroEnabledProjects,
        );
        await persistSessionContext({
          selectedGroupId: normalizedRegistry.selectedGroupId,
          selectedProjectId: normalizedRegistry.selectedProjectId,
          mode: previousState.mode,
        });
        await reconcileProjectRegistryDependencies({
          projectGroups: normalizedRegistry.projectGroups,
          selectedGroupId: normalizedRegistry.selectedGroupId,
          selectedProjectId: normalizedRegistry.selectedProjectId,
        });

        if (
          normalizedRegistry.selectedGroupId &&
          get().projectSwitchPolicy === "resume_per_project"
        ) {
          await restoreProjectContext(
            normalizedRegistry.selectedGroupId,
            normalizedRegistry.selectedProjectId,
          );
        }
        logProjectRegistryAction("succeeded", {
          action: "remove_project",
          projectId,
          afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
          alreadyRemoved: true,
          repairApplied: normalizedRegistry.report.repaired,
        });
        return;
      }

      await services.removeProject({ projectId: canonicalProject.id });
      const postMutationSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId:
          previousState.selectedProjectId === canonicalProject.id
            ? null
            : previousState.selectedProjectId,
      });
      const normalizedRegistry = postMutationSnapshot.normalizedRegistry;
      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.recentProjects.filter(
          (project) => project.projectId !== canonicalProject.id,
        ),
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.macroEnabledProjects.filter(
          (project) => project.projectId !== canonicalProject.id,
        ),
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry.projectGroups,
      );

      set({
        currentPlan: postMutationSnapshot.plan,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        selectedTaskId: didRemoveProjectInActiveGroup
          ? null
          : previousState.selectedTaskId,
        activeArchitectPlanId: didRemoveProjectInActiveGroup
          ? null
          : previousState.activeArchitectPlanId,
        activePlanContext: didRemoveProjectInActiveGroup
          ? null
          : previousState.activePlanContext,
        planNodes: didRemoveProjectInActiveGroup
          ? []
          : filterPlanNodesForRegistry(
              postMutationSnapshot.planNodes.length
                ? postMutationSnapshot.planNodes
                : derivePlanNodesFromPlan(postMutationSnapshot.plan),
              validProjectIds,
            ),
        predictedBranches: didRemoveProjectInActiveGroup
          ? []
          : filterPredictedBranchesForRegistry(
              postMutationSnapshot.predictedBranches,
              validProjectIds,
            ),
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
        isLoading: false,
        lastError: null,
      });

      const nextFocusedProject = normalizedRegistry.selectedProjectId
        ? (normalizedRegistry.projectGroups
            .flatMap((group) => group.projects)
            .find(
              (project) => project.id === normalizedRegistry.selectedProjectId,
            ) ?? null)
        : null;
      void savePreference(
        PREF_KEYS.LAST_SELECTED_GROUP_ID,
        normalizedRegistry.selectedGroupId,
      );
      void savePreference(
        PREF_KEYS.LAST_SELECTED_PROJECT_ID,
        normalizedRegistry.selectedProjectId,
      );
      void savePreference(
        PREF_KEYS.LAST_OPEN_PROJECT_PATH,
        nextFocusedProject?.path &&
          shouldPersistProjectPath(nextFocusedProject.path)
          ? nextFocusedProject.path
          : null,
      );
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );
      await persistSessionContext({
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        mode: previousState.mode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
      });

      if (
        normalizedRegistry.selectedGroupId &&
        get().projectSwitchPolicy === "resume_per_project"
      ) {
        await restoreProjectContext(
          normalizedRegistry.selectedGroupId,
          normalizedRegistry.selectedProjectId,
        );
      }
      logProjectRegistryAction("succeeded", {
        action: "remove_project",
        projectId: canonicalProject.id,
        requestedProjectId: projectId,
        canonicalized: canonicalProject.id !== projectId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "remove_project",
        projectId,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      throw normalized;
    }
  },

  updateProjectGitFlowWithSetup: async (
    projectId,
    gitFlowSettings,
    gitSetupActions,
    expectedRepoRootPath,
    expectedSetupState,
    expectedRecommendedActionSequence,
  ) => {
    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const requestedProject = previousState.getProjectById(projectId) ?? null;
      logProjectRegistryAction("started", {
        action: "update_project_git_flow_with_setup",
        projectId,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const preflightSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const canonicalProject = resolveCanonicalProject(
        preflightSnapshot.normalizedRegistry.projectGroups,
        requestedProject,
      );

      if (!canonicalProject) {
        throw {
          code: "PROJECT_NOT_FOUND",
          message: "Subproject no longer exists in Macro.",
        };
      }

      const result = await services.updateProjectGitFlowWithSetup({
        projectId: canonicalProject.id,
        gitFlowSettings,
        gitSetupActions,
        expectedRepoRootPath: expectedRepoRootPath ?? null,
        expectedSetupState,
        expectedRecommendedActionSequence,
      });

      const postMutationSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const normalizedRegistry = postMutationSnapshot.normalizedRegistry;
      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry.projectGroups,
      );

      set({
        currentPlan: postMutationSnapshot.plan,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        planNodes: filterPlanNodesForRegistry(
          postMutationSnapshot.planNodes.length
            ? postMutationSnapshot.planNodes
            : derivePlanNodesFromPlan(postMutationSnapshot.plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          postMutationSnapshot.predictedBranches,
          validProjectIds,
        ),
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
        isLoading: false,
        lastError: null,
      });
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );
      await persistSessionContext({
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        mode: previousState.mode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
      });
      logProjectRegistryAction("succeeded", {
        action: "update_project_git_flow_with_setup",
        projectId: canonicalProject.id,
        requestedProjectId: projectId,
        canonicalized: canonicalProject.id !== projectId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
      return result;
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "update_project_git_flow_with_setup",
        projectId,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      throw normalized;
    }
  },

  // Settings modal
  openSettings: (tab = "general") =>
    set({ settingsOpen: true, activeSettingsTab: tab }),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (tab) => set({ activeSettingsTab: tab }),

  openAccount: () => set({ accountOpen: true }),

  closeAccount: () => set({ accountOpen: false }),

  openProjectModal: (groupId = null) =>
    set({ projectModalOpen: true, projectModalGroupId: groupId }),

  closeProjectModal: () =>
    set({ projectModalOpen: false, projectModalGroupId: null }),

  openProjectGitFlowModal: (projectId) =>
    set({ projectGitFlowModalProjectId: projectId }),

  closeProjectGitFlowModal: () => set({ projectGitFlowModalProjectId: null }),

  createProject: async (data: CreateProjectData) => {
    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const gitFlowSettings =
        data.gitFlowSettings || getDefaultProjectGitFlowSettings();
      logProjectRegistryAction("started", {
        action: "create_project",
        groupId: data.groupId,
        path: data.path ?? null,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const { project: newProject } = await services.createProject({
        ...data,
        gitFlowSettings,
      });
      const state = get();
      if (state.selectedGroupId) {
        await persistCurrentProjectContext(
          state.selectedGroupId,
          state.selectedProjectId,
        );
      }
      const {
        projectGroups: syncedGroups,
        plan,
        planNodes,
        predictedBranches,
      } = await services.getAppBootstrap();
      const syncedGroupForProject = getProjectGroupByProjectId(
        syncedGroups,
        newProject.id,
      );
      const seededRegistry = syncedGroupForProject
        ? syncedGroups
        : insertProjectInGroups(state.projectGroups, newProject, data.groupId)
            .projectGroups;
      const normalizedRegistry = normalizeProjectRegistry({
        projectGroups: seededRegistry,
        selectedGroupId:
          syncedGroupForProject?.id ?? data.groupId ?? state.selectedGroupId,
        selectedProjectId: newProject.id,
      });
      const targetGroupId =
        getProjectGroupByProjectId(
          normalizedRegistry.projectGroups,
          newProject.id,
        )?.id ?? normalizedRegistry.selectedGroupId;
      const isCurrentGroup = targetGroupId === state.selectedGroupId;
      const preferredFocusProjectId = targetGroupId
        ? (getFocusedProjectIdForGroup(
            normalizedRegistry.projectGroups,
            targetGroupId,
            isCurrentGroup ? state.selectedProjectId : newProject.id,
          ) ?? newProject.id)
        : (normalizedRegistry.selectedProjectId ?? newProject.id);

      const rememberedProject: RememberedProject | null = targetGroupId
        ? {
            projectId: newProject.id,
            groupId: targetGroupId,
            name: newProject.name,
            path: newProject.path,
            lastOpenedAt: new Date().toISOString(),
          }
        : null;

      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        rememberedProject
          ? upsertRememberedProject(state.recentProjects, rememberedProject)
          : state.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        rememberedProject
          ? upsertRememberedProject(
              state.macroEnabledProjects,
              rememberedProject,
            )
          : state.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry.projectGroups,
      );

      set({
        currentPlan: plan,
        projectGroups: normalizedRegistry.projectGroups,
        planNodes: filterPlanNodesForRegistry(
          planNodes?.length ? planNodes : derivePlanNodesFromPlan(plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          predictedBranches ?? [],
          validProjectIds,
        ),
        selectedGroupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        selectedProjectId: preferredFocusProjectId,
        selectedTaskId: isCurrentGroup ? state.selectedTaskId : null,
        activeArchitectPlanId: isCurrentGroup
          ? state.activeArchitectPlanId
          : null,
        activePlanContext: isCurrentGroup ? state.activePlanContext : null,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
      });
      void savePreference(
        PREF_KEYS.LAST_SELECTED_GROUP_ID,
        targetGroupId ?? normalizedRegistry.selectedGroupId,
      );
      void savePreference(
        PREF_KEYS.LAST_SELECTED_PROJECT_ID,
        preferredFocusProjectId,
      );
      if (shouldPersistProjectPath(newProject.path)) {
        void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, newProject.path);
      } else {
        void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, null);
      }
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );

      await persistSessionContext({
        selectedGroupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        selectedProjectId: preferredFocusProjectId,
        mode: state.mode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        selectedProjectId: preferredFocusProjectId,
      });

      const restoredGroupId =
        targetGroupId ?? normalizedRegistry.selectedGroupId;
      if (
        get().projectSwitchPolicy === "resume_per_project" &&
        restoredGroupId
      ) {
        await restoreProjectContext(restoredGroupId, preferredFocusProjectId);
      }

      await ensureAutoPlanForSelection({
        groupId: restoredGroupId,
        projectId: preferredFocusProjectId,
      });

      logProjectRegistryAction("succeeded", {
        action: "create_project",
        projectId: newProject.id,
        groupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
      set({ isLoading: false, lastError: null });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "create_project",
        groupId: data.groupId,
        path: data.path ?? null,
        error: normalized.message,
      });
      throw normalized;
    }
  },

  createProjectWithGitSetup: async (data) => {
    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const gitFlowSettings =
        data.gitFlowSettings || getDefaultProjectGitFlowSettings();
      logProjectRegistryAction("started", {
        action: "create_project_with_git_setup",
        groupId: data.groupId,
        path: data.path ?? null,
        gitSetupActions: data.gitSetupActions,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const result = await services.createProjectWithGitSetup({
        ...data,
        gitFlowSettings,
      });
      const newProject = result.project;
      const state = get();
      if (state.selectedGroupId) {
        await persistCurrentProjectContext(
          state.selectedGroupId,
          state.selectedProjectId,
        );
      }
      const {
        projectGroups: syncedGroups,
        plan,
        planNodes,
        predictedBranches,
      } = await services.getAppBootstrap();
      const syncedGroupForProject = getProjectGroupByProjectId(
        syncedGroups,
        newProject.id,
      );
      const seededRegistry = syncedGroupForProject
        ? syncedGroups
        : insertProjectInGroups(state.projectGroups, newProject, data.groupId)
            .projectGroups;
      const normalizedRegistry = normalizeProjectRegistry({
        projectGroups: seededRegistry,
        selectedGroupId:
          syncedGroupForProject?.id ?? data.groupId ?? state.selectedGroupId,
        selectedProjectId: newProject.id,
      });
      const targetGroupId =
        getProjectGroupByProjectId(
          normalizedRegistry.projectGroups,
          newProject.id,
        )?.id ?? normalizedRegistry.selectedGroupId;
      const isCurrentGroup = targetGroupId === state.selectedGroupId;
      const preferredFocusProjectId = targetGroupId
        ? (getFocusedProjectIdForGroup(
            normalizedRegistry.projectGroups,
            targetGroupId,
            isCurrentGroup ? state.selectedProjectId : newProject.id,
          ) ?? newProject.id)
        : (normalizedRegistry.selectedProjectId ?? newProject.id);

      const rememberedProject: RememberedProject | null = targetGroupId
        ? {
            projectId: newProject.id,
            groupId: targetGroupId,
            name: newProject.name,
            path: newProject.path,
            lastOpenedAt: new Date().toISOString(),
          }
        : null;

      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        rememberedProject
          ? upsertRememberedProject(state.recentProjects, rememberedProject)
          : state.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        rememberedProject
          ? upsertRememberedProject(
              state.macroEnabledProjects,
              rememberedProject,
            )
          : state.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry.projectGroups,
      );

      set({
        currentPlan: plan,
        projectGroups: normalizedRegistry.projectGroups,
        planNodes: filterPlanNodesForRegistry(
          planNodes?.length ? planNodes : derivePlanNodesFromPlan(plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          predictedBranches ?? [],
          validProjectIds,
        ),
        selectedGroupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        selectedProjectId: preferredFocusProjectId,
        selectedTaskId: isCurrentGroup ? state.selectedTaskId : null,
        activeArchitectPlanId: isCurrentGroup
          ? state.activeArchitectPlanId
          : null,
        activePlanContext: isCurrentGroup ? state.activePlanContext : null,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
      });
      void savePreference(
        PREF_KEYS.LAST_SELECTED_GROUP_ID,
        targetGroupId ?? normalizedRegistry.selectedGroupId,
      );
      void savePreference(
        PREF_KEYS.LAST_SELECTED_PROJECT_ID,
        preferredFocusProjectId,
      );
      if (shouldPersistProjectPath(newProject.path)) {
        void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, newProject.path);
      } else {
        void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, null);
      }
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );

      await persistSessionContext({
        selectedGroupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        selectedProjectId: preferredFocusProjectId,
        mode: state.mode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        selectedProjectId: preferredFocusProjectId,
      });

      const restoredGroupId =
        targetGroupId ?? normalizedRegistry.selectedGroupId;
      if (
        get().projectSwitchPolicy === "resume_per_project" &&
        restoredGroupId
      ) {
        await restoreProjectContext(restoredGroupId, preferredFocusProjectId);
      }

      await ensureAutoPlanForSelection({
        groupId: restoredGroupId,
        projectId: preferredFocusProjectId,
      });

      logProjectRegistryAction("succeeded", {
        action: "create_project_with_git_setup",
        projectId: newProject.id,
        groupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
      set({ isLoading: false, lastError: null });
      return result;
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "create_project_with_git_setup",
        groupId: data.groupId,
        path: data.path ?? null,
        gitSetupActions: data.gitSetupActions,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      throw normalized;
    }
  },

  refreshProjectRegistry: async () => {
    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const snapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const normalizedRegistry = snapshot.normalizedRegistry;
      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry.projectGroups,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry.projectGroups,
      );

      set({
        currentPlan: snapshot.plan,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        planNodes: filterPlanNodesForRegistry(
          snapshot.planNodes.length
            ? snapshot.planNodes
            : derivePlanNodesFromPlan(snapshot.plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          snapshot.predictedBranches,
          validProjectIds,
        ),
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
        isLoading: false,
        lastError: null,
      });
      void savePreference(PREF_KEYS.RECENT_PROJECTS, nextRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        nextMacroEnabledProjects,
      );
      await persistSessionContext({
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        mode: previousState.mode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      throw normalized;
    }
  },

  setLeftPanelWidth: (width) => {
    const clampedWidth = Math.max(200, Math.min(600, width));
    set({ leftPanelWidth: clampedWidth });
    savePreferenceDebounced(PREF_KEYS.LEFT_PANEL_WIDTH, clampedWidth);
  },

  setRightPanelWidth: (width) => {
    const clampedWidth = Math.max(200, Math.min(600, width));
    set({ rightPanelWidth: clampedWidth });
    savePreferenceDebounced(PREF_KEYS.RIGHT_PANEL_WIDTH, clampedWidth);
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
      logProjectRegistryAction("started", { action: "initialize" });
      // Load persisted panel preferences
      const [
        leftWidth,
        rightWidth,
        leftOpen,
        rightOpen,
        uiZoomMode,
        uiZoomLevel,
        codeOverflowMode,
        lastSelectedGroupId,
        lastSelectedProjectId,
        lastOpenProjectPath,
        lastActiveMode,
        lastAgentType,
        recentProjects,
        macroEnabledProjects,
        metadataAutoPush,
        implementExecutionMode,
        notificationChannelModes,
        storedProjectSwitchPolicy,
        sessionContext,
      ] = await Promise.all([
        loadPreference<number>(PREF_KEYS.LEFT_PANEL_WIDTH),
        loadPreference<number>(PREF_KEYS.RIGHT_PANEL_WIDTH),
        loadPreference<boolean>(PREF_KEYS.IS_LEFT_PANEL_OPEN),
        loadPreference<boolean>(PREF_KEYS.IS_RIGHT_PANEL_OPEN),
        loadPreference<UiZoomMode>(PREF_KEYS.UI_ZOOM_MODE),
        loadPreference<number>(PREF_KEYS.UI_ZOOM_LEVEL),
        loadPreference<CodeOverflowMode>(PREF_KEYS.CODE_OVERFLOW_MODE),
        loadPreference<string | null>(PREF_KEYS.LAST_SELECTED_GROUP_ID),
        loadPreference<string | null>(PREF_KEYS.LAST_SELECTED_PROJECT_ID),
        loadPreference<string | null>(PREF_KEYS.LAST_OPEN_PROJECT_PATH),
        loadPreference<AppMode>(PREF_KEYS.LAST_ACTIVE_MODE),
        loadPreference<AgentType>(PREF_KEYS.AGENT_TYPE),
        loadPreference<RememberedProject[]>(PREF_KEYS.RECENT_PROJECTS),
        loadPreference<RememberedProject[]>(PREF_KEYS.MACRO_ENABLED_PROJECTS),
        loadPreference<boolean>(PREF_KEYS.METADATA_AUTO_PUSH),
        loadPreference<ImplementExecutionMode>(
          PREF_KEYS.IMPLEMENT_EXECUTION_MODE,
        ),
        loadPreference<NotificationChannelModes>(
          PREF_KEYS.NOTIFICATION_CHANNEL_MODES,
        ),
        getProjectSwitchPolicy(),
        getLocalSessionContextState(),
      ]);

      const normalizedZoomMode: UiZoomMode =
        uiZoomMode === "override" ? "override" : "auto";
      const normalizedZoomLevel = clampUiZoomLevel(uiZoomLevel);
      const normalizedCodeOverflowMode =
        normalizeCodeOverflowMode(codeOverflowMode);
      const normalizedImplementExecutionMode: ImplementExecutionMode =
        implementExecutionMode === "full_auto" ? "full_auto" : "semi_auto";

      const prunedRecentProjects =
        pruneLegacyRememberedProjects(recentProjects);
      const prunedMacroEnabledProjects =
        pruneLegacyRememberedProjects(macroEnabledProjects);
      let metadataRecoveryReport: WorkspaceMetadataRecoveryReportDto | null =
        null;
      if (tauriIpc.isTauriAvailable()) {
        try {
          const recoveryHints = buildMetadataRecoveryHints(
            prunedMacroEnabledProjects,
            prunedRecentProjects,
          );
          const recoveryResult = await tauriIpc.workspaceRecoverMissingMetadata(
            {
              attemptPull: true,
              projects: recoveryHints,
            },
          );
          metadataRecoveryReport =
            recoveryResult.status === "none" ? null : recoveryResult;
        } catch (error) {
          devLogger.info(
            `[Init] @macro metadata recovery failed before bootstrap: ${toServiceError(error).message}`,
          );
        }
      }

      const { plan, projectGroups, planNodes, predictedBranches } =
        await services.getAppBootstrap();
      const prunedProjectGroups = pruneLegacyWorkspaceMocks(projectGroups);

      const sessionSelectedProjectId =
        sessionContext?.selectedProjectId ?? null;
      const sessionSelectedGroupId = sessionContext?.selectedGroupId ?? null;
      const sessionMode = isAppMode(sessionContext?.mode)
        ? sessionContext.mode
        : null;
      const effectiveLastSelectedProjectId =
        sessionSelectedProjectId || lastSelectedProjectId;
      const effectiveLastSelectedGroupId =
        sessionSelectedGroupId || lastSelectedGroupId;

      const normalizedRegistry = normalizeProjectRegistry({
        projectGroups: prunedProjectGroups,
        selectedGroupId: effectiveLastSelectedGroupId,
        selectedProjectId: effectiveLastSelectedProjectId,
      });
      let resolvedProjectGroups = normalizedRegistry.projectGroups;
      let resolvedGroupId = normalizedRegistry.selectedGroupId;
      let resolvedProjectId = normalizedRegistry.selectedProjectId;

      const cleanedRecentProjects = reconcileRememberedProjects(
        resolvedProjectGroups,
        prunedRecentProjects,
      );
      const cleanedMacroEnabledProjects = reconcileRememberedProjects(
        resolvedProjectGroups,
        prunedMacroEnabledProjects,
      );

      const sanitizedLastOpenProjectPath = shouldPersistProjectPath(
        lastOpenProjectPath,
      )
        ? lastOpenProjectPath
        : null;

      if (!sanitizedLastOpenProjectPath && lastOpenProjectPath) {
        void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, null);
      }

      if (!resolvedProjectId && sanitizedLastOpenProjectPath) {
        const normalizedLastPath = normalizePath(sanitizedLastOpenProjectPath);
        const groupForPath = resolvedProjectGroups.find((group) =>
          group.projects.some(
            (project) => normalizePath(project.path) === normalizedLastPath,
          ),
        );

        if (groupForPath) {
          resolvedGroupId = groupForPath.id;
        } else {
          void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, null);
        }
      }

      if (!resolvedGroupId) {
        const firstValidRecent = cleanedRecentProjects.find((recent) =>
          resolvedProjectGroups.some((group) =>
            group.projects.some(
              (project) =>
                normalizePath(project.path) === normalizePath(recent.path),
            ),
          ),
        );

        if (firstValidRecent) {
          const recentProjectMatch = resolvedProjectGroups
            .flatMap((group) => group.projects)
            .find(
              (project) =>
                normalizePath(project.path) ===
                normalizePath(firstValidRecent.path),
            );
          const groupForRecent = getProjectGroupByProjectId(
            resolvedProjectGroups,
            recentProjectMatch?.id ?? null,
          );
          resolvedGroupId = groupForRecent?.id ?? null;
        }
      }

      if (!resolvedGroupId) {
        resolvedGroupId = resolvedProjectGroups[0]?.id ?? null;
      }

      if (resolvedGroupId) {
        resolvedProjectId = resolveExplicitProjectIdForGroup(
          resolvedProjectGroups,
          resolvedGroupId,
          resolvedProjectId,
        );
      }

      const resolvedMode: AppMode = isAppMode(sessionMode)
        ? sessionMode
        : ["Architect", "Implement", "Chat"].includes(lastActiveMode)
          ? lastActiveMode
          : "Implement";
      const resolvedAgentType: AgentType = ["build", "plan"].includes(
        lastAgentType,
      )
        ? lastAgentType
        : "build";

      const { validProjectIds } = collectProjectRegistryIds(
        resolvedProjectGroups,
      );

      set({
        mode: resolvedMode,
        agentType: resolvedAgentType,
        currentPlan: plan,
        projectGroups: resolvedProjectGroups,
        planNodes: filterPlanNodesForRegistry(
          planNodes?.length ? planNodes : derivePlanNodesFromPlan(plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          predictedBranches ?? [],
          validProjectIds,
        ),
        selectedGroupId: resolvedGroupId,
        selectedProjectId: resolvedProjectId,
        recentProjects: cleanedRecentProjects,
        macroEnabledProjects: cleanedMacroEnabledProjects,
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
        metadataRecoveryReport,
        leftPanelWidth: leftWidth,
        rightPanelWidth: rightWidth,
        isLeftPanelOpen: leftOpen,
        isRightPanelOpen: rightOpen,
        uiZoomMode: normalizedZoomMode,
        uiZoomLevel: normalizedZoomLevel,
        codeOverflowMode: normalizedCodeOverflowMode,
        metadataAutoPush,
        implementExecutionMode: normalizedImplementExecutionMode,
        notificationChannelModes: sanitizeNotificationChannelModes(
          notificationChannelModes,
        ),
        projectSwitchPolicy: storedProjectSwitchPolicy,
        isProjectSwitching: false,
        isLoading: false,
      });

      void savePreference(PREF_KEYS.RECENT_PROJECTS, cleanedRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        cleanedMacroEnabledProjects,
      );
      const resolvedFocusedProject = resolvedProjectId
        ? (resolvedProjectGroups
            .flatMap((group) => group.projects)
            .find((project) => project.id === resolvedProjectId) ?? null)
        : null;
      void savePreference(
        PREF_KEYS.LAST_OPEN_PROJECT_PATH,
        resolvedFocusedProject?.path &&
          shouldPersistProjectPath(resolvedFocusedProject.path)
          ? resolvedFocusedProject.path
          : null,
      );
      await persistSessionContext({
        selectedGroupId: resolvedGroupId,
        selectedProjectId: resolvedProjectId,
        mode: resolvedMode,
      });
      await reconcileProjectRegistryDependencies({
        projectGroups: resolvedProjectGroups,
        selectedGroupId: resolvedGroupId,
        selectedProjectId: resolvedProjectId,
      });
      logProjectRegistryAction("succeeded", {
        action: "initialize",
        afterCount: countProjectsInRegistry(resolvedProjectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });

      if (
        (resolvedGroupId || resolvedProjectId) &&
        storedProjectSwitchPolicy === "resume_per_project"
      ) {
        await restoreProjectContext(resolvedGroupId || resolvedProjectId!);
      }

      await ensureAutoPlanForSelection({
        groupId: useAppStore.getState().selectedGroupId,
        projectId: useAppStore.getState().selectedProjectId,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "initialize",
        error: normalized.message,
      });
    }
  },
}));
