import type { PlanNode, PredictedBranch, Project, ProjectGroup, TaskExecutionTarget } from '../types';
import { getAllProjects, getScopedProjectIds } from './globalProjects';
import { toBranchWorktreeKey } from './implementTaskDerivation';

type ProjectReplicaRef = {
  projectId: string | null;
};

export type ProjectRegistryRef = {
  projects?: Project[];
  standaloneProjects?: Project[];
  projectGroups?: ProjectGroup[];
};

export type PlanExecutionScopeRef = {
  projectId?: string | null;
  projectIds?: string[];
  availableProjectIds?: string[];
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  replicas?: ProjectReplicaRef[];
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
};

export type TaskExecutionScopeRef = {
  id?: string;
  project_id: string;
  project_ids?: string[];
  context_project_ids?: string[];
  execution_targets?: TaskExecutionTarget[];
};

export type ProjectExecutionReconciliationScope = {
  scopedProjectIds?: string[] | null;
  knownProjectIds: string[];
  knownProjects?: Project[];
};

export type ProjectSelectionReconciliationScope = {
  standaloneProjects?: Project[];
  projectGroups: ProjectGroup[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
};

export const normalizeExecutionProjectIds = (
  values: Array<string | null | undefined>
): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  values.forEach((value) => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  });

  return normalized;
};

export const collectKnownProjects = (registry: ProjectRegistryRef): Project[] => {
  const byId = new Map<string, Project>();
  [
    ...(registry.projects ?? []),
    ...getAllProjects({
      standaloneProjects: registry.standaloneProjects ?? [],
      projectGroups: registry.projectGroups ?? [],
    }),
  ].forEach((project) => {
    if (project.id && !byId.has(project.id)) {
      byId.set(project.id, project);
    }
  });
  return Array.from(byId.values());
};

export const collectKnownProjectIds = (registry: ProjectRegistryRef): string[] =>
  collectKnownProjects(registry).map((project) => project.id);

const collectReplicaProjectIds = (replicas?: ProjectReplicaRef[]): string[] =>
  normalizeExecutionProjectIds(
    (replicas ?? []).map((replica) => replica.projectId)
  );

export const resolveExecutionProjectIds = (params: {
  persistedIds?: Array<string | null | undefined>;
  availableProjectIds?: string[];
  replicas?: ProjectReplicaRef[];
  scopedProjectIds?: string[] | null;
  knownProjectIds: string[];
}): string[] => {
  const knownProjectIdSet = new Set(normalizeExecutionProjectIds(params.knownProjectIds));
  const scopedProjectIds = normalizeExecutionProjectIds(params.scopedProjectIds ?? [])
    .filter((projectId) => knownProjectIdSet.has(projectId));
  const scopedProjectIdSet = new Set(scopedProjectIds);
  const validPersistedIds = normalizeExecutionProjectIds(params.persistedIds ?? [])
    .filter((projectId) => knownProjectIdSet.has(projectId));
  if (validPersistedIds.length > 0) {
    return validPersistedIds;
  }

  const physicalProjectIds = normalizeExecutionProjectIds([
    ...(params.availableProjectIds ?? []),
    ...collectReplicaProjectIds(params.replicas),
  ]).filter((projectId) => knownProjectIdSet.has(projectId));
  const scopedPhysicalProjectIds = physicalProjectIds.filter((projectId) =>
    scopedProjectIdSet.has(projectId)
  );
  if (scopedPhysicalProjectIds.length > 0) {
    return scopedPhysicalProjectIds;
  }
  if (physicalProjectIds.length > 0) {
    return physicalProjectIds;
  }

  return [];
};

export const projectRefMatchesExecutionScope = (
  ref: Pick<PlanExecutionScopeRef, 'projectId' | 'projectIds' | 'availableProjectIds' | 'replicas'>,
  scopedProjectIds: string[] | null
): boolean => {
  const scopedProjectIdSet = new Set(normalizeExecutionProjectIds(scopedProjectIds ?? []));
  if (scopedProjectIdSet.size === 0) {
    return true;
  }

  const candidateProjectIds = normalizeExecutionProjectIds([
    ...(ref.projectIds ?? []),
    ref.projectId,
    ...(ref.availableProjectIds ?? []),
    ...collectReplicaProjectIds(ref.replicas),
  ]);
  if (candidateProjectIds.length === 0) {
    return true;
  }
  return candidateProjectIds.some((projectId) => scopedProjectIdSet.has(projectId));
};

const mapProjectId = (
  projectId: string | null | undefined,
  singleReplacementProjectId: string | null,
  knownProjectIdSet: Set<string>
): string | null => {
  const normalized = normalizeExecutionProjectIds([projectId])[0] ?? null;
  if (normalized && knownProjectIdSet.has(normalized)) {
    return normalized;
  }
  return singleReplacementProjectId;
};

const retargetPlanNode = (
  node: PlanNode,
  replacementProjectIds: string[],
  knownProjectIdSet: Set<string>
): PlanNode => {
  const nodeProjectIds = normalizeExecutionProjectIds([
    ...(node.projectIds ?? []),
    node.projectId,
  ]);
  const hasUnknownProjectId = nodeProjectIds.some((projectId) => !knownProjectIdSet.has(projectId));
  if (!hasUnknownProjectId) {
    return node;
  }

  const validNodeProjectIds = nodeProjectIds.filter((projectId) => knownProjectIdSet.has(projectId));
  const nextProjectIds =
    replacementProjectIds.length === 1
      ? replacementProjectIds
      : validNodeProjectIds.length > 0
        ? validNodeProjectIds
        : replacementProjectIds;
  return nextProjectIds.length > 0
    ? { ...node, projectId: nextProjectIds[0], projectIds: nextProjectIds }
    : node;
};

export const retargetPlanForExecution = <TPlan extends PlanExecutionScopeRef>(
  plan: TPlan,
  scope: ProjectExecutionReconciliationScope
): TPlan => {
  const knownProjectIdSet = new Set(normalizeExecutionProjectIds(scope.knownProjectIds));
  const persistedProjectIds = normalizeExecutionProjectIds([
    ...(plan.projectIds ?? []),
    plan.projectId,
  ]);
  const childProjectIds = normalizeExecutionProjectIds([
    ...(plan.nodes ?? []).flatMap((node) => [
      ...(node.projectIds ?? []),
      node.projectId,
    ]),
    ...(plan.predictedBranches ?? []).map((branch) => branch.projectId),
  ]);
  const hasUnknownProjectId = normalizeExecutionProjectIds([
    ...persistedProjectIds,
    ...childProjectIds,
  ]).some((projectId) => !knownProjectIdSet.has(projectId));
  if (!hasUnknownProjectId) {
    return plan;
  }
  const persistedModeProjectIds = normalizeExecutionProjectIds([
    ...Object.keys(plan.executionModesByProjectId ?? {}),
    ...(plan.nodes ?? []).flatMap((node) => Object.keys(node.executionModesByProjectId ?? {})),
  ]);
  if (persistedModeProjectIds.some((projectId) => !knownProjectIdSet.has(projectId))) {
    return plan;
  }

  const replacementProjectIds = resolveExecutionProjectIds({
    persistedIds: persistedProjectIds.length > 0 ? persistedProjectIds : childProjectIds,
    availableProjectIds: plan.availableProjectIds,
    replicas: plan.replicas,
    scopedProjectIds: scope.scopedProjectIds,
    knownProjectIds: scope.knownProjectIds,
  });
  if (replacementProjectIds.length === 0) {
    return plan;
  }

  const singleReplacementProjectId =
    replacementProjectIds.length === 1 ? replacementProjectIds[0] : null;
  return {
    ...plan,
    projectId: replacementProjectIds[0] ?? plan.projectId,
    projectIds: replacementProjectIds,
    nodes: (plan.nodes ?? []).map((node) =>
      retargetPlanNode(node, replacementProjectIds, knownProjectIdSet)
    ),
    predictedBranches: (plan.predictedBranches ?? []).map((branch) => {
      const projectId = mapProjectId(
        branch.projectId,
        singleReplacementProjectId,
        knownProjectIdSet
      );
      return projectId && projectId !== branch.projectId
        ? { ...branch, projectId }
        : branch;
    }),
  };
};

const normalizePhysicalProjectPath = (value: string | null | undefined): string => {
  const normalized = (value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
};

const retargetVerifiedExecutionTargets = (
  targets: TaskExecutionTarget[] | undefined,
  knownProjects: Project[],
  knownProjectIdSet: Set<string>
): TaskExecutionTarget[] | null | undefined => {
  if (!Array.isArray(targets)) {
    return targets;
  }

  const retargeted: TaskExecutionTarget[] = [];
  for (const target of targets) {
    if (knownProjectIdSet.has(target.projectId)) {
      retargeted.push(target);
      continue;
    }
    const persistedPath = normalizePhysicalProjectPath(target.repoPath);
    const matches = persistedPath
      ? knownProjects.filter((project) => normalizePhysicalProjectPath(project.path) === persistedPath)
      : [];
    if (matches.length !== 1) {
      return null;
    }
    const replacementProjectId = matches[0].id;
    const branchName = target.branchName || target.targetBranchName || 'work';
    retargeted.push({
      ...target,
      projectId: replacementProjectId,
      worktreeKey: toBranchWorktreeKey(replacementProjectId, branchName),
    });
  }
  return retargeted;
};

export const retargetTaskForExecution = <TTask extends TaskExecutionScopeRef>(
  task: TTask,
  scope: ProjectExecutionReconciliationScope
): TTask => {
  const knownProjectIdSet = new Set(normalizeExecutionProjectIds(scope.knownProjectIds));
  const persistedProjectIds = normalizeExecutionProjectIds([
    ...(task.execution_targets ?? []).map((target) => target.projectId),
    ...(task.project_ids ?? []),
    task.project_id,
  ]);
  const hasUnknownProjectId = persistedProjectIds.some((projectId) => !knownProjectIdSet.has(projectId));
  if (!hasUnknownProjectId) {
    return task;
  }
  const executionTargets = retargetVerifiedExecutionTargets(
    task.execution_targets,
    scope.knownProjects ?? [],
    knownProjectIdSet
  );
  if (executionTargets === null) {
    return task;
  }

  const verifiedPersistedProjectIds = normalizeExecutionProjectIds([
    ...(executionTargets ?? []).map((target) => target.projectId),
    ...(task.project_ids ?? []).filter((projectId) => knownProjectIdSet.has(projectId)),
    knownProjectIdSet.has(task.project_id) ? task.project_id : null,
  ]);
  if (verifiedPersistedProjectIds.length === 0) {
    return task;
  }

  const replacementProjectIds = resolveExecutionProjectIds({
    persistedIds: verifiedPersistedProjectIds,
    scopedProjectIds: scope.scopedProjectIds,
    knownProjectIds: scope.knownProjectIds,
  });
  if (replacementProjectIds.length === 0) {
    return task;
  }

  return {
    ...task,
    project_id: replacementProjectIds[0] ?? task.project_id,
    project_ids: replacementProjectIds,
    execution_targets: executionTargets,
  };
};

export const getProjectSelectionScopedProjectIds = (
  scope: ProjectSelectionReconciliationScope
): string[] =>
  getScopedProjectIds(
    {
      standaloneProjects: scope.standaloneProjects ?? [],
      projectGroups: scope.projectGroups,
    },
    scope.selectedGroupId ?? null,
    scope.selectedProjectId ?? null
  );

export const retargetTaskForProjectSelection = <TTask extends TaskExecutionScopeRef>(
  task: TTask,
  scope: ProjectSelectionReconciliationScope
): TTask =>
  retargetTaskForExecution(task, {
    scopedProjectIds: getProjectSelectionScopedProjectIds(scope),
    knownProjectIds: collectKnownProjectIds({
      standaloneProjects: scope.standaloneProjects ?? [],
      projectGroups: scope.projectGroups,
    }),
    knownProjects: collectKnownProjects({
      standaloneProjects: scope.standaloneProjects ?? [],
      projectGroups: scope.projectGroups,
    }),
  });
