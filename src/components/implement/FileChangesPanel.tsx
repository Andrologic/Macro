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
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { toast } from '../ui/Toaster';
import { FileChangesDiffModal } from '../modals/FileChangesDiffModal';

interface FileChangesPanelProps {
  className?: string;
}

type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

const CHANGE_PANEL_POLL_INTERVAL_MS = 1500;

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
  pending_review: 'bg-primary/10 text-primary',
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
  if (value.includes('review all file changes')) {
    return t('implement.commitNeedsValidation', 'Validate all file changes before committing this task.');
  }
  if (value.includes('must be in review before commit')) {
    return t(
      'implement.commitRequiresValidationStage',
      'Task must be in validation before commit.'
    );
  }
  return raw;
};

interface FolderTreeItemProps {
  repositoryId: string;
  node: FolderNode;
  depth: number;
  selectedChangeId: string | null;
  invalidateTooltip: string;
  onFileClick: (changeId: string) => void;
  onFileInvalidate: (changeId: string) => void;
}

const hasPendingValidationInNode = (node: FolderNode): boolean => {
  if (node.type === 'file') {
    return node.fileChange?.reviewed !== true;
  }
  return Boolean(node.children?.some((child) => hasPendingValidationInNode(child)));
};

const FolderTreeItem: React.FC<FolderTreeItemProps> = ({
  repositoryId,
  node,
  depth,
  selectedChangeId,
  invalidateTooltip,
  onFileClick,
  onFileInvalidate,
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const hasPendingValidation = hasPendingValidationInNode(node);

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
            className="text-primary/80 shrink-0"
          />
          <span className="text-sm text-foreground truncate">{node.name}</span>
          {!isOpen && hasPendingValidation && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-primary ring-2 ring-primary/15" />
          )}
        </button>
        {isOpen && node.children && (
          <div>
            {node.children.map((child) => (
              <FolderTreeItem
                repositoryId={repositoryId}
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedChangeId={selectedChangeId}
                invalidateTooltip={invalidateTooltip}
                onFileClick={onFileClick}
                onFileInvalidate={onFileInvalidate}
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
      onContextMenu={(event) => {
        if (!change.reviewed) return;
        event.preventDefault();
        onFileInvalidate(change.id);
      }}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all group',
        isSelected
          ? 'bg-primary/8'
          : change.reviewed
            ? 'hover:bg-accent/40'
            : 'bg-primary/[0.035] hover:bg-primary/[0.06]'
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      title={change.reviewed ? invalidateTooltip : undefined}
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

      {!change.reviewed && (
        <span className="h-2 w-2 shrink-0 rounded-full bg-primary ring-2 ring-primary/15" />
      )}

      <div className="flex items-center gap-1 text-[11px] shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        {change.additions > 0 && (
          <span className="text-primary font-mono">+{change.additions}</span>
        )}
        {change.deletions > 0 && (
          <span className="text-destructive font-mono">-{change.deletions}</span>
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
  return t('implement.repositoryValidationProgress', '{{validated}}/{{total}} validated', {
    validated: repository.stats.reviewed,
    total: repository.stats.total,
  });
};

const FileChangesPanelBase: React.FC<FileChangesPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const translate: TranslateFn = (key, fallback, options) =>
    String(t(key, { defaultValue: fallback, ...(options || {}) }));
  const { selectedGroupId, selectedTaskId, getProjectById } = useAppStore();
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
  const startReview = useTaskStore((state) => state.startReview);
  const finishTask = useTaskStore((state) => state.finishTask);
  const [expandedRepositoryIds, setExpandedRepositoryIds] = useState<Record<string, boolean>>({});
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
    loadCurrentChanges,
    resetReviewState,
    selectRepository,
    openDiffModal,
    closeDiffModal,
    markAllAsReviewed,
    markAsUnreviewed,
    commitReviewedChanges,
    setCommitMessageDraft,
    getOverallStats,
  } = useFileChangesStore();

  useEffect(() => {
    if (!selectedGroupId || !selectedTaskId) {
      resetReviewState();
      return;
    }
    void loadCurrentChanges();
  }, [
    currentTask?.status,
    loadCurrentChanges,
    resetReviewState,
    selectedGroupId,
    selectedTaskId,
    selectedTaskWorktreeKey,
  ]);

  useEffect(() => {
    if (!selectedGroupId || !selectedTaskId) {
      return;
    }

    let disposed = false;
    let refreshInFlight = false;

    const refreshChanges = async () => {
      if (disposed || refreshInFlight || isCommitting) {
        return;
      }

      refreshInFlight = true;
      try {
        await loadCurrentChanges({ silent: true });
      } finally {
        refreshInFlight = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void refreshChanges();
    }, CHANGE_PANEL_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [isCommitting, loadCurrentChanges, selectedGroupId, selectedTaskId]);

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
  const isValidationStage = currentTask?.status === 'InReview';
  const canStartValidationStage = currentTask?.status === 'InProgress' || currentTask?.status === 'AwaitingResponse';
  const hasPendingValidation = reviewSummary.stateCounts.pending_review > 0;
  const hasReadyToCommit = reviewSummary.stateCounts.ready_to_commit > 0;
  const hasAnyChangesToValidate = repositories.some(
    (repository) => repository.stats.total > 0 && repository.commitState !== 'committed'
  );
  const canFinishTask =
    !isCommitting &&
    currentTask !== null &&
    !currentTask.draft &&
    currentTask.status !== 'Completed' &&
    reviewSummary.stateCounts.pending_review === 0 &&
    reviewSummary.stateCounts.ready_to_commit === 0 &&
    reviewSummary.hasCommittedRepositories;
  const nextValidationRepositoryId =
    (selectedRepositoryId && repositorySummaryById.get(selectedRepositoryId)?.state === 'pending_review'
      ? selectedRepositoryId
      : reviewSummary.repositories.find((repository) => repository.state === 'pending_review')?.id) || null;
  const nextCommitRepositoryId =
    (selectedRepositoryId && repositorySummaryById.get(selectedRepositoryId)?.state === 'ready_to_commit'
      ? selectedRepositoryId
      : reviewSummary.repositories.find((repository) => repository.state === 'ready_to_commit')?.id) || null;
  const nextValidationRepository = nextValidationRepositoryId
    ? repositories.find((repository) => repository.id === nextValidationRepositoryId) ?? null
    : null;
  const nextCommitRepository = nextCommitRepositoryId
    ? repositories.find((repository) => repository.id === nextCommitRepositoryId) ?? null
    : null;
  const showValidateChangesButton = canStartValidationStage || isValidationStage;
  const isValidateChangesDisabled =
    isCommitting ||
    (isValidationStage ? !hasPendingValidation : !hasAnyChangesToValidate);
  const validateChangesDisabledReason = isValidationStage
    ? t('implement.noRemainingChangesToValidate', 'No remaining changes to validate.')
    : t('implement.noChangesToValidate', 'No changes to validate.');
  const isCommitDisabled = isCommitting || !isValidationStage || !hasReadyToCommit;
  const commitDisabledReason = !isValidationStage
    ? t('implement.commitRequiresValidationStage', 'Task must be in validation before commit.')
    : t('implement.noValidatedChangesToCommit', 'Validate changes before commit.');

  const displayError = normalizeCommitErrorMessage(
    lastError || '',
    translate
  );
  const mappingError = currentTaskLoadState === 'invalid_mapping' || currentTaskLoadState === 'awaiting_worktree'
    ? currentTaskLoadMessage
    : null;
  const handleCommit = async () => {
    if (isCommitting || !nextCommitRepository) return;
    const commitMessage = nextCommitRepository.commitMessageDraft;
    setCommitMessageDraft(nextCommitRepository.id, commitMessage);

    try {
      const result = await commitReviewedChanges(nextCommitRepository.id, commitMessage);
      toast.success(
        t('implement.repositoryCommitSuccess', 'Committed {{hash}} for this repository.', {
          hash: result.hash,
        })
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      toast.error(
        normalizeCommitErrorMessage(
          messageText || t('implement.commitFailed', 'Failed to commit changes'),
          translate
        )
      );
    }
  };

  const handleStartReview = async () => {
    if (!currentTask || isCommitting) return;
    try {
      await startReview(currentTask.id);
      await loadCurrentChanges();
      toast.success(t('implement.validationStarted', 'Task moved to validation'));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      toast.error(messageText || t('implement.validationStartFailed', 'Failed to start validation'));
    }
  };

  const handleValidateChanges = () => {
    if (!nextValidationRepository) return;
    selectRepository(nextValidationRepository.id);
    markAllAsReviewed(nextValidationRepository.id);
  };

  const handleOpenCommit = () => {
    if (!nextCommitRepository) return;
    selectRepository(nextCommitRepository.id);
    void handleCommit();
  };

  const handleFinishTask = async () => {
    if (!currentTask || isCommitting) return;
    try {
      await finishTask(currentTask.id);
      resetReviewState();
      toast.success(t('implement.taskFinished', 'Task finished'), {
        notification: {
          category: 'task_completed',
        },
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      toast.error(messageText || t('implement.completeTaskFailed', 'Failed to complete task'));
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
            {t('implement.selectTaskForValidation', 'Select a task to validate changes')}
          </p>
        </div>
      </aside>
    );
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
            {t('implement.overallValidatedCountCompact', '{{validated}}/{{total}}', {
              validated: overallStats.reviewed,
              total: overallStats.total,
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
        {!isLoading && displayError && (
          <div className="px-4 py-8 text-center text-sm text-destructive">
            {displayError}
          </div>
        )}
        {!isLoading && !mappingError && !displayError && repositories.length === 0 && (
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
          const repositoryHasPendingValidation = repository.commitState === 'idle' && repository.stats.reviewed < repository.stats.total;
          return (
            <section
              key={repository.id}
              className="mx-2 mb-1"
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
                  'w-full rounded-xl px-3 py-2.5 text-left transition-colors',
                  repository.id === selectedRepositoryId || isExpanded
                    ? 'bg-primary/5'
                    : 'bg-card hover:bg-accent/40'
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
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
                        <span className="h-2 w-2 shrink-0 rounded-full bg-primary ring-2 ring-primary/15" />
                      )}
                      {repositorySummary?.isNextAction && !repositorySummary.isSelected && (
                        <span className="px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px]">
                          {t('implement.nextRepository', 'Next')}
                        </span>
                      )}
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
                    {!repositoryError && repository.commitState === 'idle' && folderTree.length === 0 && (
                      <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                        {t('implement.noPendingChanges', 'No pending file changes for this repository.')}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'idle' && folderTree.map((node) => (
                      <FolderTreeItem
                        repositoryId={repository.id}
                        key={node.path}
                        node={node}
                        depth={0}
                        selectedChangeId={repository.selectedChangeId}
                        invalidateTooltip={t('implement.rightClickToInvalidate', 'Right-click to invalidate')}
                        onFileClick={(changeId) => {
                          selectRepository(repository.id);
                          openDiffModal(repository.id, changeId);
                        }}
                        onFileInvalidate={(changeId) => {
                          selectRepository(repository.id);
                          markAsUnreviewed(repository.id, changeId);
                        }}
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
            onClick={() => {
              if (isValidationStage) {
                handleValidateChanges();
                return;
              }
              void handleStartReview();
            }}
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
        {isValidationStage && (
          <button
            onClick={handleOpenCommit}
            disabled={isCommitDisabled}
            title={isCommitDisabled ? commitDisabledReason : undefined}
            className={cn(
              'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
              isCommitDisabled
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            <Icon name="git-commit" size={14} />
            {t('implement.commitChangesGeneric', 'Commit')}
          </button>
        )}
        {canFinishTask && (
          <button
            onClick={() => void handleFinishTask()}
            className="w-full py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center justify-center gap-2"
          >
            <Icon name="git-merge" size={14} />
            {t('implement.finishTask', 'Finish task')}
          </button>
        )}
      </div>

      {isDiffModalOpen && selectedDiffTarget && (
        <FileChangesDiffModal
          repositoryId={selectedDiffTarget.repositoryId}
          changeId={selectedDiffTarget.changeId}
          onClose={closeDiffModal}
        />
      )}
    </aside>
  );
};

export const FileChangesPanel = React.memo(FileChangesPanelBase);

export default FileChangesPanel;
