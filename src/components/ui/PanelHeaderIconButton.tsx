import React from 'react';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from './Icon';
import { SpinnerIcon } from './SpinnerIcon';

export interface PanelHeaderIconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  icon: IconName;
  label: string;
  pressed?: boolean;
  isLoading?: boolean;
}

export const PanelHeaderIconButton = React.forwardRef<
  HTMLButtonElement,
  PanelHeaderIconButtonProps
>(({
  icon,
  label,
  pressed,
  isLoading = false,
  disabled = false,
  className,
  ...props
}, ref) => {
  const unavailable = disabled || isLoading;

  return (
    <button
      {...props}
      ref={ref}
      type="button"
      disabled={unavailable}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        unavailable
          ? 'cursor-not-allowed border-border bg-muted text-muted-foreground opacity-60'
          : pressed
            ? 'border-border bg-accent text-foreground'
            : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      {isLoading ? <SpinnerIcon size={13} /> : <Icon name={icon} size={13} />}
    </button>
  );
});

PanelHeaderIconButton.displayName = 'PanelHeaderIconButton';
