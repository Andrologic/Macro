import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFileChangesStore, type FileChangeContextMode } from '../../stores/useFileChangesStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { DiffMergeView } from '../ui/DiffMergeView';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';

interface FileChangesDiffModalProps {
  onClose: () => void;
}

const CONTEXT_LABELS = {
  default: 'Focused diff',
  expanded: 'Expanded context',
  full: 'Full file context',
} as const;

const STATUS_LABELS = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
} as const;

const CONTEXT_OPTIONS: FileChangeContextMode[] = ['default', 'expanded', 'full'];

const getFileLabel = (path: string): string => path.split('/').filter(Boolean).pop() || path;
const getFileDir = (path: string): string => {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
};

const STATUS_META = {
  added: {
    icon: 'plus',
    color: 'text-emerald-500',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
  },
  modified: {
    icon: 'edit',
    color: 'text-amber-500',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
  },
  deleted: {
    icon: 'trash',
    color: 'text-destructive',
    bg: 'bg-destructive/10',
    border: 'border-destructive/20',
  },
} as const;

export const FileChangesDiffModal: React.FC<FileChangesDiffModalProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const {
    getRepository,
    getChange,
    getDiffModalSession,
    markAsReviewed,
    loadChangeContext,
    updateRightDraft,
    resetRightDraft,
    saveRightDraft,
    openDiffModal,
  } = useFileChangesStore();

  const session = getDiffModalSession();
  const repository = session ? getRepository(session.repositoryId) : undefined;
  const change = session ? getChange(session.repositoryId, session.changeId) : undefined;

  const [pendingChangeId, setPendingChangeId] = useState<string | null>(null);
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState<boolean>(false);

  const isHydrating = Boolean(
    session?.isHydratingFullContext || (repository && change && repository.loadingChangeId === change.id)
  );
  const isSaving = Boolean(session?.isSaving || (repository && change && repository.savingChangeId === change.id));
  const isBusy = isHydrating || isSaving;
  const isDirty = session?.isDirty === true;
  const canEdit = Boolean(change?.canEdit && session && !isHydrating);

  const statusMeta = change ? STATUS_META[change.status] : STATUS_META.modified;

  useEffect(() => {
    if (!session) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [session]);

  const attemptClose = () => {
    if (isDirty) {
      setPendingChangeId('close');
      setIsConfirmingDiscard(true);
      return;
    }
    onClose();
  };

  const handleConfirmDiscard = () => {
    setIsConfirmingDiscard(false);
    resetRightDraft();
    if (pendingChangeId === 'close') {
      onClose();
    } else if (pendingChangeId && repository) {
      openDiffModal(repository.id, pendingChangeId);
    }
    setPendingChangeId(null);
};

  const handleCancelDiscard = () => {
    setIsConfirmingDiscard(false);
    setPendingChangeId(null);

};

  useEffect(() => {
    if (!session) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      attemptClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isDirty, onClose, session]);
	  if (!session || !repository || !change) {
    return null;
  }
	  const handleValidate = async () => {
    if (isBusy || isDirty) return;
    await markAsReviewed(repository.id, change.id);
    onClose();
	  };

  const handleNavigation = (changeId: string) => {
    if (isDirty) {
      setPendingChangeId(changeId);
      setIsConfirmingDiscard(true);
      return;
    }
    openDiffModal(repository.id, changeId);
	  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 pt-12 sm:p-6 sm:pt-14 bg-background/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) attemptClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-full w-full max-w-[1800px] overflow-hidden rounded-xl bg-background shadow-2xl ring-1 ring-border/10">
        
        {/* SIDEBAR: File List */}
        <aside className="flex w-[200px] shrink-0 flex-col bg-muted/10">
          <div className="p-4">
            <h3 className="truncate text-sm font-semibold tracking-tight">{repository.branchName}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {repository.stats.reviewed} / {repository.stats.total} {t('implement.validatedFiles', 'files validated')}
            </p>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {repository.changes.map((candidate) => {
              const isCurrent = candidate.id === change.id;
              const isPending = !candidate.reviewed;
              const meta = STATUS_META[candidate.status];
              return (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => handleNavigation(candidate.id)}
                  disabled={isCurrent || isSaving}
                  className={cn(
                    'group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    isCurrent
                      ? 'bg-primary/10 text-foreground ring-1 ring-primary/20'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )}
                  title={candidate.path}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold',
                      meta.bg,
                      meta.color
                    )}
                  >
                    {candidate.status === 'added' ? '+' : candidate.status === 'deleted' ? '-' : 'M'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{getFileLabel(candidate.path)}</div>
                    <div className="truncate text-[11px] opacity-70">{getFileDir(candidate.path) || '/'}</div>
                  </div>
                  {isPending && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                </button>
              );
            })}
          </div>
        </aside>

        {/* MAIN: Details & Diff */}
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex shrink-0 items-center justify-between px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-3 pr-4">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-medium leading-tight">
                  <span className="text-muted-foreground">{getFileDir(change.path) || '/'}</span>
                  <span className="text-foreground">{getFileLabel(change.path)}</span>
                </h2>
              </div>
            </div>
            
            <div className="flex shrink-0 items-center gap-4">
              <Button variant="ghost" size="sm" onClick={attemptClose} aria-label={t('common.close', 'Close')}>
                <Icon name="x" size={16} />
              </Button>
            </div>
          </header>

          <div className="relative min-h-0 flex-1 bg-muted/5">
            {repository.lastError && (
              <div className="absolute inset-x-4 top-4 z-10 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {repository.lastError}
              </div>
            )}
            {change.hunks.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {t('implement.noTextualDiff', 'No textual diff is available for this file.')}
              </div>
            ) : (
              <DiffMergeView
                key={`${change.id}-${isHydrating}`}
                original={change.originalContent}
                modified={session.rightDraftContent}
                language={change.language}
                className="h-full w-full border-none md:border-none"
                autoFocus={canEdit}
                onChange={(val) => canEdit && updateRightDraft(val)}
                revertControls={canEdit ? 'a-to-b' : undefined}
              />
            )}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 bg-card/95 px-6 py-4">
            <div className="text-xs text-muted-foreground">
              {isHydrating || isSaving ? (
                <span className="flex items-center gap-2 text-primary">
                  <Icon name="loader" size={14} className="animate-spin" />
                  {t('implement.working', 'Working...')}
                </span>
              ) : isDirty ? (
                <span className="font-medium text-amber-500">
                  {t('implement.unsavedDraft', 'Unsaved draft. Save to validate or reset.')}
                </span>
              ) : change.reviewed ? (
                <span className="font-medium text-primary">✓ {t('implement.validated', 'Validated')}</span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => resetRightDraft()}
                disabled={!canEdit || !isDirty || isSaving}
              >
                {t('implement.resetDraft', 'Reset draft')}
              </Button>
              
              {isDirty ? (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => saveRightDraft()}
                  disabled={isSaving}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {t('implement.saveDraft', 'Save draft')}
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleValidate}
                  disabled={isBusy || change.reviewed}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
               >
						{t('implement.validateFile', 'Validate file')}
                </Button>
              )}
            </div>
          </footer>
        </main>
      </div>

      {isConfirmingDiscard && (
        <ConfirmPromptModal
          title={t('implement.discardChangesTitle', 'Discard unsaved changes?')}
          description={t(
            'implement.discardChangesDesc',
            'You have made edits to this file. Are you sure you want to discard them?'
          )}
          confirmLabel={t('implement.discardButton', 'Discard changes')}
          cancelLabel={t('common.cancel', 'Cancel')}
          onConfirm={handleConfirmDiscard}
          onCancel={handleCancelDiscard}
          variant="destructive"
        />
      )}
    </div>
  );
}; 