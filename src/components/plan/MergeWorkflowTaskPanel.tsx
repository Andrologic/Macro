import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useTaskStore,
  type ImplementTask,
  type MergeWorkflowAutomaticResolutionResult,
  type MergeWorkflowBlockerResolutionAction,
} from '../../stores/useTaskStore';
import { toServiceError } from '../../services/contracts/errors';
import {
  resolveMergeWorkflowViewState,
  type MergeWorkflowRepositoryResult,
} from '../../services/mergeWorkflow';
import { MergeWorkflowDiffModal } from '../modals/MergeWorkflowDiffModal';
import { Icon } from '../ui/Icon';
import { Button, type ButtonProps } from '../ui/Button';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { notify } from '../ui/toastService';
import { cn } from '../../utils/cn';
import { presentGitFlowBlockingIssue } from '../../services/degradedErrorPresentation';
import { useElementSize } from '../../hooks/useElementSize';

interface MergeWorkflowTaskPanelProps {
  task: ImplementTask;
  className?: string;
}

type MergeBlockerResolutionIntent = 'retry_merge' | 'resolve_automatically';
type IncidentTone = 'danger' | 'warning' | 'info' | 'success' | 'muted';

interface RepositoryIncident {
  statusLabel: string;
  title: string;
  description: string;
  tone: IncidentTone;
  affectedFiles: string[];
  primaryLabel: string | null;
  primaryAction: MergeWorkflowBlockerResolutionAction | 'assistant' | null;
  primaryVariant: ButtonProps['variant'];
}

const COMPACT_PANEL_WIDTH = 520;

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

const resolveRepositoryAction = (
  repository: MergeWorkflowRepositoryResult
): MergeWorkflowBlockerResolutionAction | null => {
  if (isAutoStashableDirtyMergeRepository(repository)) return 'stash_dirty';
  if (isAbortableMergeInProgressRepository(repository)) return 'abort_merge';
  if (isFastForwardMergeRepository(repository)) return 'fast_forward';
  if (isRebaseMergeRepository(repository)) return 'rebase_then_continue';
  return null;
};

const resolveSimpleBlockerAction = (
  repositories: MergeWorkflowRepositoryResult[]
): MergeWorkflowBlockerResolutionAction | null => {
  if (repositories.some(isAutoStashableDirtyMergeRepository)) return 'stash_dirty';
  if (repositories.some(isAbortableMergeInProgressRepository)) return 'abort_merge';
  if (repositories.some(isFastForwardMergeRepository)) return 'fast_forward';
  if (repositories.some(isRebaseMergeRepository)) return 'rebase_then_continue';
  return null;
};

const repositoryBranchLabel = (repository: MergeWorkflowRepositoryResult): string =>
  `${repository.sourceBranchName} -> ${repository.targetBranchName}`;

const repositoryDisplayName = (repository: MergeWorkflowRepositoryResult): string => {
  const normalized = repository.repoPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || repository.repoPath;
};

const toneClassName = (tone: IncidentTone): string => {
  switch (tone) {
    case 'danger':
      return 'border-red-500/25 bg-red-500/5 text-red-400';
    case 'warning':
      return 'border-amber-500/25 bg-amber-500/5 text-amber-300';
    case 'info':
      return 'border-primary/25 bg-primary/5 text-primary';
    case 'success':
      return 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400';
    case 'muted':
      return 'border-border bg-muted/20 text-muted-foreground';
  }
};

const getRepositoryIncident = (
  repository: MergeWorkflowRepositoryResult,
  t: (key: string, fallback: string, options?: Record<string, unknown>) => string
): RepositoryIncident => {
  const dirtyFiles = repository.dirtyFiles ?? [];
  const conflictFiles = repository.conflictFiles ?? [];

  if (repository.mergeInProgress || repository.blockingKind === 'merge_in_progress') {
    return {
      statusLabel: t('implement.mergeInProgress', 'Merge in progress'),
      title: t('implement.mergeInProgressResolutionTitle', 'A merge is already in progress'),
      description: t(
        'implement.mergeInProgressCardDescription',
        'This repository has an unfinished merge. Resolve it before retrying the workflow.'
      ),
      tone: 'warning',
      affectedFiles: conflictFiles,
      primaryLabel: t('implement.resolveBlocker', 'Resolve'),
      primaryAction: 'abort_merge',
      primaryVariant: 'primary',
    };
  }

  if (repository.mergeStrategy === 'dirty' || repository.blockingKind === 'repository_dirty') {
    return {
      statusLabel: t('implement.localChangesStatus', 'Local changes'),
      title: t('implement.localChangesBlockingMerge', 'Local changes blocking merge'),
      description: t(
        'implement.localChangesBlockingMergeDescription',
        '{{count}} local file(s) need a decision before Macro can merge this repository.',
        { count: dirtyFiles.length }
      ),
      tone: 'warning',
      affectedFiles: dirtyFiles.map((file) => file.path),
      primaryLabel: t('implement.resolveBlocker', 'Resolve'),
      primaryAction: 'stash_dirty',
      primaryVariant: 'primary',
    };
  }

  if (
    repository.mergeStrategy === 'file_conflict' ||
    repository.blockingKind === 'merge_conflict' ||
    conflictFiles.length > 0
  ) {
    return {
      statusLabel: t('implement.fileConflictsStatus', 'File conflicts'),
      title: t('implement.fileConflictsBlockingMerge', 'File conflicts need resolution'),
      description: t(
        'implement.fileConflictsBlockingMergeDescription',
        '{{count}} file(s) conflict with the target branch.',
        { count: conflictFiles.length }
      ),
      tone: 'danger',
      affectedFiles: conflictFiles,
      primaryLabel: t('implement.resolveWithAi', 'Resolve with AI'),
      primaryAction: 'assistant',
      primaryVariant: 'primary',
    };
  }

  if (isFastForwardMergeRepository(repository)) {
    return {
      statusLabel: t('implement.fastForwardResolutionTitle', 'Fast-forward available'),
      title: t('implement.fastForwardAvailableInline', 'Fast-forward is available for this repository.'),
      description: t(
        'implement.fastForwardCardDescription',
        'Macro can advance the target branch without creating a merge commit.'
      ),
      tone: 'info',
      affectedFiles: [],
      primaryLabel: t('implement.chooseMergeStrategy', 'Choose merge strategy'),
      primaryAction: 'fast_forward',
      primaryVariant: 'primary',
    };
  }

  if (isRebaseMergeRepository(repository)) {
    return {
      statusLabel: t('implement.rebaseResolutionTitle', 'Rebase available'),
      title: t('implement.rebaseAvailableInline', 'This local branch can be rebased before continuing.'),
      description: t(
        'implement.rebaseCardDescription',
        'Macro can rebase this local branch, then continue with a fast-forward.'
      ),
      tone: 'info',
      affectedFiles: [],
      primaryLabel: t('implement.chooseMergeStrategy', 'Choose merge strategy'),
      primaryAction: 'rebase_then_continue',
      primaryVariant: 'primary',
    };
  }

  if (repository.progressState === 'merged') {
    return {
      statusLabel: t('implement.repositoryCommitted', 'Committed'),
      title: t('implement.mergeRepositoryAlreadyMerged', 'Already merged'),
      description: t('implement.mergeRepositoryAlreadyMergedDescription', 'This repository is already merged.'),
      tone: 'success',
      affectedFiles: [],
      primaryLabel: null,
      primaryAction: null,
      primaryVariant: 'secondary',
    };
  }

  if (repository.progressState === 'no_changes' || !repository.hasChanges) {
    return {
      statusLabel: t('implement.repositoryNoChanges', 'No changes'),
      title: t('implement.repositoryNoChanges', 'No changes'),
      description: t('implement.repositoryNoChangesHelp', 'No pending file changes for this repository.'),
      tone: 'muted',
      affectedFiles: [],
      primaryLabel: null,
      primaryAction: null,
      primaryVariant: 'secondary',
    };
  }

  return {
    statusLabel: t('implement.mergeWorkflowReady', 'Ready to merge'),
    title: t('implement.mergeRepositoryReadyTitle', 'Merge ready'),
    description: t('implement.mergeRepositoryReadyDescription', 'This repository is clean and ready for the merge action.'),
    tone: 'success',
    affectedFiles: [],
    primaryLabel: null,
    primaryAction: null,
    primaryVariant: 'secondary',
  };
};

export const MergeWorkflowTaskPanel: React.FC<MergeWorkflowTaskPanelProps> = ({
  task,
  className,
}) => {
  const { t } = useTranslation();
  const translate = useCallback(
    (key: string, fallback: string, options?: Record<string, unknown>) =>
      String(t(key, { defaultValue: fallback, ...(options || {}) })),
    [t]
  );
  const { ref: panelRef, width: panelWidth } = useElementSize<HTMLElement>();
  const isPlanFinalizationTask = task.task_source === 'plan_finalization';
  const runtime = useTaskStore((state) => state.getMergeWorkflowRuntime(task.id));
  const loadMergeWorkflowReview = useTaskStore((state) => state.loadMergeWorkflowReview);
  const runMergeWorkflow = useTaskStore((state) => state.runMergeWorkflow);
  const archivePlanFromTask = useTaskStore((state) => state.archivePlanFromTask);
  const resolveMergeWorkflowAutomatically = useTaskStore(
    (state) => state.resolveMergeWorkflowAutomatically
  );
  const [isArchiving, setIsArchiving] = useState(false);
  const [isResolvingAutomatically, setIsResolvingAutomatically] = useState(false);
  const [blockerResolutionAction, setBlockerResolutionAction] =
    useState<MergeWorkflowBlockerResolutionAction | null>(null);
  const [blockerResolutionIntent, setBlockerResolutionIntent] =
    useState<MergeBlockerResolutionIntent>('retry_merge');
  const [diffRepositoryId, setDiffRepositoryId] = useState<string | null>(null);
  const lastBlockingNotificationKeyRef = useRef<string | null>(null);

  const hasMergeRuntime = Boolean(runtime);
  const runtimePhase = runtime?.phase;
  const hasRuntimeReview = Boolean(runtime?.review);
  const repositories = useMemo(() => runtime?.repositories ?? [], [runtime?.repositories]);
  const viewState = resolveMergeWorkflowViewState(runtime, {
    canArchive: isPlanFinalizationTask,
  });
  const isLoading = viewState.isLoading;
  const isBlocked = viewState.isBlocked;
  const isFailed = viewState.isFailed;
  const isCompact = panelWidth > 0 && panelWidth < COMPACT_PANEL_WIDTH;
  const simpleBlockerResolutionAction = useMemo(
    () => resolveSimpleBlockerAction(repositories),
    [repositories]
  );
  const diffRepository = useMemo(
    () => repositories.find((repository) => repository.id === diffRepositoryId) ?? null,
    [diffRepositoryId, repositories]
  );
  const primaryBlockedRepository = useMemo(
    () =>
      (runtime?.blockedRepositories ?? []).find((repository) => repository.blockingReason) ??
      null,
    [runtime?.blockedRepositories]
  );
  const primaryBlockingPresentation = useMemo(
    () =>
      primaryBlockedRepository?.blockingReason
        ? presentGitFlowBlockingIssue({
            blockingKind: primaryBlockedRepository.blockingKind,
            reason: primaryBlockedRepository.blockingReason,
            repoPath: primaryBlockedRepository.repoPath,
            conflictFiles: primaryBlockedRepository.conflictFiles,
          })
        : null,
    [primaryBlockedRepository]
  );

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

  useEffect(() => {
    if (!diffRepositoryId) return;
    if (!repositories.some((repository) => repository.id === diffRepositoryId)) {
      setDiffRepositoryId(null);
    }
  }, [diffRepositoryId, repositories]);

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
    if (!isPlanFinalizationTask) return;
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
      if (!nextRuntime) return;

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

  const handleIncidentPrimaryAction = useCallback((
    action: RepositoryIncident['primaryAction']
  ) => {
    if (!action) return;
    if (action === 'assistant') {
      void handleResolveAutomatically('assistant');
      return;
    }
    openBlockerResolutionModal('retry_merge', action);
  }, [handleResolveAutomatically, openBlockerResolutionModal]);

  const blockingNotificationKey = useMemo(() => {
    if (!primaryBlockedRepository || !primaryBlockingPresentation || !isBlocked) return null;

    return [
      'merge-workflow-blocker',
      task.id,
      primaryBlockedRepository.id,
      primaryBlockedRepository.blockingKind || 'unknown',
      primaryBlockedRepository.blockingReason || primaryBlockingPresentation.body,
    ].join(':');
  }, [
    isBlocked,
    primaryBlockedRepository,
    primaryBlockingPresentation,
    task.id,
  ]);

  useEffect(() => {
    if (!primaryBlockedRepository || !primaryBlockingPresentation || !blockingNotificationKey) {
      return;
    }

    if (lastBlockingNotificationKeyRef.current === blockingNotificationKey) {
      return;
    }

    const action = resolveRepositoryAction(primaryBlockedRepository);
    lastBlockingNotificationKeyRef.current = blockingNotificationKey;
    notify.actionRequired(primaryBlockingPresentation.title, {
      description: [
        primaryBlockingPresentation.body,
        primaryBlockingPresentation.nextStep,
      ].filter(Boolean).join(' '),
      category: 'task_attention_required',
      notificationKey: blockingNotificationKey,
      tone: primaryBlockingPresentation.severity === 'danger' ? 'error' : 'warning',
      actions: action
        ? [{
            label: t('implement.resolveBlocker', 'Resolve'),
            onClick: () => openBlockerResolutionModal('retry_merge', action),
            dismissOnSuccess: false,
          }]
        : [{
            label: t('implement.resolveWithAi', 'Resolve with AI'),
            variant: 'secondary' as const,
            onClick: () => handleResolveAutomatically('assistant'),
            dismissOnSuccess: true,
          }],
    });
  }, [
    blockingNotificationKey,
    handleResolveAutomatically,
    openBlockerResolutionModal,
    primaryBlockedRepository,
    primaryBlockingPresentation,
    t,
  ]);

  const panelTitle = isPlanFinalizationTask
    ? t('implement.planFinalizationPanelTitle', 'Plan finalization')
    : t('implement.mergeWorkflowPanelTitle', 'Merge workflow');
  const mergeButtonLabel = isPlanFinalizationTask
    ? t('implement.mergePlan', 'Merge plan')
    : t('implement.mergeTask', 'Merge task');
  const readyPrimaryButtonLabel =
    simpleBlockerResolutionAction === 'fast_forward' ||
    simpleBlockerResolutionAction === 'rebase_then_continue'
      ? t('implement.chooseMergeStrategy', 'Choose merge strategy')
      : mergeButtonLabel;
  const attentionCount = runtime?.blockedRepositories.length ?? 0;
  const footerMessage = isLoading
    ? t('implement.loadingMergeReview', 'Loading merge review...')
    : isBlocked || isFailed
      ? t(
          'implement.mergeWorkflowAttentionSummary',
          '{{count}} repositories need attention.',
          { count: attentionCount || repositories.length }
        )
      : t(
          'implement.mergeWorkflowReadyFooter',
          'This task is now resolving its merge into the integration branch.'
        );
  const blockerResolutionRepositories = (runtime?.blockedRepositories ?? []).filter(
    (repository) =>
      blockerResolutionAction === 'stash_dirty'
        ? isAutoStashableDirtyMergeRepository(repository)
        : blockerResolutionAction === 'abort_merge'
          ? isAbortableMergeInProgressRepository(repository)
          : false
  );
  const strategyResolutionRepositories = repositories.filter(
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
  const modalRepositoryScopeMessage = modalRepositories.length > 1
    ? t(
        'implement.mergeResolutionMultipleRepositories',
        'This action applies to {{count}} repositories with the same blocker. Any remaining blockers will stay visible after Macro refreshes the review.',
        { count: modalRepositories.length }
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
            <span className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
              isBlocked || isFailed
                ? 'bg-red-500/10 text-red-400'
                : viewState.isBusy
                  ? 'bg-primary/10 text-primary'
                  : 'bg-emerald-500/10 text-emerald-400'
            )}>
              {isBlocked
                ? t('implement.mergeWorkflowBlocked', 'Merge blocked')
                : isFailed
                  ? t('implement.mergeWorkflowFailed', 'Merge failed')
                  : viewState.isBusy
                    ? t('implement.merging', 'Merging...')
                    : t('implement.mergeWorkflowReady', 'Ready to merge')}
            </span>
            {runtime?.review?.targetBranch && (
              <span
                className="min-w-0 truncate rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                title={runtime.review.targetBranch}
              >
                {t('implement.singleTarget', 'Target: {{branchName}}', {
                  branchName: runtime.review.targetBranch,
                })}
              </span>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
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
            <div className="space-y-2">
              {repositories.map((repository) => {
                const incident = getRepositoryIncident(repository, translate);
                const affectedFiles = incident.affectedFiles.slice(0, 4);
                const hiddenFileCount = Math.max(0, incident.affectedFiles.length - affectedFiles.length);

                return (
                  <section
                    key={repository.id}
                    className="rounded-xl border border-border bg-background/50 p-3"
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-semibold text-foreground" title={repository.repoPath}>
                            {repositoryDisplayName(repository)}
                          </span>
                          <span className={cn(
                            'shrink-0 rounded-full border px-2 py-0.5 text-[10px]',
                            toneClassName(incident.tone)
                          )}>
                            {incident.statusLabel}
                          </span>
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground" title={repositoryBranchLabel(repository)}>
                          {repositoryBranchLabel(repository)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 space-y-2">
                      <div>
                        <div className="text-sm font-medium text-foreground">{incident.title}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{incident.description}</div>
                      </div>

                      {affectedFiles.length > 0 && (
                        <div className="space-y-1 rounded-lg bg-muted/30 px-2 py-2">
                          {affectedFiles.map((file) => (
                            <div key={file} className="truncate text-xs text-muted-foreground" title={file}>
                              {file}
                            </div>
                          ))}
                          {hiddenFileCount > 0 && (
                            <div className="text-xs text-muted-foreground">
                              {t('implement.moreFilesCount', '+{{count}} more', { count: hiddenFileCount })}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        {incident.primaryLabel && (
                          <Button
                            type="button"
                            size="sm"
                            variant={incident.primaryVariant}
                            disabled={isResolvingAutomatically || isArchiving}
                            onClick={() => handleIncidentPrimaryAction(incident.primaryAction)}
                          >
                            {incident.primaryLabel}
                          </Button>
                        )}
                        {repository.hasChanges && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setDiffRepositoryId(repository.id)}
                          >
                            {t('implement.viewDiff', 'View diff')}
                          </Button>
                        )}
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-border bg-card p-3 shrink-0 space-y-2">
          <div className="text-xs text-muted-foreground break-words">{footerMessage}</div>
          {isBlocked || isFailed ? (
            isPlanFinalizationTask && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => void handleArchive()}
                disabled={!viewState.canArchive || isArchiving || isResolvingAutomatically}
              >
                {t('common.archive', 'Archive')}
              </Button>
            )
          ) : (
            <div className={cn('grid gap-2', isPlanFinalizationTask ? 'grid-cols-2' : 'grid-cols-1')}>
              <Button
                type="button"
                className="w-full"
                onClick={() => void handleMerge()}
                disabled={!viewState.canMerge || isArchiving}
                isLoading={viewState.isBusy}
              >
                {viewState.isBusy
                  ? t('implement.merging', 'Merging...')
                  : readyPrimaryButtonLabel}
              </Button>
              {isPlanFinalizationTask && (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => void handleArchive()}
                  disabled={!viewState.canArchive || isArchiving}
                  isLoading={isArchiving}
                >
                  {t('common.archive', 'Archive')}
                </Button>
              )}
            </div>
          )}
        </div>
      </aside>

      {diffRepository && (
        <MergeWorkflowDiffModal
          repository={diffRepository}
          onClose={() => setDiffRepositoryId(null)}
        />
      )}

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
          if (!blockerResolutionAction) return;
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
              if (!blockerResolutionAction) return;
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
              onClick={() => runBlockerResolutionChoice('revert_dirty')}
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
              onClick={() => runBlockerResolutionChoice('merge_commit')}
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
