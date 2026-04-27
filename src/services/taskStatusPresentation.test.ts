import { describe, expect, it } from 'bun:test';
import {
  mapPlanNodeStatusToTaskStatus,
  resolvePlanNodeStatusIndicatorState,
  resolveRunningTaskIds,
  resolveTaskStatusIndicatorState,
} from './taskStatusPresentation';
import type { MergeWorkflowRuntimeState } from './mergeWorkflow';

describe('taskStatusPresentation', () => {
  it('resolves idle prompt for pending tasks without streaming', () => {
    expect(resolveTaskStatusIndicatorState('Pending', false)).toBe('idle_prompt');
  });

  it('resolves idle prompt for in-progress tasks without streaming', () => {
    expect(resolveTaskStatusIndicatorState('InProgress', false)).toBe('idle_prompt');
  });

  it('resolves awaiting response to a pulsing state', () => {
    expect(resolveTaskStatusIndicatorState('AwaitingResponse', false)).toBe(
      'awaiting_response'
    );
  });

  it('uses the dedicated finalization indicator for synthetic plan finalization tasks', () => {
    expect(resolveTaskStatusIndicatorState('Pending', false, 'plan_finalization')).toBe(
      'plan_finalization'
    );
    expect(resolveTaskStatusIndicatorState('InProgress', false, 'plan_finalization')).toBe(
      'plan_finalization'
    );
  });

  it('forces the running state only for active preparing or streamed tasks', () => {
    const runningTaskIds = resolveRunningTaskIds({
      conversations: [
        { id: 'conversation-1', task_id: 'task-1' },
        { id: 'conversation-2', task_id: 'task-2' },
        { id: 'conversation-3', task_id: 'task-3' },
        { id: 'conversation-4', task_id: 'task-4' },
      ],
      conversationRuntimeById: {
        'conversation-1': {
          phase: 'streaming',
          sessionId: 'session-1',
        },
        'conversation-2': {
          phase: 'preparing',
          sessionId: 'session-2',
        },
        'conversation-3': {
          phase: 'error',
          sessionId: 'session-3',
        },
      },
    });

    expect(runningTaskIds.has('task-1')).toBe(true);
    expect(runningTaskIds.has('task-2')).toBe(true);
    expect(runningTaskIds.has('task-3')).toBe(false);
    expect(runningTaskIds.has('task-4')).toBe(false);
    expect(
      resolveTaskStatusIndicatorState('AwaitingResponse', runningTaskIds.has('task-1'))
    ).toBe('running');
    expect(
      resolveTaskStatusIndicatorState('AwaitingResponse', runningTaskIds.has('task-3'))
    ).toBe('awaiting_response');
  });

  it('projects plan node statuses to the shared task indicator states', () => {
    expect(mapPlanNodeStatusToTaskStatus('pending')).toBe('Pending');
    expect(
      resolvePlanNodeStatusIndicatorState({
        nodeStatus: 'in-progress',
        taskStatus: 'AwaitingResponse',
        isAssistantRunning: false,
      })
    ).toBe('awaiting_response');
    expect(
      resolvePlanNodeStatusIndicatorState({
        nodeStatus: 'in-progress',
        taskStatus: null,
        isAssistantRunning: true,
      })
    ).toBe('running');
  });

  it('surfaces merge workflow indicator states ahead of the generic task status', () => {
    const blockedRuntime: MergeWorkflowRuntimeState = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'blocked',
      taskStatus: 'Blocked',
      review: null,
      repositories: [],
      blockedRepositories: [],
      message: 'blocked',
      lastLoadedAt: null,
    };
    const failedRuntime: MergeWorkflowRuntimeState = {
      ...blockedRuntime,
      phase: 'failed',
      taskStatus: 'Failed',
      message: 'failed',
    };
    const mergingRuntime: MergeWorkflowRuntimeState = {
      ...blockedRuntime,
      phase: 'merging',
      taskStatus: 'InProgress',
      message: null,
    };

    expect(
      resolveTaskStatusIndicatorState('Blocked', false, 'architect', blockedRuntime)
    ).toBe('merge_blocked');
    expect(
      resolveTaskStatusIndicatorState('Failed', false, 'architect', failedRuntime)
    ).toBe('merge_failed');
    expect(
      resolveTaskStatusIndicatorState('InProgress', false, 'architect', mergingRuntime)
    ).toBe('merging');
    expect(
      resolveTaskStatusIndicatorState('Blocked', false, 'architect', {
        phase: 'partial',
      })
    ).toBe('merge_partial');
  });
});
