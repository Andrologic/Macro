import type {
  PlanNode,
  PredictedBranch,
  ProjectGitFlowSettings,
  TaskStatus,
} from "../types";
import {
  getArchitectPlanEffectiveTargetBranchesByProjectId,
  getArchitectPlan,
  updateArchitectPlan,
  type ArchitectPlanRecord,
  type ArchitectPlanStatus,
} from "./architectPlanService";
import { provisionPlanBranches } from "./architectGitFlowService";
import {
  collectRenderedPlanPredictedBranchDescriptors,
  getPredictedBranchLogicalIdentity,
} from "./architectBranchIdentity";
import {
  getPlanNodeBranchIntent,
} from "./gitFlowBranchIntents";
import {
  normalizeNodeProjectIds,
  normalizeStrategyDependencies,
} from "./implementTaskDerivation";

const BRANCH_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
] as const;

const STARTED_TASK_STATUSES = new Set<TaskStatus>([
  "InProgress",
  "AwaitingResponse",
  "InReview",
]);
const NON_REGENERABLE_PLAN_STATUSES = new Set<ArchitectPlanStatus>([
  "completed",
  "archived",
  "deleted",
]);

export type FrozenPlanNodeReason =
  | "started"
  | "completed"
  | "dependency_locked";

export interface FrozenPlanNode {
  id: string;
  title: string;
  reason: FrozenPlanNodeReason;
  status: PlanNode["status"];
  dependencies: string[];
  projectIds: string[];
  node: PlanNode;
}

export interface StrategyMutationChangeSummary {
  id: string;
  title: string;
}

export interface StrategyMutationPreview {
  planId: string;
  planTitle: string;
  source: "strategy_generate" | "strategy_update";
  status: "valid" | "blocked";
  requiresPreview: boolean;
  repairAttempted: boolean;
  baseRevision: number | null;
  targetBranch: string;
  nextPlanStatus: ArchitectPlanStatus;
  autoProvisionBranches: boolean;
  metadataUpdate: {
    title?: string;
    label?: string;
    slug?: string;
    description: string;
  };
  resolvedProjectIds: string[];
  targetBranchesByProjectId: Record<string, string>;
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  frozenNodes: FrozenPlanNode[];
  rewrittenPendingNodes: StrategyMutationChangeSummary[];
  newNodes: StrategyMutationChangeSummary[];
  removedPendingNodes: StrategyMutationChangeSummary[];
  conflicts: string[];
}

export type StrategyMutationDecision =
  | {
      outcome: "applied";
      preview: StrategyMutationPreview;
      plan: ArchitectPlanRecord;
    }
  | {
      outcome: "repair_requested";
      preview: StrategyMutationPreview;
    }
  | {
      outcome: "preview_staged";
      preview: StrategyMutationPreview;
    }
  | {
      outcome: "blocked";
      preview: StrategyMutationPreview;
    };

export interface StrategyMutationTaskLike {
  id: string;
  plan_id?: string | null;
  status: TaskStatus;
}

export interface PrepareStrategyMutationPreviewParams {
  source: "strategy_generate" | "strategy_update";
  plan: ArchitectPlanRecord;
  candidateNodes: PlanNode[];
  tasks?: StrategyMutationTaskLike[];
  metadataUpdate?: {
    title?: string;
    label?: string;
    slug?: string;
    description?: string;
  };
  metadataValidationConflicts?: string[];
  targetBranchesByProjectId?: Record<string, string>;
  getProjectGitFlowSettings?: (
    projectId: string,
  ) => ProjectGitFlowSettings | undefined;
  repairAttempted?: boolean;
}

export interface ApplyStrategyMutationPreviewParams {
  preview: StrategyMutationPreview;
  setActive?: boolean;
}

export interface StrategyMutationGuardDeps {
  getArchitectPlan: typeof getArchitectPlan;
  updateArchitectPlan: typeof updateArchitectPlan;
  provisionPlanBranches: typeof provisionPlanBranches;
}

export const getDefaultStrategyMutationGuardDeps = (): StrategyMutationGuardDeps => ({
  getArchitectPlan,
  updateArchitectPlan,
  provisionPlanBranches,
});

const unique = (items: string[]): string[] =>
  Array.from(new Set(items.filter((item) => item.trim().length > 0)));

const priorityByFrozenReason: Record<FrozenPlanNodeReason, number> = {
  dependency_locked: 0,
  started: 1,
  completed: 2,
};

const resolveNodeTaskStatus = (
  node: PlanNode,
  taskStatusById: Map<string, TaskStatus>,
): TaskStatus => {
  const taskStatus = taskStatusById.get(node.id);
  if (taskStatus) {
    return taskStatus;
  }
  if (node.status === "completed") return "Completed";
  if (node.status === "in-progress") return "InProgress";
  if (node.status === "blocked") return "Blocked";
  return "Pending";
};

const getFrozenRootReason = (
  node: PlanNode,
  taskStatusById: Map<string, TaskStatus>,
): FrozenPlanNodeReason | null => {
  const status = resolveNodeTaskStatus(node, taskStatusById);
  if (status === "Completed") return "completed";
  if (STARTED_TASK_STATUSES.has(status) || node.status === "in-progress") {
    return "started";
  }
  return null;
};

const toFrozenPlanNode = (
  node: PlanNode,
  reason: FrozenPlanNodeReason,
): FrozenPlanNode => ({
  id: node.id,
  title: node.title,
  reason,
  status: node.status,
  dependencies: [...node.dependencies],
  projectIds: normalizeNodeProjectIds(node),
  node: {
    ...node,
    dependencies: [...node.dependencies],
    projectIds: normalizeNodeProjectIds(node),
    projectId: normalizeNodeProjectIds(node)[0],
  },
});

const buildNodeSemanticSnapshot = (node: PlanNode) => ({
  id: node.id,
  title: node.title.trim(),
  description: (node.description || '').trim(),
  type: node.type,
  status: node.status,
  assignedBranch: getPlanNodeBranchIntent(node).label,
  branchType: getPlanNodeBranchIntent(node).branchType,
  branchSlug: getPlanNodeBranchIntent(node).branchSlug,
  projectIds: [...normalizeNodeProjectIds(node)].sort(),
  dependencies: [...unique(node.dependencies)].sort(),
  archivedAt: typeof node.archivedAt === 'string' ? node.archivedAt : null,
  archiveReason: typeof node.archiveReason === 'string' ? node.archiveReason : null,
  mergedAt: typeof node.mergedAt === 'string' ? node.mergedAt : null,
});

const arePlanNodesSemanticallyEqual = (
  left: PlanNode,
  right: PlanNode,
): boolean =>
  JSON.stringify(buildNodeSemanticSnapshot(left)) ===
  JSON.stringify(buildNodeSemanticSnapshot(right));

const buildUniqueTitleIndex = (
  nodes: PlanNode[],
): Map<string, PlanNode | null> => {
  const index = new Map<string, PlanNode | null>();
  nodes.forEach((node) => {
    if (!index.has(node.title)) {
      index.set(node.title, node);
      return;
    }
    index.set(node.title, null);
  });
  return index;
};

const buildUniqueFrozenTitleIndex = (
  frozenNodes: FrozenPlanNode[],
): Map<string, FrozenPlanNode | null> => {
  const index = new Map<string, FrozenPlanNode | null>();
  frozenNodes.forEach((node) => {
    if (!index.has(node.title)) {
      index.set(node.title, node);
      return;
    }
    index.set(node.title, null);
  });
  return index;
};

const assertAcyclic = (nodes: PlanNode[]): string | null => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string): string | null => {
    if (visiting.has(nodeId)) {
      return nodeById.get(nodeId)?.title || nodeId;
    }
    if (visited.has(nodeId)) {
      return null;
    }

    visiting.add(nodeId);
    const node = nodeById.get(nodeId);
    if (node) {
      for (const dependencyId of node.dependencies) {
        if (!nodeById.has(dependencyId)) {
          return node.title;
        }
        const cycleNode = visit(dependencyId);
        if (cycleNode) {
          return cycleNode;
        }
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return null;
  };

  for (const node of nodes) {
    const cycleNode = visit(node.id);
    if (cycleNode) {
      return cycleNode;
    }
  }

  return null;
};

const createFreshNodeId = (
  baseId: string,
  reservedIds: Set<string>,
): string => {
  let attempt = `regenerated-${baseId}`;
  let index = 1;
  while (reservedIds.has(attempt)) {
    attempt = `regenerated-${baseId}-${index}`;
    index += 1;
  }
  return attempt;
};

const createStablePredictedBranchId = (projectId: string, branchKey: string): string =>
  `branch-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${branchKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}`;

const buildPredictedBranchesForMutation = (params: {
  plan: Pick<ArchitectPlanRecord, "slug" | "title" | "predictedBranches">;
  nodes: PlanNode[];
  planSlug?: string;
  getProjectGitFlowSettings?: (
    projectId: string,
  ) => ProjectGitFlowSettings | undefined;
}): PredictedBranch[] => {
  const planSlug = params.planSlug || params.plan.slug || params.plan.title;
  const renderedBranches = collectRenderedPlanPredictedBranchDescriptors({
    nodes: params.nodes,
    planSlug,
    getProjectGitFlowSettings: params.getProjectGitFlowSettings,
  });
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

  const existingByKey = new Map(
    (params.plan.predictedBranches || []).map((branch) => [
      `${branch.projectId}::${getPredictedBranchLogicalIdentity({
        planSlug,
        branch,
        settings: params.getProjectGitFlowSettings?.(branch.projectId),
      }).key}`,
      branch,
    ]),
  );

  return renderedBranches.map((branch, index) => {
    const existing = existingByKey.get(branch.key);
    return {
      id:
        existing?.id ||
        createStablePredictedBranchId(branch.projectId, branch.key),
      name: branch.name,
      color: existing?.color || BRANCH_COLORS[index % BRANCH_COLORS.length],
      parentBranch: branch.parentBranch,
      projectId: branch.projectId,
      taskIds: unique(branch.taskIds),
      status: resolveBranchStatus(branch.taskIds),
      branchType: branch.branchType,
      branchSlug: branch.branchSlug,
    };
  });
};

export const formatFrozenPlanNodeReason = (
  reason: FrozenPlanNodeReason,
): string => {
  if (reason === "completed") return "completed";
  if (reason === "dependency_locked") return "dependency_locked";
  return "started";
};

export const buildFrozenPlanNodeMap = (params: {
  plan: Pick<ArchitectPlanRecord, "id" | "nodes">;
  tasks?: StrategyMutationTaskLike[];
}): Map<string, FrozenPlanNode> => {
  const taskStatusById = new Map<string, TaskStatus>();
  (params.tasks || [])
    .filter(
      (task) => !task.plan_id || task.plan_id === params.plan.id,
    )
    .forEach((task) => {
      taskStatusById.set(task.id, task.status);
    });

  const nodeById = new Map(
    params.plan.nodes.map((node) => [
      node.id,
      {
        ...node,
        dependencies: [...node.dependencies],
        projectIds: normalizeNodeProjectIds(node),
        projectId: normalizeNodeProjectIds(node)[0],
      },
    ]),
  );
  const frozenById = new Map<string, FrozenPlanNode>();

  const freezeNode = (nodeId: string, reason: FrozenPlanNodeReason) => {
    const node = nodeById.get(nodeId);
    if (!node) return;
    const existing = frozenById.get(nodeId);
    if (
      existing &&
      priorityByFrozenReason[existing.reason] >= priorityByFrozenReason[reason]
    ) {
      return;
    }
    frozenById.set(nodeId, toFrozenPlanNode(node, reason));
  };

  const freezeAncestors = (nodeId: string, seen = new Set<string>()) => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);

    const node = nodeById.get(nodeId);
    if (!node) return;
    node.dependencies.forEach((dependencyId) => {
      const dependencyNode = nodeById.get(dependencyId);
      if (!dependencyNode) return;
      const rootReason = getFrozenRootReason(dependencyNode, taskStatusById);
      freezeNode(dependencyId, rootReason || "dependency_locked");
      freezeAncestors(dependencyId, seen);
    });
  };

  params.plan.nodes.forEach((node) => {
    const rootReason = getFrozenRootReason(node, taskStatusById);
    if (!rootReason) return;
    freezeNode(node.id, rootReason);
    freezeAncestors(node.id);
  });

  return frozenById;
};

const buildBlockedPreview = (
  params: PrepareStrategyMutationPreviewParams,
  frozenNodes: FrozenPlanNode[],
  conflicts: string[],
): StrategyMutationPreview => {
  const currentProjectIds = unique(
    params.plan.nodes.flatMap((node) => normalizeNodeProjectIds(node)),
  );
  const resolvedProjectIds =
    currentProjectIds.length > 0
      ? currentProjectIds
      : unique([
          ...(params.plan.projectIds || []),
          ...(params.plan.projectId ? [params.plan.projectId] : []),
        ]);
  const targetBranchesByProjectId = getArchitectPlanEffectiveTargetBranchesByProjectId(
    {
      ...params.plan,
      projectId: resolvedProjectIds[0],
      projectIds: resolvedProjectIds,
      targetBranchesByProjectId:
        params.targetBranchesByProjectId || params.plan.targetBranchesByProjectId,
    },
    {
      getProjectGitFlowSettings: params.getProjectGitFlowSettings,
      fallbackTargetBranch: params.plan.targetBranch,
    },
  );
  return {
    planId: params.plan.id,
    planTitle: params.plan.label || params.plan.title,
    source: params.source,
    status: "blocked",
    requiresPreview: true,
    repairAttempted: params.repairAttempted === true,
    baseRevision: params.plan.revision || null,
    targetBranch: params.plan.targetBranch,
    nextPlanStatus: params.plan.status,
    autoProvisionBranches: false,
    metadataUpdate: {
      ...(params.metadataUpdate?.title ? { title: params.metadataUpdate.title } : {}),
      ...(params.metadataUpdate?.label ? { label: params.metadataUpdate.label } : {}),
      ...(params.metadataUpdate?.slug ? { slug: params.metadataUpdate.slug } : {}),
      description:
        params.metadataUpdate?.description ?? params.plan.description,
    },
    resolvedProjectIds,
    targetBranchesByProjectId,
    planNodes: params.plan.nodes.map((node) => ({
      ...node,
      dependencies: [...node.dependencies],
      projectIds: normalizeNodeProjectIds(node),
      projectId: normalizeNodeProjectIds(node)[0],
    })),
    predictedBranches: params.plan.predictedBranches.map((branch) => ({
      ...branch,
      taskIds: [...branch.taskIds],
    })),
    frozenNodes,
    rewrittenPendingNodes: [],
    newNodes: [],
    removedPendingNodes: [],
    conflicts,
  };
};

export const prepareStrategyMutationPreview = (
  params: PrepareStrategyMutationPreviewParams,
): StrategyMutationPreview => {
  const frozenMap = buildFrozenPlanNodeMap({
    plan: params.plan,
    tasks: params.tasks,
  });
  const frozenNodes = params.plan.nodes
    .map((node) => frozenMap.get(node.id))
    .filter((node): node is FrozenPlanNode => Boolean(node));

  if (NON_REGENERABLE_PLAN_STATUSES.has(params.plan.status)) {
    return buildBlockedPreview(params, frozenNodes, [
      `Plan ${params.plan.id} is ${params.plan.status} and cannot be regenerated.`,
    ]);
  }

  if ((params.metadataValidationConflicts?.length || 0) > 0) {
    return buildBlockedPreview(
      params,
      frozenNodes,
      params.metadataValidationConflicts || [],
    );
  }

  const candidateById = new Map(
    params.candidateNodes.map((node) => [node.id, node]),
  );
  const candidateByTitle = buildUniqueTitleIndex(params.candidateNodes);
  const frozenConflicts: string[] = [];

  frozenNodes.forEach((frozenNode) => {
    const matchedCandidate =
      candidateById.get(frozenNode.id) ||
      candidateByTitle.get(frozenNode.title) ||
      null;
    if (!matchedCandidate) {
      frozenConflicts.push(
        `Frozen node "${frozenNode.title}" (${formatFrozenPlanNodeReason(frozenNode.reason)}) is missing from the candidate strategy.`,
      );
      return;
    }
    if (!arePlanNodesSemanticallyEqual(matchedCandidate, frozenNode.node)) {
      frozenConflicts.push(
        `Frozen node "${frozenNode.title}" (${formatFrozenPlanNodeReason(frozenNode.reason)}) must be preserved verbatim, including id, status, branch, projects, and dependencies.`,
      );
    }
  });

  if (frozenConflicts.length > 0) {
    return buildBlockedPreview(params, frozenNodes, frozenConflicts);
  }

  const frozenIds = new Set(frozenNodes.map((node) => node.id));
  const existingNodeIds = new Set(params.plan.nodes.map((node) => node.id));
  const currentEditableNodes = params.plan.nodes
    .filter((node) => !frozenIds.has(node.id))
    .map((node) => ({
      ...node,
      dependencies: [...node.dependencies],
      projectIds: normalizeNodeProjectIds(node),
      projectId: normalizeNodeProjectIds(node)[0],
    }));
  const currentEditableById = new Map(
    currentEditableNodes.map((node) => [node.id, node]),
  );
  const currentEditableByTitle = buildUniqueTitleIndex(currentEditableNodes);
  const frozenByTitle = buildUniqueFrozenTitleIndex(frozenNodes);
  const reservedIds = new Set(frozenIds);
  const candidateIdToFinalId = new Map<string, string>();

  const finalNodes = params.candidateNodes.map((candidateNode) => {
    const frozenNode =
      frozenMap.get(candidateNode.id) || frozenByTitle.get(candidateNode.title);
    if (frozenNode) {
      candidateIdToFinalId.set(candidateNode.id, frozenNode.id);
      reservedIds.add(frozenNode.id);
      return {
        ...frozenNode.node,
        dependencies: [...frozenNode.node.dependencies],
        projectIds: normalizeNodeProjectIds(frozenNode.node),
        projectId: normalizeNodeProjectIds(frozenNode.node)[0],
      };
    }

    const reusableExisting = currentEditableByTitle.get(candidateNode.title);
    let nextId = reusableExisting?.id || candidateNode.id;
    if (
      !reusableExisting &&
      (reservedIds.has(nextId) || existingNodeIds.has(nextId))
    ) {
      nextId = createFreshNodeId(nextId, reservedIds);
    }
    reservedIds.add(nextId);
    candidateIdToFinalId.set(candidateNode.id, nextId);
    const normalizedProjectIds = normalizeNodeProjectIds(candidateNode);
    return {
      ...candidateNode,
      id: nextId,
      dependencies: [...candidateNode.dependencies],
      projectIds: normalizedProjectIds,
      projectId: normalizedProjectIds[0],
    };
  });

  finalNodes.forEach((node) => {
    node.dependencies = unique(
      node.dependencies.map(
        (dependencyId) =>
          candidateIdToFinalId.get(dependencyId) || dependencyId,
      ),
    ).filter((dependencyId) => dependencyId !== node.id);
  });

  const preNormalizationDiff = {
    rewrittenPendingNodes: finalNodes
      .filter((node) => currentEditableById.has(node.id))
      .filter((node) => {
        const previous = currentEditableById.get(node.id);
        return previous ? !arePlanNodesSemanticallyEqual(previous, node) : false;
      })
      .map((node) => ({ id: node.id, title: node.title })),
    newNodes: finalNodes
      .filter((node) => !frozenIds.has(node.id))
      .filter((node) => !currentEditableById.has(node.id))
      .map((node) => ({ id: node.id, title: node.title })),
    removedPendingNodes: currentEditableNodes
      .filter((node) => !finalNodes.some((candidate) => candidate.id === node.id))
      .map((node) => ({ id: node.id, title: node.title })),
  };

  const cycleNode = assertAcyclic(finalNodes);
  if (cycleNode) {
    return {
      ...buildBlockedPreview(params, frozenNodes, [
        `Strategy mutation would create a dependency cycle near "${cycleNode}".`,
      ]),
      ...preNormalizationDiff,
    };
  }

  const targetPlanSlug =
    params.metadataUpdate?.slug || params.plan.slug || params.plan.title;
  const rebuiltPredictedBranches = buildPredictedBranchesForMutation({
    plan: params.plan,
    nodes: finalNodes,
    planSlug: targetPlanSlug,
    getProjectGitFlowSettings: params.getProjectGitFlowSettings,
  });
  const normalized = normalizeStrategyDependencies(
    finalNodes,
    rebuiltPredictedBranches,
    {
      planSlug: targetPlanSlug,
    },
  );
  const expectedRenderedBranches = buildPredictedBranchesForMutation({
    plan: params.plan,
    nodes: normalized.nodes,
    planSlug: targetPlanSlug,
    getProjectGitFlowSettings: params.getProjectGitFlowSettings,
  });
  const expectedRenderedBranchByKey = new Map(
    expectedRenderedBranches.map((branch) => [
      `${branch.projectId}::${getPredictedBranchLogicalIdentity({
        planSlug: targetPlanSlug,
        branch,
        settings: params.getProjectGitFlowSettings?.(branch.projectId),
      }).key}`,
      branch,
    ]),
  );
  const staleRenderedBranchConflicts = normalized.predictedBranches
    .map((branch) => {
      const expected = expectedRenderedBranchByKey.get(
        `${branch.projectId}::${getPredictedBranchLogicalIdentity({
          planSlug: targetPlanSlug,
          branch,
          settings: params.getProjectGitFlowSettings?.(branch.projectId),
        }).key}`,
      );
      if (!expected) {
        return null;
      }
      if (
        expected.name === branch.name &&
        (expected.parentBranch || null) === (branch.parentBranch || null)
      ) {
        return null;
      }
      return `Predicted branch "${branch.name}" must be regenerated for plan slug "${targetPlanSlug}".`;
    })
    .filter((value): value is string => Boolean(value));

  if (staleRenderedBranchConflicts.length > 0) {
    return {
      ...buildBlockedPreview(params, frozenNodes, staleRenderedBranchConflicts),
      ...preNormalizationDiff,
    };
  }
  const postNormalizationCycleNode = assertAcyclic(normalized.nodes);
  if (postNormalizationCycleNode) {
    return {
      ...buildBlockedPreview(params, frozenNodes, [
        `Normalized strategy would create a dependency cycle near "${postNormalizationCycleNode}".`,
      ]),
      ...preNormalizationDiff,
    };
  }

  const frozenMutationConflicts = frozenNodes
    .filter((frozenNode) => {
      const normalizedNode = normalized.nodes.find(
        (node) => node.id === frozenNode.id,
      );
      return !normalizedNode || !arePlanNodesSemanticallyEqual(normalizedNode, frozenNode.node);
    })
    .map(
      (frozenNode) =>
        `Strategy normalization would modify frozen node "${frozenNode.title}" (${formatFrozenPlanNodeReason(frozenNode.reason)}).`,
    );

  if (frozenMutationConflicts.length > 0) {
    return {
      ...buildBlockedPreview(params, frozenNodes, frozenMutationConflicts),
      ...preNormalizationDiff,
    };
  }

  const resolvedProjectIds = unique(
    normalized.nodes.flatMap((node) => normalizeNodeProjectIds(node)),
  );
  const nextPlanStatus: ArchitectPlanStatus =
    frozenNodes.length > 0 ? "in_progress" : params.plan.status;
  const targetBranchesByProjectId = getArchitectPlanEffectiveTargetBranchesByProjectId(
    {
      ...params.plan,
      projectId: resolvedProjectIds[0],
      projectIds: resolvedProjectIds,
      targetBranchesByProjectId:
        params.targetBranchesByProjectId || params.plan.targetBranchesByProjectId,
    },
    {
      getProjectGitFlowSettings: params.getProjectGitFlowSettings,
      fallbackTargetBranch: params.plan.targetBranch,
    },
  );

  return {
    planId: params.plan.id,
    planTitle: params.plan.label || params.plan.title,
    source: params.source,
    status: "valid",
    requiresPreview:
      frozenNodes.length > 0 || params.repairAttempted === true,
    repairAttempted: params.repairAttempted === true,
    baseRevision: params.plan.revision || null,
    targetBranch: params.plan.targetBranch,
    nextPlanStatus,
    autoProvisionBranches:
      params.plan.status === "validated" || params.plan.status === "in_progress",
    metadataUpdate: {
      ...(params.metadataUpdate?.title ? { title: params.metadataUpdate.title } : {}),
      ...(params.metadataUpdate?.label ? { label: params.metadataUpdate.label } : {}),
      ...(params.metadataUpdate?.slug ? { slug: params.metadataUpdate.slug } : {}),
      description:
        params.metadataUpdate?.description ?? params.plan.description,
    },
    resolvedProjectIds,
    targetBranchesByProjectId,
    planNodes: normalized.nodes,
    predictedBranches: normalized.predictedBranches,
    frozenNodes,
    rewrittenPendingNodes: preNormalizationDiff.rewrittenPendingNodes,
    newNodes: preNormalizationDiff.newNodes,
    removedPendingNodes: preNormalizationDiff.removedPendingNodes,
    conflicts: [],
  };
};

export const applyStrategyMutationPreview = async (
  params: ApplyStrategyMutationPreviewParams,
  deps: StrategyMutationGuardDeps = getDefaultStrategyMutationGuardDeps(),
): Promise<ArchitectPlanRecord> => {
  if (params.preview.status !== "valid") {
    throw new Error("Cannot apply a blocked strategy preview.");
  }

  const currentPlan = await deps.getArchitectPlan(
    params.preview.targetBranch,
    params.preview.planId,
  );
  if (!currentPlan || currentPlan.status === "deleted") {
    throw new Error(`Plan ${params.preview.planId} is unavailable.`);
  }

  if (
    params.preview.baseRevision !== null &&
    currentPlan.revision &&
    currentPlan.revision !== params.preview.baseRevision
  ) {
    throw new Error(
      "The plan changed after this preview was generated. Discard the preview and regenerate it.",
    );
  }

  const nextPlan: ArchitectPlanRecord = {
    ...currentPlan,
    description: params.preview.metadataUpdate.description,
    ...(params.preview.metadataUpdate.title
      ? { title: params.preview.metadataUpdate.title }
      : {}),
    ...(params.preview.metadataUpdate.label
      ? { label: params.preview.metadataUpdate.label }
      : {}),
    ...(params.preview.metadataUpdate.slug
      ? { slug: params.preview.metadataUpdate.slug }
      : {}),
    status: params.preview.nextPlanStatus,
    projectId: params.preview.resolvedProjectIds[0],
    projectIds: params.preview.resolvedProjectIds,
    targetBranchesByProjectId: params.preview.targetBranchesByProjectId,
    nodes: params.preview.planNodes,
    predictedBranches: params.preview.predictedBranches,
  };

  if (params.preview.autoProvisionBranches) {
    await deps.provisionPlanBranches(nextPlan);
  }

  const updatedPlan = await deps.updateArchitectPlan({
    branchName: params.preview.targetBranch,
    planId: params.preview.planId,
    description: params.preview.metadataUpdate.description,
    ...(params.preview.metadataUpdate.title
      ? { title: params.preview.metadataUpdate.title }
      : {}),
    ...(params.preview.metadataUpdate.label
      ? { label: params.preview.metadataUpdate.label }
      : {}),
    ...(params.preview.metadataUpdate.slug
      ? { slug: params.preview.metadataUpdate.slug }
      : {}),
    status: params.preview.nextPlanStatus,
    nodes: params.preview.planNodes,
    predictedBranches: params.preview.predictedBranches,
    projectId: params.preview.resolvedProjectIds[0],
    projectIds: params.preview.resolvedProjectIds,
    targetBranchesByProjectId: params.preview.targetBranchesByProjectId,
    setActive: params.setActive !== false,
  });

  return {
    ...updatedPlan,
    status: params.preview.nextPlanStatus,
    projectId: params.preview.resolvedProjectIds[0],
    projectIds: params.preview.resolvedProjectIds,
    targetBranchesByProjectId: params.preview.targetBranchesByProjectId,
    description: params.preview.metadataUpdate.description,
    ...(params.preview.metadataUpdate.title
      ? { title: params.preview.metadataUpdate.title }
      : {}),
    ...(params.preview.metadataUpdate.label
      ? { label: params.preview.metadataUpdate.label }
      : {}),
    ...(params.preview.metadataUpdate.slug
      ? { slug: params.preview.metadataUpdate.slug }
      : {}),
    nodes: params.preview.planNodes,
    predictedBranches: params.preview.predictedBranches,
  };
};
