import React from 'react';
import { Icon } from '../ui/Icon';

type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

export interface DependencyBlockedTaskLike {
  is_blocked?: boolean;
  blocked_by?: string[];
}

export const getDependencyBlockedMessage = (
  task: DependencyBlockedTaskLike | null | undefined,
  t: TranslateFn
): string | null => {
  if (!task?.is_blocked) {
    return null;
  }

  const blockedBy = task.blocked_by ?? [];
  if (blockedBy.length > 0) {
    return t('implement.taskBlockedByDependencies', 'Blocked by: {{tasks}}', {
      tasks: blockedBy.join(', '),
    });
  }

  return t(
    'implement.taskBlockedByDependenciesGeneric',
    'This task is waiting for its prerequisites.'
  );
};

interface TaskBlockedStateProps {
  message: string | null;
  help?: string;
  title: string;
  variant?: 'center' | 'panel' | 'compact';
}

export const TaskBlockedState: React.FC<TaskBlockedStateProps> = ({
  message,
  help,
  title,
  variant = 'center',
}) => {
  if (variant === 'compact') {
    return (
      <div className="rounded-xl border border-border bg-card/70 p-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
            <Icon name="lock" size={14} className="text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{title}</div>
            {message && (
              <p className="mt-1 text-xs text-muted-foreground">
                {message}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const iconSize = variant === 'panel' ? 20 : 24;
  const iconFrameClass = variant === 'panel' ? 'h-12 w-12' : 'h-16 w-16';
  const wrapperClass = variant === 'panel'
    ? 'flex flex-1 items-center justify-center px-6 py-10 text-center'
    : 'flex h-full items-center justify-center px-6';
  const contentClass = variant === 'panel' ? 'max-w-xs' : 'max-w-md text-center';

  return (
    <div className={wrapperClass}>
      <div className={contentClass}>
        <div className={`mx-auto mb-4 flex ${iconFrameClass} items-center justify-center rounded-xl border border-border bg-muted/40`}>
          <Icon name="lock" size={iconSize} className="text-muted-foreground" />
        </div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        {message && (
          <p className="mt-2 text-sm text-muted-foreground">
            {message}
          </p>
        )}
        {help && (
          <p className="mt-3 text-xs text-muted-foreground">
            {help}
          </p>
        )}
      </div>
    </div>
  );
};
