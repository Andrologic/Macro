import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useTaskStore,
  type ImplementTask,
  type MergeWorkflowBlockerResolutionAction,
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

type MergeBlockerResolutionIntent = 'retry_merge' | 'resolve_automatically';

const isAutoStashableDirtyMergeRepository = (
  repository: MergeWorkflowRepositoryResult
): boolean =>
  repository.blockingKind === 'repository_dirty' &&
  repository.nextAction === 'clean_repository' &&
  !repository.mergeInProgress &&
  repository.conflictFiles.length === 0;

const isAbortableMergeInProgressRepository = (
  repository: MergeWorkflowRepositoryResult
): boolean =>
  repository.blockingKind === 'merge_in_progress' &&
  repository.nextAction === 'finish_or_abort_merge' &&
  repository.mergeInProgress &&
  repository.conflictFiles.length === 0;

const isFastForwardMergeRepository = (
  repository: MergeWorkflowRepositoryResult
): boolean =>
  repository.progressState === 'pending' &&
  repository.recommendedAction === 'fast_forward' &&
  (repository.availableActions ?? []).includes('fast_forward');

const isRebaseMergeRepository = (
  repository: MergeWorkflowRepositoryResult
): boolean =>
  repository.progressState === 'pending' &&
  repository.recommendedAction === 'rebase_then_continue' &&
  (repository.availableActions ?? []).includes('rebase_then_continue') &&
  !repository.isSourcePublished;

const resolveSimpleBlockerAction = (
  repositories: MergeWorkflowRepositoryResult[]
): MergeWorkflowBlockerResolutionAction | null => {
  if (repositories.some(isAutoStashableDirtyMergeRepository)) {
    return 'stash_dirty';
  }
  if (repositories.some(isAbortableMergeInProgressRepository)) {
    return 'abort_merge';
  }
  if (repositories.some(isFastForwardMergeRepository)) {
    return 'fast_forward';
  }
  if (repositories.some(isRebaseMergeRepository)) {
    return 'rebase_then_continue';
  }
  return null;
};

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
  const [blockerResolutionAction, setBlockerResolutionAction] =
    useState<MergeWorkflowBlockerResolutionAction | null>(null);
  const [blockerResolutionIntent, setBlockerResolutionIntent] =
    useState<MergeBlockerResolutionIntent>('resolve_automatically');
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
  const simpleBlockerResolutionAction = useMemo(
    () => resolveSimpleBlockerAction(runtime?.repositories ?? []),
    [runtime?.repositories]
  );
  const hasFileConflict = Boolean(
    runtime?.blockedRepositories.some(
      (repository) => repository.mergeStrategy === 'file_conflict'
    )
  );
  const resolveAutomaticallyLabel = hasFileConflict
    ? t('implement.resolveWithAi', 'Resolve with AI')
    : t('implement.resolveAutomatically', 'Resolve automatically');
  const hasSimpleResolution = Boolean(simpleBlockerResolutionAction);
  const blockedPrimaryButtonLabel = hasSimpleResolution
    ? t('implement.resolveBlocker', 'Resolve')
    : t('implement.retryMerge', 'Retry merge');

  const openBlockerResolutionModal = useCallback((
    intent: MergeBlockerResolutionIntent,
    action: MergeWorkflowBlockerResolutionAction
  ) => {
    setBlockerResolutionIntent(intent);
    setBlockerResolutionAction(action);
  }, []);

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

  const handleMerge = useCallback(async (
    action?: MergeWorkflowBlockerResolutionAction,
    options: { skipStrategyPrompt?: boolean } = {}
  ) => {
    if (!options.skipStrategyPrompt && !action && simpleBlockerResolutionAction) {
      openBlockerResolutionModal('retry_merge', simpleBlockerResolutionAction);
      return;
    }

    try {
      if (action) {
        await runMergeWorkflow(task.id, { mergeStrategyAction: action });
      } else {
        await runMergeWorkflow(task.id);
      }
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
      if (action === 'rebase_then_continue') {
        try {
          const resolution = await resolveMergeWorkflowAutomatically(task.id, {
            blockerResolutionAction: 'assistant',
          });
          notifyAutomaticResolutionResult(resolution);
        } catch (assistantError) {
          notify.error(toServiceError(assistantError).message);
        }
        return;
      }
      if (!nextViewState.isBlocked && !nextViewState.isFailed) {
        notify.error(toServiceError(error).message);
      }
    }
  }, [
    isPlanFinalizationTask,
    notifyAutomaticResolutionResult,
    openBlockerResolutionModal,
    resolveMergeWorkflowAutomatically,
    runMergeWorkflow,
    simpleBlockerResolutionAction,
    t,
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

  const runAutomaticResolution = useCallback(async (
    action?: MergeWorkflowBlockerResolutionAction
  ): Promise<MergeWorkflowAutomaticResolutionResult | null> => {
    setIsResolvingAutomatically(true);
    try {
      setBlockerResolutionAction(null);
      const resolution = await resolveMergeWorkflowAutomatically(task.id, {
        blockerResolutionAction: action,
      });
      notifyAutomaticResolutionResult(resolution);
      return resolution;
    } catch (error) {
      notify.error(toServiceError(error).message);
      return null;
    } finally {
      setIsResolvingAutomatically(false);
    }
  }, [
    notifyAutomaticResolutionResult,
    resolveMergeWorkflowAutomatically,
    task.id,
  ]);

  const handleRetryMerge = useCallback(async (
    action?: MergeWorkflowBlockerResolutionAction
  ) => {
    try {
      const nextRuntime = await loadMergeWorkflowReview(task.id, { force: true });
      if (!nextRuntime) {
        return;
      }

      const nextSimpleAction = resolveSimpleBlockerAction(nextRuntime.repositories);
      if (!action && nextSimpleAction) {
        openBlockerResolutionModal('retry_merge', nextSimpleAction);
        return;
      }

      if (action === 'stash_dirty' || action === 'revert_dirty' || action === 'abort_merge') {
        const resolution = await runAutomaticResolution(action);
        if (
          !resolution ||
          resolution.remainingBlockedRepositoryCount > 0 ||
          resolution.conversationId
        ) {
          return;
        }
        await handleMerge(undefined, { skipStrategyPrompt: true });
        return;
      }

      if (
        action === 'fast_forward' ||
        action === 'rebase_then_continue' ||
        action === 'merge_commit'
      ) {
        await handleMerge(action);
        return;
      }

      if (nextRuntime.blockedRepositories.length > 0 || nextRuntime.phase === 'failed') {
        return;
      }
      await handleMerge();
    } catch (error) {
      notify.error(toServiceError(error).message);
    }
  }, [
    handleMerge,
    loadMergeWorkflowReview,
    openBlockerResolutionModal,
    runAutomaticResolution,
    task.id,
  ]);

  const handleResolveAutomatically = useCallback(async (
    action?: MergeWorkflowBlockerResolutionAction
  ) => {
    if (!action && simpleBlockerResolutionAction) {
      openBlockerResolutionModal('resolve_automatically', simpleBlockerResolutionAction);
      return;
    }

    await runAutomaticResolution(action);
  }, [
    openBlockerResolutionModal,
    runAutomaticResolution,
    simpleBlockerResolutionAction,
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
          label: blockedPrimaryButtonLabel,
          onClick: () => handleRetryMerge(),
          dismissOnSuccess: false,
        },
        ...(!hasSimpleResolution
          ? [{
              label: resolveAutomaticallyLabel,
              variant: 'secondary' as const,
              onClick: () => handleResolveAutomatically(),
              dismissOnSuccess: true,
            }]
          : []),
      ],
    });
  }, [
    blockingNotificationKey,
    blockedPrimaryButtonLabel,
    handleResolveAutomatically,
    handleRetryMerge,
    hasSimpleResolution,
    selectedRepository,
    selectedRepositoryBlockingPresentation,
    resolveAutomaticallyLabel,
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
  const readyPrimaryButtonLabel =
    simpleBlockerResolutionAction === 'fast_forward' ||
    simpleBlockerResolutionAction === 'rebase_then_continue'
      ? t('implement.chooseMergeStrategy', 'Choose merge strategy')
      : mergeButtonLabel;
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

    const dirtyFiles = selectedRepository.dirtyFiles ?? [];

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

          {dirtyFiles.length > 0 && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
              <div className="text-sm font-medium text-amber-500">
                {t('implement.localChangesBlockingMerge', 'Local changes blocking merge')}
              </div>
              <div className="mt-2 max-h-32 space-y-1 overflow-y-auto text-xs text-amber-300">
                {dirtyFiles.map((file) => (
                  <div key={`${file.area}:${file.path}`} className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 uppercase text-[10px]">
                      {file.area}
                    </span>
                    <span className="truncate" title={file.path}>{file.path}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(selectedRepository.mergeStrategy === 'fast_forward_available' ||
            selectedRepository.mergeStrategy === 'rebase_available') && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
              {selectedRepository.mergeStrategy === 'fast_forward_available'
                ? t(
                    'implement.fastForwardAvailableInline',
                    'Fast-forward is available for this repository.'
                  )
                : t(
                    'implement.rebaseAvailableInline',
                    'This local branch can be rebased before continuing.'
                  )}
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

  const showResolveAutomaticallyButton = isBlocked && !hasSimpleResolution;
  const blockedActionCount =
    1 + (showResolveAutomaticallyButton ? 1 : 0) + (isPlanFinalizationTask ? 1 : 0);
  const blockedActionGridClassName = isCompact || blockedActionCount <= 1
    ? 'grid-cols-1'
    : blockedActionCount === 3
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
  const blockerResolutionRepositories = (runtime?.blockedRepositories ?? []).filter(
    (repository) =>
      blockerResolutionAction === 'stash_dirty'
        ? isAutoStashableDirtyMergeRepository(repository)
        : blockerResolutionAction === 'abort_merge'
          ? isAbortableMergeInProgressRepository(repository)
          : false
  );
  const strategyResolutionRepositories = (runtime?.repositories ?? []).filter(
    (repository) =>
      blockerResolutionAction === 'fast_forward'
        ? isFastForwardMergeRepository(repository)
        : blockerResolutionAction === 'rebase_then_continue'
          ? isRebaseMergeRepository(repository)
          : blockerResolutionAction === 'merge_commit'
            ? (repository.availableActions ?? []).includes('merge_commit')
            : false
  );
  const modalRepositories =
    strategyResolutionRepositories.length > 0
      ? strategyResolutionRepositories
      : blockerResolutionRepositories;
  const blockerResolutionTitle =
    blockerResolutionAction === 'fast_forward'
      ? t('implement.fastForwardResolutionTitle', 'Fast-forward available')
      : blockerResolutionAction === 'rebase_then_continue'
        ? t('implement.rebaseResolutionTitle', 'Rebase available')
        : blockerResolutionAction === 'abort_merge'
      ? t('implement.mergeInProgressResolutionTitle', 'A merge is already in progress')
      : t('implement.dirtyMergeResolutionTitle', 'Local changes need attention');
  const blockerResolutionDescription =
    blockerResolutionAction === 'fast_forward'
      ? t(
          'implement.fastForwardResolutionDescription',
          'Macro can advance the target branch directly to the source branch without creating a merge commit.'
        )
      : blockerResolutionAction === 'rebase_then_continue'
        ? t(
            'implement.rebaseResolutionDescription',
            'Macro can rebase this local source branch onto the target branch, then continue with a fast-forward. This rewrites the local branch history.'
          )
        : blockerResolutionAction === 'abort_merge'
      ? t(
          'implement.mergeInProgressResolutionDescription',
          'Macro found an unfinished merge blocking this retry. Aborting it can discard partial conflict resolutions that were not committed.'
        )
      : t(
          'implement.dirtyMergeResolutionDescription',
          'Macro found local repository changes blocking the merge. Choose how to handle them before retrying.'
        );
  const blockerResolutionConfirmLabel =
    blockerResolutionAction === 'fast_forward'
      ? t('implement.fastForwardAndContinue', 'Fast-forward and continue')
      : blockerResolutionAction === 'rebase_then_continue'
        ? t('implement.rebaseThenContinue', 'Rebase then continue')
        : blockerResolutionAction === 'abort_merge'
      ? t('implement.abortMergeAndRetry', 'Abort merge and retry')
      : t('implement.stashAndRetryMerge', 'Stash and retry');
  const canRevertDirtyResolution = blockerResolutionAction === 'stash_dirty';
  const canUseMergeCommitResolution =
    blockerResolutionAction === 'fast_forward' ||
    blockerResolutionAction === 'rebase_then_continue';
  const modalRepositoryCount = modalRepositories.length;
  const modalRepositoryScopeMessage = modalRepositoryCount > 1
    ? t(
        'implement.mergeResolutionMultipleRepositories',
        'This action applies to {{count}} repositories with the same blocker. Any remaining blockers will stay visible after Macro refreshes the review.',
        { count: modalRepositoryCount }
      )
    : null;
  const runBlockerResolutionChoice = (
    action: MergeWorkflowBlockerResolutionAction
  ) => {
    if (action === 'merge_commit' && blockerResolutionIntent !== 'retry_merge') {
      void handleMerge('merge_commit');
      return;
    }
    if (blockerResolutionIntent === 'retry_merge') {
      void handleRetryMerge(action);
      return;
    }
    void handleResolveAutomatically(action);
  };
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
              <span className="truncate">{blockedPrimaryButtonLabel}</span>
            </button>
            {showResolveAutomaticallyButton && (
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
                <span className="truncate">{resolveAutomaticallyLabel}</span>
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
                  : readyPrimaryButtonLabel}
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
        isOpen={Boolean(blockerResolutionAction)}
        title={blockerResolutionTitle}
        description={blockerResolutionDescription}
        confirmLabel={blockerResolutionConfirmLabel}
        cancelLabel={t('common.cancel', 'Cancel')}
        isSubmitting={isResolvingAutomatically}
        showConfirmButton={false}
        onCancel={() => {
          if (!isResolvingAutomatically) {
            setBlockerResolutionAction(null);
          }
        }}
        onConfirm={() => {
          if (!blockerResolutionAction) {
            return;
          }
          if (blockerResolutionIntent === 'retry_merge') {
            void handleRetryMerge(blockerResolutionAction);
            return;
          }
          void handleResolveAutomatically(blockerResolutionAction);
        }}
      >
        <div className="space-y-3">
          {modalRepositoryScopeMessage && (
            <p className="text-xs text-muted-foreground">
              {modalRepositoryScopeMessage}
            </p>
          )}
          <div className="max-h-28 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            {modalRepositories.map((repository) => (
              <div key={repository.id} className="truncate" title={repository.repoPath}>
                {repository.repoPath}
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant={blockerResolutionAction === 'abort_merge' ? 'error' : 'primary'}
            size="sm"
            className="w-full"
            disabled={isResolvingAutomatically || !blockerResolutionAction}
            onClick={() => {
              if (!blockerResolutionAction) {
                return;
              }
              runBlockerResolutionChoice(blockerResolutionAction);
            }}
          >
            {blockerResolutionConfirmLabel}
          </Button>
          {canRevertDirtyResolution && (
            <Button
              type="button"
              variant="error"
              size="sm"
              className="w-full"
              disabled={isResolvingAutomatically}
              onClick={() => {
                runBlockerResolutionChoice('revert_dirty');
              }}
            >
              {t('implement.revertAndRetryMerge', 'Revert and retry')}
            </Button>
          )}
          {canUseMergeCommitResolution && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full"
              disabled={isResolvingAutomatically}
              onClick={() => {
                runBlockerResolutionChoice('merge_commit');
              }}
            >
              {t('implement.useMergeCommit', 'Use merge commit')}
            </Button>
          )}
          {!canUseMergeCommitResolution && (
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
          )}
        </div>
      </ConfirmPromptModal>
    </>
  );
};

export default MergeWorkflowTaskPanel;
