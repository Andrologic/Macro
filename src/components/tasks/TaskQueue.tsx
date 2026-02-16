import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { Icon, IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import type { Task, TaskStatus } from '../../types';

interface TaskQueueProps {
  className?: string;
}

/**
 * TaskQueue - Displays and manages project tasks in Implement mode
 *
 * PERFORMANCE: Lazy loaded via ModeRouter, only rendered when Implement mode is active
 */

const statusConfig: Record<TaskStatus, { icon: IconName; color: string; bgColor: string; label: string }> = {
  'Pending': { icon: 'circle', color: 'text-muted-foreground', bgColor: 'bg-muted', label: 'En attente' },
  'InProgress': { icon: 'loader', color: 'text-amber-500', bgColor: 'bg-amber-500/10', label: 'En cours' },
  'AwaitingResponse': { icon: 'message-circle', color: 'text-blue-400', bgColor: 'bg-blue-500/10', label: 'Réponse attendue' },
  'Completed': { icon: 'check-circle', color: 'text-emerald-500', bgColor: 'bg-emerald-500/10', label: 'Terminé' },
  'Failed': { icon: 'alert-circle', color: 'text-red-400', bgColor: 'bg-red-500/10', label: 'Échoué' },
  'Blocked': { icon: 'lock', color: 'text-orange-400', bgColor: 'bg-orange-500/10', label: 'Bloqué' },
};

interface TaskItemProps {
  task: Task;
  isSelected: boolean;
  onSelect: () => void;
  blockedBy?: string[];
}

const TaskItem: React.FC<TaskItemProps> = ({ task, isSelected, onSelect, blockedBy }) => {
  const status = statusConfig[task.status] || statusConfig['Pending'];
  const isBlocked = blockedBy && blockedBy.length > 0;

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left px-3 py-3 rounded-lg border transition-all duration-200 group',
        isSelected
          ? 'bg-primary/10 border-primary/30'
          : 'border-transparent hover:bg-accent'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Status Icon */}
        <div className={cn(
          'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
          status.bgColor
        )}>
          <Icon
            name={status.icon}
            size={14}
            className={cn(status.color, task.status === 'InProgress' && 'animate-spin')}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-foreground leading-tight">
            {task.title}
          </h3>

          {/* Description preview */}
          {task.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {task.description}
            </p>
          )}

          {/* Meta info */}
          <div className="flex items-center gap-3 mt-2">
            <span className={cn('text-xs px-1.5 py-0.5 rounded', status.bgColor, status.color)}>
              {status.label}
            </span>

            {task.estimated_changes.length > 0 && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Icon name="file" size={10} />
                {task.estimated_changes.length} fichier{task.estimated_changes.length > 1 ? 's' : ''}
              </span>
            )}

            {isBlocked && (
              <span className="text-xs text-orange-400 flex items-center gap-1">
                <Icon name="lock" size={10} />
                Bloqué
              </span>
            )}
          </div>

          {/* Blocked by */}
          {isBlocked && (
            <div className="mt-2 px-2 py-1.5 rounded bg-orange-500/5 border border-orange-500/20">
              <p className="text-xs text-orange-400">
                <Icon name="alert-circle" size={10} className="inline mr-1" />
                En attente de: {blockedBy!.join(', ')}
              </p>
            </div>
          )}
        </div>

        {/* Action button */}
        {task.status === 'Pending' && !isBlocked && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              // Would trigger task execution
            }}
            className="p-1.5 rounded-lg bg-primary/10 text-primary opacity-0 group-hover:opacity-100 transition-opacity hover:bg-primary/20"
            title="Démarrer la tâche"
          >
            <Icon name="play" size={12} />
          </button>
        )}
      </div>
    </button>
  );
};

// Performance: Memoize TaskItem to prevent re-renders when other tasks change
const MemoizedTaskItem = React.memo(TaskItem);

// Use memoized version in the component
const TaskQueueBase: React.FC<TaskQueueProps> = ({ className }) => {
  const { t } = useTranslation();
  const { selectedGroupId, selectedProjectId, selectedTaskId, setSelectedTask } = useAppStore();
  const tasks = useTaskStore((state) => state.tasks);
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');

  // Get dependency names for blocking info
  const getBlockingTasks = (task: Task): string[] => {
    if (task.dependencies.length === 0) return [];

    const incompleteDepNames: string[] = [];
    task.dependencies.forEach(depId => {
      const depTask = tasks.find(t => t.id === depId);
      if (depTask && depTask.status !== 'Completed') {
        incompleteDepNames.push(depTask.title);
      }
    });

    return incompleteDepNames;
  };

  // Filter and sort tasks
  const filteredTasks = useMemo(() => {
    let result = [...tasks];

    // Filter by project if selected
    if (selectedProjectId) {
      result = result.filter(t => t.project_id === selectedProjectId);
    }

    // Filter by status
    if (filter !== 'all') {
      result = result.filter(t => t.status === filter);
    }

    // Sort: InProgress first, then AwaitingResponse, Pending, Completed, Failed
    const statusOrder: Record<TaskStatus, number> = {
      'InProgress': 0,
      'AwaitingResponse': 1,
      'Pending': 2,
      'Blocked': 3,
      'Completed': 4,
      'Failed': 5,
    };

    result.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    return result;
  }, [tasks, filter, selectedProjectId]);

  // Stats
  const completedCount = tasks.filter(t => t.status === 'Completed').length;
  const inProgressCount = tasks.filter(t => t.status === 'InProgress').length;
  const totalCount = tasks.length;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  if (!selectedGroupId) {
    return (
      <aside
        className={cn("h-full w-full bg-card border-r border-border flex items-center justify-center", className)}
      >
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
    <aside
      className={cn("h-full w-full bg-card border-r border-border flex flex-col", className)}
    >
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="list-todo" size={16} className="text-primary" />
          {t('implement.tasks', 'Tasks')}
        </h1>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {inProgressCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-500">
              {inProgressCount} actif{inProgressCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">Progression</span>
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

      {/* Filters */}
      <div className="px-3 py-2 border-b border-border overflow-x-auto">
        <div className="flex gap-1">
          {(['all', 'InProgress', 'Pending', 'Completed'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-2 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors',
                filter === f
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
            >
              {f === 'all' ? 'Tous' : statusConfig[f]?.label || f}
            </button>
          ))}
        </div>
      </div>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Icon name="check-circle" size={32} className="text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              {filter === 'all'
                ? t('implement.noTasks', 'No tasks yet')
                : t('implement.noTasksFilter', 'No tasks with this status')}
            </p>
          </div>
        ) : (
          filteredTasks.map((task) => (
            <MemoizedTaskItem
              key={task.id}
              task={task}
              isSelected={selectedTaskId === task.id}
              onSelect={() => setSelectedTask(task.id)}
              blockedBy={getBlockingTasks(task)}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="h-12 border-t border-border flex items-center justify-between px-4 bg-card">
        <span className="text-xs text-muted-foreground">
          {filteredTasks.length} tâche{filteredTasks.length > 1 ? 's' : ''}
        </span>
        <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-primary hover:bg-primary/10 transition-colors">
          <Icon name="plus" size={12} />
          Ajouter
        </button>
      </div>
    </aside>
  );
};

// Performance: Memoize the entire component to prevent re-renders
export const TaskQueue = React.memo(TaskQueueBase);

// Export default for lazy loading compatibility
export default TaskQueue;
