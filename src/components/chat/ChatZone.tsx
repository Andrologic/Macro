import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import type { MessageImageAttachment } from '../../stores/useChatStore';
import { useNeedsStore } from '../../stores/useNeedsStore';
import { useProviderStore } from '../../stores/useProviderStore';
import { useShortcutsStore } from '../../stores/useShortcutsStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { ProviderDropdown } from '../ai/ProviderDropdown';
import { ModelDropdown } from '../ai/ModelDropdown';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useScrollMagnet } from '../../hooks/useScrollMagnet';
import { ScrollSeparator } from './ScrollSeparator';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { PlanSelector } from '../architect/PlanSelector';
import { ComposerEditor, type ComposerEditorHandle } from './composer/ComposerEditor';

/**
 * ChatZone - Main chat interface used across all modes
 *
 * PERFORMANCE: Lazy loaded via ModeRouter, though shared across all modes
 * Critical component that should load quickly once needed
 */
const ChatZone: React.FC = () => {
  const { t } = useTranslation();
  const {
    currentPlan,
    mode,
    selectedProjectId,
    selectedTaskId,
    getProjectById,
    activeArchitectPlanId,
    planNodes,
    predictedBranches,
  } = useAppStore();
  const {
    conversations,
    selectedConversationId,
    createConversation,
    ensureConversationForCurrentMode,
    getConversationMessages,
    isLoading,
    isStreaming,
    stopStreaming,
    sendMessage,
    editMessage,
    getMessageImages,
    setMessageImages,
    composerContextRefs,
  } = useChatStore();

  const { selectedProviderId, selectedModelId } = useProviderStore();
  const { needs } = useNeedsStore();
  const promptHistoryNavigationMode = useShortcutsStore((state) => state.promptHistoryNavigationMode);

  const [inputValue, setInputValue] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [composerImages, setComposerImages] = useState<MessageImageAttachment[]>([]);

  // Lexical composer ref
  const composerEditorRef = useRef<ComposerEditorHandle>(null);

  // Ensure mode-scoped conversation is selected when project/task context changes.
  // Mode switches are handled via a cross-store subscription in useChatStore.
  useEffect(() => {
    if (isLoading) return;
    void ensureConversationForCurrentMode();
  }, [
    selectedProjectId,
    selectedTaskId,
    isLoading,
    ensureConversationForCurrentMode,
  ]);

  const [editingValue, setEditingValue] = useState('');
  const [editingImages, setEditingImages] = useState<MessageImageAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<MessageImageAttachment | null>(null);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState<number | null>(null);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('');

  // Filter messages by selected conversation
  const currentMessages = selectedConversationId
    ? getConversationMessages(selectedConversationId)
    : [];

  const promptHistory = useMemo(() => {
    return currentMessages
      .filter((message) => message.role === 'user')
      .map((message) => message.content.trim())
      .filter((content) => content.length > 0);
  }, [currentMessages]);

  // Get current conversation details
  const currentConversation = selectedConversationId
    ? conversations.find((c) => c.id === selectedConversationId)
    : null;

  const selectedTask = useMemo(
    () => currentPlan?.tasks.find((task) => task.id === selectedTaskId) ?? null,
    [currentPlan, selectedTaskId]
  );

  const selectedProjectName = useMemo(
    () => (selectedProjectId ? getProjectById(selectedProjectId)?.name ?? null : null),
    [selectedProjectId, getProjectById]
  );

  const modeHeader = useMemo(() => {
    if (mode === 'Architect') {
      return {
        icon: 'compass' as const,
        title: `Architect - ${selectedProjectName || 'Select a project'}`,
        subtitle: currentConversation?.title || null,
      };
    }

    if (mode === 'Implement') {
      return {
        icon: 'check-square' as const,
        title: `Implement - ${selectedTask?.title || 'Select a task'}`,
        subtitle: selectedProjectName || currentConversation?.title || null,
      };
    }

    if (mode === 'Debug') {
      return {
        icon: 'terminal' as const,
        title: currentConversation?.title || 'Debug Session',
        subtitle: selectedProjectName || null,
      };
    }

    return {
      icon: 'message-square' as const,
      title: currentConversation?.title || 'New Conversation',
      subtitle: null,
    };
  }, [mode, selectedProjectName, selectedTask?.title, currentConversation?.title]);

  const activePlanNeedsCount = useMemo(() => {
    if (!activeArchitectPlanId) return 0;
    return needs.filter((need) => need.planId === activeArchitectPlanId).length;
  }, [activeArchitectPlanId, needs]);

  const hasExistingStrategy = useMemo(() => {
    if (!activeArchitectPlanId) return false;
    return planNodes.length > 0 || predictedBranches.length > 0;
  }, [activeArchitectPlanId, planNodes.length, predictedBranches.length]);

  // Scroll magnetism: auto-scroll during streaming, animated separator
  const { scrollContainerRef, separatorState } = useScrollMagnet(
    isStreaming,
    [currentMessages],
  );

  const previousConversationIdRef = useRef<string | null>(null);
  const pendingConversationJumpRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedConversationId && selectedConversationId !== previousConversationIdRef.current) {
      pendingConversationJumpRef.current = selectedConversationId;
    }
    previousConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    const pendingConversationId = pendingConversationJumpRef.current;
    if (!pendingConversationId || pendingConversationId !== selectedConversationId) return;

    const jumpToBottom = () => {
      const container = scrollContainerRef.current;
      if (!container) return;
      container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
    };

    requestAnimationFrame(() => {
      jumpToBottom();
      requestAnimationFrame(() => {
        jumpToBottom();
        pendingConversationJumpRef.current = null;
      });
    });
  }, [selectedConversationId, currentMessages.length, scrollContainerRef]);


  const ensureConversation = async () => {
    if (selectedConversationId) return selectedConversationId;
    const ensured = await ensureConversationForCurrentMode();
    if (ensured) return ensured;
    const conversation = await createConversation('New Conversation', null, null);
    return conversation.id;
  };

  const readClipboardImage = (file: File): Promise<{ dataUrl: string; width?: number; height?: number }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) {
          reject(new Error('Failed to parse pasted image'));
          return;
        }

        const img = new Image();
        img.onload = () => {
          resolve({ dataUrl, width: img.width, height: img.height });
        };
        img.onerror = () => resolve({ dataUrl });
        img.src = dataUrl;
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read pasted image'));
      reader.readAsDataURL(file);
    });
  };

  const appendPastedImages = async (files: File[], destination: 'composer' | 'editing') => {
    const nextImages: MessageImageAttachment[] = [];

    for (const file of files) {
      try {
        const parsed = await readClipboardImage(file);
        nextImages.push({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          mimeType: file.type || 'image/png',
          dataUrl: parsed.dataUrl,
          width: parsed.width,
          height: parsed.height,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error('Failed to parse pasted image:', error);
      }
    }

    if (nextImages.length > 0) {
      if (destination === 'editing') {
        setEditingImages((prev) => [...prev, ...nextImages]);
      } else {
        setComposerImages((prev) => [...prev, ...nextImages]);
      }
    }
  };

  const readImageFilesFromClipboardApi = async (): Promise<File[]> => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return [];

    try {
      const clipboardItems = await navigator.clipboard.read();
      const files: File[] = [];

      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (!imageType) continue;

        const blob = await item.getType(imageType);
        const extension = imageType.split('/')[1] || 'png';
        files.push(new File([blob], `pasted-${Date.now()}.${extension}`, { type: imageType }));
      }

      return files;
    } catch (error) {
      console.error('Clipboard API image read failed:', error);
      return [];
    }
  };

  const handlePasteFor = async (
    event: React.ClipboardEvent<HTMLElement>,
    destination: 'composer' | 'editing'
  ) => {
    const directFiles = Array.from(event.clipboardData.items || [])
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    const files = directFiles.length > 0 ? directFiles : await readImageFilesFromClipboardApi();
    if (files.length === 0) return;

    event.preventDefault();
    await appendPastedImages(files, destination);
  };

  const handleComposerPaste = async (event: React.ClipboardEvent<HTMLElement>) => {
    await handlePasteFor(event, 'composer');
  };

  const handleEditingPaste = async (event: React.ClipboardEvent<HTMLElement>) => {
    await handlePasteFor(event, 'editing');
  };

  const removeComposerImage = (imageId: string) => {
    setComposerImages((prev) => prev.filter((image) => image.id !== imageId));
  };

  const removeEditingImage = (imageId: string) => {
    setEditingImages((prev) => prev.filter((image) => image.id !== imageId));
  };

  const preventImageMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const openImagePreview = (
    event: React.MouseEvent<HTMLElement>,
    image: MessageImageAttachment
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setPreviewImage(image);
  };

  const handleSend = async () => {
    const text = (composerEditorRef.current?.getTextContent() ?? '').trim();
    if ((!text && composerImages.length === 0 && composerContextRefs.length === 0) || isLoading) return;
    const conversationId = await ensureConversation();
    const content = text;
    const imagesForMessage = composerImages;
    composerEditorRef.current?.clear();
    setComposerImages([]);
    setInputValue('');
    await sendMessage({ conversationId, content, images: imagesForMessage });
  };

  const handleGenerateStrategy = async () => {
    if (mode !== 'Architect' || !activeArchitectPlanId || isLoading || isStreaming) return;
    if (!hasExistingStrategy && activePlanNeedsCount === 0) return;

    const conversationId = await ensureConversation();
    const content = hasExistingStrategy
      ? 'User requested to regenerate the strategy. Reassess all identified needs for the active plan and call `strategy_generate` with a complete replacement strategy (full nodes and dependencies).'
      : 'User requested to generate the strategy now. Based on all identified needs for the active plan, call `strategy_generate` with a complete initial strategy (full nodes and dependencies).';

    await sendMessage({ conversationId, content });
  };

  const handleEditStart = (messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditingValue(content);
    setEditingImages(getMessageImages(messageId));
  };

  const handleEditCancel = () => {
    setEditingMessageId(null);
    setEditingValue('');
    setEditingImages([]);
  };

  const handleEditSave = async () => {
    if (!editingMessageId) return;
    const content = editingValue.trim();
    if (!content) return;
    setMessageImages(editingMessageId, editingImages);
    setEditingMessageId(null);
    setEditingValue('');
    setEditingImages([]);
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

  const canSend = Boolean(inputValue.trim()) || composerImages.length > 0 || composerContextRefs.length > 0;

  const handleDebugRefresh = async () => {
    if (isStreaming) {
      stopStreaming();
    }
    await createConversation('Debug Session', null, null);
    composerEditorRef.current?.clear();
    setInputValue('');
    setComposerImages([]);
    setPromptHistoryIndex(null);
    setDraftBeforeHistory('');
  };

  const navigatePromptHistory = (direction: 'up' | 'down') => {
    if (promptHistory.length === 0) return;

    if (direction === 'up') {
      if (promptHistoryIndex === null) {
        setDraftBeforeHistory(composerEditorRef.current?.getTextContent() ?? '');
        const lastIndex = promptHistory.length - 1;
        setPromptHistoryIndex(lastIndex);
        composerEditorRef.current?.setText(promptHistory[lastIndex]);
        return;
      }

      if (promptHistoryIndex > 0) {
        const nextIndex = promptHistoryIndex - 1;
        setPromptHistoryIndex(nextIndex);
        composerEditorRef.current?.setText(promptHistory[nextIndex]);
      }
      return;
    }

    if (promptHistoryIndex === null) return;

    if (promptHistoryIndex < promptHistory.length - 1) {
      const nextIndex = promptHistoryIndex + 1;
      setPromptHistoryIndex(nextIndex);
      composerEditorRef.current?.setText(promptHistory[nextIndex]);
      return;
    }

    setPromptHistoryIndex(null);
    composerEditorRef.current?.setText(draftBeforeHistory);
  };

  useEffect(() => {
    setPromptHistoryIndex(null);
    setDraftBeforeHistory('');
  }, [selectedConversationId]);

  useEffect(() => {
    const handlePromptHistoryEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ direction?: 'up' | 'down' }>;
      const direction = customEvent.detail?.direction;
      if (!direction) return;
      navigatePromptHistory(direction);
    };

    window.addEventListener('macro:prompt-history', handlePromptHistoryEvent as EventListener);
    return () => {
      window.removeEventListener('macro:prompt-history', handlePromptHistoryEvent as EventListener);
    };
  }, [navigatePromptHistory]);

  useEffect(() => {
    const handleFocusMessage = (event: Event) => {
      const customEvent = event as CustomEvent<{ messageId?: string }>;
      const messageId = customEvent.detail?.messageId;
      if (!messageId) return;

      const target = document.getElementById(`chat-message-${messageId}`);
      if (!target) return;

      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedMessageId(messageId);
      window.setTimeout(() => {
        setHighlightedMessageId((current) => (current === messageId ? null : current));
      }, 1800);
    };

    window.addEventListener('macro:focus-message', handleFocusMessage as EventListener);
    return () => {
      window.removeEventListener('macro:focus-message', handleFocusMessage as EventListener);
    };
  }, []);

  return (
    <main className="h-full flex bg-background">
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-14 border-b border-border/50 flex items-center justify-between px-4 bg-card/30">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-6 h-6 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
              <Icon name={modeHeader.icon} size={10} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-medium text-foreground truncate">{modeHeader.title}</h1>
              {modeHeader.subtitle && (
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-muted-foreground text-xs truncate">{modeHeader.subtitle}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {mode === 'Architect' && <PlanSelector />}
            {mode === 'Debug' && (
              <button
                onClick={() => void handleDebugRefresh()}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title="Reset debug chat"
              >
                <Icon name="refresh-cw" size={12} />
                Reset
              </button>
            )}
            {currentPlan && (
              <span className="text-xs text-muted-foreground font-mono">
                {currentPlan.tasks.filter((t) => t.status === 'Completed').length}/{currentPlan.tasks.length}
              </span>
            )}
          </div>
        </header>

        {/* Conversation Content */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-12 pt-8 pb-4">
          {selectedConversationId && currentMessages.length > 0 ? (
            <div className="max-w-4xl mx-auto space-y-6">
              {currentMessages.map((message) => {
                const isEditing = editingMessageId === message.id;
                const messageImages = message.role === 'user' ? getMessageImages(message.id) : [];
                const visibleImages = isEditing ? editingImages : messageImages;

                return (
                  <div
                    key={message.id}
                    id={`chat-message-${message.id}`}
                    className={cn(
                      'relative rounded-lg transition-colors duration-500',
                      highlightedMessageId === message.id && 'bg-primary/10 ring-1 ring-primary/40'
                    )}
                  >
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
                          isEditing
                            ? 'p-2'
                            : message.role === 'assistant'
                              ? 'p-2 pb-6'
                              : 'p-2 pb-9'
                        )}
                      >
                        {/* Content */}
                        {isEditing ? (
                          <div className="space-y-2">
                            {visibleImages.length > 0 && (
                              <div className="flex flex-wrap gap-2">
                                {visibleImages.map((image) => (
                                  <div key={image.id} className="relative w-16 h-16 rounded-md border border-border overflow-hidden bg-muted/40">
                                    <button
                                      type="button"
                                      onMouseDown={preventImageMouseDown}
                                      onClick={(event) => openImagePreview(event, image)}
                                      className="w-full h-full cursor-zoom-in"
                                      title="Open image"
                                    >
                                      <img src={image.dataUrl} alt="Attached" className="w-full h-full object-cover" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => removeEditingImage(image.id)}
                                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-background/90 border border-border flex items-center justify-center hover:bg-accent transition-colors"
                                      title="Remove image"
                                    >
                                      <Icon name="x" size={11} className="text-muted-foreground" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                            <textarea
                              value={editingValue}
                              onChange={(event) => setEditingValue(event.target.value)}
                              onPasteCapture={handleEditingPaste}
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
                            {message.role === 'user' && messageImages.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {messageImages.map((image) => (
                                  <button
                                    key={image.id}
                                    type="button"
                                    onMouseDown={preventImageMouseDown}
                                    onClick={(event) => openImagePreview(event, image)}
                                    className="relative w-14 h-14 rounded-md border border-border overflow-hidden bg-muted/30 hover:opacity-90 transition-opacity"
                                    title="Open image"
                                  >
                                    <img src={image.dataUrl} alt="Attached" className="w-full h-full object-cover" />
                                  </button>
                                ))}
                              </div>
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
                          <div className="absolute bottom-1 right-2 flex items-center gap-1">
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
        <ScrollSeparator state={separatorState} />
        <footer className="bg-card/30 p-3">
          <div className="w-full max-w-3xl mx-auto space-y-3">
            {composerImages.length > 0 && (
              <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-card/60 p-2">
                {composerImages.map((image) => (
                  <div key={image.id} className="relative w-16 h-16 rounded-md border border-border overflow-hidden bg-muted/30">
                    <button
                      type="button"
                      onMouseDown={preventImageMouseDown}
                      onClick={(event) => openImagePreview(event, image)}
                      className="w-full h-full cursor-zoom-in"
                      title="Open image"
                    >
                      <img src={image.dataUrl} alt="Pasted" className="w-full h-full object-cover" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeComposerImage(image.id)}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-background/90 border border-border flex items-center justify-center hover:bg-accent transition-colors"
                      title="Remove image"
                    >
                      <Icon name="x" size={11} className="text-muted-foreground" />
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
              {mode === 'Architect' && (
                <button
                  type="button"
                  onClick={() => void handleGenerateStrategy()}
                  disabled={
                    !activeArchitectPlanId ||
                    isLoading ||
                    isStreaming ||
                    (!hasExistingStrategy && activePlanNeedsCount === 0)
                  }
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-medium border transition-colors',
                    !activeArchitectPlanId ||
                      isLoading ||
                      isStreaming ||
                      (!hasExistingStrategy && activePlanNeedsCount === 0)
                      ? 'border-border text-muted-foreground bg-card/40 cursor-not-allowed'
                      : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground'
                  )}
                  title={
                    !activeArchitectPlanId
                      ? 'Select an active plan first'
                      : !hasExistingStrategy && activePlanNeedsCount === 0
                        ? 'Add at least one need before generating a strategy'
                        : hasExistingStrategy
                          ? 'Regenerate strategy from current needs'
                          : 'Generate strategy from identified needs'
                  }
                >
                  <Icon name={hasExistingStrategy ? 'refresh-cw' : 'sparkles'} size={12} />
                  {hasExistingStrategy
                    ? t('common.regenerate', 'Regenerate') + ' Strategy'
                    : 'Generate Strategy'}
                </button>
              )}
            </div>

            <div
              className="flex items-center gap-2 bg-card/80 border border-border rounded-xl px-2 py-1.5"
              onPasteCapture={handleComposerPaste}
            >
              <ComposerEditor
                ref={composerEditorRef}
                editable={!isLoading && !!selectedProviderId && !!selectedModelId}
                placeholder={
                  !selectedProviderId || !selectedModelId
                    ? t('chat.selectProvider')
                    : t('chat.typeMessage')
                }
                onTextChange={(text) => {
                  setInputValue(text);
                  if (promptHistoryIndex !== null) {
                    setPromptHistoryIndex(null);
                  }
                }}
                onSend={handleSend}
                onPromptHistory={
                  promptHistoryNavigationMode === 'contextual_arrows'
                    ? navigatePromptHistory
                    : undefined
                }
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
                  disabled={isLoading || !canSend || !selectedProviderId || !selectedModelId}
                  className={cn(
                    'rounded-lg px-3 h-9 flex items-center transition-colors',
                    isLoading || !canSend || !selectedProviderId || !selectedModelId
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

      <ImagePreviewModal
        isOpen={Boolean(previewImage)}
        image={previewImage}
        onClose={() => setPreviewImage(null)}
      />
    </main>
  );
};

// Performance: Memoize to prevent re-renders when parent updates
const MemoizedChatZone = React.memo(ChatZone);

// Export both named and default for lazy loading compatibility
export default MemoizedChatZone;
