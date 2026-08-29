import React from 'react';
import { cn } from '../../utils/cn';

export type SettingsStatus =
  | 'active'
  | 'disabled'
  | 'warning'
  | 'error'
  | 'unavailable'
  | 'neutral';

export interface SettingsStatusBadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  status: SettingsStatus;
  label: React.ReactNode;
  dot?: boolean;
}

const statusStyles: Record<SettingsStatus, string> = {
  active: 'bg-emerald-500/10 text-emerald-500',
  disabled: 'bg-secondary text-muted-foreground',
  warning: 'bg-amber-500/10 text-amber-500',
  error: 'bg-red-500/10 text-red-500',
  unavailable: 'bg-secondary/80 text-muted-foreground',
  neutral: 'bg-secondary text-muted-foreground',
};

export const SettingsStatusBadge: React.FC<SettingsStatusBadgeProps> = ({
  status,
  label,
  dot = true,
  className,
  ...props
}) => (
  <span
    data-settings-status-badge="true"
    data-status={status}
    className={cn(
      'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
      statusStyles[status],
      className,
    )}
    {...props}
  >
    {dot && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
    {label}
  </span>
);

SettingsStatusBadge.displayName = 'SettingsStatusBadge';
