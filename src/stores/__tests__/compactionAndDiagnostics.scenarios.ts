import { describe, expect, it } from 'bun:test';
import type { AppMode, ChatMessage } from '../../types';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerCompactionAndDiagnosticsScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    COMPACTED_STATE_MARKER,
    DEFAULT_PROVIDER_CONFIGS,
    activateArchitectPlanForTest,
    appState,
    buildManualCompactionLoad,
    createConversation,
    createDbConversationCompactionState,
    createDeferred,
    createIdleChatStoreState,
    dbGetConversationCompactionStateMock,
    dbUpsertConversationCompactionStateMock,
    flushAsyncWork,
    getLatestStreamOptions,
    loadChatStore,
    providerState,
    queueSendChatNonStreamingImplementation,
    savePreferenceForTest,
    sendChatNonStreamingMock,
    setSelectedProviderModelContext,
    streamChatMock,
    useProviderStoreMock,
    waitForConversationDiagnostics,
    waitForStreamCallCount,
  } = context;

  describe('useChatStore compaction and diagnostics', () => {
    it('does not compact on model switch when only image estimates exceed the smaller window', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      providerState.modelsByProvider = {
        'provider-1': [
          {
            id: 'large-model',
            name: 'Large model',
            isEnabled: true,
            contextWindowTokens: 32_000,
            outputLimitTokens: 2_000,
          } as never,
          {
            id: 'small-model',
            name: 'Small model',
            isEnabled: true,
            contextWindowTokens: 8_000,
            outputLimitTokens: 1_000,
          } as never,
        ],
      };
      providerState.selectedProviderId = 'provider-1';
      providerState.selectedModelId = 'large-model';

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Remember this.',
          timestamp: '2026-08-26T09:58:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'Remembered.',
          timestamp: '2026-08-26T09:59:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Inspect these images.',
          timestamp: '2026-08-26T10:00:00.000Z',
        },
      ];
      useChatStore.setState(createIdleChatStoreState({
        conversations: [{ ...createConversation('chat-conv', ''), message_count: 3 }],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        messageImagesByMessageId: {
          u2: Array.from({ length: 4 }, (_, index) => ({
            id: `image-${index + 1}`,
            mimeType: 'image/png',
            dataUrl: `data:image/png;base64,${'a'.repeat(index + 4)}`,
            width: 10_000,
            height: 10_000,
            createdAt: '2026-08-26T10:00:00.000Z',
          })),
        },
      }));
      dbUpsertConversationCompactionStateMock.mockClear();
      sendChatNonStreamingMock.mockClear();

      useProviderStoreMock.setState({ selectedModelId: 'small-model' });
      await flushAsyncWork();
      await flushAsyncWork();

      expect(dbUpsertConversationCompactionStateMock).not.toHaveBeenCalled();
      expect(sendChatNonStreamingMock).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toBeUndefined();
    });

    it('propagates image dimensions without blocking when image estimates alone exceed the context', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      setSelectedProviderModelContext();

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Inspecte cette image.',
        images: Array.from({ length: 4 }, (_, index) =>
          ({
            id: `image-${index + 1}`,
            mimeType: 'image/png',
            dataUrl: `data:image/png;base64,${index === 0 ? 'a'.repeat(900_000) : 'a'}`,
            width: 10_000,
            height: 10_000,
            createdAt: '2026-08-26T10:00:00.000Z',
          })
        ),
      });
      await waitForStreamCallCount(1);

      const streamOptions = getLatestStreamOptions<{
        messages: Array<{
          role: string;
          image_metadata?: Array<Record<string, unknown>>;
        }>;
      }>();
      const imageMessage = streamOptions.messages.find(
        (message) => message.role === 'user' && message.image_metadata?.length,
      );

      expect(imageMessage?.image_metadata).toHaveLength(4);
      expect(imageMessage?.image_metadata).toEqual(
        Array.from({ length: 4 }, () => ({
          width: 10_000,
          height: 10_000,
          mimeType: 'image/png',
          sourceFingerprint: expect.any(String),
        })),
      );
      expect(useChatStore.getState().lastError).toBeNull();
    });

    it('persists manual compaction pass and summary schema metadata', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      setSelectedProviderModelContext();
      queueSendChatNonStreamingImplementation(async () =>
        JSON.stringify({
          currentObjective: 'Continue the database migration safely.',
          userInstructions: ['Keep the migration reversible.'],
          decisions: ['Use a forced manual compaction for older turns.'],
          openQuestions: [],
          activeFiles: ['src-tauri/src/db/mod.rs'],
          toolFacts: ['The old schema lacks compaction_pass.'],
          remainingWork: ['Run targeted tests.'],
          summary: 'Manual compaction preserved the migration objective.',
        })
      );

      const { useChatStore } = await loadChatStore();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Keep this migration reversible.',
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: buildManualCompactionLoad('I will keep it reversible.'),
          timestamp: '2026-04-14T10:01:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Inspect the compaction table.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
        {
          id: 'a2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'The table does not persist compaction_pass.',
          timestamp: '2026-04-14T10:03:00.000Z',
        },
        {
          id: 'u3',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Now compact manually.',
          timestamp: '2026-04-14T10:04:00.000Z',
        },
      ];
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().compactConversationNow('chat-conv');

      const upsertInput = ((dbUpsertConversationCompactionStateMock as unknown as {
        mock: { calls: Array<Array<Record<string, unknown>>> };
      }).mock.calls.at(-1)?.[0] ?? null);
      expect(upsertInput).toMatchObject({
        conversation_id: 'chat-conv',
        compaction_kind: 'manual',
        compaction_pass: 'forced',
        summary_format_version: 3,
        summary_source: 'model',
      });
      expect(upsertInput?.summary_text).toContain('Continue the database migration safely.');
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        summaryFormatVersion: 3,
        summarySource: 'model',
      });
      expect(
        useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
      ).toEqual([
        expect.objectContaining({
          status: 'completed',
          displayAfterMessageId: 'u3',
          logicalUpToMessageId: 'a1',
          kind: 'manual',
        }),
      ]);
    });

    it('skips manual compaction for low-context chat without creating a checkpoint', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;

      const { useChatStore } = await loadChatStore();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Tiny old request.',
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'Tiny old answer.',
          timestamp: '2026-04-14T10:01:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Tiny recent request.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
        {
          id: 'a2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'Tiny recent answer.',
          timestamp: '2026-04-14T10:03:00.000Z',
        },
        {
          id: 'u3',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Tiny latest request.',
          timestamp: '2026-04-14T10:04:00.000Z',
        },
      ];
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const result = await useChatStore.getState().compactConversationNow('chat-conv');

      expect(result).toMatchObject({
        outcome: 'skipped',
        reason: 'below_threshold',
        userTurnCount: 3,
        retainedTurnCount: 2,
      });
      expect(sendChatNonStreamingMock).not.toHaveBeenCalled();
      expect(dbUpsertConversationCompactionStateMock).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toBeUndefined();
    });

    it('preserves an existing checkpoint status when manual compaction is skipped', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;

      const { useChatStore } = await loadChatStore();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Tiny old request.',
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'Tiny old answer.',
          timestamp: '2026-04-14T10:01:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Tiny recent request.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
        {
          id: 'a2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'Tiny recent answer.',
          timestamp: '2026-04-14T10:03:00.000Z',
        },
        {
          id: 'u3',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Tiny latest request.',
          timestamp: '2026-04-14T10:04:00.000Z',
        },
      ];
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
        conversationCompactionStatusById: {
          'chat-conv': {
            phase: 'compacted',
            upToMessageId: 'a1',
            summaryText: 'Previous compacted summary.',
            updatedAt: '2026-04-14T09:00:00.000Z',
            kind: 'manual',
          },
        },
      });

      const result = await useChatStore.getState().compactConversationNow('chat-conv');

      expect(result).toMatchObject({
        outcome: 'skipped',
        reason: 'below_threshold',
      });
      expect(sendChatNonStreamingMock).not.toHaveBeenCalled();
      expect(dbUpsertConversationCompactionStateMock).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        upToMessageId: 'a1',
        summaryText: 'Previous compacted summary.',
      });
    });

    it('compacts Copilot chat through a system checkpoint instead of provider input replay', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      providerState.providerConfigs = [
        {
          ...DEFAULT_PROVIDER_CONFIGS[0],
          id: 'copilot-provider',
          name: 'Copilot',
          providerType: 'copilot',
          isLocal: true,
        },
      ];
      providerState.modelsByProvider = {
        'copilot-provider': [
          {
            id: 'copilot-model',
            name: 'Copilot Model',
            isEnabled: true,
            contextWindowTokens: 8_000,
            outputLimitTokens: 1_200,
          } as never,
        ],
      };
      providerState.selectedProviderId = 'copilot-provider';
      providerState.selectedModelId = 'copilot-model';
      providerState.selectedReasoningEffort = null;
      providerState.selectedSupportsNativeToolCalling = () => false;
      queueSendChatNonStreamingImplementation(async () =>
        JSON.stringify({
          currentObjective: 'Continue after compacting Copilot chat history.',
          userInstructions: ['Keep the answer focused.'],
          decisions: ['Older Copilot turns were moved into a compacted system checkpoint.'],
          openQuestions: [],
          activeFiles: [],
          toolFacts: [],
          remainingWork: ['Answer the newest user request.'],
          summary: 'Copilot must receive compacted history through system text, not provider input items.',
        })
      );

      const { useChatStore } = await loadChatStore();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Remember the old Copilot context.',
          timestamp: '2026-03-18T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: `Old Copilot visible payload.\n${'older visible detail\n'.repeat(1_100)}`,
          timestamp: '2026-03-18T10:01:00.000Z',
          provider_input_items: [
            {
              type: 'chat_completion_message',
              role: 'assistant',
              content: 'Old Copilot visible payload.',
              reasoning_content: 'native reasoning payload\n'.repeat(600),
            },
          ],
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Retain the recent turn.',
          timestamp: '2026-03-18T10:02:00.000Z',
        },
        {
          id: 'a2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'Recent Copilot answer.',
          timestamp: '2026-03-18T10:03:00.000Z',
        },
        {
          id: 'u3',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Compact this manually.',
          timestamp: '2026-03-18T10:04:00.000Z',
        },
      ];
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().compactConversationNow('chat-conv');

      expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
      expect(sendChatNonStreamingMock.mock.calls[0]?.[0]).toMatchObject({
        providerType: 'copilot',
        copilotSendTimeoutMs: 60_000,
      });
      expect(dbUpsertConversationCompactionStateMock).toHaveBeenCalledTimes(1);
      const persistedCopilotCheckpoint = ((dbUpsertConversationCompactionStateMock as unknown as {
        mock: { calls: Array<Array<Record<string, unknown>>> };
      }).mock.calls.at(-1)?.[0] ?? null);
      expect(persistedCopilotCheckpoint).not.toBeNull();
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        kind: 'manual',
        summarySource: 'model',
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Continue with the compacted Copilot context.',
      });
      await waitForStreamCallCount(1);

      const streamOptions = getLatestStreamOptions<{
        providerType: string;
        messages: Array<Record<string, unknown>>;
      }>();
      const serializedRequest = JSON.stringify(streamOptions.messages);
      expect(streamOptions.providerType).toBe('copilot');
      expect(serializedRequest).toContain(COMPACTED_STATE_MARKER);
      expect(serializedRequest).toContain('Continue after compacting Copilot chat history.');
      expect(serializedRequest).toContain('Retain the recent turn.');
      expect(serializedRequest).not.toContain('older visible detail');
      expect(serializedRequest).not.toContain('native reasoning payload');
      expect(serializedRequest).not.toContain('provider_input_items');
    });

    it('marks manual compaction as running while preserving the previous boundary', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      setSelectedProviderModelContext();
      const summaryDeferred = createDeferred<string>();
      queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);

      const { useChatStore } = await loadChatStore();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Keep this migration reversible.',
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: buildManualCompactionLoad('I will keep it reversible.'),
          timestamp: '2026-04-14T10:01:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Inspect the compaction table.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
        {
          id: 'a2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'The table does not persist compaction_pass.',
          timestamp: '2026-04-14T10:03:00.000Z',
        },
        {
          id: 'u3',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Now compact manually.',
          timestamp: '2026-04-14T10:04:00.000Z',
        },
      ];
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
        conversationCompactionStatusById: {
          'chat-conv': {
            phase: 'compacted',
            upToMessageId: 'a1',
            summaryText: 'Previous compacted summary.',
            updatedAt: '2026-04-14T09:00:00.000Z',
            kind: 'manual',
          },
        },
        sessionCompactionEventsByConversationId: {
          'chat-conv': [
            {
              id: 'older-session-compaction',
              status: 'completed' as const,
              displayAfterMessageId: 'u2',
              logicalUpToMessageId: 'a1',
              kind: 'manual' as const,
              startedAt: '2026-04-14T09:00:00.000Z',
              completedAt: '2026-04-14T09:01:00.000Z',
            },
            {
              id: 'same-anchor-session-compaction',
              status: 'completed' as const,
              displayAfterMessageId: 'u3',
              logicalUpToMessageId: 'a1',
              kind: 'manual' as const,
              startedAt: '2026-04-14T09:10:00.000Z',
              completedAt: '2026-04-14T09:11:00.000Z',
            },
          ],
        },
      });

      const compactionPromise = useChatStore.getState().compactConversationNow('chat-conv');

      expect(sendChatNonStreamingMock).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        upToMessageId: 'a1',
        summaryText: 'Previous compacted summary.',
        kind: 'manual',
      });
      expect(
        useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
      ).toEqual([
        expect.objectContaining({
          id: 'older-session-compaction',
          status: 'completed',
          displayAfterMessageId: 'u2',
        }),
        expect.objectContaining({
          id: 'same-anchor-session-compaction',
          status: 'completed',
          displayAfterMessageId: 'u3',
        }),
      ]);

      await flushAsyncWork();

      expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacting',
        upToMessageId: 'a1',
        summaryText: 'Previous compacted summary.',
        kind: 'manual',
      });
      expect(
        useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
      ).toEqual([
        expect.objectContaining({
          id: 'older-session-compaction',
          status: 'completed',
          displayAfterMessageId: 'u2',
        }),
        expect.objectContaining({
          status: 'running',
          displayAfterMessageId: 'u3',
          kind: 'manual',
        }),
      ]);

      summaryDeferred.resolve(
        JSON.stringify({
          currentObjective: 'Continue the database migration safely.',
          userInstructions: ['Keep the migration reversible.'],
          decisions: ['Use a forced manual compaction for older turns.'],
          openQuestions: [],
          activeFiles: ['src-tauri/src/db/mod.rs'],
          toolFacts: ['The old schema lacks compaction_pass.'],
          remainingWork: ['Run targeted tests.'],
          summary: 'Manual compaction preserved the migration objective.',
        })
      );
      await compactionPromise;

      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        summaryText: expect.stringContaining('Continue the database migration safely.'),
      });
      expect(
        useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
      ).toEqual([
        expect.objectContaining({
          id: 'older-session-compaction',
          status: 'completed',
          displayAfterMessageId: 'u2',
        }),
        expect.objectContaining({
          status: 'completed',
          displayAfterMessageId: 'u3',
          logicalUpToMessageId: 'a1',
          kind: 'manual',
        }),
      ]);
    });

    it('keeps manual compaction running when a persisted checkpoint is loaded during the compaction', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      setSelectedProviderModelContext();
      const summaryDeferred = createDeferred<string>();
      queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);
      (dbGetConversationCompactionStateMock as unknown as {
        mockImplementationOnce: (
          implementation: () => Promise<unknown>,
        ) => void;
      }).mockImplementationOnce(async () => createDbConversationCompactionState());

      const { useChatStore } = await loadChatStore();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Keep this migration reversible.',
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: buildManualCompactionLoad('I will keep it reversible.'),
          timestamp: '2026-04-14T10:01:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Inspect the compaction table.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
        {
          id: 'a2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'The table does not persist compaction_pass.',
          timestamp: '2026-04-14T10:03:00.000Z',
        },
        {
          id: 'u3',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Now compact manually.',
          timestamp: '2026-04-14T10:04:00.000Z',
        },
      ];
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const compactionPromise = useChatStore.getState().compactConversationNow('chat-conv');

      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toBeUndefined();

      await flushAsyncWork();

      expect(dbGetConversationCompactionStateMock).toHaveBeenCalledTimes(1);
      expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacting',
        kind: 'manual',
        summaryText: 'Previous persisted compacted summary.',
      });

      summaryDeferred.resolve(
        JSON.stringify({
          currentObjective: 'Continue safely after a concurrent checkpoint load.',
          userInstructions: [],
          decisions: [],
          openQuestions: [],
          activeFiles: [],
          toolFacts: [],
          remainingWork: [],
          summary: 'Concurrent checkpoint load did not stop activity.',
        })
      );
      await compactionPromise;

      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        summaryText: expect.stringContaining('Continue safely after a concurrent checkpoint load.'),
      });
    });

    it('keeps manual compaction running when the persisted checkpoint is already cached', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      setSelectedProviderModelContext();
      const summaryDeferred = createDeferred<string>();
      queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);
      (dbGetConversationCompactionStateMock as unknown as {
        mockImplementationOnce: (
          implementation: () => Promise<unknown>,
        ) => void;
      }).mockImplementationOnce(async () => createDbConversationCompactionState());

      const { useChatStore } = await loadChatStore();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Keep this migration reversible.',
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: buildManualCompactionLoad('I will keep it reversible.'),
          timestamp: '2026-04-14T10:01:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Inspect the compaction table.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
        {
          id: 'a2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'The table does not persist compaction_pass.',
          timestamp: '2026-04-14T10:03:00.000Z',
        },
        {
          id: 'u3',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Now compact manually.',
          timestamp: '2026-04-14T10:04:00.000Z',
        },
      ];
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
        hydrationStatus: 'ready',
        restoreStatus: 'idle',
        messageImagesByMessageId: {},
        composerContextRefs: [],
      }));

      await useChatStore.getState().selectConversation('chat-conv');
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        summaryText: 'Previous persisted compacted summary.',
      });

      const compactionPromise = useChatStore.getState().compactConversationNow('chat-conv');

      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        summaryText: 'Previous persisted compacted summary.',
      });

      await flushAsyncWork();

      expect(dbGetConversationCompactionStateMock).toHaveBeenCalledTimes(1);
      expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacting',
        kind: 'manual',
        summaryText: 'Previous persisted compacted summary.',
      });

      summaryDeferred.resolve(
        JSON.stringify({
          currentObjective: 'Continue safely with cached compaction state.',
          userInstructions: [],
          decisions: [],
          openQuestions: [],
          activeFiles: [],
          toolFacts: [],
          remainingWork: [],
          summary: 'Cached checkpoint did not stop activity.',
        })
      );
      await compactionPromise;

      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        summaryText: expect.stringContaining('Continue safely with cached compaction state.'),
      });
    });

    it('hydrates persisted compaction metadata when a conversation is reselected', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      (dbGetConversationCompactionStateMock as unknown as {
        mockImplementationOnce: (
          implementation: () => Promise<unknown>,
        ) => void;
      }).mockImplementationOnce(async () => ({
        conversation_id: 'chat-conv',
        up_to_message_id: 'a1',
        summary_text: 'Current objective: continue safely.',
        tool_digest_json: '[]',
        used_source_passage_ids_json: '[]',
        interesting_source_passage_ids_json: '[]',
        estimated_tokens_before: 4200,
        estimated_tokens_after: 900,
        fingerprint: 'fp',
        version: 1,
        pruned_tool_context_message_ids_json: '["a1"]',
        reserved_tokens: 1200,
        footprint_before_json: null,
        footprint_after_json: JSON.stringify({
          totalEstimatedTokens: 900,
          messageTokens: 700,
          hiddenContextTokens: 0,
          systemTokens: 120,
          toolSchemaTokens: 80,
          imagePlaceholderTokens: 0,
          citationTokens: 0,
          modelContextWindowTokens: 8000,
          reservedTokens: 1200,
          usableContextTokens: 6800,
          threshold: 'none',
          reason: 'below_threshold',
          totalContextRatio: 0.11,
          usableContextRatio: 0.13,
          hiddenContextRatio: 0,
          hardStopRatio: 0.98,
          isHardStop: false,
          toolTurnCount: 0,
        }),
        degraded_reason: null,
        compaction_kind: 'manual',
        compaction_pass: 'ultra',
        summary_format_version: 3,
        summary_source: 'fallback',
        created_at: '2026-04-14T10:00:00.000Z',
        updated_at: '2026-04-14T10:05:00.000Z',
      }));

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
        hydrationStatus: 'ready',
        restoreStatus: 'idle',
      }));

      await useChatStore.getState().selectConversation('chat-conv');

      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        summaryText: 'Current objective: continue safely.',
        summaryFormatVersion: 3,
        summarySource: 'fallback',
      });
      expect(
        useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
      ).toBeUndefined();
    });

    it('normalizes invalid persisted compaction metadata instead of trusting DB strings', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      (dbGetConversationCompactionStateMock as unknown as {
        mockImplementationOnce: (
          implementation: () => Promise<unknown>,
        ) => void;
      }).mockImplementationOnce(async () => ({
        conversation_id: 'chat-conv',
        up_to_message_id: 'a1',
        summary_text: 'Legacy compacted summary.',
        tool_digest_json: '[]',
        used_source_passage_ids_json: '[]',
        interesting_source_passage_ids_json: '[]',
        estimated_tokens_before: 4200,
        estimated_tokens_after: 900,
        fingerprint: 'fp',
        version: 1,
        pruned_tool_context_message_ids_json: '[]',
        reserved_tokens: null,
        footprint_before_json: null,
        footprint_after_json: null,
        degraded_reason: 'not_a_reason',
        compaction_kind: 'not_a_kind',
        compaction_pass: 'dangerously_wrong',
        summary_format_version: -10,
        summary_source: 'robot_guess',
        created_at: '2026-04-14T10:00:00.000Z',
        updated_at: '2026-04-14T10:05:00.000Z',
      }));

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
        hydrationStatus: 'ready',
        restoreStatus: 'idle',
      }));

      await useChatStore.getState().selectConversation('chat-conv');

      const status =
        useChatStore.getState().conversationCompactionStatusById['chat-conv'];
      expect(status).toMatchObject({
        phase: 'compacted',
        summaryText: 'Legacy compacted summary.',
        reason: null,
        summaryFormatVersion: 1,
      });
      expect(status?.kind).toBeUndefined();
      expect(status?.summarySource).toBeUndefined();
    });

    it('rejects concurrent manual compaction for the same conversation', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      const summaryDeferred = createDeferred<string>();
      queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);

      const { useChatStore } = await loadChatStore();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Keep this migration reversible.',
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'I will keep it reversible.',
          timestamp: '2026-04-14T10:01:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Now compact manually.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
      ];
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const firstPromise = useChatStore.getState().compactConversationNow('chat-conv');
      const secondPromise = useChatStore.getState().compactConversationNow('chat-conv');

      await expect(secondPromise).rejects.toThrow('already in progress');

      summaryDeferred.resolve(
        JSON.stringify({
          currentObjective: 'Continue safely.',
          userInstructions: [],
          decisions: [],
          openQuestions: [],
          activeFiles: [],
          toolFacts: [],
          remainingWork: [],
          summary: 'Safe continuation.',
        })
      );
      await firstPromise;
    });

    it('runs safety prestream compaction before streaming when the projected payload is full', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      providerState.modelsByProvider = {
        'provider-1': [
          {
            id: 'model-1',
            name: 'Small context model',
            isEnabled: true,
            contextWindowTokens: 8000,
            outputLimitTokens: 1200,
          } as never,
        ],
      };
      const summaryDeferred = createDeferred<string>();
      queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);
      const oldContext = 'ancien contexte utile\n'.repeat(5000);
      (dbGetConversationCompactionStateMock as unknown as {
        mockImplementationOnce: (
          implementation: () => Promise<unknown>,
        ) => void;
      }).mockImplementationOnce(async () => ({
        conversation_id: 'chat-conv',
        up_to_message_id: 'a1',
        summary_text: 'Previous compacted state that must not hide active safety compaction.',
        tool_digest_json: '[]',
        used_source_passage_ids_json: '[]',
        interesting_source_passage_ids_json: '[]',
        estimated_tokens_before: 12000,
        estimated_tokens_after: 1200,
        fingerprint: 'previous-fingerprint',
        version: 1,
        pruned_tool_context_message_ids_json: '[]',
        reserved_tokens: 1200,
        footprint_before_json: null,
        footprint_after_json: JSON.stringify({
          totalEstimatedTokens: 1200,
          messageTokens: 1000,
          hiddenContextTokens: 0,
          systemTokens: 120,
          toolSchemaTokens: 80,
          imagePlaceholderTokens: 0,
          citationTokens: 0,
          modelContextWindowTokens: 8000,
          reservedTokens: 1200,
          usableContextTokens: 6800,
          threshold: 'none',
          reason: 'below_threshold',
          totalContextRatio: 0.15,
          usableContextRatio: 0.18,
          hiddenContextRatio: 0,
          hardStopRatio: 0.98,
          isHardStop: false,
          toolTurnCount: 0,
        }),
        degraded_reason: null,
        compaction_kind: 'manual',
        compaction_pass: 'forced',
        summary_format_version: 3,
        summary_source: 'model',
        created_at: '2026-04-14T09:00:00.000Z',
        updated_at: '2026-04-14T09:05:00.000Z',
      }));

      const { useChatStore } = await loadChatStore();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: `Analyse ce gros historique.\n${oldContext}`,
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: `Historique analysé.\n${oldContext}`,
          timestamp: '2026-04-14T10:01:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Garde les conclusions importantes.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
        {
          id: 'a2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'Je garde les conclusions.',
          timestamp: '2026-04-14T10:03:00.000Z',
        },
      ];
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      const sendPromise = useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Continue avec une réponse courte.',
      });
      await flushAsyncWork();

      expect(streamChatMock).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'safety_compacting',
        kind: 'safety_prestream',
        upToMessageId: 'a1',
        summaryText: 'Previous compacted state that must not hide active safety compaction.',
      });
      const latestUserMessage = useChatStore
        .getState()
        .messages.find(
          (message: ChatMessage) =>
            message.content === 'Continue avec une réponse courte.',
        );
      expect(latestUserMessage).toBeDefined();
      expect(
        useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
      ).toEqual([
        expect.objectContaining({
          status: 'running',
          displayAfterMessageId: latestUserMessage!.id,
          kind: 'safety_prestream',
        }),
      ]);

      summaryDeferred.resolve(
        JSON.stringify({
          currentObjective: 'Continue from the compacted older context.',
          userInstructions: ['Keep the answer short.'],
          decisions: ['Older context was compacted before streaming.'],
          openQuestions: [],
          activeFiles: [],
          toolFacts: [],
          remainingWork: ['Answer the latest user request.'],
          summary: 'The old history contained useful context but no pending blocker.',
        }),
      );
      await sendPromise;
      await waitForStreamCallCount(1);

      const streamOptions = getLatestStreamOptions<{
        messages: Array<{ role: string; content: string }>;
      }>();
      const serializedRequest = JSON.stringify(streamOptions.messages);
      expect(serializedRequest).toContain(COMPACTED_STATE_MARKER);
      expect(serializedRequest).toContain('Continue from the compacted older context.');
      expect(useChatStore.getState().lastError).toBeNull();
      expect(
        useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv'],
      ).toEqual([
        expect.objectContaining({
          status: 'completed',
          displayAfterMessageId: latestUserMessage!.id,
          logicalUpToMessageId: 'a1',
          kind: 'safety_prestream',
        }),
      ]);
    });

    it('ignores legacy compaction preferences and still runs safety prestream compaction', async () => {
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      localStorage.setItem('macro_compaction.auto', JSON.stringify(false));
      localStorage.setItem('macro_compaction.prune', JSON.stringify(false));
      localStorage.setItem('macro_compaction.reservedTokens', JSON.stringify(0));
      providerState.modelsByProvider = {
        'provider-1': [
          {
            id: 'model-1',
            name: 'Small context model',
            isEnabled: true,
            contextWindowTokens: 8000,
            outputLimitTokens: 1200,
          } as never,
        ],
      };
      const summaryDeferred = createDeferred<string>();
      queueSendChatNonStreamingImplementation(async () => summaryDeferred.promise);

      const { useChatStore } = await loadChatStore();
      const oldContext = 'ancien contexte utile\n'.repeat(5000);
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: `Analyse ce gros historique.\n${oldContext}`,
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: `Historique analysé.\n${oldContext}`,
          timestamp: '2026-04-14T10:01:00.000Z',
        },
      ];
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      const sendPromise = useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Continue avec une réponse courte.',
      });
      await flushAsyncWork();

      expect(streamChatMock).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'safety_compacting',
        kind: 'safety_prestream',
      });

      summaryDeferred.resolve(
        JSON.stringify({
          currentObjective: 'Continue from the compacted older context.',
          userInstructions: ['Keep the answer short.'],
          decisions: ['Legacy compaction preferences are ignored.'],
          openQuestions: [],
          activeFiles: [],
          toolFacts: [],
          remainingWork: ['Answer the latest user request.'],
          summary: 'The old history contained useful context.',
        }),
      );
      await sendPromise;
      await waitForStreamCallCount(1);

      expect(useChatStore.getState().lastError).toBeNull();
    });

    it('blocks clearly when the latest user request is too large to compact away', async () => {
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      providerState.modelsByProvider = {
        'provider-1': [
          {
            id: 'model-1',
            name: 'Tiny context model',
            isEnabled: true,
            contextWindowTokens: 2000,
          } as never,
        ],
      };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      await expect(
        useChatStore.getState().sendMessage({
          conversationId: 'chat-conv',
          content: `Réponds à ce payload impossible.\n${'dernier message énorme\n'.repeat(6000)}`,
        }),
      ).rejects.toThrow('The conversation is still too large');
      await flushAsyncWork();

      expect(streamChatMock).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'too_large',
        kind: 'safety_prestream',
      });
      expect(useChatStore.getState().lastError).toContain(
        'The conversation is still too large',
      );
      expect(
        useChatStore
          .getState()
          .getConversationMessages('chat-conv')
          .filter((message: { role: string }) => message.role === 'user'),
      ).toHaveLength(1);
    });

    it('recovers a provider context overflow by compacting and retrying once', async () => {
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      queueSendChatNonStreamingImplementation(async () =>
        JSON.stringify({
          currentObjective: 'Retry after provider context overflow.',
          userInstructions: [],
          decisions: ['Use stream overflow compaction before retrying.'],
          openQuestions: [],
          activeFiles: [],
          toolFacts: [],
          remainingWork: ['Retry the provider request once.'],
          summary: 'Older turns can be represented by this summary.',
        })
      );
      streamChatMock
        .mockImplementationOnce((async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as {
            onError?: (error: Error) => void;
          };
          options.onError?.(
            new Error('input is too long for requested model'),
          );
          return { usage: null };
        }) as unknown as typeof streamChatMock)
        .mockImplementationOnce((async () => ({ usage: null })) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      const messages = [
        {
          id: 'u1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Ancienne demande.',
          timestamp: '2026-04-14T10:00:00.000Z',
        },
        {
          id: 'a1',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'Ancienne réponse.',
          timestamp: '2026-04-14T10:01:00.000Z',
        },
        {
          id: 'u2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'user' as const,
          content: 'Conserve ce contexte.',
          timestamp: '2026-04-14T10:02:00.000Z',
        },
        {
          id: 'a2',
          task_id: '',
          conversation_id: 'chat-conv',
          role: 'assistant' as const,
          content: 'Contexte conservé.',
          timestamp: '2026-04-14T10:03:00.000Z',
        },
      ];
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          {
            ...createConversation('chat-conv', ''),
            message_count: messages.length,
          },
        ],
        messages,
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Continue après overflow.',
      });
      await waitForStreamCallCount(2);

      expect(streamChatMock).toHaveBeenCalledTimes(2);
      const retryOptions = getLatestStreamOptions<{
        messages: Array<{ role: string; content: string }>;
      }>();
      expect(JSON.stringify(retryOptions.messages)).toContain(
        COMPACTED_STATE_MARKER,
      );
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toMatchObject({
        phase: 'compacted',
        kind: 'stream_overflow',
        recoveredFromOverflow: true,
      });
    });

    it('does not retry provider context overflow after useful assistant progress', async () => {
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as {
          onToolTracesUpdate?: (toolTraces: unknown[]) => void;
          onError?: (error: Error) => void;
        };
        options.onToolTracesUpdate?.([
          {
            tool_call_id: 'call-1',
            tool_name: 'read_file',
            detail: 'src/app.ts',
            status: 'done',
          },
        ]);
        options.onError?.(
          Object.assign(new Error('maximum context length is 100 tokens'), {
            name: 'ProviderRuntimeError',
            providerError: true,
            kind: 'context_overflow',
            status: 400,
            retryable: false,
            providerMessage: 'maximum context length is 100 tokens',
          }),
        );
        return { usage: null };
      }) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Lance une requête provider.',
      });
      await flushAsyncWork();

      expect(streamChatMock).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().conversationCompactionStatusById['chat-conv'],
      ).toBeUndefined();
      const runtime = useChatStore.getState().getConversationRuntime('chat-conv');
      expect(runtime.lastErrorOrigin).toBe('provider');
      expect(runtime.lastErrorDisplayTarget).toBe('transcript');
    });

    it('passes Architect mode and the post-tool recap instruction into streaming requests', async () => {
      appState.mode = 'Architect';
      appState.selectedTaskId = null;
      await savePreferenceForTest('chatMaxTurns', 7);

      const { streamChat } = await import('../../services/streamingChat');
      (
        streamChat as unknown as {
          mockImplementationOnce: (implementation: (options: {
            mode?: AppMode;
            messages: Array<{ role: string; content: string }>;
            onComplete?: (result: {
              visibleContent: string;
              toolTraces: unknown[];
              hiddenContext?: unknown;
              completionReason?: 'completed' | 'tool_turn_limit' | 'post_tool_empty_fallback';
            }) => void;
          }) => Promise<void>) => void;
        }
      ).mockImplementationOnce(async ({ onComplete }) => {
        onComplete?.({
          visibleContent: 'Plan prêt.',
          toolTraces: [],
          hiddenContext: undefined,
          completionReason: 'tool_turn_limit',
        });
      });

      const { useChatStore } = await loadChatStore();
      activateArchitectPlanForTest({ conversationId: 'conv-1' });
      useChatStore.setState({
        conversations: [createConversation('conv-1')],
        messages: [],
        selectedConversationId: 'conv-1',
        selectedConversationIdsByMode: { Architect: 'conv-1' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'conv-1',
        content: 'Utilise les outils puis fais-moi un bilan.',
      });

      const firstCall = (
        streamChat as unknown as {
          mock: {
            calls: Array<Array<{
              maxTurns?: number | null;
              mode?: AppMode;
              messages: Array<{ role: string; content: string }>;
            }>>;
          };
        }
      ).mock.calls[0]?.[0];

      expect(firstCall?.mode).toBe('Architect');
      expect(firstCall?.maxTurns).toBe(7);
      expect(firstCall?.messages[0]?.role).toBe('system');
      expect(firstCall?.messages[0]?.content).toContain(
        'always answer in natural language with a concise recap'
      );
      expect(
        useChatStore
          .getState()
          .getConversationMessages('conv-1')
          .find((message: { role: string }) => message.role === 'assistant')
      ).toMatchObject({
        content: 'Plan prêt.',
        completion_reason: 'tool_turn_limit',
      });
    });

    it('keeps the tool-turn-limit notice out of the next model request', async () => {
      appState.mode = 'Architect';
      appState.selectedTaskId = null;

      const { streamChat } = await import('../../services/streamingChat');
      const streamChatMockForTest = streamChat as unknown as {
        mockImplementationOnce: (implementation: (options: {
          messages: Array<{ role: string; content: string }>;
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            hiddenContext?: unknown;
            completionReason?: 'completed' | 'tool_turn_limit' | 'post_tool_empty_fallback';
          }) => void;
        }) => Promise<void>) => void;
        mock: {
          calls: Array<Array<{
            messages: Array<{ role: string; content: string }>;
          }>>;
        };
      };
      streamChatMockForTest.mockImplementationOnce(async ({ onComplete }) => {
        onComplete?.({
          visibleContent: 'Plan prêt.',
          toolTraces: [],
          hiddenContext: undefined,
          completionReason: 'tool_turn_limit',
        });
      });
      streamChatMockForTest.mockImplementationOnce(async ({ onComplete }) => {
        onComplete?.({
          visibleContent: 'Suite prête.',
          toolTraces: [],
          hiddenContext: undefined,
          completionReason: 'completed',
        });
      });

      const { useChatStore } = await loadChatStore();
      activateArchitectPlanForTest({ conversationId: 'conv-1' });
      useChatStore.setState({
        conversations: [createConversation('conv-1')],
        messages: [],
        selectedConversationId: 'conv-1',
        selectedConversationIdsByMode: { Architect: 'conv-1' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'conv-1',
        content: 'Inspecte avec des outils.',
      });
      await Promise.resolve();

      await useChatStore.getState().sendMessage({
        conversationId: 'conv-1',
        content: 'Continue.',
      });
      await Promise.resolve();

      const calls = streamChatMockForTest.mock.calls;
      const secondRequest = calls[1]?.[0];
      const serializedMessages = JSON.stringify(secondRequest?.messages ?? []);

      expect(serializedMessages).toContain('Plan prêt.');
      expect(serializedMessages).not.toContain('Tool turn limit reached');
      expect(serializedMessages).not.toContain('Macro stopped the agent loop');
      expect(serializedMessages).not.toContain('Limite de tours');
      expect(
        secondRequest?.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.content === 'Plan prêt.' &&
            !('completion_reason' in message)
        )
      ).toBe(true);
    });

    it('keeps live context diagnostics pinned to the provider and model used to launch the stream', async () => {
      appState.mode = 'Chat';
      providerState.providerConfigs = [
        { ...DEFAULT_PROVIDER_CONFIGS[0], id: 'provider-1', providerType: 'openai' },
        { ...DEFAULT_PROVIDER_CONFIGS[0], id: 'provider-2', providerType: 'anthropic' },
      ];
      providerState.modelsByProvider = {
        'provider-1': [{ id: 'gpt-5.6', name: 'GPT-5.6', isEnabled: true, contextWindowTokens: 32_000, outputLimitTokens: 4_000 } as never],
        'provider-2': [{ id: 'model-2', name: 'Model 2', isEnabled: true, contextWindowTokens: 96_000, outputLimitTokens: 4_000 } as never],
      };
      providerState.selectedProviderId = 'provider-1';
      providerState.selectedModelId = 'gpt-5.6';

      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = args[0] as {
          onLiveContextUpdate?: (snapshot: {
            version: number;
            visibleContent: string;
            visibleContentLength: number;
            toolTraces: unknown[];
          }) => void;
        };
        options.onLiveContextUpdate?.({
          version: 1,
          visibleContent: 'Réponse partielle',
          visibleContentLength: 'Réponse partielle'.length,
          toolTraces: [],
        });
      }) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Mesure ce stream.',
      });
      await flushAsyncWork();

      providerState.selectedProviderId = 'provider-2';
      providerState.selectedModelId = 'model-2';
      await useChatStore.getState().refreshConversationContextDiagnostics('chat-conv', {
        mode: 'live_stream',
      });

      const diagnostics =
        useChatStore.getState().contextDiagnosticsByConversationId['chat-conv'];
      expect(diagnostics).toMatchObject({
        source: 'live_stream',
        providerId: 'provider-1',
        providerType: 'openai',
        modelId: 'gpt-5.6',
      });
      expect(diagnostics?.footprintAfter?.modelContextWindowTokens).toBe(32_000);
    });

    it('keeps live context diagnostics isolated from context changes made after send', async () => {
      appState.mode = 'Chat';
      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = args[0] as {
          onLiveContextUpdate?: (snapshot: {
            version: number;
            visibleContent: string;
            visibleContentLength: number;
            toolTraces: unknown[];
          }) => void;
        };
        options.onLiveContextUpdate?.({
          version: 1,
          visibleContent: 'Réponse en cours',
          visibleContentLength: 'Réponse en cours'.length,
          toolTraces: [],
        });
      }) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Ne mesure que le contexte initial.',
      });
      await flushAsyncWork();

      useChatStore.setState({
        composerContextRefs: [
          {
            kind: 'file',
            id: 'file-after-send',
            title: 'Late file context ref',
            subtitle: 'Should not affect live diagnostics',
            data: { description: 'Added after the stream started.' },
          },
        ],
      });
      context.citationRecords.push({
        id: 'late-citation',
        type: 'file',
        scope: 'context',
        source: 'src/late.ts',
        title: 'Late file',
        snippet: 'This source was attached after send.',
        content: 'This source was attached after send.',
        messageId: 'late-message',
        conversationId: 'chat-conv',
        timestamp: '2026-05-10T00:00:00.000Z',
        path: 'src/late.ts',
      });

      await useChatStore.getState().refreshConversationContextDiagnostics('chat-conv', {
        mode: 'live_stream',
      });

      const diagnostics =
        useChatStore.getState().contextDiagnosticsByConversationId['chat-conv'];
      expect(diagnostics?.counts.citations).toBe(0);
      expect(JSON.stringify(diagnostics?.breakdown ?? [])).not.toContain('Late file');
    });

    it('ignores older live context snapshots after a newer version is recorded', async () => {
      appState.mode = 'Chat';

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Teste les versions live.',
      });
      await flushAsyncWork();

      const streamOptions = getLatestStreamOptions<{
        onLiveContextUpdate?: (snapshot: {
          version: number;
          visibleContent: string;
          visibleContentLength: number;
          toolTraces: unknown[];
        }) => void;
      }>();
      streamOptions.onLiveContextUpdate?.({
        version: 2,
        visibleContent: 'snapshot récent',
        visibleContentLength: 'snapshot récent'.length,
        toolTraces: [],
      });
      streamOptions.onLiveContextUpdate?.({
        version: 1,
        visibleContent: 'snapshot ancien',
        visibleContentLength: 'snapshot ancien'.length,
        toolTraces: [],
      });

      expect(
        useChatStore.getState().liveStreamContextEstimatesByConversationId['chat-conv']
          ?.visibleContent,
      ).toBe('snapshot récent');
    });

    it('uses the completed stream provider for the final full context refresh', async () => {
      appState.mode = 'Chat';
      providerState.providerConfigs = [
        { ...DEFAULT_PROVIDER_CONFIGS[0], id: 'provider-1', providerType: 'openai' },
        { ...DEFAULT_PROVIDER_CONFIGS[0], id: 'provider-2', providerType: 'anthropic' },
      ];
      providerState.modelsByProvider = {
        'provider-1': [{ id: 'gpt-5.6', name: 'GPT-5.6', isEnabled: true, contextWindowTokens: 32_000, outputLimitTokens: 4_000 } as never],
        'provider-2': [{ id: 'model-2', name: 'Model 2', isEnabled: true, contextWindowTokens: 96_000, outputLimitTokens: 4_000 } as never],
      };
      providerState.selectedProviderId = 'provider-1';
      providerState.selectedModelId = 'gpt-5.6';
      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = args[0] as {
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            hiddenContext?: string;
          }) => void;
        };
        providerState.selectedProviderId = 'provider-2';
        providerState.selectedModelId = 'model-2';
        options.onComplete?.({
          visibleContent: 'Réponse finale.',
          toolTraces: [],
          hiddenContext: undefined,
        });
      }) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Termine puis mesure.',
        images: Array.from({ length: 4 }, (_, index) => ({
          id: `diagnostic-image-${index + 1}`,
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${'a'.repeat(index + 4)}`,
          width: 10_000,
          height: 10_000,
          createdAt: '2026-08-26T10:00:00.000Z',
        })),
      });

      const diagnostics = await waitForConversationDiagnostics(useChatStore, 'chat-conv');
      expect(diagnostics).toMatchObject({
        source: 'full',
        providerId: 'provider-1',
        providerType: 'openai',
        modelId: 'gpt-5.6',
      });
      expect(diagnostics?.footprintAfter?.modelContextWindowTokens).toBe(32_000);
      expect(diagnostics?.footprintAfter?.imageEstimateConfidence).toBe('model_formula');
      expect(diagnostics?.footprintAfter?.totalEstimatedTokens).toBeGreaterThan(
        diagnostics?.footprintAfter?.usableContextTokens ?? Number.POSITIVE_INFINITY,
      );
      expect(diagnostics?.footprintAfter?.isHardStop).toBe(false);
      expect(diagnostics?.phase).not.toBe('needs_manual_compaction');
    });

  });
};
