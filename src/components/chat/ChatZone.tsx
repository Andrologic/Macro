import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useProviderStore } from '../../stores/useProviderStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { Skeleton } from '../shared/Skeleton';
import { ProviderDropdown } from '../ai/ProviderDropdown';
import { ModelDropdown } from '../ai/ModelDropdown';
import { MarkdownRenderer, estimateTokens, formatTokenCount } from './MarkdownRenderer';

export const ChatZone: React.FC = () => {
  const { t } = useTranslation();
  const { currentPlan } = useAppStore();
  const {
    conversations,
    selectedConversationId,
    selectConversation,
    createConversation,
    renameConversation,
    deleteConversation,
    getConversationMessages,
    isLoading,
    isStreaming,
    stopStreaming,
    sendMessage,
    editMessage,
  } = useChatStore();

  const { selectedProviderId, selectedModelId } = useProviderStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inputValue, setInputValue] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Filter messages by selected conversation
  const currentMessages = selectedConversationId
    ? getConversationMessages(selectedConversationId)
    : [];

  // Get current conversation details
  const currentConversation = selectedConversationId
    ? conversations.find((c) => c.id === selectedConversationId)
    : null;

  // Estimate tokens for input
  const inputTokens = estimateTokens(inputValue);
  const contextTokens = currentMessages.reduce(
    (sum, msg) => sum + estimateTokens(msg.content),
    0
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages]);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenuId(null);
    if (contextMenuId) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenuId]);

  const ensureConversation = async () => {
    if (selectedConversationId) return selectedConversationId;
    const conversation = await createConversation('New Conversation', null, null);
    return conversation.id;
  };

  const handleSend = async () => {
    if (!inputValue.trim() || isLoading) return;
    const conversationId = await ensureConversation();
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

  const handleContextMenu = (e: React.MouseEvent, conversationId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuId(conversationId);
  };

  const handleRenameStart = (conv: { id: string; title: string }) => {
    setRenamingId(conv.id);
    setRenameValue(conv.title);
    setContextMenuId(null);
  };

  const handleRenameConfirm = async () => {
    if (renamingId && renameValue.trim()) {
      await renameConversation(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const handleDelete = async (id: string) => {
    if (confirm('Delete this conversation?')) {
      await deleteConversation(id);
    }
    setContextMenuId(null);
  };

  return (
    <main className="flex-1 flex bg-background">
      {/* Conversation Sidebar */}
      {sidebarOpen && (
        <aside className="w-72 bg-card border-r border-border flex flex-col shrink-0">
          {/* Sidebar Header */}
          <div className="h-14 border-b border-border flex items-center justify-between px-3">
            <button
              onClick={() => createConversation(t('chat.newConversation'), null, null)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-medium transition-colors"
              title={`${t('chat.newChat')} (Ctrl+N)`}
            >
              <Icon name="plus" size={12} />
              {t('chat.newChat')}
            </button>
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-1.5 rounded-lg hover:bg-accent transition-colors"
              aria-label={t('chat.hideHistory')}
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
                <p className="text-sm text-muted-foreground">{t('chat.noConversations')}</p>
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {conversations.map((conv) => {
                  const isSelected = conv.id === selectedConversationId;
                  const isRenaming = renamingId === conv.id;
                  
                  return (
                    <div key={conv.id} className="relative">
                      <button
                        onClick={() => selectConversation(conv.id)}
                        onContextMenu={(e) => handleContextMenu(e, conv.id)}
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
                              {isRenaming ? (
                                <input
                                  type="text"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onBlur={handleRenameConfirm}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleRenameConfirm();
                                    if (e.key === 'Escape') {
                                      setRenamingId(null);
                                      setRenameValue('');
                                    }
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  autoFocus
                                  className="text-sm font-medium text-foreground bg-muted border border-border rounded px-1 py-0.5 w-full"
                                />
                              ) : (
                                <h3 className="text-sm font-medium text-foreground truncate">
                                  {conv.title}
                                </h3>
                              )}
                              {conv.is_unread && !isRenaming && (
                                <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                              )}
                            </div>

                            {/* Last message */}
                            {conv.last_message && !isRenaming && (
                              <p className="text-xs text-muted-foreground truncate">
                                {conv.last_message}
                              </p>
                            )}

                            {/* Metadata */}
                            {!isRenaming && (
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
                            )}
                          </div>

                          {/* Menu button */}
                          {!isRenaming && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setContextMenuId(contextMenuId === conv.id ? null : conv.id);
                              }}
                              className="p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <Icon name="more-horizontal" size={12} className="text-muted-foreground" />
                            </button>
                          )}
                        </div>
                      </button>

                      {/* Context Menu */}
                      {contextMenuId === conv.id && (
                        <div
                          className="absolute right-2 top-full z-50 mt-1 w-36 bg-card border border-border rounded-lg shadow-lg py-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => handleRenameStart(conv)}
                            className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
                          >
                            <Icon name="edit" size={12} />
                            {t('common.rename')}
                          </button>
                          <button
                            onClick={() => handleDelete(conv.id)}
                            className="w-full px-3 py-1.5 text-left text-sm text-red-400 hover:bg-red-500/10 flex items-center gap-2"
                          >
                            <Icon name="trash" size={12} />
                            {t('common.delete')}
                          </button>
                        </div>
                      )}
                    </div>
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
              <div className="flex items-center gap-1 mr-1">
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="p-1.5 rounded-lg hover:bg-accent transition-colors"
                  title={t('chat.showHistory')}
                  aria-label={t('chat.showHistory')}
                >
                  <Icon name="chevron-right" size={16} className="text-muted-foreground" />
                </button>
                <button
                  onClick={() => createConversation(t('chat.newConversation'), null, null)}
                  className="p-1.5 rounded-lg hover:bg-accent transition-colors group"
                  title={`${t('chat.newChat')} (Ctrl+N)`}
                  aria-label={t('chat.newChat')}
                >
                  <Icon name="plus" size={16} className="text-muted-foreground group-hover:text-primary transition-colors" />
                </button>
              </div>
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
                                {t('common.cancel')}
                              </button>
                              <button
                                onClick={handleEditSave}
                                className="px-3 py-1.5 rounded-md text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                              >
                                {t('chat.saveRegenerate')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div
                            className={cn(
                              'text-sm leading-relaxed',
                              message.role === 'user'
                                ? 'text-foreground'
                                : 'text-foreground'
                            )}
                          >
                            {message.role === 'assistant' ? (
                              <MarkdownRenderer content={message.content} />
                            ) : (
                              message.content.split('\n').map((line, i) => (
                                <p key={i} className="mb-2 last:mb-0">
                                  {line}
                                </p>
                              ))
                            )}
                            {/* Streaming indicator */}
                            {isStreaming && message.role === 'assistant' && message === currentMessages[currentMessages.length - 1] && (
                              <span className="inline-block w-2 h-4 bg-primary/60 animate-pulse ml-1" />
                            )}
                          </div>
                        )}

                        {message.role === 'user' && !isEditing && (
                          <div className="mt-3 flex justify-end">
                            <button
                              onClick={() => handleEditStart(message.id, message.content)}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              {t('common.edit')}
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
                    <p className="text-muted-foreground text-sm">{t('chat.typeMessage')}</p>
                  ) : (
                    <div>
                      <p className="text-muted-foreground text-sm mb-1">{t('chat.selectProvider')}</p>
                      <button
                        onClick={() => createConversation(t('chat.newConversation'), null, null)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium transition-colors"
                      >
                        <Icon name="plus" size={12} />
                        {t('chat.newConversation')}
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

              {/* Token Counter - subtle display */}
              {(contextTokens > 0 || inputTokens > 0) && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors">
                  <span title="Context tokens">{formatTokenCount(contextTokens)}</span>
                  {inputTokens > 0 && (
                    <>
                      <span>+</span>
                      <span title="Input tokens">{formatTokenCount(inputTokens)}</span>
                    </>
                  )}
                  <span>{t('chat.tokens')}</span>
                </div>
              )}
            </div>

            {/* Input Field */}
            <div className="flex items-center gap-3 bg-card/80 border border-border rounded-xl p-2">
              <input
                type="text"
                placeholder={
                  !selectedProviderId || !selectedModelId
                    ? t('chat.selectProvider')
                    : t('chat.typeMessage')
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
                disabled={isLoading || !selectedProviderId || !selectedModelId}
              />
              {isStreaming ? (
                <button
                  onClick={stopStreaming}
                  className="rounded-lg bg-red-500 hover:bg-red-600 text-white px-3 h-9 flex items-center gap-2"
                  title={t('chat.stop')}
                  aria-label={t('chat.stop')}
                >
                  <Icon name="square" size={14} />
                  <span className="text-xs">{t('chat.stop')}</span>
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={isLoading || !inputValue.trim() || !selectedProviderId || !selectedModelId}
                  className={cn(
                    'rounded-lg px-3 h-9 flex items-center transition-colors',
                    isLoading || !inputValue.trim() || !selectedProviderId || !selectedModelId
                      ? 'bg-muted text-muted-foreground cursor-not-allowed'
                      : 'bg-primary hover:bg-primary/90 text-primary-foreground'
                  )}
                >
                  {isLoading ? (
                    <Icon name="loader" size={14} className="animate-spin" />
                  ) : (
                    <Icon name="arrow-up" size={14} />
                  )}
                </button>
              )}
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
};
