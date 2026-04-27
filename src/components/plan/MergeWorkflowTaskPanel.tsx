import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useTaskStore,
  type DirtyMergeWorkflowResolutionAction,
  type ImplementTask,
  type MergeWorkflowAutomaticResolutionResult,
} from '../../stores/useTaskStore';
import { toServiceError } from '../../services/contracts/errors';
import {
  resolveMergeWorkflowViewState,
  type MergeWorkflowRepositoryResult,
} from '../../services/mergeWorkflow';
import { CodeViewer } from '../ui/CodeViewer';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { notify } from '../ui/toastService';
import { cn } from '../../utils/cn';
import { presentGitFlowBlockingIssue } from '../../services/degradedErrorPresentation';
import { useElementSize } from '../../hooks/useElementSize';
import { devLogger } from '../../utils/devLogger';

interface MergeWorkflowTaskPanelProps {
  task: ImplementTask;
  className?: string;
}

const COMPACT_PANEL_WIDTH = 520;
const MAX_RENDERED_MERGE_DIFF_CHARS = 100_000;

type DirtyMergeResolutionIntent = 'retry_merge' | 'resolve_automatically';

const isAutoStashableDirtyMergeRepository = (
  repository: MergeWorkflowRepositoryResult
): boolean =>
  repository.blockingKind === 'repository_dirty' &&
  repository.nextAction === 'clean_repository' &&
  !repository.mergeInProgress &&
  repository.conflictFiles.length === 0;

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

const repositoryBranchLabel = (repository: MergeWorkflowRepositoryResult): string =>
  `${repository.sourceBranchName} -> ${repository.targetBranchName}`;

export const MergeWorkflowTaskPanel: React.FC<MergeWorkflowTaskPanelProps> = ({
  task,
  className,
}) => {
  const { t } = useTranslation();
  const { ref: panelRef, width: panelWidth } = useElementSize<HTMLElement>();
  const isPlanFinalizationTask = task.task_source === 'plan_finalization';
  const runtime = useTaskStore((state) => state.getMergeWorkflowRuntime(task.id));
  const loadMergeWorkflowReview = useTaskStore((state) => state.loadMergeWorkflowReview);
  const runMergeWorkflow = useTaskStore((state) => state.runMergeWorkflow);
  const archivePlanFromTask = useTaskStore((state) => state.archivePlanFromTask);
  const resolveMergeWorkflowAutomatically = useTaskStore(
    (state) => state.resolveMergeWorkflowAutomatically
  );
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isResolvingAutomatically, setIsResolvingAutomatically] = useState(false);
  const [isDirtyResolutionModalOpen, setIsDirtyResolutionModalOpen] = useState(false);
  const [dirtyResolutionIntent, setDirtyResolutionIntent] =
    useState<DirtyMergeResolutionIntent>('resolve_automatically');
  const lastBlockingNotificationKeyRef = useRef<string | null>(null);
  const hasMergeRuntime = Boolean(runtime);
  const runtimePhase = runtime?.phase;
  const hasRuntimeReview = Boolean(runtime?.review);

  useEffect(() => {
    if (
      !hasMergeRuntime ||
      hasRuntimeReview ||
      runtimePhase === 'loading_review' ||
      runtimePhase === 'merging' ||
      runtimePhase === 'archiving'
    ) {
      return;
    }
    void loadMergeWorkflowReview(task.id).catch(() => undefined);
  }, [hasMergeRuntime, hasRuntimeReview, loadMergeWorkflowReview, runtimePhase, task.id]);

  const repositories = useMemo(() => runtime?.repositories ?? [], [runtime?.repositories]);
  const viewState = resolveMergeWorkflowViewState(runtime, {
    canArchive: isPlanFinalizationTask,
  });
  const isLoading = viewState.isLoading;
  const isBlocked = viewState.isBlocked;
  const isFailed = viewState.isFailed;
  const isCompact = panelWidth > 0 && panelWidth < COMPACT_PANEL_WIDTH;

  useEffect(() => {
    setSelectedRepositoryId((current) =>
      repositories.some((repository) => repository.id === current)
        ? current
        : repositories[0]?.id ?? null
    );
  }, [repositories]);

  const selectedRepository = useMemo(
    () =>
      repositories.find((repository) => repository.id === selectedRepositoryId) ??
      repositories[0] ??
      null,
    [repositories, selectedRepositoryId]
  );
  const selectedRepositoryBlockingPresentation = useMemo(
    () =>
      selectedRepository?.blockingReason
        ? presentGitFlowBlockingIssue({
            blockingKind: selectedRepository.blockingKind,
            reason: selectedRepository.blockingReason,
            repoPath: selectedRepository.repoPath,
            conflictFiles: selectedRepository.conflictFiles,
          })
        : null,
    [selectedRepository]
  );
  const autoStashableDirtyRepositories = useMemo(
    () =>
      (runtime?.blockedRepositories ?? []).filter(isAutoStashableDirtyMergeRepository),
    [runtime?.blockedRepositories]
  );

  const handleMerge = useCallback(async () => {
    try {
      await runMergeWorkflow(task.id);
      notify.success(
        isPlanFinalizationTask
          ? t('implement.planMerged', 'Plan merged successfully.')
          : t('implement.taskFinished', 'Task finished'),
        {
          category: 'task_completed',
        }
      );
    } catch (error) {
      const nextRuntime = useTaskStore.getState().getMergeWorkflowRuntime(task.id);
      const nextViewState = resolveMergeWorkflowViewState(nextRuntime, {
        canArchive: isPlanFinalizationTask,
      });
      if (!nextViewState.isBlocked && !nextViewState.isFailed) {
        notify.error(toServiceError(error).message);
      }
    }
  }, [isPlanFinalizationTask, runMergeWorkflow, t, task.id]);

  const notifyAutomaticResolutionResult = useCallback((
    resolution: MergeWorkflowAutomaticResolutionResult
  ) => {
    if (resolution.conversationId) {
      notify.success(
        t('implement.aiConflictAssistantStarted', 'AI conflict assistant started'),
        {
          description: isPlanFinalizationTask
            ? t(
                'implement.planFinalizationAssistantDescription',
                'Opened the task conversation and posted the plan finalization blockers.'
              )
            : t(
                'implement.mergeWorkflowAssistantDescription',
                'Opened the task conversation and posted the merge blockers.'
              ),
        }
      );
      return;
    }

    if (resolution.autoResolvedRepositoryCount > 0) {
      notify.success(
        t('implement.mergeWorkflowAutoResolved', 'Merge blockers resolved'),
        {
          description: t(
            'implement.mergeWorkflowAutoResolvedDescription',
            'Macro stashed local repository changes and refreshed the merge review.'
          ),
        }
      );
    }
  }, [isPlanFinalizationTask, t]);

  const handleRetryMerge = useCallback(async (
    dirtyRepositoryAction?: DirtyMergeWorkflowResolutionAction
  ) => {
    try {
      const nextRuntime = await loadMergeWorkflowReview(task.id, { force: true });
      if (!nextRuntime) {
        return;
      }
      const nextDirtyRepositories = nextRuntime.blockedRepositories.filter(
        isAutoStashableDirtyMergeRepository
      );
      if (!dirtyRepositoryAction && nextDirtyRepositories.length > 0) {
        setDirtyResolutionIntent('retry_merge');
        setIsDirtyResolutionModalOpen(true);
        return;
      }
      if (dirtyRepositoryAction === 'stash') {
        setIsResolvingAutomatically(true);
        setIsDirtyResolutionModalOpen(false);
        const resolution = await resolveMergeWorkflowAutomatically(task.id, {
          dirtyRepositoryAction,
        });
        if (resolution.remainingBlockedRepositoryCount > 0 || resolution.conversationId) {
          notifyAutomaticResolutionResult(resolution);
          return;
        }
        await handleMerge();
        return;
      }
      if (nextRuntime.blockedRepositories.length > 0 || nextRuntime.phase === 'failed') {
        return;
      }
      await handleMerge();
    } catch (error) {
      notify.error(toServiceError(error).message);
    } finally {
      setIsResolvingAutomatically(false);
    }
  }, [
    handleMerge,
    loadMergeWorkflowReview,
    notifyAutomaticResolutionResult,
    resolveMergeWorkflowAutomatically,
    task.id,
  ]);

  const handleArchive = useCallback(async () => {
    if (!isPlanFinalizationTask) {
      return;
    }
    setIsArchiving(true);
    try {
      await archivePlanFromTask(task.plan_id);
      notify.success(t('architect.planSelector.toastPlanArchived', 'Plan archived'));
    } catch (error) {
      notify.error(toServiceError(error).message);
    } finally {
      setIsArchiving(false);
    }
  }, [archivePlanFromTask, isPlanFinalizationTask, t, task.plan_id]);

  const handleResolveAutomatically = useCallback(async (
    dirtyRepositoryAction?: DirtyMergeWorkflowResolutionAction
  ) => {
    if (!dirtyRepositoryAction && autoStashableDirtyRepositories.length > 0) {
      setDirtyResolutionIntent('resolve_automatically');
      setIsDirtyResolutionModalOpen(true);
      return;
    }

    setIsResolvingAutomatically(true);
    try {
      setIsDirtyResolutionModalOpen(false);
      const resolution = await resolveMergeWorkflowAutomatically(task.id, {
        dirtyRepositoryAction,
      });
      notifyAutomaticResolutionResult(resolution);
    } catch (error) {
      notify.error(toServiceError(error).message);
    } finally {
      setIsResolvingAutomatically(false);
    }
  }, [
    autoStashableDirtyRepositories.length,
    notifyAutomaticResolutionResult,
    resolveMergeWorkflowAutomatically,
    task.id,
  ]);

  const blockingNotificationKey = useMemo(() => {
    if (!selectedRepository || !selectedRepositoryBlockingPresentation || !isBlocked) {
      return null;
    }

    return [
      'merge-workflow-blocker',
      task.id,
      selectedRepository.id,
      selectedRepository.blockingKind || 'unknown',
      selectedRepository.blockingReason || selectedRepositoryBlockingPresentation.body,
    ].join(':');
  }, [
    isBlocked,
    selectedRepository,
    selectedRepositoryBlockingPresentation,
    task.id,
  ]);

  useEffect(() => {
    if (!selectedRepository || !selectedRepositoryBlockingPresentation || !blockingNotificationKey) {
      return;
    }

    if (lastBlockingNotificationKeyRef.current === blockingNotificationKey) {
      return;
    }

    lastBlockingNotificationKeyRef.current = blockingNotificationKey;
    notify.actionRequired(selectedRepositoryBlockingPresentation.title, {
      description: [
        selectedRepositoryBlockingPresentation.body,
        selectedRepositoryBlockingPresentation.nextStep,
      ].filter(Boolean).join(' '),
      category: 'task_attention_required',
      notificationKey: blockingNotificationKey,
      tone: selectedRepositoryBlockingPresentation.severity === 'danger' ? 'error' : 'warning',
      actions: [
        {
          label: t('implement.retryMerge', 'Retry merge'),
          onClick: () => handleRetryMerge(),
          dismissOnSuccess: false,
        },
        {
          label: t('implement.resolveAutomatically', 'Resolve automatically'),
          variant: 'secondary',
          onClick: () => handleResolveAutomatically(),
          dismissOnSuccess: true,
        },
      ],
    });
  }, [
    blockingNotificationKey,
    handleResolveAutomatically,
    handleRetryMerge,
    selectedRepository,
    selectedRepositoryBlockingPresentation,
    t,
  ]);

  const selectedRepositoryDiffLength = selectedRepository?.diff.length ?? 0;
  const isSelectedRepositoryDiffTruncated =
    selectedRepositoryDiffLength > MAX_RENDERED_MERGE_DIFF_CHARS;

  useEffect(() => {
    if (!selectedRepository || !isSelectedRepositoryDiffTruncated) {
      return;
    }

    devLogger.debug('[mergeWorkflow] Diff too large to render fully; showing preview.', {
      taskId: task.id,
      repositoryId: selectedRepository.id,
      diffLength: selectedRepositoryDiffLength,
      renderedCharacters: MAX_RENDERED_MERGE_DIFF_CHARS,
    });
  }, [
    isSelectedRepositoryDiffTruncated,
    selectedRepository,
    selectedRepositoryDiffLength,
    task.id,
  ]);

  const footerMessage = isBlocked
    ? t(
        'implement.mergeWorkflowBlockedFooterInline',
        'Merge blocked. Fix the repositories below or give instructions in the task chat, then retry.'
      )
    : isFailed
      ? t(
          'implement.mergeWorkflowFailedFooterInline',
          'Merge failed. Inspect the repositories below, give instructions in the task chat, then retry.'
        )
      : isPlanFinalizationTask
        ? t(
            'implement.planFinalizationReadyFooter',
            'This task will merge the plan branch into the configured development branches.'
          )
        : t(
            'implement.mergeWorkflowReadyFooter',
            'This task is now resolving its merge into the integration branch.'
          );

  const mergeButtonLabel = isPlanFinalizationTask
    ? t('implement.mergePlan', 'Merge plan')
    : t('implement.mergeTask', 'Merge task');
  const panelTitle = isPlanFinalizationTask
    ? t('implement.planFinalizationPanelTitle', 'Plan finalization')
    : t('implement.mergeWorkflowPanelTitle', 'Merge workflow');

  const renderRepositoryBadges = (
    repository: MergeWorkflowRepositoryResult,
    options: { showMergeInProgress?: boolean } = {}
  ) => (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <span
        className={cn(
          'shrink-0 px-2 py-0.5 rounded-full text-[10px]',
          badgeClassName(repository.isClean, repository.isClean ? 'success' : 'danger')
        )}
      >
        {repository.isClean
          ? t('implement.repoClean', 'Clean')
          : t('implement.repoDirty', 'Dirty')}
      </span>
      <span
        className={cn(
          'shrink-0 px-2 py-0.5 rounded-full text-[10px]',
          badgeClassName(repository.mergeable, repository.mergeable ? 'success' : 'danger')
        )}
      >
        {repository.mergeable
          ? t('implement.mergeable', 'Mergeable')
          : t('implement.hasConflicts', 'Has conflicts')}
      </span>
      {options.showMergeInProgress && repository.mergeInProgress && (
        <span
          className={cn(
            'shrink-0 px-2 py-0.5 rounded-full text-[10px]',
            badgeClassName(true, 'warning')
          )}
        >
          {t('implement.mergeInProgress', 'Merge in progress')}
        </span>
      )}
    </div>
  );

  const renderRepositorySelectorButton = (
    repository: MergeWorkflowRepositoryResult,
    mode: 'compact' | 'wide'
  ) => {
    const isSelected = selectedRepository?.id === repository.id;
    const branchLabel = repositoryBranchLabel(repository);

    return (
      <button
        key={repository.id}
        type="button"
        onClick={() => setSelectedRepositoryId(repository.id)}
        title={`${repository.repoPath}\n${branchLabel}`}
        className={cn(
          'rounded-lg border px-3 py-2 text-left transition-colors min-w-0',
          mode === 'compact' ? 'w-[180px] shrink-0' : 'w-full',
          isSelected
            ? 'border-primary/40 bg-primary/10'
            : 'border-border hover:bg-accent'
        )}
      >
        <div className="truncate text-sm font-medium text-foreground">
          {repository.repoPath}
        </div>
        <div className="mt-1 truncate text-[11px] text-muted-foreground">
          {branchLabel}
        </div>
        <div className="mt-2">
          {renderRepositoryBadges(repository)}
        </div>
      </button>
    );
  };

  const renderRepositoryDetails = () => {
    if (isLoading) {
      return (
        <div className="flex-1 flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
          {t('implement.loadingMergeReview', 'Loading merge review...')}
        </div>
      );
    }

    if (!selectedRepository) {
      return null;
    }

    return (
      <div className="min-h-0 flex flex-1 flex-col">
        <div className="px-4 py-3 border-b border-border shrink-0 space-y-2">
          <div className="min-w-0 space-y-1">
            <div className="truncate text-sm font-medium text-foreground" title={selectedRepository.repoPath}>
              {selectedRepository.repoPath}
            </div>
            <div className="truncate text-[11px] text-muted-foreground" title={repositoryBranchLabel(selectedRepository)}>
              {repositoryBranchLabel(selectedRepository)}
            </div>
          </div>
          {renderRepositoryBadges(selectedRepository, { showMergeInProgress: true })}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {selectedRepository.conflictFiles.length > 0 && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
              <div className="text-sm font-medium text-red-500">
                {t('implement.conflictFiles', 'Conflict files')}
              </div>
              <div className="mt-2 break-words text-sm text-red-400">
                {selectedRepository.conflictFiles.join(', ')}
              </div>
            </div>
          )}

          {selectedRepository.hasChanges ? (
            isSelectedRepositoryDiffTruncated ? (
              <div className="min-w-0 rounded-md border border-border bg-muted/30">
                <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                  {t(
                    'implement.mergeWorkflowDiffTooLarge',
                    'Diff too large to render fully. Showing a preview.'
                  )}
                </div>
                <pre
                  className={cn(
                    'overflow-auto whitespace-pre-wrap break-words p-3 text-xs text-foreground',
                    isCompact ? 'h-[46vh]' : 'max-h-[50vh] min-h-[320px]'
                  )}
                >
                  {selectedRepository.diff.slice(0, MAX_RENDERED_MERGE_DIFF_CHARS)}
                </pre>
              </div>
            ) : (
              <CodeViewer
                code={selectedRepository.diff}
                language="diff"
                className={cn('min-h-[320px]', isCompact ? 'h-[46vh]' : 'min-h-[50vh]')}
              />
            )
          ) : (
            <div className="rounded-lg border border-border px-4 py-8 text-sm text-muted-foreground text-center">
              {t(
                'implement.noAggregatedDiff',
                'No aggregated diff between the source branch and the target branch for this repository.'
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const blockedActionGridClassName = isCompact
    ? 'grid-cols-1'
    : isPlanFinalizationTask && isBlocked
      ? 'grid-cols-3'
      : 'grid-cols-2';
  const readyActionGridClassName = isCompact
    ? 'grid-cols-1'
    : isPlanFinalizationTask
      ? 'grid-cols-2'
      : 'grid-cols-1';
  const primaryButtonClassName =
    'w-full min-w-0 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2';
  const disabledButtonClassName = 'bg-muted text-muted-foreground cursor-not-allowed';

  return (
    <>
      <aside
        ref={panelRef}
        className={cn('h-full w-full min-w-0 bg-card border-l border-border flex flex-col', className)}
        data-merge-workflow-layout={isCompact ? 'compact' : 'wide'}
      >
      <div className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
        <h1 className="min-w-0 text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="git-merge" size={16} className="text-primary shrink-0" />
          <span className="truncate">{panelTitle}</span>
        </h1>
      </div>

      <div className="px-4 py-3 border-b border-border shrink-0 space-y-2">
        <div className="min-w-0 text-sm font-medium text-foreground truncate" title={task.title}>
          {task.title}
        </div>
        {task.description && (
          <div className="min-w-0 text-xs text-muted-foreground truncate" title={task.description}>
            {task.description}
          </div>
        )}
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className={cn('shrink-0 px-2 py-0.5 rounded-full text-[10px]', badgeClassName(!isBlocked && !isFailed, isBlocked || isFailed ? 'danger' : 'success'))}>
            {isBlocked
              ? t('implement.mergeWorkflowBlocked', 'Merge blocked')
              : isFailed
                ? t('implement.mergeWorkflowFailed', 'Merge failed')
                : viewState.isBusy
                  ? t('implement.merging', 'Merging...')
                  : t('implement.mergeWorkflowReady', 'Ready to merge')}
          </span>
          {runtime?.review?.targetBranch && (
            <span className="min-w-0 truncate px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px]" title={runtime.review.targetBranch}>
              {t('implement.singleTarget', 'Target: {{branchName}}', {
                branchName: runtime.review.targetBranch,
              })}
            </span>
          )}
        </div>
      </div>

      <div
        className={cn(
          'flex-1 min-h-0 min-w-0',
          isCompact ? 'flex flex-col' : 'grid grid-cols-[220px_minmax(0,1fr)]'
        )}
      >
        <div
          className={cn(
            'shrink-0',
            isCompact
              ? 'border-b border-border overflow-x-auto p-3'
              : 'min-h-0 border-r border-border overflow-y-auto p-3 space-y-2'
          )}
          data-merge-repository-rail={isCompact ? 'true' : undefined}
          data-merge-repository-sidebar={!isCompact ? 'true' : undefined}
        >
          {isLoading && (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              {t('implement.loadingMergeReview', 'Loading merge review...')}
            </div>
          )}

          {!isLoading && repositories.length === 0 && (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              {t('implement.noRepositoriesForMergeWorkflow', 'No repositories are available for this merge workflow.')}
            </div>
          )}

          {!isLoading && repositories.length > 0 && (
            <div className={cn(isCompact ? 'flex w-max gap-2' : 'space-y-2')}>
              {repositories.map((repository) =>
                renderRepositorySelectorButton(repository, isCompact ? 'compact' : 'wide')
              )}
            </div>
          )}
        </div>

        <div className="min-h-0 min-w-0 flex flex-col">
          {renderRepositoryDetails()}
        </div>
      </div>

      <div className="p-3 border-t border-border shrink-0 space-y-2 bg-card">
        <div className="text-xs text-muted-foreground break-words">{footerMessage}</div>
        {isBlocked || isFailed ? (
          <div className={cn('grid gap-2', blockedActionGridClassName)}>
            <button
              type="button"
              onClick={() => void handleRetryMerge()}
              disabled={!viewState.canRetry || isArchiving || isResolvingAutomatically}
              className={cn(
                primaryButtonClassName,
                !viewState.canRetry || isArchiving || isResolvingAutomatically
                  ? disabledButtonClassName
                  : 'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              <Icon name="rotate-ccw" size={14} className="shrink-0" />
              <span className="truncate">{t('implement.retryMerge', 'Retry merge')}</span>
            </button>
            {isBlocked && (
              <button
                type="button"
                onClick={() => void handleResolveAutomatically()}
                disabled={!viewState.canResolveAutomatically || isArchiving || isResolvingAutomatically}
                className={cn(
                  primaryButtonClassName,
                  !viewState.canResolveAutomatically || isArchiving || isResolvingAutomatically
                    ? disabledButtonClassName
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                )}
              >
                <Icon
                  name={isResolvingAutomatically ? 'loader' : 'sparkles'}
                  size={14}
                  className={cn('shrink-0', isResolvingAutomatically ? 'animate-spin' : undefined)}
                />
                <span className="truncate">{t('implement.resolveAutomatically', 'Resolve automatically')}</span>
              </button>
            )}
            {isPlanFinalizationTask && (
              <button
                type="button"
                onClick={() => void handleArchive()}
                disabled={!viewState.canArchive || isArchiving || isResolvingAutomatically}
                className={cn(
                  primaryButtonClassName,
                  !viewState.canArchive || isArchiving || isResolvingAutomatically
                    ? disabledButtonClassName
                    : 'bg-muted text-foreground hover:bg-accent'
                )}
              >
                <Icon
                  name={isArchiving ? 'loader' : 'archive'}
                  size={14}
                  className={cn('shrink-0', isArchiving ? 'animate-spin' : undefined)}
                />
                <span className="truncate">{t('common.archive', 'Archive')}</span>
              </button>
            )}
          </div>
        ) : (
          <div className={cn('grid gap-2', readyActionGridClassName)}>
            <button
              type="button"
              onClick={() => void handleMerge()}
              disabled={!viewState.canMerge || isArchiving}
              className={cn(
                primaryButtonClassName,
                !viewState.canMerge || isArchiving
                  ? disabledButtonClassName
                  : 'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              <Icon
                name={viewState.isBusy ? 'loader' : 'git-merge'}
                size={14}
                className={cn('shrink-0', viewState.isBusy ? 'animate-spin' : undefined)}
              />
              <span className="truncate">
                {viewState.isBusy
                  ? t('implement.merging', 'Merging...')
                  : mergeButtonLabel}
              </span>
            </button>
            {isPlanFinalizationTask && (
              <button
                type="button"
                onClick={() => void handleArchive()}
                disabled={!viewState.canArchive || isArchiving}
                className={cn(
                  primaryButtonClassName,
                  !viewState.canArchive || isArchiving
                    ? disabledButtonClassName
                    : 'bg-muted text-foreground hover:bg-accent'
                )}
              >
                <Icon
                  name={isArchiving ? 'loader' : 'archive'}
                  size={14}
                  className={cn('shrink-0', isArchiving ? 'animate-spin' : undefined)}
                />
                <span className="truncate">{t('common.archive', 'Archive')}</span>
              </button>
            )}
          </div>
        )}
      </div>
      </aside>

      <ConfirmPromptModal
        isOpen={isDirtyResolutionModalOpen}
        title={t('implement.dirtyMergeResolutionTitle', 'Local changes need attention')}
        description={t(
          'implement.dirtyMergeResolutionDescription',
          'Macro found local repository changes blocking the merge. Choose how to handle them before retrying.'
        )}
        confirmLabel={t('implement.stashAndRetryMerge', 'Stash and retry')}
        cancelLabel={t('common.cancel', 'Cancel')}
        isSubmitting={isResolvingAutomatically}
        onCancel={() => {
          if (!isResolvingAutomatically) {
            setIsDirtyResolutionModalOpen(false);
          }
        }}
        onConfirm={() => {
          if (dirtyResolutionIntent === 'retry_merge') {
            void handleRetryMerge('stash');
            return;
          }
          void handleResolveAutomatically('stash');
        }}
      >
        <div className="space-y-3">
          <div className="max-h-28 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            {autoStashableDirtyRepositories.map((repository) => (
              <div key={repository.id} className="truncate" title={repository.repoPath}>
                {repository.repoPath}
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            disabled={isResolvingAutomatically}
            onClick={() => {
              void handleResolveAutomatically('assistant');
            }}
          >
            {t('implement.openAssistantInstead', 'Open assistant instead')}
          </Button>
        </div>
      </ConfirmPromptModal>
    </>
  );
};

export default MergeWorkflowTaskPanel;
