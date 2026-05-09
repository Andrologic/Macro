import type { PlanNode, PlanNodeStatus, PlanNodeTodo, PlanNodeTodoStatus } from '../types';

export const PLAN_NODE_TODO_STATUSES = ['pending', 'in-progress', 'done'] as const;

const PLAN_NODE_TODO_STATUS_SET = new Set<string>(PLAN_NODE_TODO_STATUSES);

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const slugifyTodoTitle = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 32) || 'todo';

export const normalizePlanNodeTodoStatus = (
  value: unknown,
): PlanNodeTodoStatus => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'completed' || raw === 'complete' || raw === 'checked') {
    return 'done';
  }
  if (raw === 'todo' || raw === 'open') {
    return 'pending';
  }
  return PLAN_NODE_TODO_STATUS_SET.has(raw)
    ? (raw as PlanNodeTodoStatus)
    : 'pending';
};

const normalizeTodoId = (
  rawId: unknown,
  title: string,
  existingTodos?: PlanNodeTodo[],
): string => {
  const explicitId = typeof rawId === 'string' ? rawId.trim() : '';
  if (explicitId) {
    return explicitId;
  }
  const existingMatch = existingTodos?.find(
    (todo) => todo.title.trim().toLowerCase() === title.trim().toLowerCase(),
  );
  if (existingMatch?.id) {
    return existingMatch.id;
  }
  return `todo-${slugifyTodoTitle(title)}-${stableHash(title).slice(0, 6)}`;
};

export const normalizePlanNodeTodos = (
  rawTodos: unknown,
  options: { existingTodos?: PlanNodeTodo[] } = {},
): PlanNodeTodo[] => {
  if (!Array.isArray(rawTodos)) {
    return [];
  }

  const usedIds = new Set<string>();
  return rawTodos.reduce<PlanNodeTodo[]>((acc, rawTodo, index) => {
    const todo: Record<string, unknown> =
      rawTodo && typeof rawTodo === 'object'
        ? (rawTodo as Record<string, unknown>)
        : { title: rawTodo };
    const title = typeof todo.title === 'string' ? todo.title.trim() : '';
    if (!title) {
      return acc;
    }

    const baseId = normalizeTodoId(todo.id, title, options.existingTodos);
    let id = baseId;
    if (usedIds.has(id)) {
      id = `${baseId}-${stableHash(`${baseId}:${index}`).slice(0, 6)}`;
    }
    usedIds.add(id);

    const description =
      typeof todo.description === 'string' && todo.description.trim()
        ? todo.description.trim()
        : undefined;

    acc.push({
      id,
      title,
      ...(description ? { description } : {}),
      status: normalizePlanNodeTodoStatus(todo.status),
    });
    return acc;
  }, []);
};

export const clonePlanNodeTodos = (
  todos: PlanNodeTodo[] | undefined,
): PlanNodeTodo[] | undefined => {
  if (!Array.isArray(todos)) {
    return undefined;
  }
  return todos.map((todo) => ({ ...todo }));
};

export const hasStoredPlanNodeTodos = (
  node: Pick<PlanNode, 'todos'>,
): boolean => Array.isArray(node.todos);

export type PlanNodeTodoState =
  | { kind: 'legacy_missing'; todos: [] }
  | { kind: 'stored_empty'; todos: [] }
  | { kind: 'stored'; todos: PlanNodeTodo[] };

export const getPlanNodeTodoState = (
  node: Pick<PlanNode, 'todos'>,
): PlanNodeTodoState => {
  if (!Array.isArray(node.todos)) {
    return { kind: 'legacy_missing', todos: [] };
  }
  const todos = normalizePlanNodeTodos(node.todos);
  if (todos.length === 0) {
    return { kind: 'stored_empty', todos: [] };
  }
  return { kind: 'stored', todos };
};

const nodeStatusToImplicitTodoStatus = (
  status: PlanNodeStatus,
): PlanNodeTodoStatus => {
  if (status === 'completed') {
    return 'done';
  }
  if (status === 'in-progress') {
    return 'in-progress';
  }
  return 'pending';
};

export const getPlanNodeTodosForDisplay = (
  node: Pick<PlanNode, 'id' | 'title' | 'description' | 'status' | 'todos'>,
): PlanNodeTodo[] => {
  return getPlanNodeTodoState(node).todos;
};

export const normalizeRequiredPlanNodeTodos = (
  rawTodos: unknown,
  node: Pick<PlanNode, 'title' | 'description' | 'status'> & { id?: string },
  options: { existingTodos?: PlanNodeTodo[] } = {},
): PlanNodeTodo[] => {
  const normalized = normalizePlanNodeTodos(rawTodos, options);
  if (normalized.length > 0) {
    return normalized;
  }
  return [
    {
      id: `todo-${slugifyTodoTitle(node.title)}-${stableHash(node.id || node.title).slice(0, 6)}`,
      title: node.title,
      ...(node.description ? { description: node.description } : {}),
      status: nodeStatusToImplicitTodoStatus(node.status),
    },
  ];
};

export const getOpenStoredPlanNodeTodos = (
  node: Pick<PlanNode, 'todos'>,
): PlanNodeTodo[] =>
  normalizePlanNodeTodos(node.todos).filter((todo) => todo.status !== 'done');

export const summarizePlanNodeTodoProgress = (
  todos: PlanNodeTodo[],
): { done: number; total: number } => ({
  done: todos.filter((todo) => todo.status === 'done').length,
  total: todos.length,
});

export interface PlanNodeTodoPresentation {
  todos: PlanNodeTodo[];
  progress: { done: number; total: number };
  openCount: number;
  completedCount: number;
  hasActiveTodo: boolean;
}

export const resolvePlanNodeTodoPresentation = (
  nodeOrTodos:
    | PlanNodeTodo[]
    | Pick<PlanNode, 'todos'>,
): PlanNodeTodoPresentation => {
  const todos = Array.isArray(nodeOrTodos)
    ? normalizePlanNodeTodos(nodeOrTodos)
    : getPlanNodeTodoState(nodeOrTodos).todos;
  const progress = summarizePlanNodeTodoProgress(todos);
  return {
    todos,
    progress,
    openCount: todos.length - progress.done,
    completedCount: progress.done,
    hasActiveTodo: todos.some((todo) => todo.status === 'in-progress'),
  };
};
