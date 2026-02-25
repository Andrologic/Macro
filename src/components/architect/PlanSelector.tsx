import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  archiveArchitectPlan,
  createArchitectPlan,
  deleteArchitectPlan,
  getArchitectPlan,
  getArchitectPlanNeeds,
  getGitFlowBaseBranch,
  listArchitectPlans,
  setActiveArchitectPlan,
  updateArchitectPlan,
  type ArchitectPlanSummary,
} from '../../services/architectPlanService';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useNeedsStore } from '../../stores/useNeedsStore';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toaster';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
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

const formatRelativeDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString();
};

export const PlanSelector: React.FC<PlanSelectorProps> = ({ className }) => {
  const { setPlanNodes, setPredictedBranches, setActiveArchitectPlanId, setActivePlanContext, activeArchitectPlanId, selectedProjectId } = useAppStore();
  const [isOpen, setIsOpen] = useState(false);
  const [plans, setPlans] = useState<ArchitectPlanSummary[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isActivating, setIsActivating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planToDelete, setPlanToDelete] = useState<ArchitectPlanSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const conversationToastShownRef = useRef<Set<string>>(new Set());
  const autoCreatingRef = useRef(false);
  const targetBranch = getGitFlowBaseBranch();

  const activePlan = useMemo(() => {
    if (!activePlanId) return null;
    return plans.find((plan) => plan.id === activePlanId) || null;
  }, [plans, activePlanId]);

  const loadPlans = async (hydrateActive = false) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listArchitectPlans(targetBranch, false);

      // Auto-create a default plan when none exist
      if (result.plans.length === 0 && !autoCreatingRef.current) {
        autoCreatingRef.current = true;
        try {
          const appStoreForCreation = useAppStore.getState();
          const fallbackProjectId =
            selectedProjectId ||
            appStoreForCreation.projectGroups.flatMap((group) => group.projects)[0]?.id ||
            null;
          const conversation = await useChatStore
            .getState()
            .createConversation('Plan · New Plan', null, fallbackProjectId);
          const created = await createArchitectPlan({
            branchName: targetBranch,
            title: 'New Plan',
            projectId: selectedProjectId || undefined,
            conversationId: conversation.id,
            status: 'draft',
            setActive: true,
          });
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
                  ? 'Dedicated conversation created for this plan'
                  : 'Conversation created for this plan'
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
      const message = loadError instanceof Error ? loadError.message : 'Failed to load plans.';
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
        throw new Error('The selected plan is unavailable.');
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
      const plansSnapshot = await listArchitectPlans(targetBranch, true);
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
              ? 'Dedicated conversation created for this plan'
              : 'Conversation created for this plan'
          );
          conversationToastShownRef.current.add(plan.id);
        }
      }
      if (conversationId) {
        useChatStore.getState().selectConversation(conversationId);
      }
      setIsOpen(false);
    } catch (activationError) {
      const message = activationError instanceof Error ? activationError.message : 'Failed to activate plan.';
      setError(message);
    } finally {
      setIsActivating(null);
    }
  };

  const handleCreatePlan = async () => {
    const title = window.prompt('Plan name');
    if (!title || title.trim().length === 0) return;

    setError(null);
    setIsLoading(true);
    try {
      const appStoreForConversation = useAppStore.getState();
      const fallbackProjectId =
        selectedProjectId ||
        appStoreForConversation.projectGroups.flatMap((group) => group.projects)[0]?.id ||
        null;
      const conversation = await useChatStore
        .getState()
        .createConversation(`Plan · ${title.trim()}`, null, fallbackProjectId);

      const created = await createArchitectPlan({
        branchName: targetBranch,
        title: title.trim(),
        slug: title.trim(),
        projectId: selectedProjectId || undefined,
        conversationId: conversation.id,
        status: 'draft',
        setActive: true,
      });

      await loadPlans(false);
      await activatePlan(created.id);
    } catch (creationError) {
      const message = creationError instanceof Error ? creationError.message : 'Failed to create plan.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRenamePlan = async (planId: string, currentTitle: string) => {
    const nextTitle = window.prompt('Rename plan', currentTitle);
    if (!nextTitle || nextTitle.trim().length === 0 || nextTitle.trim() === currentTitle) return;

    setError(null);
    setIsLoading(true);
    try {
      await updateArchitectPlan({
        branchName: targetBranch,
        planId,
        title: nextTitle.trim(),
      });
      await loadPlans(false);
    } catch (renameError) {
      const message = renameError instanceof Error ? renameError.message : 'Failed to rename plan.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleArchivePlan = async (plan: ArchitectPlanSummary) => {
    setError(null);
    setIsLoading(true);
    try {
      await archiveArchitectPlan(targetBranch, plan.id);
      toast.success(`Plan "${plan.title}" archived`);
      const wasActive = activePlanId === plan.id;
      const refreshed = await listArchitectPlans(targetBranch, false);
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
      const message = archiveError instanceof Error ? archiveError.message : 'Failed to archive plan.';
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
      await deleteArchitectPlan({
        branchName: targetBranch,
        planId: planToDelete.id,
        hardDelete: true,
      });

      toast.success('Plan deleted');

      const refreshed = await listArchitectPlans(targetBranch, false);
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
        }
      }
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Failed to delete plan.';
      setError(message);
      toast.error(message);
    } finally {
      setIsDeleting(false);
      setPlanToDelete(null);
    }
  };

  useEffect(() => {
    void loadPlans(true);
  }, [activeArchitectPlanId]);

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
          {activePlan?.title || 'Select plan'}
        </span>
        <Icon name="chevron-down" size={13} className="text-muted-foreground" />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-[360px] rounded-xl border border-border bg-popover shadow-2xl overflow-hidden z-30">
          <div className="px-3 py-2 border-b border-border bg-card/60">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-foreground">Architect plans</div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => void handleCreatePlan()}
                  className="h-7 px-2 rounded-md text-xs border border-border hover:bg-accent flex items-center gap-1.5"
                >
                  <Icon name="plus" size={12} />
                  Create
                </button>
                <button
                  onClick={() => void loadPlans(false)}
                  className="h-7 px-2 rounded-md text-xs border border-border hover:bg-accent flex items-center gap-1.5"
                >
                  <Icon name="rotate-ccw" size={12} className={cn(isLoading && 'animate-spin')} />
                  Refresh
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
                Loading plans...
              </div>
            )}

            {!error && !isLoading && plans.length === 0 && (
              <div className="px-2 py-6 text-xs text-muted-foreground text-center">
                No plans yet.
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
                        {plan.status}
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleRenamePlan(plan.id, plan.title);
                        }}
                        className="w-6 h-6 rounded border border-border hover:bg-accent flex items-center justify-center"
                        title="Rename plan"
                      >
                        <Icon name="edit" size={11} className="text-muted-foreground" />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleArchivePlan(plan);
                        }}
                        className="w-6 h-6 rounded border border-border hover:bg-accent flex items-center justify-center"
                        title="Archive plan"
                      >
                        <Icon name="archive" size={11} className="text-muted-foreground" />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setPlanToDelete(plan);
                        }}
                        className="w-6 h-6 rounded border border-red-500/30 hover:bg-red-500/10 flex items-center justify-center"
                        title="Delete plan"
                      >
                        <Icon name="trash" size={11} className="text-red-500" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 text-[11px] text-muted-foreground flex items-center gap-2">
                    <span>{plan.nodeCount} nodes</span>
                    <span>•</span>
                    <span>{formatRelativeDate(plan.updatedAt)}</span>
                    {isActive && (
                      <>
                        <span>•</span>
                        <span className="text-primary inline-flex items-center gap-1">
                          <Icon name="check" size={11} />
                          Active
                        </span>
                      </>
                    )}
                    {isBusy && (
                      <span className="text-primary inline-flex items-center gap-1 ml-auto">
                        <Icon name="loader" size={11} className="animate-spin" />
                        Loading
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
        title="Delete Plan"
        description={
          planToDelete
            ? `This will permanently delete "${planToDelete.title}" and its strategy data. This action cannot be undone.`
            : 'This action cannot be undone.'
        }
        confirmLabel={isDeleting ? 'Deleting...' : 'Delete permanently'}
        cancelLabel="Cancel"
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
    </div>
  );
};

export default PlanSelector;
