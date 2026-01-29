import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { useAIStore } from '../../stores/useAIStore';
import { useToolsStore } from '../../stores/useToolsStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { UnifiedTaskList } from '../tasks/UnifiedTaskList';
import { Skeleton } from '../shared/Skeleton';
import { ProviderDropdown } from '../ai/ProviderDropdown';
import { ModelDropdown } from '../ai/ModelDropdown';

export const ChatZone: React.FC = () => {
  const { currentPlan, mode, selectedTaskId, setSelectedTask, openToolsSettings } = useAppStore();
  const {
    conversations,
    selectedConversationId,
    selectConversation,
    createConversation,
    addMessage,
    getConversationMessages,
    isLoading,
  } = useChatStore();
  const { tasks } = useTaskStore();
  const {
    providers,
    models,
    selectedProviderId,
    selectedModelId,
  } = useAIStore();
  const { internalTools, mcpServers } = useToolsStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [inputValue, setInputValue] = useState('');

  // Count active tools and servers
  const activeInternalCount = Object.values(internalTools).filter(t => (t.config as any)?.enabled !== false).length;
  const activeMCPCount = mcpServers.filter(s => (s.config as any)?.enabled !== false).length;
  const totalActiveTools = activeInternalCount + activeMCPCount;

  // Filter messages by selected conversation
  const currentMessages = selectedConversationId
    ? getConversationMessages(selectedConversationId)
    : [];

  // Get current conversation details
  const currentConversation = selectedConversationId
    ? conversations.find((c) => c.id === selectedConversationId)
    : null;

  const selectedTask = selectedTaskId
    ? tasks.find((task) => task.id === selectedTaskId)
    : null;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages]);

  const ensureConversation = () => {
    if (selectedConversationId) return selectedConversationId;
    const conversation = createConversation('New Conversation', selectedTaskId, null);
    return conversation.id;
  };

  const handleSend = () => {
    if (!inputValue.trim()) return;
    const conversationId = ensureConversation();
    addMessage({
      id: `msg-${Date.now()}`,
      task_id: selectedTaskId ?? '',
      conversation_id: conversationId,
      role: 'user',
      content: inputValue,
      timestamp: new Date().toISOString(),
    });
    setInputValue('');

    setTimeout(() => {
      addMessage({
        id: `msg-${Date.now()}-ai`,
        task_id: selectedTaskId ?? '',
        conversation_id: conversationId,
        role: 'assistant',
        content:
          mode === 'Architect'
            ? 'Plan draft generated. Review the tasks above and confirm.'
            : 'Task analysis complete. Ready to generate the diff.',
        timestamp: new Date().toISOString(),
      });
    }, 400);
  };

  if (!currentPlan) {
    return (
      <main className="flex-1 flex items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 mx-auto rounded-xl bg-card border border-border flex items-center justify-center">
            <Icon name="layers" size={24} className="text-muted-foreground" />
          </div>
          <p className="text-muted-foreground text-sm">No plan selected</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex bg-background">
      {/* Conversation Sidebar */}
      {sidebarOpen && (
        <aside className="w-72 bg-card border-r border-border flex flex-col shrink-0">
          {/* Sidebar Header */}
          <div className="h-14 border-b border-border flex items-center justify-between px-3">
            <button
              onClick={() => createConversation('New Conversation', null, null)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-medium transition-colors"
            >
              <Icon name="plus" size={12} />
              New Chat
            </button>
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-1.5 rounded-lg hover:bg-accent transition-colors"
            >
              <Icon name="chevron-left" size={16} className="text-muted-foreground" />
            </button>
          </div>

          {/* Conversation List */}
          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="p-3 space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : conversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                <Icon name="message-square" size={32} className="text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">No conversations yet</p>
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
                          ? 'bg-primary/10 border-primary/30'
                          : 'border-transparent hover:bg-accent'
                      )}
                    >
                      <div className="flex items-start gap-3">
                        {/* Icon */}
                        <div className="mt-0.5 shrink-0">
                          {conv.task_id ? (
                            <div className="w-6 h-6 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                              <Icon name="check-square" size={10} className="text-primary" />
                            </div>
                          ) : (
                            <div className="w-6 h-6 rounded-lg bg-muted border border-border flex items-center justify-center">
                              <Icon name="message-square" size={10} className="text-muted-foreground" />
                            </div>
                          )}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          {/* Title */}
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="text-sm font-medium text-foreground truncate">
                              {conv.title}
                            </h3>
                            {conv.is_unread && (
                              <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                            )}
                          </div>

                          {/* Last message */}
                          {conv.last_message && (
                            <p className="text-xs text-muted-foreground truncate">
                              {conv.last_message}
                            </p>
                          )}

                          {/* Metadata */}
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-xs text-muted-foreground/70">
                              {new Date(conv.updated_at).toLocaleDateString()}
                            </span>
                            {conv.message_count > 0 && (
                              <span className="text-xs text-muted-foreground/70 flex items-center gap-1">
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
                            'text-muted-foreground/70 transition-transform duration-200 mt-2',
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
        <header className="h-14 border-b border-border/50 flex items-center justify-between px-4 bg-card/30">
          <div className="flex items-center gap-3 min-w-0">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-1.5 rounded-lg hover:bg-accent transition-colors"
              >
                <Icon name="chevron-right" size={16} className="text-muted-foreground" />
              </button>
            )}
            {currentConversation && (
              <>
                <div className="w-6 h-6 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                  {currentConversation.task_id ? (
                    <Icon name="check-square" size={10} className="text-primary" />
                  ) : (
                    <Icon name="message-square" size={10} className="text-primary" />
                  )}
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-medium text-foreground truncate">
                    {currentConversation.title}
                  </h1>
                  {currentPlan && currentConversation.task_id && (
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-muted-foreground text-xs">
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
              <span className="text-xs text-muted-foreground font-mono">
                {currentPlan.tasks.filter((t) => t.status === 'Completed').length}/{currentPlan.tasks.length}
              </span>
            </div>
          )}
        </header>

        {/* Unified Tasks */}
        <section className="border-b border-border/50 bg-background">
          <div className="h-11 flex items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <Icon name="list" size={14} className="text-primary" />
              <span className="text-xs font-medium text-foreground">
                Unified Tasks
              </span>
            </div>
            <button
              onClick={() => setTasksOpen((prev) => !prev)}
              className="p-1.5 rounded-lg hover:bg-accent transition-colors"
            >
              <Icon
                name={tasksOpen ? 'chevron-down' : 'chevron-right'}
                size={14}
                className="text-muted-foreground"
              />
            </button>
          </div>

          {tasksOpen && (
            <div className="max-h-64 overflow-y-auto px-4 pb-4">
              <UnifiedTaskList />
            </div>
          )}
        </section>

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
                            ? 'bg-muted/80 border border-border/50'
                            : 'bg-transparent border-0'
                        )}
                      >
                        {/* Content */}
                        <div
                          className={cn(
                            'text-sm leading-relaxed',
                            message.role === 'user'
                              ? 'text-foreground'
                              : 'text-muted-foreground'
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
                                className="w-full text-left px-4 py-3 rounded-lg bg-card/50 border border-border hover:border-primary/50 hover:bg-card transition-all duration-200"
                              >
                                <span className="text-sm text-muted-foreground font-mono">
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
                <div className="w-16 h-16 mx-auto rounded-xl bg-card border border-border flex items-center justify-center">
                  <Icon name={selectedConversationId ? 'message-square' : 'sparkles'} size={24} className="text-muted-foreground" />
                </div>
                <div>
                  {selectedConversationId ? (
                    <p className="text-muted-foreground text-sm">Start a conversation</p>
                  ) : (
                    <div>
                      <p className="text-muted-foreground text-sm mb-1">Select or create a conversation</p>
                      <button
                        onClick={() => createConversation('New Conversation', null, null)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium transition-colors"
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
        <footer className="border-t border-border/50 bg-card/30 p-3">
          <div className="w-full max-w-3xl mx-auto space-y-3">
            {/* Control Buttons Row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {/* Provider Selector */}
                <ProviderDropdown />

                {/* Model Selector */}
                <ModelDropdown />
              </div>

              {/* Tools Selector */}
              <button 
                onClick={openToolsSettings}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/80 border border-border hover:border-primary/50 transition-colors"
                title="Manage AI Tools & MCP Servers"
              >
                <Icon name="tool" size={12} className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Tools</span>
                {totalActiveTools > 0 && (
                  <span className="text-xs text-primary font-medium">
                    ({totalActiveTools})
                  </span>
                )}
              </button>
            </div>

            {/* Input Field */}
            <div className="flex items-center gap-3 bg-card/80 border border-border rounded-xl p-2">
              <input
                type="text"
                placeholder={
                  mode === 'Architect'
                    ? 'Describe the plan you want to build...'
                    : 'Ask the AI to execute a task...'
                }
                className="flex-1 bg-transparent border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground h-9 px-2"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
              />
              <button
                onClick={handleSend}
                className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground px-3 h-9 flex items-center"
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
