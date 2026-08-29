import React from 'react';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';

export interface PanelEmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: IconName;
  title?: React.ReactNode;
  description: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
}

export const PanelEmptyState: React.FC<PanelEmptyStateProps> = ({
  icon = 'layers',
  title,
  description,
  action,
  compact = false,
  className,
  ...props
}) => (
  <div
    data-empty-state="panel"
    className={cn(
      'flex min-h-full w-full items-center justify-center px-6 text-center',
      compact ? 'py-6' : 'py-10',
      className,
    )}
    {...props}
  >
    <div className={cn('w-full', compact ? 'max-w-[240px]' : 'max-w-sm')}>
      <div
        className={cn(
          'mx-auto flex items-center justify-center rounded-2xl border border-border bg-card/70 text-primary',
          compact ? 'mb-3 h-10 w-10 rounded-xl' : 'mb-4 h-12 w-12',
        )}
        aria-hidden="true"
      >
        <Icon name={icon} size={compact ? 18 : 22} />
      </div>
      {title && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
      <p
        className={cn(
          'text-xs leading-relaxed text-muted-foreground',
          title ? 'mt-2' : undefined,
        )}
      >
        {description}
      </p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  </div>
);

PanelEmptyState.displayName = 'PanelEmptyState';
