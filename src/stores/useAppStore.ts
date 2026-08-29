import { create } from "zustand";
import { useChatStore } from "./useChatStore";
import { useTaskStore } from "./useTaskStore";
import {
  AppMode,
  AgentType,
  CodeOverflowMode,
  Plan,
	  ProjectGroup,
	  Project,
	  ProjectRegistry,
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
  type LocalProjectContextState,
  type ProjectSwitchPolicy,
} from "../services/localProjectContext";
import * as localProjectContext from "../services/localProjectContext";
import { getDefaultProjectGitFlowSettings } from "../services/architectGitNaming";
import {
  type ArchitectPlanActivationPayload,
  type ArchitectPlanSummary,
  getArchitectPlanVisibleProjectIds,
  getArchitectPlan,
  getArchitectPlanActivationPayload,
  getGitFlowBaseBranch,
  isArchitectPlanVisibleForScope,
  planMatchesProjectId,
  resolvePlanProjectContextId,
  resolveTargetBranch,
  setActiveArchitectPlan as persistActiveArchitectPlan,
} from "../services/architectPlanService";
import {
  persistArchitectPlanStrategyPreview,
  readArchitectPlanRuntime,
} from "../services/architectPlanRuntimeService";
import type {
  ArchitectPlanGitFlowMetadata,
  ArchitectPlanKind,
} from "../services/architectPlanKinds";
import type { StrategyMutationPreview } from "../services/architectStrategyMutationGuard";
import { taskMatchesProjectId } from "../services/implementTaskCatalog";
import {
  loadPreference,
  type MetadataMissingUpstreamPolicy,
  purgeLegacyImplementExecutionModePreference,
  savePreference,
  savePreferenceDebounced,
  PREF_KEYS,
} from "../services/preferences";
import {
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
  isProjectGitActionable,
  resolveExplicitProjectIdForGroup,
  getScopedProjectIds,
} from "../services/globalProjects";
import {
  countProjectsInProjectRegistry,
  countProjectsInRegistry,
  formatProjectRegistryRepairSummary,
  normalizeProjectRegistry,
  type ProjectRegistryRepairReport,
  resolveCanonicalProject,
  resolveCanonicalProjectGroup,
  reconcileRememberedProjects,
} from "../services/projectRegistry";
import {
  collectKnownProjectIds,
  retargetPlanForExecution,
} from "../services/projectIdentityReconciliation";
import { consolidateScopedBlankPlans } from "../services/architectAutoPlan";
import {
  buildArchitectPlanCatalogScopeKey,
  loadMacroProjectMetadataForSelection as loadMacroProjectMetadataCatalog,
  type ArchitectPlanCatalogBranch,
  type ArchitectPlanCatalogStatus,
  type MacroProjectMetadataLoadResult,
} from "../services/macroProjectMetadataLoader";
import { flushMacroMetadata } from "../services/macroMetadataCoordinator";
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
  | "speech"
  | "tools"
  | "skills"
  | "shortcuts"
  | "prompts"
  | "architect";
export type UiZoomMode = "auto" | "override";
export type MetadataSyncState = "clean" | "pending" | "failed" | "conflict";
export type { MetadataMissingUpstreamPolicy };

const normalizeCodeOverflowMode = (
  value: CodeOverflowMode | string | null | undefined,
): CodeOverflowMode =>
  value === "horizontal_scroll" ? "horizontal_scroll" : "wrap";

const flushMacroMetadataForProjectGroupSwitch = async (
  state: {
    standaloneProjects: Project[];
    projectGroups: ProjectGroup[];
    selectedGroupId: string | null;
    selectedProjectId: string | null;
  },
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) return;
  const workspacePaths = state.selectedGroupId
    ? state.projectGroups
        .find((group: ProjectGroup) => group.id === state.selectedGroupId)
        ?.projects
        .filter((project: Project) => isProjectGitActionable(project))
        .map((project: Project) => project.path)
        .filter((path: string) => path.trim().length > 0) ?? []
    : state.standaloneProjects
        .filter((project) => project.id === state.selectedProjectId && isProjectGitActionable(project))
        .map((project) => project.path)
        .filter((path) => path.trim().length > 0);
  if (workspacePaths.length === 0) return;
  await flushMacroMetadata({
    trigger: "project_switch",
    workspacePaths,
  });
};

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
  groupId: string | null;
  name: string;
  path: string;
  lastOpenedAt: string;
}

export interface ProjectAddOperation {
  requestId: string;
  status: "running" | "cancelling";
  path: string | null;
  startedAt: number;
  canCancel: boolean;
}

const MAX_REMEMBERED_PROJECTS = 50;
let projectSwitchRequestId = 0;
let architectPlanSwitchRequestId = 0;
let architectPlanCatalogRequestId = 0;
const architectPlanCatalogRequestIdsByKind = new Map<string, number>();
let selectedTaskPersistenceTimer: ReturnType<typeof setTimeout> | null = null;
let selectedTaskPersistenceQueue = Promise.resolve();
let lastQueuedTaskSelectionKey: string | null = null;

const scheduleSelectedTaskPersistence = (taskId: string | null): void => {
  if (!taskId) return;
  const task = useTaskStore.getState().getTaskById(taskId);
  if (!task) return;
  const state = useAppStore.getState();
  const taskProjectIds = Array.from(new Set([
    ...(task.project_ids ?? []),
    task.project_id,
  ].filter((value): value is string => Boolean(value))));
  const group = state.projectGroups.find((candidate) =>
    candidate.projects.some((project) => taskProjectIds.includes(project.id)),
  );
  const contextId = group?.id ?? taskProjectIds[0] ?? null;
  if (!contextId) return;
  const focusProjectId = taskProjectIds.find((projectId) =>
    group?.projects.some((project) => project.id === projectId),
  ) ?? taskProjectIds[0] ?? null;
  const persistenceKey = `${contextId}::${taskId}::${focusProjectId ?? 'none'}`;
  if (lastQueuedTaskSelectionKey === persistenceKey) return;
  lastQueuedTaskSelectionKey = persistenceKey;
  if (selectedTaskPersistenceTimer) clearTimeout(selectedTaskPersistenceTimer);
  selectedTaskPersistenceTimer = setTimeout(() => {
    selectedTaskPersistenceTimer = null;
    selectedTaskPersistenceQueue = selectedTaskPersistenceQueue.then(async () => {
      const current = await localProjectContext.getLocalProjectContextState(contextId);
      await localProjectContext.upsertLocalProjectContextState({
        projectId: contextId,
        groupId: group?.id ?? current?.groupId ?? null,
        focusProjectId: focusProjectId ?? current?.focusProjectId ?? null,
        lastPlanId: current?.lastPlanId ?? null,
        lastTaskId: taskId,
        architectConversationId: current?.architectConversationId ?? null,
        implementConversationId: current?.implementConversationId ?? null,
      });
    }).catch((error) => {
      lastQueuedTaskSelectionKey = null;
      devLogger.warn('[tasks] Failed to persist the selected task context.', error);
    });
  }, 120);
};
let activeArchitectPlanPersistenceQueue: Promise<void> = Promise.resolve();

const enqueueActiveArchitectPlanPersistence = (
  targetBranch: string,
  planId: string,
): Promise<void> => {
  const persistence = activeArchitectPlanPersistenceQueue.then(async () => {
    await persistActiveArchitectPlan(targetBranch, planId);
  });
  activeArchitectPlanPersistenceQueue = persistence.catch(() => undefined);
  return persistence;
};

export interface ArchitectPlanContext {
  id: string;
  slug?: string;
  title: string;
  label?: string;
  description: string;
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: ArchitectPlanGitFlowMetadata;
  status: string;
  targetBranch: string;
  targetBranchesByProjectId?: Record<string, string>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  hasMixedTargetBranches?: boolean;
}

export type ArchitectPlanSwitchStatus =
  | "idle"
  | "resolving"
  | "ready"
  | "error";

export interface ArchitectPlanSwitchState {
  requestId: number;
  targetPlanId: string | null;
  targetBranch: string | null;
  status: ArchitectPlanSwitchStatus;
  startedAt: number | null;
  summaryHint: ArchitectPlanSummary | null;
  errorMessage: string | null;
}

const idleArchitectPlanSwitchState = (): ArchitectPlanSwitchState => ({
  requestId: 0,
  targetPlanId: null,
  targetBranch: null,
  status: "idle",
  startedAt: null,
  summaryHint: null,
  errorMessage: null,
});

const buildArchitectPlanContext = (
  plan:
    | Pick<
        ArchitectPlanContext,
        | "id"
        | "slug"
        | "title"
        | "label"
        | "description"
        | "planKind"
        | "gitFlowPlan"
        | "status"
        | "targetBranch"
        | "targetBranchesByProjectId"
        | "executionModesByProjectId"
      >
    | Pick<
        ArchitectPlanSummary,
        | "id"
        | "slug"
        | "title"
        | "label"
        | "description"
        | "planKind"
        | "gitFlowPlan"
        | "status"
        | "targetBranch"
        | "targetBranchesByProjectId"
        | "executionModesByProjectId"
      >
): ArchitectPlanContext => ({
  id: plan.id,
  slug: plan.slug,
  title: plan.title,
  label: plan.label,
  description: plan.description,
  planKind: plan.planKind,
  gitFlowPlan: plan.gitFlowPlan,
  status: plan.status,
  targetBranch: plan.targetBranch,
  targetBranchesByProjectId: plan.targetBranchesByProjectId,
  executionModesByProjectId: plan.executionModesByProjectId,
  hasMixedTargetBranches:
    Boolean(plan.targetBranchesByProjectId) &&
    new Set(Object.values(plan.targetBranchesByProjectId || {})).size > 1,
});

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

const isLegacyPlaceholderWorkspacePath = (path?: string): boolean => {
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

const createProjectAddRequestId = (): string =>
  `project-add-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const persistSessionContext = async (input: {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  mode: AppMode;
}): Promise<void> => {
  await localProjectContext.upsertLocalSessionContextState(input);
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

const getAllProjectsFromRegistry = (registry: ProjectRegistry): Project[] => [
  ...registry.standaloneProjects,
  ...registry.projectGroups.flatMap((group) => group.projects),
];

const getProjectGroupIdFromRegistry = (
  registry: ProjectRegistry,
  projectId: string | null | undefined,
): string | null =>
  projectId
    ? registry.projectGroups.find((group) =>
        group.projects.some((project) => project.id === projectId),
      )?.id ?? null
    : null;

const findProjectInRegistry = (
  registry: ProjectRegistry,
  projectId: string | null | undefined,
): Project | null =>
  projectId
    ? getAllProjectsFromRegistry(registry).find((project) => project.id === projectId) ?? null
    : null;

const collectProjectRegistryIds = (registryInput: ProjectRegistry | ProjectGroup[]) => {
  const registry = Array.isArray(registryInput)
    ? { standaloneProjects: [], projectGroups: registryInput }
    : registryInput;
  return {
    validGroupIds: registry.projectGroups.map((group) => group.id),
    validProjectIds: getAllProjectsFromRegistry(registry).map((project) => project.id),
  };
};

const isSelectionOnlyProjectRegistryRepair = (
  report: ProjectRegistryRepairReport,
): boolean =>
  report.repaired &&
  report.duplicatePathsRemoved === 0 &&
  report.emptyGroupsRemoved === 0 &&
  report.removedSyntheticGroups === 0 &&
  report.removedSyntheticProjects === 0 &&
  report.removedGroupIds.length === 0 &&
  report.removedProjectIds.length === 0 &&
  Boolean(report.deadSelectedGroupId || report.deadSelectedProjectId);

const formatProjectRegistryRepairSummaryForUser = (
  report: ProjectRegistryRepairReport,
  options: { suppressSelectionOnly?: boolean } = {},
): string | null => {
  if (options.suppressSelectionOnly && isSelectionOnlyProjectRegistryRepair(report)) {
    return null;
  }
  return formatProjectRegistryRepairSummary(report);
};

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

const pendingBlankPlanConsolidationsByScopeKey = new Map<string, Promise<void>>();

const scheduleScopedBlankPlanConsolidation = (params: {
  branchName: string;
  scopedProjectIds: string[];
  reason: "activate" | "selector" | "scope_init";
}): void => {
  const scopedProjectIds = Array.from(
    new Set(
      params.scopedProjectIds
        .map((projectId) => projectId.trim())
        .filter((projectId) => projectId.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));
  if (scopedProjectIds.length === 0) {
    return;
  }

  const scopeKey = `${resolveTargetBranch(params.branchName)}::${scopedProjectIds.join(",")}`;
  if (pendingBlankPlanConsolidationsByScopeKey.has(scopeKey)) {
    return;
  }

  const startedAt = Date.now();
  const task = consolidateScopedBlankPlans({
    branchName: params.branchName,
    scopedProjectIds,
  })
    .then((result) => {
      devLogger.info(
        JSON.stringify({
          event: "architect_blank_plan_consolidated",
          at: new Date().toISOString(),
          branchName: resolveTargetBranch(params.branchName),
          scopedProjectIds,
          reason: params.reason,
          deletedPlanIds: result.deletedPlanIds,
          durationMs: Date.now() - startedAt,
        }),
      );
    })
    .catch((error) => {
      devLogger.info(
        JSON.stringify({
          event: "architect_blank_plan_consolidation_failed",
          at: new Date().toISOString(),
          branchName: resolveTargetBranch(params.branchName),
          scopedProjectIds,
          reason: params.reason,
          durationMs: Date.now() - startedAt,
          error: toServiceError(error).message,
        }),
      );
    })
    .finally(() => {
      pendingBlankPlanConsolidationsByScopeKey.delete(scopeKey);
    });

  pendingBlankPlanConsolidationsByScopeKey.set(scopeKey, task);
};

const reconcileProjectRegistryDependencies = async (params: {
  standaloneProjects: Project[];
  projectGroups: ProjectGroup[];
  selectedGroupId: string | null;
  selectedProjectId: string | null;
}): Promise<void> => {
  const { validGroupIds, validProjectIds } = collectProjectRegistryIds(
    { standaloneProjects: params.standaloneProjects, projectGroups: params.projectGroups },
  );
  await localProjectContext.reconcileLocalProjectRegistryState({
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

  await localProjectContext.upsertLocalProjectContextState({
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

  const context = await localProjectContext.getLocalProjectContextState(groupId);
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
    await useChatStore.getState().ensureConversationForCurrentMode();
  } else {
    useAppStore.setState({ selectedTaskId: null });
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
  requestId: number;
  activationPayload: ArchitectPlanActivationPayload;
}): Promise<void> => {
  const { activationPayload } = input;
  const rawPlan = activationPayload.plan;
  if (!rawPlan || rawPlan.status === "deleted") {
    return;
  }
  if (
    input.requestId > 0 &&
    !isCurrentArchitectPlanSwitchRequest({
      requestId: input.requestId,
      planId: rawPlan.id,
      targetBranch: activationPayload.targetBranch,
    })
  ) {
    return;
  }

  const currentState = useAppStore.getState();
  const registry = {
    standaloneProjects: currentState.standaloneProjects,
    projectGroups: currentState.projectGroups,
  };
  const scopedProjectIds = getScopedProjectIds(
    registry,
    currentState.selectedGroupId,
    currentState.selectedProjectId,
  );
  const plan = retargetPlanForExecution(rawPlan, {
    scopedProjectIds,
    knownProjectIds: collectKnownProjectIds(registry),
  });
  const reconciledActivationPayload =
    plan === rawPlan ? activationPayload : { ...activationPayload, plan };

  useAppStore.setState({
    activeArchitectPlanId: plan.id,
    activePlanContext: buildArchitectPlanContext(plan),
    architectPlanSwitch: {
      requestId: input.requestId,
      targetPlanId: plan.id,
      targetBranch: plan.targetBranch,
      status: "ready",
      startedAt: Date.now(),
      summaryHint: null,
      errorMessage: null,
    },
    planNodes: plan.nodes || [],
    predictedBranches: plan.predictedBranches || [],
    strategyMutationPreview: null,
    pendingArchitectPlanActivationPayload: reconciledActivationPayload,
  });

  const runtime = await readArchitectPlanRuntime({
    branchName: reconciledActivationPayload.targetBranch,
    planId: plan.id,
    projectIds: plan.projectIds,
    executionModesByProjectId: plan.executionModesByProjectId,
  });
  const persistedPreview = runtime?.strategyPreview ?? null;
  if (!persistedPreview) {
    return;
  }

  const currentRevision =
    typeof plan.revision === "number" && Number.isFinite(plan.revision)
      ? plan.revision
      : null;
  const isObsolete =
    persistedPreview.baseRevision !== null &&
    currentRevision !== null &&
    persistedPreview.baseRevision !== currentRevision;

  if (isObsolete) {
    await persistArchitectPlanStrategyPreview({
      branchName: reconciledActivationPayload.targetBranch,
      plan,
      preview: null,
    });
    return;
  }

  if (
    input.requestId > 0 &&
    !isCurrentArchitectPlanSwitchRequest({
      requestId: input.requestId,
      planId: plan.id,
      targetBranch: reconciledActivationPayload.targetBranch,
    })
  ) {
    return;
  }

  useAppStore.setState({ strategyMutationPreview: persistedPreview });
};

const clearActiveArchitectPlanInStore = (): void => {
  useAppStore.setState({
    activeArchitectPlanId: null,
    activePlanContext: null,
    architectPlanSwitch: idleArchitectPlanSwitchState(),
    pendingArchitectPlanActivationPayload: null,
    planNodes: [],
    predictedBranches: [],
    strategyMutationPreview: null,
  });
};

const beginArchitectPlanSwitchInStore = (input: {
  requestId: number;
  planId: string;
  targetBranch: string;
  summaryHint?: ArchitectPlanSummary | null;
}): void => {
  useAppStore.setState({
    activeArchitectPlanId: input.planId,
    activePlanContext: input.summaryHint
      ? buildArchitectPlanContext({
          ...input.summaryHint,
          targetBranch: input.summaryHint.targetBranch || input.targetBranch,
        })
      : {
          id: input.planId,
          title: input.planId,
          description: "",
          status: "draft",
          targetBranch: input.targetBranch,
        },
    architectPlanSwitch: {
      requestId: input.requestId,
      targetPlanId: input.planId,
      targetBranch: input.targetBranch,
      status: "resolving",
      startedAt: Date.now(),
      summaryHint: input.summaryHint ?? null,
      errorMessage: null,
    },
    pendingArchitectPlanActivationPayload: null,
    planNodes: [],
    predictedBranches: [],
    strategyMutationPreview: null,
  });
  useChatStore
    .getState()
    .beginArchitectPlanSwitch({ requestId: input.requestId });
};

const isCurrentArchitectPlanSwitchRequest = (input: {
  requestId: number;
  planId: string;
  targetBranch: string;
}): boolean => {
  const state = useAppStore.getState();
  const switchState = state.architectPlanSwitch;
  return (
    switchState.requestId === input.requestId &&
    switchState.targetPlanId === input.planId &&
    resolveTargetBranch(switchState.targetBranch) ===
      resolveTargetBranch(input.targetBranch)
  );
};

const activateArchitectPlanInStore = async (input: {
  planId: string;
  options?: ActivateArchitectPlanOptions;
}): Promise<Awaited<ReturnType<typeof getArchitectPlan>> | null> => {
  const appStore = useAppStore.getState();
  const targetBranch = resolveTargetBranch(
    input.options?.targetBranch ||
      appStore.activePlanContext?.targetBranch ||
      getGitFlowBaseBranch(),
  );

  const switchingArchitectPlan =
    appStore.mode === "Architect" &&
    (appStore.activeArchitectPlanId !== input.planId ||
      resolveTargetBranch(appStore.activePlanContext?.targetBranch) !==
        targetBranch);
  const requestId = switchingArchitectPlan
    ? ++architectPlanSwitchRequestId
    : appStore.architectPlanSwitch.requestId;
  if (switchingArchitectPlan) {
    beginArchitectPlanSwitchInStore({
      requestId,
      planId: input.planId,
      targetBranch,
      summaryHint: input.options?.planSummaryHint ?? null,
    });
  }

  if (input.options?.persistActiveSelection !== false) {
    void enqueueActiveArchitectPlanPersistence(targetBranch, input.planId).catch((error) => {
      if (
        !switchingArchitectPlan ||
        isCurrentArchitectPlanSwitchRequest({
          requestId,
          planId: input.planId,
          targetBranch,
        })
      ) {
        useAppStore.setState((state) => ({
          architectPlanSwitch: {
            ...state.architectPlanSwitch,
            status: 'error',
            errorMessage: toServiceError(error).message,
          },
        }));
      }
    });
  }

  const currentScopedProjectIds =
    input.options?.scopedProjectIdsHint ??
    getScopedProjectIds(
      {
        standaloneProjects: appStore.standaloneProjects,
        projectGroups: appStore.projectGroups,
      },
      appStore.selectedGroupId,
      appStore.selectedProjectId,
    );
  const activationScopedProjectIdsHint =
    currentScopedProjectIds.length > 0
      ? currentScopedProjectIds
      : input.options?.planSummaryHint
        ? getArchitectPlanVisibleProjectIds(input.options.planSummaryHint)
        : undefined;

  let activationPayload: ArchitectPlanActivationPayload | null;
  try {
    activationPayload = await getArchitectPlanActivationPayload(
      targetBranch,
      input.planId,
      {
        summaryHint: input.options?.planSummaryHint ?? null,
        scopedProjectIdsHint: activationScopedProjectIdsHint,
      }
    );
  } catch (error) {
    if (
      switchingArchitectPlan &&
      isCurrentArchitectPlanSwitchRequest({ requestId, planId: input.planId, targetBranch })
    ) {
      useAppStore.setState((state) => ({
        pendingArchitectPlanActivationPayload: null,
        architectPlanSwitch: {
          ...state.architectPlanSwitch,
          status: 'error',
          errorMessage: toServiceError(error).message,
        },
      }));
    }
    return null;
  }
  if (
    switchingArchitectPlan &&
    !isCurrentArchitectPlanSwitchRequest({
      requestId,
      planId: input.planId,
      targetBranch,
    })
  ) {
    return null;
  }
  const plan = activationPayload?.plan ?? null;
  if (!plan || plan.status === "deleted") {
    if (
      switchingArchitectPlan &&
      isCurrentArchitectPlanSwitchRequest({
        requestId,
        planId: input.planId,
        targetBranch,
      })
    ) {
      useAppStore.setState((state) => ({
        pendingArchitectPlanActivationPayload: null,
        architectPlanSwitch: {
          ...state.architectPlanSwitch,
          status: "error",
          errorMessage: `Plan not found: ${input.planId}`,
        },
      }));
    } else {
      useAppStore.setState({ pendingArchitectPlanActivationPayload: null });
    }
    return null;
  }

  if (input.options?.allowScopeSwitch !== false) {
    const latestAppState = useAppStore.getState();
    const planProjectId = resolvePlanProjectContextId(
      plan,
      latestAppState.selectedProjectId,
    );
    const scopedProjectIds = getScopedProjectIds(
      {
        standaloneProjects: latestAppState.standaloneProjects,
        projectGroups: latestAppState.projectGroups,
      },
      latestAppState.selectedGroupId,
      latestAppState.selectedProjectId,
    );
    const isPlanAlreadyInScope = isArchitectPlanVisibleForScope(
      plan,
      scopedProjectIds,
    );

    if (planProjectId && !isPlanAlreadyInScope) {
      await latestAppState.switchProjectContext(planProjectId, {
        restoreProjectContext: false,
        ensureAutoPlan: false,
      });
      if (
        switchingArchitectPlan &&
        !isCurrentArchitectPlanSwitchRequest({
          requestId,
          planId: input.planId,
          targetBranch,
        })
      ) {
        return null;
      }
    }
  }

  await hydrateArchitectPlanInStore({
    requestId,
    activationPayload:
      activationPayload ?? {
        plan,
        chatMessages: [],
        conversationId: plan.conversationId ?? null,
        sharedConversation: false,
        targetBranch,
        resolutionMode: 'full',
      },
  });
  const latestAppState = useAppStore.getState();
  if (input.options?.consolidateBlankPlans !== false) {
    scheduleScopedBlankPlanConsolidation({
      branchName: targetBranch,
      scopedProjectIds: getScopedProjectIds(
        {
          standaloneProjects: latestAppState.standaloneProjects,
          projectGroups: latestAppState.projectGroups,
        },
        latestAppState.selectedGroupId,
        latestAppState.selectedProjectId,
      ),
      reason: "activate",
    });
  }
  return plan;
};

const persistResolvedArchitectPlanContext = async (params: {
  contextId: string;
  groupId: string | null;
  focusProjectId: string | null;
  planId: string;
  localContext: LocalProjectContextState | null;
}): Promise<void> => {
  await localProjectContext.upsertLocalProjectContextState({
    projectId: params.contextId,
    groupId: params.groupId ?? params.localContext?.groupId ?? null,
    focusProjectId:
      params.focusProjectId ?? params.localContext?.focusProjectId ?? null,
    lastPlanId: params.planId,
    lastTaskId: params.localContext?.lastTaskId ?? null,
    architectConversationId:
      params.localContext?.architectConversationId ?? null,
    implementConversationId:
      params.localContext?.implementConversationId ?? null,
  });
};

const ensureAutoPlanForSelection = async (input: {
  groupId: string | null;
  projectId: string | null;
  requestId?: string;
}): Promise<void> => {
  if (!input.groupId && !input.projectId) {
    return;
  }

  const appState = useAppStore.getState();
  await useAppStore.getState().loadMacroProjectMetadataForSelection({
    hydrateActivePlan: appState.mode === "Architect",
    refreshTasks: true,
    reason: "auto_plan",
    requestId: input.requestId,
  });
  const latest = useAppStore.getState();
  if (latest.architectPlanCatalogStatus === "error") {
    throw new Error(
      latest.architectPlanCatalogError || "Architect metadata hydration failed.",
    );
  }
};

const POST_CREATE_HYDRATION_TIMEOUT_MS = 5_000;
let postCreateHydrationGeneration = 0;

const schedulePostCreateHydration = (input: {
  requestId: string;
  action: string;
  standaloneProjects: Project[];
  projectGroups: ProjectGroup[];
  groupId: string | null;
  projectId: string | null;
}): void => {
  const generation = ++postCreateHydrationGeneration;
  const isCurrentHydration = (): boolean => {
    const state = useAppStore.getState();
    return postCreateHydrationGeneration === generation &&
      state.selectedGroupId === input.groupId &&
      state.selectedProjectId === input.projectId;
  };
  const hydration = (async () => {
    await reconcileProjectRegistryDependencies({
      standaloneProjects: input.standaloneProjects,
      projectGroups: input.projectGroups,
      selectedGroupId: input.groupId,
      selectedProjectId: input.projectId,
    });
    const state = useAppStore.getState();
    if (state.projectSwitchPolicy === "resume_per_project" && input.groupId) {
      await restoreProjectContext(input.groupId, input.projectId);
    }
    await ensureAutoPlanForSelection({
      groupId: input.groupId,
      projectId: input.projectId,
      requestId: input.requestId,
    });
  })();

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Post-create hydration exceeded ${POST_CREATE_HYDRATION_TIMEOUT_MS} ms.`)),
      POST_CREATE_HYDRATION_TIMEOUT_MS,
    );
  });

  void Promise.race([hydration, timeout])
    .then(() => {
      logProjectRegistryAction("succeeded", {
        action: `${input.action}_post_create_hydration`,
        requestId: input.requestId,
      });
    })
    .catch((error) => {
      const normalized = toServiceError(error);
      if (isCurrentHydration()) {
        useAppStore.setState({
          architectPlanCatalogStatus: "error",
          architectPlanCatalogError: normalized.message,
        });
      }
      logProjectRegistryAction("failed", {
        action: `${input.action}_post_create_hydration`,
        requestId: input.requestId,
        error: normalized.message,
      });
    })
    .finally(() => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    });
};

const pruneLegacyPlaceholderWorkspaces = (groups: ProjectGroup[]): ProjectGroup[] => {
  return groups
    .map((group) => ({
      ...group,
      projects: group.projects.filter(
        (project) =>
          !isLegacyPlaceholderWorkspacePath(project.path) &&
          !isImplicitWorkspaceRootPath(project.path),
      ),
    }))
    .filter((group) => group.projects.length > 0);
};

const pruneLegacyPlaceholderStandaloneProjects = (projects: Project[]): Project[] =>
  projects.filter(
    (project) =>
      !isLegacyPlaceholderWorkspacePath(project.path) &&
      !isImplicitWorkspaceRootPath(project.path),
  );

const pruneLegacyRememberedProjects = (
  projects: RememberedProject[],
): RememberedProject[] =>
  projects.filter(
    (project) =>
      !isLegacyPlaceholderWorkspacePath(project.path) &&
      !isImplicitWorkspaceRootPath(project.path),
  );

interface AppStore {
  mode: AppMode;
  agentType: AgentType;
	  currentPlan: Plan | null;
	  standaloneProjects: Project[];
	  projectGroups: ProjectGroup[];
  selectedGroupId: string | null;
  selectedProjectId: string | null; // focused project for repo-specific panels/actions
  selectedTaskId: string | null;
  taskSortOption: TaskSortOption;
  isLoading: boolean;
  lastError: string | null;
  projectAddOperation: ProjectAddOperation | null;
  settingsOpen: boolean;
  activeSettingsTab: SettingsTab; // Added
  projectNavigatorOpen: boolean;
  projectModalOpen: boolean;
  projectModalGroupId: string | null;
  projectGitFlowModalProjectId: string | null;
  activeThemeId: string;
  leftPanelWidth: number;
  architectLeftPanelWidth: number;
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
  metadataMissingUpstreamPolicy: MetadataMissingUpstreamPolicy;
  inAppNotificationsEnabled: boolean;
  notificationChannelModes: NotificationChannelModes;
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
  architectPlanSwitch: ArchitectPlanSwitchState;
  pendingArchitectPlanActivationPayload: ArchitectPlanActivationPayload | null;
  architectPlanCatalogByBranch: Record<string, ArchitectPlanCatalogBranch>;
  architectPlanCatalogScopeKey: string | null;
  architectPlanCatalogScopedProjectIds: string[];
  architectPlanCatalogModernPlanCount: number;
  architectPlanCatalogVisiblePlanCount: number;
  visibleArchitectPlans: ArchitectPlanSummary[];
  architectPlanCatalogStatus: ArchitectPlanCatalogStatus;
  architectPlanCatalogError: string | null;
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  strategyMutationPreview: StrategyMutationPreview | null;
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
  createProjectGroup: (name: string, projectIds: string[]) => Promise<void>;
  moveProjectToGroup: (
    projectId: string,
    groupId: string | null,
  ) => Promise<void>;
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
    directEdit?: boolean,
  ) => Promise<void>;
  removeProjectGroup: (groupId: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  debugResetProject: (projectId: string) => Promise<{
    projectId: string;
    projectName: string;
    removedRegistryEntry: boolean;
    removedTaskWorktrees: number;
    removedMetadataWorktree: boolean;
    removedMacroBranch: boolean;
    warnings: string[];
  }>;
  getProjectById: (id: string) => Project | undefined;
  setEnabledModes: (modes: AppMode[]) => void;
  setUiZoomMode: (mode: UiZoomMode) => void;
  setUiZoomLevel: (level: number) => void;
  setCodeOverflowMode: (mode: CodeOverflowMode) => void;
  setProjectSwitchPolicy: (policy: ProjectSwitchPolicy) => Promise<void>;
  setMetadataAutoPush: (enabled: boolean) => void;
  setMetadataMissingUpstreamPolicy: (
    policy: MetadataMissingUpstreamPolicy,
  ) => void;
  setNotificationChannelMode: (
    category: NotificationCategory,
    mode: NotificationChannelMode,
  ) => void;
  setInAppNotificationsEnabled: (enabled: boolean) => void;
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
  setStrategyMutationPreview: (
    preview: StrategyMutationPreview | null,
  ) => void;
  consumeArchitectPlanActivationPayload: (params?: {
    planId?: string | null;
    targetBranch?: string | null;
  }) => ArchitectPlanActivationPayload | null;
  setActiveArchitectPlanId: (planId: string | null) => void;
  activateArchitectPlan: (
    planId: string,
    options?: ActivateArchitectPlanOptions,
  ) => Promise<boolean>;
  loadMacroProjectMetadataForSelection: (options?: {
    hydrateActivePlan?: boolean;
    refreshTasks?: boolean;
    includeArchivedInVisible?: boolean;
    reason?: "boot" | "project_switch" | "selector" | "auto_plan" | "manual";
    requestId?: string;
  }) => Promise<MacroProjectMetadataLoadResult | null>;
  setActivePlanContext: (plan: ArchitectPlanContext | null) => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  openProjectNavigator: () => void;
  closeProjectNavigator: () => void;
  openProjectModal: (groupId?: string | null) => void;
  closeProjectModal: () => void;
  openProjectGitFlowModal: (projectId: string) => void;
  closeProjectGitFlowModal: () => void;
  createProject: (data: CreateProjectData) => Promise<Project>;
  createProjectWithGitSetup: (
    data: CreateProjectData & {
      path: string;
      gitSetupActions: ProjectGitSetupAction[];
      expectedRepoRootPath?: string | null;
      expectedSetupState: ProjectGitSetupState;
      expectedRecommendedActionSequence: ProjectGitSetupAction[];
    },
  ) => Promise<ProjectGitSetupCommitResult>;
  createNewProjectRepo: (
    data: CreateNewProjectRepoData,
  ) => Promise<ProjectGitSetupCommitResult>;
  cancelProjectAddOperation: (requestId: string) => Promise<void>;
  refreshProjectRegistry: () => Promise<void>;
  setLeftPanelWidth: (width: number) => void;
  setArchitectLeftPanelWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  initialize: () => Promise<void>;
  initializeCritical: () => Promise<void>;
  resumeAfterInitialize: () => Promise<void>;
}

interface CreateProjectData {
  name: string;
  description: string;
  groupId: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: ProjectGitFlowSettings;
  directEdit?: boolean;
  requestId?: string | null;
}

interface CreateNewProjectRepoData {
  repoName: string;
  parentPath: string;
  folderName: string;
  groupId: string | null;
  groupName?: string | null;
  gitFlowSettings?: ProjectGitFlowSettings;
  requestId?: string | null;
}

interface SwitchProjectContextOptions {
  restoreProjectContext?: boolean;
  ensureAutoPlan?: boolean;
}

interface ActivateArchitectPlanOptions {
  targetBranch?: string | null;
  persistActiveSelection?: boolean;
  allowScopeSwitch?: boolean;
  consolidateBlankPlans?: boolean;
  planSummaryHint?: ArchitectPlanSummary | null;
  scopedProjectIdsHint?: string[];
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
  const { standaloneProjects, projectGroups, plan, planNodes, predictedBranches } =
    await services.getAppBootstrap();

  return {
    plan,
    planNodes: planNodes ?? [],
    predictedBranches: predictedBranches ?? [],
    normalizedRegistry: normalizeProjectRegistry({
      projectGroups,
      standaloneProjects: standaloneProjects ?? [],
      selectedGroupId: params.selectedGroupId,
      selectedProjectId: params.selectedProjectId,
    }),
  };
};

const collectArchitectBranchCandidatesForScope = (params: {
  registry: ProjectRegistry;
  scopedProjectIds: string[];
  activePlanContext: ArchitectPlanContext | null;
}): string[] => {
  const scopedProjectIdSet = new Set(params.scopedProjectIds);
  const scopedProjects = getAllProjectsFromRegistry(params.registry).filter(
    (project) => scopedProjectIdSet.has(project.id),
  );
  return [
    params.activePlanContext?.targetBranch,
    ...(params.activePlanContext?.targetBranchesByProjectId
      ? Object.values(params.activePlanContext.targetBranchesByProjectId)
      : []),
    ...scopedProjects.flatMap((project) => [
      project.gitFlowSettings?.baseBranch,
      project.gitFlowSettings?.mainBranch,
    ]),
  ].filter(
    (branchName): branchName is string =>
      typeof branchName === "string" && branchName.trim().length > 0,
  );
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

const INITIAL_NOTIFICATION_CHANNEL_MODES: NotificationChannelModes = {
  task_attention_required: "both",
  task_run_completed: "desktop",
  task_completed: "both",
  git_sync_completed: "desktop",
  git_sync_attention_required: "both",
};

export const useAppStore = create<AppStore>((set, get) => ({
  mode: "Implement",
  agentType: "build",
	  currentPlan: null,
	  standaloneProjects: [],
	  projectGroups: [],
  selectedGroupId: null,
  selectedProjectId: null,
  selectedTaskId: null,
  taskSortOption: "date",
  isLoading: false,
  lastError: null,
  projectAddOperation: null,
  settingsOpen: false,
  activeSettingsTab: "general",
  projectNavigatorOpen: false,
  projectModalOpen: false,
  projectModalGroupId: null,
  projectGitFlowModalProjectId: null,
  activeThemeId: "macro-dark",
  leftPanelWidth: 280,
  architectLeftPanelWidth: 320,
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
  metadataMissingUpstreamPolicy: "ask",
  inAppNotificationsEnabled: true,
  notificationChannelModes: INITIAL_NOTIFICATION_CHANNEL_MODES,
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
  architectPlanSwitch: idleArchitectPlanSwitchState(),
  pendingArchitectPlanActivationPayload: null,
  architectPlanCatalogByBranch: {},
  architectPlanCatalogScopeKey: null,
  architectPlanCatalogScopedProjectIds: [],
  architectPlanCatalogModernPlanCount: 0,
  architectPlanCatalogVisiblePlanCount: 0,
  visibleArchitectPlans: [],
  architectPlanCatalogStatus: "idle",
  architectPlanCatalogError: null,
  planNodes: [],
  predictedBranches: [],
  strategyMutationPreview: null,

  setMode: (mode) => {
    const previousMode = get().mode;
    set({ mode });
    void savePreference(PREF_KEYS.LAST_ACTIVE_MODE, mode);
    const { selectedGroupId, selectedProjectId } = get();
    void persistSessionContext({
      selectedGroupId,
      selectedProjectId,
      mode,
    });
    if (mode === "Architect" && previousMode !== "Architect") {
      void ensureAutoPlanForSelection({
        groupId: selectedGroupId,
        projectId: selectedProjectId,
      });
    }
  },
  setAgentType: (agentType) => {
    set({ agentType });
    void savePreference(PREF_KEYS.AGENT_TYPE, agentType);
  },
  setTheme: (themeId) => {
    set({ activeThemeId: themeId });
    void savePreference(PREF_KEYS.THEME, themeId);
  },

  setCurrentPlan: (plan) => set({ currentPlan: plan }),

  setProjectGroups: (groups) =>
    set((state) => {
	      const normalized = normalizeProjectRegistry({
	        standaloneProjects: state.standaloneProjects,
	        projectGroups: groups,
        selectedGroupId: state.selectedGroupId,
        selectedProjectId: state.selectedProjectId,
      });
      return {
	        projectGroups: normalized.projectGroups,
	        standaloneProjects: normalized.standaloneProjects,
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
      activeArchitectPlanId: null,
      activePlanContext: null,
      architectPlanSwitch: idleArchitectPlanSwitchState(),
      pendingArchitectPlanActivationPayload: null,
      planNodes: [],
      predictedBranches: [],
      strategyMutationPreview: null,
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
    const normalized: ProjectSwitchPolicy =
      policy === "reset_on_switch" ? policy : "resume_per_project";
    set({ projectSwitchPolicy: normalized });
    await localProjectContext.setProjectSwitchPolicy(normalized);
  },

  setMetadataAutoPush: (enabled) => {
    set({ metadataAutoPush: enabled });
    void savePreference(PREF_KEYS.METADATA_AUTO_PUSH, enabled);
  },

  setMetadataMissingUpstreamPolicy: (policy) => {
    const normalized: MetadataMissingUpstreamPolicy =
      policy === "ignore" ? "ignore" : "ask";
    set({ metadataMissingUpstreamPolicy: normalized });
    void savePreference(PREF_KEYS.METADATA_MISSING_UPSTREAM_POLICY, normalized);
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

  setInAppNotificationsEnabled: (enabled) => {
    set({ inAppNotificationsEnabled: enabled });
    void savePreference(PREF_KEYS.IN_APP_NOTIFICATIONS_ENABLED, enabled);
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
      if (
        previous.selectedGroupId !== nextGroupId ||
        previous.selectedProjectId !== nextProjectId
      ) {
        try {
          await flushMacroMetadataForProjectGroupSwitch(previous);
        } catch (error) {
          devLogger.warn(
            JSON.stringify({
              event: "macro_metadata_flush_before_project_switch_failed",
              at: new Date().toISOString(),
              error: toServiceError(error).message,
            }),
          );
        }
      }

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
	        selectedProject
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
        activeArchitectPlanId: null,
        activePlanContext: null,
        architectPlanSwitch: idleArchitectPlanSwitchState(),
        pendingArchitectPlanActivationPayload: null,
        planNodes: [],
        predictedBranches: [],
        strategyMutationPreview: null,
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

  setSelectedTask: (taskId) => {
    set({ selectedTaskId: taskId });
    scheduleSelectedTaskPersistence(taskId);
  },

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

  setStrategyMutationPreview: (preview) =>
    set({ strategyMutationPreview: preview }),

  consumeArchitectPlanActivationPayload: (params) => {
    const state = get();
    const payload = state.pendingArchitectPlanActivationPayload;
    if (!payload) {
      return null;
    }

    if (params?.planId && payload.plan.id !== params.planId) {
      return null;
    }

    if (
      params?.targetBranch &&
      resolveTargetBranch(payload.targetBranch) !==
        resolveTargetBranch(params.targetBranch)
    ) {
      return null;
    }

    set({ pendingArchitectPlanActivationPayload: null });
    return payload;
  },

  setActiveArchitectPlanId: (planId) =>
    set({
      activeArchitectPlanId: planId,
      architectPlanSwitch: idleArchitectPlanSwitchState(),
      pendingArchitectPlanActivationPayload: null,
    }),

  activateArchitectPlan: async (planId, options) => {
    const plan = await activateArchitectPlanInStore({
      planId,
      options,
    });
    return Boolean(plan);
  },

  loadMacroProjectMetadataForSelection: async (options = {}) => {
    const requestId = ++architectPlanCatalogRequestId;
    const state = get();
    const registry = {
      standaloneProjects: state.standaloneProjects,
      projectGroups: state.projectGroups,
    };
    const scopedProjectIds = getScopedProjectIds(
      registry,
      state.selectedGroupId,
      state.selectedProjectId,
    );
    const contextId = state.selectedGroupId || state.selectedProjectId;
    const catalogScopeKey = buildArchitectPlanCatalogScopeKey({
      selectedGroupId: state.selectedGroupId,
      selectedProjectId: state.selectedProjectId,
      scopedProjectIds,
    });
    const requestKind = `${catalogScopeKey}::${options.hydrateActivePlan !== false ? 'hydrate' : 'catalog'}`;
    architectPlanCatalogRequestIdsByKind.set(requestKind, requestId);
    const isCurrentScope = () => {
      if (architectPlanCatalogRequestIdsByKind.get(requestKind) !== requestId) return false;
      const latest = get();
      return buildArchitectPlanCatalogScopeKey({
        selectedGroupId: latest.selectedGroupId,
        selectedProjectId: latest.selectedProjectId,
        scopedProjectIds: getScopedProjectIds(
          { standaloneProjects: latest.standaloneProjects, projectGroups: latest.projectGroups },
          latest.selectedGroupId,
          latest.selectedProjectId,
        ),
      }) === catalogScopeKey;
    };

    if (!contextId || scopedProjectIds.length === 0) {
      if (options.hydrateActivePlan !== false) {
        clearActiveArchitectPlanInStore();
      }
      set({
        architectPlanCatalogByBranch: {},
        architectPlanCatalogScopeKey: catalogScopeKey,
        architectPlanCatalogScopedProjectIds: scopedProjectIds,
        architectPlanCatalogModernPlanCount: 0,
        architectPlanCatalogVisiblePlanCount: 0,
        visibleArchitectPlans: [],
        architectPlanCatalogStatus: "ready",
        architectPlanCatalogError: null,
      });
      if (options.refreshTasks) {
        await useTaskStore.getState().refreshFromPlan();
      }
      return null;
    }

    set({
      architectPlanCatalogStatus: "loading",
      architectPlanCatalogError: null,
      architectPlanCatalogScopeKey: catalogScopeKey,
      architectPlanCatalogScopedProjectIds: scopedProjectIds,
      architectPlanCatalogModernPlanCount: 0,
      architectPlanCatalogVisiblePlanCount: 0,
    });

    try {
      const localContext =
        await localProjectContext.getLocalProjectContextState(contextId);
      const result = await loadMacroProjectMetadataCatalog({
        requestId: options.requestId,
        scopedProjectIds,
        selectedGroupId: state.selectedGroupId,
        selectedProjectId: state.selectedProjectId,
        rememberedPlanId: localContext?.lastPlanId ?? null,
        currentActivePlanId: state.activeArchitectPlanId,
        currentTargetBranch: state.activePlanContext?.targetBranch ?? null,
        candidateBranches: collectArchitectBranchCandidatesForScope({
          registry,
          scopedProjectIds,
          activePlanContext: state.activePlanContext,
        }),
        includeArchivedInVisible: options.includeArchivedInVisible === true,
      });
      if (!isCurrentScope()) return null;
      const catalogModernPlanCount = result.snapshot.branches.reduce(
        (count, branch) =>
          count + branch.plans.filter((plan) => plan.status !== "deleted").length,
        0,
      );

      set({
        architectPlanCatalogByBranch: result.snapshot.branchCatalogByBranch,
        architectPlanCatalogScopeKey: catalogScopeKey,
        architectPlanCatalogScopedProjectIds: result.snapshot.scopedProjectIds,
        architectPlanCatalogModernPlanCount: catalogModernPlanCount,
        architectPlanCatalogVisiblePlanCount: result.snapshot.visiblePlans.length,
        visibleArchitectPlans: result.snapshot.visiblePlans,
        architectPlanCatalogStatus: "ready",
        architectPlanCatalogError: null,
      });

      if (options.hydrateActivePlan !== false) {
        if (result.selectedPlan && result.selectedBranchName) {
          const activatedPlan = await activateArchitectPlanInStore({
            planId: result.selectedPlan.id,
            options: {
              targetBranch: result.selectedBranchName,
              persistActiveSelection: false,
              allowScopeSwitch: false,
              consolidateBlankPlans: false,
              planSummaryHint: result.selectedPlan,
              scopedProjectIdsHint: scopedProjectIds,
            },
          });
          if (!isCurrentScope()) return null;
          if (activatedPlan) {
            await persistResolvedArchitectPlanContext({
              contextId,
              groupId: state.selectedGroupId,
              focusProjectId: state.selectedProjectId,
              planId: activatedPlan.id,
              localContext,
            });
          } else {
            clearActiveArchitectPlanInStore();
          }
        } else {
          clearActiveArchitectPlanInStore();
        }
      }

      if (options.refreshTasks) {
        await useTaskStore.getState().refreshFromPlan();
      }

      devLogger.info(
        JSON.stringify({
          event: "architect_metadata_selection_loaded",
          at: new Date().toISOString(),
          reason: options.reason ?? "manual",
          requestId: options.requestId ?? null,
          selectedGroupId: state.selectedGroupId,
          selectedProjectId: state.selectedProjectId,
          scopedProjectIds,
          scannedBranchNames: result.snapshot.scannedBranchNames,
          scannedBranchCount: result.snapshot.scannedBranchNames.length,
          planCount: catalogModernPlanCount,
          visiblePlanCount: result.snapshot.visiblePlans.length,
          visiblePlanIds: result.snapshot.visiblePlans.map((plan) => plan.id),
          selectedPlanId: result.selectedPlan?.id ?? null,
          selectionReason: result.selectionReason,
        }),
      );

      return result;
    } catch (error) {
      if (!isCurrentScope()) return null;
      const normalized = toServiceError(error);
      set({
        architectPlanCatalogStatus: "error",
        architectPlanCatalogError: normalized.message,
      });
      devLogger.warn(
        JSON.stringify({
          event: "architect_metadata_selection_load_failed",
          at: new Date().toISOString(),
          reason: options.reason ?? "manual",
          requestId: options.requestId ?? null,
          error: normalized.message,
        }),
      );
      return null;
    }
  },

  setActivePlanContext: (plan) =>
    set({
      activePlanContext: plan,
      architectPlanSwitch: idleArchitectPlanSwitchState(),
      pendingArchitectPlanActivationPayload: null,
    }),

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
          preflightSnapshot.normalizedRegistry,
          previousState.recentProjects,
        );
        const nextMacroEnabledProjects = reconcileRememberedProjects(
          preflightSnapshot.normalizedRegistry,
          previousState.macroEnabledProjects,
        );
        const { validProjectIds } = collectProjectRegistryIds(
          preflightSnapshot.normalizedRegistry,
          );
        const missingMessage =
          "Project group no longer exists in Macro. The registry was refreshed.";

        set({
          currentPlan: preflightSnapshot.plan,
          standaloneProjects: preflightSnapshot.normalizedRegistry.standaloneProjects,
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
          standaloneProjects: preflightSnapshot.normalizedRegistry.standaloneProjects,
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
        normalizedRegistry,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: postMutationSnapshot.plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
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
        standaloneProjects: normalizedRegistry.standaloneProjects,
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

  createProjectGroup: async (name, projectIds) => {
    const trimmedName = name.trim();
    const uniqueProjectIds = Array.from(
      new Set(projectIds.map((projectId) => projectId.trim()).filter(Boolean)),
    );
    if (!trimmedName || uniqueProjectIds.length < 2) {
      return;
    }

    set({ isLoading: true, lastError: null });
    try {
      await services.createProjectGroup({
        name: trimmedName,
        projectIds: uniqueProjectIds,
      });
      await get().refreshProjectRegistry();
      logProjectRegistryAction("succeeded", {
        action: "create_group",
        projectCount: uniqueProjectIds.length,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "create_group",
        projectCount: uniqueProjectIds.length,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      throw normalized;
    }
  },

  moveProjectToGroup: async (projectId, groupId) => {
    set({ isLoading: true, lastError: null });
    try {
      await services.moveProjectToGroup({ projectId, groupId });
      await get().refreshProjectRegistry();
      logProjectRegistryAction("succeeded", {
        action: "move_project_to_group",
        projectId,
        groupId,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "move_project_to_group",
        projectId,
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
        preflightSnapshot.normalizedRegistry,
        requestedProject,
      );

      if (!canonicalProject) {
        const nextRecentProjects = reconcileRememberedProjects(
          preflightSnapshot.normalizedRegistry,
          previousState.recentProjects,
        );
        const nextMacroEnabledProjects = reconcileRememberedProjects(
          preflightSnapshot.normalizedRegistry,
          previousState.macroEnabledProjects,
        );
        const { validProjectIds } = collectProjectRegistryIds(
          preflightSnapshot.normalizedRegistry,
          );
        const missingMessage =
          "Project no longer exists in Macro. The registry was refreshed.";

        set({
          currentPlan: preflightSnapshot.plan,
          standaloneProjects: preflightSnapshot.normalizedRegistry.standaloneProjects,
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
          standaloneProjects: preflightSnapshot.normalizedRegistry.standaloneProjects,
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
        normalizedRegistry,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: postMutationSnapshot.plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
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
        standaloneProjects: normalizedRegistry.standaloneProjects,
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
        preflightSnapshot.normalizedRegistry,
        requestedProject,
      );

      if (!canonicalProject) {
        throw {
          code: "PROJECT_NOT_FOUND",
          message: "Project no longer exists in Macro.",
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
        normalizedRegistry,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: postMutationSnapshot.plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
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
        standaloneProjects: normalizedRegistry.standaloneProjects,
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
    directEdit,
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
        preflightSnapshot.normalizedRegistry,
        requestedProject,
      );

      if (!canonicalProject) {
        throw {
          code: "PROJECT_NOT_FOUND",
          message: "Project no longer exists in Macro.",
        };
      }

      await services.updateProjectAccess({
        projectId: canonicalProject.id,
        userReadOnly,
        directEdit,
        confirmedMigration,
      });

      const postMutationSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const normalizedRegistry = postMutationSnapshot.normalizedRegistry;
      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: postMutationSnapshot.plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
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
        standaloneProjects: normalizedRegistry.standaloneProjects,
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
          normalizedRegistry,
          previousState.recentProjects.filter(
            (project) => !removedProjectIds.has(project.projectId),
          ),
        );
        const nextMacroEnabledProjects = reconcileRememberedProjects(
          normalizedRegistry,
          previousState.macroEnabledProjects.filter(
            (project) => !removedProjectIds.has(project.projectId),
          ),
        );
        const { validProjectIds } = collectProjectRegistryIds(
          normalizedRegistry,
          );

        set({
          currentPlan: preflightSnapshot.plan,
          standaloneProjects: normalizedRegistry.standaloneProjects,
          projectGroups: normalizedRegistry.projectGroups,
          selectedGroupId: normalizedRegistry.selectedGroupId,
          selectedProjectId: normalizedRegistry.selectedProjectId,
          selectedTaskId: didRemoveActiveGroup
            ? null
            : previousState.selectedTaskId,
          activeArchitectPlanId: didRemoveActiveGroup
            ? null
            : previousState.activeArchitectPlanId,
          architectPlanSwitch: didRemoveActiveGroup
            ? idleArchitectPlanSwitchState()
            : previousState.architectPlanSwitch,
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

        const nextFocusedProject = findProjectInRegistry(
          normalizedRegistry,
          normalizedRegistry.selectedProjectId,
        );
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
          standaloneProjects: normalizedRegistry.standaloneProjects,
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
        normalizedRegistry,
        previousState.recentProjects.filter(
          (project) => !removedProjectIds.has(project.projectId),
        ),
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.macroEnabledProjects.filter(
          (project) => !removedProjectIds.has(project.projectId),
        ),
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: postMutationSnapshot.plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        selectedTaskId: didRemoveActiveGroup
          ? null
          : previousState.selectedTaskId,
        activeArchitectPlanId: didRemoveActiveGroup
          ? null
          : previousState.activeArchitectPlanId,
        architectPlanSwitch: didRemoveActiveGroup
          ? idleArchitectPlanSwitchState()
          : previousState.architectPlanSwitch,
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

      const nextFocusedProject = findProjectInRegistry(
          normalizedRegistry,
          normalizedRegistry.selectedProjectId,
        );
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
        standaloneProjects: normalizedRegistry.standaloneProjects,
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
        preflightSnapshot.normalizedRegistry,
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
          normalizedRegistry,
          previousState.recentProjects.filter(
            (project) => project.projectId !== projectId,
          ),
        );
        const nextMacroEnabledProjects = reconcileRememberedProjects(
          normalizedRegistry,
          previousState.macroEnabledProjects.filter(
            (project) => project.projectId !== projectId,
          ),
        );
        const { validProjectIds } = collectProjectRegistryIds(
          normalizedRegistry,
          );

        set({
          currentPlan: preflightSnapshot.plan,
          standaloneProjects: normalizedRegistry.standaloneProjects,
          projectGroups: normalizedRegistry.projectGroups,
          selectedGroupId: normalizedRegistry.selectedGroupId,
          selectedProjectId: normalizedRegistry.selectedProjectId,
          selectedTaskId: didRemoveProjectInActiveGroup
            ? null
            : previousState.selectedTaskId,
          activeArchitectPlanId: didRemoveProjectInActiveGroup
            ? null
            : previousState.activeArchitectPlanId,
          architectPlanSwitch: didRemoveProjectInActiveGroup
            ? idleArchitectPlanSwitchState()
            : previousState.architectPlanSwitch,
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

        const nextFocusedProject = findProjectInRegistry(
          normalizedRegistry,
          normalizedRegistry.selectedProjectId,
        );
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
        await localProjectContext.deleteLocalProjectContextState(projectId);
        await reconcileProjectRegistryDependencies({
          standaloneProjects: normalizedRegistry.standaloneProjects,
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
        normalizedRegistry,
        previousState.recentProjects.filter(
          (project) => project.projectId !== canonicalProject.id,
        ),
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.macroEnabledProjects.filter(
          (project) => project.projectId !== canonicalProject.id,
        ),
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: postMutationSnapshot.plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        selectedTaskId: didRemoveProjectInActiveGroup
          ? null
          : previousState.selectedTaskId,
        activeArchitectPlanId: didRemoveProjectInActiveGroup
          ? null
          : previousState.activeArchitectPlanId,
        architectPlanSwitch: didRemoveProjectInActiveGroup
          ? idleArchitectPlanSwitchState()
          : previousState.architectPlanSwitch,
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

      const nextFocusedProject = findProjectInRegistry(
          normalizedRegistry,
          normalizedRegistry.selectedProjectId,
        );
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
      await localProjectContext.deleteLocalProjectContextState(canonicalProject.id);
      await reconcileProjectRegistryDependencies({
        standaloneProjects: normalizedRegistry.standaloneProjects,
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

  debugResetProject: async (projectId) => {
    set({ isLoading: true, lastError: null });
    try {
      const previousState = get();
      const resetProject = previousState.getProjectById(projectId) ?? null;
      logProjectRegistryAction("started", {
        action: "debug_reset_project",
        projectId,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const preflightSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: previousState.selectedGroupId,
        selectedProjectId: previousState.selectedProjectId,
      });
      const canonicalProject = resolveCanonicalProject(
        preflightSnapshot.normalizedRegistry,
        resetProject,
      );

      if (!canonicalProject) {
        throw {
          code: "PROJECT_NOT_FOUND",
          message: "Project no longer exists in Macro.",
        };
      }

      const canonicalProjectGroupId =
        getProjectGroupByProjectId(
          preflightSnapshot.normalizedRegistry.projectGroups,
          canonicalProject.id,
        )?.id ?? null;
      const registryAfterReset = preflightSnapshot.normalizedRegistry.projectGroups
        .map((group) => ({
          ...group,
          projects: group.projects.filter(
            (project) => project.id !== canonicalProject.id,
          ),
        }))
        .filter((group) => group.projects.length > 0);
      const allProjectsAfterReset = registryAfterReset.flatMap(
        (group) => group.projects,
      );
      const previousSelectedProjectStillValid = Boolean(
        previousState.selectedProjectId &&
          allProjectsAfterReset.some(
            (project) => project.id === previousState.selectedProjectId,
          ),
      );
      const previousSelectedGroupStillValid = Boolean(
        previousState.selectedGroupId &&
          registryAfterReset.some(
            (group) => group.id === previousState.selectedGroupId,
          ),
      );
      const sameGroupFallbackProject = canonicalProjectGroupId
        ? (registryAfterReset
            .find((group) => group.id === canonicalProjectGroupId)
            ?.projects[0] ?? null)
        : null;
      const firstFallbackGroup = registryAfterReset[0] ?? null;
      const firstFallbackProject = firstFallbackGroup?.projects[0] ?? null;
      const nextSelection =
        previousSelectedProjectStillValid && previousState.selectedProjectId
          ? {
              selectedGroupId:
                getProjectGroupByProjectId(
                  registryAfterReset,
                  previousState.selectedProjectId,
                )?.id ?? previousState.selectedGroupId,
              selectedProjectId: previousState.selectedProjectId,
            }
          : previousSelectedGroupStillValid &&
              previousState.selectedProjectId !== canonicalProject.id
            ? {
                selectedGroupId: previousState.selectedGroupId,
                selectedProjectId: null,
              }
            : sameGroupFallbackProject
              ? {
                  selectedGroupId: canonicalProjectGroupId,
                  selectedProjectId: sameGroupFallbackProject.id,
                }
              : firstFallbackProject
                ? {
                    selectedGroupId: firstFallbackGroup?.id ?? null,
                    selectedProjectId: firstFallbackProject.id,
                  }
                : {
                    selectedGroupId: null,
                    selectedProjectId: null,
                  };

      const resetReport = await services.debugResetProject({
        projectId: canonicalProject.id,
        force: true,
      });
      const postMutationSnapshot = await loadProjectRegistrySnapshot({
        selectedGroupId: nextSelection.selectedGroupId,
        selectedProjectId: nextSelection.selectedProjectId,
      });
      const normalizedRegistry = postMutationSnapshot.normalizedRegistry;
      const didResetProjectInActiveGroup =
        canonicalProjectGroupId === previousState.selectedGroupId;
      const nextRecentProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.recentProjects.filter(
          (project) => project.projectId !== canonicalProject.id,
        ),
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.macroEnabledProjects.filter(
          (project) => project.projectId !== canonicalProject.id,
        ),
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: postMutationSnapshot.plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        selectedTaskId: didResetProjectInActiveGroup
          ? null
          : previousState.selectedTaskId,
        activeArchitectPlanId: didResetProjectInActiveGroup
          ? null
          : previousState.activeArchitectPlanId,
        architectPlanSwitch: didResetProjectInActiveGroup
          ? idleArchitectPlanSwitchState()
          : previousState.architectPlanSwitch,
        activePlanContext: didResetProjectInActiveGroup
          ? null
          : previousState.activePlanContext,
        planNodes: didResetProjectInActiveGroup
          ? []
          : filterPlanNodesForRegistry(
              postMutationSnapshot.planNodes.length
                ? postMutationSnapshot.planNodes
                : derivePlanNodesFromPlan(postMutationSnapshot.plan),
              validProjectIds,
            ),
        predictedBranches: didResetProjectInActiveGroup
          ? []
          : filterPredictedBranchesForRegistry(
              postMutationSnapshot.predictedBranches,
              validProjectIds,
            ),
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        projectRegistryRepairSummary: formatProjectRegistryRepairSummaryForUser(
          normalizedRegistry.report,
          { suppressSelectionOnly: true },
        ),
        isLoading: false,
        lastError: null,
      });

      const nextFocusedProject = findProjectInRegistry(
          normalizedRegistry,
          normalizedRegistry.selectedProjectId,
        );
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
      await localProjectContext.deleteLocalProjectContextState(canonicalProject.id);
      await persistSessionContext({
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
        mode: previousState.mode,
      });
      await reconcileProjectRegistryDependencies({
        standaloneProjects: normalizedRegistry.standaloneProjects,
        projectGroups: normalizedRegistry.projectGroups,
        selectedGroupId: normalizedRegistry.selectedGroupId,
        selectedProjectId: normalizedRegistry.selectedProjectId,
      });

      logProjectRegistryAction("succeeded", {
        action: "debug_reset_project",
        projectId: canonicalProject.id,
        requestedProjectId: projectId,
        canonicalized: canonicalProject.id !== projectId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        removedTaskWorktrees: resetReport.removedTaskWorktrees,
        removedMetadataWorktree: resetReport.removedMetadataWorktree,
        removedMacroBranch: resetReport.removedMacroBranch,
        warningCount: resetReport.warnings.length,
        repairApplied: normalizedRegistry.report.repaired,
      });
      return resetReport;
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "debug_reset_project",
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
        preflightSnapshot.normalizedRegistry,
        requestedProject,
      );

      if (!canonicalProject) {
        throw {
          code: "PROJECT_NOT_FOUND",
          message: "Project no longer exists in Macro.",
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
        normalizedRegistry,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: postMutationSnapshot.plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
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
        standaloneProjects: normalizedRegistry.standaloneProjects,
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

  openProjectNavigator: () => set({ projectNavigatorOpen: true }),
  closeProjectNavigator: () => set({ projectNavigatorOpen: false }),

  openProjectModal: (groupId = null) =>
    set({ projectModalOpen: true, projectModalGroupId: groupId }),

  closeProjectModal: () =>
    set({ projectModalOpen: false, projectModalGroupId: null }),

  openProjectGitFlowModal: (projectId) =>
    set({ projectGitFlowModalProjectId: projectId }),

  closeProjectGitFlowModal: () => set({ projectGitFlowModalProjectId: null }),

  cancelProjectAddOperation: async (requestId) => {
    const operation = get().projectAddOperation;
    if (!operation || operation.requestId !== requestId) {
      return;
    }
    set({
      projectAddOperation: {
        ...operation,
        status: "cancelling",
      },
    });
    try {
      await services.cancelProjectOperation(requestId);
    } finally {
      const current = get().projectAddOperation;
      if (current?.requestId === requestId) {
        set({ projectAddOperation: null, isLoading: false });
      }
    }
  },

  createProject: async (data: CreateProjectData) => {
    const requestId = data.requestId || createProjectAddRequestId();
    set({
      isLoading: true,
      lastError: null,
      projectAddOperation: {
        requestId,
        status: "running",
        path: data.path ?? null,
        startedAt: Date.now(),
        canCancel: true,
      },
    });
    try {
      const previousState = get();
      const gitFlowSettings =
        data.gitFlowSettings || getDefaultProjectGitFlowSettings();
      logProjectRegistryAction("started", {
        action: "create_project",
        requestId,
        groupId: data.groupId,
        path: data.path ?? null,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const { project: newProject } = await services.createProject({
        ...data,
        gitFlowSettings,
        requestId,
      });
      logProjectRegistryAction("succeeded", {
        action: "create_project_backend",
        requestId,
        projectId: newProject.id,
      });
      if (get().projectAddOperation?.requestId !== requestId) {
        return newProject;
      }
      const state = get();
      if (state.selectedGroupId) {
        await persistCurrentProjectContext(
          state.selectedGroupId,
          state.selectedProjectId,
        );
      }
	      const {
	        standaloneProjects: syncedStandaloneProjects,
	        projectGroups: syncedGroups,
	        plan,
	        planNodes,
	        predictedBranches,
	      } = await services.getAppBootstrap();
	      const syncedRegistry = {
	        standaloneProjects: syncedStandaloneProjects ?? [],
	        projectGroups: syncedGroups,
	      };
	      const syncedGroupForProject = getProjectGroupIdFromRegistry(syncedRegistry, newProject.id);
	      const syncedProject = findProjectInRegistry(syncedRegistry, newProject.id);
	      const fallbackRegistry = data.groupId
	        ? {
	            standaloneProjects: state.standaloneProjects,
	            projectGroups: insertProjectInGroups(state.projectGroups, newProject, data.groupId)
	              .projectGroups,
	          }
	        : {
	            standaloneProjects: [...state.standaloneProjects, newProject],
	            projectGroups: state.projectGroups,
	          };
	      const seededRegistry = syncedProject ? syncedRegistry : fallbackRegistry;
	      const normalizedRegistry = normalizeProjectRegistry({
	        standaloneProjects: seededRegistry.standaloneProjects,
	        projectGroups: seededRegistry.projectGroups,
	        selectedGroupId: syncedGroupForProject ?? data.groupId ?? null,
	        selectedProjectId: newProject.id,
	      });
	      const targetGroupId = getProjectGroupIdFromRegistry(normalizedRegistry, newProject.id);
	      const isCurrentGroup = targetGroupId === state.selectedGroupId;
      const preferredFocusProjectId = targetGroupId
        ? (getFocusedProjectIdForGroup(
            normalizedRegistry.projectGroups,
            targetGroupId,
            isCurrentGroup ? state.selectedProjectId : newProject.id,
          ) ?? newProject.id)
        : (normalizedRegistry.selectedProjectId ?? newProject.id);

	      const rememberedProject: RememberedProject = {
	        projectId: newProject.id,
	        groupId: targetGroupId,
	        name: newProject.name,
	        path: newProject.path,
	        lastOpenedAt: new Date().toISOString(),
	      };

      const nextRecentProjects = reconcileRememberedProjects(
	        normalizedRegistry,
	        upsertRememberedProject(state.recentProjects, rememberedProject),
	      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
	        normalizedRegistry,
	        upsertRememberedProject(
	          state.macroEnabledProjects,
	          rememberedProject,
	        ),
	      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
        projectGroups: normalizedRegistry.projectGroups,
        planNodes: filterPlanNodesForRegistry(
          planNodes?.length ? planNodes : derivePlanNodesFromPlan(plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          predictedBranches ?? [],
          validProjectIds,
        ),
	        selectedGroupId: targetGroupId,
        selectedProjectId: preferredFocusProjectId,
        selectedTaskId: isCurrentGroup ? state.selectedTaskId : null,
        activeArchitectPlanId: isCurrentGroup
          ? state.activeArchitectPlanId
          : null,
        architectPlanSwitch: isCurrentGroup
          ? state.architectPlanSwitch
          : idleArchitectPlanSwitchState(),
        activePlanContext: isCurrentGroup ? state.activePlanContext : null,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
      });
      void savePreference(
	        PREF_KEYS.LAST_SELECTED_GROUP_ID,
	        targetGroupId,
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
        selectedGroupId: targetGroupId,
        selectedProjectId: preferredFocusProjectId,
        mode: state.mode,
      });

      logProjectRegistryAction("succeeded", {
        action: "create_project",
        requestId,
        projectId: newProject.id,
        groupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
      set({ isLoading: false, lastError: null, projectAddOperation: null });
      schedulePostCreateHydration({
        requestId,
        action: "create_project",
        standaloneProjects: normalizedRegistry.standaloneProjects,
        projectGroups: normalizedRegistry.projectGroups,
        groupId: targetGroupId,
        projectId: preferredFocusProjectId,
      });
      return newProject;
    } catch (error) {
      const normalized = toServiceError(error);
      const current = get().projectAddOperation;
      set({
        isLoading: false,
        lastError: current?.status === "cancelling" ? null : normalized.message,
        projectAddOperation: current?.requestId === requestId ? null : current,
      });
      logProjectRegistryAction("failed", {
        action: "create_project",
        requestId,
        groupId: data.groupId,
        path: data.path ?? null,
        error: normalized.message,
      });
      throw normalized;
    }
  },

  createProjectWithGitSetup: async (data) => {
    const requestId = data.requestId || createProjectAddRequestId();
    set({
      isLoading: true,
      lastError: null,
      projectAddOperation: {
        requestId,
        status: "running",
        path: data.path ?? null,
        startedAt: Date.now(),
        canCancel: true,
      },
    });
    try {
      const previousState = get();
      const gitFlowSettings =
        data.gitFlowSettings || getDefaultProjectGitFlowSettings();
      logProjectRegistryAction("started", {
        action: "create_project_with_git_setup",
        requestId,
        groupId: data.groupId,
        path: data.path ?? null,
        gitSetupActions: data.gitSetupActions,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const result = await services.createProjectWithGitSetup({
        ...data,
        gitFlowSettings,
        requestId,
      });
      const newProject = result.project;
      logProjectRegistryAction("succeeded", {
        action: "create_project_with_git_setup_backend",
        requestId,
        projectId: newProject.id,
      });
      if (get().projectAddOperation?.requestId !== requestId) {
        return result;
      }
      const state = get();
      if (state.selectedGroupId) {
        await persistCurrentProjectContext(
          state.selectedGroupId,
          state.selectedProjectId,
        );
      }
	      const {
	        standaloneProjects: syncedStandaloneProjects,
	        projectGroups: syncedGroups,
	        plan,
	        planNodes,
	        predictedBranches,
	      } = await services.getAppBootstrap();
	      const syncedRegistry = {
	        standaloneProjects: syncedStandaloneProjects ?? [],
	        projectGroups: syncedGroups,
	      };
	      const syncedGroupForProject = getProjectGroupIdFromRegistry(syncedRegistry, newProject.id);
	      const syncedProject = findProjectInRegistry(syncedRegistry, newProject.id);
	      const fallbackRegistry = data.groupId
	        ? {
	            standaloneProjects: state.standaloneProjects,
	            projectGroups: insertProjectInGroups(state.projectGroups, newProject, data.groupId)
	              .projectGroups,
	          }
	        : {
	            standaloneProjects: [...state.standaloneProjects, newProject],
	            projectGroups: state.projectGroups,
	          };
	      const seededRegistry = syncedProject ? syncedRegistry : fallbackRegistry;
	      const normalizedRegistry = normalizeProjectRegistry({
	        standaloneProjects: seededRegistry.standaloneProjects,
	        projectGroups: seededRegistry.projectGroups,
	        selectedGroupId: syncedGroupForProject ?? data.groupId ?? null,
	        selectedProjectId: newProject.id,
	      });
	      const targetGroupId = getProjectGroupIdFromRegistry(normalizedRegistry, newProject.id);
      const isCurrentGroup = targetGroupId === state.selectedGroupId;
      const preferredFocusProjectId = targetGroupId
        ? (getFocusedProjectIdForGroup(
            normalizedRegistry.projectGroups,
            targetGroupId,
            isCurrentGroup ? state.selectedProjectId : newProject.id,
          ) ?? newProject.id)
        : (normalizedRegistry.selectedProjectId ?? newProject.id);

	      const rememberedProject: RememberedProject = {
	        projectId: newProject.id,
	        groupId: targetGroupId,
	        name: newProject.name,
	        path: newProject.path,
	        lastOpenedAt: new Date().toISOString(),
	      };

      const nextRecentProjects = reconcileRememberedProjects(
	        normalizedRegistry,
	        upsertRememberedProject(state.recentProjects, rememberedProject),
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
	        normalizedRegistry,
	        upsertRememberedProject(
	          state.macroEnabledProjects,
	          rememberedProject,
	        ),
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
        projectGroups: normalizedRegistry.projectGroups,
        planNodes: filterPlanNodesForRegistry(
          planNodes?.length ? planNodes : derivePlanNodesFromPlan(plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          predictedBranches ?? [],
          validProjectIds,
        ),
	        selectedGroupId: targetGroupId,
        selectedProjectId: preferredFocusProjectId,
        selectedTaskId: isCurrentGroup ? state.selectedTaskId : null,
        activeArchitectPlanId: isCurrentGroup
          ? state.activeArchitectPlanId
          : null,
        architectPlanSwitch: isCurrentGroup
          ? state.architectPlanSwitch
          : idleArchitectPlanSwitchState(),
        activePlanContext: isCurrentGroup ? state.activePlanContext : null,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
      });
      void savePreference(
	        PREF_KEYS.LAST_SELECTED_GROUP_ID,
	        targetGroupId,
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
	        selectedGroupId: targetGroupId,
        selectedProjectId: preferredFocusProjectId,
        mode: state.mode,
      });

      logProjectRegistryAction("succeeded", {
        action: "create_project_with_git_setup",
        requestId,
        projectId: newProject.id,
        groupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
      set({ isLoading: false, lastError: null, projectAddOperation: null });
      schedulePostCreateHydration({
        requestId,
        action: "create_project_with_git_setup",
        standaloneProjects: normalizedRegistry.standaloneProjects,
        projectGroups: normalizedRegistry.projectGroups,
        groupId: targetGroupId,
        projectId: preferredFocusProjectId,
      });
      return result;
    } catch (error) {
      const normalized = toServiceError(error);
      const current = get().projectAddOperation;
      set({
        isLoading: false,
        lastError: current?.status === "cancelling" ? null : normalized.message,
        projectAddOperation: current?.requestId === requestId ? null : current,
      });
      logProjectRegistryAction("failed", {
        action: "create_project_with_git_setup",
        requestId,
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

  createNewProjectRepo: async (data) => {
    const requestId = data.requestId || createProjectAddRequestId();
    set({
      isLoading: true,
      lastError: null,
      projectAddOperation: {
        requestId,
        status: "running",
        path: data.parentPath,
        startedAt: Date.now(),
        canCancel: true,
      },
    });
    try {
      const previousState = get();
      const gitFlowSettings =
        data.gitFlowSettings || getDefaultProjectGitFlowSettings();
      logProjectRegistryAction("started", {
        action: "create_new_project_repo",
        requestId,
        groupId: data.groupId,
        parentPath: data.parentPath,
        folderName: data.folderName,
        beforeCount: countProjectsInRegistry(previousState.projectGroups),
      });
      const result = await services.createNewProjectRepo({
        ...data,
        gitFlowSettings,
        requestId,
      });
      const newProject = result.project;
      logProjectRegistryAction("succeeded", {
        action: "create_new_project_repo_backend",
        requestId,
        projectId: newProject.id,
      });
      if (get().projectAddOperation?.requestId !== requestId) {
        return result;
      }
      const state = get();
      if (state.selectedGroupId) {
        await persistCurrentProjectContext(
          state.selectedGroupId,
          state.selectedProjectId,
        );
      }
	      const {
	        standaloneProjects: syncedStandaloneProjects,
	        projectGroups: syncedGroups,
	        plan,
	        planNodes,
	        predictedBranches,
	      } = await services.getAppBootstrap();
	      const syncedRegistry = {
	        standaloneProjects: syncedStandaloneProjects ?? [],
	        projectGroups: syncedGroups,
	      };
	      const syncedGroupForProject = getProjectGroupIdFromRegistry(syncedRegistry, newProject.id);
	      const syncedProject = findProjectInRegistry(syncedRegistry, newProject.id);
	      const fallbackRegistry = data.groupId
	        ? {
	            standaloneProjects: state.standaloneProjects,
	            projectGroups: insertProjectInGroups(state.projectGroups, newProject, data.groupId)
	              .projectGroups,
	          }
	        : {
	            standaloneProjects: [...state.standaloneProjects, newProject],
	            projectGroups: state.projectGroups,
	          };
	      const seededRegistry = syncedProject ? syncedRegistry : fallbackRegistry;
	      const normalizedRegistry = normalizeProjectRegistry({
	        standaloneProjects: seededRegistry.standaloneProjects,
	        projectGroups: seededRegistry.projectGroups,
	        selectedGroupId: syncedGroupForProject ?? data.groupId ?? null,
	        selectedProjectId: newProject.id,
	      });
	      const targetGroupId = getProjectGroupIdFromRegistry(normalizedRegistry, newProject.id);
      const isCurrentGroup = targetGroupId === state.selectedGroupId;
      const preferredFocusProjectId = targetGroupId
        ? (getFocusedProjectIdForGroup(
            normalizedRegistry.projectGroups,
            targetGroupId,
            isCurrentGroup ? state.selectedProjectId : newProject.id,
          ) ?? newProject.id)
        : (normalizedRegistry.selectedProjectId ?? newProject.id);

	      const rememberedProject: RememberedProject = {
	        projectId: newProject.id,
	        groupId: targetGroupId,
	        name: newProject.name,
	        path: newProject.path,
	        lastOpenedAt: new Date().toISOString(),
	      };

      const nextRecentProjects = reconcileRememberedProjects(
	        normalizedRegistry,
	        upsertRememberedProject(state.recentProjects, rememberedProject),
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
	        normalizedRegistry,
	        upsertRememberedProject(
	          state.macroEnabledProjects,
	          rememberedProject,
	        ),
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
        projectGroups: normalizedRegistry.projectGroups,
        planNodes: filterPlanNodesForRegistry(
          planNodes?.length ? planNodes : derivePlanNodesFromPlan(plan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          predictedBranches ?? [],
          validProjectIds,
        ),
	        selectedGroupId: targetGroupId,
        selectedProjectId: preferredFocusProjectId,
        selectedTaskId: isCurrentGroup ? state.selectedTaskId : null,
        activeArchitectPlanId: isCurrentGroup
          ? state.activeArchitectPlanId
          : null,
        architectPlanSwitch: isCurrentGroup
          ? state.architectPlanSwitch
          : idleArchitectPlanSwitchState(),
        activePlanContext: isCurrentGroup ? state.activePlanContext : null,
        recentProjects: nextRecentProjects,
        macroEnabledProjects: nextMacroEnabledProjects,
        projectRegistryRepairSummary: formatProjectRegistryRepairSummary(
          normalizedRegistry.report,
        ),
      });
      void savePreference(
	        PREF_KEYS.LAST_SELECTED_GROUP_ID,
	        targetGroupId,
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
	        selectedGroupId: targetGroupId,
        selectedProjectId: preferredFocusProjectId,
        mode: state.mode,
      });

      logProjectRegistryAction("succeeded", {
        action: "create_new_project_repo",
        requestId,
        projectId: newProject.id,
        groupId: targetGroupId ?? normalizedRegistry.selectedGroupId,
        afterCount: countProjectsInRegistry(normalizedRegistry.projectGroups),
        repairApplied: normalizedRegistry.report.repaired,
      });
      set({ isLoading: false, lastError: null, projectAddOperation: null });
      schedulePostCreateHydration({
        requestId,
        action: "create_new_project_repo",
        standaloneProjects: normalizedRegistry.standaloneProjects,
        projectGroups: normalizedRegistry.projectGroups,
        groupId: targetGroupId,
        projectId: preferredFocusProjectId,
      });
      return result;
    } catch (error) {
      const normalized = toServiceError(error);
      const current = get().projectAddOperation;
      set({
        isLoading: false,
        lastError: current?.status === "cancelling" ? null : normalized.message,
        projectAddOperation: current?.requestId === requestId ? null : current,
      });
      logProjectRegistryAction("failed", {
        action: "create_new_project_repo",
        requestId,
        groupId: data.groupId,
        parentPath: data.parentPath,
        folderName: data.folderName,
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
        normalizedRegistry,
        previousState.recentProjects,
      );
      const nextMacroEnabledProjects = reconcileRememberedProjects(
        normalizedRegistry,
        previousState.macroEnabledProjects,
      );
      const { validProjectIds } = collectProjectRegistryIds(
        normalizedRegistry,
        );

      set({
        currentPlan: snapshot.plan,
        standaloneProjects: normalizedRegistry.standaloneProjects,
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
        standaloneProjects: normalizedRegistry.standaloneProjects,
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

  setArchitectLeftPanelWidth: (width) => {
    const clampedWidth = Math.max(260, Math.min(420, width));
    set({ architectLeftPanelWidth: clampedWidth });
    savePreferenceDebounced(PREF_KEYS.ARCHITECT_LEFT_PANEL_WIDTH, clampedWidth);
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
	    const standaloneProject = state.standaloneProjects.find((project) => project.id === id);
	    if (standaloneProject) return standaloneProject;
	    for (const group of state.projectGroups) {
      const project = group.projects.find((p) => p.id === id);
      if (project) return project;
    }
    return undefined;
  },

  initializeCritical: async () => {
    set({ isLoading: true, lastError: null });
    try {
      logProjectRegistryAction("started", { action: "initializeCritical" });
      await purgeLegacyImplementExecutionModePreference();
      // Load persisted panel preferences
      const [
        activeThemeId,
        leftWidth,
        architectLeftWidth,
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
        metadataMissingUpstreamPolicy,
        inAppNotificationsEnabled,
        notificationChannelModes,
        storedProjectSwitchPolicy,
        sessionContext,
      ] = await Promise.all([
        loadPreference<string>(PREF_KEYS.THEME),
        loadPreference<number>(PREF_KEYS.LEFT_PANEL_WIDTH),
        loadPreference<number>(PREF_KEYS.ARCHITECT_LEFT_PANEL_WIDTH),
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
        loadPreference<MetadataMissingUpstreamPolicy>(
          PREF_KEYS.METADATA_MISSING_UPSTREAM_POLICY,
        ),
        loadPreference<boolean>(PREF_KEYS.IN_APP_NOTIFICATIONS_ENABLED),
        loadPreference<NotificationChannelModes>(
          PREF_KEYS.NOTIFICATION_CHANNEL_MODES,
        ),
        localProjectContext.getProjectSwitchPolicy(),
        localProjectContext.getLocalSessionContextState(),
      ]);

      const normalizedZoomMode: UiZoomMode =
        uiZoomMode === "override" ? "override" : "auto";
      const normalizedZoomLevel = clampUiZoomLevel(uiZoomLevel);
      const normalizedCodeOverflowMode =
        normalizeCodeOverflowMode(codeOverflowMode);

      const prunedRecentProjects =
        pruneLegacyRememberedProjects(recentProjects);
      const prunedMacroEnabledProjects =
        pruneLegacyRememberedProjects(macroEnabledProjects);
      let metadataRecoveryReport: WorkspaceMetadataRecoveryReportDto | null =
        null;
      let bootstrapPlan: Plan | null = null;
      let bootstrapStandaloneProjects: Project[] = [];
      let bootstrapProjectGroups: ProjectGroup[] = [];
      let bootstrapPlanNodes: PlanNode[] = [];
      let bootstrapPredictedBranches: PredictedBranch[] = [];
      let bootstrapErrorMessage: string | null = null;

      const reloadWorkspaceBootstrapAfterRegistryRepair = async () => {
        const bootstrap = await services.getAppBootstrap();
        bootstrapPlan = bootstrap.plan;
        bootstrapStandaloneProjects = bootstrap.standaloneProjects ?? [];
        bootstrapProjectGroups = bootstrap.projectGroups;
        bootstrapPlanNodes = bootstrap.planNodes ?? [];
        bootstrapPredictedBranches = bootstrap.predictedBranches ?? [];
      };

      try {
        await reloadWorkspaceBootstrapAfterRegistryRepair();
      } catch (bootstrapError) {
        bootstrapErrorMessage = toServiceError(bootstrapError).message;
        devLogger.info(
          `[Init] workspace bootstrap failed: ${bootstrapErrorMessage}`,
        );
      }

      const prunedStandaloneProjects = pruneLegacyPlaceholderStandaloneProjects(
        bootstrapStandaloneProjects,
      );
      const prunedProjectGroups = pruneLegacyPlaceholderWorkspaces(
        bootstrapProjectGroups,
      );

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
        standaloneProjects: prunedStandaloneProjects,
        projectGroups: prunedProjectGroups,
        selectedGroupId: effectiveLastSelectedGroupId,
        selectedProjectId: effectiveLastSelectedProjectId,
      });
      let resolvedStandaloneProjects = normalizedRegistry.standaloneProjects;
      let resolvedProjectGroups = normalizedRegistry.projectGroups;
      let resolvedGroupId = normalizedRegistry.selectedGroupId;
      let resolvedProjectId = normalizedRegistry.selectedProjectId;

      const cleanedRecentProjects = reconcileRememberedProjects(
        {
          standaloneProjects: resolvedStandaloneProjects,
          projectGroups: resolvedProjectGroups,
        },
        prunedRecentProjects,
        { preserveUnmatched: true },
      );
      const cleanedMacroEnabledProjects = reconcileRememberedProjects(
        {
          standaloneProjects: resolvedStandaloneProjects,
          projectGroups: resolvedProjectGroups,
        },
        prunedMacroEnabledProjects,
        { preserveUnmatched: true },
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
        const standaloneProjectForPath = resolvedStandaloneProjects.find(
          (project) => normalizePath(project.path) === normalizedLastPath,
        );
        if (standaloneProjectForPath) {
          resolvedGroupId = null;
          resolvedProjectId = standaloneProjectForPath.id;
        }
        const groupForPath = resolvedProjectGroups.find((group) =>
          group.projects.some(
            (project) => normalizePath(project.path) === normalizedLastPath,
          ),
        );

        if (!standaloneProjectForPath && groupForPath) {
          resolvedGroupId = groupForPath.id;
        } else if (!standaloneProjectForPath) {
          void savePreference(PREF_KEYS.LAST_OPEN_PROJECT_PATH, null);
        }
      }

      if (!resolvedGroupId && !resolvedProjectId) {
        const firstValidRecent = cleanedRecentProjects.find((recent) =>
          getAllProjectsFromRegistry({
            standaloneProjects: resolvedStandaloneProjects,
            projectGroups: resolvedProjectGroups,
          }).some(
            (project) => normalizePath(project.path) === normalizePath(recent.path),
          ),
        );

        if (firstValidRecent) {
          const recentProjectMatch = getAllProjectsFromRegistry({
            standaloneProjects: resolvedStandaloneProjects,
            projectGroups: resolvedProjectGroups,
          }).find(
            (project) =>
              normalizePath(project.path) === normalizePath(firstValidRecent.path),
          );
          resolvedGroupId = getProjectGroupIdFromRegistry(
            {
              standaloneProjects: resolvedStandaloneProjects,
              projectGroups: resolvedProjectGroups,
            },
            recentProjectMatch?.id ?? null,
          );
          resolvedProjectId = recentProjectMatch?.id ?? null;
        }
      }

      if (!resolvedGroupId && !resolvedProjectId) {
        const firstStandaloneProject = resolvedStandaloneProjects[0] ?? null;
        if (firstStandaloneProject) {
          resolvedProjectId = firstStandaloneProject.id;
        } else {
          resolvedGroupId = resolvedProjectGroups[0]?.id ?? null;
        }
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
	        {
	          standaloneProjects: resolvedStandaloneProjects,
	          projectGroups: resolvedProjectGroups,
	        },
	      );

      set({
        activeThemeId,
        mode: resolvedMode,
        agentType: resolvedAgentType,
	        currentPlan: bootstrapPlan,
	        standaloneProjects: resolvedStandaloneProjects,
	        projectGroups: resolvedProjectGroups,
        planNodes: filterPlanNodesForRegistry(
          bootstrapPlanNodes?.length
            ? bootstrapPlanNodes
            : derivePlanNodesFromPlan(bootstrapPlan),
          validProjectIds,
        ),
        predictedBranches: filterPredictedBranchesForRegistry(
          bootstrapPredictedBranches ?? [],
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
        architectLeftPanelWidth: architectLeftWidth,
        rightPanelWidth: rightWidth,
        isLeftPanelOpen: leftOpen,
        isRightPanelOpen: rightOpen,
        uiZoomMode: normalizedZoomMode,
        uiZoomLevel: normalizedZoomLevel,
        codeOverflowMode: normalizedCodeOverflowMode,
        metadataAutoPush,
        metadataMissingUpstreamPolicy:
          metadataMissingUpstreamPolicy === "ignore" ? "ignore" : "ask",
        inAppNotificationsEnabled: inAppNotificationsEnabled !== false,
        notificationChannelModes: sanitizeNotificationChannelModes(
          notificationChannelModes,
        ),
        projectSwitchPolicy: storedProjectSwitchPolicy,
        isProjectSwitching: false,
        isLoading: false,
        lastError: bootstrapErrorMessage
          ? `Workspace metadata could not be loaded. Macro opened an empty shell: ${bootstrapErrorMessage}`
          : null,
      });

      void savePreference(PREF_KEYS.RECENT_PROJECTS, cleanedRecentProjects);
      void savePreference(
        PREF_KEYS.MACRO_ENABLED_PROJECTS,
        cleanedMacroEnabledProjects,
      );
	      const resolvedFocusedProject = resolvedProjectId
	        ? findProjectInRegistry(
	            {
	              standaloneProjects: resolvedStandaloneProjects,
	              projectGroups: resolvedProjectGroups,
	            },
	            resolvedProjectId,
	          )
	        : null;
      void savePreference(
        PREF_KEYS.LAST_OPEN_PROJECT_PATH,
        resolvedFocusedProject?.path &&
          shouldPersistProjectPath(resolvedFocusedProject.path)
          ? resolvedFocusedProject.path
          : null,
      );
      logProjectRegistryAction("succeeded", {
        action: "initializeCritical",
        afterCount: countProjectsInProjectRegistry({
          standaloneProjects: resolvedStandaloneProjects,
          projectGroups: resolvedProjectGroups,
        }),
        repairApplied: normalizedRegistry.report.repaired,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
      logProjectRegistryAction("failed", {
        action: "initializeCritical",
        error: normalized.message,
      });
    }
  },

  resumeAfterInitialize: async () => {
    const state = get();
    try {
      await persistSessionContext({
        selectedGroupId: state.selectedGroupId,
        selectedProjectId: state.selectedProjectId,
        mode: state.mode,
      });
    } catch (error) {
      devLogger.info(
        `[Init] session context persistence failed after shell boot: ${toServiceError(error).message}`,
      );
    }

    try {
	      await reconcileProjectRegistryDependencies({
	        standaloneProjects: get().standaloneProjects,
	        projectGroups: get().projectGroups,
        selectedGroupId: get().selectedGroupId,
        selectedProjectId: get().selectedProjectId,
      });
    } catch (error) {
      devLogger.info(
        `[Init] project registry dependency reconciliation failed after shell boot: ${toServiceError(error).message}`,
      );
    }

    try {
	      const current = get();
	      if (
	        current.selectedGroupId &&
	        current.projectSwitchPolicy === "resume_per_project"
	      ) {
	        await restoreProjectContext(current.selectedGroupId);
	      }
    } catch (error) {
      devLogger.info(
        `[Init] project context restore failed after shell boot: ${toServiceError(error).message}`,
      );
    }

    try {
      const current = useAppStore.getState();
      await current.loadMacroProjectMetadataForSelection({
        hydrateActivePlan: current.mode === "Architect",
        refreshTasks: true,
        reason: "boot",
      });
    } catch (error) {
      devLogger.info(
        `[Init] auto plan restore failed after shell boot: ${toServiceError(error).message}`,
      );
    }
  },

  initialize: async () => {
    await get().initializeCritical();
    await get().resumeAfterInitialize();
  },
}));
