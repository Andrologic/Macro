import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PlanNodeTodo } from '../../types';
import { summarizePlanNodeTodoProgress } from '../../services/planNodeTodos';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

const POPOVER_OFFSET_CLASS = 'mt-[1.875rem]';
const POPOVER_SIZE_CLASS = 'max-h-[min(26rem,calc(100vh-6rem))] w-[min(28rem,calc(100vw-2rem))]';

const TaskTodoStatusIcon: React.FC<{ status: PlanNodeTodo['status'] }> = ({ status }) => {
  if (status === 'done') {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
        <Icon name="check" size={9} />
      </span>
    );
  }

  if (status === 'in-progress') {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-500">
        <Icon name="loader" size={9} />
      </span>
    );
  }

  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Icon name="circle" size={7} />
    </span>
  );
};

interface ImplementTaskTodoDropdownProps {
  taskTitle: string;
  todos: PlanNodeTodo[];
  isOpen: boolean;
  onToggle: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
}

export const ImplementTaskTodoDropdown: React.FC<ImplementTaskTodoDropdownProps> = ({
  taskTitle,
  todos,
  isOpen,
  onToggle,
  rootRef,
}) => {
  const { t } = useTranslation();
  const progress = summarizePlanNodeTodoProgress(todos);
  const progressPercent = progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0;
  const toggleLabel = t('implement.taskTodoToggle', 'Show task checklist');

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={toggleLabel}
        title={toggleLabel}
        data-testid="implement-task-todos-toggle"
        className={cn(
          'group relative flex h-7 w-7 items-center justify-center rounded-lg border transition-all focus:outline-none focus:ring-2 focus:ring-primary/20',
          isOpen
            ? 'border-primary/45 bg-primary/20 text-primary shadow-sm shadow-primary/10'
            : 'border-primary/20 bg-primary/10 text-primary hover:border-primary/35 hover:bg-primary/15'
        )}
      >
        <Icon name="list-todo" size={13} />
        {isOpen && (
          <span className="absolute inset-0 rounded-lg ring-1 ring-inset ring-primary/30" aria-hidden="true" />
        )}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label={t('implement.taskTodoDropdownLabel', 'Task checklist')}
          data-testid="implement-task-todos-dropdown"
          className={cn(
            'absolute left-0 top-full z-30 flex flex-col rounded-lg border border-border bg-popover p-3 shadow-lg',
            POPOVER_OFFSET_CLASS,
            POPOVER_SIZE_CLASS
          )}
        >
          <div className="mb-3 min-w-0 shrink-0">
            <div className="truncate text-sm font-medium text-foreground">{taskTitle}</div>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t('implement.taskTodoProgressCompact', '{{done}}/{{total}}', {
                  done: progress.done,
                  total: progress.total,
                })}
              </span>
            </div>
          </div>

          <div
            data-testid="implement-task-todos-list"
            className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1"
          >
            {todos.map((todo) => (
              <div
                key={todo.id}
                className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5"
                data-implement-task-todo={todo.id}
              >
                <TaskTodoStatusIcon status={todo.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-foreground">{todo.title}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
