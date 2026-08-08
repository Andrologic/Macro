import { describe, expect, it } from 'bun:test';

import {
  resolvePlanNodeTodoPresentation,
  summarizePlanNodeTodoProgress,
} from './planNodeTodos';

describe('resolvePlanNodeTodoPresentation', () => {
  it('normalizes raw todo arrays before presenting progress', () => {
    const presentation = resolvePlanNodeTodoPresentation([
      { id: 'todo-1', title: 'Ship UI', status: 'complete' as never },
      { id: 'todo-2', title: 'Wire model', status: 'in-progress' },
      { id: 'todo-3', title: 'Review copy', status: 'open' as never },
    ]);

    expect(presentation.todos.map((todo) => todo.status)).toEqual([
      'done',
      'in-progress',
      'pending',
    ]);
    expect(presentation.progress).toEqual({ done: 1, total: 3 });
    expect(presentation.openCount).toBe(2);
    expect(presentation.completedCount).toBe(1);
    expect(presentation.hasActiveTodo).toBe(true);
  });

  it('uses the same progress semantics as the existing progress helper', () => {
    const todos = [
      { id: 'todo-1', title: 'Done', status: 'done' as const },
      { id: 'todo-2', title: 'Pending', status: 'pending' as const },
    ];

    expect(resolvePlanNodeTodoPresentation(todos).progress).toEqual(
      summarizePlanNodeTodoProgress(todos),
    );
  });
});
