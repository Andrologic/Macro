import React, {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useConversationGoalStore } from '../../stores/useConversationGoalStore';
import { useConversationArchiveStore } from '../../stores/useConversationArchiveStore';
import { ActionableErrorCallout } from '../shared/ActionableErrorCallout';
import { presentServiceError } from '../../services/degradedErrorPresentation';
import type {
  ManualCompactionResult,
  ManualCompactionSkipReason,
  MessageImageAttachment,
} from '../../stores/useChatStore';
import { useSkillsStore } from '../../stores/useSkillsStore';
import type {
  ChatMessage,
  ContextReference,
  PersistedContextReference,
  PlanNode,
  PredictedBranch,
  SkillManifest,
  SkillTurnFeedback,
  WorkspaceFileReference,
} from '../../types';
import { useProviderStore } from '../../stores/useProviderStore';
import { useSpeechToTextStore } from '../../stores/useSpeechToTextStore';
import { useShortcutsStore } from '../../stores/useShortcutsStore';
import { formatBindingForDisplay } from '../../shortcuts/utils';
import { useTaskStore } from '../../stores/useTaskStore';
import { Icon, type IconName } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';
import { cn } from '../../utils/cn';
import { ProviderDropdown } from '../ai/ProviderDropdown';
import { ModelDropdown } from '../ai/ModelDropdown';
import { ReasoningDropdown } from '../ai/ReasoningDropdown';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useScrollMagnet } from '../../hooks/useScrollMagnet';
import { useSpeechDictation } from '../../hooks/useSpeechDictation';
import { ScrollSeparator } from './ScrollSeparator';
import { SpeechDictationButton } from './SpeechDictationButton';
import { SpeechRecordingBar } from './SpeechRecordingBar';
import {
  locateSpeechComposerInsertion,
  replaceSpeechComposerInsertion,
  type SpeechComposerInsertion,
} from './speechComposerText';
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
import { isArchitectPlanStrategyMutationLocked } from '../../services/architectPlanService';
import { getArchitectPlanPrimaryName } from '../../services/architectPlanPresentation';
import { resolveActiveConversationQuestionnaire } from '../../services/chatQuestionnaires';
import { getServiceRuntimeCapabilities } from '../../services';
import {
  clearConflictAssistantInternalAgentProfile,
  getConflictAssistantInternalAgentProfile,
} from '../../services/conflictAssistantService';
import { useVirtualMessages } from '../../hooks/useVirtualList';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import LazyComposerEditor, { type ComposerEditorHandle } from './composer/LazyComposerEditor';
import {
  ARCHITECT_PLAN_SELECTOR_STATE_EVENT,
  dispatchArchitectPlanSelectorRequest,
  requestArchitectPlanSelectorState,
  type ArchitectPlanSelectorStateDetail,
} from '../architect/planSelectorEvents';
import { ProjectWorkspaceEmptyState } from '../shared/ProjectWorkspaceEmptyState';
import { getPlanNodeTodoState } from '../../services/planNodeTodos';
import { TaskArtifactsButton } from '../implement/TaskArtifactsButton';
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
import { useAgentCodeReplayConfirmation } from './useAgentCodeReplayConfirmation';
import { notify } from '../ui/toastService';
import { toServiceError } from '../../services/contracts/errors';
import { parseConversationGoalCommand } from '../../services/conversationGoalCommand';

const ConversationGoalBanner = React.lazy(() =>
  import('./ConversationGoalBanner').then((module) => ({
    default: module.ConversationGoalBanner,
  })),
);
const QuestionnaireFooter = React.lazy(() =>
  import('./QuestionnaireFooter').then((module) => ({ default: module.QuestionnaireFooter })),
);
const ToolApprovalFooter = React.lazy(() =>
  import('./ToolApprovalFooter').then((module) => ({ default: module.ToolApprovalFooter })),
);
const QuestionnaireResponseSummary = React.lazy(() =>
  import('./QuestionnaireResponseSummary').then((module) => ({
    default: module.QuestionnaireResponseSummary,
  })),
);
const ImplementTaskTodoDropdown = React.lazy(() =>
  import('./ImplementTaskTodoDropdown').then((module) => ({
    default: module.ImplementTaskTodoDropdown,
  })),
);
const ContextWindowIndicator = React.lazy(() =>
  import('./ContextWindowIndicator').then((module) => ({
    default: module.ContextWindowIndicator,
  })),
);
const AgentCodeReplayConfirmModal = React.lazy(() =>
  import('./AgentCodeReplayConfirmModal').then((module) => ({
    default: module.AgentCodeReplayConfirmModal,
  })),
);
const ImagePreviewModal = React.lazy(() =>
  import('../modals/ImagePreviewModal').then((module) => ({
    default: module.ImagePreviewModal,
  })),
);
const ArchitectPlanNamingRecoveryModal = React.lazy(() =>
  import('../architect/ArchitectPlanNamingRecoveryModal').then((module) => ({
    default: module.ArchitectPlanNamingRecoveryModal,
  })),
);
const PlanFormModal = React.lazy(() =>
  import('../architect/PlanFormModal').then((module) => ({
    default: module.PlanFormModal,
  })),
);

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

type ManualCompactionPhase = 'idle' | 'analyzing';
type ArchitectStrategyProgressAction = 'generate-strategy' | 'regenerate-strategy';
interface ArchitectToolbarButton {
  icon: IconName;
  label: string;
  title: string;
}
interface ArchitectButtonAction extends ArchitectToolbarButton {
  id: ArchitectStrategyProgressAction;
  fullPrompt: string;
  displayDescription: string;
}
const MANUAL_COMPACTION_RETAINED_USER_TURNS = 2;

type ChatTranslation = ReturnType<typeof useTranslation>['t'];

const normalizeArchitectActionPrompt = (value: string): string =>
  value.trim().replace(/\s+/g, ' ');

const buildArchitectButtonActions = (t: ChatTranslation): Record<
  ArchitectStrategyProgressAction,
  ArchitectButtonAction
> => ({
  'generate-strategy': {
    id: 'generate-strategy',
    icon: 'sparkles',
    label: t('architect.generateStrategy', 'Generate Strategy'),
    title: t(
      'architect.generateStrategyHint',
      'Generate strategy from the plan conversation and project context'
    ),
    displayDescription: t(
      'architect.generateStrategyHint',
      'Generate strategy from the plan conversation and project context'
    ),
    fullPrompt: `User explicitly requested to generate the strategy now. Use the plan conversation, the user's expressed intent, the plan scope, selected projects, inspected code context, and answers gathered with the \`question\` tool when clarification is necessary. Call \`strategy_generate\` with a complete initial strategy (full nodes and dependencies). ${ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX}`,
  },
  'regenerate-strategy': {
    id: 'regenerate-strategy',
    icon: 'refresh-cw',
    label: t('architect.regenerateStrategy', 'Regenerate Strategy'),
    title: t(
      'architect.regenerateStrategyHint',
      'Regenerate strategy from the plan conversation and project context'
    ),
    displayDescription: t(
      'architect.regenerateStrategyHint',
      'Regenerate strategy from the plan conversation and project context'
    ),
    fullPrompt: `User explicitly requested to regenerate the strategy. Reassess the full plan conversation, the user's expressed intent, the plan scope, selected projects, inspected code context, and answers gathered with the \`question\` tool when clarification is necessary. Call \`strategy_generate\` with a complete replacement strategy (full nodes and dependencies). ${ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX}`,
  },
});

const resolveArchitectButtonActionFromContent = (
  content: string,
  t: ChatTranslation,
): ArchitectButtonAction | null => {
  const actions = buildArchitectButtonActions(t);
  const normalizedContent = normalizeArchitectActionPrompt(content);
  const exactMatch = Object.values(actions).find(
    (action) => normalizeArchitectActionPrompt(action.fullPrompt) === normalizedContent,
  );
  if (exactMatch) return exactMatch;

  return null;
};

const formatManualCompactionTokens = (value: number): string => {
  const rounded = Math.max(0, Math.round(value));
  if (rounded >= 1000) return `${Math.round(rounded / 1000).toLocaleString()}k`;
  return rounded.toLocaleString();
};

const getManualCompactionSkipDescription = (
  reason: ManualCompactionSkipReason,
  result: Extract<ManualCompactionResult, { outcome: 'skipped' }>,
  t: ReturnType<typeof useTranslation>['t'],
): string => {
  switch (reason) {
    case 'not_enough_history':
      return t(
        'chat.manualCompaction.skipNotEnoughHistory',
        "Macro keeps the last {{count}} user turns; this conversation does not have enough older history to replace yet.",
        { count: result.retainedTurnCount },
      );
    case 'already_current':
      return t(
        'chat.manualCompaction.skipAlreadyCurrent',
        'The existing checkpoint already covers the useful older turns for this context.',
      );
    case 'not_beneficial':
      return t(
        'chat.manualCompaction.skipNotBeneficial',
        'The estimated summary would not have reduced the payload sent to the provider.',
      );
    case 'below_threshold':
    default:
      return t(
        'chat.manualCompaction.skipBelowThreshold',
        'Context is still light; creating a summary now would mostly add noise.',
      );
  }
};

const ComposerFallbackStatus: React.FC = () => (
  <div className="sr-only" aria-live="polite">
    Loading composer
  </div>
);

const EMPTY_RENDER_MESSAGES: ChatMessage[] = [];
const CHAT_TRANSCRIPT_ITEM_GAP = 24;
const CHAT_ARCHITECT_ACTION_ITEM_GAP_REDUCTION = 16;
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
  messageImages: MessageImageAttachment[];
  isCopied: boolean;
  isHighlighted: boolean;
  onImageMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  onOpenImagePreview: (
    event: React.MouseEvent<HTMLElement>,
    image: MessageImageAttachment
  ) => void;
  onEditCancel: () => void;
  onCopy: (content: string, messageId: string) => Promise<void>;
  onEditStart: (message: ChatMessage) => void;
  onRegenerate: (messageId: string, content: string) => Promise<void>;
  skillTurnFeedback?: SkillTurnFeedback | null;
}

const USER_CONTEXT_MENTION_PATTERN = /\[(skill|file|source):\s*([^\]]+)\]/gi;

interface SavedComposerDraft {
  savedDraftText: string;
  savedDraftImages: MessageImageAttachment[];
  savedDraftContextRefs: ContextReference[];
}

interface ComposerEditSession extends SavedComposerDraft {
  messageId: string;
  originalContent: string;
}

interface GoalComposerEditSession extends SavedComposerDraft {
  conversationId: string;
  goalId: string;
}

interface ComposerDraftSnapshot {
  text: string;
  contextRefs: ContextReference[];
}

type PromptHistoryEntry = ComposerDraftSnapshot;

const EMPTY_COMPOSER_DRAFT_SNAPSHOT: ComposerDraftSnapshot = {
  text: '',
  contextRefs: [],
};

const buildSnapshotContextRefData = (
  ref: PersistedContextReference,
): ContextReference['data'] => {
  if (ref.kind === 'skill') {
    return {
      id: ref.id,
      name: ref.title,
      description: '',
      rootPath: ref.source?.rootPath ?? ref.skillFilePath ?? ref.id,
      skillFilePath: ref.skillFilePath ?? null,
      location: ref.location,
      source: ref.source ?? {
        kind: 'global',
        namespace: 'agents',
        projectId: null,
        projectName: null,
        rootPath: ref.skillFilePath ?? ref.id,
      },
      resources: [],
      scripts: [],
      contentHash: ref.contentHash,
      validationErrors: [],
      isValid: true,
    } satisfies SkillManifest;
  }

  if (ref.kind === 'file') {
    return {
      id: ref.id,
      path: ref.path ?? ref.id,
      relativePath: ref.relativePath ?? ref.title,
      projectId: ref.projectId ?? null,
      projectName: ref.projectName ?? null,
    } satisfies WorkspaceFileReference;
  }

  if (ref.kind === 'source') {
    return {
      id: ref.id,
      type: 'source_passage',
      scope: 'source',
      source: ref.sourceLabel ?? ref.subtitle ?? ref.title,
      title: ref.title,
      snippet: ref.snippet,
      content: ref.snippet,
      messageId: '',
      conversationId: '',
      timestamp: '',
      url: ref.url,
    };
  }

  if (ref.kind === 'plan-node') {
    return {
      id: ref.id,
      title: ref.title,
      type: 'task',
      status: 'pending',
      dependencies: [],
    } satisfies PlanNode;
  }

  return {
    id: ref.id,
    name: ref.title,
    color: '#8b8f98',
    parentBranch: null,
    projectId: ref.projectId ?? '',
    taskIds: [],
    status: 'pending',
  } satisfies PredictedBranch;
};

const cloneContextRefs = (
  refs: readonly (ContextReference | PersistedContextReference)[] | null | undefined
): ContextReference[] =>
  refs
    ? refs.map((ref) => ({
        id: ref.id,
        kind: ref.kind,
        title: ref.title,
        subtitle: ref.subtitle,
        data: 'data' in ref ? ref.data : buildSnapshotContextRefData(ref),
      }))
    : [];

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

const UserMessageContent: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.split('\n');

  return (
    <div data-user-message-content="true" className="break-words leading-[1.35]">
      {lines.map((line, lineIndex) => {
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        const contextMentionPattern = new RegExp(USER_CONTEXT_MENTION_PATTERN);

        while ((match = contextMentionPattern.exec(line)) !== null) {
          if (match.index > lastIndex) {
            parts.push(line.slice(lastIndex, match.index));
          }

          const rawKind = match[1]?.toLocaleLowerCase();
          const kind = rawKind === 'file'
            ? 'file'
            : rawKind === 'source'
            ? 'source'
            : 'skill';
          const title = match[2]?.trim() ?? '';
          parts.push(
            <ContextReferenceChip
              key={`${lineIndex}-${match.index}-${title}`}
              kind={kind}
              title={title}
              surface="message"
            />
          );
          lastIndex = match.index + match[0].length;
        }

        if (lastIndex < line.length) {
          parts.push(line.slice(lastIndex));
        }

        return (
          <React.Fragment key={lineIndex}>
            {parts.length > 0 ? parts : line}
            {lineIndex < lines.length - 1 && <br />}
          </React.Fragment>
        );
      })}
    </div>
  );
};

const SkillTurnFeedbackRow: React.FC<{
  feedback?: SkillTurnFeedback | null;
}> = ({ feedback }) => {
  const { t } = useTranslation();
  if (!feedback || (feedback.loaded.length === 0 && feedback.warnings.length === 0)) {
    return null;
  }

  const loadedLabel =
    feedback.loaded.length === 1
      ? t('chat.skillFeedbackLoadedOne', '{{name}} loaded', {
          name: feedback.loaded[0]?.title ?? t('settings.skills', 'Skills'),
        })
      : t('chat.skillFeedbackLoadedMany', '{{count}} skills loaded', {
          count: feedback.loaded.length,
        });
  const primaryWarning = feedback.warnings[0];

  const handleAction = (action: SkillTurnFeedback['warnings'][number]['action']) => {
    if (action === 'open_settings') {
      useAppStore.getState().openSettings('skills');
      return;
    }
    if (action === 'refresh') {
      void useSkillsStore.getState().refreshSkills();
    }
  };

  return (
    <div
      data-testid="skill-turn-feedback"
      className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] leading-none text-muted-foreground/80"
    >
      {feedback.loaded.length > 0 && (
        <span
          className="inline-flex h-5 min-w-0 items-center gap-1 rounded-md border border-border/60 bg-background/35 px-1.5"
          title={feedback.loaded.map((item) => item.title).join(', ')}
        >
          <Icon name="sparkles" size={11} className="shrink-0 text-fuchsia-400" />
          <span className="truncate">{loadedLabel}</span>
        </span>
      )}
      {primaryWarning && (
        <span
          className="inline-flex h-5 min-w-0 items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 text-amber-700 dark:text-amber-300"
          title={feedback.warnings.map((item) => item.reason || item.title).join('\n')}
        >
          <Icon name="triangle-alert" size={11} className="shrink-0" />
          <span className="truncate">
            {primaryWarning.reason || t('chat.skillFeedbackBlocked', 'Skill context blocked')}
          </span>
          {primaryWarning.action && (
            <button
              type="button"
              onClick={() => handleAction(primaryWarning.action)}
              className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-current/80 transition-colors hover:bg-background/40 hover:text-current"
              title={
                primaryWarning.action === 'refresh'
                  ? t('common.refresh', 'Refresh')
                  : t('skills.openSettings', 'Open Settings')
              }
              aria-label={
                primaryWarning.action === 'refresh'
                  ? t('common.refresh', 'Refresh')
                  : t('skills.openSettings', 'Open Settings')
              }
            >
              <Icon
                name={primaryWarning.action === 'refresh' ? 'refresh-cw' : 'settings'}
                size={10}
              />
            </button>
          )}
        </span>
      )}
    </div>
  );
};

const ArchitectActionMessage: React.FC<{ action: ArchitectButtonAction }> = ({ action }) => (
  <div
    data-testid="architect-action-message"
    data-architect-action-id={action.id}
    className="flex w-full items-center gap-3 py-0.5 text-xs text-muted-foreground"
  >
    <span className="h-px min-w-4 flex-1 bg-border/60" aria-hidden="true" />
    <span className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-full border border-border/70 bg-background px-2.5 py-1.5 shadow-sm">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon name={action.icon} size={12} />
      </span>
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground/90">{action.label}</span>
        <span className="mx-1.5 text-muted-foreground/45">·</span>
        <span className="text-muted-foreground">{action.displayDescription}</span>
      </span>
    </span>
    <span className="h-px min-w-4 flex-1 bg-border/60" aria-hidden="true" />
  </div>
);

const ChatMessageRowBase: React.FC<ChatMessageRowProps> = ({
  virtualMessage,
  measureElement,
  assistantActivity,
  showToolTraces,
  isEditing,
  messageImages,
  isCopied,
  isHighlighted,
  onImageMouseDown,
  onOpenImagePreview,
  onEditCancel,
  onCopy,
  onEditStart,
  onRegenerate,
  skillTurnFeedback,
}) => {
  const { t } = useTranslation();
  const message = virtualMessage.item.message;
  const questionnaireResponseSummary = message.questionnaire_response_summary;
  const isQuestionnaireResponseMessage = Boolean(questionnaireResponseSummary);
  const architectActionMessage =
    message.role === 'user'
      ? resolveArchitectButtonActionFromContent(message.content, t)
      : null;
  const isArchitectActionMessage = Boolean(architectActionMessage);
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
            ? isArchitectActionMessage
              ? 'mx-auto max-w-2xl'
              : 'ml-auto mr-0 max-w-lg'
            : 'mr-auto ml-0 max-w-none'
        )}
      >
        <div
          className={cn(
            'relative rounded-lg group',
            message.role === 'user'
              ? isQuestionnaireResponseMessage || isArchitectActionMessage
                ? 'bg-transparent border-0'
                : 'bg-muted/80 border border-border/50'
              : 'bg-transparent border-0',
            isEditing
              ? 'p-2'
              : message.role === 'assistant'
                ? hasAssistantCompletionNotice
                  ? 'p-2 pb-10'
                  : 'p-2 pb-6'
                : isArchitectActionMessage
                  ? 'p-0'
                : 'p-2 pb-9'
          )}
        >
          {isEditing ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon name="edit" size={12} className="shrink-0 text-muted-foreground/80" />
              <span className="min-w-0 flex-1 truncate">
                {t(
                  'chat.messageEditingInComposer',
                  'Editing in composer'
                )}
              </span>
              <button
                type="button"
                onClick={onEditCancel}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t('common.cancel')}
                aria-label={t('common.cancel')}
              >
                {t('common.cancel')}
              </button>
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
              ) : architectActionMessage ? (
                <ArchitectActionMessage action={architectActionMessage} />
              ) : questionnaireResponseSummary ? (
                <Suspense fallback={null}>
                  <QuestionnaireResponseSummary summary={questionnaireResponseSummary} />
                </Suspense>
              ) : (
                <UserMessageContent content={message.content} />
              )}
              {message.role === 'user' && !questionnaireResponseSummary && !architectActionMessage && (
                <SkillTurnFeedbackRow feedback={skillTurnFeedback} />
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

          {message.role === 'user' && !isEditing && !architectActionMessage && (
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
    prev.messageImages === next.messageImages &&
    prev.isCopied === next.isCopied &&
    prev.isHighlighted === next.isHighlighted &&
    prev.assistantActivity === next.assistantActivity &&
    prev.showToolTraces === next.showToolTraces &&
    prev.skillTurnFeedback === next.skillTurnFeedback
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
    standaloneProjects,
    projectGroups,
    getProjectById,
    activeArchitectPlanId,
    activePlanContext,
    planNodes,
    predictedBranches,
    openProjectModal,
    setLeftPanelOpen,
  } = useAppStore(useShallow((state) => ({
    mode: state.mode,
    agentType: state.agentType,
    setAgentType: state.setAgentType,
    selectedGroupId: state.selectedGroupId,
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    standaloneProjects: state.standaloneProjects ?? [],
    projectGroups: state.projectGroups,
    getProjectById: state.getProjectById,
    activeArchitectPlanId: state.activeArchitectPlanId,
    activePlanContext: state.activePlanContext,
    planNodes: state.planNodes,
    predictedBranches: state.predictedBranches,
    openProjectModal: state.openProjectModal,
    setLeftPanelOpen: state.setLeftPanelOpen,
  })));
  const {
    conversations,
    messages,
    selectedConversationId,
    activeContextKey,
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
    submitDuringActiveTurn = async () => 'steered' as const,
    clearLastError,
    clearConversationRuntimeError,
    editMessage,
    getAgentCodeReplayPreview,
    restoreAgentCodeForReplay,
    rollbackPendingAgentCodeReplay,
    getMessageImages,
    setMessageImages,
    architectPlanNamingRecovery,
    setArchitectPlanNamingRecoveryStage,
    retryArchitectPlanNamingRecovery,
    submitArchitectPlanManualName,
    composerContextRefs,
    skillTurnFeedbackByMessageId,
    addComposerContextRef,
    clearComposerContextRefs,
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
    peekComposerDraft,
    acknowledgeComposerDraft,
    saveComposerDraftForContext = () => undefined,
    getComposerDraftForContext = () => null,
    clearComposerDraftForContext = () => undefined,
    migrateComposerDraftContext = () => undefined,
    replaceComposerContextRefs = () => undefined,
  } = useChatStore(useShallow((state) => ({
    conversations: state.conversations,
    messages: state.messages,
    selectedConversationId: state.selectedConversationId,
    activeContextKey: state.activeContextKey,
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
    submitDuringActiveTurn: state.submitDuringActiveTurn,
    clearLastError: state.clearLastError,
    clearConversationRuntimeError: state.clearConversationRuntimeError,
    editMessage: state.editMessage,
    getAgentCodeReplayPreview: state.getAgentCodeReplayPreview,
    restoreAgentCodeForReplay: state.restoreAgentCodeForReplay,
    rollbackPendingAgentCodeReplay: state.rollbackPendingAgentCodeReplay,
    getMessageImages: state.getMessageImages,
    setMessageImages: state.setMessageImages,
    architectPlanNamingRecovery: state.architectPlanNamingRecovery,
    setArchitectPlanNamingRecoveryStage:
      state.setArchitectPlanNamingRecoveryStage,
    retryArchitectPlanNamingRecovery: state.retryArchitectPlanNamingRecovery,
    submitArchitectPlanManualName: state.submitArchitectPlanManualName,
    composerContextRefs: state.composerContextRefs,
    skillTurnFeedbackByMessageId: state.skillTurnFeedbackByMessageId,
    addComposerContextRef: state.addComposerContextRef,
    clearComposerContextRefs: state.clearComposerContextRefs,
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
    peekComposerDraft: state.peekComposerDraft,
    acknowledgeComposerDraft: state.acknowledgeComposerDraft,
    saveComposerDraftForContext: state.saveComposerDraftForContext,
    getComposerDraftForContext: state.getComposerDraftForContext,
    clearComposerDraftForContext: state.clearComposerDraftForContext,
    migrateComposerDraftContext: state.migrateComposerDraftContext,
    replaceComposerContextRefs: state.replaceComposerContextRefs,
  })));
  const { mark: markPerformance } = usePerformanceMonitor();

  const { selectedProviderId, selectedModelId, selectedReasoningEffort, nativeToolsSupported } = useProviderStore(useShallow((state) => ({
    selectedProviderId: state.selectedProviderId,
    selectedModelId: state.selectedModelId,
    selectedReasoningEffort: state.selectedReasoningEffort,
    nativeToolsSupported: state.selectedSupportsNativeToolCalling(),
  })));
  const {
    activeConversationGoal,
    activateConversationGoal,
    beginConversationGoalEdit,
    settleConversationGoalEdit,
    setConversationGoalStatus,
    clearConversationGoal,
  } = useConversationGoalStore(useShallow((state) => ({
    activeConversationGoal: selectedConversationId
      ? state.goalsByConversationId[selectedConversationId] ?? null
      : null,
    activateConversationGoal: state.activateGoal,
    beginConversationGoalEdit: state.beginGoalEdit,
    settleConversationGoalEdit: state.settleGoalEdit,
    setConversationGoalStatus: state.setOperationalStatus,
    clearConversationGoal: state.clearGoal,
  })));
  const promptHistoryNavigationMode = useShortcutsStore((state) => state.promptHistoryNavigationMode);
  const activeTurnSendBehavior = useShortcutsStore((state) => state.activeTurnSendBehavior ?? 'steer');
  const secondarySendBinding = useShortcutsStore(
    (state) => state.bindings ? state.bindings['chat.secondarySend'] : 'Mod+Enter',
  );
  const speechLanguage = useSpeechToTextStore((state) => state.language);
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
  const [composerEditSession, setComposerEditSession] =
    useState<ComposerEditSession | null>(null);
  const [goalComposerEditSession, setGoalComposerEditSession] =
    useState<GoalComposerEditSession | null>(null);
  const goalComposerEditSessionRef = useRef<GoalComposerEditSession | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [composerImages, setComposerImages] = useState<MessageImageAttachment[]>([]);
  const [manualCompactionPhase, setManualCompactionPhase] =
    useState<ManualCompactionPhase>('idle');
  const [manualCompactionFeedback, setManualCompactionFeedback] =
    useState<ManualCompactionResult | null>(null);

  // Lexical composer ref
  const composerEditorRef = useRef<ComposerEditorHandle>(null);
  const pendingSpeechInsertionRef = useRef<SpeechComposerInsertion | null>(null);
  const contextRefreshInFlightRef = useRef(false);
  const wasContextStreamingRef = useRef(false);
  const standaloneTaskBuildResetRef = useRef<string | null>(null);

  const [previewImage, setPreviewImage] = useState<MessageImageAttachment | null>(null);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState<number | null>(null);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState<ComposerDraftSnapshot>(
    EMPTY_COMPOSER_DRAFT_SNAPSHOT
  );
  const pendingPromptHistoryTextRef = useRef<string | null>(null);
  const composerDraftContextKey = selectedConversationId
    ? `conversation:${selectedConversationId}`
    : activeContextKey
      ? `context:${activeContextKey}`
      : `mode:${mode}`;
  useEffect(() => {
    pendingSpeechInsertionRef.current = null;
  }, [composerDraftContextKey]);
  const activeComposerDraftContextKeyRef = useRef<string | null>(null);
  const renderedComposerDraftContextKeyRef = useRef(composerDraftContextKey);
  const latestComposerDraftRef = useRef({
    text: '',
    images: [] as MessageImageAttachment[],
    contextRefs: [] as ContextReference[],
  });
  const [isTaskTodoDropdownOpen, setIsTaskTodoDropdownOpen] = useState(false);
  const [
    architectPlanSelectorState,
    setArchitectPlanSelectorState,
  ] = useState<ArchitectPlanSelectorStateDetail | null>(null);
  const missingArchitectPlanActionRef = useRef<HTMLButtonElement | null>(null);
  const taskTodoDropdownRef = useRef<HTMLDivElement | null>(null);
  const currentMessages = useMemo(
    () =>
      selectedConversationId
        ? messagesByConversationId[selectedConversationId] ??
          messages.filter((message) => message.conversation_id === selectedConversationId)
        : EMPTY_RENDER_MESSAGES,
    [messages, messagesByConversationId, selectedConversationId]
  );

  useEffect(() => {
    if (
      mode !== 'Implement' ||
      !selectedTask ||
      selectedTask.task_source !== 'standalone'
    ) {
      if (selectedTask?.task_source !== 'standalone') {
        standaloneTaskBuildResetRef.current = null;
      }
      return;
    }

    if (standaloneTaskBuildResetRef.current === selectedTask.id) {
      return;
    }

    standaloneTaskBuildResetRef.current = selectedTask.id;
    if (agentType !== 'build') {
      setAgentType('build');
    }
  }, [agentType, mode, selectedTask, setAgentType]);
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
  const isContextStreaming = selectedConversationRuntime.phase === 'streaming';
  const isPreparingSend = selectedConversationRuntime.phase === 'preparing';
  const isBusySending = isContextStreaming || isPreparingSend;
  const isManualCompacting = manualCompactionPhase !== 'idle';
  const isActiveContextCompacting = isRuntimeCompacting || isManualCompacting;
  const isContextOverflowRecovering =
    selectedConversationRuntime.phase === 'overflow_recovery';
  const runtimeAssistantMessageId =
    selectedConversationRuntime.assistantMessageId ?? null;
  const activeTranscriptCompactionPhase =
    isRuntimeCompacting
      ? activeCompactionPhase
      : null;
  const activeTranscriptProgressPhase = activeTranscriptCompactionPhase;
  const manualCompactionActivityLabel =
    manualCompactionPhase === 'analyzing' && !isRuntimeCompacting
      ? t('chat.manualCompaction.analyzing', 'Analyse du contexte...')
      : undefined;
  const manualCompactionDisabledReason = useMemo(() => {
    const userTurnCount = currentMessages.reduce(
      (count, message) => count + (message.role === 'user' ? 1 : 0),
      0,
    );

    if (userTurnCount <= MANUAL_COMPACTION_RETAINED_USER_TURNS) {
      return t(
        'chat.manualCompaction.disabledNotEnoughHistory',
        "Macro garde les {{count}} derniers tours utilisateur; ajoutez plus d'historique avant de compacter.",
        { count: MANUAL_COMPACTION_RETAINED_USER_TURNS },
      );
    }

    const footprint =
      contextDiagnostics?.footprintAfter ?? contextDiagnostics?.footprintBefore;
    const pressurePhase =
      contextDiagnostics?.phase === 'too_large' ||
      contextDiagnostics?.phase === 'needs_manual_compaction' ||
      contextDiagnostics?.phase === 'blocked';

    if (
      contextDiagnostics?.status === 'ready' &&
      footprint?.threshold === 'none' &&
      !pressurePhase
    ) {
      return t(
        'chat.manualCompaction.disabledBelowThreshold',
        'Le contexte est trop léger pour un compactage utile.',
      );
    }

    return null;
  }, [contextDiagnostics, currentMessages, t]);
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

  useEffect(() => {
    setManualCompactionFeedback(null);
    setManualCompactionPhase('idle');
  }, [selectedConversationId]);

  useEffect(() => {
    if (!selectedConversationId) return;
    let cancelled = false;

    // The LazyComposerEditor loads its underlying editor module
    // asynchronously. composerEditorRef.current may be null on the first
    // render. We peek (read) the draft without consuming it, then retry
    // until the editor is ready, and only then acknowledge (consume) it.
    const tryApplyDraft = (attemptsLeft: number) => {
      if (cancelled) return;
      const handle = composerEditorRef.current;
      const draft = peekComposerDraft(selectedConversationId);
      if (draft === null) {
        return;
      }
      if (handle) {
        handle.setText(draft);
        handle.focus();
        acknowledgeComposerDraft(selectedConversationId);
        return;
      }
      if (attemptsLeft <= 0) {
        // Editor never came up. Drop the draft so we don't leak it.
        acknowledgeComposerDraft(selectedConversationId);
        return;
      }
      window.setTimeout(() => tryApplyDraft(attemptsLeft - 1), 50);
    };

    tryApplyDraft(10);

    return () => {
      cancelled = true;
    };
  }, [selectedConversationId, peekComposerDraft, acknowledgeComposerDraft]);

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
    setManualCompactionPhase('analyzing');
    setManualCompactionFeedback(null);
    try {
      const result = await compactConversationNow(selectedConversationId);
      setManualCompactionFeedback(result);

      if (result.outcome === 'compacted') {
        notify.success(t('chat.manualCompaction.successTitle', 'Contexte compacté'), {
          description: t(
            'chat.manualCompaction.successDescription',
            '{{tokens}} tokens économisés. Le prochain message utilisera le checkpoint compacté.',
            { tokens: formatManualCompactionTokens(result.tokensSaved) },
          ),
        });
        await refreshConversationContextDiagnostics(selectedConversationId, {
          mode: 'full',
        });
      } else {
        notify.info(t('chat.manualCompaction.skippedTitle', 'Compactage ignoré'), {
          description: getManualCompactionSkipDescription(result.reason, result, t),
        });
      }
    } catch (error) {
      console.warn('Manual context compaction failed:', error);
      notify.error(t('chat.manualCompaction.errorTitle', 'Compactage impossible'), {
        description: toServiceError(error).message,
      });
    } finally {
      setManualCompactionPhase('idle');
    }
  }, [
    compactConversationNow,
    isBusySending,
    isManualCompacting,
    refreshConversationContextDiagnostics,
    selectedConversationId,
    t,
  ]);
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
      .map<PromptHistoryEntry>((message) => ({
        text: message.content.trim(),
        contextRefs: cloneContextRefs(message.context_refs),
      }))
      .filter((entry) => entry.text.length > 0);
  }, [currentMessages]);

  const resetPromptHistoryNavigation = useCallback(() => {
    pendingPromptHistoryTextRef.current = null;
    setPromptHistoryIndex(null);
    setDraftBeforeHistory(EMPTY_COMPOSER_DRAFT_SNAPSHOT);
  }, []);

  const findPromptHistoryIndexByText = useCallback((text: string): number | null => {
    for (let index = promptHistory.length - 1; index >= 0; index -= 1) {
      if (promptHistory[index]?.text === text) {
        return index;
      }
    }
    return null;
  }, [promptHistory]);

  const getComposerDraftSnapshot = useCallback((text: string): ComposerDraftSnapshot => ({
    text,
    contextRefs: cloneContextRefs(composerContextRefs),
  }), [composerContextRefs]);

  const applyComposerDraftSnapshot = useCallback((snapshot: ComposerDraftSnapshot) => {
    const currentText = composerEditorRef.current?.getTextContent() ?? inputValue;
    clearComposerContextRefs();
    if (currentText === snapshot.text) {
      pendingPromptHistoryTextRef.current = null;
      setInputValue(snapshot.text);
      snapshot.contextRefs.forEach((ref) => {
        addComposerContextRef(ref);
      });
      return;
    }
    pendingPromptHistoryTextRef.current = snapshot.text;
    setInputValue(snapshot.text);
    composerEditorRef.current?.setText(snapshot.text, snapshot.contextRefs);
    snapshot.contextRefs.forEach((ref) => {
      addComposerContextRef(ref);
    });
  }, [addComposerContextRef, clearComposerContextRefs, inputValue]);

  useLayoutEffect(() => {
    if (renderedComposerDraftContextKeyRef.current === composerDraftContextKey) return;
    renderedComposerDraftContextKeyRef.current = composerDraftContextKey;
    goalComposerEditSessionRef.current = null;
  }, [composerDraftContextKey]);

  useEffect(() => {
    const previousContextKey = activeComposerDraftContextKeyRef.current;
    if (previousContextKey === composerDraftContextKey) return;

    if (previousContextKey) {
      const draftToSave = composerEditSession
        ? {
            text: composerEditSession.savedDraftText,
            images: composerEditSession.savedDraftImages,
            contextRefs: composerEditSession.savedDraftContextRefs,
          }
        : goalComposerEditSession
          ? {
              text: goalComposerEditSession.savedDraftText,
              images: goalComposerEditSession.savedDraftImages,
              contextRefs: goalComposerEditSession.savedDraftContextRefs,
            }
        : latestComposerDraftRef.current;
      saveComposerDraftForContext(previousContextKey, draftToSave);
    }

    const savedNextDraft = getComposerDraftForContext(composerDraftContextKey);
    activeComposerDraftContextKeyRef.current = composerDraftContextKey;
    if (!previousContextKey && !savedNextDraft) {
      return;
    }
    const nextDraft = savedNextDraft ?? {
      text: '',
      images: [],
      contextRefs: [],
    };
    setComposerEditSession(null);
    goalComposerEditSessionRef.current = null;
    setGoalComposerEditSession(null);
    setInputValue(nextDraft.text);
    setComposerImages([...nextDraft.images]);
    // Conversation toolbox refs hydrate asynchronously after a selection.
    // Avoid replacing them with an empty draft before that hydration finishes.
    if (savedNextDraft) {
      replaceComposerContextRefs(
        nextDraft.contextRefs,
        selectedConversationId,
      );
    }
    resetPromptHistoryNavigation();

    let cancelled = false;
    const applyText = (attemptsLeft: number) => {
      if (cancelled) return;
      const editor = composerEditorRef.current;
      if (editor) {
        editor.setText(nextDraft.text, nextDraft.contextRefs);
        return;
      }
      if (attemptsLeft > 0) {
        window.setTimeout(() => applyText(attemptsLeft - 1), 50);
      }
    };
    applyText(10);
    return () => {
      cancelled = true;
    };
  }, [
    composerDraftContextKey,
    composerEditSession,
    goalComposerEditSession,
    getComposerDraftForContext,
    replaceComposerContextRefs,
    resetPromptHistoryNavigation,
    saveComposerDraftForContext,
    selectedConversationId,
  ]);

  useEffect(() => {
    latestComposerDraftRef.current = {
      text: inputValue,
      images: [...composerImages],
      contextRefs: cloneContextRefs(composerContextRefs),
    };
  }, [composerContextRefs, composerImages, inputValue]);

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
        [
          ...standaloneProjects,
          ...projectGroups.flatMap((group) => group.projects),
        ].map((project) => [project.id, project.name] as const)
      ),
    [projectGroups, standaloneProjects]
  );
  const projectRegistry = useMemo(
    () => ({ standaloneProjects, projectGroups }),
    [projectGroups, standaloneProjects]
  );
  const repositoryScopedProjectIds = useMemo(
    () => getRepositoryScopedProjectIds(projectRegistry, selectedGroupId, selectedProjectId),
    [projectRegistry, selectedGroupId, selectedProjectId]
  );
  const workspaceState = useMemo(
    () =>
      resolveProjectWorkspaceState({
        standaloneProjects,
        projectGroups,
        selectedGroupId,
        selectedProjectId,
      }),
    [projectGroups, selectedGroupId, selectedProjectId, standaloneProjects]
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
  const isSelectedConversationArchived = useConversationArchiveStore((state) =>
    mode === 'Chat' && selectedConversationId
      ? state.archivedConversationIds.has(selectedConversationId)
      : false
  );
  const isComposerDisabled =
    isConversationPending ||
    isModeProjectWorkspaceMissing ||
    isArchitectPlanSelectionMissing ||
    isImplementTaskSelectionMissing ||
    isSelectedTaskDependencyBlocked ||
    isSelectedConversationArchived ||
    Boolean(activeQuestionnaire) ||
    Boolean(activePendingToolApproval);
  const selectedGlobalProject = useMemo(
    () => getGlobalProjectById(projectGroups, selectedGroupId),
    [projectGroups, selectedGroupId]
  );
  const focusedProject = useMemo(
    () =>
      selectedGroupId
        ? getFocusedProjectForGroup(projectGroups, selectedGroupId, selectedProjectId)
        : selectedProjectId
          ? getProjectById(selectedProjectId) ?? null
          : null,
    [getProjectById, projectGroups, selectedGroupId, selectedProjectId]
  );
  const selectedGlobalProjectName = selectedGlobalProject?.name ?? null;
  const focusedProjectName = focusedProject?.name ?? null;
  const projectScopeLabel = useMemo(() => {
    if (selectedGlobalProjectName && focusedProjectName && selectedGlobalProjectName !== focusedProjectName) {
      return `${selectedGlobalProjectName} / ${focusedProjectName}`;
    }
    return selectedGlobalProjectName || focusedProjectName || null;
  }, [focusedProjectName, selectedGlobalProjectName]);
  const speechEnhancementContext = useMemo(() => ({
    mode,
    language: speechLanguage,
    projectName: mode === 'Implement' && selectedTask
      ? selectedTaskProjectSummary
      : projectScopeLabel,
    planName: mode === 'Architect' && activePlanContext
      ? getArchitectPlanPrimaryName(activePlanContext)
      : null,
    taskTitle: mode === 'Implement' ? selectedTask?.title ?? null : null,
    draftText: inputValue,
    recentMessages: currentMessages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-2)
      .map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: message.content,
      })),
  }), [
    activePlanContext,
    currentMessages,
    inputValue,
    mode,
    projectScopeLabel,
    selectedTask,
    selectedTaskProjectSummary,
    speechLanguage,
  ]);

  const modeHeader = useMemo(() => {
    if (mode === 'Architect') {
      return {
        icon: 'compass' as const,
        title: `${t('header.architect', 'Architect')} - ${projectScopeLabel || t('header.selectProject', 'Select Project')}`,
        subtitle:
          isModeProjectWorkspaceMissing
            ? null
            : activePlanContext
              ? getArchitectPlanPrimaryName(activePlanContext)
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
    activePlanContext,
    focusedProjectName,
    isModeProjectWorkspaceMissing,
    mode,
    projectScopeLabel,
    selectedGlobalProjectName,
    selectedTask?.title,
    t,
  ]);

  useEffect(() => {
    const handlePlanSelectorState = (event: Event) => {
      setArchitectPlanSelectorState(
        (event as CustomEvent<ArchitectPlanSelectorStateDetail>).detail ?? null
      );
    };
    window.addEventListener(
      ARCHITECT_PLAN_SELECTOR_STATE_EVENT,
      handlePlanSelectorState,
    );
    requestArchitectPlanSelectorState();
    return () => {
      window.removeEventListener(
        ARCHITECT_PLAN_SELECTOR_STATE_EVENT,
        handlePlanSelectorState,
      );
    };
  }, []);

  const missingArchitectPlanActionKind =
    architectPlanSelectorState?.status === 'ready' &&
    architectPlanSelectorState.planCount === 0 &&
    architectPlanSelectorState.canCreate
      ? 'create'
      : 'select';
  const isMissingArchitectPlanActionLoading =
    architectPlanSelectorState?.status === 'loading';
  const missingArchitectPlanActionLabel = isMissingArchitectPlanActionLoading
    ? t('architect.planSelector.loadingShort', 'Loading')
    : missingArchitectPlanActionKind === 'create'
      ? t('architect.createPlanAction', 'Create a plan')
      : t('architect.selectPlanAction', 'Select a plan');
  const missingArchitectPlanMessage = missingArchitectPlanActionKind === 'create'
    ? t(
        'architect.createFirstPlanToStart',
        'Create your first plan to start architecting.',
      )
    : architectPlanSelectorState?.status === 'ready' && architectPlanSelectorState.canSelect
      ? t(
          'architect.selectExistingPlanToStart',
          'Select a plan to start architecting.',
        )
      : t(
          'architect.selectPlanToStart',
          'Select or create a plan to start architecting.',
        );
  const handleMissingArchitectPlanAction = useCallback(() => {
    setLeftPanelOpen(true);
    window.requestAnimationFrame(() => {
      const anchor = missingArchitectPlanActionRef.current?.getBoundingClientRect();
      dispatchArchitectPlanSelectorRequest({
        action: 'primary',
        anchorRect: anchor
          ? {
              top: anchor.top,
              right: anchor.right,
              bottom: anchor.bottom,
              left: anchor.left,
              width: anchor.width,
              height: anchor.height,
            }
          : undefined,
      });
    });
  }, [setLeftPanelOpen]);

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

  const hasUserArchitectMessage = useMemo(
    () =>
      mode === 'Architect' &&
      currentMessages.some(
        (message) =>
          message.role === 'user' && message.content.trim().length > 0
      ),
    [currentMessages, mode]
  );

  const hasExistingStrategy = useMemo(() => {
    if (!activeArchitectPlanId) return false;
    return planNodes.length > 0 || predictedBranches.length > 0;
  }, [activeArchitectPlanId, planNodes.length, predictedBranches.length]);
  const isStrategyMutationLocked =
    mode === 'Architect' &&
    isArchitectPlanStrategyMutationLocked(activePlanContext?.status);
  const architectStrategyProgressAction = useMemo<ArchitectStrategyProgressAction | null>(() => {
    if (mode !== 'Architect') return null;
    if (!activeArchitectPlanId) return null;
    if (!hasUserArchitectMessage) return null;
    return hasExistingStrategy ? 'regenerate-strategy' : 'generate-strategy';
  }, [
    activeArchitectPlanId,
    hasExistingStrategy,
    hasUserArchitectMessage,
    mode,
  ]);
  const isArchitectStrategyProgressDisabled =
    isModeProjectWorkspaceMissing ||
    !activeArchitectPlanId ||
    isConversationPending ||
    isBusySending ||
    isStrategyMutationLocked;
  const architectButtonActions = useMemo(() => buildArchitectButtonActions(t), [t]);
  const architectStrategyProgressButton = useMemo<ArchitectToolbarButton | null>(() => {
    if (!architectStrategyProgressAction) return null;
    return architectButtonActions[architectStrategyProgressAction];
  }, [architectButtonActions, architectStrategyProgressAction]);
  const architectStrategyUnavailableTitle = isModeProjectWorkspaceMissing
    ? workspaceState.kind === 'noProjectAvailable'
      ? t('project.emptyWorkspaceTitle', 'Ajoutez un projet pour commencer avec Macro.')
      : t('project.noProjectSelectedTitle', 'Sélectionnez un projet pour continuer.')
    : !activeArchitectPlanId
      ? t('architect.generateStrategySelectPlan', 'Select an active plan first')
      : isStrategyMutationLocked
        ? t('architect.strategyLockedAfterValidation', 'Strategy is locked after plan validation.')
        : null;

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
        const isArchitectActionItem =
          item.item.kind === 'message' &&
          item.item.message.role === 'user' &&
          Boolean(resolveArchitectButtonActionFromContent(item.item.message.content, t));
        const isCompactionItem =
          item.item.kind === 'compaction_boundary' ||
          item.item.kind === 'compaction_progress';
        const assistantGapAdjustment =
          isCompactionItem &&
          previousItem?.kind === 'message' &&
          previousItem.message.role === 'assistant'
            ? CHAT_COMPACTION_AFTER_ASSISTANT_GAP_REDUCTION
            : 0;
        const architectActionTopGapAdjustment =
          isArchitectActionItem && previousItem
            ? CHAT_ARCHITECT_ACTION_ITEM_GAP_REDUCTION
            : 0;
        const adjustmentBeforeRender =
          state.positionAdjustment +
          assistantGapAdjustment +
          architectActionTopGapAdjustment;
        const nextItem = transcriptItems[item.index + 1];
        const compactionFollowingGapAdjustment =
          isCompactionItem && nextItem ? CHAT_TRANSCRIPT_ITEM_GAP : 0;
        const architectActionFollowingGapAdjustment =
          isArchitectActionItem && nextItem
            ? CHAT_ARCHITECT_ACTION_ITEM_GAP_REDUCTION
            : 0;
        return {
          items: [
            ...state.items,
            {
              ...item,
              start: item.start - adjustmentBeforeRender,
            },
          ],
          positionAdjustment:
            adjustmentBeforeRender +
            compactionFollowingGapAdjustment +
            architectActionFollowingGapAdjustment,
        };
      }, { items: [], positionAdjustment: 0 }).items;
    },
    [t, transcriptItems, virtualMessageItems]
  );
  const compactionGapAdjustment = useMemo(
    () =>
      transcriptItems.reduce((total, item, index) => {
        let adjustment = total;
        const isCompactionItem =
          item.kind === 'compaction_boundary' || item.kind === 'compaction_progress';
        const isArchitectActionItem =
          item.kind === 'message' &&
          item.message.role === 'user' &&
          Boolean(resolveArchitectButtonActionFromContent(item.message.content, t));

        if (isCompactionItem) {
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
        }

        if (
          isArchitectActionItem &&
          index > 0
        ) {
          adjustment += CHAT_ARCHITECT_ACTION_ITEM_GAP_REDUCTION;
        }
        if (
          isArchitectActionItem &&
          index < transcriptItems.length - 1
        ) {
          adjustment += CHAT_ARCHITECT_ACTION_ITEM_GAP_REDUCTION;
        }
        return adjustment;
      }, 0),
    [t, transcriptItems]
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
    goalObjective?: string;
  }): Promise<boolean> => {
    if (!runtimeCapabilities.implementExecution) return false;
    if (mode !== 'Implement' || !selectedTask || isBusySending || isConversationPending) return false;
    if (!selectedTaskRequiresKickoff) return false;
    if (selectedTask.draft) return false;
    if (!selectedProviderId || !selectedModelId) return false;
    if (startingExecutionRef.current) return false;

    startingExecutionRef.current = true;
    let conversationId: string | null = null;
    let goalActivated = false;

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

      if (params?.goalObjective) {
        activateConversationGoal({
          conversationId,
          objective: params.goalObjective,
          providerId: selectedProviderId,
          modelId: selectedModelId,
          reasoningEffort: selectedReasoningEffort,
        });
        goalActivated = true;
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

      const result = await sendMessage({
        conversationId,
        content,
        taskId: selectedTask.id,
      });
      if (goalActivated) {
        setConversationGoalStatus(
          conversationId,
          result.status === 'sent' ? 'executor_running' : 'paused',
        );
      }
      clearComposerDraftForContext(composerDraftContextKey);
      clearComposerDraftForContext(`conversation:${conversationId}`);
      composerEditorRef.current?.clear();
      setInputValue('');
      resetPromptHistoryNavigation();
      return true;
    } catch (error) {
      if (conversationId) {
        delete executionKickoffByConversationRef.current[conversationId];
        if (goalActivated) {
          setConversationGoalStatus(
            conversationId,
            'error',
            toServiceError(error).message,
          );
        }
      }
      throw error;
    } finally {
      startingExecutionRef.current = false;
    }
  }, [
    ensureConversation,
    activateConversationGoal,
    clearComposerDraftForContext,
    composerDraftContextKey,
    isConversationPending,
    isBusySending,
    mode,
    selectedModelId,
    selectedProviderId,
    selectedReasoningEffort,
    selectedTask,
    selectedTaskProjectSummary,
    selectedTaskRequiresKickoff,
    sendMessage,
    setConversationGoalStatus,
    startTask,
    resetPromptHistoryNavigation,
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

  const appendPastedImages = async (files: File[]) => {
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
      setComposerImages((prev) => [...prev, ...nextImages]);
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

  const handleComposerPaste = async (event: React.ClipboardEvent<HTMLElement>) => {
    const directFiles = Array.from(event.clipboardData.items || [])
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    const files = directFiles.length > 0 ? directFiles : await readImageFilesFromClipboardApi();
    if (files.length === 0) return;

    event.preventDefault();
    await appendPastedImages(files);
  };

  const removeComposerImage = (imageId: string) => {
    if (composerError) {
      clearConversationRuntimeError(selectedConversationId ?? '');
      clearLastError();
    }
    setComposerImages((prev) => prev.filter((image) => image.id !== imageId));
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

  const applySavedComposerDraft = useCallback((session: SavedComposerDraft) => {
    setComposerImages(session.savedDraftImages);
    setInputValue(session.savedDraftText);
    clearComposerContextRefs();
    composerEditorRef.current?.setText(
      session.savedDraftText,
      session.savedDraftContextRefs,
    );
    session.savedDraftContextRefs.forEach((ref) => {
      addComposerContextRef(ref);
    });
  }, [addComposerContextRef, clearComposerContextRefs]);

  const restoreComposerDraft = useCallback((session: ComposerEditSession) => {
    setComposerEditSession(null);
    applySavedComposerDraft(session);
  }, [applySavedComposerDraft]);

  const restoreGoalComposerDraft = useCallback((session: GoalComposerEditSession) => {
    if (goalComposerEditSessionRef.current !== session) return;
    goalComposerEditSessionRef.current = null;
    setGoalComposerEditSession(null);
    applySavedComposerDraft(session);
  }, [applySavedComposerDraft]);

  const sendComposerMessage = async (
    textOverride?: string,
    activeBehaviorOverride?: 'steer' | 'queue',
  ) => {
    if (isComposerDisabled || activeQuestionnaire) return;
    if (isArchitectPlanSelectionMissing) return;
    if (mode === 'Architect' && isWorkspaceMissing) return;
    const text = (textOverride ?? composerEditorRef.current?.getTextContent() ?? '').trim();
    if (isBusySending) {
      if (!selectedConversationId || !text) return;
      try {
        const internalAgentProfile = getConflictAssistantInternalAgentProfile(selectedConversationId);
        await submitDuringActiveTurn(
          {
            conversationId: selectedConversationId,
            content: text,
            taskId: implementTaskIdForSend,
            images: [...composerImages],
            ...(internalAgentProfile ? { internalAgentProfile } : {}),
          },
          activeBehaviorOverride ?? activeTurnSendBehavior,
        );
        if (internalAgentProfile) {
          clearConflictAssistantInternalAgentProfile(selectedConversationId);
        }
        clearComposerDraftForContext(composerDraftContextKey);
        clearComposerDraftForContext(`conversation:${selectedConversationId}`);
        composerEditorRef.current?.clear();
        clearComposerContextRefs();
        setComposerImages([]);
        setInputValue('');
        resetPromptHistoryNavigation();
      } catch (error) {
        notify.error(t('chat.activeTurnSendFailed', 'Message not sent'), {
          description: toServiceError(error).message,
        });
      }
      return;
    }
    if (composerEditSession) {
      if (!text || isBusySending) return;
      await requestReplay({
        kind: 'edit',
        messageId: composerEditSession.messageId,
        content: text,
        images: [...composerImages],
      });
      return;
    }
    const goalCommand = parseConversationGoalCommand(text);
    if (goalCommand?.kind === 'missing_objective') {
      notify.warning(t('goal.commandMissingObjectiveTitle', 'Goal needs an objective'), {
        description: t(
          'goal.commandMissingObjectiveDescription',
          'Write /goal followed by the outcome you want the agent to reach.',
        ),
      });
      return;
    }
    if (isImplementComposerInKickoffMode) {
      if (!text || isBusySending) return;
      try {
        const goalObjective = goalCommand?.kind === 'activate'
          ? goalCommand.objective
          : undefined;
        await handleStartExecution({
          notesOverride: goalObjective ?? text,
          goalObjective,
        });
      } catch {
        // Keep the draft intact. The visible error feedback comes from the chat store.
      }
      return;
    }
    if ((!text && composerImages.length === 0 && composerContextRefs.length === 0) || isBusySending) return;
    if (!goalComposerEditSession) {
      saveComposerDraftForContext(composerDraftContextKey, {
        text,
        images: [...composerImages],
        contextRefs: cloneContextRefs(composerContextRefs),
      });
    }
    const conversationId = await ensureConversation();
    if (!conversationId) return;
    const conversationDraftKey = `conversation:${conversationId}`;
    migrateComposerDraftContext(composerDraftContextKey, conversationDraftKey);
    const content = goalCommand?.kind === 'activate' ? goalCommand.objective : text;
    const imagesForMessage = [...composerImages];
    const internalAgentProfile =
      getConflictAssistantInternalAgentProfile(conversationId);
    let tracksGoalTurn = false;
    let goalEditTransactionId: string | null = null;

    if (goalCommand?.kind === 'activate') {
      if (goalComposerEditSession) {
        const transaction = beginConversationGoalEdit({
          conversationId,
          objective: goalCommand.objective,
          providerId: selectedProviderId,
          modelId: selectedModelId,
          reasoningEffort: selectedReasoningEffort,
          expectedGoalId: goalComposerEditSession.goalId,
        });
        if (!transaction) return;
        goalEditTransactionId = transaction.transactionId;
      } else {
        activateConversationGoal({
          conversationId,
          objective: goalCommand.objective,
          providerId: selectedProviderId,
          modelId: selectedModelId,
          reasoningEffort: selectedReasoningEffort,
        });
      }
      tracksGoalTurn = true;
    } else {
      const currentGoal = useConversationGoalStore.getState()
        .goalsByConversationId[conversationId];
      if (
        currentGoal &&
        currentGoal.status !== 'paused' &&
        currentGoal.status !== 'achieved' &&
        currentGoal.status !== 'error'
      ) {
        tracksGoalTurn = true;
      }
    }

    try {
      const result = await sendMessage({
        conversationId,
        content,
        taskId: implementTaskIdForSend,
        images: imagesForMessage,
        ...(internalAgentProfile ? { internalAgentProfile } : {}),
      });
      if (result.status === 'sent') {
        if (goalEditTransactionId) {
          if (settleConversationGoalEdit(goalEditTransactionId, 'commit')) {
            setConversationGoalStatus(conversationId, 'executor_running');
          }
        } else if (tracksGoalTurn) {
          setConversationGoalStatus(conversationId, 'executor_running');
        }
        if (internalAgentProfile) {
          clearConflictAssistantInternalAgentProfile(conversationId);
        }
        if (goalComposerEditSession) {
          const targetDraftKey = `conversation:${goalComposerEditSession.conversationId}`;
          if (
            goalComposerEditSessionRef.current === goalComposerEditSession &&
            activeComposerDraftContextKeyRef.current === targetDraftKey
          ) {
            saveComposerDraftForContext(targetDraftKey, {
              text: goalComposerEditSession.savedDraftText,
              images: [...goalComposerEditSession.savedDraftImages],
              contextRefs: cloneContextRefs(goalComposerEditSession.savedDraftContextRefs),
            });
            restoreGoalComposerDraft(goalComposerEditSession);
          }
        } else {
          clearComposerDraftForContext(composerDraftContextKey);
          clearComposerDraftForContext(conversationDraftKey);
          composerEditorRef.current?.clear();
          clearComposerContextRefs();
          setComposerImages([]);
          setInputValue('');
        }
        resetPromptHistoryNavigation();
      } else if (goalEditTransactionId) {
        settleConversationGoalEdit(goalEditTransactionId, 'rollback');
      } else if (tracksGoalTurn) {
        setConversationGoalStatus(conversationId, 'paused');
      }
    } catch (error) {
      if (goalEditTransactionId) {
        settleConversationGoalEdit(goalEditTransactionId, 'rollback');
      } else if (tracksGoalTurn) {
        setConversationGoalStatus(
          conversationId,
          'error',
          toServiceError(error).message,
        );
      }
      // Keep the draft intact. The visible error feedback comes from the chat store.
    }
  };

  const handlePauseGoal = useCallback(() => {
    if (!selectedConversationId) return;
    if (isBusySending) stopStreaming();
    setConversationGoalStatus(selectedConversationId, 'paused');
  }, [isBusySending, selectedConversationId, setConversationGoalStatus, stopStreaming]);

  const handleResumeGoal = useCallback(() => {
    if (!selectedConversationId) return;
    setConversationGoalStatus(selectedConversationId, 'active_ready');
  }, [selectedConversationId, setConversationGoalStatus]);

  const handleEditGoal = useCallback(() => {
    if (
      !activeConversationGoal ||
      !selectedConversationId ||
      goalComposerEditSession ||
      composerEditSession ||
      activeQuestionnaire ||
      activePendingToolApproval ||
      isBusySending
    ) {
      return;
    }
    const savedDraft: GoalComposerEditSession = {
      conversationId: selectedConversationId,
      goalId: activeConversationGoal.goalId,
      savedDraftText: composerEditorRef.current?.getTextContent() ?? inputValue,
      savedDraftImages: [...composerImages],
      savedDraftContextRefs: cloneContextRefs(composerContextRefs),
    };
    const goalDraft = `/goal ${activeConversationGoal.objective}`;
    saveComposerDraftForContext(composerDraftContextKey, {
      text: savedDraft.savedDraftText,
      images: savedDraft.savedDraftImages,
      contextRefs: savedDraft.savedDraftContextRefs,
    });
    goalComposerEditSessionRef.current = savedDraft;
    setGoalComposerEditSession(savedDraft);
    clearComposerContextRefs();
    setComposerImages([]);
    setInputValue(goalDraft);
    composerEditorRef.current?.setText(goalDraft, []);
    resetPromptHistoryNavigation();
    window.requestAnimationFrame(() => composerEditorRef.current?.focus());
  }, [
    activeConversationGoal,
    activeQuestionnaire,
    activePendingToolApproval,
    clearComposerContextRefs,
    composerDraftContextKey,
    composerEditSession,
    composerContextRefs,
    composerImages,
    goalComposerEditSession,
    inputValue,
    isBusySending,
    resetPromptHistoryNavigation,
    saveComposerDraftForContext,
    selectedConversationId,
  ]);

  const handleStopGoal = useCallback(() => {
    if (!selectedConversationId) return;
    if (isBusySending) stopStreaming();
    clearConversationGoal(selectedConversationId);
  }, [clearConversationGoal, isBusySending, selectedConversationId, stopStreaming]);

  const handleStopStreaming = useCallback(() => {
    if (
      selectedConversationId &&
      activeConversationGoal?.status === 'executor_running'
    ) {
      setConversationGoalStatus(selectedConversationId, 'paused');
    }
    stopStreaming();
  }, [
    activeConversationGoal?.status,
    selectedConversationId,
    setConversationGoalStatus,
    stopStreaming,
  ]);

  useEffect(() => {
    if (
      !selectedConversationId ||
      activeConversationGoal?.status !== 'executor_running' ||
      isTranscriptActivityActive
    ) {
      return;
    }

    if (selectedConversationRuntime.phase === 'error') {
      setConversationGoalStatus(
        selectedConversationId,
        'error',
        selectedConversationRuntime.lastError ?? t(
          'goal.executionFailed',
          'The executor turn failed.',
        ),
      );
      return;
    }

    setConversationGoalStatus(selectedConversationId, 'audit_pending');
  }, [
    activeConversationGoal?.status,
    isTranscriptActivityActive,
    selectedConversationId,
    selectedConversationRuntime.lastError,
    selectedConversationRuntime.phase,
    setConversationGoalStatus,
    t,
  ]);

  const speechDictation = useSpeechDictation({
    contextKey: composerDraftContextKey,
    enhancementContext: speechEnhancementContext,
    onInterimTranscript: (text) => {
      const editor = composerEditorRef.current;
      const previousText = editor?.getTextContent() ?? inputValue;
      const composedText = editor?.insertTextAtSelection(text, 'contextual') ?? text;
      pendingSpeechInsertionRef.current = locateSpeechComposerInsertion(
        previousText,
        composedText,
        text,
      );
    },
    onTranscript: (text, completion) => {
      const editor = composerEditorRef.current;
      const pendingInsertion = pendingSpeechInsertionRef.current;
      pendingSpeechInsertionRef.current = null;
      let composedText: string;
      if (editor && pendingInsertion) {
        const currentText = editor.getTextContent();
        const replacedText = replaceSpeechComposerInsertion(currentText, pendingInsertion, text);
        if (replacedText !== null) {
          editor.setText(replacedText);
          composedText = replacedText;
        } else {
          composedText = currentText;
        }
      } else {
        composedText = editor?.insertTextAtSelection(text, 'contextual') ?? text;
      }
      if (completion === 'send') {
        void sendComposerMessage(composedText);
      }
    },
    onError: ({ code, detail }) => {
      const message = t(`speech.errors.${code}`, {
        defaultValue: t('speech.errors.transcription-failed', 'Speech transcription failed.'),
      });
      notify.error(t('speech.errors.title', 'Dictation unavailable'), {
        description: detail ? `${message} ${detail}` : message,
      });
    },
    onEnhancementError: () => {
      notify.warning(
        t('speech.errors.enhancement-failed-title', 'Smart cleanup unavailable'),
        {
          description: t('speech.errors.enhancement-failed', 'Macro kept the raw transcript.'),
        },
      );
    },
  });
  const showSpeechRecordingBar =
    speechDictation.phase === 'recording' ||
    speechDictation.phase === 'transcribing';
  const isSpeechEnhancing = speechDictation.phase === 'enhancing';

  const handleSend = async () => {
    if (speechDictation.isBusy) return;
    await sendComposerMessage();
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

  const sendArchitectButtonAction = async (actionId: ArchitectStrategyProgressAction) => {
    if (mode !== 'Architect' || !activeArchitectPlanId || isBusySending || isConversationPending) return;
    if (isStrategyMutationLocked) return;
    const conversationId = await ensureConversation();
    if (!conversationId) return;

    try {
      await sendMessage({
        conversationId,
        content: architectButtonActions[actionId].fullPrompt,
      });
    } catch {
      // The store exposes the visible error state.
    }
  };

  const handleArchitectStrategyProgressAction = () => {
    if (!architectStrategyProgressAction) return;
    void sendArchitectButtonAction(architectStrategyProgressAction);
  };

  const handleEditStart = (message: ChatMessage) => {
    if (
      composerEditSession ||
      goalComposerEditSession ||
      isBusySending ||
      activePendingToolApproval
    ) {
      return;
    }

    if (message.questionnaire_response_summary) {
      const opened = startQuestionnaireResponseEdit(message.id);
      if (opened) {
        setComposerEditSession(null);
      }
      return;
    }

    if (activeQuestionnaire) {
      return;
    }

    const content = message.content;
    const messageContextRefs = cloneContextRefs(message.context_refs);
    const draftText = composerEditorRef.current?.getTextContent() ?? inputValue;
    const session: ComposerEditSession = {
      messageId: message.id,
      originalContent: content,
      savedDraftText: draftText,
      savedDraftImages: [...composerImages],
      savedDraftContextRefs: [...composerContextRefs],
    };
    setComposerEditSession(session);
    clearComposerContextRefs();
    setComposerImages(getMessageImages(message.id));
    setInputValue(content);
    setPromptHistoryIndex(null);
    composerEditorRef.current?.setText(content, messageContextRefs);
    requestAnimationFrame(() => {
      composerEditorRef.current?.focus();
    });
  };

  const handleEditCancel = () => {
    if (!composerEditSession) return;
    restoreComposerDraft(composerEditSession);
  };

  const handleEditCommitted = useCallback(() => {
    const session = composerEditSession;
    if (!session) return;
    restoreComposerDraft(session);
  }, [composerEditSession, restoreComposerDraft]);

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
    rollbackPendingAgentCodeReplay,
    editMessage,
    setMessageImages,
    getMessageImages,
    onEditCommitted: handleEditCommitted,
  });

  useEffect(() => {
    const handleSecondarySend = () => {
      if (!isBusySending) return;
      void sendComposerMessage(
        undefined,
        activeTurnSendBehavior === 'steer' ? 'queue' : 'steer',
      );
    };
    window.addEventListener('macro:composer-secondary-send', handleSecondarySend);
    return () => window.removeEventListener('macro:composer-secondary-send', handleSecondarySend);
  });

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
      goalComposerEditSession
        ? parseConversationGoalCommand(inputValue)?.kind === 'activate'
        : composerEditSession
        ? Boolean(inputValue.trim())
        : isImplementComposerInKickoffMode
        ? Boolean(inputValue.trim())
        : Boolean(inputValue.trim()) || composerImages.length > 0 || composerContextRefs.length > 0
    );
  const isGoalComposerDraft = useMemo(
    () => !composerEditSession && parseConversationGoalCommand(inputValue) !== null,
    [composerEditSession, inputValue],
  );
  const handleRemoveGoalComposerCommand = useCallback(() => {
    if (goalComposerEditSession) {
      restoreGoalComposerDraft(goalComposerEditSession);
      window.requestAnimationFrame(() => composerEditorRef.current?.focus());
      return;
    }
    const currentText = composerEditorRef.current?.getTextContent() ?? inputValue;
    const goalCommand = parseConversationGoalCommand(currentText);
    if (!goalCommand) return;

    const nextText = goalCommand.kind === 'activate' ? goalCommand.objective : '';
    setInputValue(nextText);
    composerEditorRef.current?.setText(nextText);
    window.requestAnimationFrame(() => composerEditorRef.current?.focus());
  }, [goalComposerEditSession, inputValue, restoreGoalComposerDraft]);

  useEffect(() => {
    if (
      !goalComposerEditSession ||
      parseConversationGoalCommand(inputValue) !== null
    ) {
      return;
    }
    restoreGoalComposerDraft(goalComposerEditSession);
  }, [goalComposerEditSession, inputValue, restoreGoalComposerDraft]);
  const hasComposerSkillReference = useMemo(
    () => composerContextRefs.some((ref) => ref.kind === 'skill'),
    [composerContextRefs]
  );
  const hasComposerSkillMention = useMemo(
    () => /(?:\$[A-Za-z0-9_-]{1,80}\b|\[skill:\s*[^\]]+\])/i.test(inputValue),
    [inputValue]
  );
  const showSkillNativeToolWarning =
    !nativeToolsSupported && (hasComposerSkillReference || hasComposerSkillMention);

  const navigatePromptHistory = useCallback((direction: 'up' | 'down') => {
    if (goalComposerEditSession) return;
    if (promptHistory.length === 0) return;

    if (direction === 'up') {
      const currentText = composerEditorRef.current?.getTextContent() ?? inputValue;
      const effectiveHistoryIndex =
        promptHistoryIndex ?? findPromptHistoryIndexByText(currentText);

      if (effectiveHistoryIndex === null) {
        setDraftBeforeHistory(getComposerDraftSnapshot(currentText));
        const lastIndex = promptHistory.length - 1;
        setPromptHistoryIndex(lastIndex);
        applyComposerDraftSnapshot(promptHistory[lastIndex]);
        return;
      }

      if (promptHistoryIndex === null) {
        setDraftBeforeHistory(getComposerDraftSnapshot(currentText));
      }

      if (effectiveHistoryIndex > 0) {
        const nextIndex = effectiveHistoryIndex - 1;
        setPromptHistoryIndex(nextIndex);
        applyComposerDraftSnapshot(promptHistory[nextIndex]);
      } else if (promptHistoryIndex === null) {
        setPromptHistoryIndex(effectiveHistoryIndex);
      }
      return;
    }

    if (promptHistoryIndex === null) return;

    if (promptHistoryIndex < promptHistory.length - 1) {
      const nextIndex = promptHistoryIndex + 1;
      setPromptHistoryIndex(nextIndex);
      applyComposerDraftSnapshot(promptHistory[nextIndex]);
      return;
    }

    setPromptHistoryIndex(null);
    applyComposerDraftSnapshot(draftBeforeHistory);
  }, [
    applyComposerDraftSnapshot,
    draftBeforeHistory,
    findPromptHistoryIndexByText,
    getComposerDraftSnapshot,
    goalComposerEditSession,
    inputValue,
    promptHistory,
    promptHistoryIndex,
  ]);

  useEffect(() => {
    resetPromptHistoryNavigation();
  }, [resetPromptHistoryNavigation, selectedConversationId]);

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
      <div
        className="flex-1 flex min-h-0 min-w-0 flex-col overflow-hidden"
        data-chat-conversation-panel
      >
        {/* Header */}
        <header
          className="h-14 border-b border-border/50 flex items-center justify-between px-4 bg-card/30"
          data-tour-id="mode-context-header"
          data-chat-conversation-header
        >
          <div className="flex items-center gap-3 min-w-0">
            {canShowImplementTaskTodoDropdown ? (
              <Suspense fallback={null}>
                <ImplementTaskTodoDropdown
                  taskTitle={modeHeader.title}
                  todos={selectedTaskTodos}
                  isOpen={isTaskTodoDropdownOpen}
                  onToggle={() => setIsTaskTodoDropdownOpen((current) => !current)}
                  rootRef={taskTodoDropdownRef}
                />
              </Suspense>
            ) : (
              <div className="h-8 w-8 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                <Icon name={modeHeader.icon} size={14} className="text-primary" />
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
            {mode === 'Implement' && <TaskArtifactsButton />}
            {shouldShowContextIndicator && selectedConversationId && (
              <Suspense fallback={null}>
                <ContextWindowIndicator
                  diagnostics={contextDiagnostics}
                  compactionStatus={activeCompactionStatus}
                  isCompacting={isActiveContextCompacting}
                  activityLabel={manualCompactionActivityLabel}
                  canCompactNow={!isBusySending && !isManualCompacting}
                  manualCompactionDisabledReason={manualCompactionDisabledReason}
                  manualCompactionFeedback={manualCompactionFeedback}
                  onRefresh={() => {
                    void runContextDiagnosticsRefresh();
                  }}
                  onCompactNow={handleManualCompaction}
                />
              </Suspense>
            )}
            {headerActions}
          </div>
        </header>

        {activeConversationGoal && (
          <Suspense fallback={null}>
            <ConversationGoalBanner
              goal={activeConversationGoal}
              onEdit={handleEditGoal}
              onPause={handlePauseGoal}
              onResume={handleResumeGoal}
              onStop={handleStopGoal}
            />
          </Suspense>
        )}

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
                  {missingArchitectPlanMessage}
                </p>
                <button
                  ref={missingArchitectPlanActionRef}
                  type="button"
                  onClick={handleMissingArchitectPlanAction}
                  disabled={isMissingArchitectPlanActionLoading}
                  data-tour-id="architect-empty-plan-action"
                  className={cn(
                    'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors',
                    isMissingArchitectPlanActionLoading
                      ? 'border-border bg-muted text-muted-foreground cursor-wait'
                      : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground'
                  )}
                >
                  <Icon
                    name={
                      isMissingArchitectPlanActionLoading
                        ? 'loader'
                        : missingArchitectPlanActionKind === 'create'
                          ? 'plus'
                          : 'list'
                    }
                    size={14}
                    className={cn(isMissingArchitectPlanActionLoading && 'animate-spin')}
                  />
                  {missingArchitectPlanActionLabel}
                </button>
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
                const isEditing = composerEditSession?.messageId === message.id;
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
                    messageImages={messageImages}
                    isCopied={copiedMessageId === message.id}
                    isHighlighted={highlightedMessageId === message.id}
                    onImageMouseDown={preventImageMouseDown}
                    onOpenImagePreview={openImagePreview}
                    onEditCancel={handleEditCancel}
                    onCopy={handleCopy}
                    onEditStart={handleEditStart}
                    onRegenerate={handleRegenerate}
                    skillTurnFeedback={skillTurnFeedbackByMessageId[message.id]}
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
              </div>
              {mode === 'Architect' && architectStrategyProgressButton && (
                  <div className="flex items-center gap-2">
                    {architectStrategyProgressButton ? (
                      <button
                        type="button"
                        onClick={handleArchitectStrategyProgressAction}
                        data-tour-id={
                          architectStrategyProgressAction === 'generate-strategy' ||
                          architectStrategyProgressAction === 'regenerate-strategy'
                            ? 'architect-generate-strategy'
                            : 'architect-progress-action'
                        }
                        disabled={isArchitectStrategyProgressDisabled}
                        className={cn(
                          'inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-medium border transition-colors',
                          isArchitectStrategyProgressDisabled
                            ? 'border-border text-muted-foreground bg-card/40 cursor-not-allowed'
                            : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground'
                        )}
                        title={architectStrategyUnavailableTitle ?? architectStrategyProgressButton.title}
                      >
                        <Icon name={architectStrategyProgressButton.icon} size={12} />
                        {architectStrategyProgressButton.label}
                      </button>
                    ) : null}
                  </div>
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
                    onClick={() => void sendComposerMessage()}
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
              <ActionableErrorCallout
                className="mb-3"
                compact
                presentation={presentServiceError(composerError, {
                  fallbackBody: composerError === 'No available provider or model could be restored for this conversation.'
                    ? t(
                        'chat.providerRestoreUnavailable',
                        'The provider or model previously used by this conversation is no longer available. Select another one to continue.'
                      )
                    : t('chat.runtimeErrorFallback', 'Macro could not complete this action. Review the details, then try again.'),
                })}
              />
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

            {isSelectedConversationArchived && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <Icon name="archive" size={14} className="mt-0.5 shrink-0" />
                <span>
                  {t(
                    'chat.archivedConversationReadOnly',
                    'This conversation is archived. Restore it before sending another message.'
                  )}
                </span>
              </div>
            )}

            {activePendingToolApproval ? (
              <Suspense fallback={null}>
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
              </Suspense>
            ) : activeQuestionnaire ? (
              <Suspense fallback={null}>
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
              </Suspense>
            ) : (
              <div className="flex items-center gap-2">
                {isGoalComposerDraft && !showSpeechRecordingBar && (
                  <button
                    type="button"
                    data-chat-goal-command-control="true"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={handleRemoveGoalComposerCommand}
                    aria-label={t('goal.removeCommand', 'Remove Goal command')}
                    title={t('goal.removeCommand', 'Remove Goal command')}
                    className="group relative flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-lg text-primary/80 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                  >
                    <Icon
                      name="target"
                      size={18}
                      className="transition-[opacity,transform] group-hover:scale-75 group-hover:opacity-0 group-focus-visible:scale-75 group-focus-visible:opacity-0"
                    />
                    <Icon
                      name="x"
                      size={14}
                      className="absolute scale-75 opacity-0 transition-[opacity,transform] group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100"
                    />
                  </button>
                )}
                <div
                  data-chat-composer-editing={
                    composerEditSession ? 'true' : undefined
                  }
                  data-chat-composer-goal={isGoalComposerDraft ? 'true' : undefined}
                  className={cn(
                    'relative flex min-w-0 flex-1 items-center gap-2 rounded-xl border px-2 py-1.5 transition-[border-color,background-color,box-shadow] duration-200',
                    isGoalComposerDraft
                      ? 'border-primary/40 bg-[linear-gradient(105deg,rgb(var(--primary)/0.11),rgb(var(--card)/0.88)_32%,rgb(var(--card)/0.82))] shadow-[inset_0_1px_0_rgb(var(--primary)/0.12),0_0_0_1px_rgb(var(--primary)/0.04),0_8px_28px_-20px_rgb(var(--primary)/0.65)]'
                      : composerEditSession
                        ? 'border-border bg-card/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                        : 'border-border bg-card/80'
                  )}
                  onPasteCapture={handleComposerPaste}
                  data-tour-id="chat-composer"
                >
                  <div
                    className={cn('min-w-0 flex-1', showSpeechRecordingBar && 'hidden')}
                    aria-hidden={showSpeechRecordingBar || undefined}
                  >
                    <Suspense fallback={<ComposerFallbackStatus />}>
                      <LazyComposerEditor
                        ref={composerEditorRef}
                        editable={!!selectedProviderId && !!selectedModelId && !isComposerDisabled}
                        readOnly={isSpeechEnhancing}
                        className={isSpeechEnhancing ? 'speech-cleanup-text' : undefined}
                        placeholder={
                          composerEditSession
                            ? t('chat.editMessagePlaceholder', 'Edit message...')
                          : isConversationPending
                            ? t('chat.loadingConversation', 'Restoring conversation...')
                          : isModeProjectWorkspaceMissing
                            ? workspaceState.kind === 'noProjectAvailable'
                              ? t('project.emptyWorkspaceTitle', 'Ajoutez un projet pour commencer avec Macro.')
                              : t('project.noProjectSelectedTitle', 'Sélectionnez un projet pour continuer.')
                          : isArchitectPlanSelectionMissing
                            ? missingArchitectPlanMessage
                          : isImplementTaskSelectionMissing
                            ? t('implement.selectTaskToStart', 'Select a task to start implementation.')
                          : isSelectedConversationArchived
                            ? t(
                                'chat.archivedConversationPlaceholder',
                                'Restore this conversation to continue.'
                              )
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
                          const pendingPromptHistoryText = pendingPromptHistoryTextRef.current;
                          const isPromptHistoryText = pendingPromptHistoryText === text;
                          if (pendingPromptHistoryText !== null) {
                            pendingPromptHistoryTextRef.current = null;
                          }
                          setInputValue(text);
                          if (!isPromptHistoryText && promptHistoryIndex !== null) {
                            resetPromptHistoryNavigation();
                          }
                        }}
                        onSend={handleSend}
                        onPromptHistory={
                          !composerEditSession &&
                          !goalComposerEditSession &&
                          promptHistoryNavigationMode === 'contextual_arrows'
                            ? navigatePromptHistory
                            : undefined
                        }
                      />
                    </Suspense>
                  </div>
                  {showSpeechRecordingBar && (
                    <SpeechRecordingBar
                      phase={speechDictation.phase as 'recording' | 'transcribing'}
                      completion={speechDictation.completion}
                      elapsedSeconds={speechDictation.elapsedSeconds}
                      getAudioLevel={speechDictation.getAudioLevel}
                      recordingLabel={t('speech.recording.active', 'Recording')}
                      transcribingLabel={t('speech.button.transcribing', 'Audio sent · Transcribing')}
                      stopLabel={t('speech.recording.stopAndInsert', 'Stop and insert transcription')}
                      sendLabel={t('speech.recording.stopAndSend', 'Stop, transcribe and send')}
                      onStop={() => {
                        void speechDictation.finish('insert');
                      }}
                      onSend={() => {
                        void speechDictation.finish('send');
                      }}
                    />
                  )}
                  {composerEditSession && !isStreaming && !showSpeechRecordingBar && (
                    <button
                      type="button"
                      onClick={handleEditCancel}
                      data-tour-id="chat-edit-cancel-button"
                      aria-label={t('common.cancel')}
                      title={t('common.cancel')}
                      className="flex h-9 min-w-[2.375rem] items-center justify-center rounded-lg bg-muted px-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  )}
                  {isStreaming && !showSpeechRecordingBar && (
                    <button
                      onClick={handleStopStreaming}
                      data-tour-id="chat-stop-button"
                      className="rounded-lg bg-red-500 hover:bg-red-600 text-white px-3 h-9 flex items-center gap-2"
                    >
                      <Icon name="square" size={14} />
                      <span className="text-xs">{t('chat.stop')}</span>
                    </button>
                  )}
                  {!showSpeechRecordingBar ? (
                    <>
                      {!isStreaming && (
                        <SpeechDictationButton
                          phase={speechDictation.phase}
                          elapsedSeconds={speechDictation.elapsedSeconds}
                          disabled={isComposerDisabled}
                          label={t('speech.button.start', 'Start dictation')}
                          recordingLabel={t('speech.button.stop', 'Stop dictation')}
                          transcribingLabel={t('speech.button.transcribing', 'Transcribing')}
                          onToggle={() => {
                            void speechDictation.toggle();
                          }}
                        />
                      )}
                      <button
                        onClick={handleSend}
                        data-tour-id="chat-send-button"
                        title={isStreaming
                          ? `${activeTurnSendBehavior === 'steer'
                            ? t('chat.steerActiveTurn', 'Steer active turn')
                            : t('chat.queueNextTurn', 'Queue for next turn')}. ${t('chat.secondaryAction', 'Alternate action')}: ${formatBindingForDisplay(secondarySendBinding)}`
                          : t('chat.send', 'Send')}
                        disabled={speechDictation.isBusy || !canSend || !selectedProviderId || !selectedModelId || isComposerDisabled}
                        className={cn(
                          'rounded-lg px-3 h-9 flex items-center transition-colors',
                          speechDictation.isBusy || !canSend || !selectedProviderId || !selectedModelId || isComposerDisabled
                            ? 'bg-muted text-muted-foreground cursor-not-allowed'
                            : 'bg-primary hover:bg-primary/90 text-primary-foreground'
                        )}
                      >
                        <Icon name="arrow-up" size={14} />
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </footer>
      </div>

      {pendingReplayConfirmation && (
        <Suspense fallback={null}>
          <AgentCodeReplayConfirmModal
            pendingReplayConfirmation={pendingReplayConfirmation}
            isSubmitting={isReplayConfirmationSubmitting}
            onCancel={cancelReplayConfirmation}
            onConfirm={() => {
              void confirmReplayConfirmation();
            }}
          />
        </Suspense>
      )}

      {previewImage && (
        <Suspense fallback={null}>
          <ImagePreviewModal
            isOpen
            image={previewImage}
            onClose={() => setPreviewImage(null)}
          />
        </Suspense>
      )}

      {mode === 'Architect' &&
        architectPlanNamingRecovery?.stage === 'choice' && (
          <Suspense fallback={null}>
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
          </Suspense>
        )}

      {mode === 'Architect' &&
        architectPlanNamingRecovery?.stage === 'manual' && (
          <Suspense fallback={null}>
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
          </Suspense>
        )}
    </main>
  );
};

// Performance: Memoize to prevent re-renders when parent updates
const MemoizedChatZone = React.memo(ChatZone);

// Export both named and default for lazy loading compatibility
export default MemoizedChatZone;
