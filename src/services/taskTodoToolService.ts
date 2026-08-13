import type { ProjectExecutionContext } from './projectExecutionContext';
import type { ArchitectPlanRecord } from './architectPlanService';
import {
  getGitFlowBaseBranch,
  resolveTargetBranch,
} from './architectPlanService';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import { isPlanFinalizationTask } from './implementTaskCatalog';
import { toServiceError } from './contracts/errors';
import type { PlanNodeTodo, PlanNodeTodoStatus } from '../types';
import {
  getPlanNodeTodosForDisplay,
  getPlanNodeTodoState,
  hasStoredPlanNodeTodos,
  normalizePlanNodeTodoStatus,
  normalizePlanNodeTodos,
  PLAN_NODE_TODO_STATUSES,
  summarizePlanNodeTodoProgress,
} from './planNodeTodos';

type TaskTodoToolName = 'task_todo_get' | 'task_todo_update';

export interface TaskTodoToolTarget {
  branchName: string;
  plan: ArchitectPlanRecord;
  node: ArchitectPlanRecord['nodes'][number];
  task: CatalogedImplementTask;
}

export interface ResolveTaskTodoTargetParams {
  args: Record<string, unknown>;
  executionContext: ProjectExecutionContext;
  selectedTaskId?: string | null;
  tasks: CatalogedImplementTask[];
  mutating?: boolean;
  getArchitectPlan: (branchName: string, planId: string) => Promise<ArchitectPlanRecord | null>;
}

export type TaskTodoCompletionTask = Pick<
  CatalogedImplementTask,
  | 'id'
  | 'title'
  | 'task_source'
  | 'plan_id'
  | 'plan_storage_branch'
  | 'plan_target_branch'
  | 'todos'
>;

const getRequestedTaskId = (
  args: Record<string, unknown>,
  executionContext: ProjectExecutionContext,
  selectedTaskId?: string | null,
): string => {
  const explicitTaskId =
    typeof args.task_id === 'string' && args.task_id.trim()
      ? args.task_id.trim()
      : typeof args.taskId === 'string' && args.taskId.trim()
        ? args.taskId.trim()
        : '';
  return explicitTaskId || executionContext.taskId || selectedTaskId || '';
};

const assertSameImplementPlanContext = (params: {
  requestedTask: CatalogedImplementTask;
  currentTask: CatalogedImplementTask | null;
}): void => {
  const { requestedTask, currentTask } = params;
  if (!currentTask || currentTask.id === requestedTask.id) {
    return;
  }
  throw toServiceError('task_todo_* can only target the current Implement task context.');
};

export const resolveTaskTodoTarget = async (
  params: ResolveTaskTodoTargetParams,
): Promise<TaskTodoToolTarget> => {
  const requestedTaskId = getRequestedTaskId(
    params.args,
    params.executionContext,
    params.selectedTaskId,
  );
  if (!requestedTaskId) {
    throw toServiceError('task_todo_* requires an Implement task context or task_id.');
  }

  const task = params.tasks.find((candidate) => candidate.id === requestedTaskId);
  if (!task) {
    throw toServiceError(`Unknown task: ${requestedTaskId}`);
  }
  const currentTaskId = params.executionContext.taskId || params.selectedTaskId || '';
  const currentTask =
    currentTaskId ? params.tasks.find((candidate) => candidate.id === currentTaskId) || null : null;
  if (!currentTask) {
    throw toServiceError('task_todo_* requires a current Implement task context.');
  }
  assertSameImplementPlanContext({ requestedTask: task, currentTask });

  if (isPlanFinalizationTask(task)) {
    throw toServiceError('Plan finalization tasks do not have implementation todos.');
  }
  if (task.task_source !== 'architect' || !task.plan_id) {
    throw toServiceError('Task todos are only available for Architect tasks.');
  }
  if (params.mutating && task.archived_at) {
    throw toServiceError('Archived Architect tasks cannot update todos.');
  }

  const branchName = resolveTargetBranch(
    task.plan_storage_branch || task.plan_target_branch || getGitFlowBaseBranch(),
  );
  const plan = await params.getArchitectPlan(branchName, task.plan_id);
  if (!plan || plan.status === 'deleted') {
    throw toServiceError(`Cannot load plan metadata for task ${task.id}.`);
  }
  const node = (plan.nodes || []).find((candidate) => candidate.id === task.id);
  if (!node) {
    throw toServiceError(`Cannot find Architect node for task ${task.id}.`);
  }
  if (params.mutating && node.archivedAt) {
    throw toServiceError('Archived Architect tasks cannot update todos.');
  }

  return { branchName, plan, node, task };
};

export const formatTaskTodoResult = (
  action: TaskTodoToolName,
  target: TaskTodoToolTarget,
): string => {
  const todoState = getPlanNodeTodoState(target.node);
  const todos = getPlanNodeTodosForDisplay(target.node);
  const progress = summarizePlanNodeTodoProgress(todos);
  const legacyMissingTodos = todoState.kind === 'legacy_missing';
  return [
    legacyMissingTodos
      ? `${action}: ${target.task.title} has no generated todos because this plan predates task checklists.`
      : `${action}: ${target.task.title} (${progress.done}/${progress.total} todos done).`,
    '',
    'Structured context:',
    JSON.stringify(
      {
        action,
        task_id: target.task.id,
        plan_id: target.plan.id,
        persisted: hasStoredPlanNodeTodos(target.node),
        legacy_missing_todos: legacyMissingTodos,
        todo_state: todoState.kind,
        progress,
        todos,
      },
      null,
      2,
    ),
  ].join('\n');
};

const normalizeOperationStatus = (
  rawStatus: unknown,
  operationLabel: string,
): PlanNodeTodoStatus => {
  const raw = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
  if (!PLAN_NODE_TODO_STATUSES.includes(raw as PlanNodeTodoStatus)) {
    throw toServiceError(`${operationLabel}: invalid status.`);
  }
  return normalizePlanNodeTodoStatus(raw);
};

export const applyTaskTodoOperations = (
  currentTodosInput: unknown,
  operationsInput: unknown,
): PlanNodeTodo[] => {
  if (!Array.isArray(operationsInput) || operationsInput.length === 0) {
    throw toServiceError('task_todo_update requires at least one operation.');
  }

  let todos = normalizePlanNodeTodos(currentTodosInput);
  for (const [index, rawOperation] of operationsInput.entries()) {
    const operation =
      rawOperation && typeof rawOperation === 'object'
        ? (rawOperation as Record<string, unknown>)
        : {};
    const action =
      typeof operation.action === 'string'
        ? operation.action.trim().toLowerCase()
        : '';
    const operationLabel = `task_todo_update ${action || 'operation'} failed at operation ${index + 1}`;
    const todoId =
      typeof operation.todo_id === 'string' && operation.todo_id.trim()
        ? operation.todo_id.trim()
        : typeof operation.todoId === 'string' && operation.todoId.trim()
          ? operation.todoId.trim()
          : '';
    const locateIndex = todoId
      ? todos.findIndex((todo) => todo.id === todoId)
      : -1;

    if (action === 'add') {
      const title = typeof operation.title === 'string' ? operation.title.trim() : '';
      if (!title) {
        throw toServiceError(`${operationLabel}: missing title.`);
      }
      const description =
        typeof operation.description === 'string' && operation.description.trim()
          ? operation.description.trim()
          : undefined;
      const status = Object.prototype.hasOwnProperty.call(operation, 'status')
        ? normalizeOperationStatus(operation.status, operationLabel)
        : 'pending';
      todos = normalizePlanNodeTodos(
        [
          ...todos,
          {
            id: todoId || undefined,
            title,
            ...(description ? { description } : {}),
            status,
          },
        ],
        { existingTodos: todos },
      );
      continue;
    }

    if (!todoId || locateIndex < 0) {
      throw toServiceError(`${operationLabel}: todo not found.`);
    }

    if (action === 'remove') {
      todos = todos.filter((todo) => todo.id !== todoId);
      continue;
    }

    if (action === 'update' || action === 'set_status') {
      todos = todos.map((todo) => {
        if (todo.id !== todoId) {
          return todo;
        }
        const title =
          action === 'update' && typeof operation.title === 'string'
            ? operation.title.trim()
            : todo.title;
        if (!title) {
          throw toServiceError(`${operationLabel}: missing title.`);
        }
        const hasDescription = Object.prototype.hasOwnProperty.call(operation, 'description');
        const description =
          action === 'update' && hasDescription
            ? typeof operation.description === 'string' && operation.description.trim()
              ? operation.description.trim()
              : undefined
            : todo.description;
        const status = Object.prototype.hasOwnProperty.call(operation, 'status')
          ? normalizeOperationStatus(operation.status, operationLabel)
          : todo.status;
        return {
          ...todo,
          title,
          ...(description ? { description } : {}),
          status,
        };
      });
      todos = normalizePlanNodeTodos(todos, { existingTodos: todos });
      continue;
    }

    if (action === 'reorder') {
      const [moved] = todos.splice(locateIndex, 1);
      const afterTodoId =
        typeof operation.after_todo_id === 'string'
          ? operation.after_todo_id.trim()
          : typeof operation.afterTodoId === 'string'
            ? operation.afterTodoId.trim()
            : '';
      if (!afterTodoId) {
        todos.unshift(moved);
        continue;
      }
      const afterIndex = todos.findIndex((todo) => todo.id === afterTodoId);
      if (afterIndex < 0) {
        throw toServiceError(`${operationLabel}: after_todo_id not found.`);
      }
      todos.splice(afterIndex + 1, 0, moved);
      continue;
    }

    throw toServiceError(`${operationLabel}: unsupported action "${action}".`);
  }

  const normalized = normalizePlanNodeTodos(todos, { existingTodos: todos });
  if (normalized.length === 0) {
    throw toServiceError('task_todo_update cannot leave an Architect task with no todos.');
  }
  return normalized;
};

export const loadOpenTaskTodosForCompletion = async (
  task: TaskTodoCompletionTask,
  getArchitectPlan: (branchName: string, planId: string) => Promise<ArchitectPlanRecord | null>,
): Promise<PlanNodeTodo[]> => {
  if (task.task_source !== 'architect') {
    return [];
  }
  if (!task.plan_id) {
    return [];
  }

  const branchName = resolveTargetBranch(
    task.plan_storage_branch || task.plan_target_branch || getGitFlowBaseBranch(),
  );
  const plan = await getArchitectPlan(branchName, task.plan_id);
  const node = plan?.nodes?.find((candidate) => candidate.id === task.id);
  const todoState = node ? getPlanNodeTodoState(node) : getPlanNodeTodoState(task);
  const todos = todoState.kind === 'stored' ? todoState.todos : [];
  return todos.filter((todo) => todo.status !== 'done');
};
