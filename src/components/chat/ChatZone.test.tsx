import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../test-utils/reactI18nextMock';
import { createDeferred } from '../../test-utils/deferred';
import {
  installTauriRuntimeMock,
  removeTauriRuntimeMock,
} from '../../test-utils/tauriRuntime';
import { createStoreHookMock } from '../../test-utils/storeHookMock';
import { useConversationGoalStore } from '../../stores/useConversationGoalStore';
import { useConversationArchiveStore } from '../../stores/useConversationArchiveStore';
import type { ComposerDraft } from '../../stores/useChatStore';
import { registerArchitectScenarios } from './__tests__/architect.scenarios';
import { registerCompactionScenarios } from './__tests__/compaction.scenarios';
import { registerImplementScenarios } from './__tests__/implement.scenarios';
import { registerQuestionnaireApprovalScenarios } from './__tests__/questionnaireApproval.scenarios';

type AppMode = 'Chat' | 'Architect' | 'Implement';

type MockConversation = {
  id: string;
  title: string;
  scope_mode: AppMode;
  task_id: string | null;
  project_id: string | null;
  group_id: string | null;
};

export type MockMessage = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  task_id?: string | null;
  tool_traces?: unknown[];
  context_refs?: unknown[];
  questionnaire_response_summary?: {
    assistantMessageId: string;
    source?: 'tool' | 'legacy_quick_replies';
    originToolCallId?: string;
    items: Array<{
      id: string;
      prompt: string;
      answer: string;
    }>;
  };
  questionnaire?: {
    intro?: string;
    source?: 'tool' | 'legacy_quick_replies';
    questions: Array<{
      id: string;
      prompt: string;
      choices: [string, string, string];
      free_text_placeholder?: string;
    }>;
  };
  completion_reason?: 'completed' | 'tool_turn_limit' | 'post_tool_empty_fallback';
};

export type MockChatState = {
  conversations: MockConversation[];
  messages: MockMessage[];
  selectedConversationId: string | null;
  messagesByConversationId?: Record<string, MockMessage[]>;
  conversationCompactionStatusById: Record<
    string,
    {
      phase: 'compacting' | 'safety_compacting' | 'model_switch_compacting' | 'recovering_overflow' | 'compacted' | 'degraded' | 'too_large' | 'needs_manual_compaction' | 'blocked';
      upToMessageId?: string | null;
      updatedAt?: string | null;
      summaryText?: string | null;
      footprintAfter?: {
        usableContextRatio?: number;
        totalContextRatio?: number;
      };
    }
  >;
  sessionCompactionEventsByConversationId: Record<
    string,
    Array<{
      id: string;
      status: 'running' | 'completed';
      displayAfterMessageId?: string | null;
      logicalUpToMessageId?: string | null;
      kind?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
    }>
  >;
  contextDiagnosticsByConversationId: Record<string, unknown>;
  getConversationRuntime: (conversationId: string) => {
    phase: 'idle' | 'preparing' | 'overflow_recovery' | 'streaming' | 'error';
    sessionId: string | null;
    assistantMessageId?: string | null;
    lastError?: string | null;
    lastErrorOrigin?: 'macro' | 'provider' | null;
    lastErrorDisplayTarget?: 'composer' | 'transcript' | null;
  };
  createConversation: ReturnType<typeof mock>;
  ensureConversationForCurrentMode: ReturnType<typeof mock>;
  getConversationMessages: (conversationId: string) => MockMessage[];
  questionnaireDraftsByConversationId: Record<
    string,
    {
      mode?: 'pending_reply' | 'editing_response';
      assistantMessageId: string;
      responseMessageId?: string;
      currentStepIndex: number;
      answersByStepId: Record<string, string>;
      draftTextByStepId: Record<string, string>;
    }
  >;
  pendingToolApprovalByConversationId: Record<
    string,
    {
      conversationId: string;
      assistantMessageId: string;
      toolCallId: string;
        toolId: string;
        actionGroup: 'observe' | 'change' | 'escape';
        riskLevel: 'strict' | 'balanced' | 'yolo';
        isDestructive?: boolean;
        summary: string;
        detail?: string;
        args?: Record<string, unknown>;
        rememberKey: string;
    }
  >;
  skillTurnFeedbackByMessageId: Record<string, unknown>;
  getPendingToolApproval: ReturnType<typeof mock>;
  approvePendingToolApprovalOnce: ReturnType<typeof mock>;
  approvePendingToolApprovalForConversation: ReturnType<typeof mock>;
  denyPendingToolApproval: ReturnType<typeof mock>;
  getActiveQuestionnaire: ReturnType<typeof mock>;
  startQuestionnaireResponseEdit: ReturnType<typeof mock>;
  cancelQuestionnaireSession: ReturnType<typeof mock>;
  setActiveQuestionnaireStep: ReturnType<typeof mock>;
  setActiveQuestionnaireDraftText: ReturnType<typeof mock>;
  recordActiveQuestionnaireAnswer: ReturnType<typeof mock>;
  submitActiveQuestionnaire: ReturnType<typeof mock>;
  hydrationStatus: 'idle' | 'hydrating' | 'ready' | 'error';
  restoreStatus: 'idle' | 'resolving' | 'ready' | 'error';
  isLoading: boolean;
  isStreaming: boolean;
  sendState: 'idle' | 'preparing' | 'streaming' | 'error';
  lastError: string | null;
  stopStreaming: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
  submitDuringActiveTurn: ReturnType<typeof mock>;
  clearLastError: ReturnType<typeof mock>;
  clearConversationRuntimeError: ReturnType<typeof mock>;
  editMessage: ReturnType<typeof mock>;
  getAgentCodeReplayPreview: ReturnType<typeof mock>;
  restoreAgentCodeForReplay: ReturnType<typeof mock>;
  rollbackPendingAgentCodeReplay: ReturnType<typeof mock>;
  getMessageImages: ReturnType<typeof mock>;
  setMessageImages: ReturnType<typeof mock>;
  compactConversationNow: ReturnType<typeof mock>;
  refreshConversationContextDiagnostics: ReturnType<typeof mock>;
  pendingComposerDraftByConversationId: Record<string, string>;
  setComposerDraft: ReturnType<typeof mock>;
  peekComposerDraft: ReturnType<typeof mock>;
  consumeComposerDraft: ReturnType<typeof mock>;
  acknowledgeComposerDraft: ReturnType<typeof mock>;
  saveComposerDraftForContext: ReturnType<typeof mock>;
  getComposerDraftForContext: ReturnType<typeof mock>;
  clearComposerDraftForContext: ReturnType<typeof mock>;
  migrateComposerDraftContext: ReturnType<typeof mock>;
  architectPlanNamingRecovery: {
    conversationId: string;
    planId: string;
    targetBranch: string;
    firstUserContent: string;
    providerId: string;
    modelId: string;
    stage: 'choice' | 'manual';
    isSubmitting: boolean;
    error: string | null;
  } | null;
  setArchitectPlanNamingRecoveryStage: ReturnType<typeof mock>;
  retryArchitectPlanNamingRecovery: ReturnType<typeof mock>;
  submitArchitectPlanManualName: ReturnType<typeof mock>;
  composerContextRefs: unknown[];
  addComposerContextRef: ReturnType<typeof mock>;
  clearComposerContextRefs: ReturnType<typeof mock>;
};

export type AppStoreState = {
  mode: AppMode;
  agentType: 'build' | 'plan';
  setAgentType: ReturnType<typeof mock>;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  projectGroups: unknown[];
  activeArchitectPlanId: string | null;
  activePlanContext: { id: string; [key: string]: unknown } | null;
  planNodes: unknown[];
  predictedBranches: unknown[];
  openSettings: ReturnType<typeof mock>;
  setLeftPanelOpen: ReturnType<typeof mock>;
};

type ProviderState = {
  selectedProviderId: string | null;
  selectedModelId: string | null;
  selectedReasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
  selectedSupportsNativeToolCalling: () => boolean;
  ensureSelectedModelContextMetadata: ReturnType<typeof mock>;
};

type ShortcutsState = {
  promptHistoryNavigationMode: string;
};

export type TaskState = {
  tasks: Array<{
    id: string;
    title: string;
    draft?: boolean;
    task_source?: 'architect' | 'standalone' | 'plan_finalization';
    is_blocked?: boolean;
    blocked_by?: string[];
    status?: string;
    execution_targets?: Array<{ projectId: string }>;
    project_ids?: string[];
    project_id?: string | null;
    plan_id?: string | null;
    branch_name?: string;
    dependencies?: string[];
    estimated_changes?: Array<{ operation: string; path: string }>;
    description?: string;
    todos?: Array<{
      id: string;
      title: string;
      description?: string;
      status: 'pending' | 'in-progress' | 'done';
    }>;
  }>;
  getTaskById: (taskId: string) => TaskState['tasks'][number] | null;
  startTask: ReturnType<typeof mock>;
};

let appState: AppStoreState;
let chatState: MockChatState;
let providerState: ProviderState;
let shortcutsState: ShortcutsState;
let taskState: TaskState;
let skillsState: { getSkillById: ReturnType<typeof mock>; refreshSkills: ReturnType<typeof mock> };
let composerDraftsByContextKey: Record<string, ComposerDraft>;

const getMockConversationRuntime = (
  state: MockChatState,
  conversationId: string,
): ReturnType<MockChatState['getConversationRuntime']> => {
  const isSelectedConversation = state.selectedConversationId === conversationId;
  const phase: 'idle' | 'preparing' | 'streaming' | 'error' = isSelectedConversation
    ? state.sendState === 'streaming' || state.isStreaming
      ? 'streaming'
      : state.sendState === 'preparing'
        ? 'preparing'
        : state.sendState === 'error' || Boolean(state.lastError)
          ? 'error'
          : 'idle'
    : 'idle';
  const latestAssistantMessage = [...state.messages]
    .reverse()
    .find((message: MockMessage) => message.role === 'assistant');

  return {
    phase,
    sessionId: phase === 'idle' ? null : `session-${conversationId || 'unknown'}`,
    assistantMessageId: phase === 'streaming' || phase === 'preparing'
      ? latestAssistantMessage?.id ?? null
      : null,
    lastError: phase === 'error' ? state.lastError : null,
    lastErrorOrigin: phase === 'error' && state.lastError ? 'macro' : null,
    lastErrorDisplayTarget: phase === 'error' && state.lastError ? 'composer' : null,
  };
};

const useAppStore = createStoreHookMock(() => appState, (nextState) => {
  appState = nextState;
});
const useChatStore = createStoreHookMock(() => chatState, (nextState) => {
  chatState = nextState;
});
const useProviderStore = createStoreHookMock(() => providerState, (nextState) => {
  providerState = nextState;
});
const useSkillsStore = createStoreHookMock(() => skillsState, (nextState) => {
  skillsState = nextState;
});
const useShortcutsStore = createStoreHookMock(() => shortcutsState, (nextState) => {
  shortcutsState = nextState;
});
const useTaskStore = createStoreHookMock(() => taskState, (nextState) => {
  taskState = nextState;
});
const translationMock = createTranslationMock({
  'chat.typeMessage': 'Type your message',
  'chat.stop': 'Stop',
  'chat.newConversation': 'New Conversation',
  'architect.selectPlanToStart': 'Select or create a plan to start architecting.',
  'architect.createFirstPlanToStart': 'Create your first plan to start architecting.',
  'architect.selectExistingPlanToStart': 'Select a plan to start architecting.',
  'architect.createPlanAction': 'Create a plan',
  'architect.selectPlanAction': 'Select a plan',
  'chat.toolTurnLimitNoticeTitle': 'Tool turn limit reached',
  'chat.toolTurnLimitNoticeDescription': 'Macro stopped the agent loop. Change it in Settings > General > Max agent turns.',
  'chat.toolTurnLimitFallbackTitle': 'Tool turn limit reached',
  'chat.toolTurnLimitFallbackDescription': 'Macro showed a fallback summary.',
  'chat.contextWindow.ariaLabel': 'Diagnostic du contexte',
  'chat.contextWindow.titleWithPercent': '{{label}} · {{percent}} du budget utile',
  'chat.contextWindow.status.window': 'Fenêtre de contexte',
  'chat.contextWindow.status.compacting': 'Compactage en cours',
  'chat.contextWindow.providerFallback': 'Provider',
  'chat.contextWindow.modelFallback': 'Modèle non sélectionné',
  'chat.contextWindow.usefulBudgetShort': 'budget utile',
  'chat.contextWindow.compactButton.none': 'Rien à compacter',
  'chat.contextWindow.compactButton.aggressive': 'Compacter plus agressivement',
  'chat.contextWindow.compactButton.default': 'Compacter maintenant',
  'chat.contextWindow.metrics.payload': 'Payload',
  'chat.contextWindow.metrics.modelLimit': 'Limite modèle',
  'chat.contextWindow.metrics.estimatedLimit': 'Limite estimée',
  'chat.contextWindow.metrics.usefulBudget': 'Budget utile',
  'chat.contextWindow.metrics.margin': 'Marge',
  'chat.contextWindow.metrics.limitSource': 'Source limite',
  'chat.contextWindow.metrics.confidence': 'Confiance',
  'chat.contextWindow.metrics.totalContext': 'Contexte total',
  'chat.contextWindow.metrics.checkpoint': 'Checkpoint',
  'chat.contextWindow.limitSource.providerMetadata': 'Provider',
  'chat.contextWindow.limitSource.macroFallback': 'Fallback Macro',
  'chat.contextWindow.confidence.verified': 'Vérifiée',
  'chat.contextWindow.none': 'Aucun',
  'chat.contextWindow.manual.action': 'Action manuelle',
  'chat.contextWindow.manual.latestResult': 'Dernier résultat',
  'chat.contextWindow.manual.feedback.compactedLabel': 'Checkpoint créé',
  'chat.contextWindow.manual.feedback.compactedDetail': '{{tokens}} tokens économisés',
  'chat.contextWindow.compaction': 'Compaction',
  'chat.contextWindow.countSummary': '{{messages}} messages · {{sources}} sources',
  'chat.contextWindow.refresh': 'Actualiser',
});
const scrollContainerRef = { current: null as HTMLDivElement | null };
const markdownRendererContentMock = mock(
  (_content: string, _isStreaming: boolean) => undefined,
);
const scrollMagnetActiveValues: boolean[] = [];
let composerEditorValue = '';
let messageEditEditorValue = '';
let composerEditorSetTextCalls: string[] = [];
let composerEditorFocusCalls = 0;
let latestComposerProps: Record<string, unknown> | null = null;
const notifyInfoMock = mock(() => undefined);
const notifySuccessMock = mock(() => undefined);
const notifyWarningMock = mock(() => undefined);
const notifyErrorMock = mock(() => undefined);
const notifyActionRequiredMock = mock(() => undefined);

let ChatZone!: typeof import('./ChatZone').default;
let importCounter = 0;
const hadInitialActEnvironment = Object.prototype.hasOwnProperty.call(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);
const initialActEnvironment = (
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT;
const hadInitialRequestAnimationFrame = Object.prototype.hasOwnProperty.call(
  globalThis,
  'requestAnimationFrame',
);
const initialRequestAnimationFrame = globalThis.requestAnimationFrame;

const resetNotifyMocks = () => {
  notifyInfoMock.mockClear();
  notifySuccessMock.mockClear();
  notifyWarningMock.mockClear();
  notifyErrorMock.mockClear();
  notifyActionRequiredMock.mockClear();
};

const loadChatZoneModule = async () => {
  importCounter += 1;
  mock.restore();

  installReactI18nextMock(translationMock);

  mock.module('../../stores/useAppStore', () => ({
    useAppStore,
  }));

  mock.module('../../stores/useChatStore', () => ({
    useChatStore,
  }));

  mock.module('../../stores/useSkillsStore', () => ({
    useSkillsStore,
  }));

  mock.module('../../stores/useProviderStore', () => ({
    useProviderStore,
    providerHasCredentials: (provider: {
      isEnabled?: boolean;
      isLocal?: boolean;
      apiKey?: string;
      hasStoredApiKey?: boolean;
      authStatus?: string;
    }) =>
      !!provider.isEnabled &&
      (!!provider.isLocal ||
        !!provider.apiKey ||
        !!provider.hasStoredApiKey ||
        provider.authStatus === 'connected' ||
        provider.authStatus === 'authenticated'),
  }));

  mock.module('../../stores/useShortcutsStore', () => ({
    useShortcutsStore,
  }));

  mock.module('../../stores/useTaskStore', () => ({
    getTaskLifecycleCapabilities: () => ({
      isPublished: false,
      canRename: true,
      canDelete: false,
      canArchive: false,
      canRestore: false,
      canReopen: false,
      deleteBlockReason: null,
    }),
    getPlanActivationCandidateTask: () => null,
    useTaskStore,
  }));

  mock.module('../../hooks/useScrollMagnet', () => ({
    useScrollMagnet: (isActive: boolean) => {
      scrollMagnetActiveValues.push(isActive);
      return {
        scrollContainerRef,
        separatorState: 'hidden',
      };
    },
  }));

  mock.module('../../hooks/usePerformanceMonitor', () => ({
    usePerformanceMonitor: () => ({
      mark: () => undefined,
    }),
  }));

  mock.module('../ui/Icon', () => ({
    Icon: ({ name, className }: { name: string; className?: string }) => (
      <span data-icon={name} className={className} />
    ),
  }));

  mock.module('../ui/toastService', () => ({
    notify: {
      info: notifyInfoMock,
      success: notifySuccessMock,
      warning: notifyWarningMock,
      error: notifyErrorMock,
      actionRequired: notifyActionRequiredMock,
    },
  }));

  mock.module('../ai/ProviderDropdown', () => ({
    ProviderDropdown: () => <div data-testid="provider-dropdown" />,
  }));

  mock.module('../ai/ModelDropdown', () => ({
    ModelDropdown: () => <div data-testid="model-dropdown" />,
  }));

  mock.module('../ai/ReasoningDropdown', () => ({
    ReasoningDropdown: () => <div data-testid="reasoning-dropdown" />,
  }));

  mock.module('./MarkdownRenderer', () => ({
    MarkdownRenderer: ({
      content,
      isStreaming = false,
    }: {
      content: string;
      isStreaming?: boolean;
    }) => {
      markdownRendererContentMock(content, isStreaming);
      return <div data-testid="markdown-renderer">{content}</div>;
    },
  }));

  mock.module('./ScrollSeparator', () => ({
    ScrollSeparator: () => <div data-testid="scroll-separator" />,
  }));

  mock.module('../modals/ImagePreviewModal', () => ({
    ImagePreviewModal: () => null,
  }));

  mock.module('../architect/PlanSelector', () => ({
    PlanSelector: () => null,
  }));

  mock.module('./composer/LazyComposerEditor', () => ({
    __esModule: true,
    default: React.forwardRef((props: Record<string, unknown>, ref: React.ForwardedRef<{
      getTextContent: () => string;
      clear: () => void;
      setText: (_value: string) => void;
      focus: () => void;
    }>) => {
      const isMessageEdit = props.surface === 'message-edit';
      const chipSurface = typeof props.surface === 'string' ? props.surface : 'composer';
      if (isMessageEdit && typeof props.initialText === 'string') {
        messageEditEditorValue = props.initialText;
      }
      React.useEffect(() => {
        if (!isMessageEdit) {
          latestComposerProps = props;
        }
      }, [isMessageEdit, props]);
      React.useImperativeHandle(ref, () => ({
        getTextContent: () => isMessageEdit ? messageEditEditorValue : composerEditorValue,
        clear: () => {
          if (isMessageEdit) {
            messageEditEditorValue = '';
          } else {
            composerEditorValue = '';
          }
        },
        setText: (value: string) => {
          if (isMessageEdit) {
            messageEditEditorValue = value;
          } else {
            composerEditorValue = value;
            composerEditorSetTextCalls.push(value);
          }
        },
        focus: () => {
          if (!isMessageEdit) {
            composerEditorFocusCalls += 1;
          }
        },
      }));
      const value = isMessageEdit ? messageEditEditorValue : composerEditorValue;
      const renderedParts = value
        ? value.split(/(\[(?:need|skill):\s*[^\]]+\])/gi).map((part, index) => {
            const match = /^\[(need|skill):\s*([^\]]+)\]$/i.exec(part);
            if (!match) return part;
            const kind = match[1].toLowerCase();
            const title = match[2].trim();
            return (
              <span
                key={`${kind}-${title}-${index}`}
                data-context-reference-kind={kind}
                data-context-reference-surface={chipSurface}
              >
                {kind === 'skill' ? 'Skill' : 'Need'} {title}
              </span>
            );
          })
        : null;
      return (
        <div>
          <div data-testid={isMessageEdit ? 'message-edit-rich-preview' : 'composer-rich-preview'}>
            {renderedParts}
          </div>
          <textarea
            data-testid={isMessageEdit ? 'message-edit-editor' : 'composer-editor'}
            disabled={props.editable === false}
            placeholder={typeof props.placeholder === 'string' ? props.placeholder : ''}
            value={value}
            onChange={(event) => {
              if (isMessageEdit) {
                messageEditEditorValue = event.target.value;
              } else {
                composerEditorValue = event.target.value;
              }
              if (typeof props.onTextChange === 'function') {
                props.onTextChange(event.target.value);
              }
            }}
          />
        </div>
      );
    }),
  }));

  const actualGlobalProjects = await import(
    `../../services/globalProjects.ts?chat-zone-global-projects-test=${importCounter}`
  );
  const actualPreferences = await import(
    `../../services/preferences.ts?chat-zone-preferences-test=${importCounter}`
  );

  mock.module('../../services/globalProjects', () => ({
    ...actualGlobalProjects,
    getFocusedProjectForGroup: () => null,
    getGlobalProjectById: () => null,
  }));

  mock.module('../../services/preferences', () => ({
    ...actualPreferences,
    loadPreference: mock(async (key: string) =>
      actualPreferences.PREF_DEFAULTS[
        key as keyof typeof actualPreferences.PREF_DEFAULTS
      ]
    ),
    subscribePreference: mock(() => () => undefined),
  }));

  await Promise.all([
    import('./AgentCodeReplayConfirmModal'),
    import('../architect/ArchitectPlanNamingRecoveryModal'),
  ]);
  ({ default: ChatZone } = await import(`./ChatZone.tsx?chat-zone-test=${importCounter}`));
};

const preloadChatZoneLazyComponents = async () => {
  await Promise.all([
    import('./ConversationGoalBanner'),
    import('./QuestionnaireFooter'),
    import('./ToolApprovalFooter'),
    import('./QuestionnaireResponseSummary'),
    import('./ImplementTaskTodoDropdown'),
    import('./ContextWindowIndicator'),
    import('./AgentCodeReplayConfirmModal'),
    import('../modals/ImagePreviewModal'),
    import('../architect/ArchitectPlanNamingRecoveryModal'),
    import('../architect/PlanFormModal'),
  ]);
};

const buildConversation = (): MockConversation => ({
  id: 'conv-1',
  title: 'New Conversation',
  scope_mode: 'Chat',
  task_id: null,
  project_id: null,
  group_id: null,
});

const buildMessage = (overrides: Partial<MockMessage>): MockMessage => ({
  id: 'msg-1',
  conversation_id: 'conv-1',
  role: 'user',
  content: 'Bonjour Macro',
  timestamp: '2026-03-29T10:00:00.000Z',
  task_id: null,
  tool_traces: [],
  ...overrides,
});

export const buildCompactionEvent = (
  overrides: Partial<
    MockChatState['sessionCompactionEventsByConversationId'][string][number]
  > = {},
): MockChatState['sessionCompactionEventsByConversationId'][string][number] => ({
  id: 'compaction-event-1',
  status: 'completed',
  displayAfterMessageId: 'msg-assistant-1',
  logicalUpToMessageId: 'msg-assistant-1',
  kind: 'manual',
  startedAt: '2026-05-10T08:30:00.000Z',
  completedAt: '2026-05-10T08:30:00.000Z',
  ...overrides,
});

export const buildCompactionFootprint = (
  overrides: {
    usableContextRatio?: number;
    totalContextRatio?: number;
  } = {},
) => ({
  usableContextRatio: 0.42,
  totalContextRatio: 0.5,
  ...overrides,
});

export const buildManualCompactionCompletedResult = (
  overrides: Record<string, unknown> = {},
) => ({
  outcome: 'compacted' as const,
  updatedAt: '2026-05-10T08:30:00.000Z',
  footprintBefore: {
    totalEstimatedTokens: 12_000,
  },
  footprintAfter: {
    totalEstimatedTokens: 4_000,
  },
  tokensSaved: 8_000,
  upToMessageId: 'msg-assistant-1',
  summarySource: 'model',
  ...overrides,
});

export const buildManualCompactionSkippedResult = (
  overrides: Record<string, unknown> = {},
) => ({
  outcome: 'skipped' as const,
  updatedAt: '2026-05-10T08:30:00.000Z',
  reason: 'below_threshold' as const,
  footprintBefore: {
    totalEstimatedTokens: 800,
  },
  userTurnCount: 3,
  retainedTurnCount: 2,
  ...overrides,
});

const buildProjectGroups = () => [
  {
    id: 'group-1',
    name: 'Platform',
    projects: [
      {
        id: 'project-1',
        name: 'API',
        path: '/tmp/api',
        isReadOnly: false,
      },
    ],
  },
];

const resetState = () => {
  useConversationGoalStore.setState({ goalsByConversationId: {} });
  useConversationArchiveStore.setState({
    archivedConversationIds: new Set(),
    isArchiveHydrated: true,
    archiveHydrationError: null,
  });
  composerDraftsByContextKey = {};
  appState = {
    mode: 'Chat',
    agentType: 'build',
    setAgentType: mock(() => undefined),
    selectedGroupId: 'group-1',
    selectedProjectId: null,
    selectedTaskId: null,
    projectGroups: buildProjectGroups(),
    activeArchitectPlanId: null,
    activePlanContext: null,
    planNodes: [],
    predictedBranches: [],
    openSettings: mock(() => undefined),
    setLeftPanelOpen: mock(() => undefined),
  };

  chatState = {
    conversations: [buildConversation()],
    messages: [],
    selectedConversationId: 'conv-1',
    conversationCompactionStatusById: {},
    sessionCompactionEventsByConversationId: {},
    contextDiagnosticsByConversationId: {},
    getConversationRuntime: (conversationId: string) =>
      getMockConversationRuntime(chatState, conversationId),
    createConversation: mock(async () => buildConversation()),
    ensureConversationForCurrentMode: mock(async () => 'conv-1'),
    getConversationMessages: (conversationId: string) =>
      chatState.messages.filter((message) => message.conversation_id === conversationId),
    questionnaireDraftsByConversationId: {},
    pendingToolApprovalByConversationId: {},
    skillTurnFeedbackByMessageId: {},
    getPendingToolApproval: mock((conversationId: string) =>
      chatState.pendingToolApprovalByConversationId[conversationId] ?? null
    ),
    approvePendingToolApprovalOnce: mock(() => undefined),
    approvePendingToolApprovalForConversation: mock(() => undefined),
    denyPendingToolApproval: mock(() => undefined),
    getActiveQuestionnaire: mock(() => null),
    startQuestionnaireResponseEdit: mock(() => false),
    cancelQuestionnaireSession: mock(() => undefined),
    setActiveQuestionnaireStep: mock(() => undefined),
    setActiveQuestionnaireDraftText: mock(() => undefined),
    recordActiveQuestionnaireAnswer: mock(() => ({ completed: true, state: null })),
    submitActiveQuestionnaire: mock(async () => ({ status: 'sent' })),
    hydrationStatus: 'ready',
    restoreStatus: 'ready',
    isLoading: false,
    isStreaming: false,
    sendState: 'idle',
    lastError: null,
    stopStreaming: mock(() => undefined),
    sendMessage: mock(async () => ({ status: 'sent' })),
    submitDuringActiveTurn: mock(async () => 'steered'),
    clearLastError: mock(() => undefined),
    clearConversationRuntimeError: mock(() => undefined),
    editMessage: mock(async () => undefined),
    getAgentCodeReplayPreview: mock(async () => null),
    restoreAgentCodeForReplay: mock(async () => undefined),
    rollbackPendingAgentCodeReplay: mock(async () => undefined),
    getMessageImages: mock(() => []),
    setMessageImages: mock(() => undefined),
    compactConversationNow: mock(async () => buildManualCompactionSkippedResult()),
    refreshConversationContextDiagnostics: mock(async () => undefined),
    pendingComposerDraftByConversationId: {},
    setComposerDraft: mock(() => undefined),
    peekComposerDraft: mock(() => null),
    consumeComposerDraft: mock(() => null),
    acknowledgeComposerDraft: mock(() => undefined),
    saveComposerDraftForContext: mock((contextKey: string, draft: ComposerDraft) => {
      composerDraftsByContextKey[contextKey] = {
        text: draft.text,
        images: [...draft.images],
        contextRefs: draft.contextRefs.map((ref) => ({ ...ref })),
      };
    }),
    getComposerDraftForContext: mock((contextKey: string) => {
      const draft = composerDraftsByContextKey[contextKey];
      return draft
        ? {
            text: draft.text,
            images: [...draft.images],
            contextRefs: draft.contextRefs.map((ref) => ({ ...ref })),
          }
        : null;
    }),
    clearComposerDraftForContext: mock((contextKey: string) => {
      delete composerDraftsByContextKey[contextKey];
    }),
    migrateComposerDraftContext: mock((fromContextKey: string, toContextKey: string) => {
      if (!fromContextKey || !toContextKey || fromContextKey === toContextKey) return;
      const draft = composerDraftsByContextKey[fromContextKey];
      if (!draft) return;
      delete composerDraftsByContextKey[fromContextKey];
      composerDraftsByContextKey[toContextKey] = draft;
    }),
    architectPlanNamingRecovery: null,
    setArchitectPlanNamingRecoveryStage: mock(() => undefined),
    retryArchitectPlanNamingRecovery: mock(async () => false),
    submitArchitectPlanManualName: mock(async () => false),
    composerContextRefs: [],
    addComposerContextRef: mock((ref: unknown) => {
      chatState = {
        ...chatState,
        composerContextRefs: [...chatState.composerContextRefs, ref],
      };
      useChatStore.emit();
    }),
    clearComposerContextRefs: mock(() => {
      chatState = {
        ...chatState,
        composerContextRefs: [],
      };
      useChatStore.emit();
    }),
  };

  providerState = {
    selectedProviderId: 'provider-1',
    selectedModelId: 'model-1',
    selectedReasoningEffort: 'high',
    selectedSupportsNativeToolCalling: () => true,
    ensureSelectedModelContextMetadata: mock(async () => []),
  };


  skillsState = {
    getSkillById: mock(() => null),
    refreshSkills: mock(async () => undefined),
  };

  shortcutsState = {
    promptHistoryNavigationMode: 'default',
  };

  taskState = {
    tasks: [],
    getTaskById: (taskId: string) =>
      taskState.tasks.find((task) => task.id === taskId) ?? null,
    startTask: mock(async () => undefined),
  };
  composerEditorValue = '';
  messageEditEditorValue = '';
  composerEditorSetTextCalls = [];
  composerEditorFocusCalls = 0;
  latestComposerProps = null;
  scrollMagnetActiveValues.length = 0;
};

describe('ChatZone', () => {
  let container: HTMLDivElement | null;
  let root: Root | null;

  const requireContainer = (): HTMLDivElement => {
    if (!container) {
      throw new Error('Expected mounted container');
    }
    return container;
  };

  const requireRoot = (): Root => {
    if (!root) {
      throw new Error('Expected mounted root');
    }
    return root;
  };

  const getComposerEditor = (): HTMLTextAreaElement => {
    const editor = requireContainer().querySelector(
      '[data-testid="composer-editor"]'
    ) as HTMLTextAreaElement | null;
    if (!editor) {
      throw new Error('Expected composer editor');
    }
    return editor;
  };

  const setComposerText = async (value: string): Promise<HTMLTextAreaElement> => {
    const editor = getComposerEditor();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        editor,
        value
      );
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    return editor;
  };

  const pasteComposerImage = async (): Promise<void> => {
    const initialFileReader = globalThis.FileReader;
    const initialImage = globalThis.Image;
    class TestFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

      readAsDataURL(): void {
        this.result = 'data:image/png;base64,ZHJhZnQtaW1hZ2U=';
        this.onload?.(new Event('load') as unknown as ProgressEvent<FileReader>);
      }
    }
    class TestImage {
      width = 16;
      height = 16;
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event | string) => void) | null = null;

      set src(_value: string) {
        this.onload?.(new Event('load'));
      }
    }

    globalThis.FileReader = TestFileReader as unknown as typeof FileReader;
    globalThis.Image = TestImage as unknown as typeof Image;
    const file = new File(['draft-image'], 'draft.png', { type: 'image/png' });
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [{
          type: 'image/png',
          getAsFile: () => file,
        }],
      },
    });

    try {
      await act(async () => {
        getComposerEditor().dispatchEvent(pasteEvent);
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      });
    } finally {
      globalThis.FileReader = initialFileReader;
      globalThis.Image = initialImage;
    }
  };

  const clickSendButton = async () => {
    const sendButton = requireContainer().querySelector(
      '[data-tour-id="chat-send-button"]'
    );
    if (!sendButton) {
      throw new Error('Expected send button');
    }
    await act(async () => {
      sendButton.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });
  };

  const clickFirstMessageEditButton = async () => {
    const editButton = requireContainer().querySelector('button[title="common.edit"]');
    if (!editButton) {
      throw new Error('Expected edit button');
    }
    await act(async () => {
      editButton.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });
  };

  const clickButtonWithText = async (label: string) => {
    const button = Array.from(requireContainer().querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label
    );
    if (!button) {
      throw new Error(`Expected button with text: ${label}`);
    }
    await act(async () => {
      button.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });
  };

  const dispatchPromptHistory = async (direction: 'up' | 'down') => {
    await act(async () => {
      window.dispatchEvent(new CustomEvent('macro:prompt-history', {
        detail: { direction },
      }));
      await Promise.resolve();
    });
  };

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    installTauriRuntimeMock();
    if (!globalThis.requestAnimationFrame) {
      globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 0) as unknown as number;
    }

    await loadChatZoneModule();
    await preloadChatZoneLazyComponents();
    resetState();
    resetNotifyMocks();
    markdownRendererContentMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    document.body.innerHTML = '';
    removeTauriRuntimeMock();
    if (hadInitialActEnvironment) {
      (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
        .IS_REACT_ACT_ENVIRONMENT = initialActEnvironment;
    } else {
      Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
    if (hadInitialRequestAnimationFrame) {
      globalThis.requestAnimationFrame = initialRequestAnimationFrame;
    } else {
      Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    }
    mock.restore();
  });

  afterAll(() => {
    mock.restore();
  });

  it('renders the first user message when the selected conversation has messages', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Bonjour Macro' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '',
          tool_traces: [],
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Bonjour Macro');
    expect(requireContainer().textContent).not.toContain('Type your message');
  });

  it('keeps the composer locked until archived conversations are hydrated', async () => {
    useConversationArchiveStore.setState({
      archivedConversationIds: new Set(),
      isArchiveHydrated: false,
      archiveHydrationError: null,
    });

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const composer = requireContainer().querySelector<HTMLTextAreaElement>(
      '[data-testid="composer-editor"]'
    );
    expect(composer?.disabled).toBe(true);
    expect(composer?.placeholder).toBe('Restoring conversation...');
  });

  it('does not render the legacy skills dropdown in the composer control row', async () => {
    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().querySelector('[data-tour-id="skill-dropdown"]')).toBeNull();
    expect(requireContainer().querySelector('[data-tour-id="chat-control-row"]')).not.toBeNull();
  });

  it('activates Goal mode from the composer and sends only the objective', async () => {
    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await setComposerText('/goal Finish the authentication migration');
    expect(
      requireContainer().querySelector('[data-chat-composer-goal="true"]'),
    ).not.toBeNull();
    await clickSendButton();

    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: 'Finish the authentication migration',
      taskId: null,
      images: [],
    });
    expect(
      useConversationGoalStore.getState().goalsByConversationId['conv-1'],
    ).toMatchObject({
      objective: 'Finish the authentication migration',
      status: 'audit_pending',
    });
    expect(
      requireContainer().querySelector('[data-conversation-goal-banner]')?.textContent,
    ).toContain('Finish the authentication migration');
  });

  it('keeps the Goal control outside the composer and removes the command', async () => {
    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await setComposerText('/goal Finish the authentication migration');
    const composer = requireContainer().querySelector('[data-tour-id="chat-composer"]');
    const control = requireContainer().querySelector(
      '[data-chat-goal-command-control="true"]',
    );
    expect(control).not.toBeNull();
    expect(control?.nextElementSibling).toBe(composer);
    expect(control?.classList.contains('self-center')).toBe(true);
    expect(control?.classList.contains('border')).toBe(false);
    expect(control?.classList.contains('bg-primary/[0.045]')).toBe(false);

    await act(async () => {
      control?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(composerEditorSetTextCalls.at(-1)).toBe('Finish the authentication migration');
    expect(
      requireContainer().querySelector('[data-chat-goal-command-control="true"]'),
    ).toBeNull();
    expect(
      requireContainer().querySelector('[data-chat-composer-goal="true"]'),
    ).toBeNull();
  });

  it('reopens the active objective as a Goal draft from the compact bar', async () => {
    useConversationGoalStore.getState().activateGoal({
      conversationId: 'conv-1',
      objective: 'Finish the authentication migration',
    });

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const editGoalButton = requireContainer().querySelector(
      'button[aria-label="Edit goal"]',
    );
    expect(editGoalButton).not.toBeNull();

    await act(async () => {
      editGoalButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(composerEditorSetTextCalls.at(-1)).toBe(
      '/goal Finish the authentication migration',
    );
    expect(getComposerEditor().value).toBe(
      '/goal Finish the authentication migration',
    );
  });

  it('isolates and restores the existing draft after editing a Goal', async () => {
    const draftRef = {
      kind: 'skill',
      id: 'global:draft-skill',
      title: 'draft-skill',
      data: {},
    };
    chatState = {
      ...chatState,
      composerContextRefs: [draftRef],
      sendMessage: mock(async () => ({ status: 'sent' })),
    };
    useConversationGoalStore.getState().activateGoal({
      conversationId: 'conv-1',
      objective: 'Finish the authentication migration',
    });

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await setComposerText('Unrelated draft');
    await pasteComposerImage();
    expect(requireContainer().querySelector('img[alt="Pasted image"]')).not.toBeNull();

    const editGoalButton = requireContainer().querySelector(
      'button[aria-label="Edit goal"]',
    );
    await act(async () => {
      editGoalButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(getComposerEditor().value).toBe(
      '/goal Finish the authentication migration',
    );
    expect(requireContainer().querySelector('img[alt="Pasted image"]')).toBeNull();
    expect(chatState.composerContextRefs).toEqual([]);

    await setComposerText('/goal Finish the authentication migration safely');
    await clickSendButton();

    expect(chatState.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      content: 'Finish the authentication migration safely',
      images: [],
    }));
    expect(getComposerEditor().value).toBe('Unrelated draft');
    expect(requireContainer().querySelector('img[alt="Pasted image"]')).not.toBeNull();
    expect(chatState.composerContextRefs).toEqual([draftRef]);
  });

  it('restores the existing draft when Goal editing is cancelled', async () => {
    const draftRef = {
      kind: 'file',
      id: 'file:/repo/draft.ts',
      title: 'draft.ts',
      data: {},
    };
    chatState = {
      ...chatState,
      composerContextRefs: [draftRef],
    };
    useConversationGoalStore.getState().activateGoal({
      conversationId: 'conv-1',
      objective: 'Finish the authentication migration',
    });

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    await setComposerText('Draft to restore');

    const editGoalButton = requireContainer().querySelector(
      'button[aria-label="Edit goal"]',
    );
    await act(async () => {
      editGoalButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const removeGoalControl = requireContainer().querySelector(
      '[data-chat-goal-command-control="true"]',
    );
    await act(async () => {
      removeGoalControl?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(chatState.sendMessage).not.toHaveBeenCalled();
    expect(getComposerEditor().value).toBe('Draft to restore');
    expect(chatState.composerContextRefs).toEqual([draftRef]);
  });

  it('restores the existing draft when the Goal command is removed manually', async () => {
    useConversationGoalStore.getState().activateGoal({
      conversationId: 'conv-1',
      objective: 'Finish the authentication migration',
    });

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    await setComposerText('Draft to restore');

    const editGoalButton = requireContainer().querySelector(
      'button[aria-label="Edit goal"]',
    );
    await act(async () => {
      editGoalButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await setComposerText('Plain text without the command');

    expect(getComposerEditor().value).toBe('Draft to restore');
    expect(chatState.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps Goal editing active after a failed send and restores the prior draft on cancel', async () => {
    chatState = {
      ...chatState,
      sendMessage: mock(async () => {
        throw new Error('Provider unavailable');
      }),
    };
    const originalGoal = useConversationGoalStore.getState().activateGoal({
      conversationId: 'conv-1',
      objective: 'Finish the authentication migration',
    });

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    await setComposerText('Draft kept during retry');

    const editGoalButton = requireContainer().querySelector(
      'button[aria-label="Edit goal"]',
    );
    await act(async () => {
      editGoalButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await setComposerText('/goal Finish the authentication migration safely');
    await clickSendButton();

    expect(getComposerEditor().value).toBe(
      '/goal Finish the authentication migration safely',
    );
    expect(
      useConversationGoalStore.getState().goalsByConversationId['conv-1'],
    ).toEqual(originalGoal);
    const removeGoalControl = requireContainer().querySelector(
      '[data-chat-goal-command-control="true"]',
    );
    expect(removeGoalControl).not.toBeNull();

    await act(async () => {
      removeGoalControl?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(getComposerEditor().value).toBe('Draft kept during retry');
  });

  it('does not overwrite a newer draft when a Goal send resolves after a conversation round trip', async () => {
    const sendDeferred = createDeferred<{ status: 'sent' }>();
    chatState = {
      ...chatState,
      conversations: [
        buildConversation(),
        { ...buildConversation(), id: 'conv-2', title: 'Second conversation' },
      ],
      sendMessage: mock(() => sendDeferred.promise),
    };
    useConversationGoalStore.getState().activateGoal({
      conversationId: 'conv-1',
      objective: 'Finish the authentication migration',
    });

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    await setComposerText('Original conv-1 draft');

    const editGoalButton = requireContainer().querySelector(
      'button[aria-label="Edit goal"]',
    );
    await act(async () => {
      editGoalButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await setComposerText('/goal Finish the authentication migration safely');
    await clickSendButton();

    await act(async () => {
      useChatStore.setState({ selectedConversationId: 'conv-2' });
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    await act(async () => {
      useChatStore.setState({ selectedConversationId: 'conv-1' });
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(getComposerEditor().value).toBe('Original conv-1 draft');

    await setComposerText('Newer conv-1 draft');
    await act(async () => {
      sendDeferred.resolve({ status: 'sent' });
      await sendDeferred.promise;
      await Promise.resolve();
    });

    expect(getComposerEditor().value).toBe('Newer conv-1 draft');

    await act(async () => {
      useChatStore.setState({ selectedConversationId: 'conv-2' });
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    await act(async () => {
      useChatStore.setState({ selectedConversationId: 'conv-1' });
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(getComposerEditor().value).toBe('Newer conv-1 draft');
  });

  it('invalidates Goal restoration during the layout phase of a conversation switch', async () => {
    const sendDeferred = createDeferred<{ status: 'sent' }>();
    const draftRef = {
      kind: 'file',
      id: 'file:/repo/private-a.ts',
      title: 'private-a.ts',
      data: {},
    };
    chatState = {
      ...chatState,
      conversations: [
        buildConversation(),
        { ...buildConversation(), id: 'conv-2', title: 'Second conversation' },
      ],
      composerContextRefs: [draftRef],
      sendMessage: mock(() => sendDeferred.promise),
    };
    useConversationGoalStore.getState().activateGoal({
      conversationId: 'conv-1',
      objective: 'Finish the authentication migration',
    });

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    await setComposerText('Private conv-1 draft');

    const editGoalButton = requireContainer().querySelector(
      'button[aria-label="Edit goal"]',
    );
    await act(async () => {
      editGoalButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await setComposerText('/goal Finish the authentication migration safely');
    await clickSendButton();

    await act(async () => {
      flushSync(() => {
        useChatStore.setState({ selectedConversationId: 'conv-2' });
      });
      sendDeferred.resolve({ status: 'sent' });
      await sendDeferred.promise;
      await Promise.resolve();
    });

    expect(getComposerEditor().value).toBe('');
    expect(chatState.composerContextRefs).toEqual([]);
  });

  it('activates Goal mode from the Architect composer with the current provider selection', async () => {
    appState = {
      ...appState,
      mode: 'Architect',
      activeArchitectPlanId: 'plan-1',
    };
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Plan à charger' }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    const composer = getComposerEditor();
    expect(composer.disabled).toBe(false);

    await setComposerText('/goal Draft the migration plan');
    await clickSendButton();

    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: 'Draft the migration plan',
      taskId: null,
      images: [],
    });
    expect(
      useConversationGoalStore.getState().goalsByConversationId['conv-1'],
    ).toMatchObject({
      objective: 'Draft the migration plan',
      providerId: 'provider-1',
      modelId: 'model-1',
      reasoningEffort: 'high',
      status: 'audit_pending',
    });
  });

  it('activates Goal mode from the Implement composer and sends only the objective for the task', async () => {
    appState = {
      ...appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    taskState = {
      ...taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Quick export',
          draft: false,
          task_source: 'standalone',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: null,
          branch_name: 'feature/quick-export',
          dependencies: [],
          estimated_changes: [],
          description: 'Add CSV export from the table.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    const composer = getComposerEditor();
    expect(composer.disabled).toBe(false);

    await setComposerText('/goal Ship the CSV export end to end');
    await clickSendButton();

    expect(taskState.startTask).not.toHaveBeenCalled();
    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: 'Ship the CSV export end to end',
      taskId: 'task-1',
      images: [],
    });
    expect(
      useConversationGoalStore.getState().goalsByConversationId['conv-1'],
    ).toMatchObject({
      objective: 'Ship the CSV export end to end',
      status: 'audit_pending',
    });
  });

  it('pauses an active goal when the standard chat stop button interrupts the agent', async () => {
    useConversationGoalStore.getState().activateGoal({
      conversationId: 'conv-1',
      objective: 'Finish the authentication migration',
    });
    useConversationGoalStore
      .getState()
      .setOperationalStatus('conv-1', 'executor_running');
    chatState = {
      ...chatState,
      isStreaming: true,
      sendState: 'streaming',
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    const stopButton = requireContainer().querySelector(
      '[data-tour-id="chat-stop-button"]',
    );
    expect(stopButton).not.toBeNull();
    await act(async () => {
      stopButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(chatState.stopStreaming).toHaveBeenCalledTimes(1);
    expect(
      useConversationGoalStore.getState().goalsByConversationId['conv-1']?.status,
    ).toBe('paused');
  });

  it('navigates prompt history while preserving and restoring the current draft', async () => {
    const getContextRefSummaries = () =>
      chatState.composerContextRefs.map((ref) => {
        const contextRef = ref as { id: string; kind: string; title: string };
        return {
          id: contextRef.id,
          kind: contextRef.kind,
          title: contextRef.title,
        };
      });
    const oldRef = {
      kind: 'skill',
      id: 'global:old-skill',
      title: 'old-skill',
      skillFilePath: '/skills/old-skill/SKILL.md',
    };
    const latestRef = {
      kind: 'file',
      id: 'file:/repo/latest.ts',
      title: 'latest.ts',
      path: '/repo/latest.ts',
      relativePath: 'latest.ts',
    };
    const draftRef = {
      kind: 'need',
      id: 'need-draft',
      title: 'Draft need',
      data: {},
    };
    chatState = {
      ...chatState,
      composerContextRefs: [draftRef],
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content: 'Old prompt',
          context_refs: [oldRef],
        }),
        buildMessage({ id: 'msg-assistant-1', role: 'assistant', content: 'Old response' }),
        buildMessage({
          id: 'msg-user-2',
          role: 'user',
          content: 'Latest prompt',
          context_refs: [latestRef],
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await setComposerText('Draft prompt');
    await dispatchPromptHistory('up');
    expect(getComposerEditor().value).toBe('Latest prompt');
    expect(getContextRefSummaries()).toEqual([{
      id: latestRef.id,
      kind: latestRef.kind,
      title: latestRef.title,
    }]);

    await dispatchPromptHistory('up');
    expect(getComposerEditor().value).toBe('Old prompt');
    expect(getContextRefSummaries()).toEqual([{
      id: oldRef.id,
      kind: oldRef.kind,
      title: oldRef.title,
    }]);

    await dispatchPromptHistory('down');
    expect(getComposerEditor().value).toBe('Latest prompt');
    expect(getContextRefSummaries()).toEqual([{
      id: latestRef.id,
      kind: latestRef.kind,
      title: latestRef.title,
    }]);

    await dispatchPromptHistory('down');
    expect(getComposerEditor().value).toBe('Draft prompt');
    expect(getContextRefSummaries()).toEqual([{
      id: draftRef.id,
      kind: draftRef.kind,
      title: draftRef.title,
    }]);
  });

  it('does not reapply the same history prompt when already at the oldest entry', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Only prompt' }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await setComposerText('Only prompt');
    composerEditorSetTextCalls = [];

    await dispatchPromptHistory('up');

    expect(getComposerEditor().value).toBe('Only prompt');
    expect(composerEditorSetTextCalls).toEqual([]);
  });

  it('exits prompt history navigation after a real composer edit', async () => {
    const getContextRefSummaries = () =>
      chatState.composerContextRefs.map((ref) => {
        const contextRef = ref as { id: string; kind: string; title: string };
        return {
          id: contextRef.id,
          kind: contextRef.kind,
          title: contextRef.title,
        };
      });
    const latestRef = {
      kind: 'skill',
      id: 'global:latest-skill',
      title: 'latest-skill',
      skillFilePath: '/skills/latest-skill/SKILL.md',
    };
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Old prompt' }),
        buildMessage({
          id: 'msg-user-2',
          role: 'user',
          content: 'Latest prompt',
          context_refs: [latestRef],
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await setComposerText('Draft prompt');
    await dispatchPromptHistory('up');
    expect(getComposerEditor().value).toBe('Latest prompt');
    expect(getContextRefSummaries()).toEqual([{
      id: latestRef.id,
      kind: latestRef.kind,
      title: latestRef.title,
    }]);

    await setComposerText('Manual edit');
    expect(getContextRefSummaries()).toEqual([{
      id: latestRef.id,
      kind: latestRef.kind,
      title: latestRef.title,
    }]);
    await dispatchPromptHistory('down');
    expect(getComposerEditor().value).toBe('Manual edit');
    expect(getContextRefSummaries()).toEqual([{
      id: latestRef.id,
      kind: latestRef.kind,
      title: latestRef.title,
    }]);
  });

  it('renders skill references in user messages as composer-style chips', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content: '[skill: test-skill] utilise ce skill\nsur deux lignes',
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const skillChip = requireContainer().querySelector(
      '[data-context-reference-kind="skill"]'
    );
    expect(skillChip).toBeTruthy();
    expect(skillChip?.getAttribute('data-context-reference-surface')).toBe('message');
    expect(skillChip?.className).toContain('h-[1.125rem]');
    expect(skillChip?.className).toContain('align-[0em]');
    expect(skillChip?.className).not.toContain('align-[-0.1875rem]');
    expect(skillChip?.textContent).toContain('Skill');
    expect(skillChip?.textContent).toContain('test-skill');
    const userContent = requireContainer().querySelector('[data-user-message-content="true"]');
    expect(userContent?.className).toContain('leading-[1.35]');
    expect(userContent?.querySelectorAll('br')).toHaveLength(1);
    expect(userContent?.querySelector('p')).toBeNull();
    expect(requireContainer().textContent).not.toContain('[skill: test-skill]');
    expect(requireContainer().textContent).toContain('utilise ce skill');
    expect(requireContainer().textContent).toContain('sur deux lignes');
  });

  it('renders compact skill turn feedback for loaded and blocked skills', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content: '[skill: test-skill] utilise ce skill',
        }),
      ],
      skillTurnFeedbackByMessageId: {
        'msg-user-1': {
          messageId: 'msg-user-1',
          loaded: [{ title: 'test-skill', status: 'loaded' }],
          warnings: [
            {
              title: 'Skill context',
              status: 'blocked',
              reason: 'Skill docs is disabled. Enable it in Settings > Skills before using it.',
              action: 'open_settings',
            },
          ],
        },
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const feedback = requireContainer().querySelector('[data-testid="skill-turn-feedback"]');
    expect(feedback?.textContent).toContain('test-skill loaded');
    expect(feedback?.textContent).toContain('Skill docs is disabled');

    await act(async () => {
      feedback
        ?.querySelector<HTMLButtonElement>('button[aria-label="Open Settings"]')
        ?.click();
      await Promise.resolve();
    });

    expect(appState.openSettings).toHaveBeenCalledWith('skills');
  });

  it('renders file references in user messages as compact chips', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content: 'Regarde [file: src/App.tsx] avant de répondre',
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const fileChip = requireContainer().querySelector(
      '[data-context-reference-kind="file"]'
    );
    expect(fileChip).toBeTruthy();
    expect(fileChip?.getAttribute('data-context-reference-surface')).toBe('message');
    expect(fileChip?.textContent).toContain('File');
    expect(fileChip?.textContent).toContain('src/App.tsx');
    expect(requireContainer().textContent).not.toContain('[file: src/App.tsx]');
  });

  it('moves message editing into the composer and saves bracket text', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content: '[skill: test-skill] utilise ce skill',
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const editButton = requireContainer().querySelector('button[title="common.edit"]');
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(requireContainer().textContent).toContain('Editing in composer');
    expect(
      requireContainer().querySelector('[data-tour-id="chat-edit-cancel-button"]')
    ).not.toBeNull();

    const editor = requireContainer().querySelector(
      '[data-testid="composer-editor"]'
    ) as HTMLTextAreaElement | null;
    expect(editor).toBeTruthy();
    expect(editor?.value).toBe('[skill: test-skill] utilise ce skill');

    const editChip = requireContainer().querySelector(
      '[data-context-reference-surface="composer"]'
    );
    expect(editChip).toBeTruthy();
    expect(editChip?.textContent).toContain('Skill test-skill');

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        editor,
        '[skill: test-skill] utilise ce skill modifié'
      );
      editor!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const sendButton = requireContainer().querySelector(
      '[data-tour-id="chat-send-button"]'
    );
    expect(sendButton).not.toBeNull();

    await act(async () => {
      sendButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(chatState.editMessage).toHaveBeenCalledWith(
      'msg-user-1',
      '[skill: test-skill] utilise ce skill modifié',
      { skipAgentCodeReplayCheck: undefined }
    );
    expect(chatState.sendMessage).not.toHaveBeenCalled();
  });

  it('restores an existing composer draft and context refs after canceling message editing', async () => {
    chatState = {
      ...chatState,
      composerContextRefs: [
        {
          kind: 'skill',
          id: 'global:draft-skill',
          title: 'draft-skill',
          data: {},
        },
      ],
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content: 'Original message',
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const composer = await setComposerText('Draft before edit');

    const editButton = requireContainer().querySelector('button[title="common.edit"]');
    await act(async () => {
      editButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(composer.value).toBe('Original message');
    expect(chatState.composerContextRefs).toEqual([]);

    const cancelButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'common.cancel'
    );
    expect(cancelButton).not.toBeNull();

    await act(async () => {
      cancelButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(composer.value).toBe('Draft before edit');
    expect(chatState.composerContextRefs).toEqual([
      {
        kind: 'skill',
        id: 'global:draft-skill',
        title: 'draft-skill',
        data: {},
      },
    ]);
  });

  it('keeps composer editing active when checkpoint restoration is canceled', async () => {
    const preview = {
      conversationId: 'conv-1',
      messageId: 'msg-user-1',
      targetCheckpointId: null,
      affectedFiles: [
        {
          path: 'src/new-file.ts',
          realPath: '/repo/src/new-file.ts',
          action: 'delete',
          status: 'created',
          target: { exists: false, content: null },
        },
      ],
    };
    const previewDeferred = createDeferred<typeof preview>();
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Original message' }),
        buildMessage({ id: 'msg-assistant-1', role: 'assistant', content: 'Code changed.' }),
      ],
      getAgentCodeReplayPreview: mock(() => previewDeferred.promise),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await clickFirstMessageEditButton();
    await setComposerText('Edited message');
    await clickSendButton();
    await act(async () => {
      previewDeferred.resolve(preview);
      await previewDeferred.promise;
    });

    expect(requireContainer().textContent).toContain('Revenir au point de contrôle du code ?');
    expect(requireContainer().textContent).toContain('src/new-file.ts');
    expect(chatState.editMessage).not.toHaveBeenCalled();

    await clickButtonWithText('Annuler');

    expect(requireContainer().textContent).not.toContain('Revenir au point de contrôle du code ?');
    expect(requireContainer().querySelector('[data-chat-composer-editing="true"]')).not.toBeNull();
    expect(getComposerEditor().value).toBe('Edited message');
    expect(chatState.editMessage).not.toHaveBeenCalled();
  });

  it('confirms checkpoint restoration, saves the edit, and restores the prior draft', async () => {
    const preview = {
      conversationId: 'conv-1',
      messageId: 'msg-user-1',
      targetCheckpointId: null,
      affectedFiles: [
        {
          path: 'src/changed.ts',
          realPath: '/repo/src/changed.ts',
          action: 'modify',
          status: 'modified',
          target: { exists: true, content: 'before' },
        },
      ],
    };
    composerEditorValue = 'Draft before edit';
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Original message' }),
        buildMessage({ id: 'msg-assistant-1', role: 'assistant', content: 'Code changed.' }),
      ],
      getAgentCodeReplayPreview: mock(async () => preview),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await clickFirstMessageEditButton();
    await setComposerText('Edited after checkpoint');
    await clickSendButton();
    await clickButtonWithText('Restaurer et sauvegarder');

    expect(chatState.restoreAgentCodeForReplay).toHaveBeenCalledWith(preview);
    expect(chatState.editMessage).toHaveBeenCalledWith('msg-user-1', 'Edited after checkpoint', {
      skipAgentCodeReplayCheck: true,
    });
    expect(getComposerEditor().value).toBe('Draft before edit');
    expect(requireContainer().querySelector('[data-chat-composer-editing="true"]')).toBeNull();
  });

  it('moves message images into the composer while editing and saves image changes', async () => {
    const image = {
      id: 'img-1',
      dataUrl: 'data:image/png;base64,AAAA',
      mimeType: 'image/png',
    };
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content: 'Original image message',
        }),
      ],
      getMessageImages: mock((messageId: string) => (
        messageId === 'msg-user-1' ? [image] : []
      )),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await clickFirstMessageEditButton();

    expect(chatState.getMessageImages).toHaveBeenCalledWith('msg-user-1');
    expect(
      requireContainer().querySelector('img[alt="Pasted image"]')
    ).not.toBeNull();

    const removeImageButton = requireContainer().querySelector(
      'button[title="Remove image"]'
    );
    expect(removeImageButton).not.toBeNull();

    await act(async () => {
      removeImageButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(requireContainer().querySelector('img[alt="Pasted image"]')).toBeNull();

    await setComposerText('Edited image message');
    await clickSendButton();

    expect(chatState.editMessage).toHaveBeenCalledWith('msg-user-1', 'Edited image message', {
      skipAgentCodeReplayCheck: undefined,
    });
    expect(chatState.setMessageImages).toHaveBeenCalledWith('msg-user-1', []);
  });

  it('warns when a selected or mentioned skill cannot use native tool calls', async () => {
    providerState.selectedSupportsNativeToolCalling = () => false;
    chatState = {
      ...chatState,
      composerContextRefs: [
        {
          kind: 'skill',
          id: 'global:test-skill',
          title: 'test-skill',
          data: {},
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain(
      'Skills require a native tool-calling model/provider.'
    );

    await act(async () => {
      useChatStore.setState({ composerContextRefs: [] });
      requireRoot().render(<ChatZone />);
      await Promise.resolve();
    });

    const editor = requireContainer().querySelector(
      '[data-testid="composer-editor"]'
    ) as HTMLTextAreaElement | null;
    expect(editor).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        editor,
        'Use $test-skill'
      );
      editor!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(requireContainer().textContent).toContain(
      'Skills require a native tool-calling model/provider.'
    );
  });

  it('asks before replaying a user message that would rewind agent code checkpoints', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Recommence ici' }),
        buildMessage({ id: 'msg-assistant-1', role: 'assistant', content: 'J’ai modifié le code.' }),
      ],
      getAgentCodeReplayPreview: mock(async () => ({
        conversationId: 'conv-1',
        messageId: 'msg-user-1',
        targetCheckpointId: null,
        affectedFiles: [
          {
            path: 'src/new-file.ts',
            realPath: '/repo/src/new-file.ts',
            action: 'delete',
            status: 'created',
            target: { exists: false, content: null },
          },
        ],
      })),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const regenerateButton = requireContainer().querySelector('button[title="common.regenerate"]');
    expect(regenerateButton).not.toBeNull();

    await act(async () => {
      regenerateButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(requireContainer().textContent).toContain('Revenir au point de contrôle du code ?');
    expect(requireContainer().textContent).toContain('src/new-file.ts');
    expect(chatState.editMessage).not.toHaveBeenCalled();
    expect(chatState.restoreAgentCodeForReplay).not.toHaveBeenCalled();
  });

  it('restores agent code checkpoints before confirming a replay', async () => {
    const preview = {
      conversationId: 'conv-1',
      messageId: 'msg-user-1',
      targetCheckpointId: null,
      affectedFiles: [
        {
          path: 'src/changed.ts',
          realPath: '/repo/src/changed.ts',
          action: 'modify',
          status: 'modified',
          target: { exists: true, content: 'before' },
        },
      ],
    };
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Recommence ici' }),
        buildMessage({ id: 'msg-assistant-1', role: 'assistant', content: 'J’ai modifié le code.' }),
      ],
      getAgentCodeReplayPreview: mock(async () => preview),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const regenerateButton = requireContainer().querySelector('button[title="common.regenerate"]');
    await act(async () => {
      regenerateButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    const confirmButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Restaurer et relancer'
    );
    expect(confirmButton).not.toBeNull();

    await act(async () => {
      confirmButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(chatState.restoreAgentCodeForReplay).toHaveBeenCalledWith(preview);
    expect(chatState.editMessage).toHaveBeenCalledWith('msg-user-1', 'Recommence ici', {
      skipAgentCodeReplayCheck: true,
    });
  });

  it('keeps provider runtime errors out of the composer notice', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Bonjour' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '### Erreur du provider\n\nLe provider a refusé la requête.',
        }),
      ],
      sendState: 'error',
      lastError: null,
      getConversationRuntime: () => ({
        phase: 'error',
        sessionId: 'session-conv-1',
        assistantMessageId: 'msg-assistant-1',
        lastError: 'Composer must not render this provider error',
        lastErrorOrigin: 'provider',
        lastErrorDisplayTarget: 'transcript',
      }),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Erreur du provider');
    expect(requireContainer().textContent).not.toContain(
      'Composer must not render this provider error'
    );
  });

  it('keeps Macro runtime errors in the composer notice', async () => {
    chatState = {
      ...chatState,
      sendState: 'error',
      lastError: null,
      getConversationRuntime: () => ({
        phase: 'error',
        sessionId: 'session-conv-1',
        assistantMessageId: null,
        lastError: 'Task worktree is not ready yet.',
        lastErrorOrigin: 'macro',
        lastErrorDisplayTarget: 'composer',
      }),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).not.toContain('Task worktree is not ready yet.');
    expect(requireContainer().textContent).toContain('Show details');
    await act(async () => {
      Array.from(requireContainer().querySelectorAll('button')).find(
        (button) => button.textContent === 'Show details'
      )?.click();
    });
    expect(requireContainer().textContent).toContain('Task worktree is not ready yet.');
  });

  it('shows the context indicator in Chat mode when a conversation is selected', async () => {
    chatState = {
      ...chatState,
      selectedConversationId: 'conv-1',
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Conversation libre' }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('button[aria-label="Diagnostic du contexte"]')
    ).not.toBeNull();
  });

  it('hides the context indicator when Implement has no selected task', async () => {
    appState = {
      ...appState,
      mode: 'Implement',
      selectedTaskId: null,
    };
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Ancienne conversation' }),
      ],
      selectedConversationId: 'conv-1',
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('button[aria-label="Diagnostic du contexte"]')
    ).toBeNull();
    expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
  });

  it('shows the context indicator when Implement has a selected task id before task details load', async () => {
    appState = {
      ...appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    taskState = {
      ...taskState,
      tasks: [],
    };
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Conversation liée' }),
      ],
      selectedConversationId: 'conv-1',
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('button[aria-label="Diagnostic du contexte"]')
    ).not.toBeNull();
  });

  it('renders the visible assistant content while streaming', async () => {
    chatState = {
      ...chatState,
      isStreaming: true,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Bonjour Macro' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Réponse partielle',
          tool_traces: [],
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Bonjour Macro');
    expect(markdownRendererContentMock.mock.calls.map(([content]) => content)).toContain('Réponse partielle');
    expect(requireContainer().textContent).toContain('Stop');
    expect(requireContainer().querySelector('[data-tour-id="chat-send-button"]')).not.toBeNull();
    expect(getComposerEditor().hasAttribute('disabled')).toBe(false);
  });

  it('renders live context diagnostics while a visible conversation is streaming', async () => {
    chatState = {
      ...chatState,
      isStreaming: true,
      contextDiagnosticsByConversationId: {
        'conv-1': {
          status: 'ready',
          source: 'live_stream',
          conversationId: 'conv-1',
          updatedAt: '2026-05-10T00:00:00.000Z',
          providerType: 'openai',
          modelId: 'gpt-live',
          ratio: 0.2,
          usableRatio: 0.25,
          isHardStop: false,
          counts: {
            messages: 2,
            visibleLines: 8,
            hiddenContextLines: 0,
            providerInputItems: 2,
            providerInputItemLines: 8,
            reasoningContentLines: 0,
            toolResultLines: 0,
            citations: 0,
            activeFiles: 0,
            toolFacts: 0,
          },
          breakdown: [],
          topContributors: [],
        },
      },
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Bonjour Macro' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Réponse partielle',
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
      await Promise.resolve();
    });

    await act(async () => {
      requireContainer()
        .querySelector<HTMLButtonElement>('[aria-label="Diagnostic du contexte"]')
        ?.click();
      await Promise.resolve();
    });

    expect(requireContainer().textContent).not.toContain('Mesure en direct');
    expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
  });

  it('does not refresh live diagnostics while streaming when context controls are hidden', async () => {
    appState = {
      ...appState,
      mode: 'Implement',
      selectedTaskId: null,
    };
    chatState = {
      ...chatState,
      isStreaming: true,
      selectedConversationId: 'conv-1',
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Ancienne tâche' }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
      await Promise.resolve();
    });

    expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
  });

  it('does not issue a duplicate context refresh when streaming ends', async () => {
    chatState = {
      ...chatState,
      isStreaming: true,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Bonjour Macro' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Réponse partielle',
        }),
      ],
    };

    jest.useFakeTimers();
    try {
      await act(async () => {
        requireRoot().render(<ChatZone />);
        await Promise.resolve();
      });
      expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();

      chatState = {
        ...chatState,
        isStreaming: false,
        sendState: 'idle',
      };
      await act(async () => {
        useChatStore.emit();
        await Promise.resolve();
      });

      expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(400);
        await Promise.resolve();
      });

      expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
    } finally {
      try {
        jest.clearAllTimers();
      } finally {
        jest.useRealTimers();
      }
    }
  });

  it('prevents overlapping context diagnostic refreshes from the indicator', async () => {
    let resolveRefresh: (() => void) | null = null;
    chatState = {
      ...chatState,
      isStreaming: true,
      refreshConversationContextDiagnostics: mock(
        () =>
          new Promise<void>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Bonjour Macro' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Réponse partielle',
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
      await Promise.resolve();
    });
    expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();

    await act(async () => {
      requireContainer()
        .querySelector<HTMLButtonElement>('[aria-label="Diagnostic du contexte"]')
        ?.click();
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(requireContainer().querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Actualiser'))
        ?.click();
      await Promise.resolve();
    });

    expect(chatState.refreshConversationContextDiagnostics).toHaveBeenCalledTimes(1);
    expect(chatState.refreshConversationContextDiagnostics).toHaveBeenLastCalledWith(
      'conv-1',
      { mode: 'live_stream' },
    );

    await act(async () => {
      Array.from(requireContainer().querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Actualiser'))
        ?.click();
      await Promise.resolve();
    });

    expect(chatState.refreshConversationContextDiagnostics).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh?.();
      await Promise.resolve();
    });
  });

  it('renders a dedicated notice when the assistant hit the tool turn limit', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Inspecte ce projet' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Voici le bilan final.',
          completion_reason: 'tool_turn_limit',
          tool_traces: [],
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const notice = requireContainer().querySelector(
      '[data-chat-completion-notice="tool_turn_limit"]'
    );
    const markdown = requireContainer().querySelector('[data-testid="markdown-renderer"]');
    const messageShell = notice?.closest('.group');
    const noticeIcon = notice?.querySelector('[data-icon="triangle-alert"]');
    expect(notice?.textContent).toContain('Tool turn limit reached');
    expect(notice?.textContent).toContain('Macro stopped the agent loop.');
    expect(notice?.textContent).toContain('Settings > General > Max agent turns');
    expect(notice?.className).toContain('border-border');
    expect(notice?.className).toContain('bg-card');
    expect(notice?.className).toContain('px-2.5');
    expect(notice?.className).toContain('py-2');
    expect(notice?.className).toContain('mt-3');
    expect(noticeIcon?.className).toContain('left-1/2');
    expect(noticeIcon?.className).toContain('top-1/2');
    expect(noticeIcon?.className).toContain('-translate-x-1/2');
    expect(noticeIcon?.className).toContain('-translate-y-1/2');
    expect(messageShell?.className).toContain('pb-10');
    expect(markdown?.compareDocumentPosition(notice as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(markdownRendererContentMock.mock.calls.map(([content]) => content)).toContain(
      'Voici le bilan final.'
    );
  });

  it('renders the tool turn limit notice even when the assistant content is empty', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Inspecte ce projet' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '',
          completion_reason: 'tool_turn_limit',
          tool_traces: [],
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const notice = requireContainer().querySelector(
      '[data-chat-completion-notice="tool_turn_limit"]'
    );
    expect(notice?.textContent).toContain('Tool turn limit reached');
    expect(notice?.className).toContain('mt-0');
    expect(markdownRendererContentMock.mock.calls.map(([content]) => content)).toContain('');
  });

  it('renders a fallback notice when the final no-tool pass is unusable', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Inspecte ce projet' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: "La limite de 3 tours agent a été atteinte.\nOutils utilisés avant l'arrêt : read.",
          completion_reason: 'post_tool_empty_fallback',
          tool_traces: [],
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const notice = requireContainer().querySelector(
      '[data-chat-completion-notice="post_tool_empty_fallback"]'
    );
    expect(notice?.textContent).toContain('Macro showed a fallback summary.');
  });

  it('shows the normal assistant cursor while a retry is preparing without compaction', async () => {
    chatState = {
      ...chatState,
      sendState: 'preparing',
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Relance cette tentative' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '',
          tool_traces: [],
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('[data-chat-assistant-activity="true"]')
    ).not.toBeNull();
    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    expect(requireContainer().querySelector('[data-chat-compaction-progress="true"]')).toBeNull();
  });

  it('renders provider, model, and reasoning selectors in the toolbar', async () => {
    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().querySelector('[data-testid="provider-dropdown"]')).not.toBeNull();
    expect(requireContainer().querySelector('[data-testid="model-dropdown"]')).not.toBeNull();
    expect(requireContainer().querySelector('[data-testid="reasoning-dropdown"]')).not.toBeNull();
  });

  it('consults peekComposerDraft when the selected conversation changes', async () => {
    const peekMock = mock((conversationId: string) => {
      return chatState.pendingComposerDraftByConversationId[conversationId] ?? null;
    });
    chatState = {
      ...chatState,
      conversations: [buildConversation()],
      selectedConversationId: 'conv-1',
      pendingComposerDraftByConversationId: {
        'conv-1': 'Pre-filled conflict resolution draft.',
      },
      peekComposerDraft: peekMock as unknown as typeof chatState.peekComposerDraft,
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
      useChatStore.emit();
    });

    expect(peekMock).toHaveBeenCalledWith('conv-1');
  });

  it('does not call setText on the composer when no draft is pending', async () => {
    chatState = {
      ...chatState,
      conversations: [buildConversation()],
      selectedConversationId: 'conv-1',
      pendingComposerDraftByConversationId: {},
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
      useChatStore.emit();
    });

    // The effect ran and the mock returned null. No text was set, the
    // composer remains in its initial empty state.
    expect(
      requireContainer().querySelector('[data-testid="composer-editor"]')
    ).not.toBeNull();
  });

  registerCompactionScenarios({
    get chatState() {
      return chatState;
    },
    set chatState(nextState) {
      chatState = nextState;
    },
    get composerEditorValue() {
      return composerEditorValue;
    },
    set composerEditorValue(value) {
      composerEditorValue = value;
    },
    scrollMagnetActiveValues,
    notifyInfoMock,
    notifySuccessMock,
    notifyErrorMock,
    markdownRendererContentMock,
    renderChatZone: () => <ChatZone />,
    buildMessage,
    buildCompactionEvent,
    buildCompactionFootprint,
    buildManualCompactionCompletedResult,
    buildManualCompactionSkippedResult,
    requireContainer,
    requireRoot,
    emitChatStore: () => useChatStore.emit(),
    setChatStoreState: (state) => useChatStore.setState(state),
    clearMarkdownRendererContentMock: () => markdownRendererContentMock.mockClear(),
  });

  registerArchitectScenarios({
    get appState() {
      return appState;
    },
    set appState(nextState) {
      appState = nextState;
    },
    get chatState() {
      return chatState;
    },
    set chatState(nextState) {
      chatState = nextState;
    },
    get composerEditorValue() {
      return composerEditorValue;
    },
    set composerEditorValue(value) {
      composerEditorValue = value;
    },
    get composerEditorSetTextCalls() {
      return composerEditorSetTextCalls;
    },
    get composerEditorFocusCalls() {
      return composerEditorFocusCalls;
    },
    get latestComposerProps() {
      return latestComposerProps;
    },
    notifyInfoMock,
    renderChatZone: () => <ChatZone />,
    buildMessage,
    requireContainer,
    requireRoot,
    emitAppStore: () => useAppStore.emit(),
    emitChatStore: () => useChatStore.emit(),
  });

  registerImplementScenarios({
    get appState() {
      return appState;
    },
    set appState(nextState) {
      appState = nextState;
    },
    get chatState() {
      return chatState;
    },
    set chatState(nextState) {
      chatState = nextState;
    },
    get taskState() {
      return taskState;
    },
    set taskState(nextState) {
      taskState = nextState;
    },
    get composerEditorValue() {
      return composerEditorValue;
    },
    set composerEditorValue(value) {
      composerEditorValue = value;
    },
    get latestComposerProps() {
      return latestComposerProps;
    },
    renderChatZone: () => <ChatZone />,
    requireContainer,
    requireRoot,
    setComposerText,
    clickButtonWithText,
    emitAppStore: () => useAppStore.emit(),
    emitChatStore: () => useChatStore.emit(),
    emitTaskStore: () => useTaskStore.emit(),
    getConversationGoal: (conversationId) =>
      useConversationGoalStore.getState().goalsByConversationId[conversationId],
  });

  registerQuestionnaireApprovalScenarios({
    get chatState() {
      return chatState;
    },
    set chatState(nextState) {
      chatState = nextState;
    },
    renderChatZone: () => <ChatZone />,
    buildMessage,
    requireContainer,
    requireRoot,
    emitChatStore: () => useChatStore.emit(),
    setChatStoreState: (state) => useChatStore.setState(state),
  });


});
