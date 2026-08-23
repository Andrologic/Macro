import { expect, it, mock } from 'bun:test';
import { act, type ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import type {
  MockChatState,
  MockMessage,
  buildCompactionEvent,
  buildCompactionFootprint,
  buildManualCompactionCompletedResult,
  buildManualCompactionSkippedResult,
} from '../ChatZone.test';

export type CompactionScenarioContext = {
  chatState: MockChatState;
  composerEditorValue: string;
  readonly scrollMagnetActiveValues: boolean[];
  readonly notifyInfoMock: ReturnType<typeof mock>;
  readonly notifySuccessMock: ReturnType<typeof mock>;
  readonly notifyErrorMock: ReturnType<typeof mock>;
  readonly markdownRendererContentMock: ReturnType<typeof mock>;
  renderChatZone: () => ReactElement;
  buildMessage: (overrides: Partial<MockMessage>) => MockMessage;
  buildCompactionEvent: typeof buildCompactionEvent;
  buildCompactionFootprint: typeof buildCompactionFootprint;
  buildManualCompactionCompletedResult: typeof buildManualCompactionCompletedResult;
  buildManualCompactionSkippedResult: typeof buildManualCompactionSkippedResult;
  requireContainer: () => HTMLDivElement;
  requireRoot: () => Root;
  emitChatStore: () => void;
  setChatStoreState: (
    state: Partial<MockChatState> | ((current: MockChatState) => Partial<MockChatState>),
  ) => void;
  clearMarkdownRendererContentMock: () => void;
};

const COMPACTION_PROGRESS_TEXT = 'Compactage du contexte...';
const COMPACTION_BOUNDARY_TEXT = 'Contexte compacté';

export const registerCompactionScenarios = (context: CompactionScenarioContext) => {
  const {
    buildCompactionEvent,
    buildCompactionFootprint,
    buildManualCompactionCompletedResult,
    buildManualCompactionSkippedResult,
    buildMessage,
    renderChatZone,
    requireContainer,
    requireRoot,
  } = context;

  it('renders a vertical compaction boundary in the transcript', async () => {
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
    });

    expect(
      requireContainer().querySelector('[data-chat-compaction-boundary="true"]')
    ).not.toBeNull();
  });

  it('removes the virtual transcript gap before a compaction separator that follows an assistant message', async () => {
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
    });

    expect(
      requireContainer().querySelector('[data-chat-compaction-boundary="true"]')
    ).toBeNull();
  });

  it('renders compaction progress in the transcript while manual compaction is running', async () => {
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    expect(context.scrollMagnetActiveValues.at(-1)).toBe(true);
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
    context.chatState = {
      ...context.chatState,
      isStreaming: true,
      messages,
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().querySelector('[data-chat-assistant-activity="true"]')).not.toBeNull();
    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    expect(requireContainer().querySelector('[data-chat-compaction-progress="true"]')).toBeNull();

    context.clearMarkdownRendererContentMock();
    await act(async () => {
      context.setChatStoreState((state) => ({
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

    expect(context.chatState.messages).toBe(messages);
    expect(context.chatState.messages[1]).toBe(assistantMessage);
    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();
    expect(requireContainer().querySelector('[data-chat-assistant-activity="true"]')).toBeNull();
    expect(requireContainer().querySelector('[data-chat-compaction-progress="true"]')).toBeNull();
    expect(
      context.markdownRendererContentMock.mock.calls.some(
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().querySelector('[data-chat-assistant-activity="true"]')).not.toBeNull();
    expect(
      requireContainer().querySelector('[data-chat-streaming-compaction-activity="true"]'),
    ).toBeNull();

    runtimeAssistantMessageId = null;
    await act(async () => {
      context.setChatStoreState((state) => ({
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
    });

    expect(
      requireContainer().querySelector('[data-testid="context-window-compacting"]'),
    ).toBeNull();
  });

  it('renders compaction progress clearly in the transcript when no assistant cursor exists', async () => {
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
    });

    expect(
      requireContainer().querySelector('[data-chat-compaction-progress="true"]'),
    ).not.toBeNull();
    expect(context.scrollMagnetActiveValues.at(-1)).toBe(true);
  });

  it('renders safety compaction progress before messages are persisted and keeps the composer text', async () => {
    context.composerEditorValue = 'encore';
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().querySelector('[data-chat-compaction-progress="true"]')).toBeNull();
    const boundary = requireContainer().querySelector('[data-chat-compaction-boundary="true"]');
    expect(boundary).not.toBeNull();
    expect(boundary?.textContent).toContain(COMPACTION_BOUNDARY_TEXT);
    expect(boundary?.querySelector('.chat-streaming-compaction__wave')).toBeNull();
  });

  it('keeps manual compaction out of the header while preserving compacted transcript state', async () => {
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState = {
      ...context.chatState,
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
          context.setChatStoreState((state) => ({
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
      requireRoot().render(renderChatZone());
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
    context.chatState.refreshConversationContextDiagnostics.mockClear();

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
    expect(context.chatState.refreshConversationContextDiagnostics).toHaveBeenCalledWith('conv-1', {
      mode: 'full',
    });
    expect(context.notifySuccessMock).toHaveBeenCalledWith(
      'Contexte compacté',
      expect.objectContaining({
        description: expect.stringContaining('tokens économisés'),
      }),
    );
  });

  it('greys manual compaction without rendering transcript progress when history is too short', async () => {
    context.chatState = {
      ...context.chatState,
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
      requireRoot().render(renderChatZone());
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
    context.chatState.refreshConversationContextDiagnostics.mockClear();

    await act(async () => {
      manualButton?.click();
      await Promise.resolve();
    });

    expect(context.chatState.compactConversationNow).not.toHaveBeenCalled();
    expect(context.notifyInfoMock).not.toHaveBeenCalled();
    expect(context.chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
    expect(
      requireContainer().querySelector('[data-chat-compaction-progress="true"]'),
    ).toBeNull();
  });

  it('recovers the manual compaction button after a compaction failure', async () => {
    const originalWarn = console.warn;
    console.warn = mock(() => undefined) as unknown as typeof console.warn;
    context.chatState = {
      ...context.chatState,
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
        requireRoot().render(renderChatZone());
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
      context.chatState.refreshConversationContextDiagnostics.mockClear();

      await act(async () => {
        manualButton?.click();
        await Promise.resolve();
      });

      expect(context.chatState.compactConversationNow).toHaveBeenCalledWith('conv-1');
      expect(context.notifyErrorMock).toHaveBeenCalledWith(
        'Compactage impossible',
        expect.objectContaining({
          description: 'compaction failed',
        }),
      );
      expect(context.chatState.refreshConversationContextDiagnostics).not.toHaveBeenCalled();
      expect(
        Array.from(requireContainer().querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent?.includes('Compacter maintenant'),
        )?.disabled,
      ).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

};
