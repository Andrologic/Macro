import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { cn } from '../../utils/cn';
import { TaskStatus } from '../../types';

const statusColors: Record<TaskStatus, string> = {
  Pending: 'from-zinc-500 to-zinc-600',
  InProgress: 'from-indigo-500 to-purple-600',
  AwaitingResponse: 'from-amber-500 to-orange-600',
  Completed: 'from-emerald-500 to-green-600',
  Failed: 'from-red-500 to-rose-600',
};

export const ChatZone: React.FC = () => {
  const { currentPlan, mode } = useAppStore();
  const { messages } = useChatStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [hoveredMessage, setHoveredMessage] = useState<string | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!currentPlan) {
    return (
      <main className="flex-1 flex items-center justify-center bg-zinc-950">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 mx-auto rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <Icon name="layers" size={24} className="text-zinc-600" />
          </div>
          <p className="text-zinc-600 text-sm">No plan selected</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col bg-zinc-950">
      {/* Minimal Header */}
      <header className="h-16 border-b border-zinc-800/50 flex items-center justify-between px-6 bg-zinc-900/30">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
            <Icon name="zap" size={13} className="text-indigo-500" />
          </div>
          <div>
            <h1 className="text-sm font-medium text-zinc-100">
              {currentPlan.description}
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-zinc-500">
                {mode === 'Architect' ? 'Architect' : 'Implement'}
              </span>
              <span className="text-zinc-700">·</span>
              <span className="text-xs text-zinc-500 font-mono">
                {currentPlan.tasks.filter((t) => t.status === 'Completed').length}/{currentPlan.tasks.length}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Conversation Stream - Asymmetrical Layout */}
      <div className="flex-1 overflow-y-auto px-12 py-8">
        <div className="max-w-4xl mx-auto space-y-8">
          {messages.map((message, index) => {
            const task = currentPlan.tasks.find((t) => t.id === message.task_id);
            const isFirstInTask = index === 0 || messages[index - 1].task_id !== message.task_id;
            const isHovered = hoveredMessage === message.id;

            return (
              <div key={message.id} className="relative">
                {/* Task Section */}
                {isFirstInTask && task && (
                  <div className="mb-4">
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          'w-1.5 h-1.5 rounded-full',
                          task.status === 'Completed'
                            ? 'bg-emerald-500'
                            : 'bg-indigo-500'
                        )}
                      />
                      <h2 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                        {task.title}
                      </h2>
                      <span
                        className={cn(
                          'text-xs font-medium ml-auto px-2 py-0.5 rounded',
                          task.status === 'Completed'
                            ? 'bg-emerald-500/10 text-emerald-500'
                            : 'bg-indigo-500/10 text-indigo-500'
                        )}
                      >
                        {task.status}
                      </span>
                    </div>
                  </div>
                )}

                {/* Message Card */}
                <div
                  className={cn(
                    'relative',
                    message.role === 'user' ? 'ml-auto mr-0 max-w-lg' : 'mr-auto ml-0 max-w-none'
                  )}
                >
                  <div
                    className={cn(
                      'relative p-4 rounded-lg',
                      message.role === 'user'
                        ? 'bg-zinc-800/80 border border-zinc-700/50'
                        : 'bg-transparent border-0'
                    )}
                  >
                    {/* Content with improved readability */}
                    <div
                      className={cn(
                        'text-sm leading-relaxed',
                        message.role === 'user'
                          ? 'text-zinc-100'
                          : 'text-zinc-300'
                      )}
                    >
                      {message.content.split('\n').map((line, i) => (
                        <p key={i} className="mb-2 last:mb-0">
                          {line}
                        </p>
                      ))}
                    </div>

                    {/* Choices - Simplified cards */}
                    {message.choices && (
                      <div className="mt-4 space-y-2">
                        {message.choices.map((choice) => (
                          <button
                            key={choice.id}
                            className="w-full text-left px-4 py-3 rounded-lg bg-zinc-900/50 border border-zinc-800 hover:border-indigo-500/50 hover:bg-zinc-900 transition-all duration-200"
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
            );
          })}

          {/* Scroll marker */}
          <div ref={messagesEndRef} className="h-8" />
        </div>
      </div>

      {/* Input Area */}
      <footer className="border-t border-zinc-800/50 bg-zinc-900/30 p-3">
        <div className="w-full max-w-3xl mx-auto space-y-3">
          {/* Control Buttons Row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* AI Mode/Skill Selector */}
              <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 hover:border-zinc-600 transition-colors">
                <Icon name="zap" size={12} className="text-indigo-500" />
                <span className="text-xs text-zinc-300">Default</span>
                <Icon name="chevron-down" size={10} className="text-zinc-500" />
              </button>

              {/* Model Selector */}
              <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 hover:border-zinc-600 transition-colors">
                <Icon name="tool" size={12} className="text-zinc-500" />
                <span className="text-xs text-zinc-300">GPT-4</span>
                <Icon name="chevron-down" size={10} className="text-zinc-500" />
              </button>
            </div>

            {/* Tools Selector */}
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 hover:border-zinc-600 transition-colors">
              <Icon name="tool" size={12} className="text-zinc-500" />
              <span className="text-xs text-zinc-300">Tools</span>
              <span className="text-xs text-zinc-500">(3)</span>
            </button>
          </div>

          {/* Input Field */}
          <div className="flex items-center gap-3 bg-zinc-900/80 border border-zinc-800 rounded-xl p-2">
            <input
              type="text"
              placeholder="Continue the conversation..."
              className="flex-1 bg-transparent border-0 outline-none text-sm text-zinc-100 placeholder-zinc-500 h-9 px-2"
              disabled
            />
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white px-3 h-9"
            >
              <Icon name="arrow-up" size={14} />
            </Button>
          </div>
        </div>
      </footer>
    </main>
  );
};
