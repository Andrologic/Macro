import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConflictResolutionEntry } from '../../services/conflictResolution';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';

interface ConflictResolutionPanelProps {
  title: string;
  description: string;
  repositories: ConflictResolutionEntry[];
  error?: string | null;
  retryLabel?: string;
  retryDisabled?: boolean;
  retryLoading?: boolean;
  showWorktreeDetails?: boolean;
  showConflictFiles?: boolean;
  onRetry?: () => void;
  onUseAiAssistant?: () => void;
  onDismiss?: () => void;
  dismissLabel?: string;
}

const toneClassName: Record<ConflictResolutionEntry['statusTone'], string> = {
  success: 'bg-emerald-500/10 text-emerald-500',
  warning: 'bg-amber-500/10 text-amber-500',
  danger: 'bg-red-500/10 text-red-500',
};

export const ConflictResolutionPanel: React.FC<ConflictResolutionPanelProps> = ({
  title,
  description,
  repositories,
  error,
  retryLabel,
  retryDisabled = false,
  retryLoading = false,
  showWorktreeDetails = false,
  showConflictFiles,
  onRetry,
  onUseAiAssistant,
  onDismiss,
  dismissLabel,
}) => {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  const hasTechnicalDetails = Boolean(error?.trim());

  return (
    <div className="rounded-xl border border-red-500/20 bg-red-500/5">
      <div className="border-b border-red-500/10 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-red-500/10 p-2 text-red-500">
            <Icon name="alert-circle" size={16} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
      </div>

      <div className="space-y-3 px-4 py-4">
        {repositories.map((repository) => (
          <div key={repository.id} className="rounded-lg border border-border bg-background/50 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground break-all">{repository.repoPath}</div>
                {repository.subtitle && (
                  <div className="mt-1 text-xs text-muted-foreground">{repository.subtitle}</div>
                )}
              </div>
              <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase', toneClassName[repository.statusTone])}>
                {repository.statusLabel}
              </span>
            </div>

            {showWorktreeDetails && repository.worktreePath && (
              <div className="mt-3 text-xs text-muted-foreground">
                {t('conflicts.panel.worktree', 'Worktree')}:{' '}
                <span className="break-all text-foreground/90">{repository.worktreePath}</span>
              </div>
            )}

            {repository.reason && (
              <div className="mt-3 text-xs text-red-500">{repository.reason}</div>
            )}

            {repository.nextStep && (
              <div className="mt-2 text-xs text-muted-foreground">
                {t('conflicts.panel.nextStep', 'Next step')}:{' '}
                <span className="text-foreground/90">{repository.nextStep}</span>
              </div>
            )}

            {(showConflictFiles ?? repository.conflictFiles.length > 0) && (
              <div className="mt-3 rounded-md border border-border bg-background/70 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('conflicts.panel.conflictedFiles', 'Conflicted files')}
                </div>
                <div className="mt-2 space-y-1">
                  {repository.conflictFiles.length > 0 ? (
                    repository.conflictFiles.map((file) => (
                      <div key={`${repository.id}:${file}`} className="break-all text-xs text-foreground/90">
                        {file}
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      {t('conflicts.panel.noConflictFiles', 'No conflict file list reported.')}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {(hasTechnicalDetails || onDismiss || onRetry || onUseAiAssistant) && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {hasTechnicalDetails && (
            <Button variant="ghost" size="sm" onClick={() => setShowDetails((value) => !value)}>
              {showDetails
                ? t('errors.hideDetails', 'Hide details')
                : t('errors.showDetails', 'Show details')}
            </Button>
          )}
          {onDismiss && (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              {dismissLabel || t('conflicts.panel.close', 'Close')}
            </Button>
          )}
          {onRetry && (
            <Button
              variant="secondary"
              size="sm"
              disabled={retryDisabled}
              isLoading={retryLoading}
              onClick={onRetry}
            >
              {retryLabel || t('conflicts.panel.retry', 'Retry')}
            </Button>
          )}
          {onUseAiAssistant && (
            <Button variant="primary" size="sm" onClick={onUseAiAssistant}>
              {t('conflicts.panel.useAiAssistant', 'Use AI Assistant')}
            </Button>
          )}
        </div>
      )}
      {showDetails && error && (
        <pre className="mx-4 mb-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background/70 p-3 text-[11px] text-muted-foreground">
          {error}
        </pre>
      )}
    </div>
  );
};

export default ConflictResolutionPanel;
