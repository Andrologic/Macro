import { expect, test } from 'bun:test';
import { groupTaskQueueLanes, taskQueueLane, TASK_QUEUE_LANES } from './taskQueueLanes';
import { resolveTaskQueueStatusGroup } from './taskStatusPresentation';
import { normalizeImplementViewFilters } from './viewFilterPreferences';

test('detailed engine states resolve to one of four visible lanes, retaining live activity and blockers', () => {
  for (const [status, blocked, running, pending, expected] of [
    ['Pending', false, false, false, 'ready'],
    ['AwaitingResponse', false, false, false, 'waiting'],
    ['Blocked', false, false, false, 'waiting'],
    ['Failed', false, false, false, 'waiting'],
    ['InProgress', true, false, false, 'waiting'],
    ['InProgress', false, true, true, 'waiting'],
    ['InReview', false, false, false, 'in_progress'],
    ['Completed', false, false, false, 'completed'],
    ['Completed', true, false, false, 'waiting'],
    ['Completed', false, true, false, 'in_progress'],
  ] as const) {
    const group = resolveTaskQueueStatusGroup(status, blocked, null, running, pending);
    expect(taskQueueLane({ id: 'task', status }, group)).toBe(expected);
  }
});
test('counts partition unique non-draft unarchived tasks without overlapping attention totals', () => {
  const tasks = [
    { id: 'ready', status: 'Pending' }, { id: 'working', status: 'InProgress' },
    { id: 'reply', status: 'AwaitingResponse' }, { id: 'blocked', status: 'Blocked' },
    { id: 'failed', status: 'Failed' }, { id: 'done', status: 'Completed' },
    { id: 'failed', status: 'Failed' },
    { id: 'draft', status: 'Pending', draft: true },
    { id: 'archive', status: 'Completed', archived_at: '2026-01-01' },
  ];
  const detailed = new Map(tasks.map(task => [task.id, resolveTaskQueueStatusGroup(task.status)]));
  const lanes = groupTaskQueueLanes(tasks, detailed);
  expect(TASK_QUEUE_LANES.map(lane => lanes[lane].length)).toEqual([1, 3, 1, 1]);
  const ids = Object.values(lanes).flat().map(task => task.id);
  expect(ids).toHaveLength(6);
  expect(new Set(ids).size).toBe(ids.length);
  expect(tasks.find(task => task.id === 'failed')?.status).toBe('Failed');
  const includingArchives = groupTaskQueueLanes(tasks, detailed, true);
  expect(includingArchives.completed.map(task => task.id)).toEqual(['done', 'archive']);
  expect(Object.values(includingArchives).flat()).toHaveLength(7);
});
test('legacy persisted filters converge onto Waiting and the completed filter survives hydration', () => {
  for (const status of ['attention', 'blocked', 'failed', 'other']) {
    expect(normalizeImplementViewFilters({ version: 1, status }).status).toBe('waiting');
  }
  expect(normalizeImplementViewFilters({ version: 1, status: 'completed' }).status).toBe('completed');
});
