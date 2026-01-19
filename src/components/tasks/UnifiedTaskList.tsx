import React, { useMemo } from 'react';
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
  Pending: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20',
  InProgress: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
  AwaitingResponse: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  Completed: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  Failed: 'bg-red-500/10 text-red-500 border-red-500/20',
};

const statusOrder: TaskStatus[] = [
  'InProgress',
  'AwaitingResponse',
  'Pending',
  'Completed',
  'Failed',
];

export const UnifiedTaskList: React.FC<UnifiedTaskListProps> = ({
  className,
}) => {
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
        <div className="text-xs text-zinc-500">No tasks yet</div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {grouped.map(([projectId, projectTasks]) => {
        const project = getProjectById(projectId);
        return (
          <div key={projectId} className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Icon name="folder" size={12} className="text-zinc-500" />
              <span className="truncate">
                {project?.name ?? 'Unknown project'}
              </span>
              <span className="text-zinc-600">•</span>
              <span>{projectTasks.length} tasks</span>
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
                        ? 'bg-indigo-500/10 border-indigo-500/30'
                        : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
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
                          <h3 className="text-xs font-medium text-zinc-100 truncate">
                            {task.title}
                          </h3>
                          {conversation?.is_unread && (
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className={cn(
                              'inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded border',
                              statusColors[task.status]
                            )}
                          >
                            {task.status}
                          </span>
                          {conversation && conversation.message_count > 0 && (
                            <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                              <Icon name="message-square" size={10} />
                              {conversation.message_count}
                            </span>
                          )}
                        </div>
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
