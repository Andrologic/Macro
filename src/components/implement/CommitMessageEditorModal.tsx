import React from 'react';
import { ALLOWED_COMMIT_TYPES, type ConventionalCommitFields, type ConventionalCommitType } from '../../services/conventionalCommit';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';

type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

export type CommitMessageEditorMode = 'review_generated' | 'manual_fallback';

export interface CommitMessageEditorRepository {
  id: string;
  label: string;
}

interface CommitMessageEditorModalProps {
  t: TranslateFn;
  mode: CommitMessageEditorMode;
  error: string | null;
  fieldsByRepositoryId: Record<string, ConventionalCommitFields>;
  repositories: CommitMessageEditorRepository[];
  validationsByRepositoryId: Record<string, { ok: boolean; message?: string }>;
  isCommitting: boolean;
  isGeneratingCommitMessages: boolean;
  hasInvalidMessage: boolean;
  onCancel: () => void;
  onRetryGeneration: () => void;
  onCommit: () => void;
  onUpdateFields: (repositoryId: string, patch: Partial<ConventionalCommitFields>) => void;
}

export const CommitMessageEditorModal: React.FC<CommitMessageEditorModalProps> = ({
  t,
  mode,
  error,
  fieldsByRepositoryId,
  repositories,
  validationsByRepositoryId,
  isCommitting,
  isGeneratingCommitMessages,
  hasInvalidMessage,
  onCancel,
  onRetryGeneration,
  onCommit,
  onUpdateFields,
}) => {
  const repositoryLabelsById = Object.fromEntries(
    repositories.map((repository) => [repository.id, repository.label])
  );
  const titleId = 'commit-message-editor-title';

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <h3 id={titleId} className="text-sm font-semibold text-foreground">
            {mode === 'manual_fallback'
              ? t('implement.commitMessageManualTitle', 'Write commit messages')
              : t('implement.commitMessageEditTitle', 'Review commit messages')}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {mode === 'manual_fallback'
              ? t(
                  'implement.commitMessageManualDescription',
                  'Write a Conventional Commit message for each repository, then commit.'
                )
              : t(
                  'implement.commitMessageEditDescription',
                  'The generated message did not pass Conventional Commits validation. Edit it before committing.'
                )}
          </p>
          {error && (
            <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="mt-4 space-y-4">
            {Object.entries(fieldsByRepositoryId).map(([repositoryId, fields]) => {
              const validation = validationsByRepositoryId[repositoryId];
              const updateFields = (patch: Partial<ConventionalCommitFields>) => {
                onUpdateFields(repositoryId, patch);
              };

              return (
                <div key={repositoryId} className="space-y-2 rounded-lg border border-border bg-muted/10 p-3">
                  <div className="text-xs font-medium text-muted-foreground">
                    {repositoryLabelsById[repositoryId] || repositoryId}
                  </div>
                  <div className="grid gap-2 md:grid-cols-[120px]">
                    <label className="space-y-1">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {t('implement.commitMessageTypeLabel', 'Type')}
                      </span>
                      <select
                        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
                        value={fields.type}
                        onChange={(event) => updateFields({ type: event.target.value as ConventionalCommitType })}
                      >
                        {ALLOWED_COMMIT_TYPES.map((type) => (
                          <option key={type} value={type}>{type}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {t('implement.commitMessageSubjectLabel', 'Subject')}
                    </span>
                    <input
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
                      value={fields.subject}
                      onChange={(event) => updateFields({ subject: event.target.value })}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {t('implement.commitMessageBodyLabel', 'Body')}
                    </span>
                    <Textarea
                      rows={4}
                      value={fields.body ?? ''}
                      error={!!validation && !validation.ok}
                      placeholder={t('implement.commitMessageBodyPlaceholder', 'Optional details')}
                      onChange={(event) => updateFields({ body: event.target.value || null })}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={Boolean(fields.breaking)}
                      onChange={(event) => updateFields({ breaking: event.target.checked })}
                    />
                    {t('implement.commitMessageBreakingLabel', 'Breaking change')}
                  </label>
                  {validation && !validation.ok && (
                    <span className="text-xs text-destructive">{validation.message}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={isCommitting}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetryGeneration}
            disabled={isCommitting || isGeneratingCommitMessages}
          >
            {t('implement.retryGeneration', 'Retry generation')}
          </Button>
          <Button
            size="sm"
            onClick={onCommit}
            disabled={isCommitting || hasInvalidMessage}
          >
            {t('implement.commitChangesGeneric', 'Commit')}
          </Button>
        </div>
      </div>
    </div>
  );
};
