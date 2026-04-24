import type { Need } from '../types';
import {
  isArchitectPlanVisibleForScope,
  type ArchitectPlanRecord,
  type ArchitectPlanSummary,
} from './architectPlanService';

export type ArchitectAutoPlanTrigger = 'implicit_resume' | 'explicit_create';

type ArchitectPlanNamingShape = Pick<ArchitectPlanSummary, 'id' | 'slug' | 'title' | 'label'>;

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
  deleteArchitectPlan: (params: {
    branchName: string;
    planId: string;
    hardDelete?: boolean;
  }) => Promise<void>;
  getArchitectPlan: (branchName: string, planId: string) => Promise<ArchitectPlanRecord | null>;
  getArchitectPlanChatMessages: (branchName: string, planId: string) => Promise<Array<unknown>>;
  getArchitectPlanEditableName: (plan: ArchitectPlanNamingShape) => string;
  getArchitectPlanNeeds: (branchName: string, planId: string) => Promise<Need[]>;
  getArchitectPlanVisibleProjectIds: (
    plan: Pick<ArchitectPlanSummary, 'projectId' | 'projectIds' | 'expectedProjectIds'>
  ) => string[];
  getNextDefaultNewPlanLabel: (plans: ArchitectPlanSummary[]) => string;
  isCanonicalArchitectPlan: (plan: ArchitectPlanNamingShape) => boolean;
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

export interface EnsureScopedBlankPlanResult {
  action: 'created' | 'reused_blank' | 'expanded_blank';
  plan: ArchitectPlanRecord;
}

export interface ConsolidateScopedBlankPlansResult {
  deletedPlanIds: string[];
}

type PlaceholderCandidatePlan = ArchitectPlanNamingShape & Pick<ArchitectPlanSummary, 'status'>;

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

const normalizePlanIdList = (projectIds?: string[]): string[] =>
  Array.from(
    new Set(
      (projectIds || [])
        .map((projectId) => projectId.trim())
        .filter((projectId) => projectId.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));

export const createArchitectAutoPlanService = (deps: ArchitectAutoPlanDependencies) => {
  const belongsToPlaceholderFamily = (plan: PlaceholderCandidatePlan): boolean =>
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
    plan: Pick<
      ArchitectPlanRecord,
      'id' | 'slug' | 'title' | 'label' | 'status' | 'description' | 'nodes' | 'predictedBranches'
    >,
    needs: Need[],
    chatMessages: Array<unknown>
  ): boolean =>
    belongsToPlaceholderFamily(plan) &&
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

  const isDefinitelyNonBlankSummary = (plan: ArchitectPlanSummary): boolean =>
    !belongsToPlaceholderFamily(plan) ||
    Boolean(trimToNull(plan.description)) ||
    plan.nodeCount > 0 ||
    (plan.predictedBranchCount || 0) > 0 ||
    (plan.needCount || 0) > 0 ||
    (plan.chatMessageCount || 0) > 0;

  const isDefinitelyBlankSummary = (plan: ArchitectPlanSummary): boolean =>
    belongsToPlaceholderFamily(plan) &&
    !trimToNull(plan.description) &&
    plan.nodeCount === 0 &&
    (plan.predictedBranchCount || 0) === 0 &&
    plan.needCount === 0 &&
    plan.chatMessageCount === 0;

  const getBlankScopeSignature = (plan: ArchitectPlanSummary): string => {
    const explicitActionableProjectIds = normalizePlanIdList(plan.projectIds);
    const actionableProjectIds =
      explicitActionableProjectIds.length > 0
        ? explicitActionableProjectIds
        : normalizePlanIdList(deps.getArchitectPlanVisibleProjectIds(plan));
    const contextProjectIds = normalizePlanIdList(plan.contextProjectIds);
    const targetBranchesByProjectId = Object.fromEntries(
      actionableProjectIds.map((projectId) => [
        projectId,
        plan.targetBranchesByProjectId?.[projectId] ?? plan.targetBranch,
      ])
    );

    return JSON.stringify({
      actionableProjectIds,
      contextProjectIds,
      targetBranchesByProjectId,
    });
  };

  const consolidateBlankCandidateSummaries = async (params: {
    branchName: string;
    blankCandidates: ArchitectPlanSummary[];
    preferredPlanId?: string | null;
  }): Promise<ConsolidateScopedBlankPlansResult & {
    blankCandidates: ArchitectPlanSummary[];
  }> => {
    const candidatesByScope = new Map<string, ArchitectPlanSummary[]>();
    params.blankCandidates.forEach((candidate) => {
      const scopeSignature = getBlankScopeSignature(candidate);
      const existing = candidatesByScope.get(scopeSignature) || [];
      existing.push(candidate);
      candidatesByScope.set(scopeSignature, existing);
    });

    const keptBlankCandidates: ArchitectPlanSummary[] = [];
    const deletedPlanIds: string[] = [];

    for (const candidates of candidatesByScope.values()) {
      const sortedCandidates = [...candidates].sort((left, right) =>
        compareBlankDraftPriority(left, right, params.preferredPlanId)
      );
      const keptCandidate = sortedCandidates[0];
      if (keptCandidate) {
        keptBlankCandidates.push(keptCandidate);
      }

      const losers = sortedCandidates.slice(1);
      if (losers.length === 0) {
        continue;
      }

      for (const candidate of losers) {
        await deps.deleteArchitectPlan({
          branchName: params.branchName,
          planId: candidate.id,
          hardDelete: true,
        });
        deletedPlanIds.push(candidate.id);
      }
    }

    keptBlankCandidates.sort((left, right) =>
      compareBlankDraftPriority(left, right, params.preferredPlanId)
    );

    return {
      blankCandidates: keptBlankCandidates,
      deletedPlanIds,
    };
  };

  const inspectVisiblePlans = async (params: {
    branchName: string;
    visiblePlans: ArchitectPlanSummary[];
    preferredPlanId?: string | null;
  }): Promise<{
    blankCandidates: ArchitectPlanSummary[];
    deletedPlanIds: string[];
    hasNonBlankVisiblePlan: boolean;
  }> => {
    const blankCandidates: ArchitectPlanSummary[] = [];
    let hasNonBlankVisiblePlan = false;

    for (const candidate of params.visiblePlans) {
      if (candidate.status !== 'draft' || isDefinitelyNonBlankSummary(candidate)) {
        hasNonBlankVisiblePlan = true;
        continue;
      }

      if (isDefinitelyBlankSummary(candidate)) {
        blankCandidates.push(candidate);
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
        blankCandidates.push(candidate);
      } else {
        hasNonBlankVisiblePlan = true;
      }
    }

    const consolidation = await consolidateBlankCandidateSummaries({
      branchName: params.branchName,
      blankCandidates,
      preferredPlanId: params.preferredPlanId,
    });

    return {
      blankCandidates: consolidation.blankCandidates,
      deletedPlanIds: consolidation.deletedPlanIds,
      hasNonBlankVisiblePlan,
    };
  };

  const synchronizeBlankPlanToScope = async (
    reusableBlankPlan: ArchitectPlanRecord,
    params: Pick<ScopedBlankPlanParams, 'branchName' | 'scopedProjectIds' | 'contextProjectIds'>
  ): Promise<ResolvedBlankPlanResult> => {
    const mergedProjectIds = mergeProjectIds(
      reusableBlankPlan.projectIds,
      params.scopedProjectIds
    );
    const mergedContextProjectIds = mergeProjectIds(
      reusableBlankPlan.contextProjectIds,
      params.contextProjectIds
    );
    const mergedExpectedProjectIds = mergeProjectIds(mergedProjectIds, mergedContextProjectIds);

    if (
      !coversScope(reusableBlankPlan.projectIds || [], params.scopedProjectIds) ||
      !coversScope(reusableBlankPlan.contextProjectIds || [], params.contextProjectIds || []) ||
      !coversScope(reusableBlankPlan.expectedProjectIds || [], mergedExpectedProjectIds)
    ) {
      const expandedPlan = await deps.updateArchitectPlan({
        branchName: params.branchName,
        planId: reusableBlankPlan.id,
        projectIds: mergedProjectIds,
        contextProjectIds: mergedContextProjectIds,
        expectedProjectIds: mergedExpectedProjectIds,
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
    params: Pick<ScopedBlankPlanParams, 'branchName' | 'scopedProjectIds' | 'contextProjectIds'> & {
      blankCandidates: ArchitectPlanSummary[];
    }
  ): Promise<ResolvedBlankPlanResult | null> => {
    for (const candidate of params.blankCandidates) {
      const reusableBlankPlan = await deps.getArchitectPlan(params.branchName, candidate.id);
      if (!reusableBlankPlan || reusableBlankPlan.status === 'deleted') {
        continue;
      }

      return synchronizeBlankPlanToScope(reusableBlankPlan, params);
    }

    return null;
  };

  const resolveVisibleScopedBlankPlan = async (
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
    return resolveScopedBlankPlan({
      ...params,
      blankCandidates: inspectedPlans.blankCandidates,
    });
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

  const consolidateScopedBlankPlans = async (
    params: Pick<ScopedBlankPlanParams, 'branchName' | 'scopedProjectIds'>
  ): Promise<ConsolidateScopedBlankPlansResult> => {
    if (params.scopedProjectIds.length === 0) {
      return {
        deletedPlanIds: [],
      };
    }

    const { fullResult, scopedPlans } = await listScopedPlans(params.branchName, params.scopedProjectIds);
    const visiblePlans = scopedPlans.filter((plan) => plan.status !== 'archived' && plan.status !== 'deleted');
    const inspectedPlans = await inspectVisiblePlans({
      branchName: params.branchName,
      visiblePlans,
      preferredPlanId: fullResult.activePlanId,
    });

    return {
      deletedPlanIds: inspectedPlans.deletedPlanIds,
    };
  };

  const ensureScopedBlankPlan = async (
    params: ScopedBlankPlanParams
  ): Promise<EnsureScopedBlankPlanResult | null> => {
    if (params.scopedProjectIds.length === 0) {
      return null;
    }

    const trigger = params.trigger ?? 'implicit_resume';
    const { fullResult, scopedPlans } = await listScopedPlans(params.branchName, params.scopedProjectIds);
    const visiblePlans = scopedPlans.filter((plan) => plan.status !== 'archived' && plan.status !== 'deleted');
    const resolvedBlankPlan = await resolveVisibleScopedBlankPlan({
      ...params,
      visiblePlans,
      preferredPlanId: fullResult.activePlanId,
    });
    if (resolvedBlankPlan) {
      return resolvedBlankPlan;
    }

    if (trigger !== 'explicit_create') {
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
    };
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
    const resolvedBlankPlan = await resolveScopedBlankPlan({
      ...params,
      blankCandidates: inspectedPlans.blankCandidates,
    });

    if (resolvedBlankPlan) {
      if (trigger === 'implicit_resume' && inspectedPlans.hasNonBlankVisiblePlan) {
        return null;
      }

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
    consolidateScopedBlankPlans,
    ensureProjectGroupPlan,
    ensureScopedBlankPlan,
    isArchitectPlanBlankDraft: isReusableBlankDraft,
    isReusableBlankDraft,
  };
};
