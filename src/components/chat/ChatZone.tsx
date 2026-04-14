import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import type { MessageImageAttachment } from '../../stores/useChatStore';
import type { ChatMessage } from '../../types';
import { useNeedsStore } from '../../stores/useNeedsStore';
import { useProviderStore } from '../../stores/useProviderStore';
import { useShortcutsStore } from '../../stores/useShortcutsStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { ProviderDropdown } from '../ai/ProviderDropdown';
import { ModelDropdown } from '../ai/ModelDropdown';
import { ReasoningDropdown } from '../ai/ReasoningDropdown';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useScrollMagnet } from '../../hooks/useScrollMagnet';
import { ScrollSeparator } from './ScrollSeparator';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { Button } from '../ui/Button';
import { getFocusedProjectForGroup, getGlobalProjectById } from '../../services/globalProjects';
import { ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX } from '../../services/architectChat';
import { resolveActiveConversationQuestionnaire } from '../../services/chatQuestionnaires';
import { useVirtualMessages } from '../../hooks/useVirtualList';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { Input } from '../ui/Input';
import LazyComposerEditor, { type ComposerEditorHandle } from './composer/LazyComposerEditor';

interface ChatZoneProps {
  headerActions?: React.ReactNode;
}

const LazyPlanSelector = lazy(async () => {
  const module = await import('../architect/PlanSelector');
  return { default: module.PlanSelector };
});

const PlanSelectorFallback: React.FC = () => (
  <div className="h-8 w-28 rounded-md border border-border/60 bg-card/60 animate-pulse" aria-hidden="true" />
);

const ComposerFallbackStatus: React.FC = () => (
  <div className="sr-only" aria-live="polite">
    Loading composer
  </div>
);

const EMPTY_RENDER_MESSAGES: ChatMessage[] = [];

interface RenderedMessageItem {
  index: number;
  key: React.Key;
  size: number;
  start: number;
  item: ChatMessage;
}

interface ChatMessageRowProps {
  virtualMessage: RenderedMessageItem;
  measureElement: (el: HTMLElement | null) => void;
  currentMessagesLength: number;
  isStreaming: boolean;
  showToolTraces: boolean;
  isEditing: boolean;
  editingValue: string;
  editingImages: MessageImageAttachment[];
  messageImages: MessageImageAttachment[];
  isCopied: boolean;
  isHighlighted: boolean;
  onEditingValueChange: (value: string) => void;
  onEditingPaste: (event: React.ClipboardEvent<HTMLElement>) => Promise<void>;
  onRemoveEditingImage: (imageId: string) => void;
  onImageMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  onOpenImagePreview: (
    event: React.MouseEvent<HTMLElement>,
    image: MessageImageAttachment
  ) => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onCopy: (content: string, messageId: string) => Promise<void>;
  onEditStart: (message: ChatMessage) => void;
  onRegenerate: (messageId: string, content: string) => Promise<void>;
}

const ChatMessageRowBase: React.FC<ChatMessageRowProps> = ({
  virtualMessage,
  measureElement,
  currentMessagesLength,
  isStreaming,
  showToolTraces,
  isEditing,
  editingValue,
  editingImages,
  messageImages,
  isCopied,
  isHighlighted,
  onEditingValueChange,
  onEditingPaste,
  onRemoveEditingImage,
  onImageMouseDown,
  onOpenImagePreview,
  onEditCancel,
  onEditSave,
  onCopy,
  onEditStart,
  onRegenerate,
}) => {
  const { t } = useTranslation();
  const message = virtualMessage.item;
  const messageIndex = virtualMessage.index;
  const visibleImages = isEditing ? editingImages : messageImages;
  const questionnaireResponseSummary = message.questionnaire_response_summary;
  const isQuestionnaireResponseMessage = Boolean(questionnaireResponseSummary);

  return (
    <div
      ref={measureElement}
      data-index={messageIndex}
      id={`chat-message-${message.id}`}
      className={cn(
        'absolute left-0 top-0 w-full rounded-lg transition-colors duration-500',
        isHighlighted && 'bg-primary/10 ring-1 ring-primary/40'
      )}
      style={{ transform: `translateY(${virtualMessage.start}px)` }}
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
              ? isQuestionnaireResponseMessage
                ? 'bg-transparent border-0'
                : 'bg-muted/80 border border-border/50'
              : 'bg-transparent border-0',
            isEditing
              ? 'p-2'
              : message.role === 'assistant'
                ? 'p-2 pb-6'
                : 'p-2 pb-9'
          )}
        >
          {isEditing ? (
            <div className="space-y-2">
              {visibleImages.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {visibleImages.map((image) => (
                    <div key={image.id} className="relative w-16 h-16 rounded-md border border-border overflow-hidden bg-muted/40">
                      <button
                        type="button"
                        onMouseDown={onImageMouseDown}
                        onClick={(event) => onOpenImagePreview(event, image)}
                        className="w-full h-full cursor-zoom-in"
                        title={t('chat.openImage', 'Open image')}
                      >
                        <img src={image.dataUrl} alt={t('chat.attachedImage', 'Attached image')} className="w-full h-full object-cover" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveEditingImage(image.id)}
                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-background/90 border border-border flex items-center justify-center hover:bg-accent transition-colors"
                        title={t('chat.removeImage', 'Remove image')}
                      >
                        <Icon name="x" size={11} className="text-muted-foreground" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                value={editingValue}
                onChange={(event) => onEditingValueChange(event.target.value)}
                onPasteCapture={(event) => {
                  void onEditingPaste(event);
                }}
                placeholder={t('common.editMessage') || 'Edit your message...'}
                className="w-full min-h-[120px] max-h-[400px] resize-y bg-background border-2 border-border rounded-lg p-3 text-sm text-foreground focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 transition-all leading-relaxed"
                autoFocus
              />
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={onEditCancel}
                  className="px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={onEditSave}
                  className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
                >
                  {t('chat.saveRegenerate')}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-sm leading-relaxed text-foreground">
              {message.role === 'assistant' ? (
                <MarkdownRenderer
                  content={message.content}
                  toolTraces={showToolTraces ? message.tool_traces : undefined}
                  isStreaming={isStreaming && messageIndex === currentMessagesLength - 1}
                />
              ) : questionnaireResponseSummary ? (
                <div
                  data-testid="questionnaire-response-summary"
                  className="space-y-3.5"
                >
                  <div className="flex items-center gap-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    <Icon name="message-circle" size={13} className="shrink-0 text-primary/75" />
                    <span className="truncate">
                      {t('chat.questionnaireResponseSummaryTitle', 'Reponses au questionnaire')}
                    </span>
                  </div>
                  <div className="space-y-3">
                    {questionnaireResponseSummary.items.map((item, index) => (
                      <div
                        key={item.id}
                        className={cn(
                          'relative pl-4',
                          index > 0 && 'pt-3'
                        )}
                      >
                        <span className="absolute left-0 top-0 h-full w-px bg-border/55" aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                            {item.prompt}
                          </p>
                          <p className="mt-1.5 break-words text-sm leading-6 text-foreground">
                            {item.answer}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
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
                      onMouseDown={onImageMouseDown}
                      onClick={(event) => onOpenImagePreview(event, image)}
                      className="relative w-14 h-14 rounded-md border border-border overflow-hidden bg-muted/30 hover:opacity-90 transition-opacity"
                      title={t('chat.openImage', 'Open image')}
                    >
                      <img src={image.dataUrl} alt={t('chat.attachedImage', 'Attached image')} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
              {isStreaming && message.role === 'assistant' && messageIndex === currentMessagesLength - 1 && (
                <span className="inline-block w-2 h-4 bg-primary/60 animate-pulse ml-1" />
              )}
            </div>
          )}

          {message.role === 'user' && !isEditing && (
            <div className="absolute bottom-2 right-2 flex items-center gap-1">
              <button
                onClick={() => void onCopy(message.content, message.id)}
                className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors"
                title={t('common.copy') || 'Copy'}
              >
                <Icon
                  name="copy"
                  size={12}
                  className={cn(
                    'transition-colors',
                    isCopied ? 'text-green-500' : 'text-muted-foreground hover:text-foreground'
                  )}
                />
              </button>
              <button
                onClick={() => onEditStart(message)}
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
                onClick={() => void onRegenerate(message.id, message.content)}
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
                onClick={() => void onCopy(message.content, message.id)}
                className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors"
                title={t('common.copy') || 'Copy raw'}
              >
                <Icon
                  name="copy"
                  size={12}
                  className={cn(
                    'transition-colors',
                    isCopied ? 'text-green-500' : 'text-muted-foreground hover:text-foreground'
                  )}
                />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const MemoizedChatMessageRow = React.memo(
  ChatMessageRowBase,
  (prev, next) =>
    prev.virtualMessage.item === next.virtualMessage.item &&
    prev.virtualMessage.start === next.virtualMessage.start &&
    prev.isEditing === next.isEditing &&
    prev.editingValue === next.editingValue &&
    prev.editingImages === next.editingImages &&
    prev.messageImages === next.messageImages &&
    prev.isCopied === next.isCopied &&
    prev.isHighlighted === next.isHighlighted &&
    prev.isStreaming === next.isStreaming &&
    prev.showToolTraces === next.showToolTraces &&
    prev.currentMessagesLength === next.currentMessagesLength
);

/**
 * ChatZone - Main chat interface used across all modes
 *
 * PERFORMANCE: Lazy loaded via ModeRouter, though shared across all modes
 * Critical component that should load quickly once needed
 */
const buildImplementKickoffPrompt = (params: {
  title: string;
  description?: string;
  projectScope: string;
  branchName: string;
  dependencies: string[];
  estimatedChanges: Array<{ operation: string; path: string }>;
  notes?: string;
}): string => {
  const dependencyContext = params.dependencies.length > 0
    ? params.dependencies.join(', ')
    : 'none';
  const estimatedChanges = params.estimatedChanges.length > 0
    ? params.estimatedChanges
      .map((change) => `${change.operation} ${change.path}`)
      .join('\n')
    : 'No estimated file changes provided.';
  const executionNotes = params.notes?.trim();

  return [
    'You are starting implementation for this task.',
    'Start with a concise context summary so the developer immediately understands what needs to be done.',
    'Then propose an ordered execution plan.',
    'If critical information is missing, stop and ask blocking questions before coding.',
    'Use the question tool for blocking structured clarifications.',
    'When you use it, make a single question tool call in the turn, include 1 to 5 sequential questions, and provide exactly 3 suggested choices per question.',
    'Use the optional intro for short context, keep each prompt concrete, and wait for the user questionnaire response before continuing.',
    '',
    'TASK CONTEXT',
    `- Title: ${params.title}`,
    `- Description: ${params.description || 'No description provided.'}`,
    `- Project Scope: ${params.projectScope}`,
    `- Branch: ${params.branchName}`,
    `- Dependencies: ${dependencyContext}`,
    '- Estimated file changes:',
    estimatedChanges,
    ...(executionNotes
      ? [
        '',
        'DEVELOPER NOTES',
        executionNotes,
      ]
      : []),
  ].join('\n');
};

const ChatZone: React.FC<ChatZoneProps> = ({ headerActions }) => {
  const { t } = useTranslation();
  const {
    mode,
    agentType,
    setAgentType,
    pendingAutoLaunchPlanId,
    pendingAutoLaunchTaskId,
    clearPendingAutoLaunch,
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    projectGroups,
    activeArchitectPlanId,
    planNodes,
    predictedBranches,
  } = useAppStore(useShallow((state) => ({
    mode: state.mode,
    agentType: state.agentType,
    setAgentType: state.setAgentType,
    pendingAutoLaunchPlanId: state.pendingAutoLaunchPlanId,
    pendingAutoLaunchTaskId: state.pendingAutoLaunchTaskId,
    clearPendingAutoLaunch: state.clearPendingAutoLaunch,
    selectedGroupId: state.selectedGroupId,
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    projectGroups: state.projectGroups,
    activeArchitectPlanId: state.activeArchitectPlanId,
    planNodes: state.planNodes,
    predictedBranches: state.predictedBranches,
  })));
  const {
    conversations,
    messages,
    selectedConversationId,
    messagesByConversationId,
    createConversation,
    ensureConversationForCurrentMode,
    hydrationStatus,
    restoreStatus,
    isLoading,
    isStreaming,
    sendState,
    lastError,
    stopStreaming,
    sendMessage,
    clearLastError,
    editMessage,
    getMessageImages,
    setMessageImages,
    composerContextRefs,
    questionnaireDraftsByConversationId,
    startQuestionnaireResponseEdit,
    cancelQuestionnaireSession,
    setActiveQuestionnaireStep,
    setActiveQuestionnaireDraftText,
    recordActiveQuestionnaireAnswer,
    submitActiveQuestionnaire,
  } = useChatStore(useShallow((state) => ({
    conversations: state.conversations,
    messages: state.messages,
    selectedConversationId: state.selectedConversationId,
    messagesByConversationId: state.messagesByConversationId ?? {},
    createConversation: state.createConversation,
    ensureConversationForCurrentMode: state.ensureConversationForCurrentMode,
    hydrationStatus: state.hydrationStatus,
    restoreStatus: state.restoreStatus,
    isLoading: state.isLoading,
    isStreaming: state.isStreaming,
    sendState: state.sendState,
    lastError: state.lastError,
    stopStreaming: state.stopStreaming,
    sendMessage: state.sendMessage,
    clearLastError: state.clearLastError,
    editMessage: state.editMessage,
    getMessageImages: state.getMessageImages,
    setMessageImages: state.setMessageImages,
    composerContextRefs: state.composerContextRefs,
    questionnaireDraftsByConversationId: state.questionnaireDraftsByConversationId,
    startQuestionnaireResponseEdit: state.startQuestionnaireResponseEdit,
    cancelQuestionnaireSession: state.cancelQuestionnaireSession,
    setActiveQuestionnaireStep: state.setActiveQuestionnaireStep,
    setActiveQuestionnaireDraftText: state.setActiveQuestionnaireDraftText,
    recordActiveQuestionnaireAnswer: state.recordActiveQuestionnaireAnswer,
    submitActiveQuestionnaire: state.submitActiveQuestionnaire,
  })));
  const { mark: markPerformance } = usePerformanceMonitor();

  const { selectedProviderId, selectedModelId } = useProviderStore(useShallow((state) => ({
    selectedProviderId: state.selectedProviderId,
    selectedModelId: state.selectedModelId,
  })));
  const needs = useNeedsStore((state) => state.needs);
  const promptHistoryNavigationMode = useShortcutsStore((state) => state.promptHistoryNavigationMode);
  const { tasks, startTask } = useTaskStore(useShallow((state) => ({
    tasks: state.tasks,
    startTask: state.startTask,
  })));

  const [inputValue, setInputValue] = useState('');
  const [kickoffNotes, setKickoffNotes] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [composerImages, setComposerImages] = useState<MessageImageAttachment[]>([]);

  // Lexical composer ref
  const composerEditorRef = useRef<ComposerEditorHandle>(null);

  const [editingValue, setEditingValue] = useState('');
  const [editingImages, setEditingImages] = useState<MessageImageAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<MessageImageAttachment | null>(null);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState<number | null>(null);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('');
  const currentMessages = useMemo(
    () =>
      selectedConversationId
        ? messagesByConversationId[selectedConversationId] ??
          messages.filter((message) => message.conversation_id === selectedConversationId)
        : EMPTY_RENDER_MESSAGES,
    [messages, messagesByConversationId, selectedConversationId]
  );
  const activeQuestionnaireDraft = selectedConversationId
    ? questionnaireDraftsByConversationId[selectedConversationId]
    : undefined;
  const activeQuestionnaire = useMemo(
    () =>
      selectedConversationId
        ? resolveActiveConversationQuestionnaire(
            selectedConversationId,
            currentMessages,
            activeQuestionnaireDraft
          )
        : null,
    [activeQuestionnaireDraft, currentMessages, selectedConversationId]
  );
  const activeQuestionnaireDraftText = activeQuestionnaire
    ? activeQuestionnaire.draftTextByStepId[activeQuestionnaire.currentStep.id] ?? ''
    : '';
  const activeQuestionnaireCurrentAnswer = activeQuestionnaire
    ? activeQuestionnaire.answersByStepId[activeQuestionnaire.currentStep.id] ?? ''
    : '';
  const activeQuestionnaireSelectedChoice =
    activeQuestionnaire && activeQuestionnaireDraftText.trim().length === 0
      ? activeQuestionnaireCurrentAnswer
      : '';
  const activeQuestionnaireSubmitValue = activeQuestionnaireDraftText.trim().length > 0
    ? activeQuestionnaireDraftText
    : activeQuestionnaireCurrentAnswer;
  const activeQuestionnaireHasPreviousStep = Boolean(
    activeQuestionnaire && activeQuestionnaire.currentStepIndex > 0
  );
  const activeQuestionnaireHasNextStep = Boolean(
    activeQuestionnaire &&
      activeQuestionnaire.currentStepIndex < activeQuestionnaire.totalSteps - 1
  );

  const isConversationPending =
    hydrationStatus === 'idle' ||
    hydrationStatus === 'hydrating' ||
    restoreStatus === 'idle' ||
    restoreStatus === 'resolving';
  const isPreparingSend = sendState === 'preparing';
  const isBusySending = isLoading || isStreaming || isPreparingSend;

  const promptHistory = useMemo(() => {
    return currentMessages
      .filter((message) => message.role === 'user')
      .map((message) => message.content.trim())
      .filter((content) => content.length > 0);
  }, [currentMessages]);

  const streamingMessageContentLength =
    currentMessages[currentMessages.length - 1]?.content.length ?? 0;

  useEffect(() => {
    if (!isStreaming) return;
    markPerformance('chat-stream-visible-update');
  }, [isStreaming, markPerformance, streamingMessageContentLength]);

  // Get current conversation details
  const currentConversation = selectedConversationId
    ? conversations.find((c) => c.id === selectedConversationId)
    : null;

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  );
  const implementTaskIdForSend =
    mode === 'Implement'
      ? selectedTask?.id ?? currentConversation?.task_id ?? null
      : null;
  const isManualFeatureDraftTask = selectedTask?.draft === true;
  const selectedTaskProjectIds = useMemo(() => {
    if (!selectedTask) {
      return [];
    }

    return Array.from(
      new Set(
        [
          ...(selectedTask.execution_targets?.map((target) => target.projectId) ?? []),
          ...(selectedTask.project_ids ?? []),
          selectedTask.project_id,
        ].filter((projectId): projectId is string => typeof projectId === 'string' && projectId.trim().length > 0)
      )
    );
  }, [selectedTask]);
  const selectedTaskProjectSummary = useMemo(() => {
    if (selectedTaskProjectIds.length === 0) {
      return t('implement.noRepositorySelected', 'No repository');
    }

    if (selectedTaskProjectIds.length === 1) {
      return selectedTaskProjectIds[0]!;
    }

    return t('implement.multiProjectTask', '{{count}} repositories', {
      count: selectedTaskProjectIds.length,
    });
  }, [selectedTaskProjectIds, t]);
  const canStartImplementExecution = Boolean(
    mode === 'Implement' &&
      selectedTask &&
      !selectedTask.draft &&
      !selectedTask.is_blocked &&
      selectedTask.status !== 'Completed' &&
      selectedTask.status !== 'InReview' &&
      !isConversationPending &&
      currentMessages.length === 0
  );
  const isImplementComposerLocked =
    mode === 'Implement' &&
    Boolean(selectedTask) &&
    !selectedTask?.draft &&
    currentMessages.length === 0;
  const isImplementTaskSelectionMissing = mode === 'Implement' && !selectedTask;
  const isComposerDisabled =
    isConversationPending ||
    isImplementComposerLocked ||
    isImplementTaskSelectionMissing ||
    Boolean(activeQuestionnaire);
  const isAutoLaunchArmedForSelection = Boolean(
    mode === 'Implement' &&
      pendingAutoLaunchPlanId &&
      pendingAutoLaunchTaskId &&
      selectedTask &&
      selectedTask.id === pendingAutoLaunchTaskId &&
      selectedTask.plan_id === pendingAutoLaunchPlanId
  );

  const selectedGlobalProject = useMemo(
    () => getGlobalProjectById(projectGroups, selectedGroupId),
    [projectGroups, selectedGroupId]
  );
  const focusedProject = useMemo(
    () => getFocusedProjectForGroup(projectGroups, selectedGroupId, selectedProjectId),
    [projectGroups, selectedGroupId, selectedProjectId]
  );
  const selectedGlobalProjectName = selectedGlobalProject?.name ?? null;
  const focusedProjectName = focusedProject?.name ?? null;
  const projectScopeLabel = useMemo(() => {
    if (selectedGlobalProjectName && focusedProjectName && selectedGlobalProjectName !== focusedProjectName) {
      return `${selectedGlobalProjectName} / ${focusedProjectName}`;
    }
    return selectedGlobalProjectName || focusedProjectName || null;
  }, [focusedProjectName, selectedGlobalProjectName]);

  const modeHeader = useMemo(() => {
    if (mode === 'Architect') {
      return {
        icon: 'compass' as const,
        title: `${t('header.architect', 'Architect')} - ${selectedGlobalProjectName || t('header.selectProject', 'Select Project')}`,
        subtitle:
          currentConversation?.title ||
          (focusedProjectName && focusedProjectName !== selectedGlobalProjectName
            ? focusedProjectName
            : null),
      };
    }

    if (mode === 'Implement') {
      return {
        icon: 'check-square' as const,
        title: `${t('header.implement', 'Implement')} - ${selectedTask?.title || t('implement.selectTaskShort', 'Select a task')}`,
        subtitle: projectScopeLabel || currentConversation?.title || null,
      };
    }

    return {
      icon: 'message-square' as const,
      title: currentConversation?.title || t('chat.newConversation', 'New Conversation'),
      subtitle: null,
    };
  }, [
    currentConversation?.title,
    focusedProjectName,
    mode,
    projectScopeLabel,
    selectedGlobalProjectName,
    selectedTask?.title,
    t,
  ]);

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
  const {
    virtualItems: virtualMessageItems,
    totalSize: virtualMessageTotalSize,
    measureElement: measureMessageElement,
    scrollToIndex: scrollToMessageIndex,
  } = useVirtualMessages(currentMessages, {
    parentRef: scrollContainerRef,
    estimateSize: 220,
    overscan: isStreaming ? 10 : 6,
    dynamicHeight: true,
    gap: 24,
  });
  const messageIndexById = useMemo(
    () => new Map(currentMessages.map((message, index) => [message.id, index])),
    [currentMessages]
  );
  const renderedMessageItems = useMemo(
    () =>
      virtualMessageItems.length > 0
        ? virtualMessageItems
        : currentMessages.map((message, index) => ({
            index,
            key: message.id,
            size: 220,
            start: index * 244,
            item: message,
          })),
    [currentMessages, virtualMessageItems]
  );
  const renderedMessageTotalSize =
    virtualMessageItems.length > 0
      ? virtualMessageTotalSize
      : Math.max(0, currentMessages.length * 244 - 24);

  const previousConversationIdRef = useRef<string | null>(null);
  const pendingConversationJumpRef = useRef<string | null>(null);
  const executionKickoffByConversationRef = useRef<Record<string, boolean>>({});
  const startingExecutionRef = useRef(false);
  const attemptedAutoLaunchTaskIdRef = useRef<string | null>(null);

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
      if (currentMessages.length > 0) {
        scrollToMessageIndex(currentMessages.length - 1, { align: 'end' });
      }
      container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
    };

    requestAnimationFrame(() => {
      jumpToBottom();
      requestAnimationFrame(() => {
        jumpToBottom();
        pendingConversationJumpRef.current = null;
      });
    });
  }, [currentMessages.length, scrollContainerRef, scrollToMessageIndex, selectedConversationId]);

  const ensureConversation = useCallback(async (): Promise<string | null> => {
    if (selectedConversationId) return selectedConversationId;
    const ensured = await ensureConversationForCurrentMode();
    if (ensured) return ensured;
    if (mode === 'Implement') return null;
    const conversation = await createConversation(t('chat.newConversation', 'New Conversation'), null, null);
    return conversation.id;
  }, [
    createConversation,
    ensureConversationForCurrentMode,
    mode,
    selectedConversationId,
    t,
  ]);

  useEffect(() => {
    if (pendingAutoLaunchTaskId !== attemptedAutoLaunchTaskIdRef.current) {
      attemptedAutoLaunchTaskIdRef.current = null;
    }
  }, [pendingAutoLaunchTaskId]);

  const handleStartExecution = useCallback(async (params?: {
    notesOverride?: string;
    trigger?: 'manual' | 'auto';
  }): Promise<boolean> => {
    if (mode !== 'Implement' || !selectedTask || isBusySending || isConversationPending) return false;
    if (selectedTask.draft) return false;
    if (!selectedProviderId || !selectedModelId) return false;
    if (startingExecutionRef.current) return false;

    startingExecutionRef.current = true;
    let conversationId: string | null = null;

    try {
      conversationId = await ensureConversation();
      if (!conversationId) return false;
      if (executionKickoffByConversationRef.current[conversationId]) return false;

      executionKickoffByConversationRef.current[conversationId] = true;

      if (selectedTask.status === 'Pending' || selectedTask.status === 'Failed' || selectedTask.status === 'AwaitingResponse') {
        await startTask(selectedTask.id);
        const latestTask = useTaskStore.getState().getTaskById(selectedTask.id);
        if (!latestTask || latestTask.is_blocked || latestTask.status === 'Failed') {
          delete executionKickoffByConversationRef.current[conversationId];
          return false;
        }
      }

      const content = buildImplementKickoffPrompt({
        title: selectedTask.title,
        description: selectedTask.description,
        projectScope: selectedTaskProjectSummary,
        branchName: selectedTask.branch_name,
        dependencies: selectedTask.dependencies,
        estimatedChanges: selectedTask.estimated_changes,
        notes: params?.notesOverride ?? kickoffNotes,
      });

      setKickoffNotes('');
      await sendMessage({
        conversationId,
        content,
        taskId: selectedTask.id,
      });
      if (selectedTask.id === pendingAutoLaunchTaskId) {
        clearPendingAutoLaunch({
          planId: selectedTask.plan_id,
          taskId: selectedTask.id,
        });
      }
      return true;
    } catch (error) {
      if (conversationId) {
        delete executionKickoffByConversationRef.current[conversationId];
      }
      throw error;
    } finally {
      startingExecutionRef.current = false;
    }
  }, [
    clearPendingAutoLaunch,
    ensureConversation,
    isConversationPending,
    isBusySending,
    kickoffNotes,
    mode,
    pendingAutoLaunchTaskId,
    selectedModelId,
    selectedProviderId,
    selectedTask,
    selectedTaskProjectSummary,
    sendMessage,
    startTask,
  ]);

  useEffect(() => {
    if (!isAutoLaunchArmedForSelection) return;
    if (!canStartImplementExecution) return;
    if (isBusySending || isConversationPending) return;
    if (!selectedProviderId || !selectedModelId) return;
    if (attemptedAutoLaunchTaskIdRef.current === pendingAutoLaunchTaskId) return;
    attemptedAutoLaunchTaskIdRef.current = pendingAutoLaunchTaskId;
    void handleStartExecution({ trigger: 'auto' }).catch(() => undefined);
  }, [
    canStartImplementExecution,
    isAutoLaunchArmedForSelection,
    isConversationPending,
    isBusySending,
    pendingAutoLaunchTaskId,
    selectedProviderId,
    selectedModelId,
    selectedTask?.id,
    handleStartExecution,
  ]);

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
    if (lastError) {
      clearLastError();
    }
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
    if (isComposerDisabled || activeQuestionnaire) return;
    const text = (composerEditorRef.current?.getTextContent() ?? '').trim();
    if ((!text && composerImages.length === 0 && composerContextRefs.length === 0) || isBusySending) return;
    const conversationId = await ensureConversation();
    if (!conversationId) return;
    const content = text;
    const imagesForMessage = [...composerImages];

    try {
      const result = await sendMessage({
        conversationId,
        content,
        taskId: implementTaskIdForSend,
        images: imagesForMessage,
      });
      if (result.status === 'sent') {
        composerEditorRef.current?.clear();
        setComposerImages([]);
        setInputValue('');
      }
    } catch {
      // Keep the draft intact. The visible error feedback comes from the chat store.
    }
  };

  const handleQuestionnaireAnswer = async (answer: string) => {
    if (!selectedConversationId || isBusySending || isConversationPending) return;
    const recorded = recordActiveQuestionnaireAnswer(
      selectedConversationId,
      answer,
    );
    if (!recorded?.completed) {
      return;
    }
    try {
      await submitActiveQuestionnaire(selectedConversationId);
    } catch {
      // The store exposes the visible error state.
    }
  };

  const handleQuestionnaireSubmit = async () => {
    await handleQuestionnaireAnswer(activeQuestionnaireSubmitValue);
  };

  const handleQuestionnaireStepChange = (stepIndex: number) => {
    if (!activeQuestionnaire || isBusySending || isConversationPending) return;
    setActiveQuestionnaireStep(activeQuestionnaire.conversationId, stepIndex);
  };

  const handleGenerateStrategy = async () => {
    if (mode !== 'Architect' || !activeArchitectPlanId || isBusySending || isConversationPending) return;
    if (!hasExistingStrategy && activePlanNeedsCount === 0) return;

    const conversationId = await ensureConversation();
    if (!conversationId) return;
    const content = hasExistingStrategy
      ? `User requested to regenerate the strategy. Reassess all identified needs for the active plan and call \`strategy_generate\` with a complete replacement strategy (full nodes and dependencies). ${ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX}`
      : `User requested to generate the strategy now. Based on all identified needs for the active plan, call \`strategy_generate\` with a complete initial strategy (full nodes and dependencies). ${ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX}`;

    try {
      await sendMessage({ conversationId, content });
    } catch {
      // The store exposes the visible error state.
    }
  };

  const handleEditStart = (message: ChatMessage) => {
    if (message.questionnaire_response_summary) {
      const opened = startQuestionnaireResponseEdit(message.id);
      if (opened) {
        setEditingMessageId(null);
        setEditingValue('');
        setEditingImages([]);
        return;
      }
    }

    const content = message.content;
    const messageId = message.id;
    setEditingMessageId(messageId);
    setEditingValue(content);
    setEditingImages(getMessageImages(messageId));
  };

  const handleEditCancel = () => {
    setEditingMessageId(null);
    setEditingValue('');
    setEditingImages([]);
  };

  const handleQuestionnaireCancel = () => {
    if (!activeQuestionnaire) {
      return;
    }
    cancelQuestionnaireSession(activeQuestionnaire.conversationId);
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

  const canSend =
    !activeQuestionnaire &&
    !isConversationPending &&
    (Boolean(inputValue.trim()) || composerImages.length > 0 || composerContextRefs.length > 0);

  const navigatePromptHistory = useCallback((direction: 'up' | 'down') => {
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
  }, [draftBeforeHistory, promptHistory, promptHistoryIndex]);

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

      const targetIndex = messageIndexById.get(messageId);
      if (typeof targetIndex === 'number') {
        scrollToMessageIndex(targetIndex, { align: 'center' });
      }

      requestAnimationFrame(() => {
        const target = document.getElementById(`chat-message-${messageId}`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      setHighlightedMessageId(messageId);
      window.setTimeout(() => {
        setHighlightedMessageId((current) => (current === messageId ? null : current));
      }, 1800);
    };

    window.addEventListener('macro:focus-message', handleFocusMessage as EventListener);
    return () => {
      window.removeEventListener('macro:focus-message', handleFocusMessage as EventListener);
    };
  }, [messageIndexById, scrollToMessageIndex]);

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
            {mode === 'Architect' && (
              <Suspense fallback={<PlanSelectorFallback />}>
                <LazyPlanSelector />
              </Suspense>
            )}
            {headerActions}
          </div>
        </header>

        {/* Conversation Content */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-12 pt-8 pb-4">
          {isConversationPending ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto rounded-xl bg-card border border-border flex items-center justify-center">
                  <Icon name="loader" size={24} className="text-muted-foreground animate-spin" />
                </div>
                <div>
                  <p className="text-muted-foreground text-sm">
                    {t('chat.loadingConversation', 'Restoring conversation...')}
                  </p>
                </div>
              </div>
            </div>
          ) : selectedConversationId && currentMessages.length > 0 ? (
            <div className="max-w-4xl mx-auto relative" style={{ height: renderedMessageTotalSize }}>
              {renderedMessageItems.map((virtualMessage) => {
                const message = virtualMessage.item;
                const isEditing = editingMessageId === message.id;
                const messageImages = message.role === 'user' ? getMessageImages(message.id) : [];

                return (
                  <MemoizedChatMessageRow
                    key={message.id}
                    virtualMessage={virtualMessage}
                    measureElement={measureMessageElement}
                    currentMessagesLength={currentMessages.length}
                    isStreaming={isStreaming}
                    showToolTraces
                    isEditing={isEditing}
                    editingValue={editingValue}
                    editingImages={editingImages}
                    messageImages={messageImages}
                    isCopied={copiedMessageId === message.id}
                    isHighlighted={highlightedMessageId === message.id}
                    onEditingValueChange={setEditingValue}
                    onEditingPaste={handleEditingPaste}
                    onRemoveEditingImage={removeEditingImage}
                    onImageMouseDown={preventImageMouseDown}
                    onOpenImagePreview={openImagePreview}
                    onEditCancel={handleEditCancel}
                    onEditSave={handleEditSave}
                    onCopy={handleCopy}
                    onEditStart={handleEditStart}
                    onRegenerate={handleRegenerate}
                  />
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
                  ) : mode === 'Implement' ? (
                    <p className="text-muted-foreground text-sm">
                      {selectedTask
                        ? t(
                            'implement.startConversationFromBrief',
                            'Use the task briefing below to start the task conversation.'
                          )
                        : t(
                            'implement.selectTaskToStart',
                            'Select a task to start implementation.'
                          )}
                    </p>
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
            {!activeQuestionnaire && composerImages.length > 0 && (
              <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-card/60 p-2">
                {composerImages.map((image) => (
                  <div key={image.id} className="relative w-16 h-16 rounded-md border border-border overflow-hidden bg-muted/30">
                    <button
                      type="button"
                      onMouseDown={preventImageMouseDown}
                      onClick={(event) => openImagePreview(event, image)}
                      className="w-full h-full cursor-zoom-in"
                      title={t('chat.openImage', 'Open image')}
                    >
                      <img src={image.dataUrl} alt={t('chat.pastedImage', 'Pasted image')} className="w-full h-full object-cover" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeComposerImage(image.id)}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-background/90 border border-border flex items-center justify-center hover:bg-accent transition-colors"
                      title={t('chat.removeImage', 'Remove image')}
                    >
                      <Icon name="x" size={11} className="text-muted-foreground" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {mode === 'Implement' && (
                  <div className="inline-flex items-center rounded-lg border border-border bg-muted/60 p-0.5">
                    <button
                      type="button"
                      onClick={() => setAgentType('plan')}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                        agentType === 'plan'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      title={t('chat.agentTypePlan', 'Plan')}
                    >
                      <Icon name="map" size={12} />
                      {t('chat.agentTypePlan', 'Plan')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAgentType('build')}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                        agentType === 'build'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      title={t('chat.agentTypeBuild', 'Build')}
                    >
                      <Icon name="code" size={12} />
                      {t('chat.agentTypeBuild', 'Build')}
                    </button>
                  </div>
                )}
                <ProviderDropdown />
                <ModelDropdown />
                <ReasoningDropdown />
              </div>
              {mode === 'Architect' && (
              <button
                type="button"
                onClick={() => void handleGenerateStrategy()}
                disabled={
                  !activeArchitectPlanId ||
                  isConversationPending ||
                  isBusySending ||
                  (!hasExistingStrategy && activePlanNeedsCount === 0)
                }
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-medium border transition-colors',
                  !activeArchitectPlanId ||
                    isConversationPending ||
                    isBusySending ||
                    (!hasExistingStrategy && activePlanNeedsCount === 0)
                      ? 'border-border text-muted-foreground bg-card/40 cursor-not-allowed'
                      : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground'
                  )}
                  title={
                    !activeArchitectPlanId
                      ? t('architect.generateStrategySelectPlan', 'Select an active plan first')
                      : !hasExistingStrategy && activePlanNeedsCount === 0
                        ? t('architect.generateStrategyNeedPrompt', 'Add at least one need before generating a strategy')
                        : hasExistingStrategy
                          ? t('architect.regenerateStrategyHint', 'Regenerate strategy from current needs')
                          : t('architect.generateStrategyHint', 'Generate strategy from identified needs')
                  }
                >
                  <Icon name={hasExistingStrategy ? 'refresh-cw' : 'sparkles'} size={12} />
                  {hasExistingStrategy
                    ? t('architect.regenerateStrategy', 'Regenerate Strategy')
                    : t('architect.generateStrategy', 'Generate Strategy')}
                </button>
              )}
            </div>

            {mode === 'Implement' && selectedTask && !isManualFeatureDraftTask && currentMessages.length === 0 && (
              <div className="rounded-xl border border-border bg-card/70 p-3 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-foreground">
                      {t('implement.executionBrief', 'Task briefing')}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {selectedTask.description || t('implement.noTaskDescription', 'No task description provided.')}
                    </p>
                    <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-2 py-1">
                        <Icon name="git-branch" size={10} />
                        {selectedTask.branch_name}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-2 py-1">
                        <Icon name="folder" size={10} />
                        {selectedTaskProjectSummary}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleStartExecution({ trigger: 'manual' }).catch(() => undefined)}
                    disabled={!canStartImplementExecution || !selectedProviderId || !selectedModelId || isBusySending}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors shrink-0',
                      canStartImplementExecution && selectedProviderId && selectedModelId && !isBusySending
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'bg-muted text-muted-foreground cursor-not-allowed'
                    )}
                  >
                    <Icon name="play" size={14} />
                    {isAutoLaunchArmedForSelection
                      ? t('implement.executionStartingAuto', 'Auto-start armed')
                      : t('implement.startExecution', 'Start execution')}
                  </button>
                </div>
                <textarea
                  value={kickoffNotes}
                  onChange={(event) => setKickoffNotes(event.target.value)}
                  rows={3}
                  placeholder={t('implement.executionNotesPlaceholder', 'Optional guidance for this task kickoff')}
                  className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/50"
                  disabled={isAutoLaunchArmedForSelection}
                />
              </div>
            )}

            {lastError && (
              <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {lastError}
              </div>
            )}

            {activeQuestionnaire ? (
              <div
                data-testid="questionnaire-footer"
                className="rounded-xl border border-border bg-card/80 p-2 shadow-sm"
              >
                <div className="space-y-3 rounded-[0.9rem] border border-border/60 bg-background/30 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background/60">
                        <Icon name="message-circle" size={14} className="text-primary/80" />
                      </span>
                      <div className="flex min-w-0 items-center gap-2.5 h-8">
                        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          {t('chat.questionnaireLabel', 'Question')}
                        </div>
                        <div
                          data-testid="questionnaire-step-counter-shell"
                          className="inline-flex items-center gap-0 rounded-full border border-border/60 bg-background/45 px-[2px] py-[2px]"
                        >
                          {activeQuestionnaire.totalSteps > 1 && (
                            <button
                              type="button"
                              data-testid="questionnaire-step-nav-prev"
                              onClick={() =>
                                handleQuestionnaireStepChange(
                                  activeQuestionnaire.currentStepIndex - 1
                                )
                              }
                            disabled={isBusySending || !activeQuestionnaireHasPreviousStep}
                            title={t('chat.questionnairePreviousStep', 'Question precedente')}
                            aria-label={t('chat.questionnairePreviousStep', 'Question precedente')}
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/75 transition-colors hover:bg-accent/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-25"
                          >
                            <Icon name="chevron-left" size={12} />
                          </button>
                        )}
                        <div
                          data-testid="questionnaire-step-counter"
                          className="px-1 text-center text-[11px] font-medium tabular-nums text-muted-foreground"
                        >
                          {`${activeQuestionnaire.currentStepIndex + 1}/${activeQuestionnaire.totalSteps}`}
                        </div>
                          {activeQuestionnaire.totalSteps > 1 && (
                            <button
                              type="button"
                              data-testid="questionnaire-step-nav-next"
                              onClick={() =>
                                handleQuestionnaireStepChange(
                                  activeQuestionnaire.currentStepIndex + 1
                                )
                              }
                            disabled={isBusySending || !activeQuestionnaireHasNextStep}
                            title={t('chat.questionnairePeekNextStep', 'Question suivante')}
                            aria-label={t('chat.questionnairePeekNextStep', 'Question suivante')}
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/75 transition-colors hover:bg-accent/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-25"
                          >
                            <Icon name="chevron-right" size={12} />
                          </button>
                        )}
                        </div>
                        <div className="sr-only">
                          {t('chat.questionnaireProgress', 'Question {{current}}/{{total}}', {
                            current: activeQuestionnaire.currentStepIndex + 1,
                            total: activeQuestionnaire.totalSteps,
                          })}
                        </div>
                      </div>
                    </div>
                    <span className="inline-flex items-center rounded-full border border-border/70 bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                      {t('chat.questionnaireFreeTextHint', 'Choose one option or answer freely')}
                    </span>
                  </div>

                  <div
                    key={`${activeQuestionnaire.assistantMessageId}-${activeQuestionnaire.currentStepIndex}-${activeQuestionnaire.currentStep.id}`}
                    data-testid="questionnaire-step-panel"
                    className="questionnaire-step-enter space-y-3"
                  >
                    <div className="px-1 pt-1 pb-0.5">
                      <p className="text-[1.02rem] font-semibold leading-7 text-foreground text-balance">
                        {activeQuestionnaire.currentStep.prompt}
                      </p>
                    </div>

                    <div
                      data-testid="questionnaire-choice-list"
                      className="flex flex-col gap-2"
                    >
                      {activeQuestionnaire.currentStep.choices.map((choice) => {
                        const isSelected = activeQuestionnaireSelectedChoice === choice;
                        return (
                        <Button
                          key={choice}
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleQuestionnaireAnswer(choice)}
                          disabled={isBusySending}
                          className={cn(
                            'h-auto min-h-[52px] w-full justify-start rounded-xl border px-3 py-3 text-left text-sm whitespace-normal',
                            isBusySending
                              ? 'border-border bg-muted/40 text-muted-foreground'
                              : isSelected
                                ? 'border-primary/50 bg-primary/10 text-foreground'
                                : 'border-border/70 bg-background/45 text-foreground hover:border-primary/40 hover:bg-accent/60'
                          )}
                        >
                          {choice}
                        </Button>
                        );
                      })}
                    </div>

                    <div className="flex flex-col gap-2 md:flex-row md:items-center">
                      <Input
                        type="text"
                        value={activeQuestionnaireDraftText}
                        onChange={(event) => setActiveQuestionnaireDraftText(
                          activeQuestionnaire.conversationId,
                          event.target.value,
                        )}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void handleQuestionnaireSubmit();
                          }
                        }}
                        placeholder={
                          activeQuestionnaire.currentStep.free_text_placeholder ||
                          t('chat.questionnaireFreeTextPlaceholder', 'Or type your own answer')
                        }
                        disabled={isBusySending}
                        className="h-11 flex-1 border-border/70 bg-background/60"
                      />
                      {activeQuestionnaire.mode === 'editing_response' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={handleQuestionnaireCancel}
                          disabled={isBusySending}
                          className="h-11 shrink-0 rounded-xl border border-border/70 px-4"
                        >
                          {t('common.cancel', 'Annuler')}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleQuestionnaireSubmit()}
                        disabled={
                          isBusySending ||
                          activeQuestionnaireSubmitValue.trim().length === 0
                        }
                        className="h-11 shrink-0 rounded-xl px-4"
                      >
                        {activeQuestionnaire.isLastStep
                          ? t('chat.questionnaireSubmit', 'Envoyer')
                          : t('chat.questionnaireNext', 'Suivant')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div
                className="flex items-center gap-2 bg-card/80 border border-border rounded-xl px-2 py-1.5"
                onPasteCapture={handleComposerPaste}
              >
                <Suspense fallback={<ComposerFallbackStatus />}>
                  <LazyComposerEditor
                    ref={composerEditorRef}
                    editable={!isBusySending && !!selectedProviderId && !!selectedModelId && !isComposerDisabled}
                    placeholder={
                      isConversationPending
                        ? t('chat.loadingConversation', 'Restoring conversation...')
                        : isImplementTaskSelectionMissing
                        ? t('implement.selectTaskToStart', 'Select a task to start implementation.')
                        : isImplementComposerLocked
                        ? t('implement.startExecutionFirst', 'Start execution to begin the task conversation')
                        : !selectedProviderId || !selectedModelId
                        ? t('chat.selectProvider')
                        : t('chat.typeMessage')
                    }
                    onTextChange={(text) => {
                      if (lastError) {
                        clearLastError();
                      }
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
                </Suspense>
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
                  disabled={isBusySending || !canSend || !selectedProviderId || !selectedModelId || isComposerDisabled}
                  className={cn(
                    'rounded-lg px-3 h-9 flex items-center transition-colors',
                    isBusySending || !canSend || !selectedProviderId || !selectedModelId || isComposerDisabled
                      ? 'bg-muted text-muted-foreground cursor-not-allowed'
                      : 'bg-primary hover:bg-primary/90 text-primary-foreground'
                  )}
                >
                  {isBusySending ? (
                    <Icon name="loader" size={14} className="animate-spin" />
                  ) : (
                    <Icon name="arrow-up" size={14} />
                  )}
                </button>
              )}
              </div>
            )}
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
