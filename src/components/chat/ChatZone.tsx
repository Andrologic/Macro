import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { cn } from '../../utils/cn';
import { TaskStatus } from '../../types';

const statusColors: Record<TaskStatus, 'default' | 'success' | 'warning' | 'error' | 'primary'> = {
  Pending: 'default',
  InProgress: 'primary',
  AwaitingResponse: 'warning',
  Completed: 'success',
  Failed: 'error',
};

const statusIcons: Record<TaskStatus, 'clock' | 'loader' | 'alert-circle' | 'check' | 'x'> = {
  Pending: 'clock',
  InProgress: 'loader',
  AwaitingResponse: 'alert-circle',
  Completed: 'check',
  Failed: 'x',
};

export const ChatZone: React.FC = () => {
  const { currentPlan, mode } = useAppStore();
  const { messages } = useChatStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!currentPlan) {
    return (
      <main className="flex-1 flex items-center justify-center bg-background">
        <div className="text-center">
          <Icon name="layers" size={48} className="text-text-muted mx-auto mb-4" />
          <p className="text-text-muted">No plan selected</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col bg-zinc-950">
      {/* Header */}
      <header className="h-12 border-b border-zinc-800 bg-zinc-900 flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-zinc-100">
            {currentPlan.description}
          </h2>
          <Badge variant="primary" size="sm">
            {mode === 'Architect' ? 'Architect Mode' : 'Implement Mode'}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="default" size="sm">
            <Icon name="check" size={10} />
            {currentPlan.tasks.filter((t) => t.status === 'Completed').length}
            /{currentPlan.tasks.length}
          </Badge>
          <Button variant="ghost" size="sm">
            <Icon name="more-horizontal" size={14} />
          </Button>
        </div>
      </header>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto py-4 px-4">
          {messages.map((message, index) => {
            const task = currentPlan.tasks.find((t) => t.id === message.task_id);
            const isFirstInTask = index === 0 || messages[index - 1].task_id !== message.task_id;

            return (
              <div key={message.id}>
                {isFirstInTask && task && (
                  <div className="mb-4 mt-8 first:mt-0">
                    <div className="flex items-center gap-3 mb-3">
                      <Badge
                        variant={statusColors[task.status]}
                        dot
                        className="font-normal"
                      >
                        <Icon
                          name={statusIcons[task.status]}
                          size={10}
                        />
                        {task.status}
                      </Badge>
                      <h3 className="text-sm font-medium text-zinc-100">
                        {task.title}
                      </h3>
                    </div>
                  </div>
                )}

                {/* Message */}
                <div
                  className={cn(
                    'mb-4',
                    message.role === 'user' ? 'ml-12' : 'mr-12'
                  )}
                >
                  <div
                    className={cn(
                      'flex gap-3',
                      message.role === 'user' ? 'flex-row-reverse' : 'flex-row'
                    )}
                  >
                    {/* Avatar */}
                    <div
                      className={cn(
                        'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
                        message.role === 'user'
                          ? 'bg-indigo-500 text-white'
                          : 'bg-violet-500 text-white'
                      )}
                    >
                      {message.role === 'user' ? (
                        <Icon name="terminal" size={14} />
                      ) : (
                        <Icon name="zap" size={14} />
                      )}
                    </div>

                    {/* Content */}
                    <div
                      className={cn(
                        'flex-1',
                        message.role === 'user' ? 'text-right' : 'text-left'
                      )}
                    >
                      <div
                        className={cn(
                          'inline-block max-w-full',
                          message.role === 'user'
                            ? 'text-sm text-zinc-100'
                            : 'text-sm text-zinc-400'
                        )}
                      >
                        {message.content.split('\n').map((line, i) => (
                          <p key={i} className="mb-1 last:mb-0 whitespace-pre-wrap">
                            {line}
                          </p>
                        ))}
                      </div>

                      {/* Choices */}
                      {message.choices && (
                        <div className="mt-3 space-y-2">
                          {message.choices.map((choice) => (
                            <button
                              key={choice.id}
                              className="w-full text-left px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-indigo-500/50 hover:shadow-[0_0_20px_-4px_rgba(99,102,241,0.3)] transition-all duration-200"
                            >
                              <span className="text-sm text-zinc-400 font-mono">
                                {choice.text}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Scroll to bottom marker */}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <footer className="h-16 border-t border-zinc-800 bg-zinc-900 flex items-center gap-3 px-4">
        <div className="flex-1 flex items-center gap-3">
          <Icon name="terminal" size={14} className="text-zinc-500" />
          <input
            type="text"
            placeholder="Type your message..."
            className="flex-1 bg-transparent border-0 outline-none text-sm text-zinc-100 placeholder-zinc-500"
            disabled
          />
        </div>
        <Button variant="primary" size="sm" disabled>
          Send
        </Button>
      </footer>
    </main>
  );
};
