import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArchitectPlanRecord } from '../../services/architectPlanService';
import type { CatalogedImplementTask } from '../../services/implementTaskCatalog';
import {
  readVisibleTaskArtifactDiff,
  type VisiblePlanTaskArtifactDiff,
  type VisiblePlanTaskArtifactReviewEntry,
} from '../../services/architectPlanArtifactService';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
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
  onClose: () => void;
}

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
  onClose,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const [diff, setDiff] = useState<VisiblePlanTaskArtifactDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutatingReview, setIsMutatingReview] = useState(false);

  const activeEntry = useMemo(
    () => entries.find((entry) => entry.artifact.id === artifactId) || null,
    [artifactId, entries],
  );

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

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

  const artifact = diff?.artifact || activeEntry?.artifact || null;
  const sourceNode = artifact ? plan.nodes.find((node) => node.id === artifact.taskId) : null;
  const layout = diff?.status === 'modified' ? 'split' : 'right-only';
  const showDiff = Boolean(diff && !isLoading && !error);

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-background/95 p-4 pt-12 sm:p-6 sm:pt-14"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
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
                  onClick={() => onSelectArtifact(entry.artifact.id)}
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
            <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('common.close', 'Close')}>
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
            {showDiff && diff && (
              <DiffMergeView
                key={diff.artifact.id}
                original={diff.previousContent}
                modified={diff.content}
                language={getArtifactLanguage(diff.artifact.contentType)}
                layout={layout}
                presentationMode="full"
                className="h-full w-full border-none md:border-none"
                editable={false}
                autoFocus={false}
              />
            )}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 bg-card/95 px-6 py-4">
            <div className="text-xs text-muted-foreground">
              {activeEntry?.hasValidatedReview
                ? t('implement.artifacts.validatedHelp', 'This artifact has been validated for the current task.')
                : t('implement.artifacts.reviewHelp', 'Validate the artifact after reviewing its content.')}
            </div>
            <div className="flex items-center gap-2">
              {activeEntry?.hasValidatedReview ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleUnvalidate()}
                  disabled={isLoading || isMutatingReview}
                >
                  {t('implement.artifacts.unvalidateAction', 'Unvalidate')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleValidate()}
                  disabled={isLoading || isMutatingReview || !activeEntry}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {t('implement.artifacts.validateAction', 'Validate artifact')}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={onClose} disabled={isMutatingReview}>
                {t('common.close', 'Close')}
              </Button>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
};

export default ArtifactDiffModal;
