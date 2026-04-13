import type { Need } from '../types';
import {
  isArchitectPlanVisibleForScope,
  type ArchitectPlanRecord,
  type ArchitectPlanSummary,
} from './architectPlanService';

export type ArchitectAutoPlanTrigger = 'implicit_resume' | 'explicit_create';

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
  isDefaultNewPlanFamilyLabel: (value?: string | null) => boolean;
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

interface ResolvedBlankPlanResult {
  action: 'reused_blank' | 'expanded_blank';
  plan: ArchitectPlanRecord;
}

interface ScopedBlankPlanParams {
  branchName: string;
  scopedProjectIds: string[];
  contextProjectIds?: string[];
  trigger?: ArchitectAutoPlanTrigger;
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
  const belongsToPlaceholderFamily = (plan: ArchitectPlanSummary): boolean =>
    plan.status === 'draft' &&
    deps.isCanonicalArchitectPlan(plan) &&
    deps.isDefaultNewPlanFamilyLabel(deps.getArchitectPlanEditableName(plan));

  const listScopedPlans = async (branchName: string, scopedProjectIds: string[]) => {
    const fullResult = await deps.listArchitectPlans(branchName, true, true);
    const scopedPlans = fullResult.plans.filter((plan) => isArchitectPlanVisibleForScope(plan, scopedProjectIds));
    return {
      fullResult,
      scopedPlans,
    };
  };

  const isReusableBlankDraft = (
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

  const compareBlankDraftPriority = (
    left: Pick<ArchitectPlanSummary, 'id' | 'createdAt' | 'updatedAt'>,
    right: Pick<ArchitectPlanSummary, 'id' | 'createdAt' | 'updatedAt'>,
    preferredPlanId?: string | null
  ): number => {
    const leftIsPreferred = preferredPlanId === left.id;
    const rightIsPreferred = preferredPlanId === right.id;
    if (leftIsPreferred !== rightIsPreferred) {
      return leftIsPreferred ? -1 : 1;
    }

    const leftTime = new Date(left.updatedAt).getTime();
    const rightTime = new Date(right.updatedAt).getTime();
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }

    const leftCreatedAt = new Date(left.createdAt).getTime();
    const rightCreatedAt = new Date(right.createdAt).getTime();
    if (leftCreatedAt !== rightCreatedAt) {
      return rightCreatedAt - leftCreatedAt;
    }

    return left.id.localeCompare(right.id);
  };

  const inspectVisiblePlans = async (params: {
    branchName: string;
    visiblePlans: ArchitectPlanSummary[];
    preferredPlanId?: string | null;
  }): Promise<{
    blankCandidates: Array<{
      summary: ArchitectPlanSummary;
      plan: ArchitectPlanRecord;
    }>;
    hasNonBlankVisiblePlan: boolean;
  }> => {
    const blankCandidates: Array<{
      summary: ArchitectPlanSummary;
      plan: ArchitectPlanRecord;
    }> = [];
    let hasNonBlankVisiblePlan = false;

    for (const candidate of params.visiblePlans) {
      if (candidate.status !== 'draft') {
        hasNonBlankVisiblePlan = true;
        continue;
      }

      const plan = await deps.getArchitectPlan(params.branchName, candidate.id);
      if (!plan || plan.status === 'deleted') {
        continue;
      }

      const [needs, chatMessages] = await Promise.all([
        deps.getArchitectPlanNeeds(params.branchName, candidate.id),
        deps.getArchitectPlanChatMessages(params.branchName, candidate.id),
      ]);

      if (isReusableBlankDraft(plan, needs, chatMessages)) {
        blankCandidates.push({ summary: candidate, plan });
      } else {
        hasNonBlankVisiblePlan = true;
      }
    }

    blankCandidates.sort((left, right) =>
      compareBlankDraftPriority(left.summary, right.summary, params.preferredPlanId)
    );

    return {
      blankCandidates,
      hasNonBlankVisiblePlan,
    };
  };

  const synchronizeBlankPlanToScope = async (
    reusableBlankPlan: ArchitectPlanRecord,
    params: Pick<ScopedBlankPlanParams, 'branchName' | 'scopedProjectIds' | 'contextProjectIds'>
  ): Promise<ResolvedBlankPlanResult> => {
    const mergedProjectIds = mergeProjectIds(
      reusableBlankPlan.projectIds,
      reusableBlankPlan.expectedProjectIds,
      params.scopedProjectIds
    );
    const mergedContextProjectIds = mergeProjectIds(
      reusableBlankPlan.contextProjectIds,
      params.contextProjectIds
    );

    if (
      !coversScope(reusableBlankPlan.projectIds || [], params.scopedProjectIds) ||
      !coversScope(
        reusableBlankPlan.expectedProjectIds || reusableBlankPlan.projectIds || [],
        params.scopedProjectIds
      ) ||
      !coversScope(reusableBlankPlan.contextProjectIds || [], params.contextProjectIds || [])
    ) {
      const expandedPlan = await deps.updateArchitectPlan({
        branchName: params.branchName,
        planId: reusableBlankPlan.id,
        projectIds: mergedProjectIds,
        contextProjectIds: mergedContextProjectIds,
        expectedProjectIds: mergedProjectIds,
        targetBranchesByProjectId: deps.getTargetBranchesByProjectId?.(mergedProjectIds),
      });
      return {
        action: 'expanded_blank',
        plan: expandedPlan,
      };
    }

    return {
      action: 'reused_blank',
      plan: reusableBlankPlan,
    };
  };

  const resolveScopedBlankPlan = async (
    params: ScopedBlankPlanParams & {
      visiblePlans: ArchitectPlanSummary[];
      preferredPlanId?: string | null;
    }
  ): Promise<ResolvedBlankPlanResult | null> => {
    const inspectedPlans = await inspectVisiblePlans({
      branchName: params.branchName,
      visiblePlans: params.visiblePlans,
      preferredPlanId: params.preferredPlanId,
    });
    const reusableBlankPlan = inspectedPlans.blankCandidates[0]?.plan ?? null;
    if (!reusableBlankPlan) {
      return null;
    }

    return synchronizeBlankPlanToScope(reusableBlankPlan, params);
  };

  const getPlaceholderLabelForNewPlan = (plans: ArchitectPlanSummary[]): string => {
    const activePlaceholderPlans = plans.filter(
      (plan) => plan.status !== 'deleted' && belongsToPlaceholderFamily(plan)
    );
    const baseLabelTaken = activePlaceholderPlans.some((plan) =>
      deps.isDefaultNewPlanBaseLabel(deps.getArchitectPlanEditableName(plan))
    );

    return baseLabelTaken
      ? deps.getNextDefaultNewPlanLabel(activePlaceholderPlans)
      : deps.DEFAULT_NEW_PLAN_LABEL;
  };

  const ensureScopedBlankPlan = async (params: ScopedBlankPlanParams): Promise<ArchitectPlanRecord | null> => {
    if (params.scopedProjectIds.length === 0) {
      return null;
    }

    const trigger = params.trigger ?? 'implicit_resume';
    const { fullResult, scopedPlans } = await listScopedPlans(params.branchName, params.scopedProjectIds);
    const visiblePlans = scopedPlans.filter((plan) => plan.status !== 'archived' && plan.status !== 'deleted');
    const resolvedBlankPlan = await resolveScopedBlankPlan({
      ...params,
      visiblePlans,
      preferredPlanId: fullResult.activePlanId,
    });
    if (resolvedBlankPlan) {
      return resolvedBlankPlan.plan;
    }

    if (trigger !== 'explicit_create') {
      return null;
    }

    return deps.createArchitectPlan({
      branchName: params.branchName,
      label: getPlaceholderLabelForNewPlan(scopedPlans),
      projectId: params.scopedProjectIds[0] || undefined,
      projectIds: params.scopedProjectIds,
      contextProjectIds: params.contextProjectIds,
      targetBranchesByProjectId: deps.getTargetBranchesByProjectId?.(params.scopedProjectIds),
      status: 'draft',
      setActive: true,
    });
  };

  const ensureProjectGroupPlan = async (params: ScopedBlankPlanParams): Promise<EnsureProjectGroupPlanResult | null> => {
    if (params.scopedProjectIds.length === 0) {
      return null;
    }

    const trigger = params.trigger ?? 'implicit_resume';
    const { fullResult, scopedPlans } = await listScopedPlans(params.branchName, params.scopedProjectIds);
    const visiblePlans = scopedPlans.filter((plan) => plan.status !== 'archived' && plan.status !== 'deleted');
    const inspectedPlans = await inspectVisiblePlans({
      branchName: params.branchName,
      visiblePlans,
      preferredPlanId: fullResult.activePlanId,
    });
    const reusableBlankPlan = inspectedPlans.blankCandidates[0]?.plan ?? null;

    if (reusableBlankPlan) {
      if (trigger === 'implicit_resume' && inspectedPlans.hasNonBlankVisiblePlan) {
        return null;
      }

      const resolvedBlankPlan = await synchronizeBlankPlanToScope(reusableBlankPlan, params);
      const blankPlan = resolvedBlankPlan.plan;
      await deps.setActiveArchitectPlan(params.branchName, blankPlan.id);
      const needs = await deps.getArchitectPlanNeeds(params.branchName, blankPlan.id);
      return {
        action: resolvedBlankPlan.action,
        plan: blankPlan,
        needs,
      };
    }

    if (trigger !== 'explicit_create' && visiblePlans.length > 0) {
      return null;
    }

    const createdPlan = await deps.createArchitectPlan({
      branchName: params.branchName,
      label: getPlaceholderLabelForNewPlan(scopedPlans),
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
    isArchitectPlanBlankDraft: isReusableBlankDraft,
    isReusableBlankDraft,
  };
};
