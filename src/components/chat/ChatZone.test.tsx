import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
};

type MockChatState = {
  conversations: MockConversation[];
  messages: MockMessage[];
  selectedConversationId: string | null;
  messagesByConversationId?: Record<string, MockMessage[]>;
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
  getActiveQuestionnaire: ReturnType<typeof mock>;
  startQuestionnaireResponseEdit: ReturnType<typeof mock>;
  cancelQuestionnaireSession: ReturnType<typeof mock>;
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
  };

  hook.getState = getSnapshot;
  hook.emit = () => {
    listeners.forEach((listener) => listener());
  };
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

mock.module('../ai/ReasoningDropdown', () => ({
  ReasoningDropdown: () => <div data-testid="reasoning-dropdown" />,
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

const actualGlobalProjects = await import('../../services/globalProjects');

mock.module('../../services/globalProjects', () => ({
  ...actualGlobalProjects,
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
    questionnaireDraftsByConversationId: {},
    getActiveQuestionnaire: mock(() => null),
    startQuestionnaireResponseEdit: mock(() => false),
    cancelQuestionnaireSession: mock(() => undefined),
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
