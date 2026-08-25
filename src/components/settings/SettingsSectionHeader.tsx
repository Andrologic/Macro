import React from 'react';
import { cn } from '../../utils/cn';

type SettingsSectionHeaderProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
};

export const SettingsSectionHeader: React.FC<SettingsSectionHeaderProps> = ({
  title,
  description,
  action,
  className,
}) => (
  <div
    className={cn('flex min-w-0 items-start justify-between gap-4', className)}
  >
    <div className="min-w-0 space-y-1">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-medium uppercase tracking-wider text-primary">
          {title}
        </h4>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
    {action && <div className="shrink-0">{action}</div>}
  </div>
);
