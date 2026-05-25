import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import type { MessageImageAttachment } from '../../stores/useChatStore';
import type { ChatMessage, Need } from '../../types';
import { useNeedsStore } from '../../stores/useNeedsStore';
import { useProviderStore } from '../../stores/useProviderStore';
import { useShortcutsStore } from '../../stores/useShortcutsStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { Icon } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';
import { cn } from '../../utils/cn';
import { ProviderDropdown } from '../ai/ProviderDropdown';
import { ModelDropdown } from '../ai/ModelDropdown';
import { ReasoningDropdown } from '../ai/ReasoningDropdown';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useScrollMagnet } from '../../hooks/useScrollMagnet';
import { ScrollSeparator } from './ScrollSeparator';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { SkillDropdown } from './SkillDropdown';
import { ContextReferenceChip } from './ContextReferenceChip';
import {
  getFocusedProjectForGroup,
  getGlobalProjectById,
  getRepositoryScopedProjectIds,
} from '../../services/globalProjects';
import {
  isProjectWorkspaceMissing,
  resolveProjectWorkspaceState,
} from '../../services/projectWorkspaceState';
import { ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX } from '../../services/architectChat';
import { resolveActiveConversationQuestionnaire } from '../../services/chatQuestionnaires';
import { getServiceRuntimeCapabilities } from '../../services';
import { useVirtualMessages } from '../../hooks/useVirtualList';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import LazyComposerEditor, { type ComposerEditorHandle } from './composer/LazyComposerEditor';
import { QuestionnaireFooter } from './QuestionnaireFooter';
import { ToolApprovalFooter } from './ToolApprovalFooter';
import { QuestionnaireResponseSummary } from './QuestionnaireResponseSummary';
import { PlanFormModal } from '../architect/PlanFormModal';
import { ArchitectPlanNamingRecoveryModal } from '../architect/ArchitectPlanNamingRecoveryModal';
import { ProjectWorkspaceEmptyState } from '../shared/ProjectWorkspaceEmptyState';
import { getPlanNodeTodoState } from '../../services/planNodeTodos';
import { ImplementTaskTodoDropdown } from './ImplementTaskTodoDropdown';
import {
  getDependencyBlockedMessage,
  TaskBlockedState,
} from '../implement/TaskBlockedState';
import {
  buildChatTranscriptItems,
  getTranscriptMessageIndexById,
  isChatTranscriptCompactionProgressPhase,
  type ChatTranscriptItem,
  type ChatTranscriptMessageItem,
} from './transcriptItems';
import {
  CompactionBoundaryRow,
  CompactionProgressRow,
} from './CompactionTranscriptUi';
import { ContextWindowIndicator } from './ContextWindowIndicator';
import { AgentCodeReplayConfirmModal } from './AgentCodeReplayConfirmModal';
import { useAgentCodeReplayConfirmation } from './useAgentCodeReplayConfirmation';

interface ChatZoneProps {
  headerActions?: React.ReactNode;
}

interface ContextControlsVisibilityInput {
  mode: 'Chat' | 'Architect' | 'Implement';
  selectedConversationId?: string | null;
  selectedTaskId?: string | null;
  activeArchitectPlanId?: string | null;
}

export const shouldShowContextControls = ({
  mode,
  selectedConversationId,
  selectedTaskId,
  activeArchitectPlanId,
}: ContextControlsVisibilityInput): boolean => {
  if (!selectedConversationId) {
    return false;
  }

  if (mode === 'Implement') {
    return Boolean(selectedTaskId);
  }

  if (mode === 'Architect') {
    return Boolean(activeArchitectPlanId);
  }

  return true;
};

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
const CHAT_TRANSCRIPT_ITEM_GAP = 24;
const CHAT_COMPACTION_ROW_ESTIMATED_SIZE = 40;
const CHAT_COMPACTION_AFTER_ASSISTANT_GAP_REDUCTION = CHAT_TRANSCRIPT_ITEM_GAP;
const EMPTY_SESSION_COMPACTION_EVENTS: {
  id: string;
  status: 'running' | 'completed';
  displayAfterMessageId?: string | null;
  logicalUpToMessageId?: string | null;
  kind?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}[] = [];

const getAssistantCompletionNotice = (
  completionReason: ChatMessage['completion_reason'] | undefined,
  t: ReturnType<typeof useTranslation>['t']
): { title: string; description: string } | null => {
  switch (completionReason) {
    case 'tool_turn_limit':
      return {
        title: t('chat.toolTurnLimitNoticeTitle', 'Tool turn limit reached'),
        description: t(
          'chat.toolTurnLimitNoticeDescription',
          'Macro stopped the agent loop after the configured turn limit. Change or disable it in Settings > General > Max agent turns, then send a new message to continue.'
        ),
      };
    case 'post_tool_empty_fallback':
      return {
        title: t('chat.toolTurnLimitFallbackTitle', 'Tool turn limit reached'),
        description: t(
          'chat.toolTurnLimitFallbackDescription',
          'The final no-tool pass did not produce a usable answer, so Macro showed a fallback summary.'
        ),
      };
    default:
      return null;
  }
};

const AssistantCompletionNotice: React.FC<{
  completionReason: ChatMessage['completion_reason'] | undefined;
  hasPreviousContent: boolean;
}> = ({ completionReason, hasPreviousContent }) => {
  const { t } = useTranslation();
  const notice = getAssistantCompletionNotice(completionReason, t);

  if (!notice) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-chat-completion-notice={completionReason}
      className={cn(
        'flex items-start gap-2 rounded-lg border border-border bg-card/40 px-2.5 py-2 text-xs text-muted-foreground',
        hasPreviousContent ? 'mt-3' : 'mt-0'
      )}
    >
      <span className="relative mt-0.5 h-5 w-5 shrink-0 rounded-md border border-destructive/20 bg-destructive/10">
        <Icon
          name="triangle-alert"
          size={12}
          className="absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2 text-destructive"
        />
      </span>
      <div className="min-w-0">
        <div className="font-medium leading-snug text-foreground">{notice.title}</div>
        <div className="mt-0.5 leading-relaxed">{notice.description}</div>
      </div>
    </div>
  );
};

interface RenderedTranscriptItem {
  index: number;
  key: React.Key;
  size: number;
  start: number;
  item: ChatTranscriptItem;
}

interface RenderedMessageItem extends Omit<RenderedTranscriptItem, 'item'> {
  item: ChatTranscriptMessageItem;
}

type AssistantMessageActivity = 'streaming' | null;

interface ChatMessageRowProps {
  virtualMessage: RenderedMessageItem;
  measureElement: (el: HTMLElement | null) => void;
  assistantActivity: AssistantMessageActivity;
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
  needsByTitle: Map<string, Need>;
}

const USER_CONTEXT_MENTION_PATTERN = /\[(need|skill):\s*([^\]]+)\]/gi;

const normalizeNeedMentionTitle = (value: string): string =>
  value.trim().normalize('NFC').toLocaleLowerCase();

const resolveAssistantActivityAnchorId = (
  messages: ChatMessage[],
  preferredMessageId: string | null,
  allowLatestAssistantFallback: boolean,
): string | null => {
  if (
    preferredMessageId &&
    messages.some(
      (message) =>
        message.id === preferredMessageId && message.role === 'assistant',
    )
  ) {
    return preferredMessageId;
  }

  if (!allowLatestAssistantFallback) {
    return null;
  }

  const latestMessage = messages[messages.length - 1];
  return latestMessage?.role === 'assistant' ? latestMessage.id : null;
};

const UserMessageContent: React.FC<{
  content: string;
  needsByTitle: Map<string, Need>;
}> = ({ content, needsByTitle }) => {
  const { t } = useTranslation();

  return (
    <>
      {content.split('\n').map((line, lineIndex) => {
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        const contextMentionPattern = new RegExp(USER_CONTEXT_MENTION_PATTERN);

        while ((match = contextMentionPattern.exec(line)) !== null) {
          if (match.index > lastIndex) {
            parts.push(line.slice(lastIndex, match.index));
          }

          const kind = match[1]?.toLocaleLowerCase() === 'need' ? 'need' : 'skill';
          const title = match[2]?.trim() ?? '';
          const need = kind === 'need'
            ? needsByTitle.get(normalizeNeedMentionTitle(title))
            : undefined;
          parts.push(
            <ContextReferenceChip
              key={`${lineIndex}-${match.index}-${title}`}
              kind={kind}
              need={need}
              title={title}
              surface="message"
              priorityLabel={need ? t(`architect.needPriority.${need.priority}`, need.priority) : undefined}
            />
          );
          lastIndex = match.index + match[0].length;
        }

        if (lastIndex < line.length) {
          parts.push(line.slice(lastIndex));
        }

        return (
          <p key={lineIndex} className="mb-2 last:mb-0 break-words">
            {parts.length > 0 ? parts : line}
          </p>
        );
      })}
    </>
  );
};

const ChatMessageRowBase: React.FC<ChatMessageRowProps> = ({
  virtualMessage,
  measureElement,
  assistantActivity,
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
  needsByTitle,
}) => {
  const { t } = useTranslation();
  const message = virtualMessage.item.message;
  const editingEditorRef = useRef<ComposerEditorHandle>(null);
  const visibleImages = isEditing ? editingImages : messageImages;
  const questionnaireResponseSummary = message.questionnaire_response_summary;
  const isQuestionnaireResponseMessage = Boolean(questionnaireResponseSummary);
  const hasAssistantActivity =
    message.role === 'assistant' &&
    assistantActivity !== null;
  const hasAssistantCompletionNotice =
    message.role === 'assistant' &&
    Boolean(message.completion_reason && message.completion_reason !== 'completed');
  const hasAssistantVisibleBody =
    message.role === 'assistant' &&
    (message.content.trim().length > 0 ||
      (showToolTraces && (message.tool_traces?.length ?? 0) > 0));

  useEffect(() => {
    if (!isEditing) {
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      editingEditorRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isEditing, message.id]);

  return (
    <div
      ref={measureElement}
      data-index={virtualMessage.index}
      data-scroll-magnet-anchor={message.id}
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
                ? hasAssistantCompletionNotice
                  ? 'p-2 pb-10'
                  : 'p-2 pb-6'
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
              <div
                onPasteCapture={(event) => {
                  void onEditingPaste(event);
                }}
              >
                <LazyComposerEditor
                  key={message.id}
                  ref={editingEditorRef}
                  editable
                  initialText={editingValue}
                  placeholder={t('common.editMessage') || 'Edit your message...'}
                  onTextChange={onEditingValueChange}
                  onSend={onEditSave}
                  surface="message-edit"
                  syncContextRefs={false}
                  className="w-full min-h-[120px] max-h-[400px] overflow-y-auto rounded-lg border-2 border-border bg-background p-3 text-sm leading-5 text-foreground transition-all focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
                />
              </div>
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
                <>
                  <MarkdownRenderer
                    content={message.content}
                    toolTraces={showToolTraces ? message.tool_traces : undefined}
                    isStreaming={assistantActivity === 'streaming'}
                  />
                  <AssistantCompletionNotice
                    completionReason={message.completion_reason}
                    hasPreviousContent={hasAssistantVisibleBody}
                  />
                </>
              ) : questionnaireResponseSummary ? (
                <QuestionnaireResponseSummary summary={questionnaireResponseSummary} />
              ) : (
                <UserMessageContent
                  content={message.content}
                  needsByTitle={needsByTitle}
                />
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
              {hasAssistantActivity && (
                <span
                  data-chat-assistant-activity="true"
                  className="inline-block w-2 h-4 bg-primary/60 animate-pulse ml-1"
                />
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
    prev.assistantActivity === next.assistantActivity &&
    prev.showToolTraces === next.showToolTraces &&
    prev.needsByTitle === next.needsByTitle
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
  const runtimeCapabilities = getServiceRuntimeCapabilities();
  const {
    mode,
    agentType,
    setAgentType,
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    projectGroups,
    activeArchitectPlanId,
    activePlanContext,
    planNodes,
    predictedBranches,
    openProjectModal,
  } = useAppStore(useShallow((state) => ({
    mode: state.mode,
    agentType: state.agentType,
    setAgentType: state.setAgentType,
    selectedGroupId: state.selectedGroupId,
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    projectGroups: state.projectGroups,
    activeArchitectPlanId: state.activeArchitectPlanId,
    activePlanContext: state.activePlanContext,
    planNodes: state.planNodes,
    predictedBranches: state.predictedBranches,
    openProjectModal: state.openProjectModal,
  })));
  const {
    conversations,
    messages,
    selectedConversationId,
    selectedConversationRuntime,
    conversationCompactionStatusById,
    sessionCompactionEventsByConversationId,
    contextDiagnosticsByConversationId,
    messagesByConversationId,
    createConversation,
    ensureConversationForCurrentMode,
    hydrationStatus,
    restoreStatus,
    lastError,
    stopStreaming,
    sendMessage,
    clearLastError,
    clearConversationRuntimeError,
    editMessage,
    getAgentCodeReplayPreview,
    restoreAgentCodeForReplay,
    getMessageImages,
    setMessageImages,
    architectPlanNamingRecovery,
    setArchitectPlanNamingRecoveryStage,
    retryArchitectPlanNamingRecovery,
    submitArchitectPlanManualName,
    composerContextRefs,
    questionnaireDraftsByConversationId,
    getPendingToolApproval,
    approvePendingToolApprovalOnce,
    approvePendingToolApprovalForConversation,
    denyPendingToolApproval,
    startQuestionnaireResponseEdit,
    cancelQuestionnaireSession,
    setActiveQuestionnaireStep,
    setActiveQuestionnaireDraftText,
    recordActiveQuestionnaireAnswer,
    submitActiveQuestionnaire,
    compactConversationNow,
    refreshConversationContextDiagnostics,
  } = useChatStore(useShallow((state) => ({
    conversations: state.conversations,
    messages: state.messages,
    selectedConversationId: state.selectedConversationId,
    selectedConversationRuntime: state.selectedConversationId
      ? state.getConversationRuntime(state.selectedConversationId)
      : state.getConversationRuntime(''),
    conversationCompactionStatusById: state.conversationCompactionStatusById,
    sessionCompactionEventsByConversationId:
      state.sessionCompactionEventsByConversationId,
    contextDiagnosticsByConversationId: state.contextDiagnosticsByConversationId,
    messagesByConversationId: state.messagesByConversationId ?? {},
    createConversation: state.createConversation,
    ensureConversationForCurrentMode: state.ensureConversationForCurrentMode,
    hydrationStatus: state.hydrationStatus,
    restoreStatus: state.restoreStatus,
    lastError: state.lastError,
    stopStreaming: state.stopStreaming,
    sendMessage: state.sendMessage,
    clearLastError: state.clearLastError,
    clearConversationRuntimeError: state.clearConversationRuntimeError,
    editMessage: state.editMessage,
    getAgentCodeReplayPreview: state.getAgentCodeReplayPreview,
    restoreAgentCodeForReplay: state.restoreAgentCodeForReplay,
    getMessageImages: state.getMessageImages,
    setMessageImages: state.setMessageImages,
    architectPlanNamingRecovery: state.architectPlanNamingRecovery,
    setArchitectPlanNamingRecoveryStage:
      state.setArchitectPlanNamingRecoveryStage,
    retryArchitectPlanNamingRecovery: state.retryArchitectPlanNamingRecovery,
    submitArchitectPlanManualName: state.submitArchitectPlanManualName,
    composerContextRefs: state.composerContextRefs,
    questionnaireDraftsByConversationId: state.questionnaireDraftsByConversationId,
    getPendingToolApproval: state.getPendingToolApproval,
    approvePendingToolApprovalOnce: state.approvePendingToolApprovalOnce,
    approvePendingToolApprovalForConversation:
      state.approvePendingToolApprovalForConversation,
    denyPendingToolApproval: state.denyPendingToolApproval,
    startQuestionnaireResponseEdit: state.startQuestionnaireResponseEdit,
    cancelQuestionnaireSession: state.cancelQuestionnaireSession,
    setActiveQuestionnaireStep: state.setActiveQuestionnaireStep,
    setActiveQuestionnaireDraftText: state.setActiveQuestionnaireDraftText,
    recordActiveQuestionnaireAnswer: state.recordActiveQuestionnaireAnswer,
    submitActiveQuestionnaire: state.submitActiveQuestionnaire,
    compactConversationNow: state.compactConversationNow,
    refreshConversationContextDiagnostics:
      state.refreshConversationContextDiagnostics,
  })));
  const { mark: markPerformance } = usePerformanceMonitor();

  const { selectedProviderId, selectedModelId, nativeToolsSupported } = useProviderStore(useShallow((state) => ({
    selectedProviderId: state.selectedProviderId,
    selectedModelId: state.selectedModelId,
    nativeToolsSupported: state.selectedSupportsNativeToolCalling(),
  })));
  const needs = useNeedsStore((state) => state.needs);
  const promptHistoryNavigationMode = useShortcutsStore((state) => state.promptHistoryNavigationMode);
  const { tasks, startTask } = useTaskStore(useShallow((state) => ({
    tasks: state.tasks,
    startTask: state.startTask,
  })));
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  );
  const isArchitectPlanSelectionMissing = mode === 'Architect' && !activeArchitectPlanId;
  const shouldShowContextControlsForActiveContext = shouldShowContextControls({
    mode,
    selectedConversationId,
    selectedTaskId,
    activeArchitectPlanId,
  });

  const [inputValue, setInputValue] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [composerImages, setComposerImages] = useState<MessageImageAttachment[]>([]);
  const [isManualCompacting, setIsManualCompacting] = useState(false);

  // Lexical composer ref
  const composerEditorRef = useRef<ComposerEditorHandle>(null);
  const contextRefreshInFlightRef = useRef(false);
  const wasContextStreamingRef = useRef(false);

  const [editingValue, setEditingValue] = useState('');
  const [editingImages, setEditingImages] = useState<MessageImageAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<MessageImageAttachment | null>(null);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState<number | null>(null);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('');
  const [isTaskTodoDropdownOpen, setIsTaskTodoDropdownOpen] = useState(false);
  const taskTodoDropdownRef = useRef<HTMLDivElement | null>(null);
  const currentMessages = useMemo(
    () =>
      selectedConversationId
        ? messagesByConversationId[selectedConversationId] ??
          messages.filter((message) => message.conversation_id === selectedConversationId)
        : EMPTY_RENDER_MESSAGES,
    [messages, messagesByConversationId, selectedConversationId]
  );
  const activeCompactionStatus = selectedConversationId
    ? conversationCompactionStatusById[selectedConversationId]
    : undefined;
  const activeSessionCompactionEvents = selectedConversationId
    ? sessionCompactionEventsByConversationId[selectedConversationId] ??
      EMPTY_SESSION_COMPACTION_EVENTS
    : EMPTY_SESSION_COMPACTION_EVENTS;
  const contextDiagnostics = selectedConversationId
    ? contextDiagnosticsByConversationId[selectedConversationId]
    : undefined;
  const activeCompactionPhase = activeCompactionStatus?.phase ?? null;
  const isRuntimeCompacting =
    isChatTranscriptCompactionProgressPhase(activeCompactionPhase);
  const isActiveContextCompacting = isRuntimeCompacting || isManualCompacting;
  const isContextStreaming = selectedConversationRuntime.phase === 'streaming';
  const isPreparingSend = selectedConversationRuntime.phase === 'preparing';
  const isBusySending = isContextStreaming || isPreparingSend;
  const isContextOverflowRecovering =
    selectedConversationRuntime.phase === 'overflow_recovery';
  const runtimeAssistantMessageId =
    selectedConversationRuntime.assistantMessageId ?? null;
  const activeTranscriptCompactionPhase =
    isRuntimeCompacting
      ? activeCompactionPhase
      : isManualCompacting
        ? 'compacting'
        : null;
  const activeTranscriptProgressPhase = activeTranscriptCompactionPhase;
  const shouldShowContextIndicator =
    Boolean(selectedConversationId) &&
    (shouldShowContextControlsForActiveContext ||
      Boolean(contextDiagnostics) ||
      isActiveContextCompacting);
  const runtimeAssistantActivityAnchorId = resolveAssistantActivityAnchorId(
    currentMessages,
    runtimeAssistantMessageId,
    false,
  );
  const streamingAssistantActivityMessageId =
    !activeTranscriptProgressPhase && (isBusySending || isContextOverflowRecovering)
      ? runtimeAssistantActivityAnchorId
      : null;
  const runContextDiagnosticsRefresh = useCallback(async () => {
    if (
      !selectedConversationId ||
      !shouldShowContextControlsForActiveContext ||
      contextRefreshInFlightRef.current
    ) {
      return;
    }

    contextRefreshInFlightRef.current = true;
    try {
      await refreshConversationContextDiagnostics(selectedConversationId, {
        mode: isContextStreaming ? 'live_stream' : 'full',
      });
    } finally {
      contextRefreshInFlightRef.current = false;
    }
  }, [
    isContextStreaming,
    refreshConversationContextDiagnostics,
    selectedConversationId,
    shouldShowContextControlsForActiveContext,
  ]);
  const transcriptItems = useMemo(
    () =>
      buildChatTranscriptItems(currentMessages, {
        conversationId: selectedConversationId,
        compactionEvents: activeSessionCompactionEvents,
      }),
    [
      activeSessionCompactionEvents,
      currentMessages,
      selectedConversationId,
    ]
  );

  useEffect(() => {
    if (
      !selectedConversationId ||
      !shouldShowContextControlsForActiveContext ||
      isContextStreaming ||
      wasContextStreamingRef.current
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void runContextDiagnosticsRefresh();
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    activeCompactionStatus?.updatedAt,
    activeCompactionStatus?.phase,
    currentMessages,
    isContextStreaming,
    runContextDiagnosticsRefresh,
    selectedConversationId,
    selectedConversationRuntime.lastError,
    selectedConversationRuntime.lastErrorDisplayTarget,
    selectedModelId,
    selectedProviderId,
    shouldShowContextControlsForActiveContext,
  ]);

  useEffect(() => {
    wasContextStreamingRef.current = isContextStreaming;
  }, [isContextStreaming]);

  const isStreaming = isContextStreaming;
  const isTranscriptActivityActive =
    isContextStreaming ||
    isPreparingSend ||
    isContextOverflowRecovering ||
    Boolean(activeTranscriptProgressPhase);

  const handleManualCompaction = useCallback(async () => {
    if (!selectedConversationId || isManualCompacting || isBusySending) {
      return;
    }
    setIsManualCompacting(true);
    try {
      await compactConversationNow(selectedConversationId);
    } finally {
      setIsManualCompacting(false);
    }
  }, [compactConversationNow, isBusySending, isManualCompacting, selectedConversationId]);
  const needsByMentionTitle = useMemo(() => {
    const indexed = new Map<string, Need>();
    for (const need of needs) {
      if (typeof need.title !== 'string') continue;
      indexed.set(normalizeNeedMentionTitle(need.title), need);
    }
    return indexed;
  }, [needs]);
  const activeQuestionnaireDraft = selectedConversationId
    ? questionnaireDraftsByConversationId[selectedConversationId]
    : undefined;
  const activePendingToolApproval = selectedConversationId
    ? getPendingToolApproval(selectedConversationId)
    : null;
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
  const composerRuntimeError =
    selectedConversationRuntime.lastErrorDisplayTarget === 'composer' ||
    (selectedConversationRuntime.lastError &&
      !selectedConversationRuntime.lastErrorDisplayTarget)
      ? selectedConversationRuntime.lastError
      : null;
  const composerError = composerRuntimeError ?? lastError;

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
  const currentConversation = !isArchitectPlanSelectionMissing && selectedConversationId
    ? conversations.find((c) => c.id === selectedConversationId)
    : null;

  const selectedTaskTodoState = useMemo(
    () => (selectedTask ? getPlanNodeTodoState(selectedTask) : null),
    [selectedTask]
  );
  const selectedTaskTodos =
    selectedTaskTodoState?.kind === 'stored' ? selectedTaskTodoState.todos : [];
  const canShowImplementTaskTodoDropdown =
    mode === 'Implement' &&
    selectedTask?.task_source === 'architect' &&
    selectedTaskTodos.length > 0;
  const isSelectedTaskDependencyBlocked =
    mode === 'Implement' && Boolean(selectedTask?.is_blocked);
  const selectedTaskBlockedMessage = getDependencyBlockedMessage(selectedTask, t);
  const implementTaskIdForSend =
    mode === 'Implement'
      ? selectedTask?.id ?? currentConversation?.task_id ?? null
      : null;
  const selectedTaskRequiresKickoff = Boolean(
    mode === 'Implement' &&
      selectedTask &&
      !selectedTask.draft &&
      selectedTask.task_source === 'architect'
  );
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
  const projectNameById = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.projects.map((project) => [project.id, project.name] as const)
        )
      ),
    [projectGroups]
  );
  const repositoryScopedProjectIds = useMemo(
    () => getRepositoryScopedProjectIds(projectGroups, selectedGroupId, selectedProjectId),
    [projectGroups, selectedGroupId, selectedProjectId]
  );
  const workspaceState = useMemo(
    () =>
      resolveProjectWorkspaceState({
        projectGroups,
        selectedGroupId,
        selectedProjectId,
      }),
    [projectGroups, selectedGroupId, selectedProjectId]
  );
  const isWorkspaceMissing = isProjectWorkspaceMissing(workspaceState);
  const isModeProjectWorkspaceMissing =
    (mode === 'Architect' || mode === 'Implement') && isWorkspaceMissing;
  const selectedTaskScopedProjectIds = useMemo(() => {
    if (selectedTaskProjectIds.length === 0) {
      return [];
    }

    const scopedProjectIdSet = new Set(repositoryScopedProjectIds);
    const intersection = selectedTaskProjectIds.filter((projectId) => scopedProjectIdSet.has(projectId));
    return intersection.length > 0 ? intersection : selectedTaskProjectIds;
  }, [repositoryScopedProjectIds, selectedTaskProjectIds]);
  const selectedTaskProjectSummary = useMemo(() => {
    if (selectedTaskScopedProjectIds.length === 0) {
      return t('implement.noRepositorySelected', 'No repository');
    }

    if (selectedTaskScopedProjectIds.length === 1) {
      const scopedProjectId = selectedTaskScopedProjectIds[0]!;
      return projectNameById.get(scopedProjectId) || scopedProjectId;
    }

    return t('implement.multiProjectTask', '{{count}} repositories', {
      count: selectedTaskScopedProjectIds.length,
    });
  }, [projectNameById, selectedTaskScopedProjectIds, t]);
  const canStartImplementExecution = Boolean(
    selectedTaskRequiresKickoff &&
      selectedTask &&
      runtimeCapabilities.implementExecution &&
      !selectedTask.is_blocked &&
      selectedTask.status !== 'Completed' &&
      selectedTask.status !== 'InReview' &&
      !isConversationPending &&
      currentMessages.length === 0
  );
  const isImplementComposerInKickoffMode =
    selectedTaskRequiresKickoff && currentMessages.length === 0;
  const isImplementTaskSelectionMissing = mode === 'Implement' && !selectedTask;
  const isComposerDisabled =
    isConversationPending ||
    isModeProjectWorkspaceMissing ||
    isArchitectPlanSelectionMissing ||
    isImplementTaskSelectionMissing ||
    isSelectedTaskDependencyBlocked ||
    Boolean(activeQuestionnaire) ||
    Boolean(activePendingToolApproval);

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
          isModeProjectWorkspaceMissing
            ? null
            : currentConversation?.title ||
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
    isModeProjectWorkspaceMissing,
    mode,
    projectScopeLabel,
    selectedGlobalProjectName,
    selectedTask?.title,
    t,
  ]);

  useEffect(() => {
    setIsTaskTodoDropdownOpen(false);
  }, [selectedTask?.id, canShowImplementTaskTodoDropdown]);

  useEffect(() => {
    if (!isTaskTodoDropdownOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const root = taskTodoDropdownRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        setIsTaskTodoDropdownOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsTaskTodoDropdownOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isTaskTodoDropdownOpen]);

  const architectEmptyHint = useMemo(() => {
    if (mode !== 'Architect' || !activePlanContext) {
      return t('chat.typeMessage');
    }
    if (activePlanContext.planKind === 'release') {
      return t(
        'architect.typedPlan.releaseEmptyHint',
        'Describe what you want to ship. Macro will propose versions and repositories, then ask you to confirm.'
      );
    }
    if (activePlanContext.planKind === 'hotfix') {
      return t(
        'architect.typedPlan.hotfixEmptyHint',
        'Describe the production bug. Macro will infer the repositories, propose a hotfix slug and patch versions, then ask you to confirm.'
      );
    }
    if (activePlanContext.planKind === 'bugfix') {
      return t(
        'architect.typedPlan.bugfixEmptyHint',
        'Describe the bug. Macro will infer the repositories and propose a bugfix slug before asking you to confirm.'
      );
    }
    return t('chat.typeMessage');
  }, [activePlanContext, mode, t]);

  const activePlanNeedsCount = useMemo(() => {
    if (!activeArchitectPlanId) return 0;
    return needs.filter((need) => need.planId === activeArchitectPlanId).length;
  }, [activeArchitectPlanId, needs]);

  const hasExistingStrategy = useMemo(() => {
    if (!activeArchitectPlanId) return false;
    return planNodes.length > 0 || predictedBranches.length > 0;
  }, [activeArchitectPlanId, planNodes.length, predictedBranches.length]);

  // Scroll magnetism: auto-scroll while assistant work can append visible status rows.
  const { scrollContainerRef, separatorState } = useScrollMagnet(
    isTranscriptActivityActive,
    [transcriptItems],
  );
  const disableVirtualizerScrollAdjustment = useCallback(() => false, []);
  const {
    virtualItems: virtualMessageItems,
    totalSize: virtualMessageTotalSize,
    measureElement: measureMessageElement,
    scrollToIndex: scrollToMessageIndex,
  } = useVirtualMessages(transcriptItems, {
    parentRef: scrollContainerRef,
    getItemKey: (item) => item.key,
    estimateSize: 220,
    overscan: isTranscriptActivityActive ? 10 : 6,
    dynamicHeight: true,
    gap: CHAT_TRANSCRIPT_ITEM_GAP,
    shouldAdjustScrollPositionOnItemSizeChange:
      separatorState === 'detached'
        ? disableVirtualizerScrollAdjustment
        : undefined,
  });
  const messageIndexById = useMemo(
    () => {
      const indexed = new Map<string, number>();
      for (const message of currentMessages) {
        const transcriptIndex = getTranscriptMessageIndexById(
          transcriptItems,
          message.id,
        );
        if (transcriptIndex !== null) {
          indexed.set(message.id, transcriptIndex);
        }
      }
      return indexed;
    },
    [currentMessages, transcriptItems]
  );
  const renderedMessageItems = useMemo(
    () => {
      const sourceItems =
        virtualMessageItems.length > 0
          ? virtualMessageItems
          : (() => {
              let start = 0;
              return transcriptItems.map((item, index) => {
                const size =
                  item.kind === 'compaction_boundary'
                    ? CHAT_COMPACTION_ROW_ESTIMATED_SIZE
                    : item.kind === 'compaction_progress'
                      ? CHAT_COMPACTION_ROW_ESTIMATED_SIZE
                      : 220;
                const renderedItem = {
                  index,
                  key: item.key,
                  size,
                  start,
                  item,
                };
                start += size + CHAT_TRANSCRIPT_ITEM_GAP;
                return renderedItem;
              });
            })();

      return sourceItems.reduce<{
        items: typeof sourceItems;
        positionAdjustment: number;
      }>((state, item) => {
        const previousItem = transcriptItems[item.index - 1];
        const isCompactionItem =
          item.item.kind === 'compaction_boundary' ||
          item.item.kind === 'compaction_progress';
        const assistantGapAdjustment =
          isCompactionItem &&
          previousItem?.kind === 'message' &&
          previousItem.message.role === 'assistant'
            ? CHAT_COMPACTION_AFTER_ASSISTANT_GAP_REDUCTION
            : 0;
        const adjustmentBeforeRender =
          state.positionAdjustment + assistantGapAdjustment;
        const nextItem = transcriptItems[item.index + 1];
        const followingGapAdjustment =
          isCompactionItem && nextItem ? CHAT_TRANSCRIPT_ITEM_GAP : 0;
        return {
          items: [
            ...state.items,
            {
              ...item,
              start: item.start - adjustmentBeforeRender,
            },
          ],
          positionAdjustment: adjustmentBeforeRender + followingGapAdjustment,
        };
      }, { items: [], positionAdjustment: 0 }).items;
    },
    [transcriptItems, virtualMessageItems]
  );
  const compactionGapAdjustment = useMemo(
    () =>
      transcriptItems.reduce((total, item, index) => {
        if (item.kind !== 'compaction_boundary' && item.kind !== 'compaction_progress') {
          return total;
        }

        let adjustment = total;
        const previousItem = transcriptItems[index - 1];
        if (
          previousItem?.kind === 'message' &&
          previousItem.message.role === 'assistant'
        ) {
          adjustment += CHAT_COMPACTION_AFTER_ASSISTANT_GAP_REDUCTION;
        }
        if (index < transcriptItems.length - 1) {
          adjustment += CHAT_TRANSCRIPT_ITEM_GAP;
        }
        return adjustment;
      }, 0),
    [transcriptItems]
  );
  const renderedMessageTotalSize =
    virtualMessageItems.length > 0
      ? Math.max(0, virtualMessageTotalSize - compactionGapAdjustment)
      : Math.max(
          0,
          renderedMessageItems.reduce(
            (total, item) => Math.max(total, item.start + item.size),
            0,
          )
        );

  const previousConversationIdRef = useRef<string | null>(null);
  const pendingConversationJumpRef = useRef<string | null>(null);
  const executionKickoffByConversationRef = useRef<Record<string, boolean>>({});
  const startingExecutionRef = useRef(false);

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
    if (mode === 'Architect' && isWorkspaceMissing) return null;
    if (isArchitectPlanSelectionMissing) return null;
    if (selectedConversationId) return selectedConversationId;
    const ensured = await ensureConversationForCurrentMode();
    if (ensured) return ensured;
    if (mode === 'Architect' || mode === 'Implement') return null;
    const conversation = await createConversation(t('chat.newConversation', 'New Conversation'), null, null);
    return conversation.id;
  }, [
    createConversation,
    ensureConversationForCurrentMode,
    mode,
    selectedConversationId,
    isArchitectPlanSelectionMissing,
    isWorkspaceMissing,
    t,
  ]);

  const handleStartExecution = useCallback(async (params?: {
    notesOverride?: string;
  }): Promise<boolean> => {
    if (!runtimeCapabilities.implementExecution) return false;
    if (mode !== 'Implement' || !selectedTask || isBusySending || isConversationPending) return false;
    if (!selectedTaskRequiresKickoff) return false;
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
        notes: params?.notesOverride ?? composerEditorRef.current?.getTextContent() ?? '',
      });

      await sendMessage({
        conversationId,
        content,
        taskId: selectedTask.id,
      });
      composerEditorRef.current?.clear();
      setInputValue('');
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
    ensureConversation,
    isConversationPending,
    isBusySending,
    mode,
    selectedModelId,
    selectedProviderId,
    selectedTask,
    selectedTaskProjectSummary,
    selectedTaskRequiresKickoff,
    sendMessage,
    startTask,
    runtimeCapabilities.implementExecution,
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
    if (composerError) {
      clearConversationRuntimeError(selectedConversationId ?? '');
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
    if (isArchitectPlanSelectionMissing) return;
    if (mode === 'Architect' && isWorkspaceMissing) return;
    const text = (composerEditorRef.current?.getTextContent() ?? '').trim();
    if (isImplementComposerInKickoffMode) {
      if (!text || isBusySending) return;
      try {
        await handleStartExecution({ notesOverride: text });
      } catch {
        // Keep the draft intact. The visible error feedback comes from the chat store.
      }
      return;
    }
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
      }
      return;
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

  const handleEditCommitted = useCallback(() => {
    setEditingMessageId(null);
    setEditingValue('');
    setEditingImages([]);
  }, []);

  const handleQuestionnaireCancel = () => {
    if (!activeQuestionnaire) {
      return;
    }
    cancelQuestionnaireSession(activeQuestionnaire.conversationId);
  };

  const {
    pendingReplayConfirmation,
    isReplayConfirmationSubmitting,
    requestReplay,
    cancelReplayConfirmation,
    confirmReplayConfirmation,
  } = useAgentCodeReplayConfirmation({
    getAgentCodeReplayPreview,
    restoreAgentCodeForReplay,
    editMessage,
    setMessageImages,
    onEditCommitted: handleEditCommitted,
  });

  const handleEditSave = async () => {
    if (!editingMessageId) return;
    const content = editingValue.trim();
    if (!content) return;
    await requestReplay({
      kind: 'edit',
      messageId: editingMessageId,
      content,
      images: editingImages,
    });
  };

  const handleCopy = async (content: string, messageId: string) => {
    await navigator.clipboard.writeText(content);
    setCopiedMessageId(messageId);
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  const handleRegenerate = async (messageId: string, content: string) => {
    await requestReplay({
      kind: 'regenerate',
      messageId,
      content,
    });
  };

  const canSend =
    !isComposerDisabled &&
    !activeQuestionnaire &&
    !isConversationPending &&
    (
      isImplementComposerInKickoffMode
        ? Boolean(inputValue.trim())
        : Boolean(inputValue.trim()) || composerImages.length > 0 || composerContextRefs.length > 0
    );
  const hasComposerSkillReference = useMemo(
    () => composerContextRefs.some((ref) => ref.kind === 'skill'),
    [composerContextRefs]
  );
  const hasComposerSkillMention = useMemo(
    () => /\$[A-Za-z0-9_-]{1,80}\b/.test(inputValue),
    [inputValue]
  );
  const showSkillNativeToolWarning =
    !nativeToolsSupported && (hasComposerSkillReference || hasComposerSkillMention);

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
    <main
      className="flex h-full min-h-0 min-w-0 overflow-hidden bg-background"
      data-tour-id="chat-surface"
    >
      {/* Main Chat Area */}
      <div className="flex-1 flex min-h-0 min-w-0 flex-col overflow-hidden">
        {/* Header */}
        <header
          className="h-14 border-b border-border/50 flex items-center justify-between px-4 bg-card/30"
          data-tour-id="mode-context-header"
        >
          <div className="flex items-center gap-3 min-w-0">
            {canShowImplementTaskTodoDropdown ? (
              <ImplementTaskTodoDropdown
                taskTitle={modeHeader.title}
                todos={selectedTaskTodos}
                isOpen={isTaskTodoDropdownOpen}
                onToggle={() => setIsTaskTodoDropdownOpen((current) => !current)}
                rootRef={taskTodoDropdownRef}
              />
            ) : (
              <div className="w-6 h-6 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                <Icon name={modeHeader.icon} size={10} className="text-primary" />
              </div>
            )}
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
              <div data-tour-id="architect-plan-selector">
                <Suspense fallback={<PlanSelectorFallback />}>
                  <LazyPlanSelector />
                </Suspense>
              </div>
            )}
            {shouldShowContextIndicator && selectedConversationId && (
              <ContextWindowIndicator
                diagnostics={contextDiagnostics}
                compactionStatus={activeCompactionStatus}
                isCompacting={isActiveContextCompacting}
                canCompactNow={!isBusySending && !isManualCompacting}
                onRefresh={() => {
                  void runContextDiagnosticsRefresh();
                }}
                onCompactNow={handleManualCompaction}
              />
            )}
            {headerActions}
          </div>
        </header>

        {/* Conversation Content */}
        <div
          ref={scrollContainerRef}
          className="flex-1 min-h-0 overflow-y-auto px-12 pt-8 pb-4"
          style={{
            overflowAnchor: separatorState === 'detached' ? 'none' : undefined,
          }}
          data-tour-id="chat-transcript"
        >
          {isConversationPending ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto rounded-xl bg-card border border-border flex items-center justify-center">
                  <SpinnerIcon size={24} className="text-muted-foreground" />
                </div>
                <div>
                  <p className="text-muted-foreground text-sm">
                    {t('chat.loadingConversation', 'Restoring conversation...')}
                  </p>
                </div>
              </div>
            </div>
          ) : isModeProjectWorkspaceMissing ? (
            <ProjectWorkspaceEmptyState
              stateKind={workspaceState.kind}
              onPrimaryAction={() => openProjectModal(null)}
            />
          ) : isArchitectPlanSelectionMissing ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-4">
                <div className="w-16 h-16 mx-auto rounded-xl bg-card border border-border flex items-center justify-center">
                  <Icon name="compass" size={24} className="text-muted-foreground" />
                </div>
                <p className="text-muted-foreground text-sm">
                  {t(
                    'architect.selectPlanToStart',
                    'Select or create a plan to start architecting.'
                  )}
                </p>
              </div>
            </div>
          ) : isSelectedTaskDependencyBlocked && selectedTask ? (
            <TaskBlockedState
              title={t('implement.taskBlockedTitle', 'Task blocked')}
              message={selectedTaskBlockedMessage}
              help={t(
                'implement.taskBlockedConversationHelp',
                'Complete the prerequisite tasks before starting implementation here.'
              )}
            />
          ) : selectedConversationId && transcriptItems.length > 0 ? (
            <div className="max-w-4xl mx-auto relative" style={{ height: renderedMessageTotalSize }}>
              {renderedMessageItems.map((virtualItem) => {
                if (virtualItem.item.kind === 'compaction_boundary') {
                  const previousItem = transcriptItems[virtualItem.index - 1];
                  const compactTopSpacing =
                    previousItem?.kind === 'message' &&
                    previousItem.message.role === 'assistant';
                  return (
                    <CompactionBoundaryRow
                      key={virtualItem.key}
                      virtualItem={virtualItem}
                      measureElement={measureMessageElement}
                      compactTopSpacing={compactTopSpacing}
                    />
                  );
                }
                if (virtualItem.item.kind === 'compaction_progress') {
                  const previousItem = transcriptItems[virtualItem.index - 1];
                  const compactTopSpacing =
                    previousItem?.kind === 'message' &&
                    previousItem.message.role === 'assistant';
                  return (
                    <CompactionProgressRow
                      key={virtualItem.key}
                      virtualItem={virtualItem}
                      measureElement={measureMessageElement}
                      phase={virtualItem.item.phase}
                      compactTopSpacing={compactTopSpacing}
                    />
                  );
                }

                const virtualMessage = virtualItem as RenderedMessageItem;
                const message = virtualMessage.item.message;
                const isEditing = editingMessageId === message.id;
                const messageImages = message.role === 'user' ? getMessageImages(message.id) : [];
                const assistantActivity: AssistantMessageActivity =
                  message.id === streamingAssistantActivityMessageId ? 'streaming' : null;

                return (
                  <MemoizedChatMessageRow
                    key={virtualMessage.key}
                    virtualMessage={virtualMessage}
                    measureElement={measureMessageElement}
                    assistantActivity={assistantActivity}
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
                    needsByTitle={needsByMentionTitle}
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
                    <p className="text-muted-foreground text-sm">{architectEmptyHint}</p>
                  ) : mode === 'Implement' ? (
                    <p className="text-muted-foreground text-sm">
                      {selectedTask
                        ? selectedTaskRequiresKickoff
                          ? t(
                              'implement.startConversationFromBrief',
                              'Use the task briefing below to start the task conversation.'
                            )
                          : t('chat.typeMessage')
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
        <footer className="bg-card/30 p-3" data-tour-id="chat-footer">
          <div className="w-full max-w-3xl mx-auto space-y-3">
            {!activeQuestionnaire && !activePendingToolApproval && composerImages.length > 0 && (
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

            <div className="flex items-center justify-between" data-tour-id="chat-control-row">
              <div className="flex items-center gap-2">
                {mode === 'Implement' && (
                  <div
                    className="inline-flex items-center rounded-lg border border-border bg-muted/60 p-0.5"
                    data-tour-id="implement-agent-toggle"
                  >
                    <button
                      type="button"
                      onClick={() => setAgentType('plan')}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                        agentType === 'plan'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      title={t('chat.agentTypePlanTitle', 'Plan: read-only investigation')}
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
                      title={t('chat.agentTypeBuildTitle', 'Build: apply changes')}
                    >
                      <Icon name="code" size={12} />
                      {t('chat.agentTypeBuild', 'Build')}
                    </button>
                  </div>
                )}
                <ProviderDropdown />
                <ModelDropdown />
                <ReasoningDropdown />
                <SkillDropdown />
              </div>
              {mode === 'Architect' && (
              <button
                type="button"
                onClick={() => void handleGenerateStrategy()}
                data-tour-id="architect-generate-strategy"
                disabled={
                  isModeProjectWorkspaceMissing ||
                  !activeArchitectPlanId ||
                  isConversationPending ||
                  isBusySending ||
                  (!hasExistingStrategy && activePlanNeedsCount === 0)
                }
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-medium border transition-colors',
                  isModeProjectWorkspaceMissing ||
                  !activeArchitectPlanId ||
                    isConversationPending ||
                    isBusySending ||
                    (!hasExistingStrategy && activePlanNeedsCount === 0)
                      ? 'border-border text-muted-foreground bg-card/40 cursor-not-allowed'
                      : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground'
                  )}
                  title={
                    isModeProjectWorkspaceMissing
                      ? workspaceState.kind === 'noProjectAvailable'
                        ? t('project.emptyWorkspaceTitle', 'Ajoutez un projet pour commencer avec Macro.')
                        : t('project.noProjectSelectedTitle', 'Sélectionnez un projet pour continuer.')
                      : !activeArchitectPlanId
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

            {selectedTask && isSelectedTaskDependencyBlocked && currentMessages.length === 0 && (
              <TaskBlockedState
                variant="compact"
                title={t('implement.taskBlockedTitle', 'Task blocked')}
                message={selectedTaskBlockedMessage}
              />
            )}

            {selectedTask && !isSelectedTaskDependencyBlocked && selectedTaskRequiresKickoff && currentMessages.length === 0 && (
              <div className="rounded-xl border border-border bg-card/70 p-3 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-foreground">
                      {t('implement.executionBrief', 'Task briefing')}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {selectedTask.description || t('implement.noTaskDescription', 'No task description provided.')}
                    </p>
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/70 bg-background/40 px-2 py-0.5 font-semibold text-muted-foreground">
                        <Icon name="git-branch" size={10} className="shrink-0" />
                        {selectedTask.branch_name}
                      </span>
                      <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/70 bg-background/40 px-2 py-0.5 font-semibold text-muted-foreground">
                        <Icon name="folder" size={10} className="shrink-0" />
                        <span className="truncate">{selectedTaskProjectSummary}</span>
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleStartExecution({
                      notesOverride: composerEditorRef.current?.getTextContent() ?? '',
                    }).catch(() => undefined)}
                    data-tour-id="implement-start-execution"
                    disabled={!canStartImplementExecution || !selectedProviderId || !selectedModelId || isBusySending}
                    title={
                      !runtimeCapabilities.implementExecution
                        ? t(
                            'implement.remoteExecutionUnavailable',
                            'Implementation actions are unavailable in remote mode.'
                          )
                        : undefined
                    }
                    className={cn(
                      'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors shrink-0',
                      canStartImplementExecution && selectedProviderId && selectedModelId && !isBusySending
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'bg-muted text-muted-foreground cursor-not-allowed'
                    )}
                  >
                    <Icon name="play" size={14} />
                    {t('implement.startExecution', 'Start execution')}
                  </button>
                </div>
              </div>
            )}

            {composerError && (
              <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {composerError}
              </div>
            )}

            {showSkillNativeToolWarning && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <Icon name="triangle-alert" size={14} className="mt-0.5 shrink-0" />
                <span>
                  {t(
                    'skills.nativeToolRequiredWarning',
                    'Skills require a native tool-calling model/provider.'
                  )}
                </span>
              </div>
            )}

            {activePendingToolApproval ? (
              <ToolApprovalFooter
                pendingApproval={activePendingToolApproval}
                onAllowOnce={() =>
                  approvePendingToolApprovalOnce(
                    activePendingToolApproval.conversationId,
                  )
                }
                onAllowForConversation={() =>
                  approvePendingToolApprovalForConversation(
                    activePendingToolApproval.conversationId,
                  )
                }
                onDeny={(reason) =>
                  denyPendingToolApproval(
                    activePendingToolApproval.conversationId,
                    reason,
                  )
                }
              />
            ) : activeQuestionnaire ? (
              <QuestionnaireFooter
                activeQuestionnaire={activeQuestionnaire}
                draftText={activeQuestionnaireDraftText}
                selectedChoice={activeQuestionnaireSelectedChoice}
                submitValue={activeQuestionnaireSubmitValue}
                hasPreviousStep={activeQuestionnaireHasPreviousStep}
                hasNextStep={activeQuestionnaireHasNextStep}
                isBusySending={isBusySending}
                onAnswer={handleQuestionnaireAnswer}
                onSubmit={handleQuestionnaireSubmit}
                onStepChange={handleQuestionnaireStepChange}
                onDraftTextChange={(value) =>
                  setActiveQuestionnaireDraftText(
                    activeQuestionnaire.conversationId,
                    value,
                  )
                }
                onCancel={handleQuestionnaireCancel}
              />
            ) : (
              <div
                className="flex items-center gap-2 bg-card/80 border border-border rounded-xl px-2 py-1.5"
                onPasteCapture={handleComposerPaste}
                data-tour-id="chat-composer"
              >
                <Suspense fallback={<ComposerFallbackStatus />}>
                  <LazyComposerEditor
                    ref={composerEditorRef}
                    editable={!isBusySending && !!selectedProviderId && !!selectedModelId && !isComposerDisabled}
                    placeholder={
                      isConversationPending
                        ? t('chat.loadingConversation', 'Restoring conversation...')
                      : isModeProjectWorkspaceMissing
                        ? workspaceState.kind === 'noProjectAvailable'
                          ? t('project.emptyWorkspaceTitle', 'Ajoutez un projet pour commencer avec Macro.')
                          : t('project.noProjectSelectedTitle', 'Sélectionnez un projet pour continuer.')
                      : isArchitectPlanSelectionMissing
                        ? t(
                            'architect.selectPlanToStart',
                            'Select or create a plan to start architecting.'
                          )
                      : isImplementTaskSelectionMissing
                        ? t('implement.selectTaskToStart', 'Select a task to start implementation.')
                      : isSelectedTaskDependencyBlocked
                        ? t(
                            'implement.taskBlockedComposerPlaceholder',
                            'Task blocked until prerequisites are completed'
                          )
                      : isImplementComposerInKickoffMode
                        ? t('implement.executionNotesPlaceholder', 'Optional guidance for this task kickoff')
                        : !selectedProviderId || !selectedModelId
                        ? t('chat.selectProvider')
                        : t('chat.typeMessage')
                    }
                    onTextChange={(text) => {
                      if (composerError) {
                        clearConversationRuntimeError(selectedConversationId ?? '');
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
                  data-tour-id="chat-send-button"
                  disabled={isBusySending || !canSend || !selectedProviderId || !selectedModelId || isComposerDisabled}
                  className={cn(
                    'rounded-lg px-3 h-9 flex items-center transition-colors',
                    isBusySending || !canSend || !selectedProviderId || !selectedModelId || isComposerDisabled
                      ? 'bg-muted text-muted-foreground cursor-not-allowed'
                      : 'bg-primary hover:bg-primary/90 text-primary-foreground'
                  )}
                >
                  {isBusySending ? (
                    <SpinnerIcon size={14} />
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

      <AgentCodeReplayConfirmModal
        pendingReplayConfirmation={pendingReplayConfirmation}
        isSubmitting={isReplayConfirmationSubmitting}
        onCancel={cancelReplayConfirmation}
        onConfirm={() => {
          void confirmReplayConfirmation();
        }}
      />

      <ImagePreviewModal
        isOpen={Boolean(previewImage)}
        image={previewImage}
        onClose={() => setPreviewImage(null)}
      />

      {mode === 'Architect' &&
        architectPlanNamingRecovery?.stage === 'choice' && (
          <ArchitectPlanNamingRecoveryModal
            title={t(
              'architect.planNamingRecovery.title',
              'Plan name still needed'
            )}
            description={t(
              'architect.planNamingRecovery.description',
              'Macro could not generate a plan name from the first message after three attempts. Retry with AI or name the plan manually.'
            )}
            retryLabel={t('architect.planNamingRecovery.retryAi', 'Retry AI')}
            manualLabel={t(
              'architect.planNamingRecovery.nameManually',
              'Name manually'
            )}
            retryingLabel={t(
              'architect.planNamingRecovery.retryingAi',
              'Retrying AI...'
            )}
            error={architectPlanNamingRecovery.error}
            isLoading={architectPlanNamingRecovery.isSubmitting}
            onRetry={() => {
              void retryArchitectPlanNamingRecovery();
            }}
            onManual={() => setArchitectPlanNamingRecoveryStage('manual')}
          />
        )}

      {mode === 'Architect' &&
        architectPlanNamingRecovery?.stage === 'manual' && (
          <PlanFormModal
            initialValue=""
            isCanonicalPlan
            title={t(
              'architect.planNamingRecovery.manualTitle',
              'Name This Plan'
            )}
            description={t(
              'architect.planNamingRecovery.manualDescription',
              'Enter the plan name you want to use for this conversation.'
            )}
            confirmLabel={t(
              'architect.planNamingRecovery.saveManualName',
              'Save plan name'
            )}
            cancelLabel={t('architect.planNamingRecovery.back', 'Back')}
            requireValue
            placeholder={t(
              'architect.planNamingRecovery.manualPlaceholder',
              'e.g. Checkout Recovery Refresh'
            )}
            isLoading={architectPlanNamingRecovery.isSubmitting}
            error={architectPlanNamingRecovery.error}
            onConfirm={(value) => {
              void submitArchitectPlanManualName(value);
            }}
            onClose={() => setArchitectPlanNamingRecoveryStage('choice')}
          />
        )}
    </main>
  );
};

// Performance: Memoize to prevent re-renders when parent updates
const MemoizedChatZone = React.memo(ChatZone);

// Export both named and default for lazy loading compatibility
export default MemoizedChatZone;
