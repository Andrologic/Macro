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
  frameWidth: number;
  frameHeight: number;
  haloWidth: number;
  haloHeight: number;
  baseWidth: number;
  baseHeight: number;
  baseOpacity: number;
  baseBlur: number;
  baseGlow: number;
  haloRestOpacity: number;
  haloPeakOpacity: number;
  haloRestScale: number;
  haloPeakScale: number;
  haloRestBlur: number;
  haloPeakBlur: number;
  haloGlow: number;
}

const getAwaitingResponseLayoutMetrics = (
  layout: TaskStatusIndicatorLayout,
  size: number,
  dotSize: number
): AwaitingResponseLayoutMetrics => {
  switch (layout) {
    case 'card': {
      const frameWidth = Math.max(size + 12, dotSize + 18);
      const frameHeight = Math.max(size + 10, dotSize + 14);
      return {
        frameWidth,
        frameHeight,
        haloWidth: frameWidth,
        haloHeight: frameHeight - 1,
        baseWidth: frameWidth - 4,
        baseHeight: frameHeight - 4,
        baseOpacity: 0.2,
        baseBlur: 7.5,
        baseGlow: 14,
        haloRestOpacity: 0.34,
        haloPeakOpacity: 0.62,
        haloRestScale: 0.93,
        haloPeakScale: 1.08,
        haloRestBlur: 9,
        haloPeakBlur: 15,
        haloGlow: 20,
      };
    }
    case 'graph': {
      const frameSize = Math.max(size + 8, dotSize + 12);
      return {
        frameWidth: frameSize,
        frameHeight: frameSize,
        haloWidth: frameSize - 1,
        haloHeight: frameSize - 1,
        baseWidth: frameSize - 4,
        baseHeight: frameSize - 4,
        baseOpacity: 0.18,
        baseBlur: 6,
        baseGlow: 10,
        haloRestOpacity: 0.3,
        haloPeakOpacity: 0.54,
        haloRestScale: 0.92,
        haloPeakScale: 1.09,
        haloRestBlur: 7.5,
        haloPeakBlur: 11,
        haloGlow: 14,
      };
    }
    case 'compact':
    default: {
      const frameSize = Math.max(size + 5, dotSize + 9);
      return {
        frameWidth: frameSize,
        frameHeight: frameSize,
        haloWidth: frameSize - 1,
        haloHeight: frameSize - 1,
        baseWidth: frameSize - 3,
        baseHeight: frameSize - 3,
        baseOpacity: 0.16,
        baseBlur: 4.5,
        baseGlow: 7,
        haloRestOpacity: 0.26,
        haloPeakOpacity: 0.46,
        haloRestScale: 0.93,
        haloPeakScale: 1.08,
        haloRestBlur: 5.5,
        haloPeakBlur: 8.5,
        haloGlow: 10,
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
      '--task-status-halo-rest-opacity': String(metrics.haloRestOpacity),
      '--task-status-halo-peak-opacity': String(metrics.haloPeakOpacity),
      '--task-status-halo-rest-scale': String(metrics.haloRestScale),
      '--task-status-halo-peak-scale': String(metrics.haloPeakScale),
      '--task-status-halo-rest-blur': `${metrics.haloRestBlur}px`,
      '--task-status-halo-peak-blur': `${metrics.haloPeakBlur}px`,
      '--task-status-halo-glow': `${metrics.haloGlow}px`,
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
            width: metrics.frameWidth,
            height: metrics.frameHeight,
            ...pulseVars,
          }}
        >
          <span
            className="absolute rounded-full bg-current"
            style={{
              width: metrics.baseWidth,
              height: metrics.baseHeight,
              opacity: metrics.baseOpacity,
              filter: `blur(${metrics.baseBlur}px)`,
              boxShadow: `0 0 ${metrics.baseGlow}px currentColor`,
            }}
          />
          <span
            className="task-status-awaiting-response__halo absolute rounded-full bg-current"
            style={{ width: metrics.haloWidth, height: metrics.haloHeight }}
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
