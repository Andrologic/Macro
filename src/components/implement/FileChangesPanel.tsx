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
  canRequestTaskChangesFromReview,
  type ReviewRepositorySummary,
  type ReviewRepositoryUiState,
} from '../../services/implementMultiRepoSummary';
import { Icon, type IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { toast } from '../ui/Toaster';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { FileChangesDiffModal } from '../modals/FileChangesDiffModal';

interface FileChangesPanelProps {
  className?: string;
}

type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

const STATUS_COLORS = {
  added: 'text-emerald-500',
  modified: 'text-amber-500',
  deleted: 'text-red-500',
};

const STATUS_BG = {
  added: 'bg-emerald-500/10',
  modified: 'bg-amber-500/10',
  deleted: 'bg-red-500/10',
};

const STATUS_ICONS: Record<string, IconName> = {
  added: 'plus',
  modified: 'edit',
  deleted: 'trash',
};

const REVIEW_STATE_CLASSES: Record<ReviewRepositoryUiState, string> = {
  pending_review: 'bg-amber-500/10 text-amber-500',
  ready_to_commit: 'bg-sky-500/10 text-sky-400',
  committed: 'bg-emerald-500/10 text-emerald-500',
  no_changes: 'bg-muted text-muted-foreground',
};

const getRepositoryPathTail = (repoPath: string | null | undefined, fallback: string): string => {
  const normalized = (repoPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || fallback;
};

const normalizeCommitErrorMessage = (raw: string, t: TranslateFn): string => {
  const value = raw.toLowerCase();
  if (value.includes('staged files outside this task')) {
    return t(
      'implement.errors.foreignStagedFilesShort',
      'Some staged files do not belong to this task. Unstage them first.'
    );
  }
  if (value.includes('review all file changes')) {
    return t('implement.commitNeedsReview', 'Review all file changes before committing this task.');
  }
  if (value.includes('must be in review before commit')) {
    return t(
      'implement.commitRequiresActiveTaskStatus',
      'Task must be in review before commit.'
    );
  }
  return raw;
};

interface FolderTreeItemProps {
  node: FolderNode;
  depth: number;
  selectedChangeId: string | null;
  onFileClick: (changeId: string) => void;
}

const FolderTreeItem: React.FC<FolderTreeItemProps> = ({ node, depth, selectedChangeId, onFileClick }) => {
  const [isOpen, setIsOpen] = useState(true);

  if (node.type === 'folder') {
    return (
      <div>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-accent/50 rounded transition-colors group"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <Icon
            name={isOpen ? 'chevron-down' : 'chevron-right'}
            size={12}
            className="text-muted-foreground shrink-0"
          />
          <Icon
            name={isOpen ? 'folder-open' : 'folder'}
            size={14}
            className="text-amber-500/80 shrink-0"
          />
          <span className="text-sm text-foreground truncate">{node.name}</span>
        </button>
        {isOpen && node.children && (
          <div>
            {node.children.map((child) => (
              <FolderTreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedChangeId={selectedChangeId}
                onFileClick={onFileClick}
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
    <button
      onClick={() => onFileClick(change.id)}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-1.5 rounded transition-all group',
        isSelected
          ? 'bg-primary/10 border-l-2 border-primary'
          : 'hover:bg-accent/50 border-l-2 border-transparent'
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <div
        className={cn(
          'w-5 h-5 rounded flex items-center justify-center shrink-0',
          STATUS_BG[change.status]
        )}
      >
        <Icon name={STATUS_ICONS[change.status]} size={10} className={STATUS_COLORS[change.status]} />
      </div>

      <span className="text-sm text-foreground truncate flex-1 text-left">{node.name}</span>

      {change.reviewed && (
        <Icon name="check" size={12} className="text-emerald-500 shrink-0" />
      )}

      <div className="flex items-center gap-1 text-xs shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        {change.additions > 0 && (
          <span className="text-emerald-500 font-mono">+{change.additions}</span>
        )}
        {change.deletions > 0 && (
          <span className="text-red-400 font-mono">-{change.deletions}</span>
        )}
      </div>
    </button>
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
  if (repositorySummary?.state === 'ready_to_commit') {
    return t('implement.repositoryReadyToCommit', 'Ready to commit');
  }
  if (repository.commitState === 'committed') {
    return t('implement.repositoryCommitted', 'Committed');
  }
  if (repository.commitState === 'no_changes') {
    return t('implement.repositoryNoChanges', 'No changes');
  }
  return t('implement.repositoryReviewProgress', '{{reviewed}}/{{total}} reviewed', {
    reviewed: repository.stats.reviewed,
    total: repository.stats.total,
  });
};

const describeReviewNextAction = (
  reviewSummary: ReturnType<typeof useFileChangesStore.getState>['reviewSummary'],
  repositories: ReviewRepositoryState[],
  getProjectById: ReturnType<typeof useAppStore.getState>['getProjectById'],
  t: TranslateFn
): string => {
  const nextRepository = reviewSummary.nextRepositoryId
    ? repositories.find((repository) => repository.id === reviewSummary.nextRepositoryId) ?? null
    : null;
  const nextRepositoryLabel = nextRepository
    ? getProjectById(nextRepository.projectId)?.name ||
      getRepositoryPathTail(nextRepository.repoPath, nextRepository.projectId)
    : null;

  if (reviewSummary.nextAction === 'commit_repository' && nextRepositoryLabel) {
    return t('implement.nextActionCommitRepository', 'Next: commit {{repository}}', {
      repository: nextRepositoryLabel,
    });
  }
  if (reviewSummary.nextAction === 'review_repository' && nextRepositoryLabel) {
    return t('implement.nextActionReviewRepository', 'Next: review {{repository}}', {
      repository: nextRepositoryLabel,
    });
  }
  if (reviewSummary.nextAction === 'complete_without_code_changes') {
    return t(
      'implement.nextActionCompleteWithoutCodeChanges',
      'Next: complete the task without code changes.'
    );
  }
  if (reviewSummary.nextAction === 'complete_task') {
    return t('implement.nextActionCompleteTask', 'Next: task completion will finalize automatically.');
  }
  return t('implement.reviewOverviewIdle', 'Review each repository until every one is resolved.');
};

const FileChangesPanelBase: React.FC<FileChangesPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const translate: TranslateFn = (key, fallback, options) =>
    String(t(key, { defaultValue: fallback, ...(options || {}) }));
  const { selectedGroupId, selectedTaskId, getProjectById } = useAppStore();
  const currentTask = useTaskStore((state) =>
    selectedTaskId ? state.tasks.find((task) => task.id === selectedTaskId) ?? null : null
  );
  const startReview = useTaskStore((state) => state.startReview);
  const requestTaskChanges = useTaskStore((state) => state.requestTaskChanges);
  const completeTask = useTaskStore((state) => state.completeTask);
  const [commitTargetRepositoryId, setCommitTargetRepositoryId] = useState<string | null>(null);
  const [expandedRepositoryIds, setExpandedRepositoryIds] = useState<Record<string, boolean>>({});
  const {
    repositories,
    reviewSummary,
    selectedRepositoryId,
    selectedDiffTarget,
    isDiffModalOpen,
    isLoading,
    isCommitting,
    lastError,
    loadCurrentChanges,
    resetReviewState,
    selectRepository,
    openDiffModal,
    closeDiffModal,
    markAllAsReviewed,
    commitReviewedChanges,
    setCommitMessageDraft,
    getOverallStats,
  } = useFileChangesStore();

  useEffect(() => {
    if (!selectedGroupId || !selectedTaskId) return;
    void loadCurrentChanges();
  }, [selectedGroupId, selectedTaskId, loadCurrentChanges]);

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
  const progressPercent = overallStats.total > 0 ? (overallStats.reviewed / overallStats.total) * 100 : 0;
  const canCommitTaskStatus = currentTask?.status === 'InReview';
  const canStartReview = currentTask?.status === 'InProgress' || currentTask?.status === 'AwaitingResponse';
  const canShowRequestChanges = currentTask?.status === 'InReview';
  const canRequestChanges =
    currentTask?.status === 'InReview' && canRequestTaskChangesFromReview(reviewSummary);
  const allRepositoriesNoChanges = repositories.length > 0 && repositories.every(
    (repository) => repository.commitState === 'no_changes'
  );
  const canCompleteWithoutCodeChanges =
    currentTask?.status === 'InReview' &&
    allRepositoriesNoChanges &&
    !isCommitting;
  const resolvedRepositoryCount =
    reviewSummary.stateCounts.committed + reviewSummary.stateCounts.no_changes;
  const requestChangesDisabledReason =
    currentTask?.status === 'InReview' && !canRequestChanges
      ? t(
        'implement.requestChangesBlockedAfterRepositoryCommit',
        'A repository has already been committed for this task. Finish the remaining repositories instead of reopening implementation.'
      )
      : '';

  const currentTaskStatusLabel = currentTask
    ? {
      Pending: t('tasks.pending', 'Pending'),
      InProgress: t('tasks.inProgress', 'In Progress'),
      AwaitingResponse: t('implement.awaitingResponse', 'Awaiting response'),
      InReview: t('implement.inReview', 'In Review'),
      Completed: t('tasks.completed', 'Completed'),
      Failed: t('implement.failed', 'Failed'),
      Blocked: t('tasks.blocked', 'Blocked'),
    }[currentTask.status]
    : null;

  const getCommitDisabledReason = (repository: ReviewRepositoryState): string => {
    if (isCommitting) {
      return t('implement.commitInProgress', 'Committing changes...');
    }
    if (!canCommitTaskStatus) {
      return t(
        'implement.commitRequiresActiveTaskStatus',
        'Task must be in review before commit.'
      );
    }
    if (repository.commitState === 'committed') {
      return t('implement.repositoryAlreadyCommitted', 'This repository has already been committed.');
    }
    if (repository.commitState === 'no_changes' || repository.stats.total === 0) {
      return t('implement.commitNoChanges', 'No file changes available for this repository.');
    }
    if (repository.stats.reviewed < repository.stats.total) {
      return t(
        'implement.commitNeedsReview',
        'Review all file changes before committing this task.'
      );
    }
    return '';
  };

  const displayError = normalizeCommitErrorMessage(
    lastError || '',
    translate
  );
  const commitTargetRepository = commitTargetRepositoryId
    ? repositories.find((repository) => repository.id === commitTargetRepositoryId) ?? null
    : null;

  const handleCommitConfirm = async (message?: string) => {
    if (isCommitting || !commitTargetRepositoryId || !commitTargetRepository) return;
    const commitMessage = (message || '').trim() || commitTargetRepository.commitMessageDraft;
    setCommitMessageDraft(commitTargetRepositoryId, commitMessage);

    try {
      const result = await commitReviewedChanges(commitTargetRepositoryId, commitMessage);
      if (result.taskCompleted) {
        toast.success(
          t('implement.commitSuccess', 'Committed {{hash}} and marked task complete', {
            hash: result.hash,
          })
        );
      } else {
        toast.success(
          t('implement.repositoryCommitSuccess', 'Committed {{hash}} for this repository.', {
            hash: result.hash,
          })
        );
      }
      setCommitTargetRepositoryId(null);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      toast.error(messageText || t('implement.commitFailed', 'Failed to commit changes'));
    }
  };

  const handleStartReview = async () => {
    if (!currentTask || isCommitting) return;
    try {
      await startReview(currentTask.id);
      await loadCurrentChanges();
      toast.success(t('implement.reviewStarted', 'Task moved to review'));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      toast.error(messageText || t('implement.reviewStartFailed', 'Failed to start review'));
    }
  };

  const handleRequestChanges = async () => {
    if (!currentTask || isCommitting) return;
    if (!canRequestTaskChangesFromReview(reviewSummary)) {
      toast.error(requestChangesDisabledReason);
      return;
    }
    try {
      await requestTaskChanges(currentTask.id);
      resetReviewState();
      toast.success(t('implement.requestChangesSuccess', 'Task moved back to implementation'));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      toast.error(messageText || t('implement.requestChangesFailed', 'Failed to request changes'));
    }
  };

  const handleCompleteWithoutCodeChanges = async () => {
    if (!currentTask || isCommitting) return;
    const confirmed = window.confirm(
      t(
        'implement.completeWithoutCodeChangesConfirm',
        'Complete "{{title}}" without code changes?',
        { title: currentTask.title }
      )
    );
    if (!confirmed) return;

    try {
      await completeTask(currentTask.id, { allowWithoutCodeChanges: true });
      resetReviewState();
      toast.success(t('implement.completeWithoutCodeChangesSuccess', 'Task completed without code changes'));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      toast.error(messageText || t('implement.completeWithoutCodeChangesFailed', 'Failed to complete task'));
    }
  };

  if (!selectedGroupId) {
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
            {t('implement.selectProject', 'Select a global project to view changes')}
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
            {t('implement.selectTask', 'Select a task to review changes')}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={cn('h-full w-full bg-card border-l border-border flex flex-col', className)}>
      <div className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="git-compare" size={16} className="text-primary" />
          {t('implement.changesReview', 'Changes Review')}
        </h1>
        <div className="flex items-center gap-2">
          {currentTask && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {t('implement.taskStatusLabel', 'Task: {{status}}', { status: currentTaskStatusLabel })}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {overallStats.reviewed}/{overallStats.total} reviewed
          </span>
        </div>
      </div>

      {reviewSummary.repositoryCount > 0 && (
        <div className="px-4 py-3 border-b border-border bg-muted/10 shrink-0">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                {t('implement.repositoryResolutionProgress', '{{resolved}}/{{total}} repositories resolved', {
                  resolved: resolvedRepositoryCount,
                  total: reviewSummary.repositoryCount,
                })}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {describeReviewNextAction(reviewSummary, repositories, getProjectById, translate)}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap text-[11px]">
              {reviewSummary.stateCounts.pending_review > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500">
                  {t('implement.pendingRepositoryCount', '{{count}} pending review', {
                    count: reviewSummary.stateCounts.pending_review,
                  })}
                </span>
              )}
              {reviewSummary.stateCounts.ready_to_commit > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400">
                  {t('implement.readyRepositoryCount', '{{count}} ready to commit', {
                    count: reviewSummary.stateCounts.ready_to_commit,
                  })}
                </span>
              )}
              {reviewSummary.stateCounts.committed > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500">
                  {t('implement.committedRepositoryCount', '{{count}} committed', {
                    count: reviewSummary.stateCounts.committed,
                  })}
                </span>
              )}
              {reviewSummary.stateCounts.no_changes > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {t('implement.noChangesRepositoryCount', '{{count}} no changes', {
                    count: reviewSummary.stateCounts.no_changes,
                  })}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="px-4 py-2 border-b border-border shrink-0">
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {isLoading && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('implement.loadingRepositoryChanges', 'Loading repository changes...')}
          </div>
        )}
        {!isLoading && displayError && (
          <div className="px-4 py-8 text-center text-sm text-red-500">
            {displayError}
          </div>
        )}
        {!isLoading && !displayError && repositories.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('implement.noPendingChanges', 'No pending file changes for this task yet.')}
          </div>
        )}
        {!isLoading && !displayError && repositories.map((repository) => {
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
          const commitDisabledReason = getCommitDisabledReason(repository);
          const canCommitRepository = commitDisabledReason.length === 0;

          return (
            <section
              key={repository.id}
              className={cn(
                'mx-3 mb-3 rounded-2xl border overflow-hidden',
                repository.id === selectedRepositoryId ? 'border-primary/30' : 'border-border'
              )}
            >
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
                className={cn(
                  'w-full px-4 py-3 text-left transition-colors',
                  repository.id === selectedRepositoryId ? 'bg-primary/5' : 'bg-card hover:bg-accent/40'
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Icon
                        name={isExpanded ? 'chevron-down' : 'chevron-right'}
                        size={14}
                        className="text-muted-foreground shrink-0"
                      />
                      <span className="text-sm font-medium text-foreground truncate">
                        {project?.name || repository.projectId}
                      </span>
                      {repositorySummary?.isNextAction && !repositorySummary.isSelected && (
                        <span className="px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-400 text-[10px]">
                          {t('implement.nextRepository', 'Next')}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 pl-6 text-[11px] text-muted-foreground flex flex-wrap items-center gap-3">
                      <span>{getRepositoryPathTail(repository.repoPath, repository.projectId)}</span>
                      <span className="inline-flex items-center gap-1">
                        <Icon name="git-branch" size={10} />
                        {repository.branchName}
                      </span>
                      <span>
                        {repository.stats.reviewed}/{repository.stats.total} files reviewed
                      </span>
                    </div>
                  </div>
                  {repositorySummary && (
                    <span className={cn('px-2 py-0.5 rounded-full text-[10px] shrink-0', REVIEW_STATE_CLASSES[repositorySummary.state])}>
                      {renderRepositoryState(repository, repositorySummary, translate)}
                    </span>
                  )}
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-border bg-card/80">
                  <div className="px-4 py-2 border-b border-border flex items-center justify-between bg-muted/20">
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-1.5">
                        <span className="text-emerald-500 text-sm font-mono font-semibold">
                          +{repository.stats.additions}
                        </span>
                        <span className="text-xs text-muted-foreground">lines</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-red-400 text-sm font-mono font-semibold">
                          -{repository.stats.deletions}
                        </span>
                        <span className="text-xs text-muted-foreground">lines</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Icon name="folder" size={10} />
                        {project?.name || repository.projectId}
                      </span>
                      {repositorySummary && (
                        <span className={cn('px-2 py-0.5 rounded-full', REVIEW_STATE_CLASSES[repositorySummary.state])}>
                          {renderRepositoryState(repository, repositorySummary, translate)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="max-h-[320px] overflow-y-auto py-2">
                    {repositoryError && (
                      <div className="px-4 py-8 text-center text-sm text-red-500">
                        {repositoryError}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'committed' && (
                      <div className="px-4 py-8 text-center text-sm text-emerald-500">
                        {t('implement.repositoryCommittedHelp', 'This repository has already been committed and integrated.')}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'no_changes' && (
                      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                        {t('implement.repositoryNoChangesHelp', 'No pending file changes for this repository.')}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'idle' && folderTree.length === 0 && (
                      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                        {t('implement.noPendingChanges', 'No pending file changes for this repository.')}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'idle' && folderTree.map((node) => (
                      <FolderTreeItem
                        key={node.path}
                        node={node}
                        depth={0}
                        selectedChangeId={repository.selectedChangeId}
                        onFileClick={(changeId) => {
                          selectRepository(repository.id);
                          openDiffModal(repository.id, changeId);
                        }}
                      />
                    ))}
                  </div>

                  <div className="px-4 py-3 border-t border-border flex flex-wrap items-center gap-2">
                    {repository.stats.total > 0 && repository.stats.reviewed < repository.stats.total && (
                      <button
                        onClick={() => markAllAsReviewed(repository.id)}
                        disabled={isCommitting}
                        className="px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center justify-center gap-2"
                      >
                        <Icon name="check-circle" size={14} />
                        {t('implement.markAllReviewed', 'Mark all as reviewed')}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        selectRepository(repository.id);
                        setCommitTargetRepositoryId(repository.id);
                      }}
                      disabled={!canCommitRepository}
                      title={canCommitRepository ? undefined : commitDisabledReason}
                      className={cn(
                        'px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
                        canCommitRepository
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                          : 'bg-muted text-muted-foreground cursor-not-allowed'
                      )}
                    >
                      <Icon name="git-commit" size={14} />
                      {t('implement.commitSelectedRepositoryChanges', 'Commit {{repository}}', {
                        repository: project?.name || repository.projectId,
                      })}
                    </button>
                    {!canCommitRepository && (
                      <p className="text-xs text-muted-foreground">{commitDisabledReason}</p>
                    )}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="p-3 border-t border-border shrink-0 space-y-2">
        {canStartReview && (
          <button
            onClick={() => void handleStartReview()}
            disabled={isCommitting}
            className="w-full py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center justify-center gap-2"
          >
            <Icon name="git-compare" size={14} />
            {t('implement.startReview', 'Send to review')}
          </button>
        )}
        {canShowRequestChanges && (
          <button
            onClick={() => void handleRequestChanges()}
            disabled={isCommitting || !canRequestChanges}
            title={!canRequestChanges ? requestChangesDisabledReason : undefined}
            className={cn(
              'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
              canRequestChanges && !isCommitting
                ? 'text-muted-foreground hover:text-foreground hover:bg-accent'
                : 'text-muted-foreground/60 bg-muted cursor-not-allowed'
            )}
          >
            <Icon name="rotate-ccw" size={14} />
            {t('implement.requestChanges', 'Request changes')}
          </button>
        )}
        {canCompleteWithoutCodeChanges && (
          <button
            onClick={() => void handleCompleteWithoutCodeChanges()}
            className="w-full py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center justify-center gap-2"
          >
            <Icon name="check" size={14} />
            {t('implement.completeWithoutCodeChanges', 'Complete without code changes')}
          </button>
        )}
        {!canRequestChanges && requestChangesDisabledReason && (
          <p className="text-xs text-muted-foreground">{requestChangesDisabledReason}</p>
        )}
      </div>

      {isDiffModalOpen && selectedDiffTarget && (
        <FileChangesDiffModal
          repositoryId={selectedDiffTarget.repositoryId}
          changeId={selectedDiffTarget.changeId}
          onClose={closeDiffModal}
        />
      )}

      <ConfirmPromptModal
        isOpen={!!commitTargetRepository}
        title={t('implement.commitPromptTitle', 'Commit reviewed changes')}
        description={t(
          'implement.commitPromptDescription',
          'Provide a concise commit message for this repository.'
        )}
        confirmLabel={t('implement.commitConfirm', 'Commit')}
        cancelLabel={t('common.cancel', 'Cancel')}
        initialValue={commitTargetRepository?.commitMessageDraft || ''}
        inputPlaceholder={t('implement.commitPromptPlaceholder', 'feat: update task implementation')}
        requireInput
        onCancel={() => setCommitTargetRepositoryId(null)}
        onConfirm={(value) => {
          void handleCommitConfirm(value);
        }}
      />
    </aside>
  );
};

export const FileChangesPanel = React.memo(FileChangesPanelBase);

export default FileChangesPanel;
