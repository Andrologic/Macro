import React, { useState, useMemo } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { TaskStatus } from '../../types';
import { Icon } from '../ui/Icon';

import { cn } from '../../utils/cn';

type TaskSortOption = 'updated' | 'created' | 'status';

interface TaskListViewProps {
  projectId: string;
}

const statusColors: Record<TaskStatus, string> = {
  Pending: 'bg-muted/50 text-muted-foreground border-border',
  InProgress: 'bg-primary/10 text-primary border-primary/20',
  AwaitingResponse: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  Completed: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  Failed: 'bg-red-500/10 text-red-500 border-red-500/20',
};

const statusLabels: Record<TaskStatus, string> = {
  Pending: 'To Do',
  InProgress: 'In Progress',
  AwaitingResponse: 'Waiting',
  Completed: 'Done',
  Failed: 'Failed',
};

export const TaskListView: React.FC<TaskListViewProps> = ({ projectId }) => {
  const { currentPlan } = useAppStore();
  const { selectedConversationId, selectConversation, getConversationByTask } =
    useChatStore();
  const [sortOption, setSortOption] = useState<TaskSortOption>('updated');

  // Filter tasks by project
  const projectTasks = useMemo(() => {
    if (!currentPlan) return [];
    return currentPlan.tasks.filter((task) => task.project_id === projectId);
  }, [currentPlan, projectId]);

  // Sort tasks based on selected option
  const sortedTasks = useMemo(() => {
    const tasks = [...projectTasks];
    switch (sortOption) {
      case 'updated':
        return tasks.sort((a, b) => {
          const convA = getConversationByTask(a.id);
          const convB = getConversationByTask(b.id);
          const dateA = convA?.updated_at || '';
          const dateB = convB?.updated_at || '';
          return dateB.localeCompare(dateA);
        });
      case 'created':
        return tasks.sort((a, b) => a.id.localeCompare(b.id));
      case 'status':
        const statusOrder: TaskStatus[] = [
          'InProgress',
          'AwaitingResponse',
          'Pending',
          'Completed',
          'Failed',
        ];
        return tasks.sort((a, b) => {
          const indexA = statusOrder.indexOf(a.status);
          const indexB = statusOrder.indexOf(b.status);
          return indexA - indexB;
        });
      default:
        return tasks;
    }
  }, [projectTasks, sortOption, getConversationByTask]);

  const handleTaskClick = (taskId: string) => {
    const conversation = getConversationByTask(taskId);
    if (conversation) {
      selectConversation(conversation.id);
    }
  };

  const getTaskConversation = (taskId: string) => {
    return getConversationByTask(taskId);
  };

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Header with sort options */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h2 className="text-sm font-semibold text-foreground">Tasks</h2>
        <div className="flex items-center gap-1">
          <select
            value={sortOption}
            onChange={(e) => setSortOption(e.target.value as TaskSortOption)}
            className="text-xs bg-muted border border-border rounded-md px-2 py-1 text-muted-foreground outline-none focus:border-primary"
          >
            <option value="updated">Updated</option>
            <option value="created">Created</option>
            <option value="status">Status</option>
          </select>
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {sortedTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center">
            <Icon name="check" size={32} className="text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No tasks for this project</p>
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {sortedTasks.map((task) => {
              const conversation = getTaskConversation(task.id);
              const isSelected = conversation?.id === selectedConversationId;

              return (
                <button
                  key={task.id}
                  onClick={() => handleTaskClick(task.id)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-200 group hover:bg-accent/50',
                    isSelected
                      ? 'bg-primary/10 border-primary/30'
                      : 'border-transparent bg-transparent'
                  )}
                >
                  <div className="flex items-start gap-3">
                    {/* Status indicator */}
                    <div
                      className={cn(
                        'mt-0.5 w-2 h-2 rounded-full shrink-0',
                        statusColors[task.status].split(' ')[0]
                      )}
                    />

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {/* Title */}
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-medium text-foreground truncate">
                          {task.title}
                        </h3>
                        {conversation?.is_unread && (
                          <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
                        )}
                      </div>

                      {/* Status badge */}
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded border',
                            statusColors[task.status]
                          )}
                        >
                          {statusLabels[task.status]}
                        </span>

                        {/* Message count */}
                        {conversation && conversation.message_count > 0 && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Icon name="message-square" size={10} />
                            {conversation.message_count}
                          </span>
                        )}

                        {/* Dependencies count */}
                        {task.dependencies.length > 0 && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Icon name="git-branch" size={10} />
                            {task.dependencies.length}
                          </span>
                        )}
                      </div>

                      {/* Last message preview */}
                      {conversation?.last_message && (
                        <p className="mt-1.5 text-xs text-muted-foreground truncate">
                          {conversation.last_message}
                        </p>
                      )}
                    </div>

                    {/* Chevron */}
                    <Icon
                      name="chevron-right"
                      size={14}
                      className={cn(
                        'text-muted-foreground transition-transform duration-200',
                        isSelected ? 'rotate-90' : 'opacity-0 group-hover:opacity-100'
                      )}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer with task count */}
      <div className="h-10 border-t border-border flex items-center justify-between px-4 bg-card">
        <div className="flex items-center gap-2">
          <Icon name="list" size={14} className="text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {sortedTasks.filter((t) => t.status !== 'Completed').length} active
          </span>
        </div>
        <span className="text-xs text-muted-foreground/70">
          {sortedTasks.length} total
        </span>
      </div>
    </div>
  );
};
