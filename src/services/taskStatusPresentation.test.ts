import { describe, expect, it } from 'bun:test';
import {
  mapPlanNodeStatusToTaskStatus,
  resolvePlanNodeStatusIndicatorState,
  resolveRunningTaskIds,
  resolveTaskStatusIndicatorState,
} from './taskStatusPresentation';

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

  it('forces the running state only for the streamed task', () => {
    const runningTaskIds = resolveRunningTaskIds({
      conversations: [
        { id: 'conversation-1', task_id: 'task-1' },
        { id: 'conversation-2', task_id: 'task-2' },
      ],
      conversationRuntimeById: {
        'conversation-1': {
          phase: 'streaming',
          sessionId: 'session-1',
        },
      },
    });

    expect(runningTaskIds.has('task-1')).toBe(true);
    expect(runningTaskIds.has('task-2')).toBe(false);
    expect(
      resolveTaskStatusIndicatorState('AwaitingResponse', runningTaskIds.has('task-1'))
    ).toBe('running');
    expect(
      resolveTaskStatusIndicatorState('AwaitingResponse', runningTaskIds.has('task-2'))
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
});
