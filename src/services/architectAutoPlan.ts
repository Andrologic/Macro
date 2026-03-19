import type { Need } from '../types';
import {
  createArchitectPlan,
  getArchitectPlan,
  getArchitectPlanChatMessages,
  getArchitectPlanNeeds,
  getArchitectPlanProjectIds,
  listArchitectPlans,
  setActiveArchitectPlan,
  updateArchitectPlan,
  type ArchitectPlanRecord,
  type ArchitectPlanSummary,
} from './architectPlanService';
import {
  DEFAULT_NEW_PLAN_LABEL,
  getNextDefaultNewPlanLabel,
  getArchitectPlanEditableName,
  isDefaultNewPlanBaseLabel,
  isCanonicalArchitectPlan,
} from './architectPlanPresentation';

const trimToNull = (value?: string | null): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

const isDraftPlaceholderCandidate = (plan: ArchitectPlanSummary): boolean => {
  if (plan.status !== 'draft') {
    return false;
  }

  const editableName = getArchitectPlanEditableName(plan);
  return isDefaultNewPlanBaseLabel(editableName) || (isCanonicalArchitectPlan(plan) && !editableName);
};

const isPlanVisibleForScope = (
  plan: Pick<ArchitectPlanSummary, 'projectId' | 'projectIds' | 'expectedProjectIds'>,
  scopedProjectIds: string[]
): boolean => {
  if (scopedProjectIds.length === 0) return true;
  const scopedProjectIdSet = new Set(scopedProjectIds);
  const planProjectIds = getArchitectPlanProjectIds(plan);
  return (
    planProjectIds.length === 0 ||
    planProjectIds.some((projectId) => scopedProjectIdSet.has(projectId))
  );
};

const mergeProjectIds = (...collections: Array<string[] | undefined>): string[] =>
  Array.from(
    new Set(
      collections
        .flatMap((collection) => collection || [])
        .map((projectId) => projectId.trim())
        .filter((projectId) => projectId.length > 0)
    )
  );

const coversScope = (projectIds: string[], scopedProjectIds: string[]): boolean => {
  const projectIdSet = new Set(projectIds);
  return scopedProjectIds.every((projectId) => projectIdSet.has(projectId));
};

export const isArchitectPlanBlankDraft = (
  plan: Pick<ArchitectPlanRecord, 'status' | 'description' | 'nodes' | 'predictedBranches'>,
  needs: Need[],
  chatMessages: Array<unknown>
): boolean =>
  plan.status === 'draft' &&
  !trimToNull(plan.description) &&
  (plan.nodes?.length || 0) === 0 &&
  (plan.predictedBranches?.length || 0) === 0 &&
  needs.length === 0 &&
  chatMessages.length === 0;

export const ensureScopedBlankPlan = async (params: {
  branchName: string;
  scopedProjectIds: string[];
}): Promise<ArchitectPlanRecord | null> => {
  const fullResult = await listScopedPlans(params.branchName, params.scopedProjectIds);
  const draftCandidates = fullResult.scopedPlans.filter(isDraftPlaceholderCandidate);
  const nextLabels = [...fullResult.scopedPlans];
  const blankCandidates: Array<{
    summary: ArchitectPlanSummary;
    plan: ArchitectPlanRecord;
  }> = [];

  let blankPlan: {
    summary: ArchitectPlanSummary;
    plan: ArchitectPlanRecord;
  } | null = null;

  for (const candidate of draftCandidates) {
    const plan = await getArchitectPlan(params.branchName, candidate.id);
    if (!plan || plan.status === 'deleted') {
      continue;
    }

    const [needs, chatMessages] = await Promise.all([
      getArchitectPlanNeeds(params.branchName, candidate.id),
      getArchitectPlanChatMessages(params.branchName, candidate.id),
    ]);

    if (isArchitectPlanBlankDraft(plan, needs, chatMessages)) {
      const blankCandidate = { summary: candidate, plan };
      blankCandidates.push(blankCandidate);
      if (
        !blankPlan ||
        new Date(candidate.updatedAt).getTime() > new Date(blankPlan.summary.updatedAt).getTime()
      ) {
        blankPlan = blankCandidate;
      }
      continue;
    }

    const nextLabel = getNextDefaultNewPlanLabel(nextLabels);
    await updateArchitectPlan({
      branchName: params.branchName,
      planId: candidate.id,
      label: nextLabel,
    });
    nextLabels.push({
      ...candidate,
      label: nextLabel,
    });
  }

  if (!blankPlan) {
    return null;
  }

  for (const candidate of blankCandidates) {
    if (candidate.summary.id === blankPlan.summary.id) {
      continue;
    }

    const nextLabel = getNextDefaultNewPlanLabel(nextLabels);
    await updateArchitectPlan({
      branchName: params.branchName,
      planId: candidate.summary.id,
      label: nextLabel,
    });
    nextLabels.push({
      ...candidate.summary,
      label: nextLabel,
    });
  }

  if (!isDefaultNewPlanBaseLabel(blankPlan.plan.label)) {
    return updateArchitectPlan({
      branchName: params.branchName,
      planId: blankPlan.plan.id,
      label: DEFAULT_NEW_PLAN_LABEL,
    });
  }

  return blankPlan.plan;
};

const listScopedPlans = async (branchName: string, scopedProjectIds: string[]) => {
  const fullResult = await listArchitectPlans(branchName, true, true);
  const scopedPlans = fullResult.plans.filter((plan) =>
    isPlanVisibleForScope(plan, scopedProjectIds)
  );
  return {
    fullResult,
    scopedPlans,
  };
};

export interface EnsureProjectGroupPlanResult {
  action: 'created' | 'reused_blank' | 'expanded_blank';
  plan: ArchitectPlanRecord;
  needs: Need[];
}

export const ensureProjectGroupPlan = async (params: {
  branchName: string;
  scopedProjectIds: string[];
}): Promise<EnsureProjectGroupPlanResult | null> => {
  if (params.scopedProjectIds.length === 0) {
    return null;
  }

  const { scopedPlans } = await listScopedPlans(params.branchName, params.scopedProjectIds);
  const visiblePlans = scopedPlans.filter(
    (plan) => plan.status !== 'archived' && plan.status !== 'deleted'
  );
  const blankPlan = await ensureScopedBlankPlan(params);

  if (blankPlan) {
    const refreshedScopedPlans = (await listScopedPlans(params.branchName, params.scopedProjectIds)).scopedPlans;
    const refreshedVisiblePlans = refreshedScopedPlans.filter(
      (plan) => plan.status !== 'archived' && plan.status !== 'deleted'
    );
    const hasNonPlaceholderVisiblePlan = refreshedVisiblePlans.some(
      (plan) => plan.id !== blankPlan.id && !isDraftPlaceholderCandidate(plan)
    );
    if (hasNonPlaceholderVisiblePlan) {
      return null;
    }

    const mergedProjectIds = mergeProjectIds(
      blankPlan.projectIds,
      blankPlan.expectedProjectIds,
      params.scopedProjectIds
    );

    if (!coversScope(mergedProjectIds, params.scopedProjectIds)) {
      return null;
    }

    if (
      !coversScope(blankPlan.projectIds || [], params.scopedProjectIds) ||
      !coversScope(blankPlan.expectedProjectIds || blankPlan.projectIds || [], params.scopedProjectIds)
    ) {
      const expandedPlan = await updateArchitectPlan({
        branchName: params.branchName,
        planId: blankPlan.id,
        projectIds: mergedProjectIds,
        expectedProjectIds: mergedProjectIds,
        setActive: true,
      });
      const needs = await getArchitectPlanNeeds(params.branchName, expandedPlan.id);
      return {
        action: 'expanded_blank',
        plan: expandedPlan,
        needs,
      };
    }

    await setActiveArchitectPlan(params.branchName, blankPlan.id);
    const needs = await getArchitectPlanNeeds(params.branchName, blankPlan.id);
    return {
      action: 'reused_blank',
      plan: blankPlan,
      needs,
    };
  }

  if (visiblePlans.length > 0) {
    return null;
  }

  const createdPlan = await createArchitectPlan({
    branchName: params.branchName,
    label: DEFAULT_NEW_PLAN_LABEL,
    projectId: params.scopedProjectIds[0] || undefined,
    projectIds: params.scopedProjectIds,
    status: 'draft',
    setActive: true,
  });

  return {
    action: 'created',
    plan: createdPlan,
    needs: [],
  };
};
