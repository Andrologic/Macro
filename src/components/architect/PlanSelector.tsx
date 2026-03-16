import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  archiveArchitectPlan,
  createArchitectPlan,
  getArchitectPlan,
  getArchitectPlanProjectIds,
  getArchitectPlanNeeds,
  getGitFlowBaseBranch,
  isArchitectPlanReplicaDivergenceError,
  listArchitectPlans,
  repairArchitectPlanReplicas,
  resolvePlanProjectContextId,
  restoreArchitectPlan,
  setActiveArchitectPlan,
  updateArchitectPlan,
  type ArchitectPlanReplicaDivergence,
  type ArchitectPlanSummary,
} from '../../services/architectPlanService';
import { deletePlanAndCleanupBranches } from '../../services/architectGitFlowService';
import { getScopedProjectIds } from '../../services/globalProjects';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useNeedsStore } from '../../stores/useNeedsStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toaster';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { PlanFormModal } from './PlanFormModal';
import { PlanReviewModal } from '../plan/PlanReviewModal';
import { cn } from '../../utils/cn';
import {
  getArchitectPlanConversationTitle,
  getArchitectPlanDisplayName,
  getArchitectPlanEditableName,
  getArchitectPlanPrimaryName,
  getArchitectPlanSecondaryLabel,
  isCanonicalArchitectPlan,
} from '../../services/architectPlanPresentation';
import { toServiceError } from '../../services/contracts/errors';

interface PlanSelectorProps {
  className?: string;
}

const statusClassName: Record<string, string> = {
  draft: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
  validated: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
  in_progress: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
  completed: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
  archived: 'text-muted-foreground bg-muted/50 border-border/70',
  deleted: 'text-red-500 bg-red-500/10 border-red-500/20',
};

const formatRelativeDate = (iso: string, unknownLabel: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return unknownLabel;
  return date.toLocaleDateString();
};

const isPlanVisibleForSelection = (
  plan: ArchitectPlanSummary,
  scopedProjectIds: string[]
): boolean => {
  if (scopedProjectIds.length === 0) return true;
  const scopedProjectIdSet = new Set(scopedProjectIds);
  const planProjectIds = getArchitectPlanProjectIds(plan);
  return planProjectIds.length === 0 || planProjectIds.some((projectId) => scopedProjectIdSet.has(projectId));
};

export const PlanSelector: React.FC<PlanSelectorProps> = ({ className }) => {
  const { t } = useTranslation();
  const {
    setPlanNodes,
    setPredictedBranches,
    setActiveArchitectPlanId,
    setActivePlanContext,
    activeArchitectPlanId,
    activePlanContext,
    projectGroups,
    selectedGroupId,
    selectedProjectId,
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
  const [planReviewTarget, setPlanReviewTarget] = useState<{ planId: string; branchName: string } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const conversationToastShownRef = useRef<Set<string>>(new Set());
  const autoCreatingRef = useRef(false);
  const lastEffectIdRef = useRef<string | null | undefined>(undefined);
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
    return plans.find((plan) => plan.id === activePlanId) || null;
  }, [plans, activePlanId]);
  const scopedProjectIds = useMemo(
    () => getScopedProjectIds(projectGroups, selectedGroupId, selectedProjectId),
    [projectGroups, selectedGroupId, selectedProjectId]
  );
  const readyPlanSummaries = useTaskStore((state) => state.planSummaries);

  const displayedActivePlanTitle = useMemo(() => {
    if (activePlanContext && activePlanContext.id === activePlanId) {
      return getArchitectPlanPrimaryName(activePlanContext);
    }
    return activePlan ? getArchitectPlanPrimaryName(activePlan) : t('architect.planSelector.selectPlan', 'Select plan');
  }, [activePlan, activePlanContext, activePlanId, t]);

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
      toast.error(error.message);
    }
    return true;
  };

  const resolveOperationMessage = (value: unknown, fallback: string): string =>
    (() => {
      const message = toServiceError(value).message.trim();
      return message && message !== 'Unknown error' ? message : fallback;
    })();

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
      toast.success(
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
      toast.error(message);
    } finally {
      setIsRepairingReplica(false);
    }
  };

  const loadPlans = async (hydrateActive = false) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listArchitectPlans(targetBranch, showArchived, showArchived);
      const fullResult = showArchived ? result : await listArchitectPlans(targetBranch, true, true);
      const scopedPlans = result.plans.filter((plan) =>
        isPlanVisibleForSelection(plan, scopedProjectIds)
      );
      const scopedFullPlans = fullResult.plans.filter((plan) =>
        isPlanVisibleForSelection(plan, scopedProjectIds)
      );

      // Auto-create a default plan when none exist
      if (scopedFullPlans.length === 0 && !autoCreatingRef.current) {
        autoCreatingRef.current = true;
        try {
          const created = await createArchitectPlan({
            branchName: targetBranch,
            projectId: scopedProjectIds[0] || undefined,
            projectIds: scopedProjectIds.length > 0 ? scopedProjectIds : undefined,
            status: 'draft',
            setActive: true,
          });
          await activatePlan(created.id);
          return;
        } finally {
          autoCreatingRef.current = false;
        }
      }

      setPlans(scopedPlans);
      const preferredActivePlanId = activeArchitectPlanId || result.activePlanId;
      const nextActivePlanId =
        preferredActivePlanId && scopedPlans.some((plan) => plan.id === preferredActivePlanId)
          ? preferredActivePlanId
          : scopedPlans[0]?.id ?? null;
      setActivePlanId(nextActivePlanId);
      setActiveArchitectPlanId(nextActivePlanId);

      if (hydrateActive && nextActivePlanId) {
        const plan = await getArchitectPlan(targetBranch, nextActivePlanId);
        if (plan && plan.status !== 'deleted') {
          const appStore = useAppStore.getState();
          const planProjectId = resolvePlanProjectContextId(plan, appStore.selectedProjectId);
          const currentScopedProjectIds = getScopedProjectIds(
            appStore.projectGroups,
            appStore.selectedGroupId,
            appStore.selectedProjectId
          );
          const currentScopedProjectIdSet = new Set(currentScopedProjectIds);
          const planProjectIds = getArchitectPlanProjectIds(plan);
          const isPlanAlreadyInScope =
            currentScopedProjectIdSet.size > 0 &&
            (planProjectIds.length === 0 ||
              planProjectIds.some((projectId) => currentScopedProjectIdSet.has(projectId)));
          if (planProjectId && !isPlanAlreadyInScope) {
            await appStore.switchProjectContext(planProjectId);
          }

          setPlanNodes(plan.nodes || []);
          setPredictedBranches(plan.predictedBranches || []);
          setActivePlanContext({
            id: plan.id,
            slug: plan.slug,
            title: plan.title,
            label: plan.label,
            description: plan.description,
            status: plan.status,
            targetBranch: plan.targetBranch,
          });
          const needs = await getArchitectPlanNeeds(targetBranch, plan.id);
          useNeedsStore.getState().replaceNeedsForPlan(plan.id, needs);
          let conversationId = plan.conversationId;
          const hasSharedConversation = Boolean(
            conversationId &&
            scopedFullPlans.some((candidate) => candidate.id !== plan.id && candidate.conversationId === conversationId)
          );
          if (!conversationId || hasSharedConversation) {
            const appStoreForConversation = useAppStore.getState();
            const fallbackProjectId =
              resolvePlanProjectContextId(plan, appStoreForConversation.selectedProjectId) ||
              getArchitectPlanProjectIds(plan)[0] ||
              scopedProjectIds[0] ||
              appStoreForConversation.selectedProjectId ||
              appStoreForConversation.projectGroups.flatMap((group) => group.projects)[0]?.id ||
              null;
            const created = await useChatStore
              .getState()
              .createConversation(getArchitectPlanConversationTitle(plan), null, fallbackProjectId);
            conversationId = created.id;
            await updateArchitectPlan({
              branchName: targetBranch,
              planId: plan.id,
              conversationId,
            });
            if (!conversationToastShownRef.current.has(plan.id)) {
              toast.success(
                hasSharedConversation
                  ? t('architect.planSelector.toastDedicatedConversation', 'Dedicated conversation created for this plan')
                  : t('architect.planSelector.toastConversationCreated', 'Conversation created for this plan')
              );
              conversationToastShownRef.current.add(plan.id);
            }
          }
          if (conversationId) {
            useChatStore.getState().selectConversation(conversationId);
          }
        }
      }
    } catch (loadError) {
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
      setIsLoading(false);
    }
  };

  const activatePlan = async (planId: string) => {
    setIsActivating(planId);
    setError(null);
    try {
      await setActiveArchitectPlan(targetBranch, planId);
      const plan = await getArchitectPlan(targetBranch, planId);
      if (!plan || plan.status === 'deleted') {
        throw new Error(t('architect.planSelector.errorSelectedPlanUnavailable', 'The selected plan is unavailable.'));
      }

      const appStore = useAppStore.getState();
      const planProjectId = resolvePlanProjectContextId(plan, appStore.selectedProjectId);
      const currentScopedProjectIds = getScopedProjectIds(
        appStore.projectGroups,
        appStore.selectedGroupId,
        appStore.selectedProjectId
      );
      const currentScopedProjectIdSet = new Set(currentScopedProjectIds);
      const planProjectIds = getArchitectPlanProjectIds(plan);
      const isPlanAlreadyInScope =
        currentScopedProjectIdSet.size > 0 &&
        (planProjectIds.length === 0 ||
          planProjectIds.some((projectId) => currentScopedProjectIdSet.has(projectId)));
      if (planProjectId && !isPlanAlreadyInScope) {
        await appStore.switchProjectContext(planProjectId);
      }

      setActivePlanId(planId);
      setActiveArchitectPlanId(planId);
      setPlanNodes(plan.nodes || []);
      setPredictedBranches(plan.predictedBranches || []);
      setActivePlanContext({
        id: plan.id,
        slug: plan.slug,
        title: plan.title,
        label: plan.label,
        description: plan.description,
        status: plan.status,
        targetBranch: plan.targetBranch,
      });
      const needs = await getArchitectPlanNeeds(targetBranch, plan.id);
      useNeedsStore.getState().replaceNeedsForPlan(plan.id, needs);
      let conversationId = plan.conversationId;
      const plansSnapshot = await listArchitectPlans(targetBranch, true, true);
      const hasSharedConversation = Boolean(
        conversationId &&
        plansSnapshot.plans.some((candidate) => candidate.id !== plan.id && candidate.conversationId === conversationId)
      );
      if (!conversationId || hasSharedConversation) {
        const appStoreForConversation = useAppStore.getState();
        const fallbackProjectId =
          resolvePlanProjectContextId(plan, appStoreForConversation.selectedProjectId) ||
          getArchitectPlanProjectIds(plan)[0] ||
          scopedProjectIds[0] ||
          appStoreForConversation.selectedProjectId ||
          appStoreForConversation.projectGroups.flatMap((group) => group.projects)[0]?.id ||
          null;
        const created = await useChatStore
          .getState()
          .createConversation(getArchitectPlanConversationTitle(plan), null, fallbackProjectId);
        conversationId = created.id;
        await updateArchitectPlan({
          branchName: targetBranch,
          planId: plan.id,
          conversationId,
        });
        if (!conversationToastShownRef.current.has(plan.id)) {
          toast.success(
            hasSharedConversation
              ? t('architect.planSelector.toastDedicatedConversation', 'Dedicated conversation created for this plan')
              : t('architect.planSelector.toastConversationCreated', 'Conversation created for this plan')
          );
          conversationToastShownRef.current.add(plan.id);
        }
      }
      if (conversationId) {
        useChatStore.getState().selectConversation(conversationId);
      }
      setIsOpen(false);
    } catch (activationError) {
      if (openReplicaRepair(activationError, () => activatePlan(planId))) {
        return;
      }
      const message = resolveOperationMessage(
        activationError,
        t('architect.planSelector.errorActivatePlan', 'Failed to activate plan.')
      );
      setError(message);
    } finally {
      setIsActivating(null);
    }
  };

  const handleCreatePlan = async () => {
    setFormError(null);
    setIsLoading(true);
    try {
      const created = await createArchitectPlan({
        branchName: targetBranch,
        projectId: scopedProjectIds[0] || undefined,
        projectIds: scopedProjectIds.length > 0 ? scopedProjectIds : undefined,
        status: 'draft',
        setActive: true,
      });
      await loadPlans(false);
      await activatePlan(created.id);
    } catch (err) {
      if (openReplicaRepair(err, () => handleCreatePlan())) {
        return;
      }
      const message = resolveOperationMessage(
        err,
        t('architect.planSelector.errorOperationFailed', 'Operation failed.')
      );
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRenamePlan = (planId: string) => {
    const plan = plans.find((p) => p.id === planId);
    setFormError(null);
    setPlanFormModal(plan || null);
  };

  const handleFormConfirm = async (value: string) => {
    if (!planFormModal) return;
    setFormLoading(true);
    setFormError(null);
    try {
      const existingValue = getArchitectPlanEditableName(planFormModal);
      if (value === existingValue) {
        setPlanFormModal(null);
        return;
      }
      await updateArchitectPlan({
        branchName: targetBranch,
        planId: planFormModal.id,
        ...(isCanonicalArchitectPlan(planFormModal) ? { label: value } : { title: value }),
      });
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
    try {
      await archiveArchitectPlan(targetBranch, plan.id);
      const planDisplayName = getArchitectPlanDisplayName(plan);
      toast.success(
        t('architect.planSelector.toastPlanArchived', {
          title: planDisplayName,
          defaultValue: `Plan "${planDisplayName}" archived`,
        })
      );
      const wasActive = activePlanId === plan.id;
      const refreshed = await listArchitectPlans(targetBranch, showArchived, showArchived);
      const refreshedScopedPlans = refreshed.plans.filter((candidate) =>
        isPlanVisibleForSelection(candidate, scopedProjectIds)
      );
      setPlans(refreshedScopedPlans);
      if (wasActive) {
        const nextPlanId =
          refreshed.activePlanId && refreshedScopedPlans.some((candidate) => candidate.id === refreshed.activePlanId)
            ? refreshed.activePlanId
            : refreshedScopedPlans[0]?.id || null;
        setActivePlanId(nextPlanId);
        setActiveArchitectPlanId(nextPlanId);
        if (nextPlanId) {
          await activatePlan(nextPlanId);
        } else {
          setPlanNodes([]);
          setPredictedBranches([]);
          setActivePlanContext(null);
        }
      }
    } catch (archiveError) {
      if (openReplicaRepair(archiveError, () => handleArchivePlan(plan))) {
        return;
      }
      const message = resolveOperationMessage(
        archiveError,
        t('architect.planSelector.errorArchivePlan', 'Failed to archive plan.')
      );
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmDeletePlan = async () => {
    if (!planToDelete) return;

    setError(null);
    setIsDeleting(true);
    let keepDeleteDialogOpen = false;
    try {
      const deletedPlanId = planToDelete.id;
      const cleanup = await deletePlanAndCleanupBranches({
        branchName: targetBranch,
        planId: deletedPlanId,
      });
      useTaskStore.getState().clearPlanRuntimeState({
        planId: deletedPlanId,
        deletedWorktreeKeys: cleanup.deletedWorktreeKeys,
      });
      await useTaskStore.getState().refreshFromPlan();

      toast.success(t('architect.planSelector.toastPlanDeleted', 'Plan deleted'));

      const refreshed = await listArchitectPlans(targetBranch, showArchived, showArchived);
      const refreshedScopedPlans = refreshed.plans.filter((candidate) =>
        isPlanVisibleForSelection(candidate, scopedProjectIds)
      );
      setPlans(refreshedScopedPlans);

      const deletedWasActive = activePlanId === planToDelete.id;
      if (deletedWasActive) {
        const nextPlanId =
          refreshed.activePlanId && refreshedScopedPlans.some((candidate) => candidate.id === refreshed.activePlanId)
            ? refreshed.activePlanId
            : refreshedScopedPlans[0]?.id || null;
        setActivePlanId(nextPlanId);
        setActiveArchitectPlanId(nextPlanId);

        if (nextPlanId) {
          await activatePlan(nextPlanId);
        } else {
          setPlanNodes([]);
          setPredictedBranches([]);
          setActivePlanContext(null);
        }
      }
    } catch (deleteError) {
      if (openReplicaRepair(deleteError, () => handleConfirmDeletePlan())) {
        keepDeleteDialogOpen = true;
        return;
      }
      const message = resolveOperationMessage(
        deleteError,
        t('architect.planSelector.errorDeletePlan', 'Failed to delete plan.')
      );
      setError(message);
      toast.error(message);
    } finally {
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
      toast.success(
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
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const effectKey = `${activeArchitectPlanId || 'none'}::${selectedGroupId || 'none'}::${selectedProjectId || 'none'}::${showArchived ? '1' : '0'}`;
    if (lastEffectIdRef.current === effectKey) return;
    lastEffectIdRef.current = effectKey;
    void loadPlans(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeArchitectPlanId, selectedGroupId, selectedProjectId, showArchived]);

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
      if (event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocumentMouseDown);
    return () => document.removeEventListener('mousedown', onDocumentMouseDown);
  }, [isOpen]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        onClick={() => setIsOpen((current) => !current)}
        className="h-8 px-2.5 rounded-md border border-border bg-background/60 hover:bg-accent text-xs flex items-center gap-2"
      >
        <Icon name="list" size={13} className="text-primary" />
        <span className="max-w-[140px] truncate text-foreground">
          {displayedActivePlanTitle}
        </span>
        <Icon name="chevron-down" size={13} className="text-muted-foreground" />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-[360px] rounded-xl border border-border bg-popover shadow-2xl overflow-hidden z-30">
          <div className="px-3 py-2 border-b border-border bg-card/60">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-foreground">
                {t('architect.planSelector.title', 'Architect plans')}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setShowArchived((current) => !current)}
                  className={cn(
                    'h-7 px-2 rounded-md text-xs border flex items-center gap-1.5',
                    showArchived
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border hover:bg-accent text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Icon name="archive" size={12} />
                  {showArchived
                    ? t('architect.planSelector.hideArchived', 'Hide archived')
                    : t('architect.planSelector.showArchived', 'Show archived')}
                </button>
                <button
                  onClick={() => void handleCreatePlan()}
                  className="h-7 px-2 rounded-md text-xs border border-border hover:bg-accent flex items-center gap-1.5"
                >
                  <Icon name="plus" size={12} />
                  {t('architect.planSelector.create', 'Create')}
                </button>
                <button
                  onClick={() => void loadPlans(false)}
                  className="h-7 px-2 rounded-md text-xs border border-border hover:bg-accent flex items-center gap-1.5"
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

            {!error && !isLoading && plans.length === 0 && (
              <div className="px-2 py-6 text-xs text-muted-foreground text-center">
                {t('architect.planSelector.empty', 'No plans yet.')}
              </div>
            )}

            {plans.map((plan) => {
              const isActive = plan.id === activePlanId;
              const statusClass = statusClassName[plan.status] || statusClassName.draft;
              const isBusy = isActivating === plan.id;
              const isUnavailable = plan.status === 'deleted';
              const readyPlan = readyPlanSummaries.find((candidate) => candidate.id === plan.id && candidate.readyForValidation);
              const isCanonicalPlan = isCanonicalArchitectPlan(plan);
              const primaryName = getArchitectPlanPrimaryName(plan);
              const secondaryLabel = getArchitectPlanSecondaryLabel(plan);
              const secondaryText = secondaryLabel || (!isCanonicalPlan ? plan.id : null);
              const renameLabel = isCanonicalPlan
                ? t('architect.planSelector.editPlanLabel', 'Edit plan label')
                : t('architect.planSelector.renamePlan', 'Rename plan');

              return (
                <button
                  key={plan.id}
                  onClick={() => {
                    if (!isUnavailable) {
                      void activatePlan(plan.id);
                    }
                  }}
                  disabled={isBusy}
                  className={cn(
                    'w-full text-left p-2.5 rounded-lg border transition-colors',
                    isActive
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border hover:bg-accent',
                    isUnavailable && 'cursor-default opacity-80'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground truncate">{primaryName}</div>
                      {secondaryText && (
                        <div className="text-[11px] text-muted-foreground truncate">{secondaryText}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded border uppercase', statusClass)}>
                        {t(`architect.status.${plan.status}`, plan.status)}
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!readyPlan) return;
                          setPlanReviewTarget({
                            planId: readyPlan.id,
                            branchName: readyPlan.targetBranch,
                          });
                        }}
                        disabled={!readyPlan}
                        className={cn(
                          'w-6 h-6 rounded border flex items-center justify-center',
                          readyPlan
                            ? 'border-emerald-500/30 hover:bg-emerald-500/10'
                            : 'border-border/50 opacity-40 cursor-not-allowed'
                        )}
                        title={readyPlan
                          ? t('implement.planReadyForValidation', 'Plan ready for validation')
                          : t('implement.finalizePlanUnavailable', 'Complete all tasks to review this plan')}
                      >
                        <Icon name="git-merge" size={11} className={readyPlan ? 'text-emerald-500' : 'text-muted-foreground'} />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRenamePlan(plan.id);
                        }}
                        className="w-6 h-6 rounded border border-border hover:bg-accent flex items-center justify-center"
                        title={renameLabel}
                      >
                        <Icon name="edit" size={11} className="text-muted-foreground" />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (plan.status === 'archived' || plan.status === 'deleted') {
                            void handleRestorePlan(plan);
                            return;
                          }
                          void handleArchivePlan(plan);
                        }}
                        className="w-6 h-6 rounded border border-border hover:bg-accent flex items-center justify-center"
                        title={plan.status === 'archived' || plan.status === 'deleted'
                          ? t('architect.planSelector.restorePlan', 'Restore plan')
                          : t('architect.planSelector.archivePlan', 'Archive plan')}
                      >
                        <Icon
                          name={plan.status === 'archived' || plan.status === 'deleted' ? 'rotate-ccw' : 'archive'}
                          size={11}
                          className="text-muted-foreground"
                        />
                      </button>
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
                </button>
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
              defaultValue: `This will mark "${getArchitectPlanDisplayName(planToDelete)}" as deleted and clean its plan branches/worktrees. The plan metadata is kept for recovery.`,
            })
            : t('architect.planSelector.deleteDialogFallback', 'This action cannot be undone.')
        }
        confirmLabel={isDeleting
          ? t('architect.planSelector.deleting', 'Deleting...')
          : t('architect.planSelector.deletePermanently', 'Delete and clean')}
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

      {planReviewTarget && (
        <PlanReviewModal
          isOpen
          branchName={planReviewTarget.branchName}
          planId={planReviewTarget.planId}
          onClose={() => setPlanReviewTarget(null)}
          onFinalized={() => {
            void loadPlans(false);
          }}
        />
      )}

      {replicaRepair && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">
                {t('architect.planSelector.replicaRepairTitle', 'Repair plan metadata replicas')}
              </h3>
              <p className="mt-2 text-xs text-muted-foreground">
                {replicaRepair.message}
              </p>
            </div>

            <div className="px-5 py-4 space-y-2 text-xs text-muted-foreground">
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

            <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2">
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

