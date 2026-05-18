import React from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { Button } from '../ui/Button';

type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

interface CommitMessageGenerationFailureModalProps {
  t: TranslateFn;
  error: string;
  isGeneratingCommitMessages: boolean;
  onRetryGeneration: () => void;
  onWriteManually: () => void;
  onOpenCommitModelSettings: () => void;
  onCancel: () => void;
}

interface FailureActionButtonProps {
  icon: IconName;
  title: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}

const FailureActionButton: React.FC<FailureActionButtonProps> = ({
  icon,
  title,
  description,
  disabled,
  onClick,
}) => (
  <button
    type="button"
    className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-3 text-left text-foreground transition-colors hover:border-primary/50 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
    disabled={disabled}
    onClick={onClick}
  >
    <Icon name={icon} size={14} className="mt-0.5 shrink-0 text-primary" />
    <span className="min-w-0">
      <span className="block font-medium">{title}</span>
      <span className="mt-1 block text-xs leading-4 text-muted-foreground">
        {description}
      </span>
    </span>
  </button>
);

export const CommitMessageGenerationFailureModal: React.FC<CommitMessageGenerationFailureModalProps> = ({
  t,
  error,
  isGeneratingCommitMessages,
  onRetryGeneration,
  onWriteManually,
  onOpenCommitModelSettings,
  onCancel,
}) => {
  const titleId = 'commit-message-generation-failure-title';

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => {
          if (!isGeneratingCommitMessages) {
            onCancel();
          }
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <Icon name="triangle-alert" size={16} />
            </div>
            <div className="min-w-0">
              <h3 id={titleId} className="text-sm font-semibold text-foreground">
                {t('implement.commitMessageGenerationTitle', 'Couldn’t generate commit messages')}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {t(
                  'implement.commitMessageGenerationDescription',
                  'Your changes are ready to commit, but Macro could not prepare the AI-generated messages.'
                )}
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-border bg-muted/20 px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <Icon name="alert-circle" size={12} />
              {t('implement.commitMessageGenerationDetails', 'Details')}
            </div>
            <p className="break-words text-xs leading-5 text-muted-foreground">
              {error}
            </p>
          </div>

          <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
            <FailureActionButton
              icon="refresh-cw"
              title={t('implement.retryGeneration', 'Retry generation')}
              description={t('implement.retryGenerationHelp', 'Try again with the current metadata model.')}
              disabled={isGeneratingCommitMessages}
              onClick={onRetryGeneration}
            />
            <FailureActionButton
              icon="edit"
              title={t('implement.writeCommitMessagesManually', 'Write manually')}
              description={t('implement.writeCommitMessagesManuallyHelp', 'Use the commit editor instead of AI.')}
              disabled={isGeneratingCommitMessages}
              onClick={onWriteManually}
            />
            <FailureActionButton
              icon="cpu"
              title={t('implement.metadataModelSettings', 'Metadata model settings')}
              description={t('implement.metadataModelSettingsHelp', 'Change the model used for generated metadata and commit messages.')}
              disabled={isGeneratingCommitMessages}
              onClick={onOpenCommitModelSettings}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end border-t border-border px-5 py-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={isGeneratingCommitMessages}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
};
