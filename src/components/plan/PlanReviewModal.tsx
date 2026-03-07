import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { loadPlanReview, type PlanReviewResult } from '../../services/architectGitFlowService';
import { useTaskStore } from '../../stores/useTaskStore';
import { CodeViewer } from '../ui/CodeViewer';
import { Icon } from '../ui/Icon';
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
  const [review, setReview] = useState<PlanReviewResult | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const nextReview = await loadPlanReview({ branchName, planId });
        if (cancelled) return;
        setReview(nextReview);
        setSelectedRepositoryId((current) =>
          nextReview.repositories.some((repository) => repository.id === current)
            ? current
            : nextReview.repositories[0]?.id ?? null
        );
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
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
  }, [branchName, isOpen, planId]);

  const selectedRepository = useMemo(
    () => review?.repositories.find((repository) => repository.id === selectedRepositoryId) ?? review?.repositories[0] ?? null,
    [review, selectedRepositoryId]
  );
  const hasBlockingIssues = review?.repositories.some((repository) => Boolean(repository.blockingReason)) ?? false;

  const handleFinalize = async () => {
    await finalizePlan(planId);
    const storeError = useTaskStore.getState().lastError;
    if (storeError) {
      setError(storeError);
    }
    try {
      const refreshed = await loadPlanReview({ branchName, planId });
      setReview(refreshed);
      if (refreshed.plan.status === 'completed') {
        onFinalized?.();
        onClose();
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
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
                  {review.plan.status}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-md border border-border hover:bg-accent flex items-center justify-center"
          >
            <Icon name="x" size={16} className="text-muted-foreground" />
          </button>
        </div>

        {error && (
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
                        {task.status}
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
                  <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
                    <div className="font-medium text-foreground mb-1">{selectedRepository.repoPath}</div>
                    <div>{selectedRepository.planBranchName} -&gt; {selectedRepository.baseBranchName}</div>
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
              onClick={onClose}
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
    </div>
  );
};

export default PlanReviewModal;
