import React from 'react';
import { useTranslation } from 'react-i18next';
import { useFileChangesStore } from '../../stores/useFileChangesStore';
import { Icon } from '../ui/Icon';
import { CodeViewer } from '../ui/CodeViewer';
import { cn } from '../../utils/cn';

interface FileChangesDiffModalProps {
  changeId: string;
  onClose: () => void;
}

const CONTEXT_LABELS = {
  default: 'Focused diff',
  expanded: 'Expanded context',
  full: 'Full file context',
} as const;

export const FileChangesDiffModal: React.FC<FileChangesDiffModalProps> = ({ changeId, onClose }) => {
  const { t } = useTranslation();
  const {
    getChange,
    markAsReviewed,
    loadChangeContext,
    startEditingChange,
    updateEditingBuffer,
    cancelEditingChange,
    saveEditedChange,
    loadingChangeId,
    savingChangeId,
    lastError,
  } = useFileChangesStore();

  const change = getChange(changeId);

  if (!change) return null;

  const isLoadingContext = loadingChangeId === changeId;
  const isSavingEdit = savingChangeId === changeId;
  const isBusy = isLoadingContext || isSavingEdit;

  const handleMarkReviewed = () => {
    markAsReviewed(changeId);
    onClose();
  };

  const handleEditStart = async () => {
    try {
      await startEditingChange(changeId);
    } catch {
      // Store lastError is surfaced in the modal.
    }
  };

  const handleSaveEdit = async () => {
    try {
      await saveEditedChange(changeId);
    } catch {
      // Store lastError is surfaced in the modal.
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-6xl max-h-[92vh] bg-card border border-border shadow-2xl rounded-xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/20 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={cn(
                'w-8 h-8 rounded-lg flex items-center justify-center',
                change.status === 'added'
                  ? 'bg-emerald-500/10'
                  : change.status === 'modified'
                    ? 'bg-amber-500/10'
                    : 'bg-red-500/10'
              )}
            >
              <Icon
                name={change.status === 'added' ? 'plus' : change.status === 'modified' ? 'edit' : 'trash'}
                size={16}
                className={
                  change.status === 'added'
                    ? 'text-emerald-500'
                    : change.status === 'modified'
                      ? 'text-amber-500'
                      : 'text-red-500'
                }
              />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground truncate">{change.path}</h2>
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                <span className="text-emerald-500">+{change.additions}</span>
                <span className="text-red-400">-{change.deletions}</span>
                <span className="capitalize">{change.status}</span>
                <span className="px-2 py-0.5 rounded-full bg-background/80 border border-border">
                  {t(`implement.context.${change.contextMode}`, CONTEXT_LABELS[change.contextMode])}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {change.reviewed && !change.isEditing && (
              <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-500/10 text-emerald-500 text-xs">
                <Icon name="check" size={12} />
                {t('implement.reviewed', 'Reviewed')}
              </span>
            )}
            <button onClick={onClose} className="p-2 hover:bg-accent rounded-full transition-colors">
              <Icon name="x" size={18} className="text-muted-foreground" />
            </button>
          </div>
        </div>

        {lastError && (
          <div className="px-6 py-3 border-b border-border bg-red-500/5 text-sm text-red-500">
            {lastError}
          </div>
        )}

        {change.isEditing ? (
          <div className="flex-1 overflow-auto p-4 space-y-4">
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
              {t(
                'implement.manualEditNotice',
                'Manual edits are allowed here, but the file will need to be reviewed again before commit.'
              )}
            </div>
            <CodeViewer
              code={change.editingContent ?? change.modifiedContent}
              language={change.language}
              readOnly={false}
              onChange={(value) => updateEditingBuffer(changeId, value)}
              className="min-h-[60vh]"
            />
          </div>
        ) : (
          <div className="flex-1 overflow-auto bg-background">
            {change.hunks.length === 0 ? (
              <div className="p-6 space-y-4">
                <div className="text-sm text-muted-foreground">
                  {t(
                    'implement.noTextualDiff',
                    'No textual diff is available for this file. Use a broader review context if needed.'
                  )}
                </div>
                {change.modifiedContent.trim().length > 0 && (
                  <CodeViewer
                    code={change.modifiedContent}
                    language={change.language}
                    className="min-h-[40vh]"
                  />
                )}
              </div>
            ) : (
              <div className="font-mono text-xs leading-relaxed">
                {change.hunks.map((hunk, hunkIndex) => (
                  <div key={`${hunk.header}-${hunkIndex}`} className="border-b border-border/40 last:border-b-0">
                    <div className="px-4 py-2 bg-muted/30 text-muted-foreground border-b border-border/40">
                      {hunk.header}
                    </div>
                    {hunk.lines.map((line, lineIndex) => (
                      <div
                        key={`${hunkIndex}-${lineIndex}`}
                        className={cn(
                          'grid grid-cols-[4rem_4rem_2rem_minmax(0,1fr)] border-b border-border/20 last:border-b-0',
                          line.type === 'added'
                            ? 'bg-emerald-500/5'
                            : line.type === 'removed'
                              ? 'bg-red-500/5'
                              : ''
                        )}
                      >
                        <div className="px-2 py-0.5 text-right text-muted-foreground/60 border-r border-border/20 select-none">
                          {line.oldLineNumber ?? ''}
                        </div>
                        <div className="px-2 py-0.5 text-right text-muted-foreground/60 border-r border-border/20 select-none">
                          {line.newLineNumber ?? ''}
                        </div>
                        <div
                          className={cn(
                            'px-1 py-0.5 text-center border-r border-border/20 select-none',
                            line.type === 'added'
                              ? 'text-emerald-500 bg-emerald-500/10'
                              : line.type === 'removed'
                                ? 'text-red-400 bg-red-500/10'
                                : 'text-transparent'
                          )}
                        >
                          {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                        </div>
                        <pre
                          className={cn(
                            'px-3 py-0.5 whitespace-pre overflow-x-auto',
                            line.type === 'added'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : line.type === 'removed'
                                ? 'text-red-600 dark:text-red-400 line-through opacity-70'
                                : 'text-foreground'
                          )}
                        >
                          {line.content || ' '}
                        </pre>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-muted/20 shrink-0 gap-4">
          <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
            <span>
              {change.hunks.length} {t('implement.hunks', 'hunks')}
            </span>
            {!change.canEdit && (
              <span className="text-red-400">
                {t('implement.deletedChangeReadOnly', 'Deleted files are read-only in this review flow.')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {!change.isEditing && change.contextMode === 'default' && (
              <button
                onClick={() => void loadChangeContext(changeId, 'expanded')}
                disabled={isBusy}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Icon name={isLoadingContext ? 'loader' : 'expand'} size={14} className={isLoadingContext ? 'animate-spin' : undefined} />
                {t('implement.loadMoreContext', 'Load more context')}
              </button>
            )}

            {!change.isEditing && change.contextMode !== 'full' && (
              <button
                onClick={() => void loadChangeContext(changeId, 'full')}
                disabled={isBusy}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Icon name={isLoadingContext ? 'loader' : 'maximize'} size={14} className={isLoadingContext ? 'animate-spin' : undefined} />
                {t('implement.loadFullFile', 'Load full file')}
              </button>
            )}

            {!change.isEditing && change.canEdit && (
              <button
                onClick={() => void handleEditStart()}
                disabled={isBusy}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Icon name={isLoadingContext ? 'loader' : 'edit'} size={14} className={isLoadingContext ? 'animate-spin' : undefined} />
                {t('implement.editChange', 'Edit change')}
              </button>
            )}

            {change.isEditing && (
              <button
                onClick={() => cancelEditingChange(changeId)}
                disabled={isBusy}
                className="px-4 py-2 text-sm font-medium rounded-lg text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('common.cancel', 'Cancel')}
              </button>
            )}

            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {change.isEditing ? t('implement.closeWithoutSaving', 'Close') : t('common.close', 'Close')}
            </button>

            {change.isEditing ? (
              <button
                onClick={() => void handleSaveEdit()}
                disabled={isBusy}
                className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Icon name={isSavingEdit ? 'loader' : 'check'} size={14} className={isSavingEdit ? 'animate-spin' : undefined} />
                {isSavingEdit
                  ? t('implement.savingEdit', 'Saving changes...')
                  : t('implement.saveEdit', 'Save edit')}
              </button>
            ) : (
              !change.reviewed && (
                <button
                  onClick={handleMarkReviewed}
                  disabled={isBusy}
                  className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Icon name="check" size={14} />
                  {t('implement.markReviewed', 'Mark as reviewed')}
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
