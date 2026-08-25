import { describe, expect, it, mock } from 'bun:test';
import type { ProjectExecutionContext } from './projectExecutionContext';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import {
  applyTaskTodoOperations,
  formatTaskTodoResult,
  loadOpenTaskTodosForCompletion,
  resolveTaskTodoTarget,
} from './taskTodoToolService';

const createExecutionContext = (taskId = 'task-1'): ProjectExecutionContext => ({
  groupId: null,
  groupName: null,
  projectIds: ['project-1'],
  actionableProjectIds: ['project-1'],
  contextProjectIds: [],
  projectMounts: [],
  focusedProjectId: 'project-1',
  virtualRootEnabled: false,
  workspacePathsByProjectId: {},
  defaultWorkspacePath: null,
  projectId: 'project-1',
  projectName: null,
  taskId,
  branchName: 'feature/task-1',
  workspacePath: null,
});

const createTask = (
  overrides: Partial<CatalogedImplementTask> = {},
): CatalogedImplementTask => ({
  id: 'task-1',
  plan_id: 'plan-1',
  project_id: 'project-1',
  project_ids: ['project-1'],
  context_project_ids: [],
  title: 'Task 1',
  description: 'Task 1 description',
  status: 'InProgress',
  dependencies: [],
  estimated_changes: [],
  assigned_branch: 'feature/task-1',
  branch_name: 'feature/task-1',
  branch_id: 'branch-task-1',
  branch_task_index: 0,
  blocked_by_task_ids: [],
  blocked_by: [],
  is_blocked: false,
  is_ready: true,
  needs_revalidation: false,
  sequence_index: 0,
  execution_targets: [],
  todos: [{ id: 'todo-1', title: 'Todo 1', status: 'pending' }],
  task_source: 'architect',
  plan_title: 'Plan 1',
  plan_status: 'in_progress',
  plan_storage_branch: 'develop',
  plan_target_branch: 'develop',
  draft: false,
  standalone_kind: 'legacy',
  base_branch: null,
  feature_slug: 'task-1',
  conversation_id: null,
  archived_at: null,
  archive_reason: null,
  merged_at: null,
  ...overrides,
});

const createPlan = (
  overrides: Partial<ArchitectPlanRecord> = {},
): ArchitectPlanRecord => ({
  id: 'plan-1',
  slug: 'plan-1',
  title: 'Plan 1',
  description: 'Plan description',
  status: 'in_progress',
  targetBranch: 'develop',
  createdAt: '2026-05-09T10:00:00.000Z',
  updatedAt: '2026-05-09T10:00:00.000Z',
  nodes: [
    {
      id: 'task-1',
      title: 'Task 1',
      description: 'Task 1 description',
      type: 'task',
      status: 'in-progress',
      dependencies: [],
      todos: [{ id: 'todo-1', title: 'Todo 1', status: 'pending' }],
    },
  ],
  predictedBranches: [],
  ...overrides,
});

describe('taskTodoToolService', () => {
  it('resolves the current Architect task todo target', async () => {
    const getArchitectPlan = mock(async () => createPlan());

    const target = await resolveTaskTodoTarget({
      args: {},
      executionContext: createExecutionContext('task-1'),
      selectedTaskId: 'task-1',
      tasks: [createTask()],
      getArchitectPlan,
    });

    expect(target.task.id).toBe('task-1');
    expect(target.node.id).toBe('task-1');
  });

  it('refuses to target another task, including one in the current Implement plan', async () => {
    await expect(
      resolveTaskTodoTarget({
        args: { task_id: 'task-2' },
        executionContext: createExecutionContext('task-1'),
        selectedTaskId: 'task-1',
        tasks: [
          createTask(),
          createTask({ id: 'task-2', title: 'Task 2' }),
        ],
        getArchitectPlan: mock(async () => createPlan()),
      }),
    ).rejects.toThrow('current Implement task context');
  });

  it('refuses updates to archived Architect tasks', async () => {
    await expect(
      resolveTaskTodoTarget({
        args: {},
        executionContext: createExecutionContext('task-1'),
        selectedTaskId: 'task-1',
        tasks: [createTask({ archived_at: '2026-05-09T10:00:00.000Z' })],
        mutating: true,
        getArchitectPlan: mock(async () => createPlan()),
      }),
    ).rejects.toThrow('Archived Architect tasks cannot update todos');
  });

  it('refuses to remove the final todo from a task', () => {
    expect(() =>
      applyTaskTodoOperations(
        [{ id: 'todo-1', title: 'Todo 1', status: 'pending' }],
        [{ action: 'remove', todo_id: 'todo-1' }],
      ),
    ).toThrow('cannot leave an Architect task with no todos');
  });

  it('keeps generated todo ids stable when title-only todos are reordered', () => {
    const original = applyTaskTodoOperations([], [
      { action: 'add', title: 'Wire API' },
      { action: 'add', title: 'Update UI' },
    ]);
    const reordered = applyTaskTodoOperations(original, [
      { action: 'reorder', todo_id: original[1]?.id },
    ]);

    expect(reordered.map((todo) => todo.id).sort()).toEqual(
      original.map((todo) => todo.id).sort(),
    );
  });

  it('loads open completion todos from the plan instead of the task snapshot', async () => {
    const openTodos = await loadOpenTaskTodosForCompletion(
      createTask({ todos: [{ id: 'todo-1', title: 'Snapshot says done', status: 'done' }] }),
      mock(async () =>
        createPlan({
          nodes: [
            {
              id: 'task-1',
              title: 'Task 1',
              type: 'task',
              status: 'in-progress',
              dependencies: [],
              todos: [{ id: 'todo-1', title: 'Plan says pending', status: 'pending' }],
            },
          ],
        }),
      ),
    );

    expect(openTodos).toEqual([
      { id: 'todo-1', title: 'Plan says pending', status: 'pending' },
    ]);
  });

  it('does not block completion when the plan is legacy missing todos', async () => {
    const openTodos = await loadOpenTaskTodosForCompletion(
      createTask({ todos: [{ id: 'todo-1', title: 'Snapshot says pending', status: 'pending' }] }),
      mock(async () =>
        createPlan({
          nodes: [
            {
              id: 'task-1',
              title: 'Task 1',
              type: 'task',
              status: 'in-progress',
              dependencies: [],
            },
          ],
        }),
      ),
    );

    expect(openTodos).toEqual([]);
  });

  it('reports legacy missing todos in the tool result', () => {
    const result = formatTaskTodoResult('task_todo_get', {
      branchName: 'develop',
      plan: createPlan({
        nodes: [
          {
            id: 'task-1',
            title: 'Task 1',
            type: 'task',
            status: 'in-progress',
            dependencies: [],
          },
        ],
      }),
      node: {
        id: 'task-1',
        title: 'Task 1',
        type: 'task',
        status: 'in-progress',
        dependencies: [],
      },
      task: createTask(),
    });

    expect(result).toContain('has no generated todos');
    expect(result).toContain('"legacy_missing_todos": true');
    expect(result).toContain('"total": 0');
  });
});
