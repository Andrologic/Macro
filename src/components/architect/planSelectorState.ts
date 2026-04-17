import type { ArchitectPlanSummary } from '../../services/architectPlanService';
import {
  compareArchitectPlanSelectionPriority,
  planMatchesArchitectScope,
} from '../../services/architectPlanSelection';

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
): boolean => planMatchesArchitectScope(plan, scopedProjectIds);

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
  currentActivePlanId?: string | null;
  mutation?: PlanSelectorMutationCheck;
}): PlanSelectorRefreshState => {
  const visiblePlans = filterPlansForDisplay(
    params.plans,
    params.scopedProjectIds,
    params.showArchived
  ).sort(compareArchitectPlanSelectionPriority);
  const nextActivePlanId =
    params.preferredActivePlanId && visiblePlans.some((plan) => plan.id === params.preferredActivePlanId)
      ? params.preferredActivePlanId
      : params.currentActivePlanId && visiblePlans.some((plan) => plan.id === params.currentActivePlanId)
        ? params.currentActivePlanId
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
