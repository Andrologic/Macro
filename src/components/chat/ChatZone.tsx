import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { Skeleton } from '../shared/Skeleton';
import { ProviderDropdown } from '../ai/ProviderDropdown';
import { ModelDropdown } from '../ai/ModelDropdown';

export const ChatZone: React.FC = () => {
  const { mode, currentPlan } = useAppStore();
  const {
    conversations,
    selectedConversationId,
    selectConversation,
    createConversation,
    getConversationMessages,
    isLoading,
    sendMessage,
    editMessage,
  } = useChatStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inputValue, setInputValue] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

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

  const ensureConversation = () => {
    if (selectedConversationId) return selectedConversationId;
    const conversation = createConversation('New Conversation', null, null);
    return conversation.id;
  };

  const handleSend = async () => {
    if (!inputValue.trim()) return;
    const conversationId = ensureConversation();
    const content = inputValue.trim();
    setInputValue('');
    await sendMessage({ conversationId, content });
  };

  const handleEditStart = (messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditingValue(content);
  };

  const handleEditCancel = () => {
    setEditingMessageId(null);
    setEditingValue('');
  };

  const handleEditSave = async () => {
    if (!editingMessageId) return;
    const content = editingValue.trim();
    if (!content) return;
    await editMessage(editingMessageId, content);
    setEditingMessageId(null);
    setEditingValue('');
  };

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

        {/* Conversation Content */}
        <div className="flex-1 overflow-y-auto px-12 py-8">
          {selectedConversationId && currentMessages.length > 0 ? (
            <div className="max-w-4xl mx-auto space-y-6">
              {currentMessages.map((message) => {
                const isEditing = editingMessageId === message.id;

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
                        {isEditing ? (
                          <div className="space-y-2">
                            <textarea
                              value={editingValue}
                              onChange={(event) => setEditingValue(event.target.value)}
                              className="w-full min-h-[80px] resize-none bg-card border border-border rounded-lg p-2 text-sm text-foreground"
                            />
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                onClick={handleEditCancel}
                                className="px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-accent"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={handleEditSave}
                                className="px-3 py-1.5 rounded-md text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                              >
                                Save & Regenerate
                              </button>
                            </div>
                          </div>
                        ) : (
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
                        )}

                        {message.role === 'user' && !isEditing && (
                          <div className="mt-3 flex justify-end">
                            <button
                              onClick={() => handleEditStart(message.id, message.content)}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              Edit
                            </button>
                          </div>
                        )}

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
            </div>

            {/* Input Field */}
            <div className="flex items-center gap-3 bg-card/80 border border-border rounded-xl p-2">
              <input
                type="text"
                placeholder={
                  mode === 'Architect'
                    ? 'Describe your idea...'
                    : 'Ask the AI something...'
                }
                className="flex-1 bg-transparent border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground h-9 px-2"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
              />
              <button
                onClick={handleSend}
                className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground px-3 h-9 flex items-center"
              >
                {isLoading ? (
                  <Icon name="loader" size={14} className="animate-spin" />
                ) : (
                  <Icon name="arrow-up" size={14} />
                )}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
};
