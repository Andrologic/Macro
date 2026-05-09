import React from 'react';
import type { PlanNodeTodo } from '../../types';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

interface TodoStatusIconProps {
  status: PlanNodeTodo['status'];
  size?: 'sm' | 'md';
  className?: string;
}

const sizeClasses = {
  sm: {
    frame: 'h-4 w-4',
    doneIcon: 9,
    progressIcon: 9,
    pendingIcon: 7,
  },
  md: {
    frame: 'h-5 w-5',
    doneIcon: 11,
    progressIcon: 11,
    pendingIcon: 8,
  },
} as const;

export const TodoStatusIcon: React.FC<TodoStatusIconProps> = ({
  status,
  size = 'sm',
  className,
}) => {
  const metrics = sizeClasses[size];

  if (status === 'done') {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500 ring-1 ring-inset ring-emerald-500/25',
          metrics.frame,
          className
        )}
        data-todo-status-icon="done"
      >
        <Icon name="check" size={metrics.doneIcon} />
      </span>
    );
  }

  if (status === 'in-progress') {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary ring-1 ring-inset ring-primary/25',
          metrics.frame,
          className
        )}
        data-todo-status-icon="in-progress"
      >
        <Icon
          name="loader"
          size={metrics.progressIcon}
          className="origin-center animate-spin"
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-inset ring-border/60',
        metrics.frame,
        className
      )}
      data-todo-status-icon="pending"
    >
      <Icon name="circle" size={metrics.pendingIcon} />
    </span>
  );
};

