import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../test-utils/reactI18nextMock';

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
  getConversationRuntime: (conversationId: string) => {
    phase: 'idle' | 'preparing' | 'streaming' | 'error';
    sessionId: string | null;
    assistantMessageId?: string | null;
    lastError?: string | null;
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
        rememberKey: string;
    }
  >;
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
  getMessageImages: ReturnType<typeof mock>;
  setMessageImages: ReturnType<typeof mock>;
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
};

type AppStoreState = {
  mode: AppMode;
  agentType: string;
  setAgentType: ReturnType<typeof mock>;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  projectGroups: unknown[];
  activeArchitectPlanId: string | null;
  planNodes: unknown[];
  predictedBranches: unknown[];
};

type ProviderState = {
  selectedProviderId: string | null;
  selectedModelId: string | null;
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
  'chat.toolTurnLimitNoticeTitle': 'Tool turn limit reached',
  'chat.toolTurnLimitNoticeDescription': 'Macro stopped the agent loop. Change it in Settings > General > Max agent turns.',
  'chat.toolTurnLimitFallbackTitle': 'Tool turn limit reached',
  'chat.toolTurnLimitFallbackDescription': 'Macro showed a fallback summary.',
});

const scrollContainerRef = { current: null as HTMLDivElement | null };
const markdownRendererContentMock = mock((_content: string) => undefined);
let composerEditorValue = '';
let latestComposerProps: Record<string, unknown> | null = null;

let ChatZone!: typeof import('./ChatZone').default;
let importCounter = 0;

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
    getPlanActivationCandidateTask: () => null,
    useTaskStore,
  }));

  mock.module('../../hooks/useScrollMagnet', () => ({
    useScrollMagnet: () => ({
      scrollContainerRef,
      separatorState: 'hidden',
    }),
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
    MarkdownRenderer: ({ content }: { content: string }) => {
      markdownRendererContentMock(content);
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
    }>) => {
      React.useEffect(() => {
        latestComposerProps = props;
      }, [props]);
      React.useImperativeHandle(ref, () => ({
        getTextContent: () => composerEditorValue,
        clear: () => {
          composerEditorValue = '';
        },
        setText: (value: string) => {
          composerEditorValue = value;
        },
      }));
      return (
        <textarea
          data-testid="composer-editor"
          disabled={props.editable === false}
          placeholder={typeof props.placeholder === 'string' ? props.placeholder : ''}
          value={composerEditorValue}
          onChange={(event) => {
            composerEditorValue = event.target.value;
            if (typeof props.onTextChange === 'function') {
              props.onTextChange(event.target.value);
            }
          }}
        />
      );
    }),
  }));

  const actualGlobalProjects = await import(
    `../../services/globalProjects.ts?chat-zone-global-projects-test=${importCounter}`
  );

  mock.module('../../services/globalProjects', () => ({
    ...actualGlobalProjects,
    getFocusedProjectForGroup: () => null,
    getGlobalProjectById: () => null,
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
    agentType: 'default',
    setAgentType: mock(() => undefined),
    selectedGroupId: 'group-1',
    selectedProjectId: null,
    selectedTaskId: null,
    projectGroups: buildProjectGroups(),
    activeArchitectPlanId: null,
    planNodes: [],
    predictedBranches: [],
  };

  chatState = {
    conversations: [buildConversation()],
    messages: [],
    selectedConversationId: 'conv-1',
    getConversationRuntime: (conversationId: string) =>
      getMockConversationRuntime(chatState, conversationId),
    createConversation: mock(async () => buildConversation()),
    ensureConversationForCurrentMode: mock(async () => 'conv-1'),
    getConversationMessages: (conversationId: string) =>
      chatState.messages.filter((message) => message.conversation_id === conversationId),
    questionnaireDraftsByConversationId: {},
    pendingToolApprovalByConversationId: {},
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
    getMessageImages: mock(() => []),
    setMessageImages: mock(() => undefined),
    architectPlanNamingRecovery: null,
    setArchitectPlanNamingRecoveryStage: mock(() => undefined),
    retryArchitectPlanNamingRecovery: mock(async () => false),
    submitArchitectPlanManualName: mock(async () => false),
    composerContextRefs: [],
  };

  providerState = {
    selectedProviderId: 'provider-1',
    selectedModelId: 'model-1',
  };

  needsState = {
    needs: [],
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
  latestComposerProps = null;
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

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
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

  it('shows assistant activity while a retry is preparing', async () => {
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
  });

  it('asks for a natural-language recap after Generate Strategy in Architect mode', async () => {
    appState.mode = 'Architect';
    appState.activeArchitectPlanId = 'plan-1';
    appState.planNodes = [];
    appState.predictedBranches = [];
    needsState.needs = [{ id: 'need-1', planId: 'plan-1' }];

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
              status: 'pending',
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

  it('shows the focused subproject name instead of a multi-repository count in the kickoff summary', async () => {
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
        chatState.questionnaireDraftsByConversationId = {
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
    expect(requireContainer().querySelector('textarea')).toBeNull();
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).toBeNull();

    const balancedButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Balanced'
    );
    expect(balancedButton?.className).toContain('border-primary/50');
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
});
