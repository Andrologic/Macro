import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../test-utils/reactI18nextMock';
import { installTauriRuntimeMock } from '../../test-utils/tauriRuntime';

type AppMode = 'Chat' | 'Architect' | 'Implement';

type MockConversation = {
  id: string;
  title: string;
  scope_mode: AppMode;
  task_id: string | null;
  project_id: string | null;
  group_id: string | null;
};

type MockMessage = {
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

type MockChatState = {
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
  clearLastError: ReturnType<typeof mock>;
  clearConversationRuntimeError: ReturnType<typeof mock>;
  editMessage: ReturnType<typeof mock>;
  getAgentCodeReplayPreview: ReturnType<typeof mock>;
  restoreAgentCodeForReplay: ReturnType<typeof mock>;
  getMessageImages: ReturnType<typeof mock>;
  setMessageImages: ReturnType<typeof mock>;
  compactConversationNow: ReturnType<typeof mock>;
  refreshConversationContextDiagnostics: ReturnType<typeof mock>;
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

type AppStoreState = {
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
};

type ProviderState = {
  selectedProviderId: string | null;
  selectedModelId: string | null;
  selectedSupportsNativeToolCalling: () => boolean;
};

type NeedsState = {
  needs: unknown[];
};

type ShortcutsState = {
  promptHistoryNavigationMode: string;
};

type TaskState = {
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

const createStoreHook = <T extends object,>(
  getSnapshot: () => T,
  setSnapshot: (nextState: T) => void,
) => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      };
  };

  const hook = ((selector?: (state: T) => unknown) => {
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return selector ? selector(snapshot) : snapshot;
  }) as ((selector?: (state: T) => unknown) => unknown) & {
    emit: () => void;
    getState: () => T;
    setState: (
      nextStateOrUpdater: Partial<T> | T | ((state: T) => Partial<T> | T),
      replace?: boolean
    ) => void;
    subscribe: typeof subscribe;
  };

  hook.getState = getSnapshot;
  hook.emit = () => {
    listeners.forEach((listener) => listener());
  };
  hook.setState = (nextStateOrUpdater, replace = false) => {
    const currentState = getSnapshot();
    const nextState =
      typeof nextStateOrUpdater === 'function'
        ? nextStateOrUpdater(currentState)
        : nextStateOrUpdater;
    setSnapshot(
      (replace ? nextState : { ...currentState, ...nextState }) as T
    );
    hook.emit();
  };
  hook.subscribe = subscribe;
  return hook;
};

let appState: AppStoreState;
let chatState: MockChatState;
let providerState: ProviderState;
let needsState: NeedsState;
let shortcutsState: ShortcutsState;
let taskState: TaskState;
let skillsState: { getSkillById: ReturnType<typeof mock>; refreshSkills: ReturnType<typeof mock> };

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

const useAppStore = createStoreHook(() => appState, (nextState) => {
  appState = nextState;
});
const useChatStore = createStoreHook(() => chatState, (nextState) => {
  chatState = nextState;
});
const useProviderStore = createStoreHook(() => providerState, (nextState) => {
  providerState = nextState;
});
const useNeedsStore = createStoreHook(() => needsState, (nextState) => {
  needsState = nextState;
});
const useSkillsStore = createStoreHook(() => skillsState, (nextState) => {
  skillsState = nextState;
});
const useShortcutsStore = createStoreHook(() => shortcutsState, (nextState) => {
  shortcutsState = nextState;
});
const useTaskStore = createStoreHook(() => taskState, (nextState) => {
  taskState = nextState;
});

const translationMock = createTranslationMock({
  'chat.typeMessage': 'Type your message',
  'chat.stop': 'Stop',
  'chat.newConversation': 'New Conversation',
  'architect.selectPlanToStart': 'Select or create a plan to start architecting.',
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
const COMPACTION_PROGRESS_TEXT = 'Compactage du contexte...';
const COMPACTION_BOUNDARY_TEXT = 'Contexte compacté';

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
let notifyInfoMock: ReturnType<typeof mock>;
let notifySuccessMock: ReturnType<typeof mock>;
let notifyWarningMock: ReturnType<typeof mock>;
let notifyErrorMock: ReturnType<typeof mock>;
let notifyActionRequiredMock: ReturnType<typeof mock>;

let ChatZone!: typeof import('./ChatZone').default;
let importCounter = 0;

const resetNotifyMocks = () => {
  notifyInfoMock = mock(() => undefined);
  notifySuccessMock = mock(() => undefined);
  notifyWarningMock = mock(() => undefined);
  notifyErrorMock = mock(() => undefined);
  notifyActionRequiredMock = mock(() => undefined);
};

const loadChatZoneModule = async () => {
  importCounter += 1;
  mock.restore();
  resetNotifyMocks();

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

  mock.module('../../stores/useNeedsStore', () => ({
    useNeedsStore,
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

  ({ default: ChatZone } = await import(`./ChatZone.tsx?chat-zone-test=${importCounter}`));
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

const buildCompactionEvent = (
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

const buildCompactionFootprint = (
  overrides: {
    usableContextRatio?: number;
    totalContextRatio?: number;
  } = {},
) => ({
  usableContextRatio: 0.42,
  totalContextRatio: 0.5,
  ...overrides,
});

const buildManualCompactionCompletedResult = (
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

const buildManualCompactionSkippedResult = (
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
    clearLastError: mock(() => undefined),
    clearConversationRuntimeError: mock(() => undefined),
    editMessage: mock(async () => undefined),
    getAgentCodeReplayPreview: mock(async () => null),
    restoreAgentCodeForReplay: mock(async () => undefined),
    getMessageImages: mock(() => []),
    setMessageImages: mock(() => undefined),
    compactConversationNow: mock(async () => buildManualCompactionSkippedResult()),
    refreshConversationContextDiagnostics: mock(async () => undefined),
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
    selectedSupportsNativeToolCalling: () => true,
  };

  needsState = {
    needs: [],
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
    resetState();
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

  it('does not render the legacy skills dropdown in the composer control row', async () => {
    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().querySelector('[data-tour-id="skill-dropdown"]')).toBeNull();
    expect(requireContainer().querySelector('[data-tour-id="chat-control-row"]')).not.toBeNull();
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
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Original message' }),
        buildMessage({ id: 'msg-assistant-1', role: 'assistant', content: 'Code changed.' }),
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

    await clickFirstMessageEditButton();
    await setComposerText('Edited message');
    await clickSendButton();

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

  it('renders a vertical compaction boundary in the transcript', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Réponse avant compression',
        }),
        buildMessage({ id: 'msg-user-2', role: 'user', content: 'Message après compression' }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'compacted',
          upToMessageId: 'msg-assistant-1',
          updatedAt: '2026-05-10T08:30:00.000Z',
          summaryText: 'Résumé compacté',
        },
      },
      sessionCompactionEventsByConversationId: {
        'conv-1': [buildCompactionEvent()],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const boundary = requireContainer().querySelector('[data-chat-compaction-boundary="true"]');
    expect(boundary).not.toBeNull();
    expect(boundary?.textContent).toContain(COMPACTION_BOUNDARY_TEXT);
    expect(boundary?.getAttribute('role')).toBe('separator');
    expect(boundary?.getAttribute('aria-label')).toBe(COMPACTION_BOUNDARY_TEXT);
    expect(boundary?.getAttribute('data-chat-compaction-boundary-orientation')).toBe('vertical');
    expect(boundary?.querySelector('[data-icon="archive"]')).toBeNull();
  });

  it('keeps the compaction boundary visible when the compacted message is last', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Dernière réponse compactée',
        }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'compacted',
          upToMessageId: 'msg-assistant-1',
          updatedAt: '2026-05-10T08:30:00.000Z',
        },
      },
      sessionCompactionEventsByConversationId: {
        'conv-1': [buildCompactionEvent()],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('[data-chat-compaction-boundary="true"]')
    ).not.toBeNull();
  });

  it('removes the virtual transcript gap before a compaction separator that follows an assistant message', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Dernière réponse compactée',
        }),
      ],
      sessionCompactionEventsByConversationId: {
        'conv-1': [buildCompactionEvent()],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const assistant = requireContainer().querySelector<HTMLElement>(
      '#chat-message-msg-assistant-1'
    );
    const boundary = requireContainer().querySelector<HTMLElement>(
      '[data-chat-compaction-boundary="true"]'
    );

    expect(assistant).not.toBeNull();
    expect(boundary).not.toBeNull();
    expect(assistant?.style.transform).toBe('translateY(244px)');
    expect(boundary?.style.transform).toBe('translateY(464px)');
    expect(boundary?.className).toContain('pt-0');
    expect(boundary?.className).toContain('pb-2');
  });

  it('does not render a visual boundary from a rehydrated compaction checkpoint alone', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Dernière réponse compactée',
        }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'compacted',
          upToMessageId: 'msg-assistant-1',
          updatedAt: '2026-05-10T08:30:00.000Z',
        },
      },
      sessionCompactionEventsByConversationId: {},
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('[data-chat-compaction-boundary="true"]')
    ).toBeNull();
  });

  it('renders compaction progress in the transcript while manual compaction is running', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({ id: 'msg-assistant-1', role: 'assistant', content: 'Réponse' }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'compacting',
          upToMessageId: 'msg-assistant-1',
          updatedAt: '2026-05-10T08:30:00.000Z',
        },
      },
      sessionCompactionEventsByConversationId: {
        'conv-1': [
          buildCompactionEvent({
            id: 'previous-compaction',
            status: 'completed',
            displayAfterMessageId: 'msg-user-1',
          }),
          buildCompactionEvent({
            status: 'running',
            displayAfterMessageId: 'msg-assistant-1',
            completedAt: null,
          }),
        ],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const progress = requireContainer().querySelector('[data-chat-compaction-progress="true"]');
    expect(progress).not.toBeNull();
    expect(progress?.textContent).toContain(COMPACTION_PROGRESS_TEXT);
    expect(progress?.getAttribute('data-chat-compaction-progress-phase')).toBe('compacting');
    expect(progress?.querySelector('.chat-compaction-wave-text')).not.toBeNull();
    expect(progress?.querySelector('[data-spinner-icon="true"] .animate-spin')).toBeNull();
    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting-spinner"]'),
    ).not.toBeNull();
    expect(requireContainer().querySelector('[data-chat-compaction-boundary="true"]')).not.toBeNull();
  });

  it('uses the same compaction label layout for completed and running rows', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({ id: 'msg-assistant-1', role: 'assistant', content: 'Réponse' }),
      ],
      sessionCompactionEventsByConversationId: {
        'conv-1': [
          buildCompactionEvent({
            id: 'completed-compaction',
            status: 'completed',
            displayAfterMessageId: 'msg-user-1',
          }),
          buildCompactionEvent({
            id: 'running-compaction',
            status: 'running',
            displayAfterMessageId: 'msg-assistant-1',
            completedAt: null,
          }),
        ],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const boundary = requireContainer().querySelector('[data-chat-compaction-boundary="true"]');
    const progress = requireContainer().querySelector('[data-chat-compaction-progress="true"]');
    const boundaryLabel = boundary?.querySelector('.chat-compaction-label');
    const progressLabel = progress?.querySelector('.chat-compaction-label');

    expect(boundary).not.toBeNull();
    expect(progress).not.toBeNull();
    expect(boundaryLabel).not.toBeNull();
    expect(progressLabel).not.toBeNull();
    expect(boundaryLabel?.textContent).toContain(COMPACTION_BOUNDARY_TEXT);
    expect(progressLabel?.textContent).toContain(COMPACTION_PROGRESS_TEXT);
    expect(boundaryLabel?.classList.contains('chat-compaction-wave-text')).toBe(false);
    expect(progressLabel?.classList.contains('chat-compaction-wave-text')).toBe(true);
  });

  it('suppresses the streaming cursor during compaction without rendering inline compaction text', async () => {
    chatState = {
      ...chatState,
      isStreaming: true,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Message trop large' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '',
        }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'recovering_overflow',
          updatedAt: '2026-05-10T08:31:00.000Z',
        },
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    expect(requireContainer().querySelector('[data-chat-assistant-activity="true"]')).toBeNull();
    expect(requireContainer().querySelector('[data-chat-compaction-progress="true"]')).toBeNull();
    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting-spinner"]'),
    ).not.toBeNull();
  });

  it('renders standalone preparation activity instead of attaching a cursor to an old assistant row', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Ancien message' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Ancienne réponse',
        }),
      ],
      getConversationRuntime: () => ({
        phase: 'preparing',
        sessionId: 'session-conv-1',
        assistantMessageId: null,
        lastError: null,
        lastErrorOrigin: null,
        lastErrorDisplayTarget: null,
      }),
      sessionCompactionEventsByConversationId: {
        'conv-1': [
          buildCompactionEvent({
            status: 'running',
            displayAfterMessageId: 'msg-assistant-1',
            completedAt: null,
          }),
        ],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().querySelector('[data-chat-assistant-activity="true"]')).toBeNull();
    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    const progress = requireContainer().querySelector('[data-chat-compaction-progress="true"]');
    expect(progress).not.toBeNull();
    expect(progress?.textContent).toContain(COMPACTION_PROGRESS_TEXT);
    expect(progress?.querySelector('.chat-compaction-wave-text')).not.toBeNull();
    expect(progress?.querySelector('[data-spinner-icon="true"] .animate-spin')).toBeNull();
    expect(scrollMagnetActiveValues.at(-1)).toBe(true);
  });

  it('updates an existing streaming assistant row when automatic compaction starts', async () => {
    const userMessage = buildMessage({
      id: 'msg-user-1',
      role: 'user',
      content: 'Message trop grand',
    });
    const assistantMessage = buildMessage({
      id: 'msg-assistant-1',
      role: 'assistant',
      content: '',
    });
    const messages = [userMessage, assistantMessage];
    chatState = {
      ...chatState,
      isStreaming: true,
      messages,
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().querySelector('[data-chat-assistant-activity="true"]')).not.toBeNull();
    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    expect(requireContainer().querySelector('[data-chat-compaction-progress="true"]')).toBeNull();

    markdownRendererContentMock.mockClear();
    await act(async () => {
      useChatStore.setState((state) => ({
        conversationCompactionStatusById: {
          ...state.conversationCompactionStatusById,
          'conv-1': {
            phase: 'safety_compacting',
            updatedAt: '2026-05-10T08:31:00.000Z',
          },
        },
      }));
      await Promise.resolve();
    });

    expect(chatState.messages).toBe(messages);
    expect(chatState.messages[1]).toBe(assistantMessage);
    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    expect(requireContainer().querySelector('[data-chat-assistant-activity="true"]')).toBeNull();
    expect(requireContainer().querySelector('[data-chat-compaction-progress="true"]')).toBeNull();
    expect(
      markdownRendererContentMock.mock.calls.some(
        ([content, isStreaming]) => content === '' && isStreaming === false,
      ),
    ).toBe(true);
  });

  it('anchors automatic compaction to the latest assistant row when runtime loses the assistant id', async () => {
    let runtimeAssistantMessageId: string | null = 'msg-assistant-1';
    const userMessage = buildMessage({
      id: 'msg-user-1',
      role: 'user',
      content: 'Message trop grand',
    });
    const assistantMessage = buildMessage({
      id: 'msg-assistant-1',
      role: 'assistant',
      content: '',
    });
    chatState = {
      ...chatState,
      messages: [userMessage, assistantMessage],
      getConversationRuntime: () => ({
        phase: 'streaming',
        sessionId: 'session-conv-1',
        assistantMessageId: runtimeAssistantMessageId,
        lastError: null,
        lastErrorOrigin: null,
        lastErrorDisplayTarget: null,
      }),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().querySelector('[data-chat-assistant-activity="true"]')).not.toBeNull();
    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();

    runtimeAssistantMessageId = null;
    await act(async () => {
      useChatStore.setState((state) => ({
        conversationCompactionStatusById: {
          ...state.conversationCompactionStatusById,
          'conv-1': {
            phase: 'safety_compacting',
            updatedAt: '2026-05-10T08:31:00.000Z',
          },
        },
      }));
      await Promise.resolve();
    });

    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    expect(requireContainer().querySelector('[data-chat-assistant-activity="true"]')).toBeNull();
    expect(requireContainer().querySelector('[data-chat-compaction-progress="true"]')).toBeNull();
  });

  it('suppresses the preparing assistant cursor during compaction without rendering inline compaction text', async () => {
    chatState = {
      ...chatState,
      sendState: 'preparing',
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Message à envoyer' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '',
        }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'safety_compacting',
          updatedAt: '2026-05-10T08:31:00.000Z',
        },
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    expect(requireContainer().querySelector('[data-chat-assistant-activity="true"]')).toBeNull();
    expect(requireContainer().querySelector('[data-chat-compaction-progress="true"]')).toBeNull();
    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting-spinner"]'),
    ).not.toBeNull();
  });

  it('animates the context window during safety compaction without diagnostics', async () => {
    chatState = {
      ...chatState,
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'safety_compacting',
          updatedAt: '2026-05-10T08:31:00.000Z',
          footprintAfter: buildCompactionFootprint({ usableContextRatio: 0.42 }),
        },
      },
      contextDiagnosticsByConversationId: {},
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting"]'),
    ).not.toBeNull();
    expect(
      requireContainer()
        .querySelector('[data-testid="context-window-compacting-mask-fill"]')
        ?.getAttribute('stroke-dasharray'),
    ).toBe('42 100');
  });

  it('animates the context window during model-switch compaction without diagnostics', async () => {
    chatState = {
      ...chatState,
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'model_switch_compacting',
          updatedAt: '2026-05-10T08:31:00.000Z',
          footprintAfter: buildCompactionFootprint({ usableContextRatio: 0.37 }),
        },
      },
      contextDiagnosticsByConversationId: {},
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting"]'),
    ).not.toBeNull();
    expect(
      requireContainer()
        .querySelector('[data-testid="context-window-compacting-mask-fill"]')
        ?.getAttribute('stroke-dasharray'),
    ).toBe('37 100');
  });

  it('animates the context window during overflow recovery without diagnostics', async () => {
    chatState = {
      ...chatState,
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'recovering_overflow',
          updatedAt: '2026-05-10T08:31:00.000Z',
          footprintAfter: buildCompactionFootprint({ usableContextRatio: 0.64 }),
        },
      },
      contextDiagnosticsByConversationId: {},
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting"]'),
    ).not.toBeNull();
    expect(
      requireContainer()
        .querySelector('[data-testid="context-window-compacting-mask-fill"]')
        ?.getAttribute('stroke-dasharray'),
    ).toBe('64 100');
  });

  it('does not animate the context window for a final compacted status', async () => {
    chatState = {
      ...chatState,
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'compacted',
          updatedAt: '2026-05-10T08:31:00.000Z',
          footprintAfter: buildCompactionFootprint({ usableContextRatio: 0.25 }),
        },
      },
      contextDiagnosticsByConversationId: {},
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting"]'),
    ).toBeNull();
  });

  it('renders compaction progress clearly in the transcript when no assistant cursor exists', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Message trop large' }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'recovering_overflow',
          updatedAt: '2026-05-10T08:31:00.000Z',
        },
      },
      sessionCompactionEventsByConversationId: {
        'conv-1': [
          buildCompactionEvent({
            status: 'running',
            displayAfterMessageId: 'msg-user-1',
            kind: 'stream_overflow',
            completedAt: null,
          }),
        ],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const progress = requireContainer().querySelector('[data-chat-compaction-progress="true"]');
    expect(progress).not.toBeNull();
    expect(progress?.textContent).toContain(COMPACTION_PROGRESS_TEXT);
    expect(progress?.getAttribute('data-chat-compaction-progress-phase')).toBe('recovering_overflow');
    expect(progress?.querySelector('.chat-compaction-wave-text')).not.toBeNull();
    expect(progress?.querySelector('[data-spinner-icon="true"] .animate-spin')).toBeNull();
    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting-spinner"]'),
    ).not.toBeNull();
  });

  it('renders safety compaction progress when the assistant cursor is not available yet', async () => {
    chatState = {
      ...chatState,
      sendState: 'preparing',
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Message trop large' }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'safety_compacting',
          updatedAt: '2026-05-10T08:31:00.000Z',
        },
      },
      sessionCompactionEventsByConversationId: {
        'conv-1': [
          buildCompactionEvent({
            status: 'running',
            displayAfterMessageId: 'msg-user-1',
            kind: 'safety_prestream',
            completedAt: null,
          }),
        ],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const progress = requireContainer().querySelector('[data-chat-compaction-progress="true"]');
    expect(progress).not.toBeNull();
    expect(progress?.textContent).toContain(COMPACTION_PROGRESS_TEXT);
    expect(progress?.getAttribute('data-chat-compaction-progress-phase')).toBe('safety_compacting');
    expect(progress?.querySelector('[data-spinner-icon="true"] .animate-spin')).toBeNull();
    expect(progress?.querySelector('.chat-compaction-wave-text')).not.toBeNull();
    expect(progress?.querySelector('.chat-streaming-compaction__wave')).toBeNull();
    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting-spinner"]'),
    ).not.toBeNull();
  });

  it('keeps the transcript pinned while pre-stream safety compaction is visible', async () => {
    chatState = {
      ...chatState,
      sendState: 'preparing',
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Message trop large' }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'safety_compacting',
          updatedAt: '2026-05-10T08:31:00.000Z',
        },
      },
      sessionCompactionEventsByConversationId: {
        'conv-1': [
          buildCompactionEvent({
            status: 'running',
            displayAfterMessageId: 'msg-user-1',
            kind: 'safety_prestream',
            completedAt: null,
          }),
        ],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('[data-chat-compaction-progress="true"]'),
    ).not.toBeNull();
    expect(scrollMagnetActiveValues.at(-1)).toBe(true);
  });

  it('renders safety compaction progress before messages are persisted and keeps the composer text', async () => {
    composerEditorValue = 'encore';
    chatState = {
      ...chatState,
      sendState: 'preparing',
      messages: [],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'safety_compacting',
          updatedAt: '2026-05-10T08:31:00.000Z',
        },
      },
      sessionCompactionEventsByConversationId: {
        'conv-1': [
          buildCompactionEvent({
            status: 'running',
            displayAfterMessageId: null,
            kind: 'safety_prestream',
            completedAt: null,
          }),
        ],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const progress = requireContainer().querySelector('[data-chat-compaction-progress="true"]');
    const composer = requireContainer().querySelector(
      '[data-testid="composer-editor"]',
    ) as HTMLTextAreaElement | null;
    expect(progress).not.toBeNull();
    expect(progress?.textContent).toContain(COMPACTION_PROGRESS_TEXT);
    expect(progress?.getAttribute('data-chat-compaction-progress-phase')).toBe('safety_compacting');
    expect(progress?.querySelector('[data-spinner-icon="true"] .animate-spin')).toBeNull();
    expect(progress?.querySelector('.chat-compaction-wave-text')).not.toBeNull();
    expect(progress?.querySelector('.chat-streaming-compaction__wave')).toBeNull();
    expect(composer?.value).toBe('encore');
    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting-spinner"]'),
    ).not.toBeNull();
  });

  it('keeps the checkpoint boundary after compaction completes', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({ id: 'msg-assistant-1', role: 'assistant', content: 'Réponse' }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'compacted',
          upToMessageId: 'msg-assistant-1',
          updatedAt: '2026-05-10T08:32:00.000Z',
        },
      },
      sessionCompactionEventsByConversationId: {
        'conv-1': [
          buildCompactionEvent({
            displayAfterMessageId: 'msg-user-1',
            logicalUpToMessageId: 'msg-assistant-1',
            completedAt: '2026-05-10T08:32:00.000Z',
          }),
        ],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().querySelector('[data-chat-compaction-progress="true"]')).toBeNull();
    const boundary = requireContainer().querySelector('[data-chat-compaction-boundary="true"]');
    expect(boundary).not.toBeNull();
    expect(boundary?.textContent).toContain(COMPACTION_BOUNDARY_TEXT);
    expect(boundary?.querySelector('.chat-streaming-compaction__wave')).toBeNull();
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

    expect(requireContainer().textContent).toContain('Task worktree is not ready yet.');
  });

  it('keeps manual compaction out of the header while preserving compacted transcript state', async () => {
    localStorage.setItem('macro_compaction.manualVisible', JSON.stringify(true));
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Réponse avant compression',
        }),
        buildMessage({ id: 'msg-user-2', role: 'user', content: 'Message après compression' }),
      ],
      conversationCompactionStatusById: {
        'conv-1': {
          phase: 'compacted',
          upToMessageId: 'msg-assistant-1',
          updatedAt: '2026-05-10T08:30:00.000Z',
        },
      },
      sessionCompactionEventsByConversationId: {
        'conv-1': [buildCompactionEvent()],
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    await act(async () => undefined);

    expect(
      requireContainer().querySelector('button[aria-label="Compacter maintenant"]')
    ).toBeNull();
    expect(
      requireContainer().querySelector('[data-chat-compaction-boundary="true"]')
    ).not.toBeNull();
  });

  it('renders transcript progress when manual compaction starts from the context popover', async () => {
    let resolveCompaction: (() => void) | null = null;
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Réponse avant compactage manuel',
        }),
        buildMessage({ id: 'msg-user-2', role: 'user', content: 'Deuxième demande' }),
        buildMessage({
          id: 'msg-assistant-2',
          role: 'assistant',
          content: 'Réponse intermédiaire',
        }),
        buildMessage({ id: 'msg-user-3', role: 'user', content: 'Troisième demande' }),
      ],
      compactConversationNow: mock(
        () => {
          useChatStore.setState((state) => ({
            conversationCompactionStatusById: {
              ...state.conversationCompactionStatusById,
              'conv-1': {
                phase: 'compacting',
                upToMessageId: 'msg-assistant-1',
                updatedAt: '2026-05-10T08:30:00.000Z',
                summaryText: 'Previous compacted summary.',
              },
            },
            sessionCompactionEventsByConversationId: {
              ...state.sessionCompactionEventsByConversationId,
              'conv-1': [
                buildCompactionEvent({
                  status: 'running',
                  displayAfterMessageId: 'msg-assistant-1',
                  completedAt: null,
                }),
              ],
            },
          }));
          return new Promise<ReturnType<typeof buildManualCompactionCompletedResult>>((resolve) => {
            resolveCompaction = () => resolve(buildManualCompactionCompletedResult());
          });
        },
      ),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    await act(async () => undefined);

    expect(
      requireContainer().querySelector('button[aria-label="Compacter maintenant"]'),
    ).toBeNull();

    await act(async () => {
      requireContainer()
        .querySelector<HTMLButtonElement>('button[aria-label="Diagnostic du contexte"]')
        ?.click();
      await Promise.resolve();
    });

    const manualButton = Array.from(
      requireContainer().querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Compacter maintenant'));
    expect(manualButton).not.toBeNull();
    chatState.refreshConversationContextDiagnostics.mockClear();

    await act(async () => {
      manualButton?.click();
      await Promise.resolve();
    });

    const progress = requireContainer().querySelector('[data-chat-compaction-progress="true"]');
    expect(progress).not.toBeNull();
    expect(progress?.textContent).toContain(COMPACTION_PROGRESS_TEXT);
    expect(progress?.getAttribute('data-chat-compaction-progress-phase')).toBe('compacting');
    expect(progress?.querySelector('.chat-compaction-wave-text')).not.toBeNull();
    expect(progress?.querySelector('[data-spinner-icon="true"] .animate-spin')).toBeNull();
    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting-spinner"]'),
    ).not.toBeNull();

    await act(async () => {
      resolveCompaction?.();
      await Promise.resolve();
    });
    expect(chatState.refreshConversationContextDiagnostics).toHaveBeenCalledWith('conv-1', {
      mode: 'full',
    });
    expect(notifySuccessMock).toHaveBeenCalledWith(
      'Contexte compacté',
      expect.objectContaining({
        description: expect.stringContaining('tokens économisés'),
      }),
    );
  });

  it('greys manual compaction without rendering transcript progress when history is too short', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Réponse courte',
        }),
      ],
      compactConversationNow: mock(async () =>
        buildManualCompactionSkippedResult({
          reason: 'not_enough_history',
          userTurnCount: 2,
        })
      ),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    await act(async () => undefined);

    await act(async () => {
      requireContainer()
        .querySelector<HTMLButtonElement>('button[aria-label="Diagnostic du contexte"]')
        ?.click();
      await Promise.resolve();
    });

    const manualButton = Array.from(
      requireContainer().querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Rien à compacter'));
    expect(manualButton).not.toBeNull();
    expect(manualButton?.disabled).toBe(true);
    expect(manualButton?.getAttribute('title')).toContain("plus d'historique");
    expect(requireContainer().textContent).not.toContain('Action manuelle');
    expect(requireContainer().textContent).not.toContain("plus d'historique");
    chatState.refreshConversationContextDiagnostics.mockClear();

    await act(async () => {
      manualButton?.click();
      await Promise.resolve();
    });

    expect(chatState.compactConversationNow).not.toHaveBeenCalled();
    expect(notifyInfoMock).not.toHaveBeenCalled();
    expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
    expect(
      requireContainer().querySelector('[data-chat-compaction-progress="true"]'),
    ).toBeNull();
  });

  it('recovers the manual compaction button after a compaction failure', async () => {
    const originalWarn = console.warn;
    console.warn = mock(() => undefined) as unknown as typeof console.warn;
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Premier message' }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Réponse avant échec de compactage',
        }),
        buildMessage({ id: 'msg-user-2', role: 'user', content: 'Deuxième demande' }),
        buildMessage({
          id: 'msg-assistant-2',
          role: 'assistant',
          content: 'Réponse intermédiaire',
        }),
        buildMessage({ id: 'msg-user-3', role: 'user', content: 'Troisième demande' }),
      ],
      compactConversationNow: mock(async () => {
        throw new Error('compaction failed');
      }),
    };

    try {
      await act(async () => {
        requireRoot().render(<ChatZone />);
      });
      await act(async () => undefined);

      await act(async () => {
        requireContainer()
          .querySelector<HTMLButtonElement>('button[aria-label="Diagnostic du contexte"]')
          ?.click();
        await Promise.resolve();
      });

      const manualButton = Array.from(
        requireContainer().querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.includes('Compacter maintenant'));
      expect(manualButton).not.toBeNull();
      chatState.refreshConversationContextDiagnostics.mockClear();

      await act(async () => {
        manualButton?.click();
        await Promise.resolve();
      });

      expect(chatState.compactConversationNow).toHaveBeenCalledWith('conv-1');
      expect(notifyErrorMock).toHaveBeenCalledWith(
        'Compactage impossible',
        expect.objectContaining({
          description: 'compaction failed',
        }),
      );
      expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
      expect(
        Array.from(requireContainer().querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent?.includes('Compacter maintenant'),
        )?.disabled,
      ).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
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

  it('locks Architect chat when no plan is selected', async () => {
    appState = {
      ...appState,
      mode: 'Architect',
      activeArchitectPlanId: null,
      activePlanContext: null,
    };
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Conversation architecte' }),
      ],
      selectedConversationId: 'conv-1',
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });
    await act(async () => undefined);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    });

    expect(
      requireContainer().querySelector('button[aria-label="Diagnostic du contexte"]')
    ).toBeNull();
    expect(
      requireContainer().querySelector('button[aria-label="Compacter maintenant"]')
    ).toBeNull();
    expect(requireContainer().textContent).not.toContain('Conversation architecte');
    expect(requireContainer().textContent).toContain('Select or create a plan to start architecting.');
    expect(requireContainer().textContent).not.toContain('New Conversation');
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.disabled).toBe(true);
    const sendButton = requireContainer().querySelector('[data-tour-id="chat-send-button"]') as HTMLButtonElement | null;
    expect(sendButton?.disabled).toBe(true);
    expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
  });

  it('offers to create a plan in the central panel when none exists', async () => {
    appState = {
      ...appState,
      mode: 'Architect',
      activeArchitectPlanId: null,
      activePlanContext: null,
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('macro:architect-plan-selector-state', {
          detail: {
            status: 'ready',
            planCount: 0,
            canCreate: true,
            canSelect: false,
          },
        }),
      );
    });

    const button = requireContainer().querySelector(
      '[data-tour-id="architect-empty-plan-action"]'
    ) as HTMLButtonElement | null;
    expect(button?.textContent).toContain('Create a plan');

    const requestDetails: unknown[] = [];
    const handleRequest = (event: Event) => {
      requestDetails.push((event as CustomEvent).detail);
    };
    window.addEventListener('macro:architect-plan-selector-request', handleRequest);
    try {
      await act(async () => {
        button?.click();
      });
    } finally {
      window.removeEventListener('macro:architect-plan-selector-request', handleRequest);
    }

    expect(requestDetails).toEqual([{ action: 'primary' }]);
  });

  it('offers to select a plan in the central panel when plans exist', async () => {
    appState = {
      ...appState,
      mode: 'Architect',
      activeArchitectPlanId: null,
      activePlanContext: null,
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('macro:architect-plan-selector-state', {
          detail: {
            status: 'ready',
            planCount: 2,
            canCreate: true,
            canSelect: true,
          },
        }),
      );
    });

    const button = requireContainer().querySelector(
      '[data-tour-id="architect-empty-plan-action"]'
    ) as HTMLButtonElement | null;
    expect(button?.textContent).toContain('Select a plan');
  });

  it('does not create or send an Architect message when no plan is selected', async () => {
    appState = {
      ...appState,
      mode: 'Architect',
      activeArchitectPlanId: null,
      activePlanContext: null,
    };
    chatState = {
      ...chatState,
      selectedConversationId: null,
      ensureConversationForCurrentMode: mock(async () => 'conv-1'),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    composerEditorValue = 'Peux-tu préparer le plan ?';
    await act(async () => {
      await (latestComposerProps?.onSend as (() => Promise<void>) | undefined)?.();
    });

    expect(chatState.ensureConversationForCurrentMode).not.toHaveBeenCalled();
    expect(chatState.createConversation).not.toHaveBeenCalled();
    expect(chatState.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps Architect chat enabled when an active plan id exists before plan details load', async () => {
    appState = {
      ...appState,
      mode: 'Architect',
      activeArchitectPlanId: 'plan-1',
      activePlanContext: null,
    };
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Plan à charger' }),
      ],
      selectedConversationId: 'conv-1',
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('button[aria-label="Diagnostic du contexte"]')
    ).not.toBeNull();
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer?.disabled).toBe(false);
  });

  it('does not treat an Architect plan context alone as a selected plan', async () => {
    appState = {
      ...appState,
      mode: 'Architect',
      activeArchitectPlanId: null,
      activePlanContext: { id: 'plan-1' },
    };
    chatState = {
      ...chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Plan hydraté' }),
      ],
      selectedConversationId: 'conv-1',
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(
      requireContainer().querySelector('button[aria-label="Diagnostic du contexte"]')
    ).toBeNull();
    expect(requireContainer().textContent).toContain('Select or create a plan to start architecting.');
  });

  it('blocks orphan architect conversations when no project is available', async () => {
    appState = {
      ...appState,
      mode: 'Architect',
      selectedGroupId: null,
      selectedProjectId: null,
      projectGroups: [],
      activeArchitectPlanId: null,
    };
    chatState = {
      ...chatState,
      messages: [buildMessage({ content: 'Old orphan architect conversation' })],
      selectedConversationId: 'conv-1',
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Ajoutez un projet pour commencer avec Macro.');
    expect(requireContainer().textContent).not.toContain('Old orphan architect conversation');
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer?.disabled).toBe(true);
  });

  it('renders architect plan naming recovery actions when a plan still needs a name', async () => {
    appState.mode = 'Architect';
    chatState = {
      ...chatState,
      architectPlanNamingRecovery: {
        conversationId: 'conv-1',
        planId: 'plan-1',
        targetBranch: 'develop',
        firstUserContent: 'On doit renommer le plan.',
        providerId: 'provider-1',
        modelId: 'model-1',
        stage: 'choice',
        isSubmitting: false,
        error: null,
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Plan name still needed');
    expect(requireContainer().textContent).toContain('Retry AI');
    expect(requireContainer().textContent).toContain('Name manually');
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
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    });

    expect(chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
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
          content: "La limite de 3 tours agent a ete atteinte.\nOutils utilises avant l'arret: read.",
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

  it('hides the Architect progress button before the first user explanation', async () => {
    appState.mode = 'Architect';
    appState.activeArchitectPlanId = 'plan-1';
    chatState.messages = [];
    needsState.needs = [];

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).not.toContain('Identify Needs');
    expect(requireContainer().textContent).not.toContain('Clarify Needs');
    expect(requireContainer().textContent).not.toContain('Generate Strategy');
  });

  it('sends the Architect identify-needs action after the first explanation', async () => {
    appState.mode = 'Architect';
    appState.activeArchitectPlanId = 'plan-1';
    chatState.messages = [
      buildMessage({
        id: 'msg-user-1',
        role: 'user',
        content: 'I want to rebuild the onboarding flow.',
      }),
    ];
    needsState.needs = [];

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const button = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Identify Needs')
    );

    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
    });

    expect(composerEditorSetTextCalls).toHaveLength(0);
    expect(composerEditorFocusCalls).toBe(0);
    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('need_add'),
    });
    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('question'),
    });
  });

  it('sends the Architect clarify-needs action while keeping generation available', async () => {
    appState.mode = 'Architect';
    appState.activeArchitectPlanId = 'plan-1';
    needsState.needs = [
      {
        id: 'need-1',
        planId: 'plan-1',
        status: 'refined',
      },
    ];

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const buttons = Array.from(requireContainer().querySelectorAll('button'));
    const button = buttons.find((candidate) =>
      candidate.textContent?.includes('Clarify Needs')
    );
    const generateButton = buttons.find((candidate) =>
      candidate.textContent?.includes('Generate Strategy')
    ) as HTMLButtonElement | undefined;

    expect(button).toBeDefined();
    expect(generateButton).toBeDefined();
    expect(generateButton?.disabled).toBe(false);
    expect(generateButton?.title).toBe('Generate strategy from current needs');
    expect(buttons.indexOf(button as HTMLButtonElement)).toBeLessThan(
      buttons.indexOf(generateButton as HTMLButtonElement),
    );

    await act(async () => {
      button?.click();
    });

    expect(composerEditorSetTextCalls).toHaveLength(0);
    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('need_update'),
    });
    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('validated'),
    });
    expect(chatState.sendMessage).not.toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('strategy_generate'),
    });

    chatState.sendMessage.mockClear();

    await act(async () => {
      generateButton?.click();
    });

    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('call `strategy_generate`'),
    });
  });

  it('keeps an existing composer draft when sending an Architect action', async () => {
    appState.mode = 'Architect';
    appState.activeArchitectPlanId = 'plan-1';
    chatState.messages = [
      buildMessage({
        id: 'msg-user-1',
        role: 'user',
        content: 'I want to rebuild the onboarding flow.',
      }),
    ];
    composerEditorValue = 'Existing user draft';

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const button = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Identify Needs')
    );

    await act(async () => {
      button?.click();
    });

    expect(composerEditorValue).toBe('Existing user draft');
    expect(composerEditorSetTextCalls).toHaveLength(0);
    expect(composerEditorFocusCalls).toBe(0);
    expect(notifyInfoMock).not.toHaveBeenCalled();
    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('need_add'),
    });
  });

  it('renders Architect action prompts as compact action bubbles', async () => {
    chatState.messages = [
      buildMessage({
        id: 'msg-action-identify',
        role: 'user',
        content:
          'Analyze the codebase for this plan, identify the main product and technical stakes, then add structured needs with `need_add`. Use `need_list` and `need_get` first if useful. If important information is missing, ask me focused questions with the `question` tool before continuing.',
      }),
    ];

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const row = requireContainer().querySelector('#chat-message-msg-action-identify');
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-testid="architect-action-message"]')).not.toBeNull();
    expect(row?.textContent).toContain('Identify Needs');
    expect(row?.textContent).toContain(
      'Ask Architect to inspect the codebase and structure the first needs'
    );
    expect(row?.textContent).not.toContain('need_add');
    expect(row?.querySelector('[data-user-message-content="true"]')).toBeNull();
  });

  it('keeps normal user messages in the standard user bubble', async () => {
    chatState.messages = [
      buildMessage({
        id: 'msg-user-normal',
        role: 'user',
        content: 'I want to rebuild the onboarding flow.',
      }),
    ];

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const row = requireContainer().querySelector('#chat-message-msg-user-normal');
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-testid="architect-action-message"]')).toBeNull();
    expect(row?.querySelector('[data-user-message-content="true"]')).not.toBeNull();
    expect(row?.textContent).toContain('I want to rebuild the onboarding flow.');
  });

  it('asks for a natural-language recap after Generate Strategy in Architect mode', async () => {
    appState.mode = 'Architect';
    appState.activeArchitectPlanId = 'plan-1';
    appState.planNodes = [];
    appState.predictedBranches = [];
    needsState.needs = [{ id: 'need-1', planId: 'plan-1', status: 'validated' }];

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const button = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Generate Strategy')
    );

    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
    });

    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('call `strategy_generate`'),
    });
    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('short summary of the strategy'),
    });
  });

  it('disables strategy regeneration after plan validation', async () => {
    appState.mode = 'Architect';
    appState.activeArchitectPlanId = 'plan-1';
    appState.activePlanContext = {
      id: 'plan-1',
      title: 'Plan verrouillé',
      description: '',
      status: 'validated',
      targetBranch: 'develop',
    };
    appState.planNodes = [{ id: 'node-1', title: 'Existing strategy node' }];
    needsState.needs = [{ id: 'need-1', planId: 'plan-1', status: 'validated' }];

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const button = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Regenerate Strategy')
    ) as HTMLButtonElement | undefined;

    expect(button).toBeDefined();
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe('Strategy is locked after plan validation.');

    await act(async () => {
      button?.click();
    });

    expect(chatState.sendMessage).not.toHaveBeenCalled();
  });

  it('renders provider, model, and reasoning selectors in the toolbar', async () => {
    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().querySelector('[data-testid="provider-dropdown"]')).not.toBeNull();
    expect(requireContainer().querySelector('[data-testid="model-dropdown"]')).not.toBeNull();
    expect(requireContainer().querySelector('[data-testid="reasoning-dropdown"]')).not.toBeNull();
  });

  it('shows a read-only task todo dropdown in the Implement header', async () => {
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
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'InProgress',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
          todos: [
            { id: 'todo-api', title: 'Wire checkout API', status: 'done' },
            {
              id: 'todo-tests',
              title: 'Update tests',
              description: 'Cover the checkout happy path.',
              status: 'in-progress',
            },
          ],
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const toggle = requireContainer().querySelector(
      '[data-testid="implement-task-todos-toggle"]'
    ) as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-label')).toBe('Show task checklist');
    expect(toggle?.querySelector('[data-icon="list-todo"]')).not.toBeNull();
    expect(toggle?.querySelector('[data-icon="chevron-down"]')).toBeNull();
    expect(requireContainer().textContent).toContain('Implement checkout');
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).toBeNull();

    await act(async () => {
      toggle?.click();
    });

    const dropdown = requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]');
    expect(dropdown).not.toBeNull();
    expect(dropdown?.getAttribute('role')).toBe('dialog');
    expect(dropdown?.className).toContain('max-h-');
    expect(
      dropdown?.querySelector('[data-testid="implement-task-todos-list"]')?.className
    ).toContain('overflow-y-auto');
    expect(dropdown?.textContent).toContain('1/2');
    expect(dropdown?.textContent).toContain('Wire checkout API');
    expect(dropdown?.textContent).toContain('Update tests');
    expect(dropdown?.textContent).not.toContain('Cover the checkout happy path.');
    expect(dropdown?.querySelectorAll('[data-implement-task-todo]')).toHaveLength(2);
    expect(dropdown?.querySelector('[data-todo-status-icon="done"]')).not.toBeNull();
    expect(dropdown?.querySelector('[data-todo-status-icon="in-progress"] .animate-spin')).not.toBeNull();

    await act(async () => {
      toggle?.click();
    });

    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).toBeNull();
  });

  it('closes the task todo dropdown on Escape and outside click', async () => {
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
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'InProgress',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
          todos: [{ id: 'todo-api', title: 'Wire checkout API', status: 'pending' }],
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const toggle = requireContainer().querySelector(
      '[data-testid="implement-task-todos-toggle"]'
    ) as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle?.click();
    });
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).toBeNull();

    await act(async () => {
      toggle?.click();
    });
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).toBeNull();
  });

  it('hides the Implement header todo dropdown for tasks without stored todos', async () => {
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
          title: 'Legacy checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'InProgress',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Legacy checkout');
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-toggle"]')).toBeNull();
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).toBeNull();
  });

  it('hides the Implement header todo dropdown for standalone and finalization tasks', async () => {
    appState = {
      ...appState,
      mode: 'Implement',
      selectedTaskId: 'standalone-task',
    };
    taskState = {
      ...taskState,
      tasks: [
        {
          id: 'standalone-task',
          title: 'Standalone feature',
          draft: false,
          task_source: 'standalone',
          is_blocked: false,
          status: 'InProgress',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'manual',
          branch_name: 'feature/manual',
          dependencies: [],
          estimated_changes: [],
          description: 'Manual work.',
          todos: [{ id: 'todo-hidden', title: 'Hidden todo', status: 'pending' }],
        },
        {
          id: 'plan-finalization:plan-1',
          title: 'Finalize plan',
          draft: false,
          task_source: 'plan_finalization',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'develop',
          dependencies: [],
          estimated_changes: [],
          description: 'Merge the plan.',
          todos: [{ id: 'todo-hidden-final', title: 'Hidden final todo', status: 'pending' }],
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().querySelector('[data-testid="implement-task-todos-toggle"]')).toBeNull();

    await act(async () => {
      appState = { ...appState, selectedTaskId: 'plan-finalization:plan-1' };
      useAppStore.emit();
    });

    expect(requireContainer().textContent).toContain('Finalize plan');
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-toggle"]')).toBeNull();
  });

  it('uses the bottom composer as the only kickoff input for planned tasks with an empty conversation', async () => {
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
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Task briefing');
    expect(requireContainer().textContent).toContain('Start execution');
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.disabled).toBe(false);
    expect(composer?.getAttribute('placeholder')).toBe('Optional guidance for this task kickoff');
    expect(requireContainer().querySelectorAll('textarea')).toHaveLength(1);
    expect(taskState.startTask).not.toHaveBeenCalled();
    expect(chatState.sendMessage).not.toHaveBeenCalled();
  });

  it('shows a locked Implement state for dependency-blocked tasks', async () => {
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
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: true,
          blocked_by: ['Prepare checkout model'],
          status: 'Blocked',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: ['task-0'],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Task blocked');
    expect(requireContainer().textContent).toContain('Blocked by: Prepare checkout model');
    expect(requireContainer().textContent).not.toContain('Task briefing');
    expect(requireContainer().textContent).not.toContain('Optional guidance for this task kickoff');
    expect(requireContainer().querySelector('[data-icon="lock"]')).not.toBeNull();
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.disabled).toBe(true);
    expect(composer?.getAttribute('placeholder')).toBe('Task blocked until prerequisites are completed');
    expect(taskState.startTask).not.toHaveBeenCalled();
    expect(chatState.sendMessage).not.toHaveBeenCalled();
  });

  it('routes the first planned task composer send through the kickoff flow', async () => {
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
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await act(async () => {
      composerEditorValue = 'Need to reuse checkout components.';
      const onTextChange = latestComposerProps?.onTextChange as
        | ((value: string) => void)
        | undefined;
      onTextChange?.(composerEditorValue);
    });

    const sendButton = requireContainer()
      .querySelector('span[data-icon="arrow-up"]')
      ?.closest('button') as HTMLButtonElement | null;
    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(false);

    await act(async () => {
      sendButton?.click();
    });

    expect(taskState.startTask).toHaveBeenCalledWith('task-1');
    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('DEVELOPER NOTES\nNeed to reuse checkout components.'),
      taskId: 'task-1',
    });
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer?.value).toBe('');
  });

  it('reuses the bottom composer text when clicking Start execution', async () => {
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
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    await act(async () => {
      composerEditorValue = 'Focus on a minimal diff.';
      const onTextChange = latestComposerProps?.onTextChange as
        | ((value: string) => void)
        | undefined;
      onTextChange?.(composerEditorValue);
    });

    const startExecutionButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Start execution')
    );
    expect(startExecutionButton).toBeDefined();

    await act(async () => {
      startExecutionButton?.click();
    });

    expect(taskState.startTask).toHaveBeenCalledWith('task-1');
    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('DEVELOPER NOTES\nFocus on a minimal diff.'),
      taskId: 'task-1',
    });
  });

  it('skips kickoff UI for standalone tasks with an empty conversation', async () => {
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

    expect(requireContainer().textContent).not.toContain('Task briefing');
    expect(requireContainer().textContent).not.toContain('Start execution');
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.disabled).toBe(false);
    expect(composer?.getAttribute('placeholder')).toBe('Type your message');
  });

  it('resets a newly selected standalone task to Build mode once', async () => {
    appState = {
      ...appState,
      mode: 'Implement',
      agentType: 'plan',
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

    expect(appState.setAgentType).toHaveBeenCalledWith('build');
  });

  it('sends the first standalone task message directly from the composer', async () => {
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

    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();

    await act(async () => {
      composerEditorValue = 'Implement the standalone feature directly.';
      const onTextChange = latestComposerProps?.onTextChange as
        | ((value: string) => void)
        | undefined;
      onTextChange?.(composerEditorValue);
    });

    const sendButton = requireContainer()
      .querySelector('span[data-icon="arrow-up"]')
      ?.closest('button') as HTMLButtonElement | null;
    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(false);

    await act(async () => {
      sendButton?.click();
    });

    expect(chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: 'Implement the standalone feature directly.',
      taskId: 'task-1',
      images: [],
    });
    expect(taskState.startTask).not.toHaveBeenCalled();
  });

  it('shows the focused project name instead of a multi-repository count in the kickoff summary', async () => {
    appState = {
      ...appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-2',
      projectGroups: [
        {
          id: 'group-1',
          name: 'Platform',
          projects: [
            { id: 'project-1', name: 'Web' },
            { id: 'project-2', name: 'API' },
            { id: 'project-3', name: 'Worker' },
          ],
        },
      ],
    };
    taskState = {
      ...taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [
            { projectId: 'project-1' },
            { projectId: 'project-2' },
            { projectId: 'project-3' },
          ],
          project_ids: ['project-1', 'project-2', 'project-3'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('API');
    expect(requireContainer().textContent).not.toContain('3 repositories');
  });

  it('keeps a repository count in the kickoff summary when the scoped task still targets multiple repos', async () => {
    appState = {
      ...appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      projectGroups: [
        {
          id: 'group-1',
          name: 'Platform',
          projects: [
            { id: 'project-1', name: 'Web' },
            { id: 'project-2', name: 'API' },
            { id: 'project-3', name: 'Worker' },
          ],
        },
      ],
    };
    taskState = {
      ...taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [
            { projectId: 'project-1' },
            { projectId: 'project-2' },
            { projectId: 'project-3' },
          ],
          project_ids: ['project-1', 'project-2', 'project-3'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('3 repositories');
  });

  it('renders the active questionnaire in the footer and hides the standard composer', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need one blocking decision.',
          questionnaire: {
            intro: 'Need one blocking decision.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Which scope should I use?');
    const footer = requireContainer().querySelector('[data-testid="questionnaire-footer"]');
    const choiceList = requireContainer().querySelector('[data-testid="questionnaire-choice-list"]');
    const stepPanel = requireContainer().querySelector('[data-testid="questionnaire-step-panel"]');
    expect(footer?.textContent).toContain('Question');
    expect(footer?.textContent).not.toContain('Need one blocking decision.');
    expect(choiceList?.className).toContain('flex-col');
    expect(stepPanel?.className).toContain('questionnaire-step-enter');
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).toBeNull();
  });

  it('renders the active tool approval footer and hides the standard composer', async () => {
    chatState = {
      ...chatState,
      pendingToolApprovalByConversationId: {
        'conv-1': {
          conversationId: 'conv-1',
          assistantMessageId: 'msg-assistant-1',
          toolCallId: 'tool-call-1',
          toolId: 'terminal_run',
          actionGroup: 'escape',
          riskLevel: 'balanced',
          isDestructive: true,
          summary: 'Run a terminal command',
          detail: 'npm test',
          rememberKey: 'terminal:npm test',
        },
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const footer = requireContainer().querySelector('[data-testid="tool-approval-footer"]');
    expect(footer?.textContent).toContain('Tool approval');
    expect(footer?.textContent).toContain('Run a terminal command');
    expect(footer?.textContent).toContain('System');
    expect(footer?.textContent).not.toContain('terminal_run');
    expect(footer?.textContent).toContain('Allow once');
    expect(footer?.textContent).toContain('Allow for this conversation');
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).toBeNull();
  });

  it('forwards tool approval actions to the chat store', async () => {
    chatState = {
      ...chatState,
      pendingToolApprovalByConversationId: {
        'conv-1': {
          conversationId: 'conv-1',
          assistantMessageId: 'msg-assistant-1',
          toolCallId: 'tool-call-1',
          toolId: 'web_fetch',
          actionGroup: 'escape',
          riskLevel: 'balanced',
          isDestructive: false,
          summary: 'Fetch a web page',
          detail: 'example.com',
          rememberKey: 'domain:example.com',
        },
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const allowOnceButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Allow once')
    );
    const allowConversationButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Allow for this conversation')
    );
    const denyButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Refuse')
    );

    await act(async () => {
      allowOnceButton?.click();
      allowConversationButton?.click();
      denyButton?.click();
    });

    expect(chatState.approvePendingToolApprovalOnce).toHaveBeenCalledWith('conv-1');
    expect(chatState.approvePendingToolApprovalForConversation).toHaveBeenCalledWith('conv-1');
    expect(chatState.denyPendingToolApproval).not.toHaveBeenCalled();
  });

  it('forwards tool denial confirmations to the chat store', async () => {
    chatState = {
      ...chatState,
      pendingToolApprovalByConversationId: {
        'conv-1': {
          conversationId: 'conv-1',
          assistantMessageId: 'msg-assistant-1',
          toolCallId: 'tool-call-1',
          toolId: 'web_fetch',
          actionGroup: 'escape',
          riskLevel: 'balanced',
          isDestructive: false,
          summary: 'Fetch a web page',
          detail: 'example.com',
          rememberKey: 'domain:example.com',
        },
      },
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const denyButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Refuse')
    );

    await act(async () => {
      denyButton?.click();
    });

    const confirmDenyButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Confirm denial')
    );

    await act(async () => {
      confirmDenyButton?.click();
    });

    expect(chatState.denyPendingToolApproval).toHaveBeenCalledWith('conv-1', undefined);
  });

  it('submits the questionnaire when the user clicks a suggested answer', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need one blocking decision.',
          questionnaire: {
            intro: 'Need one blocking decision.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        }),
      ],
      recordActiveQuestionnaireAnswer: mock(() => ({ completed: true, state: null })),
      submitActiveQuestionnaire: mock(async () => ({ status: 'sent' })),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const button = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Balanced')
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
    });

    expect(chatState.recordActiveQuestionnaireAnswer).toHaveBeenCalledWith('conv-1', 'Balanced');
    expect(chatState.submitActiveQuestionnaire).toHaveBeenCalledWith('conv-1');
  });

  it('renders the inline free-text questionnaire input in the footer', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need one blocking decision.',
          questionnaire: {
            intro: 'Need one blocking decision.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
                free_text_placeholder: 'Custom answer',
              },
            ],
          },
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const input = requireContainer().querySelector('input');
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).getAttribute('placeholder')).toBe('Custom answer');
  });

  it('updates the question and choices when advancing to the next questionnaire step', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need two decisions.',
          questionnaire: {
            intro: 'Need two decisions.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
              },
            ],
          },
        }),
      ],
      recordActiveQuestionnaireAnswer: mock((_conversationId: string, answer: string) => {
        chatState = {
          ...chatState,
          questionnaireDraftsByConversationId: {
            ...chatState.questionnaireDraftsByConversationId,
            'conv-1': {
              assistantMessageId: 'msg-assistant-1',
              currentStepIndex: 1,
              answersByStepId: {
                scope: answer,
              },
              draftTextByStepId: {},
            },
          },
        };
        useChatStore.emit();
        return {
          completed: false,
          state: null,
        };
      }),
      submitActiveQuestionnaire: mock(async () => ({ status: 'sent' })),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Which scope should I use?');
    expect(requireContainer().textContent).toContain('Balanced');

    const firstStepButton = Array.from(
      requireContainer().querySelectorAll('button')
    ).find((candidate) => candidate.textContent?.includes('Balanced'));
    expect(firstStepButton).toBeDefined();

    await act(async () => {
      firstStepButton?.click();
    });

    expect(requireContainer().textContent).toContain('How risky can the change be?');
    expect(requireContainer().textContent).toContain('Aggressive');
    expect(requireContainer().textContent).not.toContain('Which scope should I use?');
    expect(requireContainer().textContent).not.toContain('Balanced');
    expect(chatState.submitActiveQuestionnaire).not.toHaveBeenCalled();
    expect(
      requireContainer()
        .querySelector('[data-testid="questionnaire-step-panel"]')
        ?.className
    ).toContain('questionnaire-step-enter');
  });

  it('returns to the first unanswered question before submitting a skipped questionnaire step', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need three decisions.',
          questionnaire: {
            intro: 'Need three decisions.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
              },
              {
                id: 'timing',
                prompt: 'How soon do you need it?',
                choices: ['Today', 'This week', 'Later'],
              },
            ],
          },
        }),
      ],
      questionnaireDraftsByConversationId: {
        'conv-1': {
          assistantMessageId: 'msg-assistant-1',
          currentStepIndex: 2,
          answersByStepId: {
            scope: 'Balanced',
          },
          draftTextByStepId: {},
        },
      },
      recordActiveQuestionnaireAnswer: mock((_conversationId: string, answer: string) => {
        chatState = {
          ...chatState,
          questionnaireDraftsByConversationId: {
            ...chatState.questionnaireDraftsByConversationId,
            'conv-1': {
              assistantMessageId: 'msg-assistant-1',
              currentStepIndex: 1,
              answersByStepId: {
                scope: 'Balanced',
                timing: answer,
              },
              draftTextByStepId: {},
            },
          },
        };
        useChatStore.emit();
        return {
          completed: false,
          state: null,
        };
      }),
      submitActiveQuestionnaire: mock(async () => ({ status: 'sent' })),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('How soon do you need it?');

    const lastStepButton = Array.from(
      requireContainer().querySelectorAll('button')
    ).find((candidate) => candidate.textContent?.includes('This week'));
    expect(lastStepButton).toBeDefined();

    await act(async () => {
      lastStepButton?.click();
    });

    expect(chatState.recordActiveQuestionnaireAnswer).toHaveBeenCalledWith('conv-1', 'This week');
    expect(chatState.submitActiveQuestionnaire).not.toHaveBeenCalled();
    expect(requireContainer().textContent).toContain('How risky can the change be?');
    expect(requireContainer().textContent).not.toContain('How soon do you need it?');
  });

  it('lets the user navigate forward and backward between questionnaire steps', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need two decisions.',
          questionnaire: {
            intro: 'Need two decisions.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
              },
            ],
          },
        }),
      ],
      setActiveQuestionnaireStep: mock((_conversationId: string, stepIndex: number) => {
        chatState = {
          ...chatState,
          questionnaireDraftsByConversationId: {
            ...chatState.questionnaireDraftsByConversationId,
            'conv-1': {
              assistantMessageId: 'msg-assistant-1',
              currentStepIndex: stepIndex,
              answersByStepId: {},
              draftTextByStepId: {},
            },
          },
        };
        useChatStore.emit();
      }),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().textContent).toContain('Which scope should I use?');

    const nextButton = requireContainer().querySelector(
      '[data-testid="questionnaire-step-nav-next"]'
    ) as HTMLButtonElement | null;
    expect(nextButton).not.toBeNull();

    await act(async () => {
      nextButton?.click();
    });

    expect(chatState.setActiveQuestionnaireStep).toHaveBeenCalledWith('conv-1', 1);
    expect(requireContainer().textContent).toContain('How risky can the change be?');
    expect(requireContainer().textContent).toContain('Aggressive');
    expect(requireContainer().textContent).not.toContain('Which scope should I use?');

    const previousButton = requireContainer().querySelector(
      '[data-testid="questionnaire-step-nav-prev"]'
    ) as HTMLButtonElement | null;
    expect(previousButton).not.toBeNull();

    await act(async () => {
      previousButton?.click();
    });

    expect(chatState.setActiveQuestionnaireStep).toHaveBeenCalledWith('conv-1', 0);
    expect(requireContainer().textContent).toContain('Which scope should I use?');
    expect(requireContainer().textContent).toContain('Balanced');
    expect(requireContainer().textContent).not.toContain('How risky can the change be?');
    expect(chatState.submitActiveQuestionnaire).not.toHaveBeenCalled();
  });

  it('renders compact step arrows around the questionnaire progress', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need two decisions.',
          questionnaire: {
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
              },
            ],
          },
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const footer = requireContainer().querySelector('[data-testid="questionnaire-footer"]');
    const previousButton = requireContainer().querySelector('[data-testid="questionnaire-step-nav-prev"]');
    const nextButton = requireContainer().querySelector('[data-testid="questionnaire-step-nav-next"]');
    const counterShell = requireContainer().querySelector('[data-testid="questionnaire-step-counter-shell"]');
    const counter = requireContainer().querySelector('[data-testid="questionnaire-step-counter"]');

    expect(footer?.textContent).toContain('Question');
    expect(counter?.textContent).toBe('1/2');
    expect(counterShell).not.toBeNull();
    expect(previousButton).not.toBeNull();
    expect(nextButton).not.toBeNull();
    expect(footer?.textContent).not.toContain('Voir la suite');
    expect(footer?.textContent).not.toContain('Retour');
  });

  it('renders questionnaire response summaries with the dedicated user bubble layout', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content:
            'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
          questionnaire_response_summary: {
            assistantMessageId: 'msg-assistant-1',
            source: 'tool',
            originToolCallId: 'call_question',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                answer: 'Stay below one day of rework',
              },
            ],
          },
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    expect(requireContainer().querySelector('[data-testid="questionnaire-response-summary"]')).not.toBeNull();
    expect(requireContainer().textContent).toContain('Reponses au questionnaire');
    expect(requireContainer().textContent).toContain('Which scope should I use?');
    expect(requireContainer().textContent).toContain('Stay below one day of rework');
  });

  it('reopens questionnaire responses in the footer instead of inline editing', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'assistant-questionnaire',
          role: 'assistant',
          content: 'Need two clarifications.',
          questionnaire: {
            intro: 'Need two clarifications.',
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
                free_text_placeholder: 'Custom answer',
              },
            ],
          },
        }),
        buildMessage({
          id: 'user-questionnaire',
          role: 'user',
          content:
            'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
          questionnaire_response_summary: {
            assistantMessageId: 'assistant-questionnaire',
            source: 'tool',
            originToolCallId: 'call_question',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                answer: 'Stay below one day of rework',
              },
            ],
          },
        }),
      ],
      startQuestionnaireResponseEdit: mock((messageId: string) => {
        useChatStore.setState({
          questionnaireDraftsByConversationId: {
            'conv-1': {
              mode: 'editing_response',
              assistantMessageId: 'assistant-questionnaire',
              responseMessageId: messageId,
              currentStepIndex: 0,
              answersByStepId: {
                scope: 'Balanced',
                risk: 'Stay below one day of rework',
              },
              draftTextByStepId: {
                risk: 'Stay below one day of rework',
              },
            },
          },
        });
        return true;
      }),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const editButton = requireContainer().querySelector('button[title="common.edit"]');
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(chatState.startQuestionnaireResponseEdit).toHaveBeenCalledWith('user-questionnaire');
    expect(requireContainer().querySelector('[data-testid="questionnaire-footer"]')).not.toBeNull();
    expect(requireContainer().querySelector('textarea')).toBeNull();
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).toBeNull();

    const balancedButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Balanced'
    );
    expect(balancedButton?.className).toContain('border-primary/50');
  });

  it('reopens questionnaire responses from conversation-indexed messages after reload', async () => {
    const conversationMessages = [
      buildMessage({
        id: 'assistant-questionnaire',
        role: 'assistant',
        content: 'Need one clarification.',
        questionnaire: {
          source: 'tool',
          questions: [
            {
              id: 'scope',
              prompt: 'Which scope should I use?',
              choices: ['Minimal', 'Balanced', 'Large'],
            },
          ],
        },
      }),
      buildMessage({
        id: 'user-questionnaire',
        role: 'user',
        content: 'Which scope should I use?: Balanced',
        questionnaire_response_summary: {
          assistantMessageId: 'assistant-questionnaire',
          source: 'tool',
          originToolCallId: 'call_question',
          items: [
            {
              id: 'scope',
              prompt: 'Which scope should I use?',
              answer: 'Balanced',
            },
          ],
        },
      }),
    ];
    chatState = {
      ...chatState,
      messages: [],
      messagesByConversationId: {
        'conv-1': conversationMessages,
      },
      startQuestionnaireResponseEdit: mock((messageId: string) => {
        chatState = {
          ...chatState,
          questionnaireDraftsByConversationId: {
            'conv-1': {
              mode: 'editing_response',
              assistantMessageId: 'assistant-questionnaire',
              responseMessageId: messageId,
              currentStepIndex: 0,
              answersByStepId: {
                scope: 'Balanced',
              },
              draftTextByStepId: {},
            },
          },
        };
        useChatStore.emit();
        return true;
      }),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const editButton = requireContainer().querySelector('button[title="common.edit"]');
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(chatState.startQuestionnaireResponseEdit).toHaveBeenCalledWith('user-questionnaire');
    expect(requireContainer().querySelector('[data-testid="questionnaire-footer"]')).not.toBeNull();
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).toBeNull();
    expect(requireContainer().querySelectorAll('textarea')).toHaveLength(0);
  });

  it('does not fall back to raw text editing when questionnaire response edit cannot reopen', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'user-questionnaire',
          role: 'user',
          content: 'Which scope should I use?: Balanced',
          questionnaire_response_summary: {
            assistantMessageId: 'missing-assistant-questionnaire',
            source: 'tool',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
            ],
          },
        }),
      ],
      startQuestionnaireResponseEdit: mock(() => false),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const editButton = requireContainer().querySelector('button[title="common.edit"]');
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(chatState.startQuestionnaireResponseEdit).toHaveBeenCalledWith('user-questionnaire');
    expect(requireContainer().querySelector('[data-testid="questionnaire-footer"]')).toBeNull();
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).not.toBeNull();
    expect(requireContainer().querySelectorAll('textarea')).toHaveLength(1);
  });

  it('cancels questionnaire response editing without touching the message history', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'assistant-questionnaire',
          role: 'assistant',
          content: 'Need one clarification.',
          questionnaire: {
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        }),
        buildMessage({
          id: 'user-questionnaire',
          role: 'user',
          content: 'Which scope should I use?: Balanced',
          questionnaire_response_summary: {
            assistantMessageId: 'assistant-questionnaire',
            source: 'tool',
            originToolCallId: 'call_question',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
            ],
          },
        }),
      ],
      questionnaireDraftsByConversationId: {
        'conv-1': {
          mode: 'editing_response',
          assistantMessageId: 'assistant-questionnaire',
          responseMessageId: 'user-questionnaire',
          currentStepIndex: 0,
          answersByStepId: {
            scope: 'Balanced',
          },
          draftTextByStepId: {},
        },
      },
      cancelQuestionnaireSession: mock((conversationId: string) => {
        const nextDrafts = { ...chatState.questionnaireDraftsByConversationId };
        delete nextDrafts[conversationId];
        chatState = {
          ...chatState,
          questionnaireDraftsByConversationId: nextDrafts,
        };
        useChatStore.emit();
      }),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const cancelButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Annuler'
    );
    expect(cancelButton).not.toBeNull();

    await act(async () => {
      cancelButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(chatState.cancelQuestionnaireSession).toHaveBeenCalledWith('conv-1');
    expect(requireContainer().querySelector('[data-testid="questionnaire-footer"]')).toBeNull();
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).not.toBeNull();
    expect(chatState.editMessage).not.toHaveBeenCalled();
    expect(chatState.submitActiveQuestionnaire).not.toHaveBeenCalled();
  });

  it('keeps only questionnaire cancel enabled while editing during streaming', async () => {
    chatState = {
      ...chatState,
      messages: [
        buildMessage({
          id: 'assistant-questionnaire',
          role: 'assistant',
          content: 'Need one clarification.',
          questionnaire: {
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        }),
        buildMessage({
          id: 'user-questionnaire',
          role: 'user',
          content: 'Which scope should I use?: Balanced',
          questionnaire_response_summary: {
            assistantMessageId: 'assistant-questionnaire',
            source: 'tool',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
            ],
          },
        }),
      ],
      questionnaireDraftsByConversationId: {
        'conv-1': {
          mode: 'editing_response',
          assistantMessageId: 'assistant-questionnaire',
          responseMessageId: 'user-questionnaire',
          currentStepIndex: 0,
          answersByStepId: {
            scope: 'Balanced',
          },
          draftTextByStepId: {},
        },
      },
      isStreaming: true,
      sendState: 'streaming',
      cancelQuestionnaireSession: mock((conversationId: string) => {
        const nextDrafts = { ...chatState.questionnaireDraftsByConversationId };
        delete nextDrafts[conversationId];
        chatState = {
          ...chatState,
          questionnaireDraftsByConversationId: nextDrafts,
        };
        useChatStore.emit();
      }),
    };

    await act(async () => {
      requireRoot().render(<ChatZone />);
    });

    const cancelButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Annuler'
    ) as HTMLButtonElement | undefined;
    const submitButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Envoyer'
    ) as HTMLButtonElement | undefined;
    const choiceButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Balanced'
    ) as HTMLButtonElement | undefined;
    const textInput = requireContainer().querySelector('input[type="text"]') as HTMLInputElement | null;

    expect(cancelButton).not.toBeNull();
    expect(cancelButton?.disabled).toBe(false);
    expect(submitButton?.disabled).toBe(true);
    expect(choiceButton?.disabled).toBe(true);
    expect(textInput?.disabled).toBe(true);

    await act(async () => {
      cancelButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(chatState.cancelQuestionnaireSession).toHaveBeenCalledWith('conv-1');
    expect(chatState.stopStreaming).not.toHaveBeenCalled();
    expect(requireContainer().querySelector('[data-testid="questionnaire-footer"]')).toBeNull();
  });
});
