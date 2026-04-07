import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from '@codemirror/view';
import { useTranslation } from 'react-i18next';
import { useFileChangesStore } from '../../stores/useFileChangesStore';
import { Icon } from '../ui/Icon';
import { CodeViewer } from '../ui/CodeViewer';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { buildSplitDiffRows } from '../../services/gitDiffParser';

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

type PendingAction = 'close' | 'previous' | 'next' | null;

const getScrollElement = (view: EditorView | null): HTMLElement | null => view?.scrollDOM ?? null;

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
    goToAdjacentDiff,
  } = useFileChangesStore();
  const session = getDiffModalSession();
  const repository = session ? getRepository(session.repositoryId) : undefined;
  const change = session ? getChange(session.repositoryId, session.changeId) : undefined;
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const leftViewRef = useRef<EditorView | null>(null);
  const rightViewRef = useRef<EditorView | null>(null);
  const syncingOwnerRef = useRef<'left' | 'right' | null>(null);

  const repositoryIndex = useMemo(() => {
    if (!repository || !change) return -1;
    return repository.changes.findIndex((candidate) => candidate.id === change.id);
  }, [repository, change]);

  const canGoPrevious = repositoryIndex > 0;
  const canGoNext = repositoryIndex >= 0 && !!repository && repositoryIndex < repository.changes.length - 1;
  const isHydrating = Boolean(
    session?.isHydratingFullContext || (repository && change && repository.loadingChangeId === change.id)
  );
  const isSaving = Boolean(session?.isSaving || (repository && change && repository.savingChangeId === change.id));
  const isBusy = isHydrating || isSaving;
  const isDirty = session?.isDirty === true;
  const canEdit = Boolean(change?.canEdit && session && !isHydrating);
  const lineHighlights = useMemo(() => {
    if (!change || !session) {
      return { left: [], right: [] };
    }

    const rows = buildSplitDiffRows(change.originalContent, session.rightDraftContent);
    const left = rows.flatMap((row) => (
      row.kind === 'removed' || row.kind === 'modified'
        ? row.leftLineNumber
          ? [{ lineNumber: row.leftLineNumber, className: 'cm-git-removed' }]
          : []
        : []
    ));
    const right = rows.flatMap((row) => (
      row.kind === 'added' || row.kind === 'modified'
        ? row.rightLineNumber
          ? [{ lineNumber: row.rightLineNumber, className: 'cm-git-added' }]
          : []
        : []
    ));

    return { left, right };
  }, [change, session]);

  useEffect(() => {
    if (!session) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [session]);

  useEffect(() => {
    if (!session) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (isDirty) {
        setPendingAction('close');
        return;
      }
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isDirty, onClose, session]);

  useEffect(() => {
    const leftScroll = getScrollElement(leftViewRef.current);
    const rightScroll = getScrollElement(rightViewRef.current);
    if (!leftScroll || !rightScroll) return;

    const syncVertical = (owner: 'left' | 'right', scrollTop: number, horizontalSource?: HTMLElement) => {
      if (syncingOwnerRef.current && syncingOwnerRef.current !== owner) {
        return;
      }

      syncingOwnerRef.current = owner;

      const nextLeftTop = Math.min(scrollTop, Math.max(0, leftScroll.scrollHeight - leftScroll.clientHeight));
      const nextRightTop = Math.min(scrollTop, Math.max(0, rightScroll.scrollHeight - rightScroll.clientHeight));

      if (leftScroll.scrollTop !== nextLeftTop) {
        leftScroll.scrollTop = nextLeftTop;
      }
      if (rightScroll.scrollTop !== nextRightTop) {
        rightScroll.scrollTop = nextRightTop;
      }

      if (horizontalSource === leftScroll && rightScroll.scrollLeft !== leftScroll.scrollLeft) {
        rightScroll.scrollLeft = leftScroll.scrollLeft;
      }
      if (horizontalSource === rightScroll && leftScroll.scrollLeft !== rightScroll.scrollLeft) {
        leftScroll.scrollLeft = rightScroll.scrollLeft;
      }

      requestAnimationFrame(() => {
        if (syncingOwnerRef.current === owner) {
          syncingOwnerRef.current = null;
        }
      });
    };

    const onLeftScroll = () => syncVertical('left', leftScroll.scrollTop, leftScroll);
    const onRightScroll = () => syncVertical('right', rightScroll.scrollTop, rightScroll);

    leftScroll.addEventListener('scroll', onLeftScroll);
    rightScroll.addEventListener('scroll', onRightScroll);

    return () => {
      leftScroll.removeEventListener('scroll', onLeftScroll);
      rightScroll.removeEventListener('scroll', onRightScroll);
    };
  }, [session?.changeId]);

  if (!session || !repository || !change) {
    return null;
  }

  const attemptAction = (action: Exclude<PendingAction, null>) => {
    if (isDirty) {
      setPendingAction(action);
      return;
    }

    if (action === 'close') {
      onClose();
      return;
    }

    goToAdjacentDiff(action);
  };

  const handleConfirmDiscard = () => {
    const action = pendingAction;
    setPendingAction(null);
    if (!action) return;

    if (action === 'close') {
      onClose();
      return;
    }

    goToAdjacentDiff(action);
  };

  const handleValidate = () => {
    if (isBusy || isDirty) return;
    markAsReviewed(repository.id, change.id);
    onClose();
  };

  const backdrop = (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        attemptAction('close');
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-diff-modal-title"
    >
      <div className="flex h-[92vh] w-[96vw] max-w-[1680px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="sticky top-0 z-10 border-b border-border bg-card/95 px-6 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                    change.status === 'added'
                      ? 'bg-emerald-500/10 text-emerald-500'
                      : change.status === 'modified'
                        ? 'bg-amber-500/10 text-amber-500'
                        : 'bg-red-500/10 text-red-500'
                  )}
                >
                  <Icon
                    name={change.status === 'added' ? 'plus' : change.status === 'modified' ? 'edit' : 'trash'}
                    size={18}
                  />
                </div>
                <div className="min-w-0">
                  <h2 id="file-diff-modal-title" className="truncate text-base font-semibold text-foreground">
                    {change.path}
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5">
                      {t(`implement.changeStatus.${change.status}`, STATUS_LABELS[change.status])}
                    </span>
                    <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5">
                      {t(`implement.context.${change.contextMode}`, CONTEXT_LABELS[change.contextMode])}
                    </span>
                    <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5">
                      {repository.branchName}
                    </span>
                    <span className="font-mono text-emerald-500">+{change.additions}</span>
                    <span className="font-mono text-red-400">-{change.deletions}</span>
                    <span>
                      {repositoryIndex + 1}/{repository.changes.length}
                    </span>
                    {change.reviewed && (
                      <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-500">
                        {t('implement.validated', 'Validated')}
                      </span>
                    )}
                    {isDirty && (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-500">
                        {t('implement.unsavedDraft', 'Unsaved draft')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => attemptAction('previous')}
                disabled={!canGoPrevious || isSaving}
              >
                <Icon name="chevron-left" size={14} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => attemptAction('next')}
                disabled={!canGoNext || isSaving}
              >
                <Icon name="chevron-right" size={14} />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => attemptAction('close')}>
                <Icon name="x" size={14} />
              </Button>
            </div>
          </div>
        </header>

        {repository.lastError && (
          <div className="border-b border-border bg-red-500/5 px-6 py-3 text-sm text-red-500">
            {repository.lastError}
          </div>
        )}

        <div className="flex-1 overflow-hidden bg-background">
          {isHydrating && (
            <div className="border-b border-border bg-primary/5 px-6 py-3 text-sm text-primary">
              {t(
                'implement.loadingFullContextForEditing',
                'Loading the full file before enabling editing on the right side...'
              )}
            </div>
          )}
          {!change.canEdit && (
            <div className="border-b border-border bg-muted/40 px-6 py-3 text-sm text-muted-foreground">
              {t(
                'implement.deletedChangeReadOnlyValidation',
                'Deleted files are read-only in this validation flow.'
              )}
            </div>
          )}
          {change.hunks.length === 0 && (
            <div className="border-b border-border bg-muted/40 px-6 py-3 text-sm text-muted-foreground">
              {t(
                'implement.noTextualDiff',
                'No textual diff is available for this file. The split view falls back to full-file content.'
              )}
            </div>
          )}

          <div className="grid h-full min-h-0 grid-cols-1 divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            <section className="flex min-h-0 flex-col">
              <div className="border-b border-border bg-muted/30 px-4 py-2">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  <Icon name="file-code" size={12} />
                  {t('diffViewer.before', 'Before')}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden bg-card">
                <CodeViewer
                  code={change.originalContent}
                  language={change.language}
                  className="h-full border-0 rounded-none"
                  wrapLines={false}
                  lineHighlights={lineHighlights.left}
                  hideVerticalScrollbar
                  onEditorReady={(view) => {
                    leftViewRef.current = view;
                  }}
                />
              </div>
            </section>

            <section className="flex min-h-0 flex-col">
              <div className="border-b border-border bg-muted/30 px-4 py-2">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  <Icon name={canEdit ? 'edit' : 'lock'} size={12} />
                  {t('diffViewer.after', 'After')}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden bg-card">
                <CodeViewer
                  code={session.rightDraftContent}
                  language={change.language}
                  className="h-full border-0 rounded-none"
                  readOnly={!canEdit || isSaving}
                  wrapLines={false}
                  autoFocus={canEdit}
                  lineHighlights={lineHighlights.right}
                  onChange={(value) => updateRightDraft(value)}
                  onEditorReady={(view) => {
                    rightViewRef.current = view;
                  }}
                />
              </div>
            </section>
          </div>
        </div>

        <footer className="sticky bottom-0 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-card/95 px-6 py-4 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {change.hunks.length} {t('implement.hunks', 'hunks')}
            </span>
            {session.isHydratingFullContext && (
              <span>{t('implement.preparingEditor', 'Preparing editor...')}</span>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {change.contextMode !== 'full' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadChangeContext(repository.id, change.id, 'full')}
                disabled={isBusy || isDirty}
              >
                <Icon name={isHydrating ? 'loader' : 'expand'} size={14} className={isHydrating ? 'animate-spin' : undefined} />
                {t('implement.loadMoreContext', 'Load more context')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => resetRightDraft()}
              disabled={!canEdit || !isDirty || isSaving}
            >
              {t('implement.resetDraft', 'Reset draft')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void saveRightDraft()}
              disabled={!canEdit || !isDirty || isBusy}
            >
              {isSaving ? t('implement.savingChanges', 'Saving...') : t('implement.saveRightSide', 'Save right side')}
            </Button>
            <Button
              variant="success"
              size="sm"
              onClick={handleValidate}
              disabled={isBusy || isDirty}
            >
              {t('implement.validateFile', 'Validate')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => attemptAction('close')}>
              {t('common.close', 'Close')}
            </Button>
          </div>
        </footer>
      </div>

      <ConfirmPromptModal
        isOpen={pendingAction !== null}
        title={t('implement.discardUnsavedChangesTitle', 'Discard unsaved changes?')}
        description={t(
          'implement.discardUnsavedChangesDescription',
          'Your edits on the right side have not been saved yet. This action will discard them.'
        )}
        confirmLabel={t('implement.discardChanges', 'Discard changes')}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant="error"
        onCancel={() => setPendingAction(null)}
        onConfirm={() => handleConfirmDiscard()}
      />
    </div>
  );

  return createPortal(backdrop, document.body);
};

export default FileChangesDiffModal;
