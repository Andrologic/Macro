import React from 'react';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';

export interface SettingsEmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: IconName;
  title?: React.ReactNode;
  description: React.ReactNode;
  action?: React.ReactNode;
  variant?: 'card' | 'plain';
}

export const SettingsEmptyState: React.FC<SettingsEmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  variant = 'card',
  className,
  ...props
}) => (
  <div
    data-empty-state="settings"
    className={cn(
      'px-4 py-8 text-center',
      variant === 'card' && 'rounded-xl border border-dashed border-border/70 bg-background/40',
      className,
    )}
    {...props}
  >
    {icon && (
      <div
        className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card/70 text-muted-foreground"
        aria-hidden="true"
      >
        <Icon name={icon} size={18} />
      </div>
    )}
    {title && <h3 className="text-sm font-medium text-foreground">{title}</h3>}
    <p
      className={cn(
        'mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground',
        title ? 'mt-1' : undefined,
      )}
    >
      {description}
    </p>
    {action && <div className="mt-4 flex justify-center">{action}</div>}
  </div>
);

SettingsEmptyState.displayName = 'SettingsEmptyState';
