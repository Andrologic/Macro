import type { StandaloneTaskKind, Task, TaskExecutionTarget } from '../types';
import {
  deriveImplementTasksFromStrategy,
  toBranchWorktreeKey,
  type DerivedImplementTask,
} from './implementTaskDerivation';
import {
  getArchitectPlanTargetBranchesByProjectId,
  planHasMixedTargetBranches,
  type ArchitectPlanRecord,
  type ArchitectPlanStatus,
} from './architectPlanService';
import {
  getArchitectPlanKind,
  type ArchitectPlanKind,
} from './architectPlanKinds';
import {
  buildPlanFinalizationTaskId,
  buildPlanFinalizationTaskTitle,
  derivePlanFinalizationDependencyState,
  isPlanFinalizationTaskSource,
  PLAN_FINALIZATION_TASK_DESCRIPTION,
  PLAN_FINALIZATION_TASK_PREFIX,
  shouldCreatePlanFinalizationTask,
  type PlanFinalizationDependencyState,
} from './planFinalization';
import type {
  MergeWorkflowSummary,
  PersistedMergeWorkflowSession,
} from './mergeWorkflowPersistence';
import { summarizePersistedMergeWorkflowSession } from './mergeWorkflowPersistence';

export type ImplementTaskSource = 'architect' | 'plan_finalization' | 'standalone';
export type ImplementTaskCatalogSource = 'architect' | 'mixed' | 'fallback' | 'empty';

export interface ImplementTaskPlanSummary {
  id: string;
  slug: string;
  title: string;
  label?: string;
  planKind?: ArchitectPlanKind;
  status: ArchitectPlanStatus;
  storageBranch: string;
  targetBranch: string;
  targetBranchesByProjectId?: Record<string, string>;
  hasMixedTargetBranches?: boolean;
  projectIds: string[];
  taskCount: number;
  completedTaskCount: number;
  activeTaskCount: number;
}

export interface CatalogedImplementTask extends DerivedImplementTask {
  task_source: ImplementTaskSource;
  plan_title: string | null;
  plan_status: ArchitectPlanStatus | null;
  plan_storage_branch?: string | null;
  plan_target_branch: string | null;
  plan_target_branches_by_project_id?: Record<string, string> | null;
  has_mixed_target_branches?: boolean;
  draft: boolean;
  standalone_kind: 'legacy' | 'manual_feature';
  task_kind?: StandaloneTaskKind | null;
  base_branch: string | null;
  feature_slug: string | null;
  conversation_id: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  merged_at: string | null;
  merge_workflow?: PersistedMergeWorkflowSession | null;
  merge_workflow_summary?: MergeWorkflowSummary | null;
}

export const isPlanFinalizationTask = (
  task: Pick<CatalogedImplementTask, 'task_source'>
): boolean => isPlanFinalizationTaskSource(task.task_source);

export interface ImplementTaskCatalog {
  tasks: CatalogedImplementTask[];
  plans: ImplementTaskPlanSummary[];
  hasStandaloneTasks: boolean;
  source: ImplementTaskCatalogSource;
}

const normalizeBranchName = (value?: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || 'work';
};

const unique = (items: string[]): string[] => Array.from(new Set(items.filter((item) => item.trim().length > 0)));

const compareOptionalText = (left: string | null | undefined, right: string | null | undefined): number =>
  (left || '').localeCompare(right || '');

const normalizeProjectIds = (projectIds?: string[], projectId?: string): string[] =>
  unique([
    ...(Array.isArray(projectIds) ? projectIds : []).filter((value): value is string => typeof value === 'string'),
    ...(projectId ? [projectId] : []),
  ]);

const getUniqueTargetBranch = (
  targetBranchesByProjectId: Record<string, string>,
  fallbackTargetBranch?: string | null
): string | null => {
  const uniqueTargets = unique(
    Object.values(targetBranchesByProjectId)
      .map((branchName) => branchName.trim())
      .filter(Boolean)
  );
  if (uniqueTargets.length === 1) {
    return uniqueTargets[0];
  }
  if (uniqueTargets.length === 0) {
    return fallbackTargetBranch?.trim() || null;
  }
  return null;
};

const buildPlanFinalizationExecutionTargets = (
  plan: Pick<ArchitectPlanRecord, 'projectId' | 'projectIds' | 'targetBranch' | 'targetBranchesByProjectId'>
): TaskExecutionTarget[] => {
  const projectIds = normalizeProjectIds(plan.projectIds, plan.projectId);

  return projectIds.map((projectId) => {
    const targetBranchName = plan.targetBranchesByProjectId?.[projectId] || plan.targetBranch;
    return {
      projectId,
      branchName: targetBranchName,
      targetBranchName,
      executionKind: 'repository_root',
      worktreeKey: `${PLAN_FINALIZATION_TASK_PREFIX}${plan.projectId || projectId}:${projectId}`,
    };
  });
};

const buildPlanFinalizationTask = (
  plan: ArchitectPlanRecord,
  sequenceIndex: number,
  dependencyState: PlanFinalizationDependencyState,
  blockingTasks: CatalogedImplementTask[]
): CatalogedImplementTask | null => {
  const projectIds = normalizeProjectIds(plan.projectIds, plan.projectId);
  const projectId = projectIds[0];
  if (!projectId) {
    return null;
  }

  const isBlocked = !dependencyState.isComplete;
  const blockedByTaskIds = isBlocked ? dependencyState.incompleteNodeIds : [];
  const blockedBy = blockedByTaskIds
    .map((taskId) => blockingTasks.find((task) => task.id === taskId)?.title)
    .filter((title): title is string => Boolean(title));
  const targetBranchesByProjectId = getArchitectPlanTargetBranchesByProjectId(plan);
  const effectiveTargetBranch = getUniqueTargetBranch(targetBranchesByProjectId, plan.targetBranch);

  return {
    id: buildPlanFinalizationTaskId(plan.id),
    plan_id: plan.id,
    project_id: projectId,
    project_ids: projectIds,
    context_project_ids: plan.contextProjectIds || [],
    title: buildPlanFinalizationTaskTitle(plan),
    description: PLAN_FINALIZATION_TASK_DESCRIPTION,
    status: isBlocked ? 'Blocked' : 'Pending',
    dependencies: dependencyState.terminalNodeIds,
    estimated_changes: [],
    assigned_branch: effectiveTargetBranch || '',
    branch_name: effectiveTargetBranch || '',
    branch_id: null,
    branch_task_index: Number.MAX_SAFE_INTEGER,
    blocked_by_task_ids: blockedByTaskIds,
    blocked_by: blockedBy,
    is_blocked: isBlocked,
    is_ready: !isBlocked,
    needs_revalidation: false,
    sequence_index: sequenceIndex,
    execution_targets: buildPlanFinalizationExecutionTargets(plan),
    todos: [],
    task_source: 'plan_finalization',
    plan_title: plan.title,
    plan_status: plan.status,
    plan_storage_branch: plan.targetBranch,
    plan_target_branch: effectiveTargetBranch,
    plan_target_branches_by_project_id: targetBranchesByProjectId,
    has_mixed_target_branches: planHasMixedTargetBranches(plan),
    draft: false,
    standalone_kind: 'legacy',
    task_kind: null,
    base_branch: effectiveTargetBranch,
    feature_slug: null,
    conversation_id: null,
    archived_at: null,
    archive_reason: null,
    merged_at: null,
    merge_workflow: null,
    merge_workflow_summary: null,
  };
};

const buildFallbackExecutionTargets = (
  projectIds: string[],
  branchName: string,
  targetBranchName?: string | null
): TaskExecutionTarget[] => {
  return projectIds.map((projectId) => ({
    projectId,
    branchName,
    targetBranchName: targetBranchName || undefined,
    executionKind: 'worktree',
    worktreeKey: toBranchWorktreeKey(projectId, branchName),
  }));
};

export const isExecutableImplementPlanStatus = (
  status: ArchitectPlanStatus | string | null | undefined
): status is ArchitectPlanStatus => {
  return status === 'validated' || status === 'in_progress';
};

export const taskMatchesProjectId = (
  task: Pick<CatalogedImplementTask, 'project_id' | 'project_ids' | 'execution_targets'>,
  projectId: string | null | undefined
): boolean => {
  if (!projectId) return false;
  return (
    task.project_id === projectId ||
    (task.project_ids || []).includes(projectId) ||
    (task.execution_targets || []).some((target) => target.projectId === projectId)
  );
};

export const deriveFallbackImplementTasks = (tasks: Task[]): CatalogedImplementTask[] => {
  const initial = tasks.map((task, index) => {
    const raw = task as Task & {
      assigned_branch?: string;
      branch_name?: string;
      branch_id?: string;
      branch_task_index?: number;
      sequence_index?: number;
      execution_targets?: TaskExecutionTarget[];
      draft?: boolean;
      standalone_kind?: 'legacy' | 'manual_feature';
      task_kind?: StandaloneTaskKind | null;
      base_branch?: string | null;
      feature_slug?: string | null;
      conversation_id?: string | null;
      archived_at?: string | null;
      archive_reason?: string | null;
      merged_at?: string | null;
      merge_workflow?: PersistedMergeWorkflowSession | null;
      merge_workflow_summary?: MergeWorkflowSummary | null;
    };
    const isDraft = raw.draft === true;
    const assignedBranch =
      isDraft && !(raw.assigned_branch || raw.branch_name)
        ? ''
        : normalizeBranchName(raw.assigned_branch || raw.branch_name);
    const projectIds = normalizeProjectIds(task.project_ids, task.project_id);
    const executionTargets = raw.execution_targets && raw.execution_targets.length > 0
      ? raw.execution_targets
      : isDraft || !assignedBranch
        ? []
        : buildFallbackExecutionTargets(projectIds, assignedBranch, raw.base_branch ?? null);

    return {
      ...task,
      project_ids: projectIds,
      assigned_branch: assignedBranch,
      branch_name: assignedBranch,
      branch_id: raw.branch_id || null,
      branch_task_index:
        typeof raw.branch_task_index === 'number' ? raw.branch_task_index : Number.MAX_SAFE_INTEGER,
      blocked_by_task_ids: [],
      blocked_by: [],
      is_blocked: false,
      is_ready: false,
      needs_revalidation: false,
      sequence_index: typeof raw.sequence_index === 'number' ? raw.sequence_index : index,
      execution_targets: executionTargets,
      todos: [],
      draft: isDraft,
      standalone_kind: raw.standalone_kind === 'manual_feature' ? 'manual_feature' : 'legacy',
      task_kind:
        raw.task_kind === 'feature' || raw.task_kind === 'bugfix' || raw.task_kind === 'hotfix'
          ? raw.task_kind
          : null,
      base_branch: typeof raw.base_branch === 'string' ? raw.base_branch : null,
      feature_slug: typeof raw.feature_slug === 'string' ? raw.feature_slug : null,
      conversation_id: typeof raw.conversation_id === 'string' ? raw.conversation_id : null,
      archived_at: typeof raw.archived_at === 'string' ? raw.archived_at : null,
      archive_reason: typeof raw.archive_reason === 'string' ? raw.archive_reason : null,
      merged_at: typeof raw.merged_at === 'string' ? raw.merged_at : null,
      merge_workflow:
        raw.merge_workflow && typeof raw.merge_workflow === 'object'
          ? raw.merge_workflow
          : null,
      merge_workflow_summary:
        raw.merge_workflow_summary && typeof raw.merge_workflow_summary === 'object'
          ? raw.merge_workflow_summary
          : summarizePersistedMergeWorkflowSession(
              raw.merge_workflow && typeof raw.merge_workflow === 'object'
                ? raw.merge_workflow
                : null
            ),
      task_source: 'standalone' as const,
      plan_title: null,
      plan_status: null,
      plan_storage_branch: null,
      plan_target_branch: null,
      plan_target_branches_by_project_id: null,
      has_mixed_target_branches: false,
    } satisfies CatalogedImplementTask;
  });

  const byId = new Map(initial.map((task) => [task.id, task]));
  return initial.map((task) => {
    const blockedByTaskIds = task.dependencies.filter((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return dependency ? dependency.status !== 'Completed' : false;
    });
    const blockedBy = blockedByTaskIds
      .map((dependencyId) => byId.get(dependencyId)?.title)
      .filter((title): title is string => Boolean(title));

    let status = task.status;
    if (blockedByTaskIds.length > 0 && status === 'Pending') {
      status = 'Blocked';
    }
    if (blockedByTaskIds.length === 0 && status === 'Blocked') {
      status = 'Pending';
    }

    const isBlocked = blockedByTaskIds.length > 0;
    const isReady = !task.draft && !isBlocked && status !== 'Completed' && status !== 'Failed';
    const needsRevalidation =
      blockedByTaskIds.length > 0 &&
      (status === 'Completed' ||
        status === 'InProgress' ||
        status === 'AwaitingResponse' ||
        status === 'InReview');
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
};

export const deriveImplementTasksFromArchitectPlan = (
  plan: ArchitectPlanRecord
): CatalogedImplementTask[] => {
  const targetBranchesByProjectId = getArchitectPlanTargetBranchesByProjectId(plan);
  const effectiveTargetBranch = getUniqueTargetBranch(targetBranchesByProjectId, plan.targetBranch);
  const strategy = deriveImplementTasksFromStrategy({
    planId: plan.id,
    planSlug: plan.slug,
    nodes: plan.nodes || [],
    predictedBranches: plan.predictedBranches || [],
    targetBranchesByProjectId,
  });
  const nodeById = new Map(strategy.nodes.map((node) => [node.id, node]));

  return strategy.tasks.map((task) => {
    const planNode = nodeById.get(task.id);
    return {
      ...task,
      task_source: 'architect' as const,
      context_project_ids: plan.contextProjectIds || [],
      plan_title: plan.title,
      plan_status: plan.status,
      plan_storage_branch: plan.targetBranch,
      plan_target_branch: effectiveTargetBranch,
      plan_target_branches_by_project_id: targetBranchesByProjectId,
      has_mixed_target_branches: planHasMixedTargetBranches(plan),
      draft: false,
      standalone_kind: 'legacy' as const,
      task_kind: null,
      base_branch: null,
      feature_slug: null,
      conversation_id: null,
      archived_at: typeof planNode?.archivedAt === 'string' ? planNode.archivedAt : null,
      archive_reason: typeof planNode?.archiveReason === 'string' ? planNode.archiveReason : null,
      merged_at: typeof planNode?.mergedAt === 'string' ? planNode.mergedAt : null,
      merge_workflow: null,
      merge_workflow_summary: null,
    };
  });
};

const sortCatalogTasks = (tasks: CatalogedImplementTask[]): CatalogedImplementTask[] => {
  return [...tasks].sort((left, right) => {
    if (left.task_source !== right.task_source) {
      const taskSourceOrder: Record<ImplementTaskSource, number> = {
        architect: 0,
        plan_finalization: 1,
        standalone: 2,
      };
      return taskSourceOrder[left.task_source] - taskSourceOrder[right.task_source];
    }

    if (left.plan_id !== right.plan_id) {
      const planTitleDelta = compareOptionalText(left.plan_title, right.plan_title);
      if (planTitleDelta !== 0) {
        return planTitleDelta;
      }

      const planTargetBranchDelta = compareOptionalText(left.plan_target_branch, right.plan_target_branch);
      if (planTargetBranchDelta !== 0) {
        return planTargetBranchDelta;
      }

      const planIdDelta = compareOptionalText(left.plan_id, right.plan_id);
      if (planIdDelta !== 0) {
        return planIdDelta;
      }
    }

    const sequenceDelta = left.sequence_index - right.sequence_index;
    if (sequenceDelta !== 0) return sequenceDelta;

    const branchDelta = left.branch_task_index - right.branch_task_index;
    if (branchDelta !== 0) return branchDelta;

    return left.title.localeCompare(right.title);
  });
};

export const buildImplementTaskCatalog = (params: {
  plans: ArchitectPlanRecord[];
  fallbackTasks: Task[];
}): ImplementTaskCatalog => {
  const executablePlans = params.plans.filter((plan) => isExecutableImplementPlanStatus(plan.status));
  const architectTasks = executablePlans.flatMap((plan) => deriveImplementTasksFromArchitectPlan(plan));
  const architectTasksByPlanId = new Map<string, CatalogedImplementTask[]>();
  architectTasks.forEach((task) => {
    const planTasks = architectTasksByPlanId.get(task.plan_id) || [];
    planTasks.push(task);
    architectTasksByPlanId.set(task.plan_id, planTasks);
  });
  const planFinalizationTasks = executablePlans
    .map((plan) => {
      const planTasks = architectTasksByPlanId.get(plan.id) || [];
      const actionablePlanTasks = planTasks.filter((task) => !task.archived_at);
      const dependencyState = derivePlanFinalizationDependencyState(plan.nodes || []);
      if (!shouldCreatePlanFinalizationTask({
        planStatus: plan.status,
        taskCount: dependencyState.actionableNodeIds.length,
      })) {
        return null;
      }

      const lastSequenceIndex = planTasks.reduce(
        (maxValue, task) => Math.max(maxValue, task.sequence_index),
          0
      );
      return buildPlanFinalizationTask(
        plan,
        lastSequenceIndex + 1,
        dependencyState,
        actionablePlanTasks
      );
    })
    .filter((task): task is CatalogedImplementTask => Boolean(task));
  const architectTaskIds = new Set(architectTasks.map((task) => task.id));
  const allKnownPlanIds = new Set(params.plans.map((plan) => plan.id));

  const standaloneFallbackTasks = params.fallbackTasks.filter((task) => {
    if (architectTaskIds.has(task.id)) return false;
    const planId = typeof task.plan_id === 'string' ? task.plan_id.trim() : '';
    if (!planId) return true;
    return !allKnownPlanIds.has(planId);
  });
  const standaloneTasks = deriveFallbackImplementTasks(standaloneFallbackTasks);

  const plans = executablePlans
    .map((plan) => {
      const planTasks = architectTasks.filter((task) => task.plan_id === plan.id);
      const actionablePlanTasks = planTasks.filter((task) => !task.archived_at);
      const taskCount = actionablePlanTasks.length;
      const completedTaskCount = actionablePlanTasks.filter((task) => task.status === 'Completed').length;
      const activeTaskCount = actionablePlanTasks.filter(
        (task) => task.status === 'InProgress' || task.status === 'AwaitingResponse'
      ).length;

      return {
        id: plan.id,
        slug: plan.slug,
        title: plan.title,
        label: plan.label,
        planKind: getArchitectPlanKind(plan),
        status: plan.status,
        storageBranch: plan.targetBranch,
        targetBranch: getUniqueTargetBranch(getArchitectPlanTargetBranchesByProjectId(plan), plan.targetBranch) || '',
        targetBranchesByProjectId: getArchitectPlanTargetBranchesByProjectId(plan),
        hasMixedTargetBranches: planHasMixedTargetBranches(plan),
        projectIds: unique(
          [
            ...(Array.isArray(plan.projectIds) ? plan.projectIds : []),
            ...(plan.projectId ? [plan.projectId] : []),
          ].filter((value): value is string => typeof value === 'string')
        ),
        taskCount,
        completedTaskCount,
        activeTaskCount,
      };
    })
    .filter((plan) => plan.taskCount > 0)
    .sort((left, right) => {
      const titleDelta = left.title.localeCompare(right.title);
      if (titleDelta !== 0) return titleDelta;

      const targetBranchDelta = left.targetBranch.localeCompare(right.targetBranch);
      if (targetBranchDelta !== 0) return targetBranchDelta;

      return left.id.localeCompare(right.id);
    });

  const tasks = sortCatalogTasks([...architectTasks, ...planFinalizationTasks, ...standaloneTasks]);
  let source: ImplementTaskCatalogSource = 'empty';
  if ((architectTasks.length > 0 || planFinalizationTasks.length > 0) && standaloneTasks.length > 0) {
    source = 'mixed';
  } else if (architectTasks.length > 0 || planFinalizationTasks.length > 0) {
    source = 'architect';
  } else if (standaloneTasks.length > 0) {
    source = 'fallback';
  }

  return {
    tasks,
    plans,
    hasStandaloneTasks: standaloneTasks.length > 0,
    source,
  };
};
