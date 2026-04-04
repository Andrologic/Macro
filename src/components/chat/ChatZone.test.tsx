import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type AppMode = 'Chat' | 'Architect' | 'Implement' | 'Debug';

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
  choices?: Array<{ id: string; text: string }>;
};

type MockChatState = {
  conversations: MockConversation[];
  messages: MockMessage[];
  selectedConversationId: string | null;
  createConversation: ReturnType<typeof mock>;
  ensureConversationForCurrentMode: ReturnType<typeof mock>;
  getConversationMessages: (conversationId: string) => MockMessage[];
  hydrationStatus: 'idle' | 'hydrating' | 'ready' | 'error';
  restoreStatus: 'idle' | 'resolving' | 'ready' | 'error';
  isLoading: boolean;
  isStreaming: boolean;
  sendState: 'idle' | 'preparing' | 'streaming' | 'error';
  lastError: string | null;
  stopStreaming: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
  clearLastError: ReturnType<typeof mock>;
  editMessage: ReturnType<typeof mock>;
  getMessageImages: ReturnType<typeof mock>;
  setMessageImages: ReturnType<typeof mock>;
  composerContextRefs: unknown[];
};

type AppStoreState = {
  mode: AppMode;
  agentType: string;
  setAgentType: ReturnType<typeof mock>;
  pendingAutoLaunchPlanId: string | null;
  pendingAutoLaunchTaskId: string | null;
  clearPendingAutoLaunch: ReturnType<typeof mock>;
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
    is_blocked?: boolean;
    status?: string;
    execution_targets?: Array<{ projectId: string }>;
    project_ids?: string[];
    project_id?: string | null;
    plan_id?: string | null;
    branch_name?: string;
    dependencies?: string[];
    estimated_changes?: Array<{ operation: string; path: string }>;
    description?: string;
  }>;
  startTask: ReturnType<typeof mock>;
};

const createStoreHook = <T,>(getSnapshot: () => T) => {
  const hook = ((selector?: (state: T) => unknown) => {
    const snapshot = getSnapshot();
    return selector ? selector(snapshot) : snapshot;
  }) as ((selector?: (state: T) => unknown) => unknown) & { getState: () => T };

  hook.getState = getSnapshot;
  return hook;
};

let appState: AppStoreState;
let chatState: MockChatState;
let providerState: ProviderState;
let needsState: NeedsState;
let shortcutsState: ShortcutsState;
let taskState: TaskState;

const useAppStore = createStoreHook(() => appState);
const useChatStore = createStoreHook(() => chatState);
const useProviderStore = createStoreHook(() => providerState);
const useNeedsStore = createStoreHook(() => needsState);
const useShortcutsStore = createStoreHook(() => shortcutsState);
const useTaskStore = createStoreHook(() => taskState);

const translationMock = {
  t: (key: string, fallbackOrOptions?: string | { defaultValue?: string }, maybeOptions?: { defaultValue?: string }) => {
    const explicitTranslations: Record<string, string> = {
      'chat.typeMessage': 'Type your message',
      'chat.stop': 'Stop',
      'chat.newConversation': 'New Conversation',
    };
    if (key in explicitTranslations) {
      return explicitTranslations[key]!;
    }
    if (typeof fallbackOrOptions === 'string') {
      return fallbackOrOptions;
    }
    return maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? key;
  },
};

const scrollContainerRef = { current: null as HTMLDivElement | null };
const markdownRendererContentMock = mock((_content: string) => undefined);

mock.module('react-i18next', () => ({
  useTranslation: () => translationMock,
}));

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
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

mock.module('../ai/ProviderDropdown', () => ({
  ProviderDropdown: () => <div data-testid="provider-dropdown" />,
}));

mock.module('../ai/ModelDropdown', () => ({
  ModelDropdown: () => <div data-testid="model-dropdown" />,
}));

mock.module('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => {
    markdownRendererContentMock(content);
    return <div>{content}</div>;
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
  default: React.forwardRef((_props: Record<string, unknown>, ref: React.ForwardedRef<{
    getTextContent: () => string;
    clear: () => void;
    setText: (_value: string) => void;
  }>) => {
    React.useImperativeHandle(ref, () => ({
      getTextContent: () => '',
      clear: () => undefined,
      setText: () => undefined,
    }));
    return <div data-testid="composer-editor" />;
  }),
}));

mock.module('../../services/globalProjects', () => ({
  getFocusedProjectForGroup: () => null,
  getGlobalProjectById: () => null,
}));

const { default: ChatZone } = await import('./ChatZone');

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

const resetState = () => {
  appState = {
    mode: 'Chat',
    agentType: 'default',
    setAgentType: mock(() => undefined),
    pendingAutoLaunchPlanId: null,
    pendingAutoLaunchTaskId: null,
    clearPendingAutoLaunch: mock(() => undefined),
    selectedGroupId: null,
    selectedProjectId: null,
    selectedTaskId: null,
    projectGroups: [],
    activeArchitectPlanId: null,
    planNodes: [],
    predictedBranches: [],
  };

  chatState = {
    conversations: [buildConversation()],
    messages: [],
    selectedConversationId: 'conv-1',
    createConversation: mock(async () => buildConversation()),
    ensureConversationForCurrentMode: mock(async () => 'conv-1'),
    getConversationMessages: (conversationId: string) =>
      chatState.messages.filter((message) => message.conversation_id === conversationId),
    hydrationStatus: 'ready',
    restoreStatus: 'ready',
    isLoading: false,
    isStreaming: false,
    sendState: 'idle',
    lastError: null,
    stopStreaming: mock(() => undefined),
    sendMessage: mock(async () => ({ status: 'sent' })),
    clearLastError: mock(() => undefined),
    editMessage: mock(async () => undefined),
    getMessageImages: mock(() => []),
    setMessageImages: mock(() => undefined),
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
    startTask: mock(async () => undefined),
  };
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

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    if (!globalThis.requestAnimationFrame) {
      globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 0) as unknown as number;
    }

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
});
