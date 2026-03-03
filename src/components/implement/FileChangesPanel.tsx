import React, { useMemo, useState } from 'react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { useFileChangesStore, buildFolderTree, FolderNode } from '../../stores/useFileChangesStore';
import { Icon, IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { toast } from '../ui/Toaster';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { FileChangesDiffModal } from '../modals/FileChangesDiffModal.tsx';

interface FileChangesPanelProps {
  className?: string;
}

/**
 * FileChangesPanel - Displays file changes in Implement mode
 *
 * PERFORMANCE: Lazy loaded via ModeRouter, only rendered when Implement mode is active
 */

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

const fallbackCommitMessage = 'chore: update task changes';

const toDefaultCommitMessage = (title?: string | null): string => {
  const trimmed = title?.trim();
  if (!trimmed) return fallbackCommitMessage;
  const normalized = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  return `feat: ${normalized}`;
};

const normalizeCommitErrorMessage = (raw: string, t: (key: string, fallback: string) => string): string => {
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
  if (value.includes('in progress or awaiting response')) {
    return t(
      'implement.commitRequiresActiveTaskStatus',
      'Task must be in progress or awaiting response before commit.'
    );
  }
  return raw;
};

interface FolderTreeItemProps {
  node: FolderNode;
  depth: number;
  onFileClick: (id: string) => void;
}

const FolderTreeItem: React.FC<FolderTreeItemProps> = ({ node, depth, onFileClick }) => {
  const [isOpen, setIsOpen] = useState(true);
  const { selectedChangeId } = useFileChangesStore();

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
                onFileClick={onFileClick}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File node
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
      {/* Status indicator */}
      <div
        className={cn(
          'w-5 h-5 rounded flex items-center justify-center shrink-0',
          STATUS_BG[change.status]
        )}
      >
        <Icon name={STATUS_ICONS[change.status]} size={10} className={STATUS_COLORS[change.status]} />
      </div>

      {/* File name */}
      <span className="text-sm text-foreground truncate flex-1 text-left">{node.name}</span>

      {/* Review indicator */}
      {change.reviewed && (
        <Icon name="check" size={12} className="text-emerald-500 shrink-0" />
      )}

      {/* Line changes */}
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

// Base component - wrapped with React.memo below for performance
const FileChangesPanelBase: React.FC<FileChangesPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const { selectedGroupId, selectedTaskId } = useAppStore();
  const currentTask = useTaskStore((state) =>
    selectedTaskId ? state.tasks.find((task) => task.id === selectedTaskId) ?? null : null
  );
  const [isCommitPromptOpen, setIsCommitPromptOpen] = useState(false);
  const {
    changes,
    isDiffModalOpen,
    selectedChangeId,
    isLoading,
    isCommitting,
    lastError,
    loadCurrentChanges,
    openDiffModal,
    closeDiffModal,
    markAllAsReviewed,
    commitReviewedChanges,
    getStats,
  } = useFileChangesStore();

  useEffect(() => {
    if (!selectedGroupId || !selectedTaskId) return;
    void loadCurrentChanges();
  }, [selectedGroupId, selectedTaskId, loadCurrentChanges]);

  const stats = getStats();
  const folderTree = useMemo(() => buildFolderTree(changes), [changes]);
  const progressPercent = stats.total > 0 ? (stats.reviewed / stats.total) * 100 : 0;
  const canCommitTaskStatus = currentTask?.status === 'InProgress' || currentTask?.status === 'AwaitingResponse';
  const canCommit =
    !isLoading &&
    !isCommitting &&
    canCommitTaskStatus &&
    stats.total > 0 &&
    stats.reviewed === stats.total;
  const commitMessageDefault = useMemo(
    () => toDefaultCommitMessage(currentTask?.title),
    [currentTask?.title]
  );
  const currentTaskStatusLabel = currentTask
    ? {
      Pending: t('tasks.pending', 'Pending'),
      InProgress: t('tasks.inProgress', 'In Progress'),
      AwaitingResponse: t('implement.awaitingResponse', 'Awaiting response'),
      Completed: t('tasks.completed', 'Completed'),
      Failed: t('implement.failed', 'Failed'),
      Blocked: t('tasks.blocked', 'Blocked'),
    }[currentTask.status]
    : null;

  const commitDisabledReason = (() => {
    if (isCommitting) {
      return t('implement.commitInProgress', 'Committing changes...');
    }
    if (!canCommitTaskStatus) {
      return t(
        'implement.commitRequiresActiveTaskStatus',
        'Task must be in progress or awaiting response before commit.'
      );
    }
    if (stats.total === 0) {
      return t('implement.commitNoChanges', 'No file changes available for this task.');
    }
    if (stats.reviewed < stats.total) {
      return t(
        'implement.commitNeedsReview',
        'Review all file changes before committing this task.'
      );
    }
    return '';
  })();

  const displayError = lastError
    ? normalizeCommitErrorMessage(lastError, (key, fallback) => t(key, fallback))
    : null;

  const handleFileClick = (id: string) => {
    openDiffModal(id);
  };

  const handleCommitConfirm = async (message?: string) => {
    if (isCommitting) return;
    const commitMessage = (message || '').trim() || commitMessageDefault;
    try {
      const result = await commitReviewedChanges(commitMessage);
      if (result.taskCompleted) {
        toast.success(
          t('implement.commitSuccess', 'Committed {{hash}} and marked task complete', {
            hash: result.hash,
          })
        );
      } else {
        toast.success(
          t('implement.commitSuccessNoComplete', 'Committed {{hash}}. Complete the task manually.', {
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
      {/* Header */}
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
            {stats.reviewed}/{stats.total} reviewed
          </span>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/20 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="text-emerald-500 text-sm font-mono font-semibold">
              +{stats.additions}
            </span>
            <span className="text-xs text-muted-foreground">lines</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-red-400 text-sm font-mono font-semibold">-{stats.deletions}</span>
            <span className="text-xs text-muted-foreground">lines</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{stats.total} files</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="px-4 py-2 border-b border-border shrink-0">
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* File Tree */}
      <div className="flex-1 overflow-y-auto py-2">
        {isLoading && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Loading repository changes...
          </div>
        )}
        {!isLoading && displayError && (
          <div className="px-4 py-8 text-center text-sm text-red-500">
            {displayError}
          </div>
        )}
        {!isLoading && !displayError && folderTree.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No pending file changes for this task.
          </div>
        )}
        {folderTree.map((node) => (
          <FolderTreeItem key={node.path} node={node} depth={0} onFileClick={handleFileClick} />
        ))}
      </div>

      {/* Footer Actions */}
      <div className="p-3 border-t border-border shrink-0 space-y-2">
        {stats.reviewed < stats.total && (
          <button
            onClick={markAllAsReviewed}
            disabled={isCommitting}
            className="w-full py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center justify-center gap-2"
          >
            <Icon name="check-circle" size={14} />
            {t('implement.markAllReviewed', 'Mark all as reviewed')}
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
            : t('implement.commitChanges', 'Commit Changes')}
        </button>
        {!canCommit && commitDisabledReason && (
          <p className="text-xs text-muted-foreground">{commitDisabledReason}</p>
        )}
      </div>

      {/* Diff Modal */}
      {isDiffModalOpen && selectedChangeId && (
        <FileChangesDiffModal changeId={selectedChangeId} onClose={closeDiffModal} />
      )}

      <ConfirmPromptModal
        isOpen={isCommitPromptOpen}
        title={t('implement.commitPromptTitle', 'Commit reviewed changes')}
        description={t(
          'implement.commitPromptDescription',
          'Provide a concise commit message for this task.'
        )}
        confirmLabel={t('implement.commitConfirm', 'Commit')}
        cancelLabel={t('common.cancel', 'Cancel')}
        initialValue={commitMessageDefault}
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

// Performance: Memoize the entire panel to prevent re-renders

// Performance: Memoize the entire panel to prevent re-renders
export const FileChangesPanel = React.memo(FileChangesPanelBase);

// Export default for lazy loading compatibility
export default FileChangesPanel;
