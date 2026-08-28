import type {
  PlanNode,
  PlanNodeArtifactContract,
  PlanNodeTodo,
  PlanNodeStatus,
  PredictedBranch,
  Task,
  TaskExecutionTarget,
  TaskStatus,
} from '../types';
import { toTaskRuntimeId } from './durableIdentity';
import {
  buildPlanFeatureBranchKey,
  getPlanNodeLogicalBranchIdentity,
  getPredictedBranchLogicalIdentity,
  renderPlanFeatureBranchName,
  resolvePlanNodeTaskBranchIntents,
} from './architectBranchIdentity';
import {
  getPlanNodeBranchIntent,
  getPredictedBranchIntent,
  getPredictedBranchIntentKey,
} from './gitFlowBranchIntents';
import { normalizePlanNodeTodos } from './planNodeTodos';

const BRANCH_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

const normalizeBranchName = (value?: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || 'work';
};

const unique = (items: string[]): string[] => Array.from(new Set(items.filter((item) => item.trim().length > 0)));

const makeBranchId = (name: string, projectId?: string): string => {
  const normalized = `${projectId || 'shared'}-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return `branch-${normalized || 'work'}`;
};

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const normalizeProjectId = (value?: string | null): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizedProjectId = (projectId: string): string =>
  projectId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 16) || 'project';

export const normalizeNodeProjectIds = (node: Pick<PlanNode, 'projectId' | 'projectIds'>): string[] => {
  const projectIds = Array.isArray(node.projectIds) ? node.projectIds : [];
  return unique([
    ...projectIds.filter((projectId): projectId is string => typeof projectId === 'string'),
    ...(node.projectId ? [node.projectId] : []),
  ]);
};

export const toBranchCacheKey = (projectId: string, branchName: string): string => {
  return `${projectId}::${normalizeBranchName(branchName)}`;
};

export const toBranchWorktreeKey = (projectId: string, branchName: string): string => {
  const normalized = normalizeBranchName(branchName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 32);
  return `branch-${normalizedProjectId(projectId)}-${normalized || 'work'}-${stableHash(`${projectId}:${branchName}`)}`;
};

export { toPlanIntegrationWorktreeKey } from './planIntegrationWorktreeService';

export const mapNodeStatusToTaskStatus = (status: PlanNodeStatus): TaskStatus => {
  if (status === 'completed') return 'Completed';
  if (status === 'in-progress') return 'InProgress';
  if (status === 'blocked') return 'Blocked';
  return 'Pending';
};

export const mapTaskStatusToNodeStatus = (status: TaskStatus): PlanNodeStatus => {
  if (status === 'Completed') return 'completed';
  if (status === 'InProgress' || status === 'AwaitingResponse' || status === 'InReview') return 'in-progress';
  if (status === 'Blocked' || status === 'Failed') return 'blocked';
  return 'pending';
};

export const resolvePlanNodeTaskStatus = (node: Pick<PlanNode, 'status' | 'executionStatus'>): TaskStatus => {
  const persistedStatus = node.executionStatus;
  if (persistedStatus && mapTaskStatusToNodeStatus(persistedStatus) === node.status) {
    return persistedStatus;
  }
  return mapNodeStatusToTaskStatus(node.status);
};

export const applyTaskStatusToPlanNodes = (
  nodes: PlanNode[],
  taskId: string,
  status: TaskStatus,
): PlanNode[] => nodes.map((node) =>
  node.id === taskId
    ? { ...node, status: mapTaskStatusToNodeStatus(status), executionStatus: status }
    : node
);

export interface DerivedImplementTask extends Task {
  node_id?: string;
  artifact_contracts?: PlanNodeArtifactContract[];
  assigned_branch: string;
  branch_name: string;
  branch_id: string | null;
  branch_task_index: number;
  blocked_by_task_ids: string[];
  blocked_by: string[];
  is_blocked: boolean;
  is_ready: boolean;
  needs_revalidation: boolean;
  sequence_index: number;
  execution_targets: TaskExecutionTarget[];
  todos?: PlanNodeTodo[];
}

export interface NormalizedStrategyResult {
  nodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  branchTaskOrder: Record<string, string[]>;
}

const getNodeBranchKey = (node: PlanNode, planSlug?: string): string => {
  if (planSlug?.trim()) {
    return getPlanNodeLogicalBranchIdentity({
      planSlug,
      node,
    }).key;
  }
  return getPlanNodeBranchIntent(node).key;
};

const getLegacyNodeBranchKey = (node: PlanNode, planSlug?: string): string => {
  const branchIntent = getPlanNodeBranchIntent(node);
  if (planSlug?.trim()) {
    return buildPlanFeatureBranchKey(planSlug, branchIntent.branchSlug);
  }
  return branchIntent.key;
};

const getPredictedBranchKey = (
  branch: PredictedBranch,
  planSlug?: string,
): string => {
  if (planSlug?.trim()) {
    const logicalIdentity = getPredictedBranchLogicalIdentity({
      planSlug,
      branch,
    });
    if (logicalIdentity.kind !== 'unknown') {
      return logicalIdentity.key;
    }
  }
  return getPredictedBranchIntentKey(branch);
};

const getLegacyPredictedBranchKey = (
  branch: PredictedBranch,
  planSlug?: string,
): string => {
  const branchIntent = getPredictedBranchIntent(branch);
  if (planSlug?.trim()) {
    return buildPlanFeatureBranchKey(planSlug, branchIntent.branchSlug);
  }
  return branchIntent.key;
};

const toBranchTaskOrder = (
  nodes: PlanNode[],
  predictedBranches: PredictedBranch[],
  planSlug?: string,
  options?: {
    taskScoped?: boolean;
  },
): Map<string, string[]> => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const orderByBranch = new Map<string, string[]>();
  const taskScoped = options?.taskScoped !== false;

  for (const branch of predictedBranches) {
    const branchName = normalizeBranchName(branch.name);
    const orderedIds = branch.taskIds.filter((taskId) => nodeById.has(taskId));
    const deduped = unique(orderedIds);
    if (taskScoped && deduped.length !== 1) {
      continue;
    }
    const branchNode = taskScoped ? nodeById.get(deduped[0]) : null;
    const branchKey = taskScoped && branchNode
      ? getNodeBranchKey(branchNode, planSlug)
      : getLegacyPredictedBranchKey(branch, planSlug);

    for (const taskId of deduped) {
      const node = nodeById.get(taskId);
      if (node && !node.branchType && !node.branchSlug) {
        node.assignedBranch = branchName;
      }
    }

    if (!orderByBranch.has(branchKey)) {
      orderByBranch.set(branchKey, deduped);
      continue;
    }

    const existing = orderByBranch.get(branchKey)!;
    for (const taskId of deduped) {
      if (!existing.includes(taskId)) {
        existing.push(taskId);
      }
    }
  }

  for (const node of nodes) {
    const branchIntent = getPlanNodeBranchIntent(node);
    const branchKey = taskScoped
      ? getNodeBranchKey(node, planSlug)
      : getLegacyNodeBranchKey(node, planSlug);
    node.assignedBranch = node.assignedBranch ? normalizeBranchName(node.assignedBranch) : branchIntent.label;
    node.branchType = branchIntent.branchType;
    node.branchSlug = branchIntent.branchSlug;

    if (!orderByBranch.has(branchKey)) {
      orderByBranch.set(branchKey, []);
    }

    const branchOrder = orderByBranch.get(branchKey)!;
    if (!branchOrder.includes(node.id)) {
      branchOrder.push(node.id);
    }
  }

  return orderByBranch;
};

const normalizePredictedBranches = (
  nodes: PlanNode[],
  predictedBranches: PredictedBranch[],
  branchTaskOrder: Map<string, string[]>,
  planSlug?: string
): PredictedBranch[] => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const resolveBranchStatus = (taskIds: string[]): PredictedBranch['status'] => {
    const branchNodes = taskIds
      .map((taskId) => nodeById.get(taskId))
      .filter((node): node is PlanNode => Boolean(node));
    if (branchNodes.length > 0 && branchNodes.every((node) => node.status === 'completed')) {
      return 'merged';
    }
    if (branchNodes.some((node) => node.status === 'in-progress')) {
      return 'active';
    }
    return 'pending';
  };
  const normalized: PredictedBranch[] = [];
  const seenKeys = new Set<string>();
  const legacyBranchByProjectAndTask = new Map<string, PredictedBranch>();
  for (const branch of predictedBranches) {
    for (const taskId of unique(branch.taskIds)) {
      legacyBranchByProjectAndTask.set(`${branch.projectId}::${taskId}`, branch);
    }
  }

  for (const branch of predictedBranches) {
    const branchIntent = getPredictedBranchIntent(branch);
    const branchName = normalizeBranchName(branch.name);
    const projectId = normalizeProjectId(branch.projectId);
    if (!projectId) continue;

    const branchKey = getPredictedBranchKey(branch, planSlug);
    const taskIds = branchTaskOrder.get(branchKey) || [];
    if (taskIds.length === 0) continue;
    const cacheKey = `${projectId}::${branchKey}`;
    if (seenKeys.has(cacheKey)) {
      const existing = normalized.find(
        (candidate) =>
          `${candidate.projectId}::${getPredictedBranchKey(candidate, planSlug)}` === cacheKey
      );
      if (existing) {
        existing.taskIds = unique([...existing.taskIds, ...taskIds]);
        existing.status = resolveBranchStatus(existing.taskIds);
      }
      continue;
    }

    normalized.push({
      ...branch,
      name: branchName,
      projectId,
      taskIds,
      status: resolveBranchStatus(taskIds),
      branchType: branchIntent.branchType,
      branchSlug: branchIntent.branchSlug,
    });
    seenKeys.add(cacheKey);
  }

  let colorIndex = normalized.length;
  for (const [branchKey, taskIds] of branchTaskOrder.entries()) {
    const projectIds = unique(
      taskIds.flatMap((taskId) => {
        const node = nodeById.get(taskId);
        return node ? normalizeNodeProjectIds(node) : [];
      })
    );
    const firstNode = taskIds.map((taskId) => nodeById.get(taskId)).find(Boolean) || null;
    const branchIntent = firstNode ? getPlanNodeBranchIntent(firstNode) : null;
    const branchName =
      branchIntent && planSlug
        ? renderPlanFeatureBranchName({
            planSlug,
            featureSlug: branchIntent.branchSlug,
          })
        : branchIntent?.label || branchKey;
    const branchStatus = resolveBranchStatus(taskIds);

    for (const projectId of projectIds) {
      const cacheKey = `${projectId}::${branchKey}`;
      if (seenKeys.has(cacheKey)) continue;
      const legacyBranch = taskIds.length === 1
        ? legacyBranchByProjectAndTask.get(`${projectId}::${taskIds[0]}`)
        : null;

      normalized.push({
        id: makeBranchId(branchName, projectId),
        name: branchName,
        color: BRANCH_COLORS[colorIndex % BRANCH_COLORS.length],
        parentBranch: legacyBranch?.parentBranch || null,
        projectId,
        taskIds,
        status: branchStatus,
        branchType: branchIntent?.branchType,
        branchSlug: branchIntent?.branchSlug,
      });
      colorIndex += 1;
      seenKeys.add(cacheKey);
    }
  }

  return normalized;
};

const applySequentialBranchDependencies = (
  nodes: PlanNode[],
  branchTaskOrder: Map<string, string[]>
): void => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const hasDependencyPath = (fromId: string, toId: string, seen = new Set<string>()): boolean => {
    if (fromId === toId) return true;
    if (seen.has(fromId)) return false;
    seen.add(fromId);

    const node = nodeById.get(fromId);
    if (!node) return false;

    for (const dependencyId of node.dependencies) {
      if (hasDependencyPath(dependencyId, toId, seen)) {
        return true;
      }
    }

    return false;
  };

  for (const orderedTaskIds of branchTaskOrder.values()) {
    for (let index = 1; index < orderedTaskIds.length; index += 1) {
      const currentTaskId = orderedTaskIds[index];
      const previousTaskId = orderedTaskIds[index - 1];
      const currentNode = nodeById.get(currentTaskId);
      if (!currentNode) continue;

      if (hasDependencyPath(previousTaskId, currentTaskId)) {
        continue;
      }

      if (!currentNode.dependencies.includes(previousTaskId)) {
        currentNode.dependencies = [...currentNode.dependencies, previousTaskId];
      }
    }
  }
};

export const normalizeStrategyDependencies = (
  nodesInput: PlanNode[],
  predictedBranchesInput: PredictedBranch[],
  options?: {
    planSlug?: string;
  }
): NormalizedStrategyResult => {
  const planSlug = options?.planSlug?.trim() || undefined;
  const clonedNodes: PlanNode[] = nodesInput.map((node) => {
    const projectIds = normalizeNodeProjectIds(node);
    const branchIntent = getPlanNodeBranchIntent(node);
    return {
      ...node,
      assignedBranch: normalizeBranchName(node.assignedBranch) || branchIntent.label,
      branchType: branchIntent.branchType,
      branchSlug: branchIntent.branchSlug,
      dependencies: [...node.dependencies],
      projectId: projectIds[0],
      projectIds,
    };
  });
  const nodeIds = new Set(clonedNodes.map((node) => node.id));

  for (const node of clonedNodes) {
    node.dependencies = unique(
      node.dependencies.filter((dependencyId) => dependencyId !== node.id && nodeIds.has(dependencyId))
    );
  }

  const predictedBranches = predictedBranchesInput
    .map((branch) => {
      const branchIntent = getPredictedBranchIntent(branch);
      return {
        ...branch,
        name: normalizeBranchName(branch.name) || branchIntent.label,
        projectId: normalizeProjectId(branch.projectId) || '',
        taskIds: [...branch.taskIds],
        branchType: branchIntent.branchType,
        branchSlug: branchIntent.branchSlug,
      };
    })
    .filter((branch) => branch.projectId.length > 0);

  const legacyBranchTaskOrder = toBranchTaskOrder(
    clonedNodes,
    predictedBranches,
    planSlug,
    { taskScoped: false },
  );
  applySequentialBranchDependencies(clonedNodes, legacyBranchTaskOrder);

  const taskBranchIntents = resolvePlanNodeTaskBranchIntents(clonedNodes);
  clonedNodes.forEach((node) => {
    const branchIntent = taskBranchIntents.get(node.id) || getPlanNodeBranchIntent(node);
    node.assignedBranch = branchIntent.label;
    node.branchType = branchIntent.branchType;
    node.branchSlug = branchIntent.branchSlug;
  });

  const branchTaskOrder = toBranchTaskOrder(
    clonedNodes,
    predictedBranches,
    planSlug,
    { taskScoped: true },
  );

  const normalizedPredictedBranches = normalizePredictedBranches(
    clonedNodes,
    predictedBranches,
    branchTaskOrder,
    planSlug,
  );

  return {
    nodes: clonedNodes,
    predictedBranches: normalizedPredictedBranches,
    branchTaskOrder: Object.fromEntries(branchTaskOrder.entries()),
  };
};

const finalizeTaskStatus = (status: TaskStatus, blockedByTaskIds: string[]): TaskStatus => {
  if (blockedByTaskIds.length > 0) {
    if (
      status === 'Completed' ||
      status === 'InProgress' ||
      status === 'AwaitingResponse' ||
      status === 'InReview' ||
      status === 'Failed'
    ) {
      return status;
    }
    return 'Blocked';
  }

  if (status === 'Blocked') {
    return 'Pending';
  }

  return status;
};

const shouldFlagTaskForRevalidation = (status: TaskStatus, blockedByTaskIds: string[]): boolean =>
  blockedByTaskIds.length > 0 &&
  (status === 'Completed' ||
    status === 'InProgress' ||
    status === 'AwaitingResponse' ||
    status === 'InReview' ||
    status === 'Failed');

const buildExecutionTargets = (
  node: PlanNode,
  predictedBranches: PredictedBranch[],
  planBranchName: string | undefined,
  targetBranchesByProjectId?: Record<string, string>,
  planSlug?: string
): TaskExecutionTarget[] => {
  const branchIntent = getPlanNodeBranchIntent(node);
  const projectIds = normalizeNodeProjectIds(node);
  const branchKey = getNodeBranchKey(node, planSlug);

  return projectIds.map((projectId) => {
    const predictedBranch = predictedBranches.find(
      (branch) =>
        branch.projectId === projectId &&
        getPredictedBranchKey(branch, planSlug) === branchKey
    );
    const executionMode = node.executionModesByProjectId?.[projectId];
    const branchName = executionMode === 'direct'
      ? ''
      : predictedBranch?.name || normalizeBranchName(node.assignedBranch) || branchIntent.label;

    return {
      projectId,
      branchName,
      targetBranchName: executionMode === 'direct'
        ? undefined
        : targetBranchesByProjectId?.[projectId],
      executionMode,
      executionKind: executionMode === 'direct' ? 'repository_root' : 'worktree',
      worktreeKey: executionMode === 'direct'
        ? `direct:${projectId}:${node.id}`
        : toBranchWorktreeKey(projectId, branchName),
      planBranchName: executionMode === 'direct'
        ? undefined
        : predictedBranch?.parentBranch || planBranchName || undefined,
      predictedBranchId: executionMode === 'direct' ? null : predictedBranch?.id ?? null,
    };
  });
};

export const deriveImplementTasksFromStrategy = (params: {
  planId: string;
  runtimeBranchName?: string;
  planSlug?: string;
  nodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  targetBranchesByProjectId?: Record<string, string>;
}): {
  tasks: DerivedImplementTask[];
  nodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  branchTaskOrder: Record<string, string[]>;
} => {
  const normalized = normalizeStrategyDependencies(params.nodes, params.predictedBranches, {
    planSlug: params.planSlug,
  });
  const branchByProjectAndName = new Map(
    normalized.predictedBranches.map((branch) => [
      `${branch.projectId}::${getPredictedBranchKey(branch, params.planSlug)}`,
      branch,
    ])
  );
  const planBranchName = normalized.predictedBranches[0]?.parentBranch || undefined;

  const sequenceOrder = new Map<string, number>();
  let nextOrder = 0;
  for (const branch of normalized.predictedBranches) {
    for (const taskId of branch.taskIds) {
      if (!sequenceOrder.has(taskId)) {
        sequenceOrder.set(taskId, nextOrder);
        nextOrder += 1;
      }
    }
  }
  for (const node of normalized.nodes) {
    if (!sequenceOrder.has(node.id)) {
      sequenceOrder.set(node.id, nextOrder);
      nextOrder += 1;
    }
  }

  const initialTasks: DerivedImplementTask[] = normalized.nodes.map((node) => {
    const branchIntent = getPlanNodeBranchIntent(node);
    const branchKey = getNodeBranchKey(node, params.planSlug);
    const executionTargets = buildExecutionTargets(
      node,
      normalized.predictedBranches,
      planBranchName,
      params.targetBranchesByProjectId,
      params.planSlug,
    );
    const primaryTarget = executionTargets[0] || null;
    const branch = primaryTarget
      ? branchByProjectAndName.get(`${primaryTarget.projectId}::${branchKey}`) || null
      : null;
    const branchName = primaryTarget?.branchName || normalizeBranchName(node.assignedBranch) || branchIntent.label;
    const branchTaskIndex = normalized.branchTaskOrder[branchKey]?.indexOf(node.id) ?? -1;
    const status = resolvePlanNodeTaskStatus(node);
    const projectIds = executionTargets.map((target) => target.projectId);

    const runtimeId = params.runtimeBranchName
      ? toTaskRuntimeId({ branchName: params.runtimeBranchName, planId: params.planId, nodeId: node.id })
      : node.id;
    return {
      id: runtimeId,
      node_id: node.id,
      plan_id: params.planId,
      project_id: projectIds[0] || node.projectId || '',
      project_ids: projectIds,
      title: node.title,
      description: node.description || '',
      status,
      dependencies: params.runtimeBranchName
        ? node.dependencies.map((nodeId) => toTaskRuntimeId({
            branchName: params.runtimeBranchName!, planId: params.planId, nodeId,
          }))
        : [...node.dependencies],
      estimated_changes: [],
      assigned_branch: branchName,
      branch_name: branchName,
      branch_id: branch?.id ?? null,
      branch_task_index: branchTaskIndex,
      blocked_by_task_ids: [],
      blocked_by: [],
      is_blocked: false,
      is_ready: status !== 'Completed' && status !== 'Failed' && status !== 'InReview',
      needs_revalidation: false,
      sequence_index: sequenceOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER,
      execution_targets: executionTargets,
      todos: normalizePlanNodeTodos(node.todos),
      artifact_contracts: (node.artifactContracts || []).map((contract) => ({ ...contract })),
    };
  });

  const taskById = new Map(initialTasks.map((task) => [task.id, task]));
  const finalized = initialTasks.map((task) => {
    const blockedByTaskIds = task.dependencies.filter((dependencyId) => {
      const dependencyTask = taskById.get(dependencyId);
      return dependencyTask ? dependencyTask.status !== 'Completed' : false;
    });
    const blockedBy = blockedByTaskIds
      .map((dependencyId) => taskById.get(dependencyId)?.title)
      .filter((title): title is string => Boolean(title));

    const status = finalizeTaskStatus(task.status, blockedByTaskIds);
    const isBlocked = blockedByTaskIds.length > 0;
    const isReady = !isBlocked && status !== 'Completed' && status !== 'Failed' && status !== 'InReview';
    const needsRevalidation = shouldFlagTaskForRevalidation(status, blockedByTaskIds);

    return {
      ...task,
      status,
      blocked_by_task_ids: blockedByTaskIds,
      blocked_by: blockedBy,
      is_blocked: isBlocked,
      is_ready: isReady,
      needs_revalidation: needsRevalidation,
    };
  });

  finalized.sort((a, b) => a.sequence_index - b.sequence_index);

  return {
    tasks: finalized,
    nodes: normalized.nodes,
    predictedBranches: normalized.predictedBranches,
    branchTaskOrder: normalized.branchTaskOrder,
  };
};
