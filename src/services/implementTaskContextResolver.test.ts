import { describe, expect, it } from 'bun:test';
import type { ProjectGroup } from '../types';
import type { CatalogedImplementTask as ImplementTask } from './implementTaskCatalog';
import { resolveImplementTaskForContext } from './implementTaskContextResolver';

const projectGroups: ProjectGroup[] = [
  {
    id: 'group-1',
    name: 'Macro',
    isOpen: true,
    projects: [
      {
        id: 'project-1',
        name: 'Web',
        path: '/repos/web',
        mountName: 'web',
        created_at: '2026-03-19T00:00:00.000Z',
        status: 'active',
        metadata: {
          description: '',
          tags: [],
          team_members: [],
          api_contracts: [],
          dependencies: [],
        },
      },
    ],
  },
];

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

const resolve = (
  tasks: ImplementTask[],
  overrides: Partial<Parameters<typeof resolveImplementTaskForContext>[0]> = {},
) => resolveImplementTaskForContext({
  tasks,
  projectGroups,
  selectedGroupId: 'group-1',
  selectedProjectId: 'project-1',
  ...overrides,
});

describe('resolveImplementTaskForContext', () => {
  it('keeps an explicitly selected task even when it is archived or outside the current project scope', () => {
    const selectedTask = createTask({
      id: 'task-selected',
      project_id: 'project-2',
      project_ids: ['project-2'],
      archived_at: '2026-08-14T10:00:00.000Z',
    });

    expect(resolve([selectedTask], { selectedTaskId: selectedTask.id })).toBe(selectedTask);
  });

  it('restores the local task through its durable node reference before applying status priority', () => {
    const localTask = createTask({ id: 'task:v1:plan:local', node_id: 'local-node' });
    const activeTask = createTask({ id: 'task-active', status: 'InProgress' });

    expect(resolve([activeTask, localTask], {
      localContext: {
        projectId: 'project-1',
        groupId: 'group-1',
        focusProjectId: 'project-1',
        lastPlanId: null,
        architectConversationId: null,
        implementConversationId: null,
        lastTaskId: 'local-node',
        updatedAt: '2026-08-21T10:00:00.000Z',
      },
    })).toBe(localTask);
  });

  it('chooses the highest-priority scoped task and uses sequence order as the tie-breaker', () => {
    const pendingTask = createTask({ id: 'task-pending', status: 'Pending', sequence_index: 0 });
    const laterActiveTask = createTask({ id: 'task-active-later', status: 'InProgress', sequence_index: 2 });
    const firstActiveTask = createTask({ id: 'task-active-first', status: 'InProgress', sequence_index: 1 });
    const archivedTask = createTask({
      id: 'task-archived',
      status: 'InProgress',
      sequence_index: 0,
      archived_at: '2026-08-14T10:00:00.000Z',
    });

    expect(resolve([pendingTask, laterActiveTask, firstActiveTask, archivedTask])).toBe(firstActiveTask);
  });

  it('retargets a standalone task with stale project identity to the current selection for eligibility', () => {
    const staleStandaloneTask = createTask({
      id: 'task-standalone',
      task_source: 'standalone',
      project_id: 'removed-project',
      project_ids: ['removed-project'],
    });

    expect(resolve([staleStandaloneTask])).toBe(staleStandaloneTask);
  });

  it('returns null when every unselected task is outside the current project scope', () => {
    const outsideTask = createTask({
      id: 'task-outside',
      project_id: 'project-2',
      project_ids: ['project-2'],
    });

    expect(resolve([outsideTask])).toBeNull();
  });
});
