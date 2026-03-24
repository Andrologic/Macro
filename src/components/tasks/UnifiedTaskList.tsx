import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTaskStore } from '../../stores/useTaskStore';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { TaskStatus } from '../../types';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../shared/Skeleton';
import { cn } from '../../utils/cn';

interface UnifiedTaskListProps {
  className?: string;
}

const statusColors: Record<TaskStatus, string> = {
  Pending: 'bg-muted/50 text-muted-foreground border-border',
  InProgress: 'bg-primary/10 text-primary border-primary/20',
  AwaitingResponse: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  InReview: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  Completed: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  Failed: 'bg-red-500/10 text-red-500 border-red-500/20',
  Blocked: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
};

const statusOrder: TaskStatus[] = [
  'InProgress',
  'AwaitingResponse',
  'InReview',
  'Pending',
  'Blocked',
  'Completed',
  'Failed',
];

export const UnifiedTaskList: React.FC<UnifiedTaskListProps> = ({
  className,
}) => {
  const { t } = useTranslation();
  const { tasks, isLoading, lastError } = useTaskStore();
  const getProjectById = useAppStore((state) => state.getProjectById);
  const setSelectedTask = useAppStore((state) => state.setSelectedTask);
  const { selectedConversationId, selectConversation, getConversationByTask } =
    useChatStore();

  const grouped = useMemo(() => {
    const sorted = [...tasks].sort(
      (a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)
    );

    const groups = new Map<string, typeof sorted>();
    for (const task of sorted) {
      const list = groups.get(task.project_id) ?? [];
      list.push(task);
      groups.set(task.project_id, list);
    }
    return Array.from(groups.entries());
  }, [tasks]);

  if (isLoading) {
    return (
      <div className={cn('space-y-2', className)}>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  if (lastError) {
    return (
      <div className={cn('flex items-center justify-center h-32', className)}>
        <div className="text-xs text-red-400">{lastError}</div>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className={cn('flex items-center justify-center h-32', className)}>
        <div className="text-xs text-muted-foreground">{t('tasks.noTasks', 'No tasks yet')}</div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {grouped.map(([projectId, projectTasks]) => {
        const project = getProjectById(projectId);
        return (
          <div key={projectId} className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon name="folder" size={12} className="text-muted-foreground" />
              <span className="truncate">
                {project?.name ?? t('project.unknownProject', 'Unknown project')}
              </span>
              <span className="text-muted-foreground/70">•</span>
              <span>{t('implement.taskCount', '{{count}} tasks', { count: projectTasks.length })}</span>
            </div>

            <div className="grid grid-cols-1 gap-2">
              {projectTasks.map((task) => {
                const conversation = getConversationByTask(task.id);
                const isSelected = conversation?.id === selectedConversationId;
                return (
                  <button
                    key={task.id}
                    onClick={() => {
                      setSelectedTask(task.id);
                      if (conversation) {
                        selectConversation(conversation.id);
                      }
                    }}
                    className={cn(
                      'w-full text-left px-3 py-2 rounded-lg border transition-all duration-200',
                      isSelected
                        ? 'bg-primary/10 border-primary/30'
                        : 'bg-card/50 border-border hover:border-primary/30'
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={cn(
                          'mt-1 w-2 h-2 rounded-full shrink-0',
                          statusColors[task.status].split(' ')[0]
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-xs font-medium text-foreground truncate">
                            {task.title}
                          </h3>
                          {conversation?.is_unread && (
                            <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                          )}
                        </div>
                        {conversation && conversation.message_count > 0 && (
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                              <Icon name="message-square" size={10} />
                              {conversation.message_count}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};
