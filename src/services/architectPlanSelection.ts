import type { ArchitectPlanSummary } from './architectPlanService';

export interface ArchitectPlanResolutionState {
  visiblePlans: ArchitectPlanSummary[];
  nextActivePlanId: string | null;
}

export const compareArchitectPlanSelectionPriority = (
  left: Pick<ArchitectPlanSummary, 'id' | 'createdAt' | 'updatedAt'>,
  right: Pick<ArchitectPlanSummary, 'id' | 'createdAt' | 'updatedAt'>
): number => {
  const leftUpdatedAt = new Date(left.updatedAt).getTime();
  const rightUpdatedAt = new Date(right.updatedAt).getTime();
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }

  const leftCreatedAt = new Date(left.createdAt).getTime();
  const rightCreatedAt = new Date(right.createdAt).getTime();
  if (leftCreatedAt !== rightCreatedAt) {
    return rightCreatedAt - leftCreatedAt;
  }

  return left.id.localeCompare(right.id);
};

export const getVisibleArchitectPlansForScope = (
  plans: ArchitectPlanSummary[],
  scopedProjectIds: string[]
): ArchitectPlanSummary[] =>
  plans
    .filter((plan) => plan.status !== 'archived' && plan.status !== 'deleted')
    .filter((plan) => planMatchesArchitectScope(plan, scopedProjectIds))
    .sort(compareArchitectPlanSelectionPriority);

export const computeArchitectPlanResolutionState = (params: {
  plans: ArchitectPlanSummary[];
  scopedProjectIds: string[];
  currentActivePlanId?: string | null;
  rememberedPlanId?: string | null;
}): ArchitectPlanResolutionState => {
  const visiblePlans = getVisibleArchitectPlansForScope(
    params.plans,
    params.scopedProjectIds
  );
  const visiblePlanIdSet = new Set(visiblePlans.map((plan) => plan.id));

  const nextActivePlanId =
    params.currentActivePlanId &&
    visiblePlanIdSet.has(params.currentActivePlanId)
      ? params.currentActivePlanId
      : params.rememberedPlanId &&
          visiblePlanIdSet.has(params.rememberedPlanId)
        ? params.rememberedPlanId
        : visiblePlans[0]?.id ?? null;

  return {
    visiblePlans,
    nextActivePlanId,
  };
};

export const planMatchesArchitectScope = (
  plan: Pick<
    ArchitectPlanSummary,
    'projectId' | 'projectIds' | 'expectedProjectIds'
  >,
  scopedProjectIds: string[]
): boolean => {
  if (scopedProjectIds.length === 0) {
    return true;
  }

  const planProjectIds = Array.from(
    new Set(
      [
        plan.projectId,
        ...(plan.projectIds ?? []),
        ...(plan.expectedProjectIds ?? []),
      ].filter(Boolean)
    )
  ) as string[];
  if (planProjectIds.length === 0) {
    return false;
  }

  const scopedProjectIdSet = new Set(scopedProjectIds);
  return planProjectIds.some((projectId) => scopedProjectIdSet.has(projectId));
};
