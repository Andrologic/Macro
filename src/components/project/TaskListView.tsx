import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { TaskStatus } from '../../types';
import { Icon } from '../ui/Icon';
import { TaskStatusIndicator } from '../tasks/TaskStatusIndicator';
import { Select } from '../ui/Select';
import { cn } from '../../utils/cn';
import {
  resolveRunningTaskIds,
  resolveTaskStatusIndicatorState,
} from '../../services/taskStatusPresentation';

type TaskSortOption = 'updated' | 'created' | 'status';

interface TaskListViewProps {
  projectId: string;
}

const indicatorColors: Record<TaskStatus, string> = {
  Pending: 'text-muted-foreground',
  InProgress: 'text-primary',
  AwaitingResponse: 'text-amber-500',
  InReview: 'text-sky-500',
  Completed: 'text-emerald-500',
  Failed: 'text-red-500',
  Blocked: 'text-orange-500',
};

export const TaskListView: React.FC<TaskListViewProps> = ({ projectId }) => {
  const { t } = useTranslation();
  const { currentPlan, setSelectedTask } = useAppStore();
  const {
    conversations,
    conversationRuntimeById,
    selectedConversationId,
    selectConversation,
    getConversationByTask,
  } =
    useChatStore();
  const [sortOption, setSortOption] = useState<TaskSortOption>('updated');
  const mergeWorkflowRuntimeByTaskId = useTaskStore(
    (state) => state.mergeWorkflowRuntimeByTaskId
  );
  const runningTaskIds = useMemo(
    () =>
      resolveRunningTaskIds({
        conversations,
        conversationRuntimeById,
      }),
    [conversationRuntimeById, conversations]
  );

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
          'InReview',
          'Pending',
          'Completed',
          'Failed',
          'Blocked',
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
    setSelectedTask(taskId);
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
        <h2 className="text-sm font-semibold text-foreground">{t('tasks.tasks', 'Tasks')}</h2>
        <div className="flex items-center gap-1">
          <Select
            value={sortOption}
            onChange={(e) => setSortOption(e.target.value as TaskSortOption)}
            fullWidth={false}
            className="text-xs rounded-md px-2 py-1"
          >
            <option value="updated">{t('tasks.sort.updated', 'Updated')}</option>
            <option value="created">{t('tasks.sort.created', 'Created')}</option>
            <option value="status">{t('common.status', 'Status')}</option>
          </Select>
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {sortedTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center">
            <Icon name="check" size={32} className="text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">{t('tasks.noTasksForProject', 'No tasks for this project')}</p>
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {sortedTasks.map((task) => {
              const conversation = getTaskConversation(task.id);
              const isSelected = conversation?.id === selectedConversationId;
              const isAssistantRunning = runningTaskIds.has(task.id);
              const indicatorState = resolveTaskStatusIndicatorState(
                task.status,
                isAssistantRunning,
                null,
                mergeWorkflowRuntimeByTaskId[task.id] ?? null
              );
              const indicatorColor = isAssistantRunning
                ? 'text-amber-500'
                : indicatorColors[task.status];

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
                    <TaskStatusIndicator
                      state={indicatorState}
                      layout="compact"
                      size={10}
                      dotSize={8}
                      className={cn('mt-0.5 shrink-0', indicatorColor)}
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

                      {(conversation && conversation.message_count > 0) ||
                      task.dependencies.length > 0 ? (
                        <div className="flex items-center gap-2">
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
                      ) : null}

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
            {t('implement.activeCount', '{{count}} active', {
              count: sortedTasks.filter((task) => task.status !== 'Completed').length,
            })}
          </span>
        </div>
        <span className="text-xs text-muted-foreground/70">
          {sortedTasks.length} {t('models.total', 'total')}
        </span>
      </div>
    </div>
  );
};
