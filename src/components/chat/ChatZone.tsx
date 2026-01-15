import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';

export const ChatZone: React.FC = () => {
  const { currentPlan } = useAppStore();
  const {
    conversations,
    selectedConversationId,
    selectConversation,
    createConversation,
    getConversationMessages,
  } = useChatStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Filter messages by selected conversation
  const currentMessages = selectedConversationId
    ? getConversationMessages(selectedConversationId)
    : [];

  // Get current conversation details
  const currentConversation = selectedConversationId
    ? conversations.find((c) => c.id === selectedConversationId)
    : null;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages]);

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
    <main className="flex-1 flex bg-zinc-950">
      {/* Conversation Sidebar */}
      {sidebarOpen && (
        <aside className="w-72 bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0">
          {/* Sidebar Header */}
          <div className="h-14 border-b border-zinc-800 flex items-center justify-between px-3">
            <button
              onClick={() => createConversation('New Conversation', null, null)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-medium transition-colors"
            >
              <Icon name="plus" size={12} />
              New Chat
            </button>
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
            >
              <Icon name="chevron-left" size={16} className="text-zinc-500" />
            </button>
          </div>

          {/* Conversation List */}
          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                <Icon name="message-square" size={32} className="text-zinc-600 mb-3" />
                <p className="text-sm text-zinc-500">No conversations yet</p>
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {conversations.map((conv) => {
                  const isSelected = conv.id === selectedConversationId;
                  return (
                    <button
                      key={conv.id}
                      onClick={() => selectConversation(conv.id)}
                      className={cn(
                        'w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-200 group',
                        isSelected
                          ? 'bg-indigo-500/10 border-indigo-500/30'
                          : 'border-transparent hover:bg-zinc-800'
                      )}
                    >
                      <div className="flex items-start gap-3">
                        {/* Icon */}
                        <div className="mt-0.5 shrink-0">
                          {conv.task_id ? (
                            <div className="w-6 h-6 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                              <Icon name="check-square" size={10} className="text-indigo-500" />
                            </div>
                          ) : (
                            <div className="w-6 h-6 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center">
                              <Icon name="message-square" size={10} className="text-zinc-500" />
                            </div>
                          )}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          {/* Title */}
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="text-sm font-medium text-zinc-100 truncate">
                              {conv.title}
                            </h3>
                            {conv.is_unread && (
                              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
                            )}
                          </div>

                          {/* Last message */}
                          {conv.last_message && (
                            <p className="text-xs text-zinc-500 truncate">
                              {conv.last_message}
                            </p>
                          )}

                          {/* Metadata */}
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-xs text-zinc-600">
                              {new Date(conv.updated_at).toLocaleDateString()}
                            </span>
                            {conv.message_count > 0 && (
                              <span className="text-xs text-zinc-600 flex items-center gap-1">
                                <Icon name="message-square" size={8} />
                                {conv.message_count}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Chevron */}
                        <Icon
                          name="chevron-right"
                          size={12}
                          className={cn(
                            'text-zinc-600 transition-transform duration-200 mt-2',
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
        </aside>
      )}

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-14 border-b border-zinc-800/50 flex items-center justify-between px-4 bg-zinc-900/30">
          <div className="flex items-center gap-3 min-w-0">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
              >
                <Icon name="chevron-right" size={16} className="text-zinc-500" />
              </button>
            )}
            {currentConversation && (
              <>
                <div className="w-6 h-6 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
                  {currentConversation.task_id ? (
                    <Icon name="check-square" size={10} className="text-indigo-500" />
                  ) : (
                    <Icon name="message-square" size={10} className="text-indigo-500" />
                  )}
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-medium text-zinc-100 truncate">
                    {currentConversation.title}
                  </h1>
                  {currentPlan && currentConversation.task_id && (
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-zinc-500 text-xs">
                        Task {currentConversation.task_id}
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {currentPlan && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 font-mono">
                {currentPlan.tasks.filter((t) => t.status === 'Completed').length}/{currentPlan.tasks.length}
              </span>
            </div>
          )}
        </header>

        {/* Conversation Content */}
        <div className="flex-1 overflow-y-auto px-12 py-8">
          {selectedConversationId && currentMessages.length > 0 ? (
            <div className="max-w-4xl mx-auto space-y-6">
              {currentMessages.map((message) => {

                return (
                  <div key={message.id} className="relative">
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
                        {/* Content */}
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

                        {/* Choices */}
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
              <div ref={messagesEndRef} className="h-8" />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                  <Icon name={selectedConversationId ? 'message-square' : 'sparkles'} size={24} className="text-zinc-600" />
                </div>
                <div>
                  {selectedConversationId ? (
                    <p className="text-zinc-600 text-sm">Start a conversation</p>
                  ) : (
                    <div>
                      <p className="text-zinc-600 text-sm mb-1">Select or create a conversation</p>
                      <button
                        onClick={() => createConversation('New Conversation', null, null)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium transition-colors"
                      >
                        <Icon name="plus" size={12} />
                        New Conversation
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <footer className="border-t border-zinc-800/50 bg-zinc-900/30 p-3">
          <div className="w-full max-w-3xl mx-auto">
            <div className="flex items-center gap-3 bg-zinc-900/80 border border-zinc-800 rounded-xl p-2">
              <input
                type="text"
                placeholder="Type a message..."
                className="flex-1 bg-transparent border-0 outline-none text-sm text-zinc-100 placeholder-zinc-500 h-9 px-2"
                disabled
              />
              <button
                disabled
                className="rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white px-3 h-9 flex items-center"
              >
                <Icon name="arrow-up" size={14} />
              </button>
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
};
