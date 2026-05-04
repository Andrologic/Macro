import type {
  Need,
  NeedCategory,
  NeedStatus,
  PlanNode,
  PlanNodeStatus,
  PlanNodeType,
  PredictedBranch,
  Project,
  ProjectGitFlowSettings,
  ProjectGroup,
  TaskStatus,
} from "../types";
import type {
  ArchitectPlanRecord,
  ArchitectPlanSummary,
} from "./architectPlanService";
import type {
  ArchitectPlanGitFlowMetadata,
  ArchitectPlanKind,
} from "./architectPlanKinds";
import {
  hasPersistedArchitectStrategy,
  isArchitectPlanReplicaDivergenceError,
} from "./architectPlanService";
import { persistArchitectPlanStrategyPreview } from "./architectPlanRuntimeService";
import { isCanonicalArchitectPlan } from "./architectPlanPresentation";
import {
  formatArchitectNeedAddToolResult,
  formatArchitectNeedDeleteToolResult,
  formatArchitectNeedGetToolResult,
  formatArchitectNeedListToolResult,
  formatArchitectNeedUpdateToolResult,
  formatArchitectPlanCreateToolResult,
  formatArchitectPlanGetToolResult,
  formatArchitectPlanListToolResult,
  formatArchitectPlanUpdateToolResult,
  formatArchitectStrategyDeleteToolResult,
  formatArchitectStrategyGenerateToolResult,
  formatArchitectStrategyGetToolResult,
  formatArchitectStrategyMutationPreviewToolResult,
  formatArchitectStrategyMutationRepairToolResult,
  formatArchitectStrategyUpdateToolResult,
} from "./architectChat";
import {
  collectRenderedPlanPredictedBranchDescriptors,
  normalizePlanSlugInput,
} from "./architectBranchIdentity";
import { getPlanNodeBranchIntent, type WorkBranchType } from "./gitFlowBranchIntents";
import {
  normalizeNodeProjectIds,
  normalizeStrategyDependencies,
} from "./implementTaskDerivation";
import type {
  ApplyStrategyMutationPreviewParams,
  PrepareStrategyMutationPreviewParams,
  StrategyMutationDecision,
  StrategyMutationGuardDeps,
  StrategyMutationPreview,
} from "./architectStrategyMutationGuard";
import {
  getFocusedProjectForGroup,
  getProjectGroupByProjectId,
  getScopedActionableProjectIds,
} from "./globalProjects";

const strategyMutationRepairAttempts = new Map<string, number>();

const ARCHITECT_STRATEGY_NODE_TYPES = new Set<PlanNodeType>([
  "spec",
  "feature",
  "task",
  "milestone",
]);

const ARCHITECT_STRATEGY_NODE_STATUSES = new Set<PlanNodeStatus>([
  "pending",
  "in-progress",
  "completed",
  "blocked",
]);

const ARCHITECT_NEED_CATEGORIES = new Set<NeedCategory>([
  "functional",
  "technical",
  "ux",
  "performance",
  "security",
  "data",
  "business",
  "other",
]);

const ARCHITECT_NEED_PRIORITIES = new Set<Need["priority"]>([
  "low",
  "medium",
  "high",
]);

const ARCHITECT_NEED_STATUSES = new Set<NeedStatus>([
  "identified",
  "refined",
  "validated",
]);

const uniqueProjectIds = (items: Array<string | null | undefined>): string[] =>
  Array.from(
    new Set(
      items
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0),
    ),
  );

type NormalizedArchitectStrategyNodeInput = {
  id?: string;
  title: string;
  description: string;
  type: PlanNodeType;
  assignedBranch: string;
  branchType: WorkBranchType;
  branchSlug: string;
  status: PlanNodeStatus;
  dependencies: string[];
  projectIds: string[];
};

interface ArchitectToolAppState {
  activeArchitectPlanId: string | null;
  activePlanContext: {
    id?: string;
    targetBranch: string;
  } | null;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  projectGroups: ProjectGroup[];
  getProjectById: (projectId: string) => Project | undefined;
  activateArchitectPlan: (
    planId: string,
    options?: {
      targetBranch?: string | null;
      persistActiveSelection?: boolean;
    },
  ) => Promise<boolean>;
  setStrategyMutationPreview: (preview: StrategyMutationPreview | null) => void;
}

interface ArchitectToolNeedsState {
  addNeed: (need: Omit<Need, "id" | "createdAt" | "updatedAt">) => string;
  updateNeed: (id: string, updates: Partial<Need>) => void;
  deleteNeed: (id: string) => void;
  flushPendingPersistence?: (planId?: string | null) => Promise<void>;
  getNeed: (id: string) => Need | undefined;
  getNeedsForPlan: (planId: string) => Need[];
}

interface ArchitectToolTaskRecord {
  id: string;
  plan_id: string | null;
  status: TaskStatus;
}

interface ArchitectToolTaskState {
  tasks: ArchitectToolTaskRecord[];
  refreshFromPlan: () => Promise<void>;
}

interface EnsureArchitectConversationForPlanParams {
  plan: ArchitectPlanRecord;
  targetBranch: string;
  fallbackProjectId?: string;
  fallbackGroupId?: string;
  sharedConversation?: boolean;
}

interface ArchitectToolUpdatePlanInput {
  branchName: string;
  planId: string;
  title?: string;
  label?: string;
  slug?: string;
  description?: string;
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: Partial<ArchitectPlanGitFlowMetadata>;
  status?: ArchitectPlanRecord["status"];
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
  projectId?: string;
  projectIds?: string[];
  contextProjectIds?: string[];
  targetBranchesByProjectId?: Record<string, string>;
  setActive?: boolean;
}

interface ArchitectToolCreatePlanInput {
  branchName: string;
  title?: string;
  label?: string;
  description?: string;
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: Partial<ArchitectPlanGitFlowMetadata>;
  status?: ArchitectPlanRecord["status"];
  projectId?: string;
  projectIds?: string[];
  contextProjectIds?: string[];
  setActive?: boolean;
}

interface ArchitectToolPlanService {
  createArchitectPlan: (
    input: ArchitectToolCreatePlanInput,
  ) => Promise<ArchitectPlanRecord>;
  getArchitectPlan: (
    branchName: string,
    planId: string,
  ) => Promise<ArchitectPlanRecord | null>;
  getGitFlowBaseBranch: () => string;
  isArchitectPlanSlugAvailable: (params: {
    branchName: string;
    slug: string;
    excludePlanId?: string | null;
  }) => Promise<boolean>;
  isArchitectPlanSlugMutable: (
    plan: Pick<ArchitectPlanRecord, "status" | "nodes">,
  ) => boolean;
  listArchitectPlans: (
    branchName: string,
    includeDeleted?: boolean,
    includeArchived?: boolean,
  ) => Promise<{
    activePlanId: string | null;
    plans: ArchitectPlanSummary[];
  }>;
  resolvePlanProjectContextId: (
    plan: Pick<
      ArchitectPlanRecord,
      "projectId" | "projectIds" | "contextProjectIds"
    > & { expectedProjectIds?: string[] },
    preferredProjectId?: string | null,
  ) => string | null;
  resolveTargetBranch: (argsValue: unknown) => string;
  updateArchitectPlan: (
    input: ArchitectToolUpdatePlanInput,
  ) => Promise<ArchitectPlanRecord>;
}

interface ArchitectToolStrategyService {
  prepareStrategyMutationPreview: (
    params: PrepareStrategyMutationPreviewParams,
  ) => StrategyMutationPreview;
  applyStrategyMutationPreview: (
    params: ApplyStrategyMutationPreviewParams,
    deps: StrategyMutationGuardDeps,
  ) => Promise<ArchitectPlanRecord>;
  guardDeps: StrategyMutationGuardDeps;
}

interface ArchitectToolRuntimeDependencies {
  assistantMessageId: string;
  toolName: string;
  args: Record<string, unknown>;
  planService: ArchitectToolPlanService;
  strategyService: ArchitectToolStrategyService;
  getAppState: () => ArchitectToolAppState;
  getNeedsState: () => ArchitectToolNeedsState;
  getTaskState: () => ArchitectToolTaskState;
  ensureArchitectConversationForPlan: (
    params: EnsureArchitectConversationForPlanParams,
  ) => Promise<{
    conversationId: string | null;
    restoredTranscript: boolean;
    createdConversation: boolean;
  }>;
}

const normalizeArchitectStrategyOperationProjectIds = (
  rawOperation: Record<string, unknown>,
  fallbackNode?: Pick<PlanNode, "projectId" | "projectIds"> | null,
): string[] => {
  const explicitProjectIds = Array.isArray(rawOperation.projectIds)
    ? rawOperation.projectIds
        .filter(
          (projectId): projectId is string => typeof projectId === "string",
        )
        .map((projectId) => projectId.trim())
        .filter(Boolean)
    : [];
  const explicitProjectId =
    typeof rawOperation.projectId === "string"
      ? rawOperation.projectId.trim()
      : "";

  if (Array.isArray(rawOperation.projectIds) || explicitProjectId.length > 0) {
    return Array.from(
      new Set([
        ...explicitProjectIds,
        ...(explicitProjectId.length > 0 ? [explicitProjectId] : []),
      ]),
    );
  }

  return fallbackNode ? normalizeNodeProjectIds(fallbackNode) : [];
};

const cloneArchitectStrategyWorkingNode = (node: PlanNode): PlanNode => {
  const projectIds = normalizeNodeProjectIds(node);
  return {
    ...node,
    dependencies: [...node.dependencies],
    projectId: projectIds[0],
    projectIds,
  };
};

const serializeArchitectStrategyNodeForResolution = (
  node: Pick<
    PlanNode,
    | "id"
    | "title"
    | "description"
    | "type"
    | "status"
    | "assignedBranch"
    | "branchType"
    | "branchSlug"
    | "dependencies"
    | "projectId"
    | "projectIds"
  >,
) => {
  const projectIds = normalizeNodeProjectIds(node);
  return {
    id: node.id,
    title: node.title,
    description: node.description,
    type: node.type,
    status: node.status,
    assignedBranch: node.assignedBranch,
    branchType: node.branchType,
    branchSlug: node.branchSlug,
    dependencies: [...node.dependencies],
    ...(projectIds.length > 0
      ? {
          projectId: projectIds[0],
          projectIds,
        }
      : {}),
  };
};

const normalizeArchitectStrategyNodeInput = (
  rawNode: unknown,
  index: number,
): NormalizedArchitectStrategyNodeInput => {
  const node = (
    rawNode && typeof rawNode === "object" ? rawNode : {}
  ) as Record<string, unknown>;
  const title = typeof node.title === "string" ? node.title.trim() : "";
  const description =
    typeof node.description === "string" ? node.description.trim() : "";
  const rawType =
    typeof node.type === "string" ? node.type.trim().toLowerCase() : "task";
  const rawStatus =
    typeof node.status === "string"
      ? node.status.trim().toLowerCase()
      : "pending";
  const assignedBranchRaw =
    typeof node.assignedBranch === "string"
      ? node.assignedBranch.trim()
      : "";
  const branchTypeRaw =
    typeof node.branchType === "string"
      ? node.branchType.trim().toLowerCase()
      : "";
  const branchSlugRaw =
    typeof node.featureSlug === "string"
      ? node.featureSlug.trim()
      : typeof node.feature_slug === "string"
        ? node.feature_slug.trim()
        : typeof node.branchSlug === "string"
          ? node.branchSlug.trim()
          : "";
  const dependencies = Array.isArray(node.dependencies)
    ? node.dependencies
        .filter((dep): dep is string => typeof dep === "string")
        .map((dep) => dep.trim())
        .filter(Boolean)
    : [];
  const rawProjectIds = Array.isArray(node.projectIds)
    ? node.projectIds
    : Array.isArray(node.project_ids)
      ? node.project_ids
      : null;
  const rawProjectId =
    typeof node.projectId === "string"
      ? node.projectId
      : typeof node.project_id === "string"
        ? node.project_id
        : "";
  const projectIds = rawProjectIds
    ? rawProjectIds
        .filter(
          (projectId): projectId is string => typeof projectId === "string",
        )
        .map((projectId) => projectId.trim())
        .filter(Boolean)
    : rawProjectId.trim().length > 0
      ? [rawProjectId.trim()]
      : [];

  if (!title) {
    throw new Error(`Invalid strategy node at index ${index}: missing title.`);
  }
  if (!ARCHITECT_STRATEGY_NODE_TYPES.has(rawType as PlanNodeType)) {
    throw new Error(`Invalid node type for "${title}": ${rawType}.`);
  }
  if (!ARCHITECT_STRATEGY_NODE_STATUSES.has(rawStatus as PlanNodeStatus)) {
    throw new Error(`Invalid node status for "${title}": ${rawStatus}.`);
  }

  const branchIntent = getPlanNodeBranchIntent({
    branchType: branchTypeRaw,
    branchSlug: branchSlugRaw,
    assignedBranch: assignedBranchRaw,
    title,
  });

  return {
    id: typeof node.id === "string" ? node.id.trim() : undefined,
    title,
    description,
    type: rawType as PlanNodeType,
    assignedBranch: branchIntent.label,
    branchType: branchIntent.branchType,
    branchSlug: branchIntent.branchSlug,
    status: rawStatus as PlanNodeStatus,
    dependencies: Array.from(new Set(dependencies)),
    projectIds: Array.from(new Set(projectIds)),
  };
};

const buildArchitectStrategyPredictedBranches = (params: {
  nodes: PlanNode[];
  planSlug: string;
  getProjectGitFlowSettings: (
    projectId: string,
  ) => ProjectGitFlowSettings | undefined;
}): PredictedBranch[] => {
  const colors = [
    "#3b82f6",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#8b5cf6",
    "#ec4899",
    "#06b6d4",
  ];
  const nodeById = new Map(params.nodes.map((node) => [node.id, node]));
  const resolveBranchStatus = (taskIds: string[]): PredictedBranch["status"] => {
    const branchNodes = taskIds
      .map((taskId) => nodeById.get(taskId))
      .filter((node): node is PlanNode => Boolean(node));
    if (branchNodes.length > 0 && branchNodes.every((node) => node.status === "completed")) {
      return "merged";
    }
    if (branchNodes.some((node) => node.status === "in-progress")) {
      return "active";
    }
    return "pending";
  };

  return collectRenderedPlanPredictedBranchDescriptors({
    nodes: params.nodes,
    planSlug: params.planSlug,
    getProjectGitFlowSettings: params.getProjectGitFlowSettings,
  }).map((branch, index) => ({
    id: `branch-${Date.now()}-${index}`,
    name: branch.name,
    color: colors[index % colors.length],
    parentBranch: branch.parentBranch,
    projectId: branch.projectId,
    taskIds: branch.taskIds,
    status: resolveBranchStatus(branch.taskIds),
    branchType: branch.branchType,
    branchSlug: branch.branchSlug,
  }));
};

const resolvePlanEditableProjectIds = (
  plan: Pick<ArchitectPlanRecord, "projectId" | "projectIds">,
): string[] => uniqueProjectIds([...(plan.projectIds || []), plan.projectId]);

const resolvePlanContextProjectIds = (
  plan: Pick<ArchitectPlanRecord, "contextProjectIds">,
): string[] => uniqueProjectIds(plan.contextProjectIds || []);

const resolvePlanGlobalProjectIds = (
  appState: ArchitectToolAppState,
  plan: Pick<
    ArchitectPlanRecord,
    "projectId" | "projectIds" | "contextProjectIds"
  >,
): Set<string> => {
  const anchorProjectId = uniqueProjectIds([
    ...(plan.projectIds || []),
    plan.projectId,
    ...(plan.contextProjectIds || []),
  ])[0];
  const group = getProjectGroupByProjectId(
    appState.projectGroups,
    anchorProjectId,
  );

  return new Set(group?.projects.map((project) => project.id) || []);
};

const validateStrategyNodeProjectIds = (params: {
  nodeTitle: string;
  projectIds: string[];
  editableProjectIds: string[];
  contextProjectIds: string[];
  globalProjectIds: Set<string>;
}): void => {
  const editableProjectIdSet = new Set(params.editableProjectIds);
  const contextProjectIdSet = new Set(params.contextProjectIds);

  params.projectIds.forEach((projectId) => {
    if (editableProjectIdSet.has(projectId)) {
      return;
    }

    if (contextProjectIdSet.has(projectId)) {
      throw new Error(
        `Strategy node "${params.nodeTitle}" targets context-only subproject "${projectId}". Context subprojects stay in contextProjectIds and cannot receive executable strategy branches.`,
      );
    }

    if (params.globalProjectIds.size > 0 && params.globalProjectIds.has(projectId)) {
      throw new Error(
        `Strategy node "${params.nodeTitle}" targets subproject "${projectId}", but that subproject is not in the editable scope of this plan. Add it to projectIds before generating the strategy.`,
      );
    }

    throw new Error(
      `Strategy node "${params.nodeTitle}" targets subproject "${projectId}", which is outside this plan's global project scope.`,
    );
  });
};

const resolveRequestedArchitectPlanSlug = (params: {
  activePlan: Pick<ArchitectPlanRecord, "id" | "slug" | "title">;
  requestedPlanSlug?: string | null;
}): string | null => {
  const trimmedRequestedSlug = params.requestedPlanSlug?.trim() || "";
  if (!trimmedRequestedSlug) {
    return null;
  }

  return normalizePlanSlugInput(
    trimmedRequestedSlug,
    params.activePlan.slug || params.activePlan.id,
  );
};

const validateRequestedArchitectPlanSlug = async (params: {
  branchName: string;
  activePlan: ArchitectPlanRecord;
  requestedPlanSlug?: string | null;
  planService: ArchitectToolPlanService;
}): Promise<{
  normalizedRequestedPlanSlug: string | null;
  slugValidationConflicts: string[];
}> => {
  const normalizedRequestedPlanSlug = resolveRequestedArchitectPlanSlug({
    activePlan: params.activePlan,
    requestedPlanSlug: params.requestedPlanSlug,
  });
  const slugValidationConflicts: string[] = [];

  if (
    normalizedRequestedPlanSlug &&
    normalizedRequestedPlanSlug !== params.activePlan.slug
  ) {
    if (!params.planService.isArchitectPlanSlugMutable(params.activePlan)) {
      slugValidationConflicts.push(
        `Plan slug "${params.activePlan.slug}" is already locked and cannot be changed.`,
      );
    } else if (
      !(await params.planService.isArchitectPlanSlugAvailable({
        branchName: params.branchName,
        slug: normalizedRequestedPlanSlug,
        excludePlanId: params.activePlan.id,
      }))
    ) {
      slugValidationConflicts.push(
        `Plan slug "${normalizedRequestedPlanSlug}" is already reserved by another plan.`,
      );
    }
  }

  return {
    normalizedRequestedPlanSlug,
    slugValidationConflicts,
  };
};

const buildArchitectStrategyMetadataUpdate = async (params: {
  branchName: string;
  activePlan: ArchitectPlanRecord;
  requestedPlanSlug?: string | null;
  requestedPlanTitleAlias?: string;
  description: string;
  includeTitleAlias?: boolean;
  planService: ArchitectToolPlanService;
}): Promise<{
  title?: string;
  label?: string;
  slug?: string;
  description: string;
  validationConflicts?: string[];
}> => {
  const { normalizedRequestedPlanSlug, slugValidationConflicts } =
    await validateRequestedArchitectPlanSlug({
      branchName: params.branchName,
      activePlan: params.activePlan,
      requestedPlanSlug: params.requestedPlanSlug,
      planService: params.planService,
    });
  const metadataUpdate: {
    title?: string;
    label?: string;
    slug?: string;
    description: string;
    validationConflicts?: string[];
  } = {
    description: params.description,
  };

  if (normalizedRequestedPlanSlug) {
    metadataUpdate.slug = normalizedRequestedPlanSlug;
  }

  if (params.includeTitleAlias && params.requestedPlanTitleAlias !== undefined) {
    if (isCanonicalArchitectPlan(params.activePlan)) {
      metadataUpdate.label = params.requestedPlanTitleAlias;
    } else {
      metadataUpdate.title = params.requestedPlanTitleAlias;
    }
  }

  if (slugValidationConflicts.length > 0) {
    metadataUpdate.validationConflicts = slugValidationConflicts;
  }

  return metadataUpdate;
};

const normalizeNeedTags = (rawTags: unknown): string[] => {
  if (!Array.isArray(rawTags)) {
    return [];
  }

  return Array.from(
    new Set(
      rawTags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  ).slice(0, 12);
};

const resolveActivePlanId = (
  appState: ArchitectToolAppState,
): string | null => appState.activeArchitectPlanId;

const hasPostWriteReplicaWarning = (plan: ArchitectPlanRecord): boolean =>
  plan.hasReplicaDivergence === true || plan.replicationState === "diverged";

const resolveArchitectTargetBranch = (
  rawTargetBranch: unknown,
  appState: ArchitectToolAppState,
  planService: ArchitectToolPlanService,
): string => {
  if (typeof rawTargetBranch === "string" && rawTargetBranch.trim().length > 0) {
    return planService.resolveTargetBranch(rawTargetBranch);
  }

  const activeTargetBranch = appState.activePlanContext?.targetBranch;
  if (activeTargetBranch && activeTargetBranch.trim().length > 0) {
    try {
      return planService.resolveTargetBranch(activeTargetBranch);
    } catch {
      // Fall through to default base branch.
    }
  }

  return planService.getGitFlowBaseBranch();
};

const hydratePlanContext = async (params: {
  targetBranch: string;
  planId: string;
  planService: ArchitectToolPlanService;
  getAppState: () => ArchitectToolAppState;
  ensureArchitectConversationForPlan: (
    params: EnsureArchitectConversationForPlanParams,
  ) => Promise<{
    conversationId: string | null;
    restoredTranscript: boolean;
    createdConversation: boolean;
  }>;
}): Promise<void> => {
  const plan = await params.planService.getArchitectPlan(
    params.targetBranch,
    params.planId,
  );
  if (!plan || plan.status === "deleted") return;

  const appStore = params.getAppState();
  const activated = await appStore.activateArchitectPlan(plan.id, {
    targetBranch: params.targetBranch,
    persistActiveSelection: false,
  });
  if (!activated) {
    return;
  }

  const latestAppStore = params.getAppState();
  const plansIndex = await params.planService.listArchitectPlans(
    params.targetBranch,
    true,
    true,
  );
  const conversationId = plan.conversationId;
  const hasSharedConversation = Boolean(
    conversationId &&
      plansIndex.plans.some(
        (candidate) =>
          candidate.id !== plan.id && candidate.conversationId === conversationId,
      ),
  );

  const fallbackGroupId = latestAppStore.selectedGroupId;
  const fallbackGroupProjectId =
    getFocusedProjectForGroup(
      latestAppStore.projectGroups,
      fallbackGroupId,
      latestAppStore.selectedProjectId,
    )?.id ?? null;
  const fallbackProjectId =
    params.planService.resolvePlanProjectContextId(
      plan,
      latestAppStore.selectedProjectId,
    ) ||
    fallbackGroupProjectId ||
    latestAppStore.selectedProjectId ||
    latestAppStore.projectGroups.flatMap((group) => group.projects)[0]?.id ||
    null;

  await params.ensureArchitectConversationForPlan({
    plan,
    targetBranch: params.targetBranch,
    fallbackProjectId: fallbackProjectId ?? undefined,
    fallbackGroupId: fallbackGroupId ?? undefined,
    sharedConversation: hasSharedConversation,
  });
};

const resolveStrategyForPlan = async (params: {
  activePlan: ArchitectPlanRecord;
  nodesInput: unknown[];
  requestedPlanSlug?: string;
  reuseExistingIds?: boolean;
  existingNodesForPatch?: PlanNode[];
  planService: ArchitectToolPlanService;
  getAppState: () => ArchitectToolAppState;
}): Promise<{
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  resolvedProjectIds: string[];
  targetBranchesByProjectId: Record<string, string>;
}> => {
  const {
    activePlan,
    nodesInput,
    requestedPlanSlug,
    reuseExistingIds = false,
    existingNodesForPatch = [],
    planService,
    getAppState,
  } = params;

  if (nodesInput.length === 0) {
    throw new Error("No nodes provided for strategy update.");
  }
  if (nodesInput.length > 250) {
    throw new Error("Strategy too large. Maximum 250 nodes.");
  }

  const appState = getAppState();
  const selectedProjectIds = getScopedActionableProjectIds(
    appState.projectGroups,
    appState.selectedGroupId,
    appState.selectedProjectId,
  );
  const editablePlanProjectIds = resolvePlanEditableProjectIds(activePlan);
  const contextPlanProjectIds = resolvePlanContextProjectIds(activePlan);
  const globalPlanProjectIds = resolvePlanGlobalProjectIds(appState, activePlan);
  const defaultProjectIds = Array.from(
    new Set([
      ...editablePlanProjectIds,
      ...(editablePlanProjectIds.length === 0 ? selectedProjectIds : []),
    ]),
  ).filter(Boolean);

  if (defaultProjectIds.length === 0) {
    throw new Error(
      "Cannot generate a strategy because the active plan has no editable subproject scope.",
    );
  }

  const planSlug =
    requestedPlanSlug && planService.isArchitectPlanSlugMutable(activePlan)
      ? normalizePlanSlugInput(requestedPlanSlug, activePlan.slug || activePlan.id)
      : activePlan.slug;

  const idBase = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const existingIdByTitle = new Map(
    existingNodesForPatch.map((node) => [node.title, node.id]),
  );

  const normalizedNodes = nodesInput.map((rawNode, index) =>
    normalizeArchitectStrategyNodeInput(rawNode, index),
  );
  const titleSet = new Set<string>();
  normalizedNodes.forEach((node) => {
    if (titleSet.has(node.title)) {
      throw new Error(`Duplicate strategy node title detected: "${node.title}".`);
    }
    titleSet.add(node.title);
  });

  const planNodes: PlanNode[] = normalizedNodes.map((node, index) => {
    const existingId = reuseExistingIds
      ? existingIdByTitle.get(node.title)
      : undefined;
    const preferredId = node.id || existingId;
    const resolvedProjectIds =
      node.projectIds.length > 0 ? node.projectIds : defaultProjectIds;
    validateStrategyNodeProjectIds({
      nodeTitle: node.title,
      projectIds: resolvedProjectIds,
      editableProjectIds: defaultProjectIds,
      contextProjectIds: contextPlanProjectIds,
      globalProjectIds: globalPlanProjectIds,
    });
    return {
      id:
        preferredId && preferredId.length > 0
          ? preferredId
          : `${idBase}-${index}`,
      title: node.title,
      description: node.description,
      type: node.type,
      assignedBranch: node.assignedBranch,
      branchType: node.branchType,
      branchSlug: node.branchSlug,
      status: node.status,
      projectId: resolvedProjectIds[0] || undefined,
      projectIds: resolvedProjectIds,
      dependencies: [...node.dependencies],
    };
  });

  const nodeById = new Map(planNodes.map((node) => [node.id, node]));
  const nodeByTitle = new Map(planNodes.map((node) => [node.title, node]));

  planNodes.forEach((node) => {
    node.dependencies = node.dependencies.map((dependencyRef) => {
      const byId = nodeById.get(dependencyRef);
      if (byId) return byId.id;
      const byTitle = nodeByTitle.get(dependencyRef);
      if (byTitle) return byTitle.id;
      throw new Error(
        `Unknown dependency "${dependencyRef}" for node "${node.title}".`,
      );
    });
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;

    visiting.add(id);
    const node = nodeById.get(id);
    if (node) {
      for (const dependencyId of node.dependencies) {
        if (!nodeById.has(dependencyId)) {
          throw new Error(
            `Dependency id "${dependencyId}" is missing from strategy nodes.`,
          );
        }
        if (dependencyId === id || hasCycle(dependencyId)) {
          return true;
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  for (const node of planNodes) {
    if (hasCycle(node.id)) {
      throw new Error(
        `Cycle detected in strategy dependencies near node "${node.title}".`,
      );
    }
  }

  const predictedBranches = buildArchitectStrategyPredictedBranches({
    nodes: planNodes,
    planSlug,
    getProjectGitFlowSettings: (projectId) =>
      appState.getProjectById(projectId)?.gitFlowSettings,
  });

  const normalizedStrategy = normalizeStrategyDependencies(
    planNodes,
    predictedBranches,
    {
      planSlug,
    },
  );
  const resolvedProjectIds = Array.from(
    new Set(
      normalizedStrategy.nodes.flatMap(
        (node) => node.projectIds || (node.projectId ? [node.projectId] : []),
      ),
    ),
  );
  const targetBranchesByProjectId = Object.fromEntries(
    resolvedProjectIds.map((projectId) => [
      projectId,
      activePlan.targetBranchesByProjectId?.[projectId] ||
        appState.getProjectById(projectId)?.gitFlowSettings?.baseBranch ||
        activePlan.targetBranch,
    ]),
  );
  return {
    planNodes: normalizedStrategy.nodes,
    predictedBranches: normalizedStrategy.predictedBranches,
    resolvedProjectIds,
    targetBranchesByProjectId,
  };
};

const executeStrategyMutation = async (params: {
  assistantMessageId: string;
  source: "strategy_generate" | "strategy_update";
  targetBranch: string;
  activePlan: ArchitectPlanRecord;
  strategy: Awaited<ReturnType<typeof resolveStrategyForPlan>>;
  metadataUpdate?: {
    title?: string;
    label?: string;
    slug?: string;
    description?: string;
    validationConflicts?: string[];
  };
  planService: ArchitectToolPlanService;
  strategyService: ArchitectToolStrategyService;
  getAppState: () => ArchitectToolAppState;
  getTaskState: () => ArchitectToolTaskState;
  ensureArchitectConversationForPlan: (
    params: EnsureArchitectConversationForPlanParams,
  ) => Promise<{
    conversationId: string | null;
    restoredTranscript: boolean;
    createdConversation: boolean;
  }>;
}): Promise<StrategyMutationDecision> => {
  const repairAttemptKey = [
    params.assistantMessageId,
    params.activePlan.id,
    params.source,
  ].join(":");
  const repairAttempted =
    (strategyMutationRepairAttempts.get(repairAttemptKey) || 0) > 0;

  params.getAppState().setStrategyMutationPreview(null);
  await persistArchitectPlanStrategyPreview({
    branchName: params.targetBranch,
    plan: params.activePlan,
    preview: null,
  });

  const preview = params.strategyService.prepareStrategyMutationPreview({
    source: params.source,
    plan: params.activePlan,
    candidateNodes: params.strategy.planNodes,
    tasks: params
      .getTaskState()
      .tasks.filter((task) => task.plan_id === params.activePlan.id)
      .map((task) => ({
        id: task.id,
        plan_id: task.plan_id ?? params.activePlan.id,
        status: task.status,
      })),
    metadataUpdate: params.metadataUpdate,
    metadataValidationConflicts: params.metadataUpdate?.validationConflicts,
    targetBranchesByProjectId: params.strategy.targetBranchesByProjectId,
    getProjectGitFlowSettings: (projectId) =>
      params.getAppState().getProjectById(projectId)?.gitFlowSettings,
    repairAttempted,
  });

  if (preview.status === "valid") {
    strategyMutationRepairAttempts.delete(repairAttemptKey);

    if (preview.requiresPreview) {
      params.getAppState().setStrategyMutationPreview(preview);
      await persistArchitectPlanStrategyPreview({
        branchName: params.targetBranch,
        plan: params.activePlan,
        preview,
      });
      return {
        outcome: "preview_staged",
        preview,
      };
    }

    const plan = await params.strategyService.applyStrategyMutationPreview(
      {
        preview,
        setActive: true,
      },
      params.strategyService.guardDeps,
    );
    params.getAppState().setStrategyMutationPreview(null);
    await persistArchitectPlanStrategyPreview({
      branchName: params.targetBranch,
      plan,
      preview: null,
    });
    try {
      await hydratePlanContext({
        targetBranch: params.targetBranch,
        planId: plan.id,
        planService: params.planService,
        getAppState: params.getAppState,
        ensureArchitectConversationForPlan: params.ensureArchitectConversationForPlan,
      });
    } catch (error) {
      if (!hasPostWriteReplicaWarning(plan) || !isArchitectPlanReplicaDivergenceError(error)) {
        throw error;
      }
    }
    await params.getTaskState().refreshFromPlan();
    return {
      outcome: "applied",
      preview,
      plan,
    };
  }

  if (!repairAttempted) {
    strategyMutationRepairAttempts.set(repairAttemptKey, 1);
    return {
      outcome: "repair_requested",
      preview,
    };
  }

  strategyMutationRepairAttempts.delete(repairAttemptKey);
  params.getAppState().setStrategyMutationPreview(preview);
  await persistArchitectPlanStrategyPreview({
    branchName: params.targetBranch,
    plan: params.activePlan,
    preview,
  });
  return {
    outcome: "blocked",
    preview,
  };
};

const getNeedForActivePlan = (
  needId: string,
  planId: string,
  needsState: ArchitectToolNeedsState,
): Need | null => {
  const need = needsState.getNeed(needId);
  if (!need || need.planId !== planId) {
    return null;
  }
  return need;
};

export const handleArchitectToolCall = async (
  params: ArchitectToolRuntimeDependencies,
): Promise<string | undefined> => {
  const {
    toolName,
    args,
    assistantMessageId,
    planService,
    strategyService,
  } = params;
  const appState = params.getAppState();

  if (toolName === "need_add") {
    const activePlanId = resolveActivePlanId(appState);
    if (!activePlanId) {
      return "Cannot need_add without an active plan. Create or select a plan first.";
    }

    const title = typeof args.title === "string" ? args.title.trim() : "";
    const description =
      typeof args.description === "string" ? args.description.trim() : "";
    const category =
      typeof args.category === "string"
        ? args.category.trim().toLowerCase()
        : "";
    const priority =
      typeof args.priority === "string"
        ? args.priority.trim().toLowerCase()
        : "";
    if (!title || !description || !category || !priority) {
      return "Missing required fields for need_add (title, description, category, priority).";
    }

    if (!ARCHITECT_NEED_CATEGORIES.has(category as NeedCategory)) {
      return `Invalid category for need_add: ${category}.`;
    }
    if (!ARCHITECT_NEED_PRIORITIES.has(priority as Need["priority"])) {
      return `Invalid priority for need_add: ${priority}.`;
    }

    const tags = normalizeNeedTags(args.tags);
    const needsState = params.getNeedsState();
    const id = needsState.addNeed({
      planId: activePlanId,
      title,
      description,
      category: category as NeedCategory,
      priority: priority as Need["priority"],
      tags,
      status: "identified",
      sourceMessageId: assistantMessageId,
    });
    await needsState.flushPendingPersistence?.(activePlanId);
    const totalNeeds = needsState.getNeedsForPlan(activePlanId).length;

    return formatArchitectNeedAddToolResult({
      planId: activePlanId,
      needId: id,
      title,
      category,
      priority,
      tags,
      totalNeeds,
    });
  }

  if (toolName === "need_list") {
    const activePlanId = resolveActivePlanId(appState);
    if (!activePlanId) {
      return "Cannot need_list without an active plan. Create or select a plan first.";
    }

    const status =
      typeof args.status === "string" ? args.status.trim().toLowerCase() : undefined;
    const category =
      typeof args.category === "string"
        ? args.category.trim().toLowerCase()
        : undefined;
    const priority =
      typeof args.priority === "string"
        ? args.priority.trim().toLowerCase()
        : undefined;
    const tag =
      typeof args.tag === "string" ? args.tag.trim().toLowerCase() : undefined;

    if (status && !ARCHITECT_NEED_STATUSES.has(status as NeedStatus)) {
      return `Invalid status for need_list: ${status}.`;
    }
    if (category && !ARCHITECT_NEED_CATEGORIES.has(category as NeedCategory)) {
      return `Invalid category for need_list: ${category}.`;
    }
    if (priority && !ARCHITECT_NEED_PRIORITIES.has(priority as Need["priority"])) {
      return `Invalid priority for need_list: ${priority}.`;
    }

    const filteredNeeds = params
      .getNeedsState()
      .getNeedsForPlan(activePlanId)
      .filter((need) => (status ? need.status === status : true))
      .filter((need) => (category ? need.category === category : true))
      .filter((need) => (priority ? need.priority === priority : true))
      .filter((need) => (tag ? need.tags.includes(tag) : true));

    return formatArchitectNeedListToolResult({
      planId: activePlanId,
      filters: { status, category, priority, tag },
      needs: filteredNeeds,
    });
  }

  if (toolName === "need_get") {
    const activePlanId = resolveActivePlanId(appState);
    if (!activePlanId) {
      return "Cannot need_get without an active plan. Create or select a plan first.";
    }

    const needId = typeof args.need_id === "string" ? args.need_id.trim() : "";
    if (!needId) {
      return "Missing need_id for need_get.";
    }

    const need = getNeedForActivePlan(needId, activePlanId, params.getNeedsState());
    if (!need) {
      return `Need ${needId} is unavailable on the active plan.`;
    }

    return formatArchitectNeedGetToolResult({
      planId: activePlanId,
      need,
    });
  }

  if (toolName === "need_update") {
    const activePlanId = resolveActivePlanId(appState);
    if (!activePlanId) {
      return "Cannot need_update without an active plan. Create or select a plan first.";
    }

    const needId = typeof args.need_id === "string" ? args.need_id.trim() : "";
    if (!needId) {
      return "Missing need_id for need_update.";
    }

    const needsState = params.getNeedsState();
    const existingNeed = getNeedForActivePlan(needId, activePlanId, needsState);
    if (!existingNeed) {
      return `Need ${needId} is unavailable on the active plan.`;
    }

    const updates: Partial<Need> = {};
    const changedFields: string[] = [];

    if (args.title !== undefined) {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) {
        return "Invalid title for need_update.";
      }
      updates.title = title;
      if (title !== existingNeed.title) {
        changedFields.push("title");
      }
    }

    if (args.description !== undefined) {
      const description =
        typeof args.description === "string" ? args.description.trim() : "";
      if (!description) {
        return "Invalid description for need_update.";
      }
      updates.description = description;
      if (description !== existingNeed.description) {
        changedFields.push("description");
      }
    }

    if (args.category !== undefined) {
      const category =
        typeof args.category === "string"
          ? args.category.trim().toLowerCase()
          : "";
      if (!ARCHITECT_NEED_CATEGORIES.has(category as NeedCategory)) {
        return `Invalid category for need_update: ${category}.`;
      }
      updates.category = category as NeedCategory;
      if (category !== existingNeed.category) {
        changedFields.push("category");
      }
    }

    if (args.priority !== undefined) {
      const priority =
        typeof args.priority === "string"
          ? args.priority.trim().toLowerCase()
          : "";
      if (!ARCHITECT_NEED_PRIORITIES.has(priority as Need["priority"])) {
        return `Invalid priority for need_update: ${priority}.`;
      }
      updates.priority = priority as Need["priority"];
      if (priority !== existingNeed.priority) {
        changedFields.push("priority");
      }
    }

    if (args.status !== undefined) {
      const status =
        typeof args.status === "string" ? args.status.trim().toLowerCase() : "";
      if (!ARCHITECT_NEED_STATUSES.has(status as NeedStatus)) {
        return `Invalid status for need_update: ${status}.`;
      }
      updates.status = status as NeedStatus;
      if (status !== existingNeed.status) {
        changedFields.push("status");
      }
    }

    if (args.tags !== undefined) {
      if (!Array.isArray(args.tags)) {
        return "Invalid tags for need_update. Expected an array of strings.";
      }
      const tags = normalizeNeedTags(args.tags);
      updates.tags = tags;
      if (JSON.stringify(tags) !== JSON.stringify(existingNeed.tags)) {
        changedFields.push("tags");
      }
    }

    if (Object.keys(updates).length === 0) {
      return "need_update requires at least one field to change.";
    }

    needsState.updateNeed(needId, updates);
    await needsState.flushPendingPersistence?.(activePlanId);
    const updatedNeed = getNeedForActivePlan(needId, activePlanId, needsState);
    if (!updatedNeed) {
      return `Need ${needId} became unavailable after update.`;
    }

    return formatArchitectNeedUpdateToolResult({
      planId: activePlanId,
      need: updatedNeed,
      changedFields,
    });
  }

  if (toolName === "need_delete") {
    const activePlanId = resolveActivePlanId(appState);
    if (!activePlanId) {
      return "Cannot need_delete without an active plan. Create or select a plan first.";
    }

    const needId = typeof args.need_id === "string" ? args.need_id.trim() : "";
    if (!needId) {
      return "Missing need_id for need_delete.";
    }
    if (args.confirm !== true) {
      return "need_delete requires confirm=true to proceed.";
    }

    const needsState = params.getNeedsState();
    const existingNeed = getNeedForActivePlan(needId, activePlanId, needsState);
    if (!existingNeed) {
      return `Need ${needId} is unavailable on the active plan.`;
    }

    needsState.deleteNeed(needId);
    await needsState.flushPendingPersistence?.(activePlanId);
    const remainingNeeds = needsState.getNeedsForPlan(activePlanId).length;
    return formatArchitectNeedDeleteToolResult({
      planId: activePlanId,
      needId,
      title: existingNeed.title,
      remainingNeeds,
    });
  }

  if (toolName === "plan_create") {
    if (args.status !== undefined && args.status !== "draft") {
      return "plan_create can only create draft plans in Architect chat.";
    }

    const targetBranch = resolveArchitectTargetBranch(
      args.target_branch,
      appState,
      planService,
    );
    const titleAlias =
      typeof args.title === "string" ? args.title.trim() : undefined;
    const label = typeof args.label === "string" ? args.label.trim() : undefined;
    const description =
      typeof args.description === "string" ? args.description : undefined;
    const projectIds = Array.isArray(args.project_ids)
      ? args.project_ids
          .filter((projectId): projectId is string => typeof projectId === "string")
          .map((projectId) => projectId.trim())
          .filter(Boolean)
      : getScopedActionableProjectIds(
          appState.projectGroups,
          appState.selectedGroupId,
          appState.selectedProjectId,
        );
    const contextProjectIds = Array.isArray(args.context_project_ids)
      ? args.context_project_ids
          .filter((projectId): projectId is string => typeof projectId === "string")
          .map((projectId) => projectId.trim())
          .filter(Boolean)
      : undefined;
    const gitFlowPlan =
      args.git_flow && typeof args.git_flow === "object" && !Array.isArray(args.git_flow)
        ? (args.git_flow as Partial<ArchitectPlanGitFlowMetadata>)
        : undefined;
    const setActive = args.set_active !== false;
    const createdPlan = await planService.createArchitectPlan({
      branchName: targetBranch,
      ...(titleAlias !== undefined ? { title: titleAlias } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(projectIds.length > 0
        ? { projectId: projectIds[0], projectIds }
        : {}),
      ...(contextProjectIds !== undefined ? { contextProjectIds } : {}),
      ...(gitFlowPlan !== undefined
        ? {
            planKind: gitFlowPlan.planKind,
            gitFlowPlan,
          }
        : {}),
      status: "draft",
      setActive,
    });

    if (setActive) {
      await appState.activateArchitectPlan(createdPlan.id, {
        targetBranch,
        persistActiveSelection: true,
      });
    }

    if (setActive) {
      await hydratePlanContext({
        targetBranch,
        planId: createdPlan.id,
        planService,
        getAppState: params.getAppState,
        ensureArchitectConversationForPlan: params.ensureArchitectConversationForPlan,
      });
    }

    return formatArchitectPlanCreateToolResult(
      createdPlan,
      resolveActivePlanId(params.getAppState()),
    );
  }

  if (toolName === "plan_list") {
    const targetBranch = resolveArchitectTargetBranch(
      args.target_branch,
      appState,
      planService,
    );
    const includeDeleted = args.include_deleted === true;
    const includeArchived = args.include_archived === true || includeDeleted;
    const plansIndex = await planService.listArchitectPlans(
      targetBranch,
      includeDeleted,
      includeArchived,
    );

    return formatArchitectPlanListToolResult({
      targetBranch,
      activePlanId: plansIndex.activePlanId,
      plans: plansIndex.plans,
    });
  }

  if (toolName === "plan_get") {
    const planId = typeof args.plan_id === "string" ? args.plan_id.trim() : "";
    if (!planId) {
      return "Missing plan_id for plan_get.";
    }
    const targetBranch = resolveArchitectTargetBranch(
      args.target_branch,
      appState,
      planService,
    );
    const plan = await planService.getArchitectPlan(targetBranch, planId);
    if (!plan || plan.status === "deleted") {
      return `Plan ${planId} is unavailable.`;
    }

    return formatArchitectPlanGetToolResult(plan);
  }

  if (toolName === "plan_update") {
    const planId = typeof args.plan_id === "string" ? args.plan_id.trim() : "";
    if (!planId) {
      return "Missing plan_id for plan_update.";
    }
    const targetBranch = resolveArchitectTargetBranch(
      args.target_branch,
      appState,
      planService,
    );
    const existingPlan = await planService.getArchitectPlan(targetBranch, planId);
    if (!existingPlan || existingPlan.status === "deleted") {
      return `Plan ${planId} is unavailable.`;
    }
    if (args.status !== undefined) {
      return "plan_update cannot modify plan status in Architect chat.";
    }
    if (args.set_active !== undefined) {
      return "plan_update cannot change the active plan in Architect chat. Ask the user to select the plan from the plan selector instead.";
    }

    const isCanonicalPlan = isCanonicalArchitectPlan(existingPlan);
    const titleAlias =
      typeof args.title === "string" ? args.title.trim() : undefined;
    const label = typeof args.label === "string" ? args.label.trim() : undefined;
    const slug =
      typeof args.slug === "string"
        ? args.slug.trim()
        : typeof args.plan_slug === "string"
          ? args.plan_slug.trim()
          : undefined;
    const projectIds = Array.isArray(args.project_ids)
      ? args.project_ids
          .filter((projectId): projectId is string => typeof projectId === "string")
          .map((projectId) => projectId.trim())
          .filter(Boolean)
      : undefined;
    const contextProjectIds = Array.isArray(args.context_project_ids)
      ? args.context_project_ids
          .filter((projectId): projectId is string => typeof projectId === "string")
          .map((projectId) => projectId.trim())
          .filter(Boolean)
      : undefined;
    const gitFlowPlan =
      args.git_flow && typeof args.git_flow === "object" && !Array.isArray(args.git_flow)
        ? (args.git_flow as Partial<ArchitectPlanGitFlowMetadata>)
        : undefined;
    const targetBranchesByProjectId =
      gitFlowPlan?.projects && typeof gitFlowPlan.projects === "object"
        ? Object.fromEntries(
            Object.entries(gitFlowPlan.projects)
              .map(([projectId, metadata]) => [
                projectId,
                typeof metadata?.targetBranch === "string"
                  ? metadata.targetBranch.trim()
                  : "",
              ])
              .filter(([, branchName]) => branchName.length > 0)
          )
        : undefined;
    const shouldPassTitleAlias =
      titleAlias !== undefined &&
      (!isCanonicalPlan ||
        titleAlias !== existingPlan.title ||
        label !== undefined);
    if (
      existingPlan.status !== "draft" &&
      (projectIds !== undefined || contextProjectIds !== undefined || gitFlowPlan !== undefined)
    ) {
      return "plan_update can change plan scope or Git workflow metadata only while the plan is a draft.";
    }

    if (
      hasPersistedArchitectStrategy(existingPlan) &&
      (projectIds !== undefined || contextProjectIds !== undefined || gitFlowPlan !== undefined)
    ) {
      return "plan_update cannot change plan scope or Git workflow metadata after strategy has been created.";
    }

    if (
      slug !== undefined &&
      slug.length > 0 &&
      !planService.isArchitectPlanSlugMutable(existingPlan) &&
      normalizePlanSlugInput(slug, existingPlan.slug || existingPlan.id) !==
        existingPlan.slug
    ) {
      return `Plan slug "${existingPlan.slug}" is locked and can no longer be changed.`;
    }

    const updatedPlan = await planService.updateArchitectPlan({
      branchName: targetBranch,
      planId,
      ...(shouldPassTitleAlias ? { title: titleAlias } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(slug !== undefined ? { slug } : {}),
      ...(typeof args.description === "string"
        ? { description: args.description }
        : {}),
      ...(projectIds !== undefined ? { projectIds } : {}),
      ...(contextProjectIds !== undefined ? { contextProjectIds } : {}),
      ...(gitFlowPlan !== undefined
        ? {
            planKind: existingPlan.planKind,
            gitFlowPlan,
            ...(targetBranchesByProjectId
              ? { targetBranchesByProjectId }
              : {}),
          }
        : {}),
    });

    if (resolveActivePlanId(params.getAppState()) === updatedPlan.id) {
      try {
        await hydratePlanContext({
          targetBranch,
          planId: updatedPlan.id,
          planService,
          getAppState: params.getAppState,
          ensureArchitectConversationForPlan: params.ensureArchitectConversationForPlan,
        });
      } catch (error) {
        if (!hasPostWriteReplicaWarning(updatedPlan) || !isArchitectPlanReplicaDivergenceError(error)) {
          throw error;
        }
      }
    }

    return formatArchitectPlanUpdateToolResult(
      updatedPlan,
      resolveActivePlanId(params.getAppState()),
    );
  }

  if (toolName === "plan_delete") {
    return "plan_delete is disabled in Architect chat. Ask the user to delete or archive the plan from the plan selector if needed.";
  }

  if (toolName === "plan_restore") {
    return "plan_restore is disabled in Architect chat. Ask the user to restore the plan from the plan selector if needed.";
  }

  if (toolName === "plan_set_active") {
    return "plan_set_active is disabled in Architect chat. Ask the user to select the plan from the plan selector.";
  }

  if (toolName === "strategy_generate") {
    const targetBranch = resolveArchitectTargetBranch(
      args.target_branch,
      appState,
      planService,
    );
    const activePlanId = resolveActivePlanId(appState);
    if (!activePlanId) {
      return "Cannot generate strategy without an active plan. Create or select a plan first.";
    }

    const rawNodes = Array.isArray(args.nodes) ? args.nodes : [];
    const inputPlanId =
      typeof args.plan_id === "string" ? args.plan_id.trim() : "";
    if (inputPlanId && inputPlanId !== activePlanId) {
      return `strategy_generate can only update the active plan (${activePlanId}).`;
    }
    await params.getNeedsState().flushPendingPersistence?.(activePlanId);

    const requestedPlanSlug =
      typeof args.plan_slug === "string"
        ? args.plan_slug.trim()
        : typeof args.planSlug === "string"
          ? args.planSlug.trim()
          : "";

    const activePlan = await planService.getArchitectPlan(
      targetBranch,
      activePlanId,
    );
    if (!activePlan || activePlan.status === "deleted") {
      return `Active plan ${activePlanId} is unavailable.`;
    }

    const strategy = await resolveStrategyForPlan({
      activePlan,
      nodesInput: rawNodes,
      requestedPlanSlug,
      planService,
      getAppState: params.getAppState,
    });

    const requestedPlanTitleAlias =
      typeof args.plan_title === "string" ? args.plan_title.trim() : undefined;
    const inputDescription =
      typeof args.plan_description === "string"
        ? args.plan_description
        : activePlan.description || "";
    const metadataUpdate = await buildArchitectStrategyMetadataUpdate({
      branchName: targetBranch,
      activePlan,
      requestedPlanSlug,
      requestedPlanTitleAlias,
      description: inputDescription,
      includeTitleAlias: requestedPlanTitleAlias !== undefined,
      planService,
    });
    const decision = await executeStrategyMutation({
      assistantMessageId,
      source: "strategy_generate",
      targetBranch,
      activePlan,
      strategy,
      metadataUpdate,
      planService,
      strategyService,
      getAppState: params.getAppState,
      getTaskState: params.getTaskState,
      ensureArchitectConversationForPlan: params.ensureArchitectConversationForPlan,
    });

    if (decision.outcome === "repair_requested") {
      return formatArchitectStrategyMutationRepairToolResult({
        planId: activePlanId,
        source: "strategy_generate",
        conflicts: decision.preview.conflicts,
        frozenNodes: decision.preview.frozenNodes,
      });
    }

    if (decision.outcome === "preview_staged" || decision.outcome === "blocked") {
      return formatArchitectStrategyMutationPreviewToolResult(decision.preview);
    }

    return formatArchitectStrategyGenerateToolResult({
      planId: activePlanId,
      planTitle: decision.plan.label || decision.plan.title,
      planDescription: decision.plan.description,
      planNodes: decision.plan.nodes,
      predictedBranches: decision.plan.predictedBranches,
      resolvedProjectIds: decision.preview.resolvedProjectIds,
      targetBranchesByProjectId: decision.preview.targetBranchesByProjectId,
      plan: decision.plan,
    });
  }

  if (toolName === "strategy_get") {
    const targetBranch = resolveArchitectTargetBranch(
      args.target_branch,
      appState,
      planService,
    );
    const activePlanId = resolveActivePlanId(appState);
    if (!activePlanId) {
      return "Cannot get strategy without an active plan. Create or select a plan first.";
    }
    const plan = await planService.getArchitectPlan(targetBranch, activePlanId);
    if (!plan || plan.status === "deleted") {
      return `Active plan ${activePlanId} is unavailable.`;
    }

    return formatArchitectStrategyGetToolResult(plan);
  }

  if (toolName === "strategy_update") {
    const targetBranch = resolveArchitectTargetBranch(
      args.target_branch,
      appState,
      planService,
    );
    const activePlanId = resolveActivePlanId(appState);
    if (!activePlanId) {
      return "Cannot update strategy without an active plan. Create or select a plan first.";
    }
    await params.getNeedsState().flushPendingPersistence?.(activePlanId);

    const activePlan = await planService.getArchitectPlan(
      targetBranch,
      activePlanId,
    );
    if (!activePlan || activePlan.status === "deleted") {
      return `Active plan ${activePlanId} is unavailable.`;
    }
    const requestedPlanSlug =
      typeof args.plan_slug === "string"
        ? args.plan_slug.trim()
        : typeof args.planSlug === "string"
          ? args.planSlug.trim()
          : "";

    const replace = args.replace === true;
    const rawNodes = Array.isArray(args.nodes) ? args.nodes : [];
    const rawOperations = Array.isArray(args.operations) ? args.operations : [];

    let nodesInput: unknown[] = [];
    if (replace || rawNodes.length > 0) {
      if (rawNodes.length === 0) {
        return "strategy_update with replace=true requires non-empty nodes.";
      }
      nodesInput = rawNodes;
    } else {
      if (rawOperations.length === 0) {
        return "strategy_update requires either nodes or operations.";
      }

      const working = activePlan.nodes.map(cloneArchitectStrategyWorkingNode);
      let idCounter = 0;
      for (const [index, rawOperation] of rawOperations.entries()) {
        const operation = (
          rawOperation && typeof rawOperation === "object" ? rawOperation : {}
        ) as Record<string, unknown>;
        const action =
          typeof operation.action === "string"
            ? operation.action.trim().toLowerCase()
            : "";
        const nodeId =
          typeof operation.node_id === "string"
            ? operation.node_id.trim()
            : "";
        const titleRef =
          typeof operation.title === "string" ? operation.title.trim() : "";
        const locateIndex = nodeId
          ? working.findIndex((node) => node.id === nodeId)
          : titleRef
            ? working.findIndex((node) => node.title === titleRef)
            : -1;

        if (action === "remove") {
          if (locateIndex < 0) {
            return `strategy_update remove failed at operation ${index + 1}: node not found.`;
          }
          const removedNode = working[locateIndex];
          working.splice(locateIndex, 1);
          working.forEach((node) => {
            node.dependencies = node.dependencies.filter(
              (dependencyId) => dependencyId !== removedNode.id,
            );
          });
          continue;
        }

        if (action === "update") {
          if (locateIndex < 0) {
            return `strategy_update update failed at operation ${index + 1}: node not found.`;
          }
          const target = working[locateIndex];
          const nextTitle =
            typeof operation.title === "string"
              ? operation.title.trim()
              : target.title;
          const nextDescription =
            typeof operation.description === "string"
              ? operation.description
              : target.description || "";
          const nextTypeRaw =
            typeof operation.type === "string"
              ? operation.type.trim().toLowerCase()
              : target.type;
          const nextStatusRaw =
            typeof operation.status === "string"
              ? operation.status.trim().toLowerCase()
              : target.status;
          const nextBranchRaw =
            typeof operation.assignedBranch === "string"
              ? operation.assignedBranch.trim()
              : target.assignedBranch || "work";
          const nextBranchTypeRaw =
            typeof operation.branchType === "string"
              ? operation.branchType.trim().toLowerCase()
              : target.branchType;
          const nextBranchSlugRaw =
            typeof operation.featureSlug === "string"
              ? operation.featureSlug.trim()
              : typeof operation.feature_slug === "string"
                ? operation.feature_slug.trim()
                : typeof operation.branchSlug === "string"
                  ? operation.branchSlug.trim()
                  : target.branchSlug;
          const nextDependencies = Array.isArray(operation.dependencies)
            ? operation.dependencies
                .filter((dep): dep is string => typeof dep === "string")
                .map((dep) => dep.trim())
                .filter(Boolean)
            : target.dependencies;
          const nextProjectIds = normalizeArchitectStrategyOperationProjectIds(
            operation,
            target,
          );

          if (!ARCHITECT_STRATEGY_NODE_TYPES.has(nextTypeRaw as PlanNodeType)) {
            return `strategy_update update failed at operation ${index + 1}: invalid type ${nextTypeRaw}.`;
          }
          if (
            !ARCHITECT_STRATEGY_NODE_STATUSES.has(
              nextStatusRaw as PlanNodeStatus,
            )
          ) {
            return `strategy_update update failed at operation ${index + 1}: invalid status ${nextStatusRaw}.`;
          }

          const nextBranchIntent = getPlanNodeBranchIntent({
            branchType: nextBranchTypeRaw,
            branchSlug: nextBranchSlugRaw,
            assignedBranch: nextBranchRaw,
            title: nextTitle || target.title,
          });

          working[locateIndex] = {
            ...target,
            title: nextTitle || target.title,
            description: nextDescription,
            type: nextTypeRaw as PlanNodeType,
            status: nextStatusRaw as PlanNodeStatus,
            assignedBranch: nextBranchIntent.label,
            branchType: nextBranchIntent.branchType,
            branchSlug: nextBranchIntent.branchSlug,
            dependencies: Array.from(new Set(nextDependencies)),
            projectId: nextProjectIds[0],
            projectIds: nextProjectIds,
          };
          continue;
        }

        if (action === "add") {
          const normalized = normalizeArchitectStrategyNodeInput(
            operation,
            index,
          );
          const normalizedProjectIds =
            normalizeArchitectStrategyOperationProjectIds(operation);
          idCounter += 1;
          working.push({
            id: `node-${Date.now()}-${idCounter}`,
            title: normalized.title,
            description: normalized.description,
            type: normalized.type,
            status: normalized.status,
            assignedBranch: normalized.assignedBranch,
            branchType: normalized.branchType,
            branchSlug: normalized.branchSlug,
            dependencies: normalized.dependencies,
            projectId: normalizedProjectIds[0],
            projectIds: normalizedProjectIds,
          });
          continue;
        }

        return `strategy_update failed at operation ${index + 1}: unsupported action "${action}".`;
      }

      nodesInput = working.map((node) =>
        serializeArchitectStrategyNodeForResolution(node),
      );
    }

    const strategy = await resolveStrategyForPlan({
      activePlan,
      nodesInput,
      requestedPlanSlug,
      reuseExistingIds: !replace,
      existingNodesForPatch: activePlan.nodes,
      planService,
      getAppState: params.getAppState,
    });
    const decision = await executeStrategyMutation({
      assistantMessageId,
      source: "strategy_update",
      targetBranch,
      activePlan,
      strategy,
      metadataUpdate: await buildArchitectStrategyMetadataUpdate({
        branchName: targetBranch,
        activePlan,
        requestedPlanSlug,
        description: activePlan.description,
        planService,
      }),
      planService,
      strategyService,
      getAppState: params.getAppState,
      getTaskState: params.getTaskState,
      ensureArchitectConversationForPlan: params.ensureArchitectConversationForPlan,
    });

    if (decision.outcome === "repair_requested") {
      return formatArchitectStrategyMutationRepairToolResult({
        planId: activePlanId,
        source: "strategy_update",
        conflicts: decision.preview.conflicts,
        frozenNodes: decision.preview.frozenNodes,
      });
    }

    if (decision.outcome === "preview_staged" || decision.outcome === "blocked") {
      return formatArchitectStrategyMutationPreviewToolResult(decision.preview);
    }

    return formatArchitectStrategyUpdateToolResult({
      planId: activePlanId,
      planNodes: decision.plan.nodes,
      predictedBranches: decision.plan.predictedBranches,
      plan: decision.plan,
    });
  }

  if (toolName === "strategy_delete") {
    const targetBranch = resolveArchitectTargetBranch(
      args.target_branch,
      appState,
      planService,
    );
    const activePlanId = resolveActivePlanId(appState);
    if (!activePlanId) {
      return "Cannot delete strategy without an active plan. Create or select a plan first.";
    }

    if (args.confirm !== true) {
      return "strategy_delete requires confirm=true to proceed.";
    }

    const activePlan = await planService.getArchitectPlan(
      targetBranch,
      activePlanId,
    );
    if (!activePlan || activePlan.status === "deleted") {
      return `Active plan ${activePlanId} is unavailable.`;
    }

    await planService.updateArchitectPlan({
      branchName: targetBranch,
      planId: activePlanId,
      description: activePlan.description,
      status: activePlan.status,
      nodes: [],
      predictedBranches: [],
      projectId: activePlan.projectId,
      setActive: true,
    });

    await hydratePlanContext({
      targetBranch,
      planId: activePlanId,
      planService,
      getAppState: params.getAppState,
      ensureArchitectConversationForPlan: params.ensureArchitectConversationForPlan,
    });
    return formatArchitectStrategyDeleteToolResult({
      planId: activePlanId,
    });
  }

  return undefined;
};
