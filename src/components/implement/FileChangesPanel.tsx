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
  t: TranslateFn
): string => {
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
  const [isCommitPromptOpen, setIsCommitPromptOpen] = useState(false);
  const {
    repositories,
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
    getSelectedRepository,
    getOverallStats,
  } = useFileChangesStore();

  useEffect(() => {
    if (!selectedGroupId || !selectedTaskId) return;
    void loadCurrentChanges();
  }, [selectedGroupId, selectedTaskId, loadCurrentChanges]);

  const selectedRepository = getSelectedRepository();
  const selectedProject = selectedRepository ? getProjectById(selectedRepository.projectId) : null;
  const overallStats = getOverallStats();
  const folderTree = useMemo(
    () => buildFolderTree(selectedRepository?.changes || []),
    [selectedRepository?.changes]
  );
  const progressPercent = overallStats.total > 0 ? (overallStats.reviewed / overallStats.total) * 100 : 0;
  const canCommitTaskStatus = currentTask?.status === 'InReview';
  const canStartReview = currentTask?.status === 'InProgress' || currentTask?.status === 'AwaitingResponse';
  const canRequestChanges = currentTask?.status === 'InReview';
  const allRepositoriesNoChanges = repositories.length > 0 && repositories.every(
    (repository) => repository.commitState === 'no_changes'
  );
  const canCompleteWithoutCodeChanges =
    currentTask?.status === 'InReview' &&
    allRepositoriesNoChanges &&
    !isCommitting;
  const canCommit =
    selectedRepository
      ? !isLoading &&
        !isCommitting &&
        canCommitTaskStatus &&
        selectedRepository.commitState !== 'committed' &&
        selectedRepository.stats.total > 0 &&
        selectedRepository.stats.reviewed === selectedRepository.stats.total
      : false;

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

  const commitDisabledReason = (() => {
    if (!selectedRepository) {
      return t('implement.selectRepository', 'Select a repository to review changes.');
    }
    if (isCommitting) {
      return t('implement.commitInProgress', 'Committing changes...');
    }
    if (!canCommitTaskStatus) {
      return t(
        'implement.commitRequiresActiveTaskStatus',
        'Task must be in review before commit.'
      );
    }
    if (selectedRepository.commitState === 'committed') {
      return t('implement.repositoryAlreadyCommitted', 'This repository has already been committed.');
    }
    if (selectedRepository.stats.total === 0) {
      return t('implement.commitNoChanges', 'No file changes available for this repository.');
    }
    if (selectedRepository.stats.reviewed < selectedRepository.stats.total) {
      return t(
        'implement.commitNeedsReview',
        'Review all file changes before committing this task.'
      );
    }
    return '';
  })();

  const displayError = normalizeCommitErrorMessage(
    selectedRepository?.lastError || lastError || '',
    translate
  );

  const handleCommitConfirm = async (message?: string) => {
    if (isCommitting || !selectedRepositoryId || !selectedRepository) return;
    const commitMessage = (message || '').trim() || selectedRepository.commitMessageDraft;
    setCommitMessageDraft(selectedRepositoryId, commitMessage);

    try {
      const result = await commitReviewedChanges(selectedRepositoryId, commitMessage);
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
      setIsCommitPromptOpen(false);
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

      {repositories.length > 0 && (
        <div className="px-3 py-3 border-b border-border flex items-center gap-2 overflow-x-auto shrink-0">
          {repositories.map((repository) => {
            const project = getProjectById(repository.projectId);
            const isSelected = repository.id === selectedRepositoryId;
            return (
              <button
                key={repository.id}
                type="button"
                onClick={() => selectRepository(repository.id)}
                className={cn(
                  'min-w-0 rounded-lg border px-3 py-2 text-left transition-colors',
                  isSelected
                    ? 'border-primary/40 bg-primary/10'
                    : 'border-border hover:bg-accent'
                )}
              >
                <div className="text-xs font-medium text-foreground truncate">
                  {project?.name || repository.projectId}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {renderRepositoryState(repository, translate)}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/20 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="text-emerald-500 text-sm font-mono font-semibold">
              +{selectedRepository?.stats.additions ?? 0}
            </span>
            <span className="text-xs text-muted-foreground">lines</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-red-400 text-sm font-mono font-semibold">
              -{selectedRepository?.stats.deletions ?? 0}
            </span>
            <span className="text-xs text-muted-foreground">lines</span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {selectedProject && (
            <span className="inline-flex items-center gap-1">
              <Icon name="folder" size={10} />
              {selectedProject.name}
            </span>
          )}
          {selectedRepository && (
            <span className="inline-flex items-center gap-1">
              <Icon name="git-branch" size={10} />
              {selectedRepository.branchName}
            </span>
          )}
        </div>
      </div>

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
        {!isLoading && !displayError && !selectedRepository && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('implement.selectRepository', 'Select a repository to review changes.')}
          </div>
        )}
        {!isLoading && !displayError && selectedRepository && selectedRepository.commitState === 'committed' && (
          <div className="px-4 py-8 text-center text-sm text-emerald-500">
            {t('implement.repositoryCommittedHelp', 'This repository has already been committed and integrated.')}
          </div>
        )}
        {!isLoading && !displayError && selectedRepository && selectedRepository.commitState === 'no_changes' && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('implement.repositoryNoChangesHelp', 'No pending file changes for this repository.')}
          </div>
        )}
        {!isLoading && !displayError && selectedRepository && selectedRepository.commitState === 'idle' && folderTree.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('implement.noPendingChanges', 'No pending file changes for this repository.')}
          </div>
        )}
        {selectedRepository && folderTree.map((node) => (
          <FolderTreeItem
            key={node.path}
            node={node}
            depth={0}
            selectedChangeId={selectedRepository.selectedChangeId}
            onFileClick={(changeId) => openDiffModal(selectedRepository.id, changeId)}
          />
        ))}
      </div>

      <div className="p-3 border-t border-border shrink-0 space-y-2">
        {selectedRepository && selectedRepository.stats.reviewed < selectedRepository.stats.total && (
          <button
            onClick={() => markAllAsReviewed(selectedRepository.id)}
            disabled={isCommitting}
            className="w-full py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center justify-center gap-2"
          >
            <Icon name="check-circle" size={14} />
            {t('implement.markAllReviewed', 'Mark all as reviewed')}
          </button>
        )}
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
        {canRequestChanges && (
          <button
            onClick={() => void handleRequestChanges()}
            disabled={isCommitting}
            className="w-full py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center justify-center gap-2"
          >
            <Icon name="rotate-ccw" size={14} />
            {t('implement.requestChanges', 'Request changes')}
          </button>
        )}
        <button
          onClick={() => setIsCommitPromptOpen(true)}
          disabled={!canCommit}
          title={canCommit ? undefined : commitDisabledReason}
          className={cn(
            'w-full py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
            canCommit
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
          )}
        >
          <Icon name={isCommitting ? 'loader' : 'git-commit'} size={14} className={isCommitting ? 'animate-spin' : undefined} />
          {isCommitting
            ? t('implement.commitInProgress', 'Committing changes...')
            : t('implement.commitRepositoryChanges', 'Commit Repository Changes')}
        </button>
        {canCompleteWithoutCodeChanges && (
          <button
            onClick={() => void handleCompleteWithoutCodeChanges()}
            className="w-full py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center justify-center gap-2"
          >
            <Icon name="check" size={14} />
            {t('implement.completeWithoutCodeChanges', 'Complete without code changes')}
          </button>
        )}
        {!canCommit && commitDisabledReason && (
          <p className="text-xs text-muted-foreground">{commitDisabledReason}</p>
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
        isOpen={isCommitPromptOpen}
        title={t('implement.commitPromptTitle', 'Commit reviewed changes')}
        description={t(
          'implement.commitPromptDescription',
          'Provide a concise commit message for this repository.'
        )}
        confirmLabel={t('implement.commitConfirm', 'Commit')}
        cancelLabel={t('common.cancel', 'Cancel')}
        initialValue={selectedRepository?.commitMessageDraft || ''}
        inputPlaceholder={t('implement.commitPromptPlaceholder', 'feat: update task implementation')}
        requireInput
        onCancel={() => setIsCommitPromptOpen(false)}
        onConfirm={(value) => {
          void handleCommitConfirm(value);
        }}
      />
    </aside>
  );
};

export const FileChangesPanel = React.memo(FileChangesPanelBase);

export default FileChangesPanel;
