import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTaskStore, type ImplementTask } from '../../stores/useTaskStore';
import { describePlanFinalizationNextStep } from '../../services/conflictResolution';
import { toServiceError } from '../../services/contracts/errors';
import { resolvePlanFinalizationViewState } from '../../services/planFinalization';
import { CodeViewer } from '../ui/CodeViewer';
import { Icon } from '../ui/Icon';
import { notify } from '../ui/toastService';
import { cn } from '../../utils/cn';

interface PlanFinalizationTaskPanelProps {
  task: ImplementTask;
  className?: string;
}

const badgeClassName = (
  enabled: boolean,
  tone: 'success' | 'warning' | 'danger' | 'default'
): string => {
  if (!enabled) {
    return 'bg-muted text-muted-foreground';
  }

  switch (tone) {
    case 'success':
      return 'bg-emerald-500/10 text-emerald-500';
    case 'warning':
      return 'bg-amber-500/10 text-amber-500';
    case 'danger':
      return 'bg-red-500/10 text-red-500';
    default:
      return 'bg-primary/10 text-primary';
  }
};

export const PlanFinalizationTaskPanel: React.FC<PlanFinalizationTaskPanelProps> = ({
  task,
  className,
}) => {
  const { t } = useTranslation();
  const runtime = useTaskStore((state) => state.getPlanFinalizationRuntime(task.plan_id));
  const loadPlanFinalizationReview = useTaskStore((state) => state.loadPlanFinalizationReview);
  const finalizePlan = useTaskStore((state) => state.finalizePlan);
  const archivePlanFromTask = useTaskStore((state) => state.archivePlanFromTask);
  const resolvePlanFinalizationAutomatically = useTaskStore(
    (state) => state.resolvePlanFinalizationAutomatically
  );
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isResolvingAutomatically, setIsResolvingAutomatically] = useState(false);

  useEffect(() => {
    void loadPlanFinalizationReview(task.plan_id).catch(() => undefined);
  }, [loadPlanFinalizationReview, task.plan_id]);

  const repositories = runtime?.review?.repositories || runtime?.repositories || [];
  const viewState = resolvePlanFinalizationViewState(runtime);
  const isLoading = viewState.isLoading;
  const isMerging = viewState.isMerging;
  const isBlocked = viewState.isBlocked;
  const reviewError = runtime?.message || null;

  useEffect(() => {
    setSelectedRepositoryId((current) =>
      repositories.some((repository) => repository.id === current)
        ? current
        : repositories[0]?.id ?? null
    );
  }, [repositories]);

  const selectedRepository = useMemo(
    () => repositories.find((repository) => repository.id === selectedRepositoryId) ?? repositories[0] ?? null,
    [repositories, selectedRepositoryId]
  );

  const handleMerge = async () => {
    try {
      await finalizePlan(task.plan_id);
      notify.success(t('implement.planMerged', 'Plan merged successfully.'), {
        category: 'task_completed',
      });
    } catch (error) {
      if (!viewState.isBlocked) {
        notify.error(toServiceError(error).message);
      }
    }
  };

  const handleRetryMerge = async () => {
    try {
      const nextRuntime = await loadPlanFinalizationReview(task.plan_id, { force: true });
      if (nextRuntime?.blockedRepositories.length) {
        return;
      }
      await handleMerge();
    } catch (error) {
      notify.error(toServiceError(error).message);
    }
  };

  const handleArchive = async () => {
    setIsArchiving(true);
    try {
      await archivePlanFromTask(task.plan_id);
      notify.success(t('architect.planSelector.toastPlanArchived', 'Plan archived'));
    } catch (error) {
      notify.error(toServiceError(error).message);
    } finally {
      setIsArchiving(false);
    }
  };

  const handleResolveAutomatically = async () => {
    setIsResolvingAutomatically(true);
    try {
      const conversationId = await resolvePlanFinalizationAutomatically(task.plan_id);
      if (conversationId) {
        notify.success(
          t('implement.aiConflictAssistantStarted', 'AI conflict assistant started'),
          {
            description: t(
              'implement.planFinalizationAssistantDescription',
              'Opened the task conversation and posted the plan finalization blockers.'
            ),
          }
        );
      }
    } catch (error) {
      notify.error(toServiceError(error).message);
    } finally {
      setIsResolvingAutomatically(false);
    }
  };

  const footerMessage = isBlocked
    ? t(
        'implement.planFinalizationBlockedFooterInline',
        'Merge blocked. Fix the repositories below or give instructions in the task chat, then retry.'
      )
    : t(
        'implement.planFinalizationReadyFooter',
        'This task will merge the plan branch into the configured development branches.'
      );

  return (
    <aside className={cn('h-full w-full bg-card border-l border-border flex flex-col', className)}>
      <div className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="git-merge" size={16} className="text-primary" />
          {t('implement.planFinalizationPanelTitle', 'Plan finalization')}
        </h1>
      </div>

      <div className="px-4 py-3 border-b border-border shrink-0 space-y-2">
        <div className="text-sm font-medium text-foreground">{task.title}</div>
        <div className="text-xs text-muted-foreground">
          {task.description}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('px-2 py-0.5 rounded-full text-[10px]', badgeClassName(isBlocked, 'danger'))}>
            {isBlocked
              ? t('implement.planFinalizationBlocked', 'Blocked')
              : viewState.isBusy
                ? t('implement.finalizingPlan', 'Finalizing...')
                : t('implement.planFinalizationReady', 'Ready to merge')}
          </span>
          {runtime?.review?.plan.targetBranch && (
            <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px]">
              {t('implement.singleTarget', 'Target: {{branchName}}', {
                branchName: runtime.review.plan.targetBranch,
              })}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[280px_minmax(0,1fr)]">
        <div className="border-r border-border overflow-y-auto p-3 space-y-2">
          {isLoading && (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              {t('implement.loadingPlanReview', 'Loading plan review...')}
            </div>
          )}

          {!isLoading && repositories.length === 0 && (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              {t('implement.noRepositoriesForPlanFinalization', 'No repositories are available for this plan.')}
            </div>
          )}

          {!isLoading && repositories.map((repository) => (
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
              <div className="text-sm font-medium text-foreground truncate">{repository.repoPath}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {repository.planBranchName} -&gt; {repository.baseBranchName}
              </div>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className={cn('px-2 py-0.5 rounded-full text-[10px]', badgeClassName(repository.isClean, repository.isClean ? 'success' : 'danger'))}>
                  {repository.isClean ? t('implement.repoClean', 'Clean') : t('implement.repoDirty', 'Dirty')}
                </span>
                <span className={cn('px-2 py-0.5 rounded-full text-[10px]', badgeClassName(repository.mergeable, repository.mergeable ? 'success' : 'danger'))}>
                  {repository.mergeable ? t('implement.mergeable', 'Mergeable') : t('implement.hasConflicts', 'Has conflicts')}
                </span>
              </div>
            </button>
          ))}
        </div>

        <div className="min-h-0 flex flex-col">
          {isLoading && (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              {t('implement.loadingPlanReview', 'Loading plan review...')}
            </div>
          )}

          {!isLoading && selectedRepository && (
            <>
              <div className="px-4 py-3 border-b border-border shrink-0 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={cn('px-2 py-0.5 rounded-full text-[10px]', badgeClassName(selectedRepository.isClean, selectedRepository.isClean ? 'success' : 'danger'))}>
                    {selectedRepository.isClean ? t('implement.repoClean', 'Clean') : t('implement.repoDirty', 'Dirty')}
                  </span>
                  <span className={cn('px-2 py-0.5 rounded-full text-[10px]', badgeClassName(selectedRepository.mergeable, selectedRepository.mergeable ? 'success' : 'danger'))}>
                    {selectedRepository.mergeable ? t('implement.mergeable', 'Mergeable') : t('implement.hasConflicts', 'Has conflicts')}
                  </span>
                  {selectedRepository.mergeInProgress && (
                    <span className={cn('px-2 py-0.5 rounded-full text-[10px]', badgeClassName(true, 'warning'))}>
                      {t('implement.mergeInProgress', 'Merge in progress')}
                    </span>
                  )}
                </div>
                {selectedRepository.blockingReason && (
                  <div className="text-sm text-red-500">{selectedRepository.blockingReason}</div>
                )}
                {selectedRepository.nextAction && (
                  <div className="text-xs text-muted-foreground">
                    {describePlanFinalizationNextStep(selectedRepository.nextAction)}
                  </div>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                {reviewError && (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-500">
                    {reviewError}
                  </div>
                )}

                {selectedRepository.conflictFiles.length > 0 && (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                    <div className="text-sm font-medium text-red-500">
                      {t('implement.conflictFiles', 'Conflict files')}
                    </div>
                    <div className="mt-2 text-sm text-red-400">
                      {selectedRepository.conflictFiles.join(', ')}
                    </div>
                  </div>
                )}

                {selectedRepository.hasChanges ? (
                  <CodeViewer
                    code={selectedRepository.diff}
                    language="diff"
                    className="min-h-[50vh]"
                  />
                ) : (
                  <div className="rounded-lg border border-border px-4 py-8 text-sm text-muted-foreground text-center">
                    {t(
                      'implement.noAggregatedDiff',
                      'No aggregated diff between the plan branch and the base branch for this repository.'
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="p-3 border-t border-border shrink-0 space-y-2">
        <div className="text-xs text-muted-foreground">{footerMessage}</div>
        {isBlocked ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => void handleRetryMerge()}
              disabled={!viewState.canRetry || isArchiving || isResolvingAutomatically}
              className={cn(
                'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
                !viewState.canRetry || isArchiving || isResolvingAutomatically
                  ? 'bg-muted text-muted-foreground cursor-not-allowed'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              <Icon name="rotate-ccw" size={14} />
              {t('implement.retryMerge', 'Retry merge')}
            </button>
            <button
              type="button"
              onClick={() => void handleResolveAutomatically()}
              disabled={!viewState.canResolveAutomatically || isArchiving || isResolvingAutomatically}
              className={cn(
                'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
                !viewState.canResolveAutomatically || isArchiving || isResolvingAutomatically
                  ? 'bg-muted text-muted-foreground cursor-not-allowed'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
              )}
            >
              <Icon
                name={isResolvingAutomatically ? 'loader' : 'sparkles'}
                size={14}
                className={isResolvingAutomatically ? 'animate-spin' : undefined}
              />
              {t('implement.resolveAutomatically', 'Resolve automatically')}
            </button>
            <button
              type="button"
              onClick={() => void handleArchive()}
              disabled={!viewState.canArchive || isArchiving || isResolvingAutomatically}
              className={cn(
                'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
                !viewState.canArchive || isArchiving || isResolvingAutomatically
                  ? 'bg-muted text-muted-foreground cursor-not-allowed'
                  : 'bg-muted text-foreground hover:bg-accent'
              )}
            >
              <Icon
                name={isArchiving ? 'loader' : 'archive'}
                size={14}
                className={isArchiving ? 'animate-spin' : undefined}
              />
              {t('common.archive', 'Archive')}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => void handleMerge()}
              disabled={!viewState.canMerge || isArchiving}
              className={cn(
                'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
                !viewState.canMerge || isArchiving
                  ? 'bg-muted text-muted-foreground cursor-not-allowed'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              <Icon
                name={isMerging ? 'loader' : 'git-merge'}
                size={14}
                className={isMerging ? 'animate-spin' : undefined}
              />
              {isMerging
                ? t('implement.finalizingPlan', 'Finalizing...')
                : t('implement.mergePlan', 'Merge plan')}
            </button>
            <button
              type="button"
              onClick={() => void handleArchive()}
              disabled={!viewState.canArchive || isArchiving}
              className={cn(
                'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
                !viewState.canArchive || isArchiving
                  ? 'bg-muted text-muted-foreground cursor-not-allowed'
                  : 'bg-muted text-foreground hover:bg-accent'
              )}
            >
              <Icon
                name={isArchiving ? 'loader' : 'archive'}
                size={14}
                className={isArchiving ? 'animate-spin' : undefined}
              />
              {t('common.archive', 'Archive')}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};

export default PlanFinalizationTaskPanel;
