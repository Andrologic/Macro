import { describe, expect, it } from 'bun:test';
import {
  mapPlanNodeStatusToTaskStatus,
  resolvePlanNodeStatusIndicatorState,
  resolveRunningConversationIds,
  resolveRunningTaskIds,
  resolveTaskQueueStatusGroup,
  resolveTaskStatusIndicatorState,
} from './taskStatusPresentation';
import type { MergeWorkflowRuntimeState } from './mergeWorkflow';
import type { TaskStatus } from '../types';

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

  it('lets a structured dependency blocker override a stale waiting status', () => {
    expect(
      resolveTaskStatusIndicatorState('AwaitingResponse', false, null, null, true)
    ).toBe('blocked');
    expect(
      resolveTaskStatusIndicatorState('AwaitingResponse', true, null, null, true)
    ).toBe('running');
    expect(
      resolveTaskStatusIndicatorState(
        'AwaitingResponse',
        false,
        null,
        { phase: 'partial' },
        true
      )
    ).toBe('blocked');
  });

  it('projects structured dependency blockers on plan nodes', () => {
    expect(
      resolvePlanNodeStatusIndicatorState({
        nodeStatus: 'in-progress',
        taskStatus: 'InReview',
        isAssistantRunning: false,
        isDependencyBlocked: true,
      })
    ).toBe('blocked');
  });

  it('keeps waiting, blocked and failed queue groups disjoint', () => {
    expect(resolveTaskQueueStatusGroup('AwaitingResponse')).toBe('waiting');
    expect(resolveTaskQueueStatusGroup('Blocked')).toBe('blocked');
    expect(resolveTaskQueueStatusGroup('Failed')).toBe('failed');
    expect(resolveTaskQueueStatusGroup('AwaitingResponse', true)).toBe('blocked');
    expect(
      resolveTaskQueueStatusGroup('AwaitingResponse', false, { phase: 'blocked' })
    ).toBe('blocked');
    expect(
      resolveTaskQueueStatusGroup('AwaitingResponse', false, { phase: 'partial' })
    ).toBe('blocked');
    expect(
      resolveTaskQueueStatusGroup('AwaitingResponse', false, { phase: 'failed' })
    ).toBe('failed');
    expect(
      resolveTaskQueueStatusGroup('AwaitingResponse', false, { phase: 'merging' })
    ).toBe('in_progress');
    expect(
      resolveTaskQueueStatusGroup(
        'AwaitingResponse',
        true,
        { phase: 'blocked' },
        true
      )
    ).toBe('in_progress');
  });

  it('leaves unknown and completed statuses outside actionable queue groups', () => {
    expect(resolveTaskQueueStatusGroup('Paused')).toBe('other');
    expect(resolveTaskQueueStatusGroup('Completed')).toBe('other');
    expect(resolveTaskStatusIndicatorState('Paused' as TaskStatus, false)).toBe(
      'idle_prompt'
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

  it('treats transient compaction phases as active conversations', () => {
    const runningTaskIds = resolveRunningTaskIds({
      conversations: [
        { id: 'conversation-1', task_id: 'task-1' },
        { id: 'conversation-2', task_id: 'task-2' },
        { id: 'conversation-3', task_id: 'task-3' },
        { id: 'conversation-4', task_id: 'task-4' },
        { id: 'conversation-5', task_id: 'task-5' },
        { id: 'conversation-6', task_id: 'task-6' },
        { id: 'conversation-7', task_id: 'task-7' },
      ],
      conversationRuntimeById: {},
      conversationCompactionStatusById: {
        'conversation-1': { phase: 'compacting' },
        'conversation-2': { phase: 'safety_compacting' },
        'conversation-3': { phase: 'model_switch_compacting' },
        'conversation-4': { phase: 'recovering_overflow' },
        'conversation-5': { phase: 'compacted' },
        'conversation-6': { phase: 'degraded' },
        'conversation-7': { phase: 'too_large' },
      },
    });

    expect(Array.from(runningTaskIds).sort()).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
    ]);
  });

  it('maps an active conversation to tasks through task conversation_id when needed', () => {
    const runningTaskIds = resolveRunningTaskIds({
      conversations: [{ id: 'conversation-1', task_id: null }],
      tasks: [{ id: 'task-1', conversation_id: 'conversation-1' }],
      conversationRuntimeById: {},
      conversationCompactionStatusById: {
        'conversation-1': { phase: 'compacting' },
      },
    });

    expect(Array.from(runningTaskIds)).toEqual(['task-1']);
  });

  it('maps the active selected conversation to the selected task when persisted links are stale', () => {
    const runningTaskIds = resolveRunningTaskIds({
      conversations: [{ id: 'conversation-1', task_id: null }],
      tasks: [{ id: 'task-1', conversation_id: null }],
      selectedConversationId: 'conversation-1',
      selectedTaskId: 'task-1',
      conversationRuntimeById: {},
      conversationCompactionStatusById: {
        'conversation-1': { phase: 'compacting' },
      },
    });

    expect(Array.from(runningTaskIds)).toEqual(['task-1']);
  });

  it('does not map the selected task when compaction belongs to another conversation', () => {
    const runningTaskIds = resolveRunningTaskIds({
      conversations: [{ id: 'conversation-1', task_id: null }],
      tasks: [{ id: 'task-1', conversation_id: null }],
      selectedConversationId: 'conversation-1',
      selectedTaskId: 'task-1',
      conversationRuntimeById: {},
      conversationCompactionStatusById: {
        'conversation-2': { phase: 'compacting' },
      },
    });

    expect(Array.from(runningTaskIds)).toEqual([]);
  });

  it('keeps preparing and streaming conversations active when compaction statuses are provided', () => {
    const runningConversationIds = resolveRunningConversationIds(
      {
        'conversation-1': {
          phase: 'streaming',
          sessionId: 'session-1',
        },
        'conversation-2': {
          phase: 'preparing',
          sessionId: 'session-2',
        },
      },
      {
        'conversation-3': { phase: 'compacting' },
        'conversation-4': { phase: 'compacted' },
      }
    );

    expect(Array.from(runningConversationIds).sort()).toEqual([
      'conversation-1',
      'conversation-2',
      'conversation-3',
    ]);
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
