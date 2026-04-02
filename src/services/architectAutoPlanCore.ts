import type { Need } from '../types';
import type { ArchitectPlanRecord, ArchitectPlanSummary } from './architectPlanService';

export interface ArchitectAutoPlanDependencies {
  DEFAULT_NEW_PLAN_LABEL: string;
  createArchitectPlan: (params: {
    branchName: string;
    label?: string;
    projectId?: string;
    projectIds?: string[];
    contextProjectIds?: string[];
    targetBranchesByProjectId?: Record<string, string>;
    status?: ArchitectPlanRecord['status'];
    setActive?: boolean;
  }) => Promise<ArchitectPlanRecord>;
  getArchitectPlan: (branchName: string, planId: string) => Promise<ArchitectPlanRecord | null>;
  getArchitectPlanChatMessages: (branchName: string, planId: string) => Promise<Array<unknown>>;
  getArchitectPlanEditableName: (plan: ArchitectPlanSummary) => string;
  getArchitectPlanNeeds: (branchName: string, planId: string) => Promise<Need[]>;
  getArchitectPlanProjectIds: (
    plan: Pick<ArchitectPlanSummary, 'projectId' | 'projectIds' | 'expectedProjectIds'>
  ) => string[];
  getNextDefaultNewPlanLabel: (plans: ArchitectPlanSummary[]) => string;
  isCanonicalArchitectPlan: (plan: ArchitectPlanSummary) => boolean;
  isDefaultNewPlanBaseLabel: (value?: string | null) => boolean;
  listArchitectPlans: (
    branchName: string,
    includeArchived?: boolean,
    includeDeleted?: boolean
  ) => Promise<{ activePlanId: string | null; plans: ArchitectPlanSummary[] }>;
  setActiveArchitectPlan: (branchName: string, planId: string | null) => Promise<void>;
  updateArchitectPlan: (params: {
    branchName: string;
    planId: string;
    label?: string;
    projectIds?: string[];
    contextProjectIds?: string[];
    expectedProjectIds?: string[];
    targetBranchesByProjectId?: Record<string, string>;
    setActive?: boolean;
  }) => Promise<ArchitectPlanRecord>;
  getTargetBranchesByProjectId?: (projectIds: string[]) => Record<string, string>;
}

export interface EnsureProjectGroupPlanResult {
  action: 'created' | 'reused_blank' | 'expanded_blank';
  plan: ArchitectPlanRecord;
  needs: Need[];
}

const trimToNull = (value?: string | null): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
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

export const createArchitectAutoPlanService = (deps: ArchitectAutoPlanDependencies) => {
  const isDraftPlaceholderCandidate = (plan: ArchitectPlanSummary): boolean => {
    if (plan.status !== 'draft') {
      return false;
    }

    const editableName = deps.getArchitectPlanEditableName(plan);
    return deps.isDefaultNewPlanBaseLabel(editableName) || (deps.isCanonicalArchitectPlan(plan) && !editableName);
  };

  const isPlanVisibleForScope = (
    plan: Pick<ArchitectPlanSummary, 'projectId' | 'projectIds' | 'expectedProjectIds'>,
    scopedProjectIds: string[]
  ): boolean => {
    if (scopedProjectIds.length === 0) return true;
    const scopedProjectIdSet = new Set(scopedProjectIds);
    const planProjectIds = deps.getArchitectPlanProjectIds(plan);
    return planProjectIds.length === 0 || planProjectIds.some((projectId) => scopedProjectIdSet.has(projectId));
  };

  const listScopedPlans = async (branchName: string, scopedProjectIds: string[]) => {
    const fullResult = await deps.listArchitectPlans(branchName, true, true);
    const scopedPlans = fullResult.plans.filter((plan) => isPlanVisibleForScope(plan, scopedProjectIds));
    return {
      fullResult,
      scopedPlans,
    };
  };

  const isArchitectPlanBlankDraft = (
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

  const ensureScopedBlankPlan = async (params: {
    branchName: string;
    scopedProjectIds: string[];
    contextProjectIds?: string[];
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
      const plan = await deps.getArchitectPlan(params.branchName, candidate.id);
      if (!plan || plan.status === 'deleted') {
        continue;
      }

      const [needs, chatMessages] = await Promise.all([
        deps.getArchitectPlanNeeds(params.branchName, candidate.id),
        deps.getArchitectPlanChatMessages(params.branchName, candidate.id),
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

      const nextLabel = deps.getNextDefaultNewPlanLabel(nextLabels);
      await deps.updateArchitectPlan({
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

      const nextLabel = deps.getNextDefaultNewPlanLabel(nextLabels);
      await deps.updateArchitectPlan({
        branchName: params.branchName,
        planId: candidate.summary.id,
        label: nextLabel,
      });
      nextLabels.push({
        ...candidate.summary,
        label: nextLabel,
      });
    }

    if (!deps.isDefaultNewPlanBaseLabel(blankPlan.plan.label)) {
      return deps.updateArchitectPlan({
        branchName: params.branchName,
        planId: blankPlan.plan.id,
        label: deps.DEFAULT_NEW_PLAN_LABEL,
      });
    }

    return blankPlan.plan;
  };

  const ensureProjectGroupPlan = async (params: {
    branchName: string;
    scopedProjectIds: string[];
    contextProjectIds?: string[];
  }): Promise<EnsureProjectGroupPlanResult | null> => {
    if (params.scopedProjectIds.length === 0) {
      return null;
    }

    const { scopedPlans } = await listScopedPlans(params.branchName, params.scopedProjectIds);
    const visiblePlans = scopedPlans.filter((plan) => plan.status !== 'archived' && plan.status !== 'deleted');
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
      const mergedContextProjectIds = mergeProjectIds(
        blankPlan.contextProjectIds,
        params.contextProjectIds
      );

      if (!coversScope(mergedProjectIds, params.scopedProjectIds)) {
        return null;
      }

      if (
        !coversScope(blankPlan.projectIds || [], params.scopedProjectIds) ||
        !coversScope(blankPlan.expectedProjectIds || blankPlan.projectIds || [], params.scopedProjectIds) ||
        !coversScope(blankPlan.contextProjectIds || [], params.contextProjectIds || [])
      ) {
        const expandedPlan = await deps.updateArchitectPlan({
          branchName: params.branchName,
          planId: blankPlan.id,
          projectIds: mergedProjectIds,
          contextProjectIds: mergedContextProjectIds,
          expectedProjectIds: mergedProjectIds,
          targetBranchesByProjectId: deps.getTargetBranchesByProjectId?.(mergedProjectIds),
          setActive: true,
        });
        const needs = await deps.getArchitectPlanNeeds(params.branchName, expandedPlan.id);
        return {
          action: 'expanded_blank',
          plan: expandedPlan,
          needs,
        };
      }

      await deps.setActiveArchitectPlan(params.branchName, blankPlan.id);
      const needs = await deps.getArchitectPlanNeeds(params.branchName, blankPlan.id);
      return {
        action: 'reused_blank',
        plan: blankPlan,
        needs,
      };
    }

    if (visiblePlans.length > 0) {
      return null;
    }

    const createdPlan = await deps.createArchitectPlan({
      branchName: params.branchName,
      label: deps.DEFAULT_NEW_PLAN_LABEL,
      projectId: params.scopedProjectIds[0] || undefined,
      projectIds: params.scopedProjectIds,
      contextProjectIds: params.contextProjectIds,
      targetBranchesByProjectId: deps.getTargetBranchesByProjectId?.(params.scopedProjectIds),
      status: 'draft',
      setActive: true,
    });

    return {
      action: 'created',
      plan: createdPlan,
      needs: [],
    };
  };

  return {
    ensureProjectGroupPlan,
    ensureScopedBlankPlan,
    isArchitectPlanBlankDraft,
  };
};
