import React from 'react';
import { cn } from '../../utils/cn';

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'error';
  size?: 'sm' | 'md';
  dot?: boolean;
}

export const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  (
    { className, variant = 'default', size = 'md', dot, children, ...props },
    ref
  ) => {
    const variants = {
      default: 'bg-elevated text-text-secondary',
      primary: 'bg-primary/10 text-primary',
      success: 'bg-accent-success/10 text-accent-success',
      warning: 'bg-accent-warning/10 text-accent-warning',
      error: 'bg-accent-error/10 text-accent-error',
    };

    const sizes = {
      sm: 'px-2 py-0.5 text-xs',
      md: 'px-2.5 py-0.5 text-sm',
    };

    return (
      <div
        ref={ref}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full font-medium',
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      >
        {dot && (
          <span className="w-2 h-2 rounded-full bg-current" />
        )}
        {children}
      </div>
    );
  }
);

Badge.displayName = 'Badge';
