import React, { useCallback, useEffect, useId, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useFileChangesStore,
  type DiffPresentationMode,
} from '../../stores/useFileChangesStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { DiffMergeView, type MergeViewEditorHandle } from '../ui/DiffMergeView';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { loadPreference, PREF_KEYS, savePreference } from '../../services/preferences';

interface FileChangesDiffModalProps {
  onClose: () => void;
}

const DEBUG_FILE_DIFF_STORAGE_KEY = 'debug:file-diff';

const getFileLabel = (path: string): string => path.split('/').filter(Boolean).pop() || path;

const getFileDir = (path: string): string => {
  const parts = path.split('/');
  return parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';
};

const getFirstMismatchIndex = (left: string, right: string): number => {
  const boundary = Math.min(left.length, right.length);
  for (let index = 0; index < boundary; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return left.length === right.length ? -1 : boundary;
};

const isDiffDebugEnabled = (): boolean =>
  Boolean(import.meta.env?.DEV) &&
  typeof window !== 'undefined' &&
  window.localStorage.getItem(DEBUG_FILE_DIFF_STORAGE_KEY) === '1';

const STATUS_META = {
  added: {
    color: 'text-emerald-500',
    bg: 'bg-emerald-500/10',
  },
  modified: {
    color: 'text-amber-500',
    bg: 'bg-amber-500/10',
  },
  deleted: {
    color: 'text-destructive',
    bg: 'bg-destructive/10',
  },
} as const;

export const FileChangesDiffModal: React.FC<FileChangesDiffModalProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const titleId = useId();
  const session = useFileChangesStore((state) => state.diffModalSession);
  const repository = useFileChangesStore((state) => {
    const currentSession = state.diffModalSession;
    return currentSession
      ? state.repositories.find((candidate) => candidate.id === currentSession.repositoryId)
      : undefined;
  });
  const change = useFileChangesStore((state) => {
    const currentSession = state.diffModalSession;
    if (!currentSession) {
      return undefined;
    }
    return state.repositories
      .find((candidate) => candidate.id === currentSession.repositoryId)
      ?.changes.find((candidate) => candidate.id === currentSession.changeId);
  });
  const markAsReviewed = useFileChangesStore((state) => state.markAsReviewed);
  const markAsUnreviewed = useFileChangesStore((state) => state.markAsUnreviewed);
  const revertChanges = useFileChangesStore((state) => state.revertChanges);
  const updateRightDraft = useFileChangesStore((state) => state.updateRightDraft);
  const resetRightDraft = useFileChangesStore((state) => state.resetRightDraft);
  const saveRightDraft = useFileChangesStore((state) => state.saveRightDraft);
  const openDiffModal = useFileChangesStore((state) => state.openDiffModal);

  const [pendingChangeId, setPendingChangeId] = useState<string | null>(null);
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false);
  const [presentationMode, setPresentationMode] = useState<DiffPresentationMode>('focused');

  const isHydrating = Boolean(
    session?.isHydratingFullContext || (repository && change && repository.loadingChangeId === change.id)
  );
  const isSaving = Boolean(session?.isSaving || (repository && change && repository.savingChangeId === change.id));
  const isBusy = isHydrating || isSaving;
  const isDirty = session?.isDirty === true;
  const diffLayout: 'split' | 'left-only' | 'right-only' = change?.status === 'added'
    ? 'right-only'
    : change?.status === 'deleted'
      ? 'left-only'
      : 'split';
  const showPresentationControls = diffLayout === 'split';
  const effectivePresentationMode: DiffPresentationMode = showPresentationControls ? presentationMode : 'full';
  const canEdit = Boolean(change?.canEdit && session && !isHydrating && effectivePresentationMode === 'full');
  const canRevertChunks = Boolean(
    diffLayout === 'split' && change?.canEdit && !change?.reviewed && !isHydrating
  );

  useEffect(() => {
    if (!session) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [session]);

  useEffect(() => {
    let cancelled = false;

    void loadPreference<DiffPresentationMode>(PREF_KEYS.IMPLEMENT_DIFF_PRESENTATION_MODE).then((value) => {
      if (!cancelled && (value === 'focused' || value === 'full')) {
        setPresentationMode(value);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    if (!session || !repository || !change || !isDiffDebugEnabled()) {
      return;
    }

    const original = session.originalContent;
    const modified = session.rightDraftContent;

    console.groupCollapsed(`[FileChangesDiffModal] Diff inputs for ${change.path}`);
    console.log({
      repositoryId: session.repositoryId,
      changeId: session.changeId,
      presentationMode,
      effectivePresentationMode,
      diffLayout,
      isHydrating,
      isDirty,
      originalLength: original.length,
      modifiedLength: modified.length,
      sameString: original === modified,
      firstMismatchIndex: getFirstMismatchIndex(original, modified),
    });
    console.groupEnd();
  }, [change, diffLayout, effectivePresentationMode, isDirty, isHydrating, presentationMode, repository, session]);

  const attemptClose = useCallback(() => {
    if (isDirty) {
      setPendingChangeId('close');
      setIsConfirmingDiscard(true);
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  const handleConfirmDiscard = useCallback(() => {
    setIsConfirmingDiscard(false);
    resetRightDraft();

    if (pendingChangeId === 'close') {
      onClose();
    } else if (pendingChangeId && repository) {
      openDiffModal(repository.id, pendingChangeId);
    }

    setPendingChangeId(null);
  }, [onClose, openDiffModal, pendingChangeId, repository, resetRightDraft]);

  const handleCancelDiscard = useCallback(() => {
    setIsConfirmingDiscard(false);
    setPendingChangeId(null);
  }, []);

  useEffect(() => {
    if (!session) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      attemptClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [attemptClose, session]);

  const handleValidate = useCallback(async () => {
    if (!repository || !change || isBusy || isDirty) return;
    await markAsReviewed(repository.id, change.id);
    onClose();
  }, [change, isBusy, isDirty, markAsReviewed, onClose, repository]);

  const handleInvalidate = useCallback(() => {
    if (!repository || !change || isBusy || isDirty) return;
    markAsUnreviewed(repository.id, change.id);
  }, [change, isBusy, isDirty, markAsUnreviewed, repository]);

  const handleRevert = useCallback(async () => {
    if (!repository || !change || isBusy || isDirty || change.reviewed) return;
    await revertChanges(repository.id, [change.id]);
  }, [change, isBusy, isDirty, repository, revertChanges]);

  const handleNavigation = useCallback((changeId: string) => {
    if (!repository) return;

    if (isDirty) {
      setPendingChangeId(changeId);
      setIsConfirmingDiscard(true);
      return;
    }

    openDiffModal(repository.id, changeId);
  }, [isDirty, openDiffModal, repository]);

  const handlePresentationModeChange = useCallback((nextMode: DiffPresentationMode) => {
    if (isBusy || isDirty || presentationMode === nextMode) {
      return;
    }

    setPresentationMode(nextMode);
    void savePreference(PREF_KEYS.IMPLEMENT_DIFF_PRESENTATION_MODE, nextMode);
  }, [isBusy, isDirty, presentationMode]);

  const handleDebugEditorReady = useCallback((editor: MergeViewEditorHandle | null) => {
    if (!editor || !session || !change || !isDiffDebugEnabled()) {
      return;
    }

    const actualOriginal = editor.a.state.doc.toString();
    const actualModified = editor.b.state.doc.toString();

    console.groupCollapsed(`[FileChangesDiffModal] MergeView mounted for ${change.path}`);
    console.log({
      repositoryId: session.repositoryId,
      changeId: session.changeId,
      presentationMode,
      effectivePresentationMode,
      diffLayout,
      actualOriginalLength: actualOriginal.length,
      actualModifiedLength: actualModified.length,
      sameString: actualOriginal === actualModified,
      firstMismatchIndex: getFirstMismatchIndex(actualOriginal, actualModified),
    });
    console.groupEnd();
  }, [change, diffLayout, effectivePresentationMode, presentationMode, session]);

  if (!session || !repository || !change) {
    return null;
  }

  const contextOptions: Array<{ mode: DiffPresentationMode; label: string }> = [
    { mode: 'focused', label: t('implement.context.default', 'Focused diff') },
    { mode: 'full', label: t('implement.context.full', 'Full file context') },
  ];
  const hasRenderableTextDiff = (
    change.hunks.length > 0 ||
    (change.status === 'added' && change.additions > 0) ||
    (change.status === 'deleted' && change.deletions > 0)
  );

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-background/50 p-4 pt-12 backdrop-blur-sm sm:p-6 sm:pt-14"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) attemptClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="relative z-0 flex h-[calc(100vh-4rem)] w-[calc(100vw-2rem)] max-h-[min(940px,calc(100vh-4rem))] max-w-[1800px] overflow-hidden rounded-xl bg-background shadow-2xl ring-1 ring-border/10 sm:h-[calc(100vh-5rem)] sm:w-[calc(100vw-3rem)]">
        <aside className="flex w-[200px] shrink-0 flex-col bg-muted/10">
          <div className="p-4">
            <h3 className="truncate text-sm font-semibold tracking-tight">{repository.branchName}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {repository.stats.reviewed} / {repository.stats.total} {t('implement.validatedFiles', 'files validated')}
            </p>
          </div>

          <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
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

        <main className="flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex shrink-0 items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-3 pr-4">
              <div className="min-w-0">
                <h2 id={titleId} className="truncate text-sm font-medium leading-tight">
                  <span className="text-muted-foreground">{getFileDir(change.path) || '/'}</span>
                  <span className="text-foreground">{getFileLabel(change.path)}</span>
                </h2>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-4">
              {showPresentationControls && (
                <div className="flex items-center rounded-lg border border-border bg-muted/20 p-1">
                  {contextOptions.map((option) => (
                    <Button
                      key={option.mode}
                      variant={presentationMode === option.mode ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => handlePresentationModeChange(option.mode)}
                      disabled={isBusy || isDirty}
                      className={cn(
                        'h-7 px-2.5 text-xs',
                        presentationMode === option.mode ? 'shadow-sm' : ''
                      )}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              )}
              <Button variant="ghost" size="sm" onClick={attemptClose} aria-label={t('common.close', 'Close')}>
                <Icon name="x" size={16} />
              </Button>
            </div>
          </header>

          <div className="relative min-h-0 flex-1 bg-muted/5">
            {repository.lastError && (
              <div className="absolute inset-x-4 top-4 z-20 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {repository.lastError}
              </div>
            )}

            {isHydrating ? (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 p-6">
                <div className="flex items-center gap-3">
                  <Icon name="loader" size={20} className="animate-spin text-primary" />
                  <span className="text-sm font-medium text-muted-foreground">
                    {t('implement.loadingFileDiff', 'Loading file diff...')}
                  </span>
                </div>
                <div className="w-full max-w-md space-y-2">
                  <div className="h-3 animate-pulse rounded bg-muted/40" />
                  <div className="h-3 w-4/5 animate-pulse rounded bg-muted/30" />
                  <div className="h-3 w-3/5 animate-pulse rounded bg-muted/20" />
                </div>
              </div>
            ) : !hasRenderableTextDiff ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {t('implement.noTextualDiff', 'No textual diff is available for this file.')}
              </div>
            ) : (
              <DiffMergeView
                key={change.id}
                original={session.originalContent}
                modified={session.rightDraftContent}
                language={change.language}
                layout={diffLayout}
                presentationMode={effectivePresentationMode}
                className="h-full w-full border-none md:border-none"
                editable={canEdit}
                autoFocus={canEdit}
                onChange={(value) => {
                  if (canEdit) {
                    updateRightDraft(value);
                  }
                }}
                onEditorReady={handleDebugEditorReady}
                revertControls={canRevertChunks ? 'a-to-b' : undefined}
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
              {isDirty ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => resetRightDraft()}
                    disabled={!canEdit || isSaving}
                  >
                    {t('implement.resetDraft', 'Reset draft')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void saveRightDraft()}
                    disabled={isSaving}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {t('implement.saveDraft', 'Save draft')}
                  </Button>
                </>
              ) : change.reviewed ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleInvalidate}
                  disabled={isBusy}
                >
                  {t('implement.invalidateAction', 'Invalidate')}
                </Button>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleRevert()}
                    disabled={isBusy}
                  >
                    {t('implement.revertAction', 'Revert')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleValidate()}
                    disabled={isBusy || change.reviewed}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {t('implement.validateFile', 'Validate file')}
                  </Button>
                </>
              )}
            </div>
          </footer>
        </main>
      </div>

      {isConfirmingDiscard && (
        <ConfirmPromptModal
          isOpen={isConfirmingDiscard}
          title={t('implement.discardChangesTitle', 'Discard unsaved changes?')}
          description={t(
            'implement.discardChangesDesc',
            'You have made edits to this file. Are you sure you want to discard them?'
          )}
          confirmLabel={t('implement.discardButton', 'Discard changes')}
          cancelLabel={t('common.cancel', 'Cancel')}
          onConfirm={handleConfirmDiscard}
          onCancel={handleCancelDiscard}
          confirmVariant="error"
        />
      )}
    </div>
  );
};
