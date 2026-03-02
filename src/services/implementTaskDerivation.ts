import type { PlanNode, PlanNodeStatus, PredictedBranch, Task, TaskStatus } from '../types';

const BRANCH_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

const normalizeBranchName = (value?: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || 'work';
};

const unique = (items: string[]): string[] => Array.from(new Set(items));

const makeBranchId = (name: string): string => {
  const normalized = name
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

export const toBranchWorktreeKey = (branchName: string): string => {
  const normalized = normalizeBranchName(branchName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 42);
  return `branch-${normalized || 'work'}-${stableHash(branchName)}`;
};

export const mapNodeStatusToTaskStatus = (status: PlanNodeStatus): TaskStatus => {
  if (status === 'completed') return 'Completed';
  if (status === 'in-progress') return 'InProgress';
  if (status === 'blocked') return 'Blocked';
  return 'Pending';
};

export const mapTaskStatusToNodeStatus = (status: TaskStatus): PlanNodeStatus => {
  if (status === 'Completed') return 'completed';
  if (status === 'InProgress' || status === 'AwaitingResponse') return 'in-progress';
  if (status === 'Blocked' || status === 'Failed') return 'blocked';
  return 'pending';
};

export interface DerivedImplementTask extends Task {
  assigned_branch: string;
  branch_name: string;
  branch_id: string | null;
  branch_task_index: number;
  blocked_by_task_ids: string[];
  blocked_by: string[];
  is_blocked: boolean;
  is_ready: boolean;
  sequence_index: number;
}

export interface NormalizedStrategyResult {
  nodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  branchTaskOrder: Record<string, string[]>;
}

const toBranchTaskOrder = (
  nodes: PlanNode[],
  predictedBranches: PredictedBranch[]
): Map<string, string[]> => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const orderByBranch = new Map<string, string[]>();

  for (const branch of predictedBranches) {
    const branchName = normalizeBranchName(branch.name);
    const orderedIds = branch.taskIds.filter((taskId) => nodeById.has(taskId));
    const deduped = unique(orderedIds);

    for (const taskId of deduped) {
      const node = nodeById.get(taskId);
      if (node) {
        node.assignedBranch = branchName;
      }
    }

    if (!orderByBranch.has(branchName)) {
      orderByBranch.set(branchName, deduped);
      continue;
    }

    const existing = orderByBranch.get(branchName)!;
    for (const taskId of deduped) {
      if (!existing.includes(taskId)) {
        existing.push(taskId);
      }
    }
  }

  for (const node of nodes) {
    const branchName = normalizeBranchName(node.assignedBranch);
    node.assignedBranch = branchName;

    if (!orderByBranch.has(branchName)) {
      orderByBranch.set(branchName, []);
    }

    const branchOrder = orderByBranch.get(branchName)!;
    if (!branchOrder.includes(node.id)) {
      branchOrder.push(node.id);
    }
  }

  return orderByBranch;
};

const normalizePredictedBranches = (
  nodes: PlanNode[],
  predictedBranches: PredictedBranch[],
  branchTaskOrder: Map<string, string[]>
): PredictedBranch[] => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const normalized: PredictedBranch[] = [];
  const seenNames = new Set<string>();

  for (const branch of predictedBranches) {
    const branchName = normalizeBranchName(branch.name);
    const taskIds = branchTaskOrder.get(branchName) || [];
    normalized.push({
      ...branch,
      name: branchName,
      taskIds,
    });
    seenNames.add(branchName);
  }

  let colorIndex = normalized.length;
  for (const [branchName, taskIds] of branchTaskOrder.entries()) {
    if (seenNames.has(branchName)) continue;

    const firstNode = nodeById.get(taskIds[0]);
    normalized.push({
      id: makeBranchId(branchName),
      name: branchName,
      color: BRANCH_COLORS[colorIndex % BRANCH_COLORS.length],
      parentBranch: null,
      projectId: firstNode?.projectId || '',
      taskIds,
      status: 'pending',
    });
    colorIndex += 1;
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
  predictedBranchesInput: PredictedBranch[]
): NormalizedStrategyResult => {
  const clonedNodes: PlanNode[] = nodesInput.map((node) => ({
    ...node,
    assignedBranch: normalizeBranchName(node.assignedBranch),
    dependencies: [...node.dependencies],
  }));
  const nodeIds = new Set(clonedNodes.map((node) => node.id));

  for (const node of clonedNodes) {
    node.dependencies = unique(
      node.dependencies.filter((dependencyId) => dependencyId !== node.id && nodeIds.has(dependencyId))
    );
  }

  const predictedBranches = predictedBranchesInput.map((branch) => ({
    ...branch,
    name: normalizeBranchName(branch.name),
    taskIds: [...branch.taskIds],
  }));

  const branchTaskOrder = toBranchTaskOrder(clonedNodes, predictedBranches);
  applySequentialBranchDependencies(clonedNodes, branchTaskOrder);

  const normalizedPredictedBranches = normalizePredictedBranches(
    clonedNodes,
    predictedBranches,
    branchTaskOrder
  );

  return {
    nodes: clonedNodes,
    predictedBranches: normalizedPredictedBranches,
    branchTaskOrder: Object.fromEntries(branchTaskOrder.entries()),
  };
};

const finalizeTaskStatus = (status: TaskStatus, blockedByTaskIds: string[]): TaskStatus => {
  if (blockedByTaskIds.length > 0) {
    if (status === 'Completed' || status === 'InProgress' || status === 'AwaitingResponse') {
      return status;
    }
    return 'Blocked';
  }

  if (status === 'Blocked') {
    return 'Pending';
  }

  return status;
};

export const deriveImplementTasksFromStrategy = (params: {
  planId: string;
  nodes: PlanNode[];
  predictedBranches: PredictedBranch[];
}): {
  tasks: DerivedImplementTask[];
  nodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  branchTaskOrder: Record<string, string[]>;
} => {
  const normalized = normalizeStrategyDependencies(params.nodes, params.predictedBranches);
  const branchByName = new Map(normalized.predictedBranches.map((branch) => [branch.name, branch]));

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
    const branchName = normalizeBranchName(node.assignedBranch);
    const branch = branchByName.get(branchName) || null;
    const branchTaskIndex = normalized.branchTaskOrder[branchName]?.indexOf(node.id) ?? -1;
    const status = mapNodeStatusToTaskStatus(node.status);

    return {
      id: node.id,
      plan_id: params.planId,
      project_id: node.projectId || branch?.projectId || '',
      title: node.title,
      description: node.description || '',
      status,
      dependencies: [...node.dependencies],
      estimated_changes: [],
      assigned_branch: branchName,
      branch_name: branchName,
      branch_id: branch?.id ?? null,
      branch_task_index: branchTaskIndex,
      blocked_by_task_ids: [],
      blocked_by: [],
      is_blocked: false,
      is_ready: status !== 'Completed' && status !== 'Failed',
      sequence_index: sequenceOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER,
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
    const isReady = !isBlocked && status !== 'Completed' && status !== 'Failed';

    return {
      ...task,
      status,
      blocked_by_task_ids: blockedByTaskIds,
      blocked_by: blockedBy,
      is_blocked: isBlocked,
      is_ready: isReady,
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
