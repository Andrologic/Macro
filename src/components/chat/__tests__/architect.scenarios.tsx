import { expect, it, jest, mock } from 'bun:test';
import { act, type ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import type {
  AppStoreState,
  MockChatState,
  MockMessage,
} from '../ChatZone.test';

export type ArchitectScenarioContext = {
  appState: AppStoreState;
  chatState: MockChatState;
  composerEditorValue: string;
  readonly composerEditorSetTextCalls: string[];
  readonly composerEditorFocusCalls: number;
  readonly latestComposerProps: Record<string, unknown> | null;
  readonly notifyInfoMock: ReturnType<typeof mock>;
  renderChatZone: () => ReactElement;
  buildMessage: (overrides: Partial<MockMessage>) => MockMessage;
  requireContainer: () => HTMLDivElement;
  requireRoot: () => Root;
  emitAppStore: () => void;
  emitChatStore: () => void;
};

export const registerArchitectScenarios = (context: ArchitectScenarioContext) => {
  const {
    buildMessage,
    renderChatZone,
    requireContainer,
    requireRoot,
  } = context;

  it('locks Architect chat when no plan is selected', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Architect',
      activeArchitectPlanId: null,
      activePlanContext: null,
    };
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Conversation architecte' }),
      ],
      selectedConversationId: 'conv-1',
    };

    jest.useFakeTimers();
    try {
      await act(async () => {
        requireRoot().render(renderChatZone());
      });
      await act(async () => undefined);
      await act(async () => {
        jest.advanceTimersByTime(400);
        await Promise.resolve();
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
      expect(context.chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
    } finally {
      try {
        jest.clearAllTimers();
      } finally {
        jest.useRealTimers();
      }
    }
  });

  it('offers to create a plan in the central panel when none exists', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Architect',
      activeArchitectPlanId: null,
      activePlanContext: null,
    };

    const handleStateRequest = () => {
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
    };
    window.addEventListener('macro:architect-plan-selector-state-request', handleStateRequest);
    try {
      await act(async () => {
        requireRoot().render(renderChatZone());
      });
    } finally {
      window.removeEventListener('macro:architect-plan-selector-state-request', handleStateRequest);
    }

    const button = requireContainer().querySelector(
      '[data-tour-id="architect-empty-plan-action"]'
    ) as HTMLButtonElement | null;
    expect(requireContainer().textContent).toContain('Create your first plan to start architecting.');
    expect(requireContainer().textContent).not.toContain('Select or create a plan to start architecting.');
    expect(button?.textContent).toContain('Create a plan');
    if (button) {
      button.getBoundingClientRect = () => ({
        top: 300,
        right: 740,
        bottom: 336,
        left: 600,
        width: 140,
        height: 36,
        x: 600,
        y: 300,
        toJSON: () => ({}),
      });
    }

    const requestDetails: unknown[] = [];
    const handleRequest = (event: Event) => {
      requestDetails.push((event as CustomEvent).detail);
    };
    window.addEventListener('macro:architect-plan-selector-request', handleRequest);
    try {
      await act(async () => {
        button?.click();
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });
    } finally {
      window.removeEventListener('macro:architect-plan-selector-request', handleRequest);
    }

    expect(requestDetails).toEqual([{
      action: 'primary',
      anchorRect: {
        top: 300,
        right: 740,
        bottom: 336,
        left: 600,
        width: 140,
        height: 36,
      },
    }]);
  });

  it('offers to select a plan in the central panel when plans exist', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Architect',
      activeArchitectPlanId: null,
      activePlanContext: null,
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
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
    expect(requireContainer().textContent).toContain('Select a plan to start architecting.');
    expect(button?.textContent).toContain('Select a plan');
  });

  it('does not create or send an Architect message when no plan is selected', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Architect',
      activeArchitectPlanId: null,
      activePlanContext: null,
    };
    context.chatState = {
      ...context.chatState,
      selectedConversationId: null,
      ensureConversationForCurrentMode: mock(async () => 'conv-1'),
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    context.composerEditorValue = 'Peux-tu préparer le plan ?';
    await act(async () => {
      await (context.latestComposerProps?.onSend as (() => Promise<void>) | undefined)?.();
    });

    expect(context.chatState.ensureConversationForCurrentMode).not.toHaveBeenCalled();
    expect(context.chatState.createConversation).not.toHaveBeenCalled();
    expect(context.chatState.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps Architect chat enabled when an active plan id exists before plan details load', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Architect',
      activeArchitectPlanId: 'plan-1',
      activePlanContext: null,
    };
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Plan à charger' }),
      ],
      selectedConversationId: 'conv-1',
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(
      requireContainer().querySelector('button[aria-label="Diagnostic du contexte"]')
    ).not.toBeNull();
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer?.disabled).toBe(false);
  });

  it('does not treat an Architect plan context alone as a selected plan', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Architect',
      activeArchitectPlanId: null,
      activePlanContext: { id: 'plan-1' },
    };
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({ id: 'msg-user-1', role: 'user', content: 'Plan hydraté' }),
      ],
      selectedConversationId: 'conv-1',
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(
      requireContainer().querySelector('button[aria-label="Diagnostic du contexte"]')
    ).toBeNull();
    expect(requireContainer().textContent).toContain('Select or create a plan to start architecting.');
  });

  it('blocks orphan architect conversations when no project is available', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Architect',
      selectedGroupId: null,
      selectedProjectId: null,
      projectGroups: [],
      activeArchitectPlanId: null,
    };
    context.chatState = {
      ...context.chatState,
      messages: [buildMessage({ content: 'Old orphan architect conversation' })],
      selectedConversationId: 'conv-1',
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('Ajoutez un projet pour commencer avec Macro.');
    expect(requireContainer().textContent).not.toContain('Old orphan architect conversation');
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer?.disabled).toBe(true);
  });

  it('renders architect plan naming recovery actions when a plan still needs a name', async () => {
    context.appState.mode = 'Architect';
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('Plan name still needed');
    expect(requireContainer().textContent).toContain('Retry AI');
    expect(requireContainer().textContent).toContain('Name manually');
  });

  it('hides the Architect progress button before the first user explanation', async () => {
    context.appState.mode = 'Architect';
    context.appState.activeArchitectPlanId = 'plan-1';
    context.chatState.messages = [];

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).not.toContain('Generate Strategy');
  });

  it('offers direct strategy generation after the first explanation', async () => {
    context.appState.mode = 'Architect';
    context.appState.activeArchitectPlanId = 'plan-1';
    context.chatState.messages = [
      buildMessage({
        id: 'msg-user-1',
        role: 'user',
        content: 'I want to rebuild the onboarding flow.',
      }),
    ];
    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const button = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Generate Strategy')
    );

    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
    });

    expect(context.composerEditorSetTextCalls).toHaveLength(0);
    expect(context.composerEditorFocusCalls).toBe(0);
    expect(context.chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('strategy_generate'),
    });
    expect(context.chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('question'),
    });
  });

  it('keeps an existing composer draft when sending an Architect action', async () => {
    context.appState.mode = 'Architect';
    context.appState.activeArchitectPlanId = 'plan-1';
    context.chatState.messages = [
      buildMessage({
        id: 'msg-user-1',
        role: 'user',
        content: 'I want to rebuild the onboarding flow.',
      }),
    ];
    context.composerEditorValue = 'Existing user draft';

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const button = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Generate Strategy')
    );

    await act(async () => {
      button?.click();
    });

    expect(context.composerEditorValue).toBe('Existing user draft');
    expect(context.composerEditorSetTextCalls).toHaveLength(0);
    expect(context.composerEditorFocusCalls).toBe(0);
    expect(context.notifyInfoMock).not.toHaveBeenCalled();
    expect(context.chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('strategy_generate'),
    });
  });

  it('keeps normal user messages in the standard user bubble', async () => {
    context.chatState.messages = [
      buildMessage({
        id: 'msg-user-normal',
        role: 'user',
        content: 'I want to rebuild the onboarding flow.',
      }),
    ];

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const row = requireContainer().querySelector('#chat-message-msg-user-normal');
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-testid="architect-action-message"]')).toBeNull();
    expect(row?.querySelector('[data-user-message-content="true"]')).not.toBeNull();
    expect(row?.textContent).toContain('I want to rebuild the onboarding flow.');
  });

  it('asks for a natural-language recap after Generate Strategy in Architect mode', async () => {
    context.appState.mode = 'Architect';
    context.appState.activeArchitectPlanId = 'plan-1';
    context.appState.planNodes = [];
    context.appState.predictedBranches = [];
    context.chatState.messages = [
      buildMessage({
        id: 'msg-user-strategy',
        role: 'user',
        content: 'Rebuild the onboarding flow.',
      }),
    ];

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const button = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Generate Strategy')
    );

    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
    });

    expect(context.chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('Call `strategy_generate`'),
    });
    expect(context.chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('short summary of the strategy'),
    });
  });

  it('disables strategy regeneration after plan validation', async () => {
    context.appState.mode = 'Architect';
    context.appState.activeArchitectPlanId = 'plan-1';
    context.appState.activePlanContext = {
      id: 'plan-1',
      title: 'Plan verrouillé',
      description: '',
      status: 'validated',
      targetBranch: 'develop',
    };
    context.appState.planNodes = [{ id: 'node-1', title: 'Existing strategy node' }];
    context.chatState.messages = [
      buildMessage({
        id: 'msg-user-regenerate',
        role: 'user',
        content: 'Rebuild the onboarding flow.',
      }),
    ];

    await act(async () => {
      requireRoot().render(renderChatZone());
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

    expect(context.chatState.sendMessage).not.toHaveBeenCalled();
  });

};
