import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import {
  useFileChangesStore,
  buildFolderTree,
  type FolderNode,
  type ReviewRepositoryState,
} from '../../stores/useFileChangesStore';
import {
  type ReviewRepositorySummary,
  type ReviewRepositoryUiState,
} from '../../services/implementMultiRepoSummary';
import {
  getServiceRuntimeCapabilities,
  REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE,
} from '../../services';
import { toServiceError } from '../../services/contracts/errors';
import {
  areAllFileChangesRepositoriesResolved,
} from '../../services/fileChangesReviewScope';
import { isPlanFinalizationTaskSource } from '../../services/planFinalization';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { notify } from '../ui/toastService';
import { FileChangesDiffModal } from '../modals/FileChangesDiffModal';
import { Button } from '../ui/Button';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { PlanFinalizationTaskPanel } from '../plan/PlanFinalizationTaskPanel';

interface FileChangesPanelProps {
  className?: string;
}

type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

const CHANGE_PANEL_POLL_INTERVAL_MS = 1500;
const CHANGE_PANEL_HIDDEN_POLL_INTERVAL_MS = 8000;

const STATUS_COLORS = {
  added: 'text-primary',
  modified: 'text-foreground',
  deleted: 'text-destructive',
};

const STATUS_BG = {
  added: 'bg-primary/10',
  modified: 'bg-muted',
  deleted: 'bg-destructive/10',
};

const STATUS_MARKERS: Record<string, string> = {
  added: '+',
  modified: 'M',
  deleted: '-',
};

const REVIEW_STATE_CLASSES: Record<ReviewRepositoryUiState, string> = {
  pending_validation: 'bg-primary/10 text-primary',
  ready_to_commit: 'bg-secondary text-secondary-foreground',
  committed: 'bg-muted text-muted-foreground',
  no_changes: 'bg-muted text-muted-foreground',
};

const getRepositoryPathTail = (repoPath: string | null | undefined, fallback: string): string => {
  const normalized = (repoPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || fallback;
};

const getRepositoryDisplayName = (
  repository: Pick<ReviewRepositoryState, 'projectId' | 'repoPath'>,
  projectName?: string | null
): string => {
  const tail = getRepositoryPathTail(repository.repoPath, repository.projectId);
  return projectName || tail;
};

const normalizeCommitErrorMessage = (raw: string, t: TranslateFn): string => {
  const value = raw.toLowerCase();
  if (value.includes('staged files outside this task')) {
    return t(
      'implement.errors.foreignStagedFilesShort',
      'Some staged files do not belong to this task. Unstage them first.'
    );
  }
  return raw;
};

interface FolderTreeItemProps {
  repositoryId: string;
  node: FolderNode;
  depth: number;
  selectedChangeId: string | null;
  onFileClick: (changeId: string) => void;
  onStageChanges: (changeIds: string[]) => void;
  onRevert: (changeIds: string[], scopeLabel: string, requiresConfirm: boolean) => void;
  labels: {
    staged: string;
    validate: string;
    revert: string;
  };
}

interface ScopeActionRailProps {
  onValidate: () => void;
  onRevert?: () => void;
  labels: {
    staged: string;
    validate: string;
    revert: string;
  };
  className?: string;
}

const ScopeActionRail: React.FC<ScopeActionRailProps> = ({
  onValidate,
  onRevert,
  labels,
  className,
}) => (
  <div
    className={cn(
      'absolute inset-y-0 right-0 z-20 flex items-center gap-1 pr-1 pl-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
      'bg-transparent',
      className
    )}
  >
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 w-7 px-0"
      title={labels.validate}
      aria-label={labels.validate}
      onClick={(event) => {
        event.stopPropagation();
        onValidate();
      }}
    >
      <Icon name="check" size={14} />
    </Button>
    {onRevert && (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 px-0"
        title={labels.revert}
        aria-label={labels.revert}
        onClick={(event) => {
          event.stopPropagation();
          onRevert();
        }}
      >
        <Icon name="undo-2" size={14} />
      </Button>
    )}
  </div>
);

const FolderTreeItem: React.FC<FolderTreeItemProps> = ({
  repositoryId,
  node,
  depth,
  selectedChangeId,
  onFileClick,
  onStageChanges,
  onRevert,
  labels,
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const hasPendingValidation = node.hasPendingVisibleChanges;

  if (node.type === 'folder') {
    return (
      <div>
        <div
          className="group relative rounded transition-colors hover:bg-accent/50"
          style={{ marginLeft: `${depth * 12}px` }}
        >
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="flex min-w-0 w-full appearance-none items-center gap-2 border-0 bg-transparent px-2 py-1.5 pr-2 text-left outline-none"
          >
            <Icon
              name={isOpen ? 'chevron-down' : 'chevron-right'}
              size={12}
              className="text-muted-foreground shrink-0"
            />
            <Icon
              name={isOpen ? 'folder-open' : 'folder'}
              size={14}
              className="text-primary/80 shrink-0"
            />
            <span className="text-sm text-foreground truncate">{node.name}</span>
            {!isOpen && hasPendingValidation && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-primary ring-2 ring-primary/15 transition-opacity group-hover:opacity-0" />
            )}
          </button>
          <ScopeActionRail
            onValidate={() => onStageChanges(node.changeIds)}
            onRevert={() => onRevert(node.changeIds, node.path, true)}
            labels={labels}
            className="rounded-r"
          />
        </div>
        {isOpen && node.children && (
          <div>
            {node.children.map((child) => (
              <FolderTreeItem
                repositoryId={repositoryId}
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedChangeId={selectedChangeId}
                onFileClick={onFileClick}
                onStageChanges={onStageChanges}
                onRevert={onRevert}
                labels={labels}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const change = node.fileChange;
  if (!change) return null;

  const isSelected = selectedChangeId === change.id;

  return (
    <div
      className={cn(
        'group relative rounded-lg transition-all overflow-hidden',
        isSelected
          ? 'bg-primary/[0.035]'
          : 'bg-primary/[0.035] hover:bg-primary/[0.06]'
      )}
      style={{ marginLeft: `${depth * 12}px` }}
    >
      <button
        type="button"
        onClick={() => onFileClick(change.id)}
        className="flex min-w-0 w-full appearance-none items-center gap-2 border-0 bg-transparent px-2 py-1.5 pr-2 text-left outline-none"
      >
        <span
          className={cn(
            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold font-mono',
            STATUS_BG[change.status]
          )}
        >
          <span className={STATUS_COLORS[change.status]}>{STATUS_MARKERS[change.status]}</span>
        </span>

        <span className="text-sm text-foreground truncate flex-1 text-left">{node.name}</span>

        <span className="h-2 w-2 shrink-0 rounded-full bg-primary ring-2 ring-primary/15 transition-opacity group-hover:opacity-0" />

        <div className="flex items-center gap-1 text-[11px] shrink-0 opacity-60 transition-opacity group-hover:opacity-0">
          {change.hasValidatedStage && (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
              {labels.staged}
            </span>
          )}
          {change.additions > 0 && (
            <span className="text-primary font-mono">+{change.additions}</span>
          )}
          {change.deletions > 0 && (
            <span className="text-destructive font-mono">-{change.deletions}</span>
          )}
        </div>
      </button>
      <ScopeActionRail
        onValidate={() => onStageChanges([change.id])}
        onRevert={() => onRevert([change.id], change.path, false)}
        labels={labels}
        className="rounded-r-lg"
      />
    </div>
  );
};

const renderRepositoryState = (
  repository: ReviewRepositoryState,
  repositorySummary: ReviewRepositorySummary | undefined,
  t: TranslateFn
): string => {
  if (repositorySummary?.isCommitting) {
    return t('implement.commitInProgress', 'Committing changes...');
  }
  if (repositorySummary?.state === 'committed') {
    return t('implement.repositoryCommitted', 'Committed');
  }
  if (repositorySummary?.state === 'no_changes') {
    return t('implement.repositoryNoChanges', 'No changes');
  }
  if (repositorySummary?.hasPendingVisibleChanges && repositorySummary?.hasValidatedStagedChanges) {
    return t(
      'implement.repositoryPendingAndReady',
      '{{pending}} pending, {{validated}} ready',
      {
        pending: repositorySummary.pendingVisibleFileCount,
        validated: repositorySummary.validatedStagedFileCount,
      }
    );
  }
  if (repositorySummary?.hasValidatedStagedChanges) {
    return t('implement.repositoryReadyToCommit', 'Ready to commit');
  }
  if (repository.commitState === 'committed') {
    return t('implement.repositoryCommitted', 'Committed');
  }
  if (repository.commitState === 'no_changes') {
    return t('implement.repositoryNoChanges', 'No changes');
  }
  return t('implement.repositoryValidationProgress', '{{pending}} pending', {
    pending: repository.stats.pendingVisibleFileCount,
    total: repository.stats.pendingVisibleFileCount,
  });
};

const FileChangesPanelBase: React.FC<FileChangesPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const translate: TranslateFn = (key, fallback, options) =>
    String(t(key, { defaultValue: fallback, ...(options || {}) }));
  const serviceRuntimeCapabilities = getServiceRuntimeCapabilities();
  const isReadOnlyRemoteMode = !serviceRuntimeCapabilities.taskMutation;
  const { selectedGroupId, selectedProjectId, selectedTaskId, getProjectById } = useAppStore();
  const currentTask = useTaskStore((state) =>
    selectedTaskId ? state.tasks.find((task) => task.id === selectedTaskId) ?? null : null
  );
  const selectedTaskWorktreeKey = useTaskStore((state) => {
    if (!selectedTaskId) return '';
    const task = state.tasks.find((candidate) => candidate.id === selectedTaskId);
    if (!task?.execution_targets?.length) return '';
    return task.execution_targets
      .map((target) => `${target.worktreeKey}:${state.branchWorktrees[target.worktreeKey] ?? ''}`)
      .join('|');
  });
  const finishTask = useTaskStore((state) => state.finishTask);
  const [expandedRepositoryIds, setExpandedRepositoryIds] = useState<Record<string, boolean>>({});
  const [pendingRevertScope, setPendingRevertScope] = useState<{
    repositoryId: string;
    changeIds: string[];
    scopeLabel: string;
  } | null>(null);
  const {
    repositories,
    reviewSummary,
    currentTaskLoadState,
    currentTaskLoadMessage,
    selectedRepositoryId,
    selectedDiffTarget,
    isDiffModalOpen,
    isLoading,
    isCommitting,
    lastError,
    executionRecords,
    loadCurrentChanges,
    resetReviewState,
    selectRepository,
    openDiffModal,
    closeDiffModal,
    stageChanges,
    stageAllChanges,
    revertChanges,
    commitStagedChanges,
    setCommitMessageDraft,
    getOverallStats,
  } = useFileChangesStore();
  const hasRepositoryScope = Boolean(selectedGroupId || selectedProjectId);
  const isPlanFinalizationTask = isPlanFinalizationTaskSource(currentTask?.task_source);

  useEffect(() => {
    if (isReadOnlyRemoteMode) {
      resetReviewState();
      return;
    }
    if (!hasRepositoryScope || !selectedTaskId || isPlanFinalizationTask) {
      resetReviewState();
      return;
    }
    if (isDiffModalOpen) {
      return;
    }
    void loadCurrentChanges();
  }, [
    currentTask?.status,
    isDiffModalOpen,
    loadCurrentChanges,
    hasRepositoryScope,
    isPlanFinalizationTask,
    resetReviewState,
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    selectedTaskWorktreeKey,
    isReadOnlyRemoteMode,
  ]);

  useEffect(() => {
    if (isReadOnlyRemoteMode) {
      return;
    }
    if (!hasRepositoryScope || !selectedTaskId || isPlanFinalizationTask) {
      return;
    }
    if (isDiffModalOpen) {
      return;
    }

    let disposed = false;
    let refreshInFlight = false;
    let timeoutId: number | null = null;

    const refreshChanges = async (silent: boolean = true) => {
      if (disposed || refreshInFlight || isCommitting) {
        return;
      }

      refreshInFlight = true;
      try {
        await loadCurrentChanges({ silent });
      } finally {
        refreshInFlight = false;
      }
    };

    const scheduleRefresh = (delayMs: number) => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }

      timeoutId = window.setTimeout(() => {
        if (disposed) {
          return;
        }

        if (document.visibilityState === 'visible') {
          void refreshChanges();
          scheduleRefresh(CHANGE_PANEL_POLL_INTERVAL_MS);
          return;
        }

        scheduleRefresh(CHANGE_PANEL_HIDDEN_POLL_INTERVAL_MS);
      }, delayMs);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshChanges();
      }
      scheduleRefresh(
        document.visibilityState === 'visible'
          ? CHANGE_PANEL_POLL_INTERVAL_MS
          : CHANGE_PANEL_HIDDEN_POLL_INTERVAL_MS
      );
    };

    scheduleRefresh(CHANGE_PANEL_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    hasRepositoryScope,
    isCommitting,
    isDiffModalOpen,
    isPlanFinalizationTask,
    loadCurrentChanges,
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    isReadOnlyRemoteMode,
  ]);

  useEffect(() => {
    if (repositories.length === 0) return;
    setExpandedRepositoryIds((current) => {
      const next = { ...current };
      repositories.forEach((repository) => {
        if (next[repository.id] !== undefined) return;
        next[repository.id] =
          repositories.length === 1 ||
          repository.id === selectedRepositoryId ||
          repository.id === reviewSummary.nextRepositoryId;
      });
      return next;
    });
  }, [repositories, reviewSummary.nextRepositoryId, selectedRepositoryId]);

  const repositorySummaryById = useMemo(
    () => new Map(reviewSummary.repositories.map((repository) => [repository.id, repository])),
    [reviewSummary.repositories]
  );
  const overallStats = getOverallStats();
  const actionableFileCount =
    overallStats.pendingVisibleFileCount + overallStats.validatedStagedFileCount;
  const progressPercent = actionableFileCount > 0
    ? (overallStats.validatedStagedFileCount / actionableFileCount) * 100
    : 0;
  const hasPendingValidation = reviewSummary.actionCounts.pending_validation > 0;
  const hasReadyToCommit = reviewSummary.actionCounts.ready_to_commit > 0;
  const showValidateChangesButton = currentTask !== null && currentTask.status !== 'Completed';
  const allTaskRepositoriesResolved = Boolean(
    currentTask &&
      areAllFileChangesRepositoriesResolved({
        task: currentTask,
        repositories,
        executionRecords,
        fallbackRepositoryIds: repositories.map((repository) => repository.id),
      })
  );
  const hasTaskCommittedRepositories =
    reviewSummary.hasCommittedRepositories || Object.keys(executionRecords).length > 0;
  const canFinishTask =
    !isCommitting &&
    currentTask !== null &&
    !currentTask.draft &&
    currentTask.status !== 'Completed' &&
    allTaskRepositoriesResolved &&
    reviewSummary.actionCounts.pending_validation === 0 &&
    reviewSummary.actionCounts.ready_to_commit === 0 &&
    hasTaskCommittedRepositories;
  const nextValidationRepositoryId =
    (selectedRepositoryId && repositorySummaryById.get(selectedRepositoryId)?.hasPendingVisibleChanges
      ? selectedRepositoryId
      : reviewSummary.repositories.find((repository) => repository.hasPendingVisibleChanges)?.id) || null;
  const nextCommitRepositoryId =
    (selectedRepositoryId && repositorySummaryById.get(selectedRepositoryId)?.hasValidatedStagedChanges
      ? selectedRepositoryId
      : reviewSummary.repositories.find((repository) => repository.hasValidatedStagedChanges)?.id) || null;
  const nextValidationRepository = nextValidationRepositoryId
    ? repositories.find((repository) => repository.id === nextValidationRepositoryId) ?? null
    : null;
  const nextCommitRepository = nextCommitRepositoryId
    ? repositories.find((repository) => repository.id === nextCommitRepositoryId) ?? null
    : null;
  const isValidateChangesDisabled = isCommitting || !hasPendingValidation;
  const validateChangesDisabledReason = t(
    'implement.noRemainingChangesToValidate',
    'No remaining unstaged changes to validate.'
  );
  const isCommitDisabled = isCommitting || !hasReadyToCommit;
  const commitDisabledReason = t('implement.noValidatedChangesToCommit', 'Validate changes before commit.');

  const displayError = normalizeCommitErrorMessage(
    lastError || '',
    translate
  );
  const outOfScopeMessage = currentTaskLoadState === 'out_of_scope'
    ? currentTaskLoadMessage
    : null;
  const mappingError = currentTaskLoadState === 'invalid_mapping' || currentTaskLoadState === 'awaiting_worktree'
    ? currentTaskLoadMessage
    : null;
  const handleCommit = async () => {
    if (isCommitting || !nextCommitRepository) return;
    const commitMessage = nextCommitRepository.commitMessageDraft;
    setCommitMessageDraft(nextCommitRepository.id, commitMessage);

    try {
      const result = await commitStagedChanges(nextCommitRepository.id, commitMessage);
      notify.success(
        t('implement.repositoryCommitSuccess', 'Committed {{hash}} for this repository.', {
          hash: result.hash,
        })
      );
    } catch (error) {
      const messageText = toServiceError(error).message;
      notify.error(
        normalizeCommitErrorMessage(
          messageText || t('implement.commitFailed', 'Failed to commit changes'),
          translate
        )
      );
    }
  };

  const handleValidateChanges = async () => {
    if (!nextValidationRepository) return;
    selectRepository(nextValidationRepository.id);
    try {
      await stageAllChanges(nextValidationRepository.id);
      notify.success(t('implement.validateChangesSuccess', 'Changes validated and staged.'));
    } catch (error) {
      notify.error(
        toServiceError(error).message ||
          t('implement.validateChangesFailed', 'Failed to validate and stage changes.')
      );
    }
  };

  const handleStageScope = async (repositoryId: string, changeIds: string[]) => {
    if (changeIds.length === 0) return;
    try {
      await stageChanges(repositoryId, changeIds);
      notify.success(t('implement.validateChangesSuccess', 'Changes validated and staged.'));
    } catch (error) {
      notify.error(
        toServiceError(error).message ||
          t('implement.validateChangesFailed', 'Failed to validate and stage changes.')
      );
    }
  };

  const handleRevert = async (repositoryId: string, changeIds: string[]) => {
    if (changeIds.length === 0) return;
    if (isReadOnlyRemoteMode) {
      notify.error(REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE);
      return;
    }
    try {
      await revertChanges(repositoryId, changeIds);
      notify.success(t('implement.revertSuccess', 'Changes reverted.'));
    } catch (error) {
      const messageText = toServiceError(error).message;
      notify.error(messageText || t('implement.revertFailed', 'Failed to revert changes.'));
    }
  };

  const handleOpenCommit = () => {
    if (!nextCommitRepository) return;
    if (isReadOnlyRemoteMode) {
      notify.error(REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE);
      return;
    }
    selectRepository(nextCommitRepository.id);
    void handleCommit();
  };

  const handleFinishTask = async () => {
    if (!currentTask || isCommitting) return;
    try {
      await finishTask(currentTask.id);
      resetReviewState();
      notify.success(t('implement.taskFinished', 'Task finished'), {
        category: 'task_completed',
      });
    } catch (error) {
      const messageText = toServiceError(error).message;
      notify.error(messageText || t('implement.completeTaskFailed', 'Failed to complete task'));
    }
  };
  const primaryAction = canFinishTask
    ? {
        onClick: () => void handleFinishTask(),
        disabled: false,
        title: undefined,
        icon: 'git-merge' as const,
        label: t('implement.finishTask', 'Finish task'),
      }
    : {
        onClick: handleOpenCommit,
        disabled: isCommitDisabled,
        title: isCommitDisabled ? commitDisabledReason : undefined,
        icon: 'git-commit' as const,
        label: t('implement.commitChangesGeneric', 'Commit'),
      };

  const actionLabels = {
    staged: t('implement.stagedBadge', 'Staged'),
    validate: t('implement.validateAction', 'Validate'),
    revert: t('implement.revertAction', 'Revert'),
  };

  if (!hasRepositoryScope) {
    return (
      <aside
        className={cn(
          'h-full w-full bg-card border-l border-border flex items-center justify-center',
          className
        )}
      >
        <div className="text-center px-6">
          <Icon name="folder-git-2" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">
            {t('implement.selectProject', 'Select a project to view changes')}
          </p>
        </div>
      </aside>
    );
  }

  if (!selectedTaskId) {
    return (
      <aside
        className={cn(
          'h-full w-full bg-card border-l border-border flex items-center justify-center',
          className
        )}
      >
        <div className="text-center px-6">
          <Icon name="git-compare" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">
            {t('implement.selectTaskForValidation', 'Select a task to validate changes')}
          </p>
        </div>
      </aside>
    );
  }

  if (isReadOnlyRemoteMode) {
    return (
      <aside
        className={cn(
          'h-full w-full bg-card border-l border-border flex items-center justify-center',
          className
        )}
      >
        <div className="text-center px-6 max-w-sm">
          <Icon name="lock" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-foreground text-sm font-medium">
            {t(
              'implement.remoteValidationUnavailable',
              'Local validation is not available in remote mode yet.'
            )}
          </p>
          <p className="mt-2 text-muted-foreground text-sm">
            {REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE}
          </p>
        </div>
      </aside>
    );
  }

  if (currentTask && isPlanFinalizationTask) {
    return <PlanFinalizationTaskPanel task={currentTask} className={className} />;
  }

  return (
    <aside className={cn('h-full w-full bg-card border-l border-border flex flex-col', className)}>
      <div className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="folder-git-2" size={16} className="text-primary" />
          {t('implement.changesValidationPanel', 'Changes')}
        </h1>
      </div>

      <div className="px-4 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {overallStats.validatedStagedFileCount > 0 && overallStats.pendingVisibleFileCount > 0
              ? t('implement.overallPendingAndReadyCompact', '{{ready}} ready, {{pending}} pending', {
                  ready: overallStats.validatedStagedFileCount,
                  pending: overallStats.pendingVisibleFileCount,
                })
              : overallStats.validatedStagedFileCount > 0
                ? t('implement.overallReadyCompact', '{{ready}} ready', {
                    ready: overallStats.validatedStagedFileCount,
                  })
                : t('implement.overallPendingCompact', '{{pending}} pending', {
                    pending: overallStats.pendingVisibleFileCount,
                  })}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {isLoading && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('implement.loadingRepositoryChanges', 'Loading repository changes...')}
          </div>
        )}
        {!isLoading && mappingError && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {mappingError}
          </div>
        )}
        {!isLoading && !mappingError && !displayError && outOfScopeMessage && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {outOfScopeMessage}
          </div>
        )}
        {!isLoading && displayError && (
          <div className="px-4 py-8 text-center text-sm text-destructive">
            {displayError}
          </div>
        )}
        {!isLoading && !mappingError && !displayError && !outOfScopeMessage && repositories.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('implement.noPendingChanges', 'No pending file changes for this task yet.')}
          </div>
        )}
        {!isLoading && !mappingError && !displayError && repositories.map((repository) => {
          const project = getProjectById(repository.projectId);
          const repositorySummary = repositorySummaryById.get(repository.id);
          const isExpanded =
            expandedRepositoryIds[repository.id] ??
            (
              repositories.length === 1 ||
              repository.id === selectedRepositoryId ||
              repositorySummary?.isNextAction ||
              false
            );
          const folderTree = buildFolderTree(repository.changes || []);
          const repositoryError = normalizeCommitErrorMessage(repository.lastError || '', translate);
          const repositoryName = getRepositoryDisplayName(repository, project?.name);
          const repositoryHasPendingValidation =
            repository.commitState === 'idle' && repository.stats.pendingVisibleFileCount > 0;
          const repositoryChangeIds = repository.changes.map((change) => change.id);
          return (
            <section
              key={repository.id}
              className="mx-2 mb-1"
            >
              <div
                className={cn(
                  'group relative w-full rounded-xl px-3 py-2.5 transition-colors overflow-hidden',
                  repository.id === selectedRepositoryId || isExpanded
                    ? 'bg-primary/5'
                    : 'bg-card hover:bg-accent/40'
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      selectRepository(repository.id);
                      setExpandedRepositoryIds((current) => ({
                        ...current,
                        [repository.id]: !(
                          current[repository.id] ??
                          (repositories.length === 1 ||
                            repository.id === selectedRepositoryId ||
                            repository.id === reviewSummary.nextRepositoryId)
                        ),
                      }));
                    }}
                    className="min-w-0 flex flex-1 appearance-none items-center gap-2 border-0 bg-transparent text-left outline-none"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon
                        name={isExpanded ? 'chevron-down' : 'chevron-right'}
                        size={14}
                        className="text-muted-foreground shrink-0"
                      />
                      <Icon
                        name={isExpanded ? 'folder-open' : 'folder'}
                        size={15}
                        className="shrink-0 text-primary/80"
                      />
                      <span className="text-sm font-medium text-foreground truncate">
                        {repositoryName}
                      </span>
                      {!isExpanded && repositoryHasPendingValidation && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-primary ring-2 ring-primary/15 transition-opacity group-hover:opacity-0" />
                      )}
                      {repositorySummary?.isNextAction && !repositorySummary.isSelected && (
                        <span className="px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px]">
                          {t('implement.nextRepository', 'Next')}
                        </span>
                      )}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {repositorySummary && (
                      <span className={cn('px-2 py-0.5 rounded-full text-[10px] shrink-0 transition-opacity group-hover:opacity-0', REVIEW_STATE_CLASSES[repositorySummary.state])}>
                        {renderRepositoryState(repository, repositorySummary, translate)}
                      </span>
                    )}
                  </div>
                </div>
                {repository.commitState === 'idle' && repositoryChangeIds.length > 0 && (
                  <ScopeActionRail
                    onValidate={() => void handleStageScope(repository.id, repositoryChangeIds)}
                    onRevert={() => setPendingRevertScope({
                      repositoryId: repository.id,
                      changeIds: repositoryChangeIds,
                      scopeLabel: repositoryName,
                    })}
                    labels={actionLabels}
                    className="rounded-r-xl"
                  />
                )}
              </div>

              {isExpanded && (
                <div className="ml-3 mr-3 mb-3">
                  <div className="max-h-[320px] overflow-y-auto py-1">
                    {repositoryError && (
                      <div className="px-2 py-8 text-center text-sm text-destructive">
                        {repositoryError}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'committed' && (
                      <div className="px-2 py-8 text-center text-sm text-primary">
                        {t('implement.repositoryCommittedHelp', 'This repository has already been committed for this task.')}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'no_changes' && (
                      <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                        {t('implement.repositoryNoChangesHelp', 'No pending file changes for this repository.')}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'idle' && repository.stats.validatedStagedFileCount > 0 && (
                      <div className="px-2 pb-2 text-xs text-muted-foreground">
                        {t(
                          'implement.repositoryStagedSummary',
                          '{{count}} validated file(s) staged and ready to commit.',
                          { count: repository.stats.validatedStagedFileCount }
                        )}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'idle' && folderTree.length === 0 && (
                      <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                        {repository.stats.validatedStagedFileCount > 0
                          ? t(
                              'implement.repositoryOnlyStagedChanges',
                              'All visible changes are already validated. Commit when you are ready.'
                            )
                          : t('implement.noPendingChanges', 'No pending file changes for this repository.')}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'idle' && folderTree.map((node) => (
                      <FolderTreeItem
                        repositoryId={repository.id}
                        key={node.path}
                        node={node}
                        depth={0}
                        selectedChangeId={repository.selectedChangeId}
                        onFileClick={(changeId) => {
                          selectRepository(repository.id);
                          openDiffModal(repository.id, changeId);
                        }}
                        onStageChanges={(changeIds) => {
                          selectRepository(repository.id);
                          void handleStageScope(repository.id, changeIds);
                        }}
                        onRevert={(changeIds, scopeLabel, requiresConfirm) => {
                          selectRepository(repository.id);
                          if (requiresConfirm) {
                            setPendingRevertScope({
                              repositoryId: repository.id,
                              changeIds,
                              scopeLabel,
                            });
                            return;
                          }
                          void handleRevert(repository.id, changeIds);
                        }}
                        labels={actionLabels}
                      />
                    ))}
                  </div>

                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="p-3 border-t border-border shrink-0 space-y-2">
        {showValidateChangesButton && (
          <button
            onClick={handleValidateChanges}
            disabled={isValidateChangesDisabled}
            title={isValidateChangesDisabled ? validateChangesDisabledReason : undefined}
            className={cn(
              'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
              isValidateChangesDisabled
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            <Icon name="check-circle" size={14} />
            {t('implement.validateChanges', 'Validate changes')}
          </button>
        )}
        <button
          onClick={primaryAction.onClick}
          disabled={primaryAction.disabled}
          title={primaryAction.title}
          className={cn(
            'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
            primaryAction.disabled
              ? 'bg-muted text-muted-foreground cursor-not-allowed'
              : 'bg-primary text-primary-foreground hover:bg-primary/90'
          )}
        >
          <Icon name={primaryAction.icon} size={14} />
          {primaryAction.label}
        </button>
      </div>

      {isDiffModalOpen && selectedDiffTarget && (
        <FileChangesDiffModal
          onClose={closeDiffModal}
        />
      )}

      {pendingRevertScope && (
        <ConfirmPromptModal
          isOpen={true}
          title={t('implement.revertScopeTitle', 'Revert these changes?')}
          description={t(
            'implement.revertScopeDescription',
            'This will discard the local changes for "{{scope}}".',
            { scope: pendingRevertScope.scopeLabel }
          )}
          confirmLabel={t('implement.revertAction', 'Revert')}
          cancelLabel={t('common.cancel', 'Cancel')}
          confirmVariant="error"
          onCancel={() => setPendingRevertScope(null)}
          onConfirm={() => {
            const scope = pendingRevertScope;
            setPendingRevertScope(null);
            void handleRevert(scope.repositoryId, scope.changeIds);
          }}
        />
      )}
    </aside>
  );
};

export const FileChangesPanel = React.memo(FileChangesPanelBase);

export default FileChangesPanel;
