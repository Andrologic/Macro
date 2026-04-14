import { describe, expect, it } from 'bun:test';
import {
  mapPlanNodeStatusToTaskStatus,
  resolvePlanNodeStatusIndicatorState,
  resolveStreamingTaskId,
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

  it('forces the running state only for the streamed task', () => {
    const streamingTaskId = resolveStreamingTaskId({
      conversations: [
        { id: 'conversation-1', task_id: 'task-1' },
        { id: 'conversation-2', task_id: 'task-2' },
      ],
      isStreaming: true,
      selectedConversationId: 'conversation-1',
    });

    expect(streamingTaskId).toBe('task-1');
    expect(
      resolveTaskStatusIndicatorState('AwaitingResponse', streamingTaskId === 'task-1')
    ).toBe('running');
    expect(
      resolveTaskStatusIndicatorState('AwaitingResponse', streamingTaskId === 'task-2')
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
