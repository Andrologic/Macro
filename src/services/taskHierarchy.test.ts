import { expect, test } from 'bun:test';
import { taskHierarchy, workflowStatus } from './taskHierarchy';

test('a workflow and its delegated tasks have one root, without hiding unrelated or orphaned tasks', () => {
  const rows = [{ id: 'workflow' }, { id: 'a', parent_task_id: 'workflow' }, { id: 'b', parent_task_id: 'workflow' }, { id: 'standalone' }, { id: 'orphan', parent_task_id: 'missing' }];
  const grouped = taskHierarchy([...rows, rows[1]]);
  expect(grouped.roots.map(task => task.id)).toEqual(['workflow', 'standalone', 'orphan']);
  expect(grouped.children.get('workflow')?.map(task => task.id)).toEqual(['a', 'b']);
});

test('malformed cyclic ancestry stays visible rather than losing tasks', () => {
  expect(taskHierarchy([{ id: 'a', parent_task_id: 'b' }, { id: 'b', parent_task_id: 'a' }]).roots).toHaveLength(2);
});

test('workflow status follows useful overall progress rather than every internal wait', () => {
  expect(workflowStatus([{ status: 'InProgress' }, { status: 'Blocked' }])).toBe('InProgress');
  expect(workflowStatus([{ status: 'Completed' }, { status: 'AwaitingResponse' }])).toBe('AwaitingResponse');
  expect(workflowStatus([{ status: 'Completed' }, { status: 'Failed' }])).toBe('Failed');
  expect(workflowStatus([{ status: 'Completed' }, { status: 'Completed' }])).toBe('Completed');
});
