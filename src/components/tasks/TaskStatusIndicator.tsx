import React from 'react';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import type { TaskStatusIndicatorState } from '../../services/taskStatusPresentation';

export type TaskStatusIndicatorLayout = 'card' | 'graph' | 'compact';

interface TaskStatusIndicatorProps {
  state: TaskStatusIndicatorState;
  layout?: TaskStatusIndicatorLayout;
  className?: string;
  size?: number;
  dotSize?: number;
}

interface AwaitingResponseLayoutMetrics {
  frameSize: number;
  waveSize: number;
  waveStartScale: number;
  waveMidScale: number;
  waveEndScale: number;
  waveStartOpacity: number;
  waveMidOpacity: number;
}

const getAwaitingResponseLayoutMetrics = (
  layout: TaskStatusIndicatorLayout,
  size: number,
  dotSize: number
): AwaitingResponseLayoutMetrics => {
  switch (layout) {
    case 'card': {
      const frameSize = Math.max(size + 12, dotSize + 18);
      return {
        frameSize,
        waveSize: frameSize,
        waveStartScale: 0.2,
        waveMidScale: 0.62,
        waveEndScale: 1.02,
        waveStartOpacity: 0.3,
        waveMidOpacity: 0.12,
      };
    }
    case 'graph': {
      const frameSize = Math.max(size + 8, dotSize + 12);
      return {
        frameSize,
        waveSize: frameSize,
        waveStartScale: 0.22,
        waveMidScale: 0.64,
        waveEndScale: 1,
        waveStartOpacity: 0.28,
        waveMidOpacity: 0.11,
      };
    }
    case 'compact':
    default: {
      const frameSize = Math.max(size + 5, dotSize + 9);
      return {
        frameSize,
        waveSize: frameSize,
        waveStartScale: 0.28,
        waveMidScale: 0.66,
        waveEndScale: 0.98,
        waveStartOpacity: 0.24,
        waveMidOpacity: 0.1,
      };
    }
  }
};

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
  layout = 'compact',
  className,
  size = 14,
  dotSize = 8,
}) => {
  const iconName = getIconName(state);

  if (state === 'idle_prompt') {
    return (
      <span
        data-task-status-indicator-state={state}
        data-task-status-indicator-layout={layout}
        className={cn('inline-flex items-center justify-center', className)}
      >
        <span
          aria-hidden="true"
          className="block rounded-full bg-current"
          style={{ width: dotSize, height: dotSize }}
        />
      </span>
    );
  }

  if (state === 'awaiting_response') {
    const metrics = getAwaitingResponseLayoutMetrics(layout, size, dotSize);
    const pulseVars = {
      '--task-status-wave-start-scale': String(metrics.waveStartScale),
      '--task-status-wave-mid-scale': String(metrics.waveMidScale),
      '--task-status-wave-end-scale': String(metrics.waveEndScale),
      '--task-status-wave-start-opacity': String(metrics.waveStartOpacity),
      '--task-status-wave-mid-opacity': String(metrics.waveMidOpacity),
    } as React.CSSProperties;

    return (
      <span
        data-task-status-indicator-state={state}
        data-task-status-indicator-layout={layout}
        data-task-status-indicator-pulse={state}
        className={cn('inline-flex items-center justify-center overflow-visible', className)}
      >
        <span
          aria-hidden="true"
          className="relative inline-flex items-center justify-center overflow-visible"
          style={{
            width: metrics.frameSize,
            height: metrics.frameSize,
            ...pulseVars,
          }}
        >
          <span
            className="task-status-awaiting-response__wave absolute rounded-full bg-current"
            style={{
              width: metrics.waveSize,
              height: metrics.waveSize,
            }}
          />
          <span
            className="relative block rounded-full bg-current"
            style={{ width: dotSize, height: dotSize }}
          />
        </span>
      </span>
    );
  }

  return (
    <span
      data-task-status-indicator-state={state}
      data-task-status-indicator-layout={layout}
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
