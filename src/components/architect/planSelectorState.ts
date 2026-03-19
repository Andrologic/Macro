import {
  getArchitectPlanProjectIds,
  type ArchitectPlanSummary,
} from '../../services/architectPlanService';

export interface PlanSelectorMutationCheck {
  type: 'archive' | 'delete';
  planId: string;
}

export interface PlanSelectorRefreshState {
  targetPlan: ArchitectPlanSummary | null;
  visiblePlans: ArchitectPlanSummary[];
  nextActivePlanId: string | null;
  mutationApplied: boolean;
}

export const isPlanVisibleForSelection = (
  plan: ArchitectPlanSummary,
  scopedProjectIds: string[]
): boolean => {
  if (scopedProjectIds.length === 0) return true;
  const scopedProjectIdSet = new Set(scopedProjectIds);
  const planProjectIds = getArchitectPlanProjectIds(plan);
  return planProjectIds.length === 0 || planProjectIds.some((projectId) => scopedProjectIdSet.has(projectId));
};

export const filterPlansForDisplay = (
  plans: ArchitectPlanSummary[],
  scopedProjectIds: string[],
  showArchived: boolean
): ArchitectPlanSummary[] =>
  plans.filter((plan) => {
    if (!isPlanVisibleForSelection(plan, scopedProjectIds)) {
      return false;
    }

    return showArchived ? plan.status === 'archived' : plan.status !== 'archived' && plan.status !== 'deleted';
  });

export const computePlanSelectorRefreshState = (params: {
  plans: ArchitectPlanSummary[];
  scopedProjectIds: string[];
  showArchived: boolean;
  preferredActivePlanId?: string | null;
  mutation?: PlanSelectorMutationCheck;
}): PlanSelectorRefreshState => {
  const visiblePlans = filterPlansForDisplay(params.plans, params.scopedProjectIds, params.showArchived);
  const nextActivePlanId =
    params.preferredActivePlanId && visiblePlans.some((plan) => plan.id === params.preferredActivePlanId)
      ? params.preferredActivePlanId
      : visiblePlans[0]?.id ?? null;

  const targetPlan = params.mutation
    ? params.plans.find((plan) => plan.id === params.mutation?.planId) || null
    : null;
  const mutationApplied =
    params.mutation?.type === 'archive'
      ? targetPlan?.status === 'archived'
      : params.mutation?.type === 'delete'
        ? !targetPlan || targetPlan.status === 'deleted'
        : false;

  return {
    targetPlan,
    visiblePlans,
    nextActivePlanId,
    mutationApplied,
  };
};
