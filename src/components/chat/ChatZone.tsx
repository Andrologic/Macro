import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useProviderStore } from '../../stores/useProviderStore';
import { useCitationsStore } from '../../stores/useCitationsStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { ProviderDropdown } from '../ai/ProviderDropdown';
import { ModelDropdown } from '../ai/ModelDropdown';
import { MarkdownRenderer, estimateTokens, formatTokenCount } from './MarkdownRenderer';

/**
 * ChatZone - Main chat interface used across all modes
 *
 * PERFORMANCE: Lazy loaded via ModeRouter, though shared across all modes
 * Critical component that should load quickly once needed
 */
const ChatZone: React.FC = () => {
  const { t } = useTranslation();
  const { currentPlan } = useAppStore();
  const {
    conversations,
    selectedConversationId,
    selectConversation,
    createConversation,
    getConversationMessages,
    isLoading,
    isStreaming,
    stopStreaming,
    sendMessage,
    editMessage,
  } = useChatStore();

  const { selectedProviderId, selectedModelId } = useProviderStore();
  const { mode } = useAppStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  // File attachments for current message
  const { getCitationsByType, removeCitation } = useCitationsStore();
  const currentFileAttachments = selectedConversationId 
    ? getCitationsByType(selectedConversationId, 'file')
    : [];

  // Architect Mode: Ensure single conversation
  useEffect(() => {
    if (mode === 'Architect') {
      const architectTitle = 'Architect Session';
      const architectConvo = conversations.find(c => c.title === architectTitle);

      if (architectConvo) {
        if (selectedConversationId !== architectConvo.id) {
          selectConversation(architectConvo.id);
        }
      } else {
        // Create if missing. Note: This might trigger multiple creates if not careful.
        // We rely on conversations being loaded.
        if (!isLoading && conversations.length > 0) {
          createConversation(architectTitle, null, null);
        } else if (!isLoading && conversations.length === 0) {
          // Initial load case
          createConversation(architectTitle, null, null);
        }
      }
    }
  }, [mode, conversations, selectedConversationId, isLoading, createConversation, selectConversation]);

  const [editingValue, setEditingValue] = useState('');

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
    setEditingMessageId(null);
    setEditingValue('');
    await editMessage(editingMessageId, content);
  };

  const handleCopy = async (content: string, messageId: string) => {
    await navigator.clipboard.writeText(content);
    setCopiedMessageId(messageId);
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  const handleRegenerate = async (messageId: string, content: string) => {
    await editMessage(messageId, content);
  };

  const handleRemoveAttachment = (citationId: string) => {
    removeCitation(citationId);
  };

  return (
    <main className="h-full flex bg-background">
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-14 border-b border-border/50 flex items-center justify-between px-4 bg-card/30">
          <div className="flex items-center gap-3 min-w-0">
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
                        'relative transition-all duration-200',
                        message.role === 'user'
                          ? isEditing
                            ? 'ml-auto mr-0 max-w-3xl'
                            : 'ml-auto mr-0 max-w-lg'
                          : 'mr-auto ml-0 max-w-none'
                      )}
                    >
                      <div
                        className={cn(
                          'relative rounded-lg group',
                          message.role === 'user'
                            ? 'bg-muted/80 border border-border/50'
                            : 'bg-transparent border-0',
                          isEditing ? 'p-4' : 'p-4 pb-10'
                        )}
                      >
                        {/* Content */}
                        {isEditing ? (
                          <div className="space-y-2">
                            <textarea
                              value={editingValue}
                              onChange={(event) => setEditingValue(event.target.value)}
                              placeholder={t('common.editMessage') || 'Edit your message...'}
                              className="w-full min-h-[120px] max-h-[400px] resize-y bg-background border-2 border-border rounded-lg p-3 text-sm text-foreground focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 transition-all leading-relaxed"
                              autoFocus
                            />
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                onClick={handleEditCancel}
                                className="px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                              >
                                {t('common.cancel')}
                              </button>
                              <button
                                onClick={handleEditSave}
                                className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
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
                              <MarkdownRenderer
                                content={message.content}
                                isStreaming={
                                  isStreaming &&
                                  message === currentMessages[currentMessages.length - 1]
                                }
                              />
                            ) : (
                              message.content.split('\n').map((line, i) => (
                                <p key={i} className="mb-2 last:mb-0 break-words">
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
                          <div className="absolute bottom-2 right-2 flex items-center gap-1">
                            <button
                              onClick={() => handleCopy(message.content, message.id)}
                              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors"
                              title={t('common.copy') || 'Copy'}
                            >
                              <Icon
                                name="copy"
                                size={12}
                                className={cn(
                                  'transition-colors',
                                  copiedMessageId === message.id
                                    ? 'text-green-500'
                                    : 'text-muted-foreground hover:text-foreground'
                                )}
                              />
                            </button>
                            <button
                              onClick={() => handleEditStart(message.id, message.content)}
                              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors"
                              title={t('common.edit')}
                            >
                              <Icon
                                name="edit"
                                size={12}
                                className="text-muted-foreground hover:text-foreground transition-colors"
                              />
                            </button>
                            <button
                              onClick={() => handleRegenerate(message.id, message.content)}
                              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors"
                              title={t('common.regenerate') || 'Regenerate'}
                            >
                              <Icon
                                name="refresh-cw"
                                size={12}
                                className="text-muted-foreground hover:text-foreground transition-colors"
                              />
                            </button>
                          </div>
                        )}

                        {message.role === 'assistant' && !isEditing && (
                          <div className="absolute bottom-2 right-2 flex items-center gap-1">
                            <button
                              onClick={() => handleCopy(message.content, message.id)}
                              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors"
                              title={t('common.copy') || 'Copy raw'}
                            >
                              <Icon
                                name="copy"
                                size={12}
                                className={cn(
                                  'transition-colors',
                                  copiedMessageId === message.id
                                    ? 'text-green-500'
                                    : 'text-muted-foreground hover:text-foreground'
                                )}
                              />
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
            {/* File Attachments Preview */}
            {currentFileAttachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {currentFileAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="flex items-center gap-2 px-2 py-1 bg-muted/50 border border-border rounded-lg text-xs"
                  >
                    <Icon name="file" size={12} className="text-muted-foreground" />
                    <span className="text-foreground truncate max-w-[150px]">{attachment.title}</span>
                    <button
                      onClick={() => handleRemoveAttachment(attachment.id)}
                      className="p-0.5 hover:bg-accent rounded transition-colors"
                    >
                      <Icon name="x" size={10} className="text-muted-foreground hover:text-foreground" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ProviderDropdown />
                <ModelDropdown />
              </div>

              {(contextTokens > 0 || inputTokens > 0) && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground/60">
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

// Performance: Memoize to prevent re-renders when parent updates
const MemoizedChatZone = React.memo(ChatZone);

// Export both named and default for lazy loading compatibility
export default MemoizedChatZone;
