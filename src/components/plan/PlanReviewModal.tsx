import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isPlanFinalizationBlockedError,
  loadPlanReview,
  type PlanReviewResult,
} from '../../services/architectGitFlowService';
import {
  buildPlanFinalizationConflictAssistantPrompt,
  describePlanFinalizationNextStep,
  toPlanConflictResolutionEntries,
} from '../../services/conflictResolution';
import { openConflictAssistant } from '../../services/conflictAssistantService';
import { toServiceError } from '../../services/contracts/errors';
import {
  isArchitectPlanReplicaDivergenceError,
  repairArchitectPlanReplicas,
  type ArchitectPlanReplicaDivergence,
} from '../../services/architectPlanService';
import { useTaskStore } from '../../stores/useTaskStore';
import { ConflictResolutionPanel } from '../conflicts/ConflictResolutionPanel';
import { CodeViewer } from '../ui/CodeViewer';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/toastService';
import { cn } from '../../utils/cn';

interface PlanReviewModalProps {
  isOpen: boolean;
  branchName: string;
  planId: string;
  onClose: () => void;
  onFinalized?: () => void;
}

const taskStatusClasses: Record<string, string> = {
  pending: 'bg-muted text-muted-foreground',
  'in-progress': 'bg-blue-500/10 text-blue-500',
  blocked: 'bg-amber-500/10 text-amber-500',
  completed: 'bg-emerald-500/10 text-emerald-500',
};

export const PlanReviewModal: React.FC<PlanReviewModalProps> = ({
  isOpen,
  branchName,
  planId,
  onClose,
  onFinalized,
}) => {
  const { t } = useTranslation();
  const finalizePlan = useTaskStore((state) => state.finalizePlan);
  const finalizingPlanId = useTaskStore((state) => state.finalizingPlanId);
  const blockedPlanFinalization = useTaskStore((state) => state.blockedPlanFinalization);
  const clearPlanFinalizationBlock = useTaskStore((state) => state.clearPlanFinalizationBlock);
  const [review, setReview] = useState<PlanReviewResult | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRetryingFinalization, setIsRetryingFinalization] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replicaRepair, setReplicaRepair] = useState<{
    divergence: ArchitectPlanReplicaDivergence;
    message: string;
  } | null>(null);
  const [isRepairingReplica, setIsRepairingReplica] = useState(false);
  const pendingReplicaRetryRef = useRef<(() => Promise<unknown>) | null>(null);

  const openReplicaRepair = (loadError: unknown, retry?: () => Promise<unknown>): boolean => {
    if (!isArchitectPlanReplicaDivergenceError(loadError)) {
      return false;
    }

    pendingReplicaRetryRef.current = retry || null;
    setReplicaRepair({
      divergence: loadError.divergence,
      message: loadError.message,
    });
    setError(loadError.message);
    return true;
  };

  const resolveOperationMessage = (value: unknown, fallback: string): string => {
    const message = toServiceError(value).message.trim();
    return message && message !== 'Unknown error' ? message : fallback;
  };

  const loadReview = useCallback(async (options?: { cancelled?: () => boolean }): Promise<PlanReviewResult> => {
    const nextReview = await loadPlanReview({ branchName, planId });
    if (options?.cancelled?.()) {
      return nextReview;
    }
    setReview(nextReview);
    setSelectedRepositoryId((current) =>
      nextReview.repositories.some((repository) => repository.id === current)
        ? current
        : nextReview.repositories[0]?.id ?? null
    );
    return nextReview;
  }, [branchName, planId]);

  const handleClose = useCallback(() => {
    clearPlanFinalizationBlock();
    setError(null);
    onClose();
  }, [clearPlanFinalizationBlock, onClose]);

  const performReplicaRepair = async (strategy: 'oldest' | 'newest'): Promise<void> => {
    if (!replicaRepair) return;

    setIsRepairingReplica(true);
    try {
      await repairArchitectPlanReplicas({
        branchName: replicaRepair.divergence.branchName,
        planId: replicaRepair.divergence.planId,
        strategy,
      });
      await loadReview();
      const retry = pendingReplicaRetryRef.current;
      pendingReplicaRetryRef.current = null;
      setReplicaRepair(null);
      setError(null);
      if (retry) {
        await retry();
      }
    } catch (repairError) {
      setError(resolveOperationMessage(repairError, t('architect.planSelector.errorRepairReplica', 'Failed to repair plan metadata.')));
    } finally {
      setIsRepairingReplica(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        await loadReview({ cancelled: () => cancelled });
      } catch (loadError) {
        if (cancelled) return;
        if (openReplicaRepair(loadError, () => loadReview())) {
          return;
        }
        setError(resolveOperationMessage(loadError, t('architect.planReview.loadError', 'Failed to load plan review.')));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [isOpen, loadReview, planId, t]);

  useEffect(() => {
    if (!isOpen) {
      clearPlanFinalizationBlock();
      setError(null);
    }
  }, [clearPlanFinalizationBlock, isOpen]);

  useEffect(() => {
    if (blockedPlanFinalization && blockedPlanFinalization.planId !== planId) {
      clearPlanFinalizationBlock();
    }
  }, [blockedPlanFinalization, clearPlanFinalizationBlock, planId]);

  const selectedRepository = useMemo(
    () => review?.repositories.find((repository) => repository.id === selectedRepositoryId) ?? review?.repositories[0] ?? null,
    [review, selectedRepositoryId]
  );
  const blockedPlan = blockedPlanFinalization?.planId === planId ? blockedPlanFinalization : null;
  const blockedRepositories = useMemo(() => {
    if (blockedPlan?.blockedRepositories.length) {
      return blockedPlan.blockedRepositories;
    }
    return review?.repositories.filter((repository) => Boolean(repository.blockingReason)) ?? [];
  }, [blockedPlan, review]);
  const hasBlockingIssues = blockedRepositories.length > 0;
  const conflictEntries = useMemo(
    () => toPlanConflictResolutionEntries(blockedRepositories),
    [blockedRepositories]
  );
  const panelError = blockedPlan?.message ?? null;
  const showInlineError = Boolean(error && (!hasBlockingIssues || error !== panelError));

  const handleFinalize = async () => {
    setError(null);
    clearPlanFinalizationBlock();
    try {
      await finalizePlan(planId);
    } catch (finalizeError) {
      if (openReplicaRepair(finalizeError, () => handleFinalize())) {
        return;
      }
      if (!isPlanFinalizationBlockedError(finalizeError)) {
        setError(toServiceError(finalizeError).message);
      }
    }
    if (useTaskStore.getState().blockedPlanFinalization) {
      return;
    }
    const storeError = useTaskStore.getState().lastError;
    if (storeError) {
      setError(storeError);
      return;
    }
    onFinalized?.();
    handleClose();
  };

  const handleRetryFinalization = async () => {
    setIsRetryingFinalization(true);
    setError(null);
    clearPlanFinalizationBlock();
    try {
      const nextReview = await loadReview();
      if (nextReview.repositories.some((repository) => Boolean(repository.blockingReason))) {
        return;
      }
      await handleFinalize();
    } catch (retryError) {
      if (openReplicaRepair(retryError, () => handleRetryFinalization())) {
        return;
      }
      if (!isPlanFinalizationBlockedError(retryError)) {
        setError(toServiceError(retryError).message);
      }
    } finally {
      setIsRetryingFinalization(false);
    }
  };

  const openAiConflictReviewAssistant = async () => {
    if (!review || blockedRepositories.length === 0) {
      return;
    }

    try {
      await openConflictAssistant(buildPlanFinalizationConflictAssistantPrompt({
        planTitle: review.plan.title,
        repositories: blockedRepositories,
      }));
      toast.success(t('implement.aiConflictAssistantStarted', 'AI conflict assistant started'), {
        description: t(
          'implement.planFinalizationAssistantDescription',
          'Opened an Implement review conversation and posted the plan finalization blockers.'
        ),
      });
    } catch (assistantError) {
      setError(toServiceError(assistantError).message);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-7xl max-h-[92vh] bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground truncate">
              {review?.plan.title || t('implement.planReview', 'Plan review')}
            </h2>
            <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span>{review?.tasks.length ?? 0} {t('implement.tasks', 'tasks')}</span>
              <span>{review?.repositories.length ?? 0} {t('implement.repositories', 'repositories')}</span>
              {review?.plan.status && (
                <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground uppercase">
                  {t(`architect.status.${review.plan.status}`, review.plan.status)}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="w-8 h-8 rounded-md border border-border hover:bg-accent flex items-center justify-center"
          >
            <Icon name="x" size={16} className="text-muted-foreground" />
          </button>
        </div>

        {showInlineError && (
          <div className="px-6 py-3 border-b border-border bg-red-500/5 text-sm text-red-500">
            {error}
          </div>
        )}

        {hasBlockingIssues && (
          <div className="px-6 py-3 border-b border-border bg-amber-500/5 text-sm text-amber-500">
            {t(
              'implement.planReviewBlockingIssues',
              'Fix repository cleanliness or merge conflicts before finalizing this plan.'
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 grid grid-cols-[320px_minmax(0,1fr)]">
          <div className="border-r border-border overflow-y-auto p-4 space-y-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {t('implement.planTasks', 'Plan tasks')}
              </div>
              <div className="space-y-2">
                {isLoading && (
                  <div className="text-sm text-muted-foreground">
                    {t('architect.planSelector.loading', 'Loading plans...')}
                  </div>
                )}
                {!isLoading && review?.tasks.map((task) => (
                  <div key={task.id} className="rounded-lg border border-border px-3 py-2">
                    <div className="text-sm font-medium text-foreground">{task.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                      <span className={cn('px-1.5 py-0.5 rounded', taskStatusClasses[task.status] || taskStatusClasses.pending)}>
                        {t(`architect.nodeStatus.${task.status}`, task.status)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Icon name="git-branch" size={10} />
                        {task.branchName}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {t('implement.repositories', 'Repositories')}
              </div>
              <div className="space-y-2">
                {!isLoading && review?.repositories.map((repository) => (
                  <button
                    key={repository.id}
                    type="button"
                    onClick={() => setSelectedRepositoryId(repository.id)}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                      selectedRepository?.id === repository.id
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-border hover:bg-accent'
                    )}
                  >
                    <div className="text-sm font-medium text-foreground truncate">
                      {repository.repoPath}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {repository.planBranchName} -&gt; {repository.baseBranchName}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="min-h-0 flex flex-col">
            {isLoading && (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                {t('implement.loadingPlanReview', 'Loading plan review...')}
              </div>
            )}

            {!isLoading && selectedRepository && (
              <>
                <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <span className={cn(
                      'px-2 py-0.5 rounded-full',
                      selectedRepository.isClean
                        ? 'bg-emerald-500/10 text-emerald-500'
                        : 'bg-red-500/10 text-red-500'
                    )}>
                      {selectedRepository.isClean
                        ? t('implement.repoClean', 'Clean')
                        : t('implement.repoDirty', 'Dirty')}
                    </span>
                    <span className={cn(
                      'px-2 py-0.5 rounded-full',
                      selectedRepository.mergeable
                        ? 'bg-emerald-500/10 text-emerald-500'
                        : 'bg-red-500/10 text-red-500'
                    )}>
                      {selectedRepository.mergeable
                        ? t('implement.mergeable', 'Mergeable')
                        : t('implement.hasConflicts', 'Has conflicts')}
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {t('implement.checkStatusNotRun', 'Checks: not_run')}
                    </span>
                  </div>
                  {selectedRepository.blockingReason && (
                    <div className="text-xs text-red-500">
                      {selectedRepository.blockingReason}
                    </div>
                  )}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
                  {hasBlockingIssues && (
                    <ConflictResolutionPanel
                      title={t('implement.planFinalizationBlockedTitle', 'Plan finalization blocked')}
                      description={t(
                        'implement.planFinalizationBlockedDescription',
                        'Resolve the repository blockers below, then retry finalization explicitly.'
                      )}
                      repositories={conflictEntries}
                      error={panelError}
                      retryLabel={t('implement.retryFinalization', 'Retry finalization')}
                      retryDisabled={Boolean(finalizingPlanId) || isRetryingFinalization || isLoading}
                      retryLoading={Boolean(finalizingPlanId) || isRetryingFinalization}
                      onDismiss={handleClose}
                      dismissLabel={t('common.close', 'Close')}
                      onRetry={() => void handleRetryFinalization()}
                      onUseAiAssistant={() => void openAiConflictReviewAssistant()}
                    />
                  )}

                  <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
                    <div className="font-medium text-foreground mb-1">{selectedRepository.repoPath}</div>
                    <div>{selectedRepository.planBranchName} -&gt; {selectedRepository.baseBranchName}</div>
                    {selectedRepository.mergeInProgress && (
                      <div className="mt-2 inline-flex rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500">
                        {t('implement.mergeInProgress', 'Merge in progress')}
                      </div>
                    )}
                    {selectedRepository.nextAction && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {describePlanFinalizationNextStep(selectedRepository.nextAction)}
                      </div>
                    )}
                    {selectedRepository.conflictFiles.length > 0 && (
                      <div className="mt-2 text-red-500">
                        {selectedRepository.conflictFiles.join(', ')}
                      </div>
                    )}
                  </div>

                  {selectedRepository.hasChanges ? (
                    <CodeViewer
                      code={selectedRepository.diff}
                      language="diff"
                      className="min-h-[50vh]"
                    />
                  ) : (
                    <div className="rounded-lg border border-border px-4 py-8 text-sm text-muted-foreground text-center">
                      {t('implement.noAggregatedDiff', 'No aggregated diff between the plan branch and the base branch for this repository.')}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-border flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {hasBlockingIssues
              ? t('implement.planReviewBlockedFooter', 'Finalization is blocked until every repository is clean and mergeable.')
              : t('implement.planReviewReadyFooter', 'This plan can be finalized into its base branch.')}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('common.close', 'Close')}
            </button>
            <button
              type="button"
              onClick={() => void handleFinalize()}
              disabled={Boolean(finalizingPlanId) || hasBlockingIssues || isLoading}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2',
                Boolean(finalizingPlanId) || hasBlockingIssues || isLoading
                  ? 'bg-muted text-muted-foreground cursor-not-allowed'
                  : 'bg-emerald-500 text-white hover:bg-emerald-600'
              )}
            >
              <Icon
                name={finalizingPlanId === planId ? 'loader' : 'git-merge'}
                size={14}
                className={finalizingPlanId === planId ? 'animate-spin' : undefined}
              />
              {finalizingPlanId === planId
                ? t('implement.finalizingPlan', 'Finalizing...')
                : t('implement.finalizePlan', 'Finalize plan')}
            </button>
          </div>
        </div>
      </div>

      {replicaRepair && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">
                {t('implement.planReviewReplicaRepair', 'Repair plan metadata replicas')}
              </h3>
              <p className="mt-2 text-xs text-muted-foreground">{replicaRepair.message}</p>
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

export default PlanReviewModal;
