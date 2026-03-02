import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  archiveArchitectPlan,
  createArchitectPlan,
  getArchitectPlan,
  getArchitectPlanNeeds,
  getGitFlowBaseBranch,
  listArchitectPlans,
  restoreArchitectPlan,
  setActiveArchitectPlan,
  updateArchitectPlan,
  type ArchitectPlanSummary,
} from '../../services/architectPlanService';
import { deletePlanAndCleanupBranches } from '../../services/architectGitFlowService';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useNeedsStore } from '../../stores/useNeedsStore';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toaster';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { PlanFormModal } from './PlanFormModal';
import { cn } from '../../utils/cn';

interface PlanSelectorProps {
  className?: string;
}

const statusClassName: Record<string, string> = {
  draft: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
  validated: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
  in_progress: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
  archived: 'text-muted-foreground bg-muted/50 border-border/70',
  deleted: 'text-red-500 bg-red-500/10 border-red-500/20',
};

const formatRelativeDate = (iso: string, unknownLabel: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return unknownLabel;
  return date.toLocaleDateString();
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const conversationToastShownRef = useRef<Set<string>>(new Set());
  const autoCreatingRef = useRef(false);
  const lastEffectIdRef = useRef<string | null | undefined>(undefined);
  const targetBranch = getGitFlowBaseBranch();

  const [planFormModal, setPlanFormModal] = useState<{
    open: boolean;
    mode: 'create' | 'rename';
    plan?: ArchitectPlanSummary;
  } | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const activePlan = useMemo(() => {
    if (!activePlanId) return null;
    return plans.find((plan) => plan.id === activePlanId) || null;
  }, [plans, activePlanId]);

  const displayedActivePlanTitle = useMemo(() => {
    if (activePlanContext && activePlanContext.id === activePlanId && activePlanContext.title.trim().length > 0) {
      return activePlanContext.title;
    }
    return activePlan?.title || t('architect.planSelector.selectPlan', 'Select plan');
  }, [activePlan, activePlanContext, activePlanId, t]);

  const loadPlans = async (hydrateActive = false) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listArchitectPlans(targetBranch, false, showArchived);
      const fullResult = showArchived ? result : await listArchitectPlans(targetBranch, false, true);

      // Auto-create a default plan when none exist
      if (fullResult.plans.length === 0 && !autoCreatingRef.current) {
        autoCreatingRef.current = true;
        try {
          const appStoreForCreation = useAppStore.getState();
          const fallbackProjectId =
            selectedProjectId ||
            appStoreForCreation.projectGroups.flatMap((group) => group.projects)[0]?.id ||
            null;
          let createdTitle = t('architect.planForm.createTitle', 'New Plan');
          let created = null as Awaited<ReturnType<typeof createArchitectPlan>> | null;
          for (let index = 0; index < 50; index += 1) {
            const baseTitle = t('architect.planForm.createTitle', 'New Plan');
            const candidateTitle = index === 0 ? baseTitle : `${baseTitle} ${index + 1}`;
            try {
              const conversation = await useChatStore
                .getState()
                .createConversation(`Plan · ${candidateTitle}`, null, fallbackProjectId);
              created = await createArchitectPlan({
                branchName: targetBranch,
                title: candidateTitle,
                projectId: selectedProjectId || undefined,
                conversationId: conversation.id,
                status: 'draft',
                setActive: true,
              });
              createdTitle = candidateTitle;
              break;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const isDuplicateNameError = /already exists or existed before/i.test(message);
              if (!isDuplicateNameError || index === 49) {
                throw error;
              }
            }
          }

          if (!created) {
            throw new Error(
              t('architect.planSelector.autoCreateError', {
                title: createdTitle,
                defaultValue: `Unable to auto-create default plan from base title "${createdTitle}".`,
              })
            );
          }

          await activatePlan(created.id);
          return;
        } finally {
          autoCreatingRef.current = false;
        }
      }

      setPlans(result.plans);
      const nextActivePlanId = activeArchitectPlanId || result.activePlanId;
      setActivePlanId(nextActivePlanId);
      setActiveArchitectPlanId(nextActivePlanId);

      if (hydrateActive && nextActivePlanId) {
        const plan = await getArchitectPlan(targetBranch, nextActivePlanId);
        if (plan && plan.status !== 'deleted') {
          const appStore = useAppStore.getState();
          if (plan.projectId && appStore.selectedProjectId !== plan.projectId) {
            appStore.setSelectedProject(plan.projectId);
          }

          setPlanNodes(plan.nodes || []);
          setPredictedBranches(plan.predictedBranches || []);
          setActivePlanContext({
            id: plan.id,
            title: plan.title,
            description: plan.description,
            status: plan.status,
            targetBranch: plan.targetBranch,
          });
          const needs = await getArchitectPlanNeeds(targetBranch, plan.id);
          useNeedsStore.getState().replaceNeedsForPlan(plan.id, needs);
          let conversationId = plan.conversationId;
          const hasSharedConversation = Boolean(
            conversationId &&
            result.plans.some((candidate) => candidate.id !== plan.id && candidate.conversationId === conversationId)
          );
          if (!conversationId || hasSharedConversation) {
            const appStoreForConversation = useAppStore.getState();
            const fallbackProjectId =
              plan.projectId ||
              appStoreForConversation.selectedProjectId ||
              appStoreForConversation.projectGroups.flatMap((group) => group.projects)[0]?.id ||
              null;
            const created = await useChatStore
              .getState()
              .createConversation(`Plan · ${plan.title}`, null, fallbackProjectId);
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
      const message = loadError instanceof Error
        ? loadError.message
        : t('architect.planSelector.errorLoadPlans', 'Failed to load plans.');
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
      if (plan.projectId && appStore.selectedProjectId !== plan.projectId) {
        appStore.setSelectedProject(plan.projectId);
      }

      setActivePlanId(planId);
      setActiveArchitectPlanId(planId);
      setPlanNodes(plan.nodes || []);
      setPredictedBranches(plan.predictedBranches || []);
      setActivePlanContext({
        id: plan.id,
        title: plan.title,
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
          plan.projectId ||
          appStoreForConversation.selectedProjectId ||
          appStoreForConversation.projectGroups.flatMap((group) => group.projects)[0]?.id ||
          null;
        const created = await useChatStore
          .getState()
          .createConversation(`Plan · ${plan.title}`, null, fallbackProjectId);
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
      const message = activationError instanceof Error
        ? activationError.message
        : t('architect.planSelector.errorActivatePlan', 'Failed to activate plan.');
      setError(message);
    } finally {
      setIsActivating(null);
    }
  };

  const handleCreatePlan = () => {
    setFormError(null);
    setPlanFormModal({ open: true, mode: 'create' });
  };

  const handleRenamePlan = (planId: string, _currentTitle: string) => {
    const plan = plans.find((p) => p.id === planId);
    setFormError(null);
    setPlanFormModal({ open: true, mode: 'rename', plan });
  };

  const handleFormConfirm = async (title: string, description?: string) => {
    if (!planFormModal) return;
    setFormLoading(true);
    setFormError(null);
    try {
      if (planFormModal.mode === 'create') {
        const appStoreForConversation = useAppStore.getState();
        const fallbackProjectId =
          selectedProjectId ||
          appStoreForConversation.projectGroups.flatMap((g) => g.projects)[0]?.id ||
          null;
        const conversation = await useChatStore
          .getState()
          .createConversation(`Plan · ${title}`, null, fallbackProjectId);
        const created = await createArchitectPlan({
          branchName: targetBranch,
          title,
          slug: title,
          description,
          projectId: selectedProjectId || undefined,
          conversationId: conversation.id,
          status: 'draft',
          setActive: true,
        });
        setPlanFormModal(null);
        await loadPlans(false);
        await activatePlan(created.id);
      } else if (planFormModal.mode === 'rename' && planFormModal.plan) {
        if (title === planFormModal.plan.title) {
          setPlanFormModal(null);
          return;
        }
        await updateArchitectPlan({
          branchName: targetBranch,
          planId: planFormModal.plan.id,
          title,
        });
        setPlanFormModal(null);
        await loadPlans(false);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('architect.planSelector.errorOperationFailed', 'Operation failed.'));
    } finally {
      setFormLoading(false);
    }
  };

  const handleArchivePlan = async (plan: ArchitectPlanSummary) => {
    setError(null);
    setIsLoading(true);
    try {
      await archiveArchitectPlan(targetBranch, plan.id);
      toast.success(
        t('architect.planSelector.toastPlanArchived', {
          title: plan.title,
          defaultValue: `Plan "${plan.title}" archived`,
        })
      );
      const wasActive = activePlanId === plan.id;
      const refreshed = await listArchitectPlans(targetBranch, false, showArchived);
      setPlans(refreshed.plans);
      if (wasActive) {
        const nextPlanId = refreshed.activePlanId || refreshed.plans[0]?.id || null;
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
      const message = archiveError instanceof Error
        ? archiveError.message
        : t('architect.planSelector.errorArchivePlan', 'Failed to archive plan.');
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
    try {
      await deletePlanAndCleanupBranches({
        branchName: targetBranch,
        planId: planToDelete.id,
        hardDelete: true,
      });

      toast.success(t('architect.planSelector.toastPlanDeleted', 'Plan deleted'));

      const refreshed = await listArchitectPlans(targetBranch, false, showArchived);
      setPlans(refreshed.plans);

      const deletedWasActive = activePlanId === planToDelete.id;
      if (deletedWasActive) {
        const nextPlanId = refreshed.activePlanId || refreshed.plans[0]?.id || null;
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
      const message = deleteError instanceof Error
        ? deleteError.message
        : t('architect.planSelector.errorDeletePlan', 'Failed to delete plan.');
      setError(message);
      toast.error(message);
    } finally {
      setIsDeleting(false);
      setPlanToDelete(null);
    }
  };

  const handleRestorePlan = async (plan: ArchitectPlanSummary) => {
    setError(null);
    setIsLoading(true);
    try {
      await restoreArchitectPlan(targetBranch, plan.id);
      toast.success(
        t('architect.planSelector.toastPlanRestored', {
          title: plan.title,
          defaultValue: `Plan "${plan.title}" restored`,
        })
      );
      await loadPlans(false);
    } catch (restoreError) {
      const message = restoreError instanceof Error
        ? restoreError.message
        : t('architect.planSelector.errorRestorePlan', 'Failed to restore plan.');
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Guard against re-runs when activeArchitectPlanId hasn't actually changed
    // (e.g. when loadPlans itself calls setActiveArchitectPlanId during auto-creation)
    if (lastEffectIdRef.current === activeArchitectPlanId) return;
    lastEffectIdRef.current = activeArchitectPlanId;
    void loadPlans(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeArchitectPlanId, showArchived]);

  useEffect(() => {
    if (!activePlanContext) return;

    setPlans((current) => {
      let changed = false;
      const next = current.map((plan) => {
        if (plan.id !== activePlanContext.id) return plan;
        const nextStatus = activePlanContext.status as ArchitectPlanSummary['status'];
        if (
          plan.title === activePlanContext.title &&
          plan.description === activePlanContext.description &&
          plan.status === nextStatus
        ) {
          return plan;
        }
        changed = true;
        return {
          ...plan,
          title: activePlanContext.title,
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
                  onClick={handleCreatePlan}
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

              return (
                <button
                  key={plan.id}
                  onClick={() => void activatePlan(plan.id)}
                  disabled={isBusy}
                  className={cn(
                    'w-full text-left p-2.5 rounded-lg border transition-colors',
                    isActive
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border hover:bg-accent'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground truncate">{plan.title}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{plan.id}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded border uppercase', statusClass)}>
                        {t(`architect.status.${plan.status}`, plan.status)}
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRenamePlan(plan.id, plan.title);
                        }}
                        className="w-6 h-6 rounded border border-border hover:bg-accent flex items-center justify-center"
                        title={t('architect.planSelector.renamePlan', 'Rename plan')}
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
                          void handleArchivePlan(plan);
                        }}
                        className="w-6 h-6 rounded border border-border hover:bg-accent flex items-center justify-center"
                        title={plan.status === 'archived'
                          ? t('architect.planSelector.restorePlan', 'Restore plan')
                          : t('architect.planSelector.archivePlan', 'Archive plan')}
                      >
                        <Icon
                          name={plan.status === 'archived' ? 'rotate-ccw' : 'archive'}
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
                    <span>•</span>
                    <span>{formatRelativeDate(plan.updatedAt, t('architect.planSelector.unknownDate', 'Unknown date'))}</span>
                    {isActive && (
                      <>
                        <span>•</span>
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
              title: planToDelete.title,
              defaultValue: `This will permanently delete "${planToDelete.title}" and its strategy data. This action cannot be undone.`,
            })
            : t('architect.planSelector.deleteDialogFallback', 'This action cannot be undone.')
        }
        confirmLabel={isDeleting
          ? t('architect.planSelector.deleting', 'Deleting...')
          : t('architect.planSelector.deletePermanently', 'Delete permanently')}
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

      {planFormModal?.open && (
        <PlanFormModal
          mode={planFormModal.mode}
          initialTitle={planFormModal.mode === 'rename' ? (planFormModal.plan?.title ?? '') : ''}
          onConfirm={(title, description) => void handleFormConfirm(title, description)}
          onClose={() => {
            if (!formLoading) setPlanFormModal(null);
          }}
          isLoading={formLoading}
          error={formError}
        />
      )}
    </div>
  );
};

export default PlanSelector;
