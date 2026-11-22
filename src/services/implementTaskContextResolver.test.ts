import { describe, expect, it } from 'bun:test';
import type { CatalogedImplementTask as ImplementTask } from './implementTaskCatalog';
import { resolveImplementTaskForContext } from './implementTaskContextResolver';

const createTask = (overrides: Partial<ImplementTask> = {}): ImplementTask => ({
  id: 'task-1',
  node_id: 'node-1',
  plan_id: 'plan-1',
  project_id: 'project-1',
  project_ids: ['project-1'],
  title: 'Implement checkout',
  description: 'Ship the checkout flow.',
  status: 'Pending',
  dependencies: [],
  estimated_changes: [],
  task_source: 'architect',
  draft: false,
  standalone_kind: 'legacy',
  task_kind: null,
  base_branch: 'develop',
  feature_slug: 'implement-checkout',
  conversation_id: null,
  assigned_branch: 'feature/implement-checkout',
  branch_name: 'feature/implement-checkout',
  branch_id: null,
  branch_task_index: 0,
  sequence_index: 0,
  blocked_by_task_ids: [],
  blocked_by: [],
  is_blocked: false,
  is_ready: true,
  needs_revalidation: false,
  execution_targets: [],
  todos: [],
  plan_title: 'Checkout',
  plan_status: 'validated',
  plan_storage_branch: 'plan/checkout',
  plan_target_branch: 'develop',
  plan_target_branches_by_project_id: { 'project-1': 'develop' },
  has_mixed_target_branches: false,
  archived_at: null,
  archive_reason: null,
  merged_at: null,
  merge_workflow: null,
  merge_workflow_summary: null,
  ...overrides,
});

describe('resolveImplementTaskForContext', () => {
  it('resolves an explicitly requested durable or legacy identity', () => {
    const selectedTask = createTask({ id: 'task:v1:develop:plan:node-1', archived_at: '2026-08-14T10:00:00.000Z' });
    const tasks = [createTask({ id: 'other', node_id: 'other-node' }), selectedTask];
    expect(resolveImplementTaskForContext({ tasks, selectedTaskId: selectedTask.id })).toBe(selectedTask);
    expect(resolveImplementTaskForContext({ tasks, selectedTaskId: selectedTask.node_id })).toBe(selectedTask);
  });

  it('leaves selection empty when the task is absent or the legacy reference is ambiguous', () => {
    const tasks = [
      createTask({ id: 'task:v1:develop:plan:node-1', status: 'InProgress' }),
      createTask({ id: 'task:v1:develop:other-plan:node-1' }),
    ];
    expect(resolveImplementTaskForContext({ tasks })).toBeNull();
    expect(resolveImplementTaskForContext({ tasks, selectedTaskId: 'deleted' })).toBeNull();
    expect(resolveImplementTaskForContext({ tasks, selectedTaskId: 'node-1' })).toBeNull();
  });
});
