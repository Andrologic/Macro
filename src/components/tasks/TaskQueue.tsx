import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore, type ImplementTask } from '../../stores/useTaskStore';
import { Icon, IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { toast } from '../ui/Toaster';
import type { TaskStatus } from '../../types';

interface TaskQueueProps {
  className?: string;
}

const statusConfig: Record<TaskStatus, { icon: IconName; color: string; bgColor: string }> = {
  Pending: { icon: 'circle', color: 'text-muted-foreground', bgColor: 'bg-muted' },
  InProgress: { icon: 'loader', color: 'text-amber-500', bgColor: 'bg-amber-500/10' },
  AwaitingResponse: { icon: 'message-circle', color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  Completed: { icon: 'check-circle', color: 'text-emerald-500', bgColor: 'bg-emerald-500/10' },
  Failed: { icon: 'alert-circle', color: 'text-red-400', bgColor: 'bg-red-500/10' },
  Blocked: { icon: 'lock', color: 'text-orange-400', bgColor: 'bg-orange-500/10' },
};

const readyStatusOrder: Record<TaskStatus, number> = {
  InProgress: 0,
  AwaitingResponse: 1,
  Pending: 2,
  Blocked: 3,
  Failed: 4,
  Completed: 5,
};

interface TaskItemProps {
  task: ImplementTask;
  isSelected: boolean;
  isBusy: boolean;
  statusLabel: string;
  onSelect: () => void;
  onStart: () => void;
  onAwaitingResponse: () => void;
  onFail: () => void;
  onRetry: () => void;
  onComplete: () => void;
}

const TaskItem: React.FC<TaskItemProps> = ({
  task,
  isSelected,
  isBusy,
  statusLabel,
  onSelect,
  onStart,
  onAwaitingResponse,
  onFail,
  onRetry,
  onComplete,
}) => {
  const { t } = useTranslation();
  const status = statusConfig[task.status] || statusConfig.Pending;
  const canStart = !isBusy && task.is_ready && (task.status === 'Pending' || task.status === 'Blocked');
  const canComplete =
    !isBusy && !task.is_blocked && (task.status === 'InProgress' || task.status === 'AwaitingResponse');
  const canAwaitingResponse = !isBusy && !task.is_blocked && task.status === 'InProgress';
  const canFail = !isBusy && !task.is_blocked && (task.status === 'InProgress' || task.status === 'AwaitingResponse');
  const canRetry = !isBusy && !task.is_blocked && (task.status === 'Failed' || task.status === 'AwaitingResponse');
  const lockTooltip = task.is_blocked
    ? t('implement.blockedBy', 'Blocked by: {{tasks}}', {
      tasks: task.blocked_by.join(', '),
    })
    : '';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'w-full text-left px-3 py-3 rounded-lg border transition-all duration-200 group cursor-pointer',
        isSelected ? 'bg-primary/10 border-primary/30' : 'border-transparent hover:bg-accent'
      )}
    >
      <div className="flex items-start gap-3">
        <div className="relative shrink-0 group/lock">
          <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center', status.bgColor)}>
            <Icon
              name={status.icon}
              size={14}
              className={cn(status.color, task.status === 'InProgress' && 'animate-spin')}
            />
          </div>
          {task.is_blocked && task.blocked_by.length > 0 && (
            <div className="pointer-events-none absolute left-0 top-8 z-20 hidden min-w-56 max-w-72 rounded-md border border-orange-500/30 bg-popover px-2 py-1.5 text-xs text-orange-300 shadow-lg group-hover/lock:block">
              {lockTooltip}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-foreground leading-tight">{task.title}</h3>

          {task.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{task.description}</p>
          )}

          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {task.status !== 'Blocked' && (
              <span className={cn('text-xs px-1.5 py-0.5 rounded', status.bgColor, status.color)}>
                {statusLabel}
              </span>
            )}

            <span className="text-xs text-muted-foreground inline-flex items-center gap-1 leading-none">
              <Icon name="git-branch" size={10} />
              {task.branch_name}
            </span>

            {task.branch_task_index >= 0 && (
              <span
                className="text-xs text-muted-foreground font-mono inline-flex items-center leading-none"
                title={t('implement.sequenceHintHelp', 'Execution order in branch')}
              >
                {t('implement.sequenceHint', '#{{step}}', {
                  step: task.branch_task_index + 1,
                })}
              </span>
            )}
          </div>

        </div>

        <div className="shrink-0 flex items-center gap-1">
          {isBusy && (
            <span
              className="p-1.5 rounded-lg bg-muted text-muted-foreground"
              title={t('implement.taskActionInProgress', 'Updating task status...')}
            >
              <Icon name="loader" size={12} className="animate-spin" />
            </span>
          )}
          {canStart && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void onStart();
              }}
              className="p-1.5 rounded-lg bg-primary/10 text-primary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-primary/20"
              title={t('implement.startTask', 'Start task')}
            >
              <Icon name="play" size={12} />
            </button>
          )}
          {canAwaitingResponse && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void onAwaitingResponse();
              }}
              className="p-1.5 rounded-lg bg-blue-500/10 text-blue-500 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-blue-500/20"
              title={t('implement.markAwaitingResponse', 'Mark awaiting response')}
            >
              <Icon name="message-circle" size={12} />
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void onRetry();
              }}
              className="p-1.5 rounded-lg bg-amber-500/10 text-amber-500 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-amber-500/20"
              title={t('implement.retryTask', 'Retry task')}
            >
              <Icon name="refresh-cw" size={12} />
            </button>
          )}
          {canFail && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void onFail();
              }}
              className="p-1.5 rounded-lg bg-red-500/10 text-red-500 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-red-500/20"
              title={t('implement.markFailed', 'Mark failed')}
            >
              <Icon name="x" size={12} />
            </button>
          )}
          {canComplete && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void onComplete();
              }}
              className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-500 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-emerald-500/20"
              title={t('implement.completeTask', 'Mark complete')}
            >
              <Icon name="check" size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const MemoizedTaskItem = React.memo(TaskItem);

const TaskQueueBase: React.FC<TaskQueueProps> = ({ className }) => {
  const { t } = useTranslation();
  const { selectedGroupId, selectedProjectId, selectedTaskId, projectGroups } = useAppStore();
  const tasks = useTaskStore((state) => state.tasks);
  const activateTask = useTaskStore((state) => state.activateTask);
  const startTask = useTaskStore((state) => state.startTask);
  const completeTask = useTaskStore((state) => state.completeTask);
  const markTaskAwaitingResponse = useTaskStore((state) => state.markTaskAwaitingResponse);
  const markTaskFailed = useTaskStore((state) => state.markTaskFailed);
  const retryTask = useTaskStore((state) => state.retryTask);
  const taskError = useTaskStore((state) => state.lastError);
  const lastErrorToastRef = useRef<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (!taskError || taskError === lastErrorToastRef.current) return;
    lastErrorToastRef.current = taskError;
    toast.error(taskError);
  }, [taskError]);

  const runTaskAction = async (taskId: string, action: () => Promise<void>) => {
    if (pendingTaskId) return;
    setPendingTaskId(taskId);
    try {
      await action();
    } finally {
      setPendingTaskId((current) => (current === taskId ? null : current));
    }
  };

  const confirmFailTask = (task: ImplementTask): boolean => {
    return window.confirm(
      t('implement.confirmFailTask', 'Mark task "{{title}}" as failed?', { title: task.title })
    );
  };

  const statusLabels: Record<TaskStatus, string> = {
    Pending: t('tasks.pending', 'Pending'),
    InProgress: t('tasks.inProgress', 'In Progress'),
    AwaitingResponse: t('implement.awaitingResponse', 'Awaiting response'),
    Completed: t('tasks.completed', 'Completed'),
    Failed: t('implement.failed', 'Failed'),
    Blocked: t('tasks.blocked', 'Blocked'),
  };

  const scopedTasks = useMemo(() => {
    if (selectedProjectId) {
      return tasks.filter((task) => task.project_id === selectedProjectId);
    }

    if (selectedGroupId) {
      const group = projectGroups.find((candidate) => candidate.id === selectedGroupId);
      const groupProjectIds = new Set(group?.projects.map((project) => project.id) ?? []);
      if (groupProjectIds.size === 0) return [];
      return tasks.filter((task) => groupProjectIds.has(task.project_id));
    }

    return [];
  }, [tasks, selectedProjectId, selectedGroupId, projectGroups]);

  const readyTasks = useMemo(() => {
    return [...scopedTasks]
      .filter((task) => !task.is_blocked && task.status !== 'Completed')
      .sort((a, b) => {
        const byStatus = readyStatusOrder[a.status] - readyStatusOrder[b.status];
        if (byStatus !== 0) return byStatus;
        return a.sequence_index - b.sequence_index;
      });
  }, [scopedTasks]);

  const blockedTasks = useMemo(() => {
    return [...scopedTasks]
      .filter((task) => task.is_blocked)
      .sort((a, b) => a.sequence_index - b.sequence_index);
  }, [scopedTasks]);

  const completedCount = scopedTasks.filter((task) => task.status === 'Completed').length;
  const inProgressCount = scopedTasks.filter((task) => task.status === 'InProgress').length;
  const totalCount = scopedTasks.length;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  if (!selectedGroupId) {
    return (
      <aside className={cn('h-full w-full bg-card border-r border-border flex items-center justify-center', className)}>
        <div className="text-center px-6">
          <Icon name="list-todo" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">
            {t('implement.selectProject', 'Select a project to view tasks')}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={cn('h-full w-full bg-card border-r border-border flex flex-col', className)}>
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="list-todo" size={16} className="text-primary" />
          {t('implement.tasks', 'Tasks')}
        </h1>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {inProgressCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-500">
              {t('implement.activeCount', '{{count}} active', { count: inProgressCount })}
            </span>
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">{t('architect.progress', 'Progress')}</span>
          <span className="text-xs font-medium text-foreground">
            {completedCount}/{totalCount}
          </span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {scopedTasks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Icon name="check-circle" size={32} className="text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              {t('implement.noTasks', 'No tasks yet')}
            </p>
          </div>
        )}

        {scopedTasks.length > 0 && (
          <>
            <section className="space-y-1">
              <div className="px-1 pb-1 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/80">
                  {t('implement.readyTasks', 'Ready tasks')}
                </h2>
                <span className="text-xs text-muted-foreground">{readyTasks.length}</span>
              </div>

              {readyTasks.length === 0 && (
                <div className="px-2 py-3 text-xs text-muted-foreground rounded border border-dashed border-border">
                  {t('implement.noReadyTasks', 'No task is currently runnable.')}
                </div>
              )}

              {readyTasks.map((task) => (
                <MemoizedTaskItem
                  key={task.id}
                  task={task}
                  isSelected={selectedTaskId === task.id}
                  isBusy={pendingTaskId === task.id}
                  statusLabel={statusLabels[task.status]}
                  onSelect={() => void activateTask(task.id)}
                  onStart={() => void runTaskAction(task.id, () => startTask(task.id))}
                  onAwaitingResponse={() =>
                    void runTaskAction(task.id, () => markTaskAwaitingResponse(task.id))
                  }
                  onFail={() => {
                    if (!confirmFailTask(task)) return;
                    void runTaskAction(task.id, () => markTaskFailed(task.id));
                  }}
                  onRetry={() => void runTaskAction(task.id, () => retryTask(task.id))}
                  onComplete={() => void runTaskAction(task.id, () => completeTask(task.id))}
                />
              ))}
            </section>

            <section className="space-y-1 pt-1 border-t border-border/60">
              <div className="px-1 pb-1 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-orange-400">
                  {t('implement.blockedTasks', 'Blocked tasks')}
                </h2>
                <span className="text-xs text-muted-foreground">{blockedTasks.length}</span>
              </div>

              {blockedTasks.length === 0 && (
                <div className="px-2 py-3 text-xs text-muted-foreground rounded border border-dashed border-border">
                  {t('implement.noBlockedTasks', 'No dependency-blocked task.')}
                </div>
              )}

              {blockedTasks.map((task) => (
                <MemoizedTaskItem
                  key={task.id}
                  task={task}
                  isSelected={selectedTaskId === task.id}
                  isBusy={pendingTaskId === task.id}
                  statusLabel={statusLabels[task.status]}
                  onSelect={() => void activateTask(task.id)}
                  onStart={() => void runTaskAction(task.id, () => startTask(task.id))}
                  onAwaitingResponse={() =>
                    void runTaskAction(task.id, () => markTaskAwaitingResponse(task.id))
                  }
                  onFail={() => {
                    if (!confirmFailTask(task)) return;
                    void runTaskAction(task.id, () => markTaskFailed(task.id));
                  }}
                  onRetry={() => void runTaskAction(task.id, () => retryTask(task.id))}
                  onComplete={() => void runTaskAction(task.id, () => completeTask(task.id))}
                />
              ))}
            </section>
          </>
        )}
      </div>

      <div className="h-10 border-t border-border flex items-center justify-between px-4 bg-card">
        <span className="text-xs text-muted-foreground">
          {t('implement.taskCount', '{{count}} tasks', { count: scopedTasks.length })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('implement.completedCount', '{{count}} completed', { count: completedCount })}
        </span>
      </div>
    </aside>
  );
};

export const TaskQueue = React.memo(TaskQueueBase);

export default TaskQueue;
