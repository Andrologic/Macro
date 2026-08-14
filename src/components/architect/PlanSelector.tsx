import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  archiveArchitectPlan,
  getArchitectPlan,
  getArchitectPlanCrudCapabilities,
  getArchitectPlanTargetDisplay,
  getArchitectPlanVisibleProjectIds,
  getGitFlowBaseBranch,
  getGitFlowMainBranch,
  isArchitectPlanReplicaDivergenceError,
  listArchitectPlans,
  repairArchitectPlanReplicas,
  restoreArchitectPlan,
  updateArchitectPlan,
  type ArchitectPlanReplicaDivergence,
  type ArchitectPlanRecord,
  type ArchitectPlanSummary,
} from '../../services/architectPlanService';
import {
  cleanupPlanBranches,
  deletePlanAndCleanupBranches,
} from '../../services/architectGitFlowService';
import {
  getArchitectPlanKind,
  getPlanKindBackmergeBranch,
  getCreatableArchitectPlanKinds,
  getPlanKindSourceBranch,
  getPlanKindTargetBranch,
  normalizeVersionSlug,
  type ArchitectPlanGitFlowMetadata,
  type ArchitectPlanKind,
} from '../../services/architectPlanKinds';
import { detectProjectVersions } from '../../services/architectPlanVersionDetection';
import {
  getScopedActionableProjectIds,
  getScopedProjectIds,
  getScopedReadOnlyProjectIds,
} from '../../services/globalProjects';
import {
  isProjectWorkspaceMissing,
  resolveProjectWorkspaceState,
} from '../../services/projectWorkspaceState';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { Icon } from '../ui/Icon';
import { ProjectWorkspaceEmptyState } from '../shared/ProjectWorkspaceEmptyState';
import { ActionableErrorCallout } from '../shared/ActionableErrorCallout';
import { notify } from '../ui/toastService';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { PlanFormModal } from './PlanFormModal';
import { cn } from '../../utils/cn';
import { formatDate } from '../../i18n/format';
import {
  getArchitectPlanDisplayName,
  getArchitectPlanEditableName,
  getArchitectPlanLifecyclePhase,
  getArchitectPlanPrimaryName,
  getArchitectPlanSecondaryLabel,
  isCanonicalArchitectPlan,
} from '../../services/architectPlanPresentation';
import { toServiceError } from '../../services/contracts/errors';
import { planKindIconName } from '../../services/planKindPresentation';
import {
  ensureScopedBlankPlan,
} from '../../services/architectAutoPlan';
import {
  computePlanSelectorRefreshState,
  getPlanSelectorNullLoadDisposition,
  computePlanSelectorEmptyState,
  resolveVerifiedPlanDeletionRecovery,
  type PlanSelectorMutationCheck,
  type PlanSelectorRefreshState,
} from './planSelectorState';
import {
  ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT,
  ARCHITECT_PLAN_SELECTOR_STATE_EVENT,
  type ArchitectPlanSelectorRequestDetail,
  type ArchitectPlanSelectorStateDetail,
} from './planSelectorEvents';
import { useChatStore } from '../../stores/useChatStore';
import {
  removeLinkedConversationDeletionSaga,
  upsertLinkedConversationDeletionSaga,
} from '../../services/linkedTaskDeletionSaga';
import {
  removePlanLifecycleSaga,
  upsertPlanLifecycleSaga,
} from '../../services/planLifecycleSaga';
import { presentReplicaIssue } from '../../services/degradedErrorPresentation';
import { buildArchitectPlanCatalogScopeKey } from '../../services/macroProjectMetadataLoader';
import { toPlanLocatorKey } from '../../services/durableIdentity';

interface PlanSelectorProps {
  className?: string;
}

const bumpPatchVersion = (version: string | null): string | null => {
  const normalized = normalizeVersionSlug(version);
  if (!normalized) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(normalized);
  if (!match) return normalized;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] || ''}`;
};

interface PlanSelectorAsyncContext {
  targetBranch: string;
  scopedProjectIdsKey: string;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  showArchived: boolean;
  activeArchitectPlanId: string | null;
}

const buildProjectScopeKey = (projectIds: string[]): string => projectIds.join('\u0000');

const arePlanSelectorAsyncContextsEqual = (
  left: PlanSelectorAsyncContext | null,
  right: PlanSelectorAsyncContext | null
): boolean => {
  if (!left || !right) {
    return false;
  }

  return (
    left.targetBranch === right.targetBranch &&
    left.scopedProjectIdsKey === right.scopedProjectIdsKey &&
    left.selectedGroupId === right.selectedGroupId &&
    left.selectedProjectId === right.selectedProjectId &&
    left.showArchived === right.showArchived &&
    left.activeArchitectPlanId === right.activeArchitectPlanId
  );
};

const arePlanSelectorActivationContextsEqual = (
  left: PlanSelectorAsyncContext | null,
  right: PlanSelectorAsyncContext | null
): boolean => {
  if (!left || !right) {
    return false;
  }

  return (
    left.targetBranch === right.targetBranch &&
    left.scopedProjectIdsKey === right.scopedProjectIdsKey &&
    left.selectedGroupId === right.selectedGroupId &&
    left.selectedProjectId === right.selectedProjectId &&
    left.showArchived === right.showArchived
  );
};

const statusClassName: Record<string, string> = {
  blank: 'text-slate-500 bg-slate-500/10 border-slate-500/20',
  editing: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
  draft: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
  validated: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
  in_progress: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
  completed: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
  archived: 'text-muted-foreground bg-muted/50 border-border/70',
  deleted: 'text-red-500 bg-red-500/10 border-red-500/20',
};

const planKindClassName: Record<ArchitectPlanKind, string> = {
  feature: 'border-sky-500/25 bg-sky-500/10 text-sky-500',
  release: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500',
  hotfix: 'border-red-500/25 bg-red-500/10 text-red-500',
  bugfix: 'border-violet-500/25 bg-violet-500/10 text-violet-500',
};

const planKindIconClassName: Record<ArchitectPlanKind, string> = {
  feature: 'text-sky-500',
  release: 'text-emerald-500',
  hotfix: 'text-red-500',
  bugfix: 'text-violet-500',
};

const formatRelativeDate = (iso: string, unknownLabel: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return unknownLabel;
  return formatDate(date);
};

const summarizeArchitectPlanRecord = (
  plan: ArchitectPlanRecord
): ArchitectPlanSummary => ({
  id: plan.id,
  slug: plan.slug,
  title: plan.title,
  label: plan.label,
  description: plan.description,
  planKind: plan.planKind,
  gitFlowPlan: plan.gitFlowPlan,
  status: plan.status,
  targetBranch: plan.targetBranch,
  targetBranchesByProjectId: plan.targetBranchesByProjectId,
  conversationId: plan.conversationId,
  projectId: plan.projectId,
  projectIds: plan.projectIds,
  contextProjectIds: plan.contextProjectIds,
  expectedProjectIds: plan.expectedProjectIds,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
  nodeCount: plan.nodes.length,
  predictedBranchCount: plan.predictedBranches.length,
  availableProjectIds: plan.availableProjectIds,
  missingProjectIds: plan.missingProjectIds,
  replicationState: plan.replicationState,
  revision: plan.revision,
  replicas: plan.replicas,
  hasReplicaDivergence: plan.hasReplicaDivergence,
});

export const PlanSelector: React.FC<PlanSelectorProps> = ({ className }) => {
  const { t } = useTranslation();
  const {
    activeArchitectPlanId,
    activePlanContext,
    standaloneProjects,
    projectGroups,
    selectedGroupId,
    selectedProjectId,
    getProjectById,
    openProjectGitFlowModal,
    setSelectedProject,
    setActiveArchitectPlanId,
    setPlanNodes,
    setPredictedBranches,
    setActivePlanContext,
    activateArchitectPlan,
    loadMacroProjectMetadataForSelection,
    architectPlanCatalogScopeKey,
    architectPlanCatalogModernPlanCount,
    architectPlanCatalogVisiblePlanCount,
    visibleArchitectPlans,
    architectPlanCatalogStatus,
  } = useAppStore();
  const [isOpen, setIsOpen] = useState(false);
  const [plans, setPlans] = useState<ArchitectPlanSummary[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isActivating, setIsActivating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planToDelete, setPlanToDelete] = useState<ArchitectPlanSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showCreateKinds, setShowCreateKinds] = useState(false);
  const [creatingPlanKind, setCreatingPlanKind] = useState<ArchitectPlanKind | null>(null);
  const [hasLoadedPlans, setHasLoadedPlans] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastEffectIdRef = useRef<string | null | undefined>(undefined);
  const loadPlansRequestIdRef = useRef(0);
  const activationRequestIdRef = useRef(0);
  const selectorAsyncContextRef = useRef<PlanSelectorAsyncContext | null>(null);
  const targetBranch = getGitFlowBaseBranch();

  const [planFormModal, setPlanFormModal] = useState<ArchitectPlanSummary | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [replicaRepair, setReplicaRepair] = useState<{
    divergence: ArchitectPlanReplicaDivergence;
    message: string;
  } | null>(null);
  const [isRepairingReplica, setIsRepairingReplica] = useState(false);
  const pendingReplicaRetryRef = useRef<(() => Promise<void>) | null>(null);

  const activePlan = useMemo(() => {
    if (!activePlanId) return null;
    const activeBranch = activePlanContext?.targetBranch;
    return plans.find((plan) =>
      plan.id === activePlanId && (!activeBranch || plan.targetBranch === activeBranch)
    ) || null;
  }, [plans, activePlanContext?.targetBranch, activePlanId]);
  const projectRegistry = useMemo(
    () => ({ standaloneProjects: standaloneProjects ?? [], projectGroups }),
    [projectGroups, standaloneProjects]
  );
  const scopedProjectIds = useMemo(
    () => getScopedProjectIds(projectRegistry, selectedGroupId, selectedProjectId),
    [projectRegistry, selectedGroupId, selectedProjectId]
  );
  const currentCatalogScopeKey = useMemo(
    () =>
      buildArchitectPlanCatalogScopeKey({
        selectedGroupId,
        selectedProjectId,
        scopedProjectIds,
      }),
    [scopedProjectIds, selectedGroupId, selectedProjectId]
  );
  const isPlanCatalogForCurrentScope = architectPlanCatalogScopeKey === currentCatalogScopeKey;
  const selectorAsyncContext = useMemo<PlanSelectorAsyncContext>(
    () => ({
      targetBranch,
      scopedProjectIdsKey: buildProjectScopeKey(scopedProjectIds),
      selectedGroupId: selectedGroupId ?? null,
      selectedProjectId: selectedProjectId ?? null,
      showArchived,
      activeArchitectPlanId: activeArchitectPlanId ?? null,
    }),
    [
      activeArchitectPlanId,
      scopedProjectIds,
      selectedGroupId,
      selectedProjectId,
      showArchived,
      targetBranch,
    ]
  );
  useLayoutEffect(() => {
    selectorAsyncContextRef.current = selectorAsyncContext;
  }, [selectorAsyncContext]);
  const isCurrentLoadRequest = (
    requestId: number,
    context: PlanSelectorAsyncContext
  ): boolean =>
    loadPlansRequestIdRef.current === requestId &&
    arePlanSelectorAsyncContextsEqual(selectorAsyncContextRef.current, context);
  const isCurrentActivationRequest = (
    requestId: number,
    context: PlanSelectorAsyncContext
  ): boolean =>
    activationRequestIdRef.current === requestId &&
    arePlanSelectorActivationContextsEqual(selectorAsyncContextRef.current, context);
  const scopedActionableProjectIds = useMemo(
    () => getScopedActionableProjectIds(projectRegistry, selectedGroupId, selectedProjectId),
    [projectRegistry, selectedGroupId, selectedProjectId]
  );
  const contextProjectIds = useMemo(
    () => getScopedReadOnlyProjectIds(projectRegistry, selectedGroupId, selectedProjectId),
    [projectRegistry, selectedGroupId, selectedProjectId]
  );
  const workspaceState = useMemo(
    () =>
      resolveProjectWorkspaceState({
        standaloneProjects,
        projectGroups,
        selectedGroupId,
        selectedProjectId,
      }),
    [projectGroups, selectedGroupId, selectedProjectId, standaloneProjects]
  );
  const isWorkspaceMissing = isProjectWorkspaceMissing(workspaceState);
  const scopedReadOnlyProjects = useMemo(
    () =>
      contextProjectIds
        .map((projectId) => getProjectById(projectId))
        .filter((project): project is NonNullable<typeof project> => Boolean(project)),
    [contextProjectIds, getProjectById]
  );
  const firstReadOnlyProject = scopedReadOnlyProjects[0] ?? null;
  const isReadOnlyOnlyScope = scopedProjectIds.length > 0 && scopedActionableProjectIds.length === 0;
  const canCreatePlanForScope = !isWorkspaceMissing && !isReadOnlyOnlyScope;
  const creatablePlanKinds = useMemo(
    () =>
      getCreatableArchitectPlanKinds(
        scopedActionableProjectIds.map((projectId) => getProjectById(projectId)?.gitFlowSettings ?? null)
      ),
    [scopedActionableProjectIds, getProjectById]
  );
  const displayedActivePlanTitle = useMemo(() => {
    if (activePlanContext && activePlanContext.id === activePlanId) {
      return getArchitectPlanPrimaryName(activePlanContext);
    }
    return activePlan ? getArchitectPlanPrimaryName(activePlan) : t('architect.planSelector.selectPlan', 'Select plan');
  }, [activePlan, activePlanContext, activePlanId, t]);
  const displayedActivePlanKind = useMemo<ArchitectPlanKind | null>(() => {
    if (activePlanContext && activePlanContext.id === activePlanId) {
      return getArchitectPlanKind(activePlanContext);
    }
    return activePlan ? getArchitectPlanKind(activePlan) : null;
  }, [activePlan, activePlanContext, activePlanId]);
  const planSelectorEmptyState = useMemo(
    () =>
      computePlanSelectorEmptyState({
        hasError: Boolean(error),
        isLoading,
        hasLoadedPlans,
        isWorkspaceMissing,
        isReadOnlyOnlyScope,
        displayedPlanCount: plans.length,
        catalogStatus: architectPlanCatalogStatus,
        isCatalogForCurrentScope: isPlanCatalogForCurrentScope,
        catalogModernPlanCount: architectPlanCatalogModernPlanCount,
        catalogVisiblePlanCount: architectPlanCatalogVisiblePlanCount,
      }),
    [
      architectPlanCatalogModernPlanCount,
      architectPlanCatalogStatus,
      architectPlanCatalogVisiblePlanCount,
      error,
      hasLoadedPlans,
      isLoading,
      isPlanCatalogForCurrentScope,
      isReadOnlyOnlyScope,
      isWorkspaceMissing,
      plans.length,
    ]
  );
  const displayedActivePlanKindLabel = displayedActivePlanKind
    ? displayedActivePlanKind === 'feature'
      ? t('architect.planSelector.kindFeature', 'Feature')
      : displayedActivePlanKind === 'release'
        ? t('architect.planSelector.kindRelease', 'Release')
        : displayedActivePlanKind === 'hotfix'
          ? t('architect.planSelector.kindHotfix', 'Hotfix')
          : t('architect.planSelector.kindBugfix', 'Bugfix')
    : null;
  const replicaRepairPresentation = useMemo(() => {
    if (!replicaRepair) return null;
    const missingCount = replicaRepair.divergence.replicas.filter((replica) => replica.missing).length;
    return presentReplicaIssue({
      reason: replicaRepair.divergence.reason,
      planId: replicaRepair.divergence.planId,
      missingCount,
      technicalMessage: replicaRepair.message,
    });
  }, [replicaRepair]);

  const openReplicaRepair = (
    error: unknown,
    retry?: () => Promise<void>,
    options?: { toastOnError?: boolean }
  ): boolean => {
    if (!isArchitectPlanReplicaDivergenceError(error)) {
      return false;
    }

    pendingReplicaRetryRef.current = retry || null;
    setReplicaRepair({
      divergence: error.divergence,
      message: error.message,
    });
    setError(error.message);
    if (options?.toastOnError !== false) {
      notify.error(error.message);
    }
    return true;
  };

  const resolveOperationMessage = (value: unknown, fallback: string): string =>
    (() => {
      const message = toServiceError(value).message.trim();
      return message && message !== 'Unknown error' ? message : fallback;
    })();

  const readOnlyCtaLabel = firstReadOnlyProject?.readOnlyReason === 'missing_git'
    ? t('projects.initializeGitAction', 'Initialize Git')
    : firstReadOnlyProject?.readOnlyReason === 'missing_initial_commit'
      ? t('projects.createInitialCommitAction', 'Create initial commit')
      : t('projects.projectSettings', 'Project settings');

  const openReadOnlyProjectSettings = () => {
    if (!firstReadOnlyProject) {
      return;
    }
    setSelectedProject(firstReadOnlyProject.id);
    openProjectGitFlowModal(firstReadOnlyProject.id);
  };

  const clearActivePlanSelection = () => {
    setActivePlanId(null);
    setActiveArchitectPlanId(null);
    setPlanNodes([]);
    setPredictedBranches([]);
    setActivePlanContext(null);
  };

  const applyRefreshedPlanSelectorState = async (params: {
    refreshState: PlanSelectorRefreshState;
    hydrateActive?: boolean;
  }): Promise<PlanSelectorRefreshState> => {
    const { refreshState } = params;
    setPlans(refreshState.visiblePlans);
    setActivePlanId(refreshState.nextActivePlanId);

    if (params.hydrateActive) {
      if (!refreshState.nextActivePlanId) {
        clearActivePlanSelection();
      } else if (refreshState.nextActivePlanId !== activeArchitectPlanId) {
        await activatePlan(
          refreshState.nextActivePlanId,
          refreshState.visiblePlans.find(
            (plan) => plan.id === refreshState.nextActivePlanId
          ) ?? null
        );
      }
    }

    return refreshState;
  };

  const refreshPlanSelectorAfterMutation = async (params: {
    mutation: PlanSelectorMutationCheck;
    refreshTasks?: boolean;
  }): Promise<PlanSelectorRefreshState> => {
    if (params.refreshTasks) {
      await useTaskStore.getState().refreshFromPlan();
    }

    const refreshed = await listArchitectPlans(targetBranch, true, true, {
      scopedProjectIdsHint: scopedProjectIds,
    });
    const refreshState = computePlanSelectorRefreshState({
      plans: refreshed.plans,
      scopedProjectIds,
      showArchived,
      preferredActivePlanId: activeArchitectPlanId || refreshed.activePlanId,
      currentActivePlanId: activePlanId || activeArchitectPlanId,
      mutation: params.mutation,
    });

    return applyRefreshedPlanSelectorState({
      refreshState,
      hydrateActive:
        refreshState.nextActivePlanId !== activePlanId ||
        (refreshState.nextActivePlanId === null && activePlanId !== null),
    });
  };

  const performReplicaRepair = async (strategy: 'newest' | 'oldest'): Promise<void> => {
    if (!replicaRepair) return;

    setIsRepairingReplica(true);
    try {
      await repairArchitectPlanReplicas({
        branchName: replicaRepair.divergence.branchName,
        planId: replicaRepair.divergence.planId,
        strategy,
      });
      setReplicaRepair(null);
      await loadPlans(true);
      const retry = pendingReplicaRetryRef.current;
      pendingReplicaRetryRef.current = null;
      if (retry) {
        await retry();
      }
      notify.success(
        strategy === 'oldest'
          ? t('architect.planSelector.replicaRepairOldest', 'Plan metadata repaired from the oldest replica.')
          : t('architect.planSelector.replicaRepairNewest', 'Plan metadata repaired from the newest replica.')
      );
    } catch (repairError) {
      const message = resolveOperationMessage(
        repairError,
        t('architect.planSelector.errorRepairReplica', 'Failed to repair plan metadata.')
      );
      setError(message);
      notify.error(message);
    } finally {
      setIsRepairingReplica(false);
    }
  };

  const loadPlans = async (hydrateActive = false) => {
    const requestId = ++loadPlansRequestIdRef.current;
    const requestContext = selectorAsyncContextRef.current ?? selectorAsyncContext;
    setIsLoading(true);
    setError(null);
    try {
      const result = await loadMacroProjectMetadataForSelection({
        hydrateActivePlan: hydrateActive,
        refreshTasks: false,
        includeArchivedInVisible: showArchived,
        reason: 'selector',
      });
      if (!isCurrentLoadRequest(requestId, requestContext)) {
        return;
      }
      if (!result) {
        const catalogState = useAppStore.getState();
        const disposition = getPlanSelectorNullLoadDisposition({
          catalogStatus: catalogState.architectPlanCatalogStatus,
          isCatalogForCurrentScope:
            catalogState.architectPlanCatalogScopeKey === currentCatalogScopeKey,
        });
        if (catalogState.architectPlanCatalogStatus === 'error') {
          setError(
            catalogState.architectPlanCatalogError ??
              t('architect.planSelector.errorLoadPlans', 'Failed to load plans.'),
          );
        }
        if (disposition === 'preserve') return;
      }
      const visiblePlans = result?.snapshot.visiblePlans ?? [];
      const nextActivePlanId = result?.selectedPlan?.id ?? null;
      setPlans(visiblePlans);
      setActivePlanId(nextActivePlanId);

      if (hydrateActive && !nextActivePlanId) {
        clearActivePlanSelection();
      }
    } catch (loadError) {
      if (!isCurrentLoadRequest(requestId, requestContext)) {
        return;
      }
      if (openReplicaRepair(loadError, () => loadPlans(hydrateActive), { toastOnError: false })) {
        setPlans([]);
        setActivePlanId(null);
        return;
      }
      const message = resolveOperationMessage(
        loadError,
        t('architect.planSelector.errorLoadPlans', 'Failed to load plans.')
      );
      setError(message);
      setPlans([]);
      setActivePlanId(null);
    } finally {
      if (loadPlansRequestIdRef.current === requestId) {
        setHasLoadedPlans(true);
        setIsLoading(false);
      }
    }
  };

  const activatePlan = async (
    planId: string,
    planSummaryHint?: ArchitectPlanSummary | null
  ) => {
    const planBranch = planSummaryHint?.targetBranch || targetBranch;
    const locatorKey = toPlanLocatorKey({ branchName: planBranch, planId });
    const requestId = ++activationRequestIdRef.current;
    const requestContext = selectorAsyncContextRef.current ?? selectorAsyncContext;
    setIsActivating(locatorKey);
    setError(null);
    setActivePlanId(planId);
    try {
      const catalogBranches = Object.values(
        useAppStore.getState().architectPlanCatalogByBranch,
      );
      const exactCatalogBranch = (
        catalogBranches.find((branch) =>
          branch.plans.some((plan) => plan === planSummaryHint),
        ) ??
        catalogBranches.find((branch) =>
          branch.plans.some((plan) =>
            plan.id === planId &&
            plan.targetBranch === planSummaryHint?.targetBranch,
          ),
        )
      )?.branchName;
      const idOnlyBranches = catalogBranches.filter((branch) =>
        branch.plans.some((plan) => plan.id === planId),
      );
      const unambiguousLegacyBranch = idOnlyBranches.length === 1
        ? idOnlyBranches[0]?.branchName
        : null;
      const activated = await activateArchitectPlan(planId, {
        targetBranch: exactCatalogBranch ?? unambiguousLegacyBranch ?? planBranch,
        planSummaryHint: planSummaryHint ?? null,
      });
      if (!isCurrentActivationRequest(requestId, requestContext)) {
        return;
      }
      if (!activated) {
        throw new Error(t('architect.planSelector.errorSelectedPlanUnavailable', 'The selected plan is unavailable.'));
      }

      setActivePlanId(planId);
      setIsOpen(false);
      setShowCreateKinds(false);
    } catch (activationError) {
      if (!isCurrentActivationRequest(requestId, requestContext)) {
        return;
      }
      if (openReplicaRepair(activationError, () => activatePlan(planId, planSummaryHint ?? null))) {
        return;
      }
      const message = resolveOperationMessage(
        activationError,
        t('architect.planSelector.errorActivatePlan', 'Failed to activate plan.')
      );
      setError(message);
    } finally {
      if (activationRequestIdRef.current === requestId) {
        setIsActivating(null);
      }
    }
  };

  const buildTypedPlanGitFlowMetadata = useCallback(async (
    planKind: Exclude<ArchitectPlanKind, 'feature'>,
    projectIds: string[],
    fallbackBranchSlug: string,
  ): Promise<{
    targetBranchesByProjectId: Record<string, string>;
    gitFlowPlan: ArchitectPlanGitFlowMetadata;
  }> => {
    const projects = projectIds
      .map((projectId) => getProjectById(projectId))
      .filter((project): project is NonNullable<ReturnType<typeof getProjectById>> => Boolean(project));
    const detectedVersions = new Map(
      (await detectProjectVersions(projects)).map((result) => [result.projectId, result.version])
    );
    const targetBranchesByProjectId: Record<string, string> = {};
    const gitFlowProjects: ArchitectPlanGitFlowMetadata['projects'] = {};

    for (const projectId of projectIds) {
      const project = getProjectById(projectId);
      const baseBranch = project?.gitFlowSettings?.baseBranch || getGitFlowBaseBranch();
      const mainBranch = project?.gitFlowSettings?.mainBranch || getGitFlowMainBranch();
      const detectedVersion = detectedVersions.get(projectId) || null;
      const proposedVersion =
        planKind === 'hotfix'
          ? bumpPatchVersion(detectedVersion)
          : planKind === 'release'
            ? detectedVersion
            : null;
      const sourceBranch = getPlanKindSourceBranch({ planKind, baseBranch, mainBranch });
      const targetBranchName = getPlanKindTargetBranch({ planKind, baseBranch, mainBranch });
      const backmergeBranch = getPlanKindBackmergeBranch({ planKind, baseBranch, mainBranch });
      targetBranchesByProjectId[projectId] = targetBranchName;
      gitFlowProjects[projectId] = {
        projectId,
        sourceBranch,
        integrationBranch: '',
        targetBranch: targetBranchName,
        backmergeBranch,
        proposedVersion,
        confirmedVersion: null,
        proposedSlug: proposedVersion || fallbackBranchSlug,
        confirmedSlug: null,
      };
    }

    return {
      targetBranchesByProjectId,
      gitFlowPlan: {
        version: 1,
        planKind,
        slug: fallbackBranchSlug,
        projects: gitFlowProjects,
      },
    };
  }, [getProjectById]);

  const handleCreatePlan = async (planKind: ArchitectPlanKind = 'feature') => {
    if (creatingPlanKind) {
      return;
    }
    setFormError(null);
    setError(null);
    setCreatingPlanKind(planKind);
    setIsLoading(true);
    try {
      if (isWorkspaceMissing) {
        const message = workspaceState.kind === 'noProjectAvailable'
          ? t('project.emptyWorkspaceTitle', 'Ajoutez un projet pour commencer avec Macro.')
          : t('project.noProjectSelectedTitle', 'Sélectionnez un projet pour continuer.');
        setError(message);
        notify.error(message);
        return;
      }

      if (scopedActionableProjectIds.length === 0) {
        const message = t(
          'implement.manualFeatureMissingProjects',
          'No editable project is available for this group.'
        );
        setError(message);
        notify.error(message);
        return;
      }

      const labelByKind: Record<Exclude<ArchitectPlanKind, 'feature'>, string> = {
        release: t('architect.planSelector.releasePlanLabel', 'New Release Plan'),
        hotfix: t('architect.planSelector.hotfixPlanLabel', 'New Hotfix Plan'),
        bugfix: t('architect.planSelector.bugfixPlanLabel', 'New Bugfix Plan'),
      };
      const typedPlanInput =
        planKind === 'feature'
          ? undefined
          : await (async () => {
              const dateSlug = new Date().toISOString().slice(0, 10);
              const typedMetadata = await buildTypedPlanGitFlowMetadata(
                planKind,
                scopedActionableProjectIds,
                dateSlug,
              );
              return {
                label: labelByKind[planKind],
                slug: `${planKind}-${dateSlug}`,
                description:
                  planKind === 'release'
                    ? t(
                        'architect.planSelector.releasePlanDescription',
                        'Release workflow draft. Confirm versions and repositories in chat, then generate the stabilization checklist.'
                      )
                    : t(
                        'architect.planSelector.bugPlanDescription',
                        'Bug workflow draft. Describe the bug(s) in chat so Macro can infer the affected repositories.'
                      ),
                planKind,
                gitFlowPlan: typedMetadata.gitFlowPlan,
                targetBranchesByProjectId: typedMetadata.targetBranchesByProjectId,
              };
            })();

      const ensuredBlankPlan = await ensureScopedBlankPlan({
        branchName: targetBranch,
        scopedProjectIds: scopedActionableProjectIds,
        contextProjectIds,
        planKind,
        createPlanInput: typedPlanInput,
        trigger: 'explicit_create',
      });
      if (ensuredBlankPlan) {
        await activatePlan(
          ensuredBlankPlan.plan.id,
          summarizeArchitectPlanRecord(ensuredBlankPlan.plan)
        );
        await loadPlans(false);
        if (ensuredBlankPlan.action === 'reused_blank') {
          notify.info(
            t(
              'architect.planSelector.toastBlankPlanReady',
              'A blank new plan is already ready. Send the first message to name it.'
            )
          );
        } else if (ensuredBlankPlan.action === 'expanded_blank') {
          notify.info(
            t(
              'architect.planSelector.toastBlankPlanExpanded',
              'Reused the existing blank new plan and updated its scope. Send the first message to name it.'
            )
          );
        } else {
          notify.success(
            planKind === 'feature'
              ? t('architect.planSelector.toastBlankPlanCreated', 'New plan ready. Send the first message to name it.')
              : planKind === 'release'
                ? t('architect.planSelector.releasePlanReady', 'Release plan ready. Macro will ask for versions and repositories in chat.')
                : t('architect.planSelector.bugPlanReady', 'Plan ready. Describe the bug in chat so Macro can map the affected repositories.')
          );
        }
        return;
      }
    } catch (err) {
      if (openReplicaRepair(err, async () => {
        await handleCreatePlanRef.current?.(planKind);
      })) {
        return;
      }
      const message = resolveOperationMessage(
        err,
        t('architect.planSelector.errorOperationFailed', 'Operation failed.')
      );
      setError(message);
      notify.error(message);
    } finally {
      setIsLoading(false);
      setCreatingPlanKind(null);
    }
  };

  const handleCreatePlanRef = useRef(handleCreatePlan);
  useLayoutEffect(() => {
    handleCreatePlanRef.current = handleCreatePlan;
  });

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const detail: ArchitectPlanSelectorStateDetail = {
      status: !hasLoadedPlans || isLoading ? 'loading' : error ? 'error' : 'ready',
      planCount: plans.length,
      canCreate: canCreatePlanForScope,
      canSelect: plans.length > 0,
    };
    window.dispatchEvent(
      new CustomEvent<ArchitectPlanSelectorStateDetail>(
        ARCHITECT_PLAN_SELECTOR_STATE_EVENT,
        { detail },
      ),
    );
  }, [
    canCreatePlanForScope,
    error,
    hasLoadedPlans,
    isLoading,
    plans.length,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<ArchitectPlanSelectorRequestDetail>).detail;
      if (detail?.action !== 'primary') {
        return;
      }
      if (!hasLoadedPlans || isLoading) {
        setIsOpen(true);
        setShowCreateKinds(false);
        return;
      }
      if (plans.length === 0 && canCreatePlanForScope && !creatingPlanKind) {
        void handleCreatePlanRef.current?.('feature');
        return;
      }
      setIsOpen(true);
      setShowCreateKinds(false);
    };
    window.addEventListener(ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT, handleRequest);
    return () => {
      window.removeEventListener(ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT, handleRequest);
    };
  }, [
    canCreatePlanForScope,
    creatingPlanKind,
    hasLoadedPlans,
    isLoading,
    plans.length,
  ]);

  const handleRenamePlan = (plan: ArchitectPlanSummary) => {
    if (!getArchitectPlanCrudCapabilities(plan).canEditDetails) {
      return;
    }
    setFormError(null);
    setPlanFormModal(plan);
  };

  const handleFormConfirm = async (value: string) => {
    if (!planFormModal) return;
    setFormLoading(true);
    setFormError(null);
    try {
      const latestPlan = await getArchitectPlan(targetBranch, planFormModal.id);
      if (!latestPlan || !getArchitectPlanCrudCapabilities(latestPlan).canEditDetails) {
        throw new Error(
          t(
            'architect.planSelector.errorSelectedPlanUnavailable',
            'The selected plan is unavailable or immutable.'
          )
        );
      }
      const existingValue = getArchitectPlanEditableName(latestPlan);
      if (value === existingValue) {
        setPlanFormModal(null);
        return;
      }
      const updatedPlan = await updateArchitectPlan({
        branchName: targetBranch,
        planId: planFormModal.id,
        ...(isCanonicalArchitectPlan(planFormModal) ? { label: value } : { title: value }),
      });
      if (updatedPlan.conversationId) {
        await useChatStore
          .getState()
          .syncArchitectPlanConversationMetadata(updatedPlan.conversationId, updatedPlan);
      }
      const namingRecovery = useChatStore.getState().architectPlanNamingRecovery;
      if (namingRecovery?.planId === planFormModal.id) {
        useChatStore.getState().dismissArchitectPlanNamingRecovery();
      }
      setPlanFormModal(null);
      await loadPlans(false);
    } catch (err) {
      if (openReplicaRepair(err, () => handleFormConfirm(value))) {
        return;
      }
      setFormError(
        resolveOperationMessage(
          err,
          t('architect.planSelector.errorOperationFailed', 'Operation failed.')
        )
      );
    } finally {
      setFormLoading(false);
    }
  };

  const handleArchivePlan = async (plan: ArchitectPlanSummary) => {
    setError(null);
    setIsLoading(true);
    let releasePlanMutation: (() => void) | null = null;
    let archivedPlan: ArchitectPlanRecord | null = null;
    try {
      const taskStore = useTaskStore.getState();
      if (!taskStore.reservePlanWorktreeMutation(plan.id)) {
        throw new Error(
          t(
            'implement.taskCommandsPlanMutationActive',
            'Stop active task commands before archiving or deleting this plan.'
          )
        );
      }
      releasePlanMutation = () => taskStore.releasePlanWorktreeMutation(plan.id);

      const latestPlan = await getArchitectPlan(targetBranch, plan.id);
      if (!latestPlan || !getArchitectPlanCrudCapabilities(latestPlan).canArchive) {
        throw new Error(
          t('architect.planSelector.errorSelectedPlanUnavailable', 'The selected plan is unavailable.')
        );
      }
      const archiveSagaNow = new Date().toISOString();
      await upsertPlanLifecycleSaga({
        planId: plan.id,
        branchName: targetBranch,
        operation: 'archive',
        phase: 'prepared',
        conversationId: latestPlan.conversationId ?? null,
        createdAt: archiveSagaNow,
        updatedAt: archiveSagaNow,
      });
      archivedPlan = await archiveArchitectPlan(targetBranch, plan.id);
      await upsertPlanLifecycleSaga({
        planId: plan.id,
        branchName: targetBranch,
        operation: 'archive',
        phase: 'metadata_written',
        conversationId: archivedPlan.conversationId ?? null,
        createdAt: archiveSagaNow,
        updatedAt: new Date().toISOString(),
      });
      const cleanup = await cleanupPlanBranches(archivedPlan);
      await removePlanLifecycleSaga(plan.id, 'archive', targetBranch);
      taskStore.clearPlanRuntimeState({
        planId: plan.id,
        deletedWorktreeKeys: cleanup.flatMap((repository) =>
          repository.deletedWorktrees.map((worktree) => worktree.worktreeKey)
        ),
      });
      const planDisplayName = getArchitectPlanDisplayName(plan);
      notify.success(
        t('architect.planSelector.toastPlanArchived', {
          title: planDisplayName,
          defaultValue: `Plan "${planDisplayName}" archived`,
        })
      );
      await refreshPlanSelectorAfterMutation({
        mutation: {
          type: 'archive',
          planId: plan.id,
        },
      });
    } catch (archiveError) {
      if (archivedPlan) {
        const message = t(
          'architect.planSelector.errorArchivePlanCleanup',
          'Plan archived, but Git cleanup failed. Delete the archived plan to retry cleanup.'
        );
        setError(`${message} ${resolveOperationMessage(archiveError, '')}`.trim());
        notify.warning(message);
        await refreshPlanSelectorAfterMutation({
          mutation: {
            type: 'archive',
            planId: plan.id,
          },
        });
        return;
      }
      if (openReplicaRepair(archiveError, () => handleArchivePlan(plan))) {
        return;
      }
      try {
        const verification = await refreshPlanSelectorAfterMutation({
          mutation: {
            type: 'archive',
            planId: plan.id,
          },
        });
        if (verification.mutationApplied) {
          return;
        }
      } catch {
        // Fall through to surface the original archive error.
      }
      const message = resolveOperationMessage(
        archiveError,
        t('architect.planSelector.errorArchivePlan', 'Failed to archive plan.')
      );
      setError(message);
      notify.error(message);
    } finally {
      releasePlanMutation?.();
      setIsLoading(false);
    }
  };

  const handleConfirmDeletePlan = async () => {
    if (!planToDelete) return;

    setError(null);
    setIsDeleting(true);
    let keepDeleteDialogOpen = false;
    let releasePlanMutation: (() => void) | null = null;
    let linkedConversationCleanupPending = false;
    try {
      const deletedPlanId = planToDelete.id;
      const taskStore = useTaskStore.getState();
      if (!taskStore.reservePlanWorktreeMutation(deletedPlanId)) {
        throw new Error(
          t(
            'implement.taskCommandsPlanMutationActive',
            'Stop active task commands before archiving or deleting this plan.'
          )
        );
      }
      releasePlanMutation = () => taskStore.releasePlanWorktreeMutation(deletedPlanId);
      const currentPlan = await getArchitectPlan(targetBranch, deletedPlanId);
      if (!currentPlan) {
        throw new Error(
          t('architect.planSelector.errorSelectedPlanUnavailable', 'The selected plan is unavailable.')
        );
      }
      if (currentPlan.conversationId) {
        const now = new Date().toISOString();
        await upsertLinkedConversationDeletionSaga({
          ownerType: 'plan',
          ownerId: deletedPlanId,
          conversationId: currentPlan.conversationId,
          phase: 'plan_deleting',
          targetBranch,
          createdAt: now,
          updatedAt: now,
        });
      }
      const cleanup = await deletePlanAndCleanupBranches({
        branchName: targetBranch,
        planId: deletedPlanId,
      });
      useTaskStore.getState().clearPlanRuntimeState({
        planId: deletedPlanId,
        deletedWorktreeKeys: cleanup.deletedWorktreeKeys,
      });
      if (currentPlan.conversationId) {
        let deletedConversation = false;
        try {
          deletedConversation = await useChatStore
            .getState()
            .completeLinkedTaskConversationDeletion(currentPlan.conversationId);
        } catch (error) {
          linkedConversationCleanupPending = true;
          throw error;
        }
        if (!deletedConversation) {
          linkedConversationCleanupPending = true;
          throw new Error(
            t(
              'architect.planSelector.errorDeletePlanConversation',
              'Plan deleted, but its conversation cleanup remains pending.'
            )
          );
        }
        await removeLinkedConversationDeletionSaga('plan', deletedPlanId);
      }
      notify.success(t('architect.planSelector.toastPlanDeleted', 'Plan deleted'));
      await refreshPlanSelectorAfterMutation({
        mutation: {
          type: 'delete',
          planId: deletedPlanId,
        },
        refreshTasks: true,
      });
    } catch (deleteError) {
      if (openReplicaRepair(deleteError, () => handleConfirmDeletePlan())) {
        keepDeleteDialogOpen = true;
        return;
      }
      try {
        const verification = await refreshPlanSelectorAfterMutation({
          mutation: {
            type: 'delete',
            planId: planToDelete.id,
          },
        });
        if (verification.mutationApplied) {
          useTaskStore.getState().clearPlanRuntimeState({
            planId: planToDelete.id,
            deletedWorktreeKeys: [],
          });
          if (resolveVerifiedPlanDeletionRecovery({
            mutationApplied: verification.mutationApplied,
            linkedConversationCleanupPending,
          }) === 'conversation_cleanup_pending') {
            const pendingCleanupMessage = t(
              'architect.planSelector.warningDeletePlanConversationPending',
              'Plan deleted, but linked conversation cleanup remains pending and will be retried automatically.'
            );
            setError(pendingCleanupMessage);
            notify.warning(pendingCleanupMessage);
          }
          void useTaskStore.getState().refreshFromPlan().catch(() => undefined);
          return;
        }
      } catch {
        // Fall through to surface the original delete error.
      }
      const message = resolveOperationMessage(
        deleteError,
        t('architect.planSelector.errorDeletePlan', 'Failed to delete plan.')
      );
      setError(message);
      notify.error(message);
    } finally {
      releasePlanMutation?.();
      setIsDeleting(false);
      if (!keepDeleteDialogOpen) {
        setPlanToDelete(null);
      }
    }
  };

  const handleRestorePlan = async (plan: ArchitectPlanSummary) => {
    setError(null);
    setIsLoading(true);
    try {
      await restoreArchitectPlan(targetBranch, plan.id);
      const planDisplayName = getArchitectPlanDisplayName(plan);
      notify.success(
        t('architect.planSelector.toastPlanRestored', {
          title: planDisplayName,
          defaultValue: `Plan "${planDisplayName}" restored`,
        })
      );
      await loadPlans(false);
    } catch (restoreError) {
      if (openReplicaRepair(restoreError, () => handleRestorePlan(plan))) {
        return;
      }
      const message = resolveOperationMessage(
        restoreError,
        t('architect.planSelector.errorRestorePlan', 'Failed to restore plan.')
      );
      setError(message);
      notify.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const effectKey = `${selectedGroupId || 'none'}::${selectedProjectId || 'none'}::${showArchived ? '1' : '0'}`;
    if (lastEffectIdRef.current === effectKey) return;
    lastEffectIdRef.current = effectKey;
    void loadPlans(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId, selectedProjectId, showArchived]);

  useEffect(() => {
    if (architectPlanCatalogStatus !== 'ready' || !isPlanCatalogForCurrentScope) {
      return;
    }

    setPlans((current) => {
      const currentKey = current.map((plan) => `${plan.id}:${plan.status}:${plan.updatedAt}`).join('|');
      const nextKey = visibleArchitectPlans.map((plan) => `${plan.id}:${plan.status}:${plan.updatedAt}`).join('|');
      return currentKey === nextKey ? current : visibleArchitectPlans;
    });
  }, [
    architectPlanCatalogStatus,
    isPlanCatalogForCurrentScope,
    visibleArchitectPlans,
  ]);

  useEffect(() => {
    const nextActivePlanId = activePlanContext?.id ?? activeArchitectPlanId;
    setActivePlanId((current) => (current === nextActivePlanId ? current : nextActivePlanId));
  }, [activeArchitectPlanId, activePlanContext]);

  useEffect(() => {
    if (!activePlanContext) return;

    setPlans((current) => {
      let changed = false;
      const next = current.map((plan) => {
        if (plan.id !== activePlanContext.id) return plan;
        const nextStatus = activePlanContext.status as ArchitectPlanSummary['status'];
        if (
          plan.slug === activePlanContext.slug &&
          plan.title === activePlanContext.title &&
          plan.label === activePlanContext.label &&
          plan.description === activePlanContext.description &&
          plan.planKind === activePlanContext.planKind &&
          plan.gitFlowPlan === activePlanContext.gitFlowPlan &&
          plan.status === nextStatus
        ) {
          return plan;
        }
        changed = true;
        return {
          ...plan,
          slug: activePlanContext.slug || plan.slug,
          title: activePlanContext.title,
          label: activePlanContext.label,
          description: activePlanContext.description,
          planKind: activePlanContext.planKind,
          gitFlowPlan: activePlanContext.gitFlowPlan,
          status: nextStatus,
          updatedAt: new Date().toISOString(),
        };
      });
      return changed ? next : current;
    });

    if (activePlanId !== activePlanContext.id) {
      setActivePlanId(activePlanContext.id);
    }
  }, [activePlanContext, activePlanId]);

  useEffect(() => {
    if (!isOpen) return;
    const onDocumentMouseDown = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (creatingPlanKind) return;
      if (event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setIsOpen(false);
        setShowCreateKinds(false);
      }
    };
    document.addEventListener('mousedown', onDocumentMouseDown);
    return () => document.removeEventListener('mousedown', onDocumentMouseDown);
  }, [creatingPlanKind, isOpen]);

  const planToDeleteCrudCapabilities = planToDelete
    ? getArchitectPlanCrudCapabilities(planToDelete)
    : null;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        onClick={() => {
          const nextIsOpen = !isOpen;
          setIsOpen(nextIsOpen);
          if (!nextIsOpen) setShowCreateKinds(false);
        }}
        className="h-8 px-2.5 rounded-md border border-border bg-background/60 hover:bg-accent text-xs flex items-center gap-2"
      >
        {displayedActivePlanKind ? (
          <span
            className="shrink-0 inline-flex items-center justify-center"
            title={displayedActivePlanKindLabel ?? undefined}
          >
            <Icon
              name={planKindIconName[displayedActivePlanKind]}
              size={13}
              className={planKindIconClassName[displayedActivePlanKind]}
            />
          </span>
        ) : (
          <Icon name="list" size={13} className="text-primary" />
        )}
        <span className="max-w-[140px] truncate text-foreground">
          {displayedActivePlanTitle}
        </span>
        <Icon name="chevron-down" size={13} className="text-muted-foreground" />
      </button>

      {isOpen && (
        <div className="absolute right-0 z-[80] mt-2 w-[440px] rounded-xl border border-border bg-popover shadow-2xl overflow-visible">
          <div className="px-3 py-2 border-b border-border bg-card/60">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-foreground shrink-0">
                {t('architect.planSelector.title', 'Architect plans')}
              </div>
              <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
                <button
                  onClick={() => setShowArchived((current) => !current)}
                  title={showArchived
                    ? t('architect.planSelector.hideArchived', 'Hide archived')
                    : t('architect.planSelector.showArchived', 'Show archived')}
                  className={cn(
                    'h-7 min-w-0 max-w-full shrink px-2 rounded-md text-xs border inline-flex items-center gap-1.5 whitespace-nowrap',
                    showArchived
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border hover:bg-accent text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Icon name="archive" size={12} />
                  <span className="truncate">
                    {showArchived
                      ? t('architect.planSelector.hideArchived', 'Hide archived')
                      : t('architect.planSelector.showArchived', 'Show archived')}
                  </span>
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowCreateKinds((current) => !current)}
                    disabled={isReadOnlyOnlyScope || isWorkspaceMissing || Boolean(creatingPlanKind)}
                    title={
                      isWorkspaceMissing
                        ? workspaceState.kind === 'noProjectAvailable'
                          ? t('project.emptyWorkspaceTitle', 'Ajoutez un projet pour commencer avec Macro.')
                          : t('project.noProjectSelectedTitle', 'Sélectionnez un projet pour continuer.')
                        : isReadOnlyOnlyScope
                        ? t(
                            'architect.planSelector.readOnlyOnlyAction',
                            'At least one editable repository is required to create a plan.'
                          )
                        : undefined
                    }
                    className={cn(
                      'h-7 shrink-0 px-2 rounded-md text-xs border flex items-center gap-1.5',
                      isReadOnlyOnlyScope || isWorkspaceMissing || creatingPlanKind
                        ? 'border-border bg-muted text-muted-foreground cursor-not-allowed'
                        : 'border-border hover:bg-accent'
                    )}
                  >
                    <Icon
                      name={creatingPlanKind ? 'loader' : 'plus'}
                      size={12}
                      className={cn(creatingPlanKind && 'animate-spin')}
                    />
                    {creatingPlanKind
                      ? t('architect.planSelector.creating', 'Creating')
                      : t('architect.planSelector.create', 'Create')}
                  </button>
                  {showCreateKinds && !isReadOnlyOnlyScope && !isWorkspaceMissing && (
                    <div className="absolute right-0 top-8 z-[90] w-56 rounded-lg border border-border bg-popover shadow-xl p-1">
                      {([
                        ['feature', 'sparkles', t('architect.planSelector.newFeaturePlan', 'New Feature Plan'), t('architect.planSelector.kindFeatureHelp', 'Build something new.')] as const,
                        ['release', 'flag', t('architect.planSelector.releasePlanLabel', 'New Release Plan'), t('architect.planSelector.kindReleaseHelp', 'Stabilize and ship.')] as const,
                        ['hotfix', 'zap', t('architect.planSelector.hotfixPlanLabel', 'New Hotfix Plan'), t('architect.planSelector.kindHotfixHelp', 'Patch production quickly.')] as const,
                        ['bugfix', 'tool', t('architect.planSelector.bugfixPlanLabel', 'New Bugfix Plan'), t('architect.planSelector.kindBugfixHelp', 'Fix a normal bug.')] as const,
                      ] satisfies Array<readonly [ArchitectPlanKind, React.ComponentProps<typeof Icon>['name'], string, string]>)
                        .filter(([kind]) => creatablePlanKinds.includes(kind))
                        .map(([kind, icon, label, help]) => {
                          const isCreatingKind = creatingPlanKind === kind;
                          const isCreateDisabled = Boolean(creatingPlanKind);
                          return (
                            <button
                              key={kind}
                              type="button"
                              onClick={() => void handleCreatePlan(kind)}
                              disabled={isCreateDisabled}
                              aria-busy={isCreatingKind}
                              className={cn(
                                'w-full rounded-md px-2 py-1.5 text-left transition-colors flex items-stretch gap-3',
                                isCreatingKind
                                  ? 'bg-primary/10'
                                  : isCreateDisabled
                                    ? 'opacity-45 cursor-not-allowed'
                                    : 'hover:bg-accent'
                              )}
                            >
                              <span className="w-4 shrink-0 self-stretch inline-flex items-center justify-center">
                                <Icon name={icon} size={16} className={planKindIconClassName[kind]} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex min-w-0 items-center justify-between gap-2">
                                  <span className="truncate text-xs font-medium text-foreground">{label}</span>
                                  {isCreatingKind && (
                                    <Icon name="loader" size={11} className="shrink-0 animate-spin text-primary" />
                                  )}
                                </span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {isCreatingKind
                                    ? t('architect.planSelector.creatingKind', 'Creating this plan...')
                                    : help}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => void loadPlans(false)}
                  className="h-7 shrink-0 px-2 rounded-md text-xs border border-border hover:bg-accent flex items-center gap-1.5"
                >
                  <Icon name="rotate-ccw" size={12} className={cn(isLoading && 'animate-spin')} />
                  {t('architect.planSelector.refresh', 'Refresh')}
                </button>
              </div>
            </div>
          </div>

          <div className="max-h-[360px] overflow-y-auto p-2 space-y-1">
            {error && (
              <div className="px-2 py-2 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-md">
                {error}
              </div>
            )}

            {!error && isLoading && plans.length === 0 && (
              <div className="px-2 py-6 text-xs text-muted-foreground text-center">
                {t('architect.planSelector.loading', 'Loading plans...')}
              </div>
            )}

            {!error && !isLoading && isWorkspaceMissing && (
              <ProjectWorkspaceEmptyState
                stateKind={workspaceState.kind}
                compact
                variant="secondary"
              />
            )}

            {!error && !isLoading && !isWorkspaceMissing && isReadOnlyOnlyScope && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-4">
                <div className="text-sm font-medium text-amber-100">
                  {t(
                    'projects.readOnlyWorkspaceTitle',
                    'This scope is currently read-only.'
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-amber-50/80">
                  {t(
                    'projects.readOnlyWorkspaceArchitectBody',
                    'Plans need at least one editable project. Read-only projects still stay available for context and code reading.'
                  )}
                </p>
                {firstReadOnlyProject && (
                  <button
                    type="button"
                    onClick={openReadOnlyProjectSettings}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-100/10 px-2.5 py-1.5 text-xs font-medium text-amber-50 transition-colors hover:bg-amber-100/15"
                  >
                    <Icon name="settings" size={12} />
                    {readOnlyCtaLabel}
                  </button>
                )}
              </div>
            )}

            {planSelectorEmptyState !== 'hidden' && (
              <div className="px-2 py-6 text-xs text-muted-foreground text-center">
                {planSelectorEmptyState === 'outside-scope'
                  ? t(
                      'architect.planSelector.emptyOutsideScope',
                      'Plans exist in @macro but do not match the selected project.'
                    )
                  : t('architect.planSelector.empty', 'No plans yet.')}
              </div>
            )}

            {plans.map((plan) => {
              const locatorKey = toPlanLocatorKey({ branchName: plan.targetBranch, planId: plan.id });
              const isActive = plan.id === activePlanId &&
                (!activePlanContext?.targetBranch || plan.targetBranch === activePlanContext.targetBranch);
              const planPhase = getArchitectPlanLifecyclePhase(plan);
              const statusClass = statusClassName[planPhase] || statusClassName.draft;
              const isBusy = isActivating === locatorKey;
              const isUnavailable = plan.status === 'deleted';
              const isMissingProjects = plan.replicationState === 'missing_projects';
              const missingCount = plan.missingProjectIds?.length ?? 0;
              const expectedCount = plan.expectedProjectIds?.length ?? getArchitectPlanVisibleProjectIds(plan).length;
              const availableCount = expectedCount - missingCount;
              const isCanonicalPlan = isCanonicalArchitectPlan(plan);
              const primaryName = getArchitectPlanPrimaryName(plan);
              const secondaryLabel = getArchitectPlanSecondaryLabel(plan);
              const secondaryText = secondaryLabel || (!isCanonicalPlan ? plan.id : null);
              const planKind = getArchitectPlanKind(plan);
              const crudCapabilities = getArchitectPlanCrudCapabilities(plan);
              const planKindLabel =
                planKind === 'feature'
                  ? t('architect.planSelector.kindFeature', 'Feature')
                  : planKind === 'release'
                    ? t('architect.planSelector.kindRelease', 'Release')
                    : planKind === 'hotfix'
                      ? t('architect.planSelector.kindHotfix', 'Hotfix')
                      : t('architect.planSelector.kindBugfix', 'Bugfix');
              const canDeletePlan = crudCapabilities.canDelete;
              const canRenamePlan = crudCapabilities.canEditDetails;
              const canArchivePlan = crudCapabilities.canArchive || crudCapabilities.canRestore;
              const {
                targetBranch: effectiveTargetBranch,
                targetBranchesByProjectId: effectiveTargetBranchesByProjectId,
                hasMixedTargetBranches,
              } = getArchitectPlanTargetDisplay(plan, selectedProjectId, {
                getProjectGitFlowSettings: (projectId) =>
                  getProjectById(projectId)?.gitFlowSettings ?? null,
              });
              const targetSummary = hasMixedTargetBranches
                ? selectedProjectId && effectiveTargetBranchesByProjectId[selectedProjectId]
                  ? t('architect.planSelector.mixedTargetsForProject', 'Mixed targets · this repo: {{branchName}}', {
                    branchName: effectiveTargetBranch,
                  })
                  : t('architect.planSelector.mixedTargets', 'Mixed targets')
                : t('architect.planSelector.targetBranch', 'Target: {{branchName}}', {
                  branchName: effectiveTargetBranch,
                });
              const renameLabel = isCanonicalPlan
                ? t('architect.planSelector.editPlanLabel', 'Edit plan label')
                : t('architect.planSelector.renamePlan', 'Rename plan');
              const canActivatePlan = !isUnavailable && plan.status !== 'archived' && !isBusy;

              return (
                <div
                  key={locatorKey}
                  role="button"
                  tabIndex={canActivatePlan ? 0 : -1}
                  aria-disabled={!canActivatePlan}
                  onClick={() => {
                    if (canActivatePlan) {
                      void activatePlan(plan.id, plan);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!canActivatePlan) {
                      return;
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      void activatePlan(plan.id, plan);
                    }
                  }}
                  className={cn(
                    'w-full text-left p-2.5 rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    isActive
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border hover:bg-accent',
                    canActivatePlan ? 'cursor-pointer' : 'cursor-default opacity-80'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex items-stretch gap-2">
                      <span
                        className={cn(
                          'self-stretch min-h-8 aspect-square shrink-0 rounded-full border inline-flex items-center justify-center',
                          planKindClassName[planKind]
                        )}
                        title={planKindLabel}
                      >
                        <Icon name={planKindIconName[planKind]} size={14} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-foreground truncate">{primaryName}</div>
                        {secondaryText && (
                          <div className="text-[11px] text-muted-foreground truncate">{secondaryText}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded border uppercase', statusClass)}>
                        {t(`architect.status.${planPhase}`, planPhase)}
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRenamePlan(plan);
                        }}
                        disabled={!canRenamePlan}
                        className="w-6 h-6 rounded border border-border hover:bg-accent flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                        title={!canRenamePlan
                          ? t(
                              'architect.planSelector.renameUnavailable',
                              'Plan details cannot be edited for this status.'
                            )
                          : renameLabel}
                      >
                        <Icon name="edit" size={11} className="text-muted-foreground" />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (plan.status === 'archived') {
                            void handleRestorePlan(plan);
                            return;
                          }
                          if (!canArchivePlan) {
                            return;
                          }
                          void handleArchivePlan(plan);
                        }}
                        disabled={!canArchivePlan}
                        className="w-6 h-6 rounded border border-border hover:bg-accent flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                        title={plan.status === 'archived'
                          ? t('architect.planSelector.unarchivePlan', 'Unarchive plan')
                          : !canArchivePlan
                            ? t(
                                'architect.planSelector.archiveUnavailable',
                                'Archive is unavailable for this status'
                              )
                            : t('architect.planSelector.archivePlan', 'Archive plan')}
                      >
                        <Icon
                          name={plan.status === 'archived' ? 'rotate-ccw' : 'archive'}
                          size={11}
                          className="text-muted-foreground"
                        />
                      </button>
                      {canDeletePlan && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPlanToDelete(plan);
                          }}
                          className="w-6 h-6 rounded border border-red-500/30 hover:bg-red-500/10 flex items-center justify-center"
                          title={t('architect.planSelector.deletePlan', 'Delete plan')}
                        >
                          <Icon name="trash" size={11} className="text-red-500" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-1.5 text-[11px] text-muted-foreground flex items-center gap-2">
                    <span>
                      {t('architect.planSelector.nodesCount', {
                        count: plan.nodeCount,
                        defaultValue: `${plan.nodeCount} nodes`,
                      })}
                    </span>
                    <span>&middot;</span>
                    <span>{formatRelativeDate(plan.updatedAt, t('architect.planSelector.unknownDate', 'Unknown date'))}</span>
                    {expectedCount > 0 && (
                      <>
                        <span>&middot;</span>
                        <span className={cn(isMissingProjects ? 'text-amber-500' : undefined)}>
                          {`${availableCount}/${expectedCount} repos`}
                        </span>
                      </>
                    )}
                    {isMissingProjects && (
                      <>
                        <span>&middot;</span>
                        <span className="text-amber-500 truncate">
                          {`Missing: ${(plan.missingProjectIds || []).join(', ')}`}
                        </span>
                      </>
                    )}
                    {isActive && (
                      <>
                        <span>&middot;</span>
                        <span className="text-primary inline-flex items-center gap-1">
                          <Icon name="check" size={11} />
                          {t('architect.planSelector.active', 'Active')}
                        </span>
                      </>
                    )}
                    {isBusy && (
                      <span className="text-primary inline-flex items-center gap-1 ml-auto">
                        <Icon name="loader" size={11} className="animate-spin" />
                        {t('architect.planSelector.loadingShort', 'Loading')}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground truncate">
                    {targetSummary}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ConfirmPromptModal
        isOpen={Boolean(planToDelete)}
        title={t('architect.planSelector.deleteDialogTitle', 'Delete Plan')}
        description={
          planToDelete
            ? t('architect.planSelector.deleteDialogDescription', {
              title: getArchitectPlanDisplayName(planToDelete),
              defaultValue:
                planToDeleteCrudCapabilities?.deleteRequiresCleanup
                  ? `This will permanently remove "${getArchitectPlanDisplayName(planToDelete)}" and clean local Macro worktrees and branches. Remote branches will not be deleted.`
                  : `This will permanently remove "${getArchitectPlanDisplayName(planToDelete)}" from plan storage.`,
            })
            : t('architect.planSelector.deleteDialogFallback', 'This action cannot be undone.')
        }
        confirmLabel={isDeleting
          ? t('architect.planSelector.deleting', 'Deleting...')
          : planToDeleteCrudCapabilities?.deleteRequiresCleanup
            ? t('architect.planSelector.deleteAndCleanup', 'Delete and clean up')
            : t('architect.planSelector.purgePlan', 'Delete permanently')}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant="error"
        onCancel={() => {
          if (!isDeleting) {
            setPlanToDelete(null);
          }
        }}
        onConfirm={() => {
          if (!isDeleting) {
            void handleConfirmDeletePlan();
          }
        }}
      />

      {planFormModal && (
        <PlanFormModal
          initialValue={getArchitectPlanEditableName(planFormModal)}
          isCanonicalPlan={isCanonicalArchitectPlan(planFormModal)}
          onConfirm={(value) => void handleFormConfirm(value)}
          onClose={() => {
            if (!formLoading) setPlanFormModal(null);
          }}
          isLoading={formLoading}
          error={formError}
        />
      )}

      {replicaRepair && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-background/80 p-4">
          <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
            <div className="shrink-0 px-5 py-4 border-b border-border">
              {replicaRepairPresentation && (
                <ActionableErrorCallout
                  presentation={replicaRepairPresentation}
                  compact
                />
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-2 text-xs text-muted-foreground">
              {replicaRepair.divergence.replicas.map((replica) => (
                <div key={replica.scopeKey} className="rounded-md border border-border px-3 py-2">
                  <div className="text-foreground">{replica.repoPath || replica.scopeKey}</div>
                  <div>
                    {replica.missing
                      ? t('architect.planSelector.replicaMissing', 'Missing replica')
                      : replica.updatedAt || t('architect.planSelector.unknownDate', 'Unknown date')}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
              <button
                type="button"
                disabled={isRepairingReplica}
                onClick={() => {
                  pendingReplicaRetryRef.current = null;
                  setReplicaRepair(null);
                }}
                className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                disabled={isRepairingReplica}
                onClick={() => void performReplicaRepair('oldest')}
                className="px-3 py-2 rounded-md border border-border hover:bg-accent text-sm"
              >
                {isRepairingReplica
                  ? t('architect.planSelector.repairing', 'Repairing...')
                  : t('architect.planSelector.keepOldestReplica', 'Keep oldest')}
              </button>
              <button
                type="button"
                disabled={isRepairingReplica}
                onClick={() => void performReplicaRepair('newest')}
                className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90"
              >
                {isRepairingReplica
                  ? t('architect.planSelector.repairing', 'Repairing...')
                  : t('architect.planSelector.keepNewestReplica', 'Keep newest')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PlanSelector;
