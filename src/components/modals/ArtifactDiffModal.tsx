import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArchitectPlanRecord } from '../../services/architectPlanService';
import type { CatalogedImplementTask } from '../../services/implementTaskCatalog';
import {
  putTaskArtifact,
  readVisibleTaskArtifactDiff,
  type VisiblePlanTaskArtifactDiff,
  type VisiblePlanTaskArtifactReviewEntry,
} from '../../services/architectPlanArtifactService';
import { cn } from '../../utils/cn';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import { Button } from '../ui/Button';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { DiffMergeView } from '../ui/DiffMergeView';
import { Icon } from '../ui/Icon';

interface ArtifactDiffModalProps {
  branchName: string;
  plan: ArchitectPlanRecord;
  task: CatalogedImplementTask;
  entries: VisiblePlanTaskArtifactReviewEntry[];
  artifactId: string;
  onSelectArtifact: (artifactId: string) => void;
  onValidate: (artifactId: string) => Promise<void> | void;
  onUnvalidate: (artifactId: string) => Promise<void> | void;
  onArtifactSaved: (artifactId: string) => Promise<void> | void;
  onClose: () => void;
}

type ArtifactViewMode = 'preview' | 'code';
type PendingDiscardAction =
  | { type: 'close' }
  | { type: 'select'; artifactId: string };

const getArtifactLanguage = (contentType: string): string =>
  contentType === 'json' ? 'javascript' : 'text';

const getArtifactPathLabel = (path: string): string =>
  path.split('/').filter(Boolean).slice(-2).join('/') || path;

export const ArtifactDiffModal: React.FC<ArtifactDiffModalProps> = ({
  branchName,
  plan,
  task,
  entries,
  artifactId,
  onSelectArtifact,
  onValidate,
  onUnvalidate,
  onArtifactSaved,
  onClose,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const [diff, setDiff] = useState<VisiblePlanTaskArtifactDiff | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [activeView, setActiveView] = useState<ArtifactViewMode>('code');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutatingReview, setIsMutatingReview] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDiscardAction, setPendingDiscardAction] = useState<PendingDiscardAction | null>(null);

  const activeEntry = useMemo(
    () => entries.find((entry) => entry.artifact.id === artifactId) || null,
    [artifactId, entries],
  );
  const isDirty = Boolean(diff && draftContent !== diff.content);
  const canPreviewMarkdown = diff?.artifact.contentType === 'markdown';
  const showCode = Boolean(diff && !isLoading && !error && activeView === 'code');
  const showPreview = Boolean(diff && !isLoading && !error && activeView === 'preview' && canPreviewMarkdown);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) {
      setPendingDiscardAction({ type: 'close' });
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  const requestSelectArtifact = useCallback((nextArtifactId: string) => {
    if (nextArtifactId === artifactId) return;
    if (isDirty) {
      setPendingDiscardAction({ type: 'select', artifactId: nextArtifactId });
      return;
    }
    onSelectArtifact(nextArtifactId);
  }, [artifactId, isDirty, onSelectArtifact]);

  const handleCancelDiscard = useCallback(() => {
    setPendingDiscardAction(null);
  }, []);

  const handleConfirmDiscard = useCallback(() => {
    const action = pendingDiscardAction;
    setPendingDiscardAction(null);
    if (!action) return;
    if (action.type === 'close') {
      onClose();
      return;
    }
    onSelectArtifact(action.artifactId);
  }, [onClose, onSelectArtifact, pendingDiscardAction]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      requestClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

  useEffect(() => {
    let disposed = false;
    setIsLoading(true);
    setError(null);
    setDiff(null);
    void readVisibleTaskArtifactDiff({
      branchName,
      plan,
      task,
      artifactId,
    })
      .then((result) => {
        if (!disposed) {
          setDiff(result);
          setDraftContent(result.content);
          setActiveView(result.artifact.contentType === 'markdown' ? 'preview' : 'code');
        }
      })
      .catch((loadError) => {
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : t('common.error', 'An error occurred'));
        }
      })
      .finally(() => {
        if (!disposed) {
          setIsLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [artifactId, branchName, plan, task, t]);

  const handleValidate = useCallback(async () => {
    if (!activeEntry || isMutatingReview) return;
    setIsMutatingReview(true);
    try {
      await onValidate(activeEntry.artifact.id);
    } finally {
      setIsMutatingReview(false);
    }
  }, [activeEntry, isMutatingReview, onValidate]);

  const handleUnvalidate = useCallback(async () => {
    if (!activeEntry || isMutatingReview) return;
    setIsMutatingReview(true);
    try {
      await onUnvalidate(activeEntry.artifact.id);
    } finally {
      setIsMutatingReview(false);
    }
  }, [activeEntry, isMutatingReview, onUnvalidate]);

  const handleSave = useCallback(async () => {
    if (!diff || isSaving || draftContent.trim().length === 0 || draftContent === diff.content) {
      return;
    }
    const artifact = diff.artifact;
    const isInherited = artifact.visibility === 'inherited';
    setIsSaving(true);
    setError(null);
    try {
      const savedArtifact = await putTaskArtifact({
        target: {
          branchName,
          plan,
          task,
          currentTask: task,
        },
        args: {
          title: artifact.title,
          kind: artifact.kind,
          summary: artifact.summary,
          content_type: artifact.contentType,
          content: draftContent,
          ...(isInherited ? {} : { artifact_id: artifact.id }),
          ...(isInherited ? { supersedes_artifact_id: artifact.id } : {}),
          ...(!isInherited && artifact.contractId ? { contract_id: artifact.contractId } : {}),
        },
        createdBy: 'user',
      });

      if (savedArtifact.id === artifact.id) {
        setDiff((current) =>
          current && current.artifact.id === artifact.id
            ? {
                ...current,
                artifact: {
                  ...savedArtifact,
                  visibility: 'own',
                },
                content: draftContent,
              }
            : current,
        );
      }

      await onArtifactSaved(savedArtifact.id);
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? saveError.message
          : t('implement.artifacts.saveFailed', 'Failed to save artifact.');
      setError(message);
    } finally {
      setIsSaving(false);
    }
  }, [branchName, diff, draftContent, isSaving, onArtifactSaved, plan, task, t]);

  const artifact = diff?.artifact || activeEntry?.artifact || null;
  const sourceNode = artifact ? plan.nodes.find((node) => node.id === artifact.taskId) : null;
  const layout = diff?.status === 'modified' ? 'split' : 'right-only';
  const canSave = Boolean(diff && isDirty && draftContent.trim().length > 0 && !isLoading && !isSaving);

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-background/95 p-4 pt-12 sm:p-6 sm:pt-14"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="relative z-0 flex h-[calc(100vh-4rem)] w-[calc(100vw-2rem)] max-h-[min(940px,calc(100vh-4rem))] max-w-[1800px] overflow-hidden rounded-xl bg-background shadow-2xl ring-1 ring-border/10 sm:h-[calc(100vh-5rem)] sm:w-[calc(100vw-3rem)]">
        <aside className="flex w-[220px] shrink-0 flex-col bg-muted/10">
          <div className="p-4">
            <h3 className="truncate text-sm font-semibold tracking-tight">
              {t('implement.artifacts.title', 'Artifacts')}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('implement.artifacts.diffModalCount', '{{count}} visible artifact(s)', {
                count: entries.length,
              })}
            </p>
          </div>

          <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {entries.map((entry) => {
              const current = entry.artifact.id === artifactId;
              return (
                <button
                  key={entry.artifact.id}
                  type="button"
                  onClick={() => requestSelectArtifact(entry.artifact.id)}
                  disabled={current || isMutatingReview}
                  className={cn(
                    'group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    current
                      ? 'bg-primary/10 text-foreground ring-1 ring-primary/20'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                  title={entry.artifact.title}
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-primary/10 text-[10px] font-bold text-primary">
                    {entry.artifact.visibility === 'own' ? '+' : 'I'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{entry.artifact.title}</span>
                    <span className="block truncate text-[11px] opacity-70">{entry.artifact.kind}</span>
                  </span>
                  <span className="mt-1 flex shrink-0 items-center gap-1">
                    {entry.hasValidatedReview && (
                      <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
                        {t('implement.artifacts.validatedBadge', 'Validated')}
                      </span>
                    )}
                    {entry.hasPendingReview && (
                      <span
                        data-pending-validation-indicator="true"
                        className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                      />
                    )}
                  </span>
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
                  {artifact ? artifact.title : t('implement.artifacts.title', 'Artifacts')}
                </h2>
                {artifact && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {sourceNode?.title || artifact.taskId}
                    <span className="px-1.5">/</span>
                    {getArtifactPathLabel(artifact.path)}
                  </p>
                )}
              </div>
              {artifact && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    {artifact.kind}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                      artifact.visibility === 'own'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {artifact.visibility === 'own'
                      ? t('implement.artifacts.newBadge', 'new')
                      : t('implement.artifacts.inheritedBadge', 'hérité')}
                  </span>
                </div>
              )}
            </div>
            {artifact && (
              <div className="flex shrink-0 items-center rounded-md border border-border bg-muted/40 p-0.5">
                {canPreviewMarkdown && (
                  <button
                    type="button"
                    data-artifact-view-tab="preview"
                    onClick={() => setActiveView('preview')}
                    className={cn(
                      'h-7 rounded px-2.5 text-xs font-medium transition-colors',
                      activeView === 'preview'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t('implement.artifacts.previewTab', 'Preview')}
                  </button>
                )}
                <button
                  type="button"
                  data-artifact-view-tab="code"
                  onClick={() => setActiveView('code')}
                  className={cn(
                    'h-7 rounded px-2.5 text-xs font-medium transition-colors',
                    activeView === 'code'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t('implement.artifacts.codeTab', 'Code')}
                </button>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={requestClose} aria-label={t('common.close', 'Close')}>
              <Icon name="x" size={16} />
            </Button>
          </header>

          <div className="relative min-h-0 flex-1 bg-muted/5">
            {isLoading && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 p-6">
                <div className="flex items-center gap-3">
                  <Icon name="loader" size={20} className="animate-spin text-primary" />
                  <span className="text-sm font-medium text-muted-foreground">
                    {t('implement.artifacts.loadingDiff', 'Loading artifact diff...')}
                  </span>
                </div>
              </div>
            )}
            {error && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center">
                <Icon name="triangle-alert" size={24} className="text-destructive" />
                <p className="max-w-md text-sm text-destructive">{error}</p>
              </div>
            )}
            {showPreview && (
              <div
                data-artifact-markdown-preview="true"
                className="h-full overflow-y-auto px-6 py-5"
              >
                <MarkdownRenderer
                  content={draftContent}
                  className="mx-auto max-w-4xl text-sm leading-relaxed"
                />
              </div>
            )}
            {showCode && diff && (
              <DiffMergeView
                key={diff.artifact.id}
                original={diff.previousContent}
                modified={draftContent}
                language={getArtifactLanguage(diff.artifact.contentType)}
                layout={layout}
                presentationMode="full"
                className="h-full w-full border-none md:border-none"
                editable
                autoFocus={activeView === 'code'}
                onChange={setDraftContent}
              />
            )}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 bg-card/95 px-6 py-4">
            <div className="text-xs text-muted-foreground">
              {isDirty
                ? t('implement.unsavedDraft', 'Unsaved draft. Save to validate or reset.')
                : activeEntry?.hasValidatedReview
                ? t('implement.artifacts.validatedHelp', 'This artifact has been validated for the current task.')
                : t('implement.artifacts.reviewHelp', 'Validate the artifact after reviewing its content.')}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleSave()}
                disabled={!canSave || isMutatingReview}
              >
                {isSaving
                  ? t('implement.artifacts.savingAction', 'Saving...')
                  : t('implement.artifacts.saveAction', 'Save')}
              </Button>
              {activeEntry?.hasValidatedReview ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleUnvalidate()}
                  disabled={isLoading || isMutatingReview || isSaving || isDirty}
                >
                  {t('implement.artifacts.unvalidateAction', 'Unvalidate')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleValidate()}
                  disabled={isLoading || isMutatingReview || isSaving || isDirty || !activeEntry}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {t('implement.artifacts.validateAction', 'Validate artifact')}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={requestClose} disabled={isMutatingReview || isSaving}>
                {t('common.close', 'Close')}
              </Button>
            </div>
          </footer>
        </main>
      </div>
      {pendingDiscardAction && (
        <ConfirmPromptModal
          isOpen={Boolean(pendingDiscardAction)}
          title={t('implement.artifacts.unsavedChangesTitle', 'Discard unsaved artifact changes?')}
          description={t(
            'implement.artifacts.unsavedChangesDescription',
            'You have unsaved edits to this artifact. Discard them to continue.'
          )}
          confirmLabel={t('implement.discardButton', 'Discard changes')}
          cancelLabel={t('common.cancel', 'Cancel')}
          confirmVariant="error"
          onConfirm={handleConfirmDiscard}
          onCancel={handleCancelDiscard}
        />
      )}
    </div>
  );
};

export default ArtifactDiffModal;
