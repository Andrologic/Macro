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
      const emptyStateAction = requireContainer().querySelector(
        '[data-tour-id="architect-empty-plan-action"]'
      ) as HTMLButtonElement | null;
      expect(emptyStateAction?.disabled).toBe(true);
      expect(emptyStateAction?.textContent).toContain('Loading');
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
      event.preventDefault();
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

  it('offers project management when the empty scope cannot create plans', async () => {
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
            planCount: 0,
            canCreate: false,
            canSelect: false,
          },
        }),
      );
    });

    const button = requireContainer().querySelector(
      '[data-tour-id="architect-empty-plan-action"]'
    ) as HTMLButtonElement | null;
    expect(requireContainer().textContent).toContain('Make a project editable before creating a plan.');
    expect(requireContainer().textContent).not.toContain('Select a plan to start architecting.');
    expect(button?.textContent).toContain('Manage projects');
  });

  it('keeps the empty-state action disabled while the plan catalog loads', async () => {
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
            status: 'loading',
            planCount: 0,
            canCreate: false,
            canSelect: false,
          },
        }),
      );
    });

    const button = requireContainer().querySelector(
      '[data-tour-id="architect-empty-plan-action"]'
    ) as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain('Loading');
  });

  it('keeps the empty-state action disabled when the plan catalog fails', async () => {
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
            status: 'error',
            planCount: 0,
            canCreate: false,
            canSelect: false,
          },
        }),
      );
    });

    const button = requireContainer().querySelector(
      '[data-tour-id="architect-empty-plan-action"]'
    ) as HTMLButtonElement | null;
    expect(requireContainer().textContent).toContain('Unable to load plans.');
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain('Unavailable');
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

  const namingRecovery = (stage: 'choice' | 'manual') => ({
    conversationId: 'conv-1',
    planId: 'plan-1',
    targetBranch: 'develop',
    firstUserContent: 'On doit renommer le plan.',
    providerId: 'provider-1',
    modelId: 'model-1',
    stage,
    isSubmitting: false,
    error: null,
  });

  it('does not block Architect when automatic plan naming fails', async () => {
    context.appState.mode = 'Architect';
    context.chatState = { ...context.chatState, architectPlanNamingRecovery: namingRecovery('choice') };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(document.body.textContent).not.toContain('Retry AI');
    expect(document.body.textContent).not.toContain('Name This Plan');
  });

  it('keeps the default plan name when manual naming is cancelled', async () => {
    const dismiss = mock(() => undefined);
    context.appState.mode = 'Architect';
    context.chatState = {
      ...context.chatState,
      architectPlanNamingRecovery: namingRecovery('manual'),
      dismissArchitectPlanNamingRecovery: dismiss,
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });
    expect(document.body.textContent).toContain('Name This Plan');

    const cancel = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Cancel');
    await act(async () => { cancel?.dispatchEvent(new window.Event('click', { bubbles: true })); });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('keeps Architect chat free of legacy strategy actions (has history: %s)', async hasHistory => {
    context.appState.mode = 'Architect';
    context.appState.activeArchitectPlanId = 'plan-1';
    context.chatState.messages = hasHistory
      ? [buildMessage({ id: 'msg-user-1', role: 'user', content: 'Build the system together.' })]
      : [];
    context.composerEditorValue = 'Existing user draft';
    await act(async () => { requireRoot().render(renderChatZone()); });
    expect(requireContainer().textContent).not.toContain('Generate Strategy');
    expect(requireContainer().textContent).not.toContain('Regenerate Strategy');
    expect(context.composerEditorValue).toBe('Existing user draft');
    expect(context.chatState.sendMessage).not.toHaveBeenCalled();
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

};
