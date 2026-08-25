import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../ui/Icon';
import { Button } from '../ui/Button';
import { cn } from '../../utils/cn';
import {
  resolveDegradedErrorPresentation,
  type DegradedErrorPresentation,
} from '../../services/degradedErrorPresentation';

interface ActionableErrorCalloutProps {
  presentation: DegradedErrorPresentation;
  actionLabel?: string | null;
  onAction?: (() => void) | null;
  secondaryActionLabel?: string | null;
  onSecondaryAction?: (() => void) | null;
  className?: string;
  compact?: boolean;
}

const toneClassName: Record<DegradedErrorPresentation['severity'], string> = {
  info: 'border-primary/20 bg-primary/5 text-primary',
  warning: 'border-amber-500/20 bg-amber-500/10 text-amber-500',
  danger: 'border-destructive/25 bg-destructive/10 text-destructive',
};

const iconBySeverity: Record<DegradedErrorPresentation['severity'], IconName> = {
  info: 'alert-circle',
  warning: 'triangle-alert',
  danger: 'alert-circle',
};

export const ActionableErrorCallout: React.FC<ActionableErrorCalloutProps> = ({
  presentation,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  className,
  compact = false,
}) => {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  const resolvedPresentation = resolveDegradedErrorPresentation(
    presentation,
    (key, options) => String(t(key, options))
  );
  const hasTechnicalDetails = Boolean(presentation.technicalDetails?.trim());
  const buttonVariant = presentation.severity === 'danger' ? 'error' : 'secondary';
  const resolvedDetails = presentation.technicalDetails?.trim() || null;

  return (
    <div className={cn('rounded-xl border px-4 py-3', toneClassName[presentation.severity], className)}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <Icon name={iconBySeverity[presentation.severity]} size={compact ? 14 : 16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{resolvedPresentation.title}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {resolvedPresentation.body}
          </p>
          {resolvedPresentation.nextStep && (
            <p className="mt-2 text-xs leading-relaxed text-foreground/85">
              <span className="font-medium">{t('errors.nextStep', 'Next step')}:</span> {resolvedPresentation.nextStep}
            </p>
          )}
          {(presentation.repoPath || presentation.projectId) && (
            <p className="mt-2 break-all text-[11px] text-muted-foreground">
              {presentation.repoPath || presentation.projectId}
            </p>
          )}
          {(onAction || onSecondaryAction || hasTechnicalDetails) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onAction && actionLabel && (
                <Button type="button" size="sm" variant={buttonVariant} onClick={onAction}>
                  {actionLabel}
                </Button>
              )}
              {onSecondaryAction && secondaryActionLabel && (
                <Button type="button" size="sm" variant="ghost" onClick={onSecondaryAction}>
                  {secondaryActionLabel}
                </Button>
              )}
              {hasTechnicalDetails && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="px-2"
                  onClick={() => setShowDetails((current) => !current)}
                >
                  {showDetails
                    ? t('errors.hideDetails', 'Hide details')
                    : t('errors.showDetails', 'Show details')}
                </Button>
              )}
            </div>
          )}
          {showDetails && resolvedDetails && (
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-background/70 p-3 text-[11px] text-muted-foreground">
              {resolvedDetails}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};

export default ActionableErrorCallout;
