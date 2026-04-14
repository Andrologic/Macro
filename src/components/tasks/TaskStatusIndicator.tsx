import React from 'react';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import type { TaskStatusIndicatorState } from '../../services/taskStatusPresentation';

interface TaskStatusIndicatorProps {
  state: TaskStatusIndicatorState;
  className?: string;
  size?: number;
  dotSize?: number;
}

const getIconName = (state: TaskStatusIndicatorState) => {
  switch (state) {
    case 'in_review':
      return 'search';
    case 'completed':
      return 'check-circle';
    case 'failed':
      return 'alert-circle';
    case 'blocked':
      return 'lock';
    case 'running':
      return 'loader';
    default:
      return null;
  }
};

export const TaskStatusIndicator: React.FC<TaskStatusIndicatorProps> = ({
  state,
  className,
  size = 14,
  dotSize = 8,
}) => {
  const iconName = getIconName(state);

  if (state === 'idle_prompt' || state === 'awaiting_response') {
    return (
      <span
        data-task-status-indicator-state={state}
        className={cn('inline-flex items-center justify-center', className)}
      >
        <span
          aria-hidden="true"
          className={cn(
            'block rounded-full bg-current',
            state === 'awaiting_response' && 'animate-pulse'
          )}
          style={{ width: dotSize, height: dotSize }}
        />
      </span>
    );
  }

  return (
    <span
      data-task-status-indicator-state={state}
      className={cn('inline-flex items-center justify-center', className)}
    >
      <Icon
        name={iconName || 'circle'}
        size={size}
        className={cn(state === 'running' && 'animate-spin')}
      />
    </span>
  );
};

export default TaskStatusIndicator;
