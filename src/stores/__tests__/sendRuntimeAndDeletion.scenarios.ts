import { describe, expect, it } from 'bun:test';
import type { ChatMessage, Conversation } from '../../types';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerSendRuntimeAndDeletionScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    DEFAULT_PROVIDER_CONFIGS,
    appSettingValues,
    appState,
    architectPlans,
    bindArchitectPlanConversationMock,
    createChatMessageRecord,
    createChatSnapshotConversation,
    createConversation,
    createConversationMock,
    createDeferred,
    createIdleChatStoreState,
    createImplementTask,
    createMessageMock,
    createScenarioPlan,
    deleteConversationMock,
    deleteConversationsMock,
    deleteConversationToolboxStateMock,
    deleteMessagesAfterMock,
    dbUpsertConversationCompactionStateMock,
    emitTaskStoreUpdate,
    executeWorkspaceToolMock,
    flushAsyncWork,
    getLatestStreamOptions,
    listMessagesMock,
    loadChatStore,
    providerState,
    queueSendChatNonStreamingImplementation,
    savePreferenceForTest,
    setSelectedProviderModelContext,
    streamChatMock,
    syncArchitectPlanChatFromConversationMock,
    taskStoreState,
    taskStoreSubscribers,
    toolsStoreState,
    updateMessageMock,
    waitForToolboxPersistence,
  } = context;

  describe('useChatStore send runtime and deletion', () => {
    it('rejects sends without a selected provider or model before committing any message', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];
      providerState.selectedProviderId = null;
      providerState.selectedModelId = null;

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await expect(
        useChatStore.getState().sendMessage({
          conversationId: 'implement-conv',
          content: 'Réponds à la demande du développeur.',
          taskId: 'task-1',
        })
      ).rejects.toThrow('Select a provider and model before sending a message.');

      expect(useChatStore.getState().getConversationMessages('implement-conv')).toHaveLength(0);
      expect(useChatStore.getState().lastError).toBe('Select a provider and model before sending a message.');
      expect(useChatStore.getState().sendState).toBe('error');
    });

    it('does not start streaming when the user message cannot be persisted', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      createMessageMock.mockImplementationOnce(async () => {
        throw new Error('database unavailable');
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [],
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

      await expect(
        useChatStore.getState().sendMessage({
          conversationId: 'chat-conv',
          content: 'Hello',
        })
      ).rejects.toThrow('Failed to save the message before sending: database unavailable');

      expect(streamChatMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().getConversationMessages('chat-conv')).toHaveLength(0);
      expect(useChatStore.getState().sendState).toBe('error');
    });

    it('routes provider stream errors to the transcript without setting the composer error', async () => {
      appState.mode = 'Chat';
      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as {
          onError?: (error: Error) => void;
        };
        const providerError = Object.assign(new Error('Provider returned error'), {
          name: 'ProviderRuntimeError',
          providerError: true,
          kind: 'rate_limited',
          status: 429,
          retryable: true,
          retryAfterMs: 45000,
          providerMessage: 'Too many requests for this model.',
          providerCode: 'rate_limit_exceeded',
          providerType: 'rate_limit',
        });
        options.onError?.(providerError);
        return { usage: null };
      }) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [],
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

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Hello',
      });
      await flushAsyncWork();

      const assistantMessage = useChatStore
        .getState()
        .getConversationMessages('chat-conv')
        .find((message: { role: string }) => message.role === 'assistant');
      const runtime = useChatStore.getState().getConversationRuntime('chat-conv');

      expect(useChatStore.getState().lastError).toBeNull();
      expect(runtime.lastErrorOrigin).toBe('provider');
      expect(runtime.lastErrorDisplayTarget).toBe('transcript');
      expect(assistantMessage?.content).toContain('### Erreur du provider');
      expect(assistantMessage?.content).toContain('Too many requests for this model.');
      expect(assistantMessage?.content).toContain('Statut HTTP: `429`');
    });

    it('keeps launch-time Macro errors in the composer and removes the empty assistant placeholder', async () => {
      appState.mode = 'Chat';
      toolsStoreState.internalTools = {};
      toolsStoreState.lastError = 'settings unavailable';

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [],
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

      await expect(
        useChatStore.getState().sendMessage({
          conversationId: 'chat-conv',
          content: 'Hello',
        }),
      ).rejects.toThrow('Failed to load tool settings');
      await flushAsyncWork();

      const messages = useChatStore.getState().getConversationMessages('chat-conv');
      const runtime = useChatStore.getState().getConversationRuntime('chat-conv');

      expect(messages.filter((message: { role: string }) => message.role === 'assistant')).toHaveLength(0);
      expect(useChatStore.getState().lastError).toContain('Failed to load tool settings');
      expect(runtime.lastErrorOrigin).toBe('macro');
      expect(runtime.lastErrorDisplayTarget).toBe('composer');
      expect(streamChatMock).not.toHaveBeenCalled();
    });

    it('preserves conversation-indexed messages when a launch-time Macro error removes a placeholder', async () => {
      appState.mode = 'Chat';
      toolsStoreState.internalTools = {};
      toolsStoreState.lastError = 'settings unavailable';

      const cachedOtherMessage = {
        id: 'cached-other-message',
        task_id: '',
        conversation_id: 'other-conv',
        role: 'user' as const,
        content: 'Keep me indexed only.',
        timestamp: '2026-04-14T10:00:00.000Z',
      };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          createConversation('chat-conv', ''),
          createConversation('other-conv', ''),
        ],
        messages: [],
        messagesByConversationId: {
          'other-conv': [cachedOtherMessage],
        },
        messageIndexById: {},
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

      await expect(
        useChatStore.getState().sendMessage({
          conversationId: 'chat-conv',
          content: 'Hello',
        }),
      ).rejects.toThrow('Failed to load tool settings');
      await flushAsyncWork();

      expect(useChatStore.getState().messagesByConversationId['other-conv']).toEqual([
        cachedOtherMessage,
      ]);
      expect(useChatStore.getState().getConversationMessages('other-conv')).toEqual([
        cachedOtherMessage,
      ]);
    });

    it('surfaces assistant persistence failures instead of losing them silently', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      createMessageMock.mockImplementationOnce(
        async (
          conversationId: string,
          role: 'user' | 'assistant',
          content: string,
          options?: {
            id?: string;
            turnId?: string | null;
            toolTraces?: unknown[];
            hiddenContext?: string;
            providerInputItems?: unknown[];
            providerTurnState?: unknown;
            contextRefs?: unknown[];
          }
        ) => ({
          id: 'db-user-message',
          conversation_id: conversationId,
          turn_id: options?.turnId ?? null,
          role,
          content,
          created_at: '2026-03-19T00:00:00.000Z',
          tool_traces_json: options?.toolTraces ? JSON.stringify(options.toolTraces) : null,
          hidden_context: options?.hiddenContext ?? null,
          provider_input_items_json: options?.providerInputItems
            ? JSON.stringify(options.providerInputItems)
            : null,
          provider_turn_state_json: options?.providerTurnState
            ? JSON.stringify(options.providerTurnState)
            : null,
          context_refs_json: options?.contextRefs
            ? JSON.stringify(options.contextRefs)
            : null,
        })
      );
      updateMessageMock.mockImplementation(async (_id, content) => {
        if (content === 'Persist me') {
          throw new Error('assistant write failed');
        }
      });
      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as {
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            hiddenContext?: string;
          }) => void;
        };
        options.onComplete?.({
          visibleContent: 'Persist me',
          toolTraces: [],
          hiddenContext: undefined,
        });
      }) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [],
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

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Hello',
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(createMessageMock).toHaveBeenCalledTimes(2);
      expect(useChatStore.getState().lastError).toBe(
        'Failed to save assistant response: assistant write failed'
      );
      expect(useChatStore.getState().sendState).toBe('error');
      expect(
        useChatStore
          .getState()
          .getConversationMessages('chat-conv')
          .some((message: { role: string; content: string }) =>
            message.role === 'assistant' && message.content === 'Persist me'
          )
      ).toBe(true);
      updateMessageMock.mockImplementation(async () => undefined);
    });

    it('does not let an older incomplete completion overwrite a newer streaming session', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      const releaseFirstPersistenceRef: { current: (() => void) | null } = {
        current: null,
      };
      const releaseSecondStreamRef: { current: (() => void) | null } = {
        current: null,
      };
      updateMessageMock.mockImplementation(async (_id, content) => {
        if (content === 'Partial response') {
          await new Promise<void>((resolve) => {
            releaseFirstPersistenceRef.current = resolve;
          });
        }
      });
      streamChatMock
        .mockImplementationOnce((async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as {
            onComplete?: (result: {
              visibleContent: string;
              toolTraces: unknown[];
              completionReason: 'incomplete';
            }) => void;
          };
          options.onComplete?.({
            visibleContent: 'Partial response',
            toolTraces: [],
            completionReason: 'incomplete',
          });
        }) as unknown as typeof streamChatMock)
        .mockImplementationOnce((async () =>
          new Promise<void>((resolve) => {
            releaseSecondStreamRef.current = resolve;
          })) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [],
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

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'First request',
      });
      await flushAsyncWork();

      const secondSend = useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Second request',
      });
      await flushAsyncWork();
      expect(useChatStore.getState().sendState).toBe('streaming');

      releaseFirstPersistenceRef.current?.();
      await flushAsyncWork();

      expect(useChatStore.getState().sendState).toBe('streaming');
      expect(useChatStore.getState().lastError).toBeNull();
      expect(
        useChatStore.getState().conversationRuntimeById['chat-conv']?.phase,
      ).toBe('streaming');

      releaseSecondStreamRef.current?.();
      await secondSend;
      updateMessageMock.mockImplementation(async () => undefined);
    });

    it('marks an exhausted incomplete recovery as an error for its owning session', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as {
          onComplete?: (result: {
            visibleContent: string;
            toolTraces: unknown[];
            completionReason: 'incomplete';
          }) => void;
        };
        options.onComplete?.({
          visibleContent: 'Persisted partial response',
          toolTraces: [],
          completionReason: 'incomplete',
        });
      }) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [],
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

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'First request',
      });
      await flushAsyncWork();

      expect(useChatStore.getState().sendState).toBe('error');
      expect(
        useChatStore.getState().conversationRuntimeById['chat-conv'],
      ).toEqual(
        expect.objectContaining({
          phase: 'error',
          lastError: 'Le fournisseur a interrompu la réponse avant sa fin.',
          lastErrorOrigin: 'provider',
          lastErrorDisplayTarget: 'transcript',
        }),
      );
    });

    it('does not consolidate an older synthetic checkpoint from a newer turn snapshot', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      setSelectedProviderModelContext();
      const releaseFirstPersistenceRef: { current: (() => void) | null } = {
        current: null,
      };
      const releaseSecondStreamRef: { current: (() => void) | null } = {
        current: null,
      };
      let createdSyntheticCheckpoint = false;
      queueSendChatNonStreamingImplementation(async () => {
        createdSyntheticCheckpoint = true;
        return JSON.stringify({
          currentObjective: 'Finish the current tool-assisted answer.',
          userInstructions: [],
          decisions: [],
          openQuestions: [],
          activeFiles: [],
          toolFacts: [],
          remainingWork: ['Answer from the latest tool result.'],
          summary: 'Older turns compacted at the tool boundary.',
        });
      });
      updateMessageMock.mockImplementation(async (_id, content) => {
        if (content === 'First completed response') {
          await new Promise<void>((resolve) => {
            releaseFirstPersistenceRef.current = resolve;
          });
        }
      });
      streamChatMock
        .mockImplementationOnce((async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as {
            onBeforeFollowUpRequest?: (request: {
              reason: 'tool_results';
              messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
              turnCount: number;
              toolResultCount: number;
            }) => Promise<
              Array<{
                role: 'system' | 'user' | 'assistant' | 'tool';
                content: string;
              }>
            >;
            onComplete?: (result: {
              visibleContent: string;
              toolTraces: unknown[];
              completionReason: 'completed';
            }) => void;
          };
          await options.onBeforeFollowUpRequest?.({
            reason: 'tool_results',
            messages: [
              { role: 'system', content: 'You are Macro.' },
              { role: 'user', content: `Old request ${'context '.repeat(12_000)}` },
              { role: 'assistant', content: `Old answer ${'detail '.repeat(12_000)}` },
              { role: 'tool', content: 'FILE: current.ts\nconst current = true;' },
            ],
            turnCount: 1,
            toolResultCount: 1,
          });
          options.onComplete?.({
            visibleContent: 'First completed response',
            toolTraces: [],
            completionReason: 'completed',
          });
        }) as unknown as typeof streamChatMock)
        .mockImplementationOnce((async () =>
          new Promise<void>((resolve) => {
            releaseSecondStreamRef.current = resolve;
          })) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [],
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

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'First request',
      });
      await flushAsyncWork();
      expect(createdSyntheticCheckpoint).toBe(true);
      expect(dbUpsertConversationCompactionStateMock).not.toHaveBeenCalled();

      const secondSend = useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Second request',
      });
      await flushAsyncWork();
      releaseFirstPersistenceRef.current?.();
      await flushAsyncWork();

      expect(dbUpsertConversationCompactionStateMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().sendState).toBe('streaming');

      releaseSecondStreamRef.current?.();
      await secondSend;
      updateMessageMock.mockImplementation(async () => undefined);
    });

    it('rejects concurrent sends while an Implement message is still preparing', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [createImplementTask({ status: 'Pending' })];

      const releaseStartTaskRef: { current: (() => void) | null } = { current: null };
      taskStoreState.startTask.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseStartTaskRef.current = () => {
              taskStoreState.tasks = taskStoreState.tasks.map((task) =>
                task.id === 'task-1'
                  ? {
                      ...task,
                      status: 'InProgress',
                    }
                  : task
              );
              resolve();
            };
          })
      );

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const firstSend = useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Premier envoi.',
        taskId: 'task-1',
      });

      await Promise.resolve();

      await expect(
        useChatStore.getState().sendMessage({
          conversationId: 'implement-conv',
          content: 'Deuxième envoi.',
          taskId: 'task-1',
        })
      ).rejects.toThrow(
        'This conversation is already running. Wait for it to finish before sending again.'
      );

      expect(useChatStore.getState().getConversationMessages('implement-conv')).toHaveLength(0);

      if (releaseStartTaskRef.current) {
        releaseStartTaskRef.current();
      }
      const result = await firstSend;

      expect(result.status).toBe('sent');
      expect(
        useChatStore
          .getState()
          .getConversationMessages('implement-conv')
          .map((message: { role: string; content: string }) => ({
            role: message.role,
            content: message.content,
          }))
      ).toEqual([
        { role: 'user', content: 'Premier envoi.' },
        { role: 'assistant', content: '' },
      ]);
    });

    it('keeps conversation runtimes independent across parallel chat streams and targeted stops', async () => {
      appState.mode = 'Chat';

      const activeStreams = new Map<string, () => void>();
      (streamChatMock as unknown as {
        mockImplementation: (
          implementation: (options: {
            conversationId?: string;
            signal?: AbortSignal;
            onComplete: (result: { visibleContent: string; toolTraces: [] }) => void;
          }) => Promise<void>
        ) => void;
      }).mockImplementation(async (options) => {
        await new Promise<void>((resolve) => {
          const finish = () => {
            options.onComplete({
              visibleContent: '',
              toolTraces: [],
            });
            resolve();
          };

          activeStreams.set(options.conversationId ?? 'unknown', finish);
          options.signal?.addEventListener('abort', finish, { once: true });
        });
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-1'),
            scope_mode: 'Chat',
            title: 'Chat 1',
          },
          {
            ...createConversation('chat-2'),
            scope_mode: 'Chat',
            title: 'Chat 2',
          },
        ],
        messages: [],
        selectedConversationId: 'chat-1',
        selectedConversationIdsByMode: { Chat: 'chat-1' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-1',
        content: 'Stream A',
      });
      await useChatStore.getState().sendMessage({
        conversationId: 'chat-2',
        content: 'Stream B',
      });

      expect(useChatStore.getState().getConversationRuntime('chat-1').phase).toBe('streaming');
      expect(useChatStore.getState().getConversationRuntime('chat-2').phase).toBe('streaming');

      useChatStore.getState().stopConversationStream('chat-1');
      await Promise.resolve();

      expect(useChatStore.getState().getConversationRuntime('chat-1').phase).toBe('idle');
      expect(useChatStore.getState().getConversationRuntime('chat-2').phase).toBe('streaming');

      activeStreams.get('chat-2')?.();
      await Promise.resolve();

      expect(useChatStore.getState().getConversationRuntime('chat-2').phase).toBe('idle');
    });

    it('keeps the active stream cleanup owner when an edit is rejected', async () => {
      appState.mode = 'Chat';
      context.tauriAvailable = true;
      (
        streamChatMock as unknown as {
          mockImplementationOnce: (
            implementation: (options: { signal?: AbortSignal }) => Promise<void>,
          ) => void;
        }
      ).mockImplementationOnce(async (options) => {
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv')],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));
      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Active stream',
      });
      const userMessage = useChatStore
        .getState()
        .getConversationMessages('chat-conv')
        .find((message: ChatMessage) => message.role === 'user');

      await expect(
        useChatStore.getState().editMessage(
          userMessage!.id,
          'Rejected replay',
          { skipAgentCodeReplayCheck: true },
        ),
      ).rejects.toThrow('This conversation is already running.');

      useChatStore.getState().stopConversationStream('chat-conv');
      await flushAsyncWork();

      expect(deleteMessagesAfterMock).toHaveBeenCalledWith(
        'chat-conv',
        userMessage!.id,
      );
    });

    it('stops an active Implement stream when the linked task becomes completed', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

      const { cancelStream } = await import('../../services/streamingChat');
      const cancelStreamMock = cancelStream as unknown as { mockClear: () => void; mock: { calls: unknown[][] } };
      cancelStreamMock.mockClear();

      const { useChatStore } = await loadChatStore();
      await Promise.resolve();

      const abortController = new AbortController();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        conversationRuntimeById: {
          'implement-conv': {
            phase: 'streaming',
            sessionId: 'session-task-1',
            assistantMessageId: 'assistant-1',
            abortController,
            lastError: null,
          },
        },
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
      });

      const previousTasks = taskStoreState.tasks;
      taskStoreState.tasks = [createImplementTask({ status: 'Completed' })];
      emitTaskStoreUpdate(previousTasks);
      await Promise.resolve();

      expect(useChatStore.getState().getConversationRuntime('implement-conv').phase).toBe('idle');
      expect(abortController.signal.aborted).toBe(true);
      expect(cancelStreamMock.mock.calls).toEqual([['session-task-1']]);
    });

    it('keeps an active Implement stream running for non-completed task transitions', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';

      for (const status of ['InReview', 'AwaitingResponse']) {
        taskStoreSubscribers.clear();
        taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

        const { cancelStream } = await import('../../services/streamingChat');
        const cancelStreamMock = cancelStream as unknown as { mockClear: () => void; mock: { calls: unknown[][] } };
        cancelStreamMock.mockClear();

        const { useChatStore } = await loadChatStore();
        await Promise.resolve();

        useChatStore.setState({
          conversations: [
            {
              ...createConversation(`implement-conv-${status}`),
              scope_mode: 'Implement',
              task_id: 'task-1',
              title: 'Task - Implement checkout',
            },
          ],
          conversationRuntimeById: {
            [`implement-conv-${status}`]: {
              phase: 'streaming',
              sessionId: `session-${status}`,
              assistantMessageId: 'assistant-1',
              abortController: new AbortController(),
              lastError: null,
            },
          },
          selectedConversationId: `implement-conv-${status}`,
          selectedConversationIdsByMode: { Implement: `implement-conv-${status}` },
        });

        const previousTasks = taskStoreState.tasks;
        taskStoreState.tasks = [createImplementTask({ status })];
        emitTaskStoreUpdate(previousTasks);
        await Promise.resolve();

        expect(useChatStore.getState().getConversationRuntime(`implement-conv-${status}`).phase).toBe('streaming');
        expect(cancelStreamMock.mock.calls).toEqual([]);
      }
    });

    it('deletes multiple chat conversations in a single batch and recalculates selection once', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-1',
            title: 'Chat 1',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 2,
            updated_at: '2026-03-19T00:03:00.000Z',
            is_unread: false,
          },
          {
            id: 'chat-2',
            title: 'Chat 2',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 1,
            updated_at: '2026-03-19T00:02:00.000Z',
            is_unread: false,
          },
          {
            id: 'chat-3',
            title: 'Chat 3',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 1,
            updated_at: '2026-03-19T00:01:00.000Z',
            is_unread: false,
          },
        ],
        messages: [
          {
            id: 'm-1',
            task_id: '',
            conversation_id: 'chat-1',
            role: 'user',
            content: 'one',
            timestamp: '2026-03-19T00:01:00.000Z',
          },
          {
            id: 'm-2',
            task_id: '',
            conversation_id: 'chat-1',
            role: 'assistant',
            content: 'two',
            timestamp: '2026-03-19T00:02:00.000Z',
          },
          {
            id: 'm-3',
            task_id: '',
            conversation_id: 'chat-2',
            role: 'user',
            content: 'three',
            timestamp: '2026-03-19T00:03:00.000Z',
          },
          {
            id: 'm-4',
            task_id: '',
            conversation_id: 'chat-3',
            role: 'assistant',
            content: 'four',
            timestamp: '2026-03-19T00:04:00.000Z',
          },
        ],
        selectedConversationId: 'chat-1',
        selectedConversationIdsByMode: { Chat: 'chat-1' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {
          'm-1': [
            {
              id: 'img-1',
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,aaa',
              createdAt: '2026-03-19T00:01:00.000Z',
            },
          ],
          'm-4': [
            {
              id: 'img-2',
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,bbb',
              createdAt: '2026-03-19T00:04:00.000Z',
            },
          ],
        },
        composerContextRefs: [],
      });

      await useChatStore.getState().deleteChatConversations(['chat-1', 'chat-2']);

      expect(deleteConversationsMock).toHaveBeenCalledWith(['chat-1', 'chat-2']);
      expect(deleteConversationToolboxStateMock).toHaveBeenCalledWith('chat-1');
      expect(deleteConversationToolboxStateMock).toHaveBeenCalledWith('chat-2');
      expect(useChatStore.getState().conversations.map((conversation: Conversation) => conversation.id)).toEqual([
        'chat-3',
      ]);
      expect(
        useChatStore.getState().messages.map((message: { id: string }) => message.id)
      ).toEqual(['m-4']);
      expect(useChatStore.getState().selectedConversationId).toBe('chat-3');
      expect(useChatStore.getState().selectedConversationIdsByMode.Chat).toBe('chat-3');
      expect(Object.keys(useChatStore.getState().messageImagesByMessageId)).toEqual(['m-4']);
    });

    it('does not restore messages when deletion wins a deferred conversation load', async () => {
      context.tauriAvailable = true;
      const deferredMessages = createDeferred<Array<ReturnType<typeof createChatMessageRecord>>>();
      listMessagesMock.mockImplementationOnce(async () => deferredMessages.promise);
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          { ...createConversation('chat-1'), scope_mode: 'Chat', message_count: 1 },
        ],
        selectedConversationId: 'chat-1',
        selectedConversationIdsByMode: { Chat: 'chat-1' },
      }));

      const loading = useChatStore.getState().ensureMessagesLoaded('chat-1');
      await Promise.resolve();
      await useChatStore.getState().deleteChatConversations(['chat-1']);
      deferredMessages.resolve([
        createChatMessageRecord({ id: 'late-message', conversation_id: 'chat-1' }),
      ]);
      await loading;

      expect(useChatStore.getState().conversations).toEqual([]);
      expect(useChatStore.getState().getConversationMessages('chat-1')).toEqual([]);
    });

    it('persists and resumes toolbox cleanup after a conversation deletion commits', async () => {
      context.tauriAvailable = true;
      deleteConversationToolboxStateMock.mockImplementationOnce(async () => {
        throw new Error('injected toolbox cleanup failure');
      });
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('chat-toolbox-retry', { message_count: 1 }),
      ];
      context.chatSnapshotMessages = [
        createChatMessageRecord({
          id: 'toolbox-retry-message',
          conversation_id: 'chat-toolbox-retry',
        }),
      ];
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [{ ...createConversation('chat-toolbox-retry'), scope_mode: 'Chat' }],
        messages: [{
          id: 'toolbox-retry-message',
          task_id: '',
          conversation_id: 'chat-toolbox-retry',
          role: 'user',
          content: 'Delete me safely.',
          timestamp: '2026-08-12T00:00:00.000Z',
        }],
        selectedConversationId: 'chat-toolbox-retry',
        selectedConversationIdsByMode: { Chat: 'chat-toolbox-retry' },
      }));

      await expect(
        useChatStore.getState().deleteConversation('chat-toolbox-retry'),
      ).rejects.toThrow('certaines ressources');

      expect(JSON.parse(appSettingValues.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([
        expect.objectContaining({
          ownerType: 'conversation',
          ownerId: 'chat-toolbox-retry',
          conversationId: 'chat-toolbox-retry',
          phase: 'task_deleted',
        }),
      ]);
      expect(useChatStore.getState().conversations).toEqual([]);

      await useChatStore.getState().initializeCritical();

      expect(deleteConversationToolboxStateMock).toHaveBeenCalledTimes(2);
      expect(appSettingValues.get('pendingLinkedTaskDeletions:v1')).toBe('[]');
      expect(useChatStore.getState().conversations).toEqual([]);
    });

    it('refuses a send while a deferred conversation deletion owns its tombstone', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      const deletion = createDeferred<undefined>();
      deleteConversationMock.mockImplementationOnce(async () => deletion.promise);
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          { ...createConversation('chat-1'), scope_mode: 'Chat' },
        ],
        selectedConversationId: 'chat-1',
        selectedConversationIdsByMode: { Chat: 'chat-1' },
      }));

      const deletionPromise = useChatStore.getState().deleteConversation('chat-1');
      await Promise.resolve();

      await expect(
        useChatStore.getState().sendMessage({
          conversationId: 'chat-1',
          content: 'Cette demande ne doit pas recréer la conversation.',
        }),
      ).rejects.toThrow('This conversation is no longer available.');

      expect(useChatStore.getState().getConversationRuntime('chat-1').phase).toBe('idle');
      expect(useChatStore.getState().getConversationMessages('chat-1')).toEqual([]);
      expect(createMessageMock).not.toHaveBeenCalled();
      expect(streamChatMock).not.toHaveBeenCalled();

      deletion.resolve(undefined);
      await deletionPromise;

      expect(useChatStore.getState().conversations).toEqual([]);
      expect(useChatStore.getState().getConversationMessages('chat-1')).toEqual([]);
    });

    it('does not materialize a ghost conversation when durable creation fails', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      createConversationMock.mockImplementationOnce(async () => {
        throw new Error('SQLite unavailable');
      });
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('existing-chat')],
        selectedConversationId: 'existing-chat',
        selectedConversationIdsByMode: { Chat: 'existing-chat' },
      }));

      await expect(
        useChatStore.getState().createConversation('Nouvelle conversation', null, null),
      ).rejects.toThrow('Impossible de créer la conversation de manière durable');

      expect(useChatStore.getState().conversations.map((conversation: Conversation) => conversation.id)).toEqual([
        'existing-chat',
      ]);
      expect(useChatStore.getState().selectedConversationId).toBe('existing-chat');
    });

    it('cleans an empty placeholder once before rebuilding a new session', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      const oldStreamReleased = createDeferred<undefined>();
      (
        streamChatMock as unknown as {
          mockImplementationOnce: (
            implementation: (options: { signal?: AbortSignal }) => Promise<void>,
          ) => void;
        }
      ).mockImplementationOnce(async (options) => {
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener(
            'abort',
            () => void oldStreamReleased.promise.then(() => resolve()),
            { once: true },
          );
        });
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-1')],
        selectedConversationId: 'chat-1',
        selectedConversationIdsByMode: { Chat: 'chat-1' },
      }));
      const oldSend = await useChatStore.getState().sendMessage({
        conversationId: 'chat-1',
        content: 'Ancien stream.',
      });

      useChatStore.getState().clearMessages();
      await flushAsyncWork();
      expect(deleteMessagesAfterMock).toHaveBeenCalledTimes(1);
      expect(deleteMessagesAfterMock).toHaveBeenCalledWith(
        'chat-1',
        oldSend.userMessageId,
      );
      await useChatStore.getState().initializeCritical();
      expect(useChatStore.getState().getConversationMessages('chat-1')).toEqual([]);
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-1')],
        selectedConversationId: 'chat-1',
        selectedConversationIdsByMode: { Chat: 'chat-1' },
      }));

      const newSend = await useChatStore.getState().sendMessage({
        conversationId: 'chat-1',
        content: 'Nouvelle session légitime.',
      });
      oldStreamReleased.resolve(undefined);
      await flushAsyncWork();

      expect(newSend).toMatchObject({ status: 'sent', conversationId: 'chat-1' });
      expect(deleteMessagesAfterMock).toHaveBeenCalledTimes(1);
      expect(
        useChatStore
          .getState()
          .getConversationMessages('chat-1')
          .some((message: ChatMessage) => message.content === 'Nouvelle session légitime.'),
      ).toBe(true);
    });

    it('restores the previous snapshot when bulk chat deletion fails', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      deleteConversationsMock.mockImplementationOnce(async () => {
        throw new Error('db unavailable');
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-1',
            title: 'Chat 1',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 1,
            updated_at: '2026-03-19T00:02:00.000Z',
            is_unread: false,
          },
          {
            id: 'chat-2',
            title: 'Chat 2',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 1,
            updated_at: '2026-03-19T00:01:00.000Z',
            is_unread: false,
          },
        ],
        messages: [
          {
            id: 'm-1',
            task_id: '',
            conversation_id: 'chat-1',
            role: 'user',
            content: 'one',
            timestamp: '2026-03-19T00:01:00.000Z',
          },
          {
            id: 'm-2',
            task_id: '',
            conversation_id: 'chat-2',
            role: 'assistant',
            content: 'two',
            timestamp: '2026-03-19T00:02:00.000Z',
          },
        ],
        selectedConversationId: 'chat-1',
        selectedConversationIdsByMode: { Chat: 'chat-1' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {
          'm-1': [
            {
              id: 'img-1',
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,aaa',
              createdAt: '2026-03-19T00:01:00.000Z',
            },
          ],
        },
        composerContextRefs: [],
      });

      await expect(useChatStore.getState().deleteChatConversations(['chat-1'])).rejects.toThrow(
        'db unavailable'
      );
      expect(useChatStore.getState().conversations.map((conversation: Conversation) => conversation.id)).toEqual([
        'chat-1',
        'chat-2',
      ]);
      expect(
        useChatStore.getState().messages.map((message: { id: string }) => message.id)
      ).toEqual(['m-1', 'm-2']);
      expect(useChatStore.getState().selectedConversationId).toBe('chat-1');
      expect(Object.keys(useChatStore.getState().messageImagesByMessageId)).toEqual(['m-1']);
    });

    it('rejects bulk deletion for non-chat conversations', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('architect-conv')],
        messages: [],
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await expect(
        useChatStore.getState().deleteChatConversations(['architect-conv'])
      ).rejects.toThrow('La suppression groupée est réservée aux conversations Chat.');
      expect(deleteConversationsMock).not.toHaveBeenCalled();
    });

    it('updates only the targeted message object when appending streamed content', async () => {
      const { useChatStore } = await loadChatStore();

      useChatStore.setState({
        conversations: [createConversation('conv-1')],
        messages: [],
        messagesByConversationId: {},
        messageIndexById: {},
        selectedConversationId: 'conv-1',
        selectedConversationIdsByMode: { Chat: 'conv-1' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      useChatStore.getState().addMessage({
        id: 'm-user',
        task_id: '',
        conversation_id: 'conv-1',
        role: 'user',
        content: 'bonjour',
        timestamp: '2026-03-19T00:01:00.000Z',
      });
      useChatStore.getState().addMessage({
        id: 'm-assistant',
        task_id: '',
        conversation_id: 'conv-1',
        role: 'assistant',
        content: 'rép',
        timestamp: '2026-03-19T00:02:00.000Z',
        tool_traces: [],
      });

      const beforeMessages = useChatStore.getState().messages;

      useChatStore.getState().appendToMessage('m-assistant', 'onse');

      const afterMessages = useChatStore.getState().messages;
      expect(afterMessages[0]).toBe(beforeMessages[0]);
      expect(afterMessages[1]).not.toBe(beforeMessages[1]);
      expect(afterMessages[1]?.content).toBe('réponse');
      expect(
        useChatStore
          .getState()
          .getConversationMessages('conv-1')
          .map((message: { id: string }) => message.id)
      ).toEqual(['m-user', 'm-assistant']);
    });

    it('claims an edited conversation before credential loading so a second replay cannot trim it', async () => {
      appState.mode = 'Chat';
      providerState.providerConfigs = [
        {
          ...DEFAULT_PROVIDER_CONFIGS[0],
          isLocal: false,
        },
      ];
      const credential = createDeferred<undefined>();
      providerState.resolveProviderApiKey.mockImplementationOnce(
        async () => credential.promise,
      );

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv')],
        messages: [
          {
            id: 'user-1',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'user',
            content: 'Original request',
            timestamp: '2026-03-19T00:01:00.000Z',
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      const firstEdit = useChatStore.getState().editMessage(
        'user-1',
        'First replay request',
        { skipAgentCodeReplayCheck: true },
      );
      await Promise.resolve();

      expect(useChatStore.getState().getConversationRuntime('chat-conv').phase).toBe(
        'preparing',
      );
      await expect(
        useChatStore.getState().editMessage(
          'user-1',
          'Second replay request',
          { skipAgentCodeReplayCheck: true },
        ),
      ).rejects.toThrow(
        'This conversation is already running. Wait for it to finish before sending again.',
      );

      useChatStore.getState().stopConversationStream('chat-conv');
      credential.resolve(undefined);
      await firstEdit;

      expect(useChatStore.getState().getConversationRuntime('chat-conv').phase).toBe('idle');
      expect(useChatStore.getState().getConversationMessages('chat-conv')).toHaveLength(1);
      expect(deleteMessagesAfterMock).not.toHaveBeenCalled();
    });

    it('removes a deferred edit-replay placeholder when Stop wins after its creation', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      const placeholderCreated = createDeferred<ReturnType<typeof createChatMessageRecord>>();
      (
        createMessageMock as unknown as {
          mockImplementationOnce: (
            implementation: (...args: unknown[]) => Promise<ReturnType<typeof createChatMessageRecord>>,
          ) => void;
        }
      ).mockImplementationOnce(async () => placeholderCreated.promise);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv')],
        messages: [
          {
            id: 'user-1',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'user',
            content: 'Original request',
            timestamp: '2026-03-19T00:01:00.000Z',
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));

      const edit = useChatStore.getState().editMessage(
        'user-1',
        'Edited request',
        { skipAgentCodeReplayCheck: true },
      );
      await flushAsyncWork();
      expect(createMessageMock).toHaveBeenCalledWith(
        'chat-conv',
        'assistant',
        '',
        expect.objectContaining({ turnId: 'legacy-turn-user-1' }),
      );

      useChatStore.getState().stopConversationStream('chat-conv');
      placeholderCreated.resolve(
        createChatMessageRecord({
          id: 'deferred-assistant',
          conversation_id: 'chat-conv',
          role: 'assistant',
          content: '',
        }),
      );
      await edit;

      expect(
        useChatStore.getState().getConversationMessages('chat-conv'),
      ).not.toContainEqual(expect.objectContaining({ id: 'deferred-assistant' }));
      expect(deleteMessagesAfterMock).toHaveBeenCalledWith('chat-conv', 'user-1');
    });

    it('keeps generation A bound to its captured context after delayed loading', async () => {
      appState.mode = 'Implement';
      appState.agentType = 'build';
      appState.selectedTaskId = 'task-1';
      context.tauriAvailable = true;
      await savePreferenceForTest('toolRiskLevel', 'yolo');
      taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];
      const deferredA = createDeferred<Array<ReturnType<typeof createChatMessageRecord>>>();
      listMessagesMock.mockImplementationOnce(async () => deferredA.promise);
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          {
            ...createConversation('chat-a'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            message_count: 1,
          },
          { ...createConversation('chat-b'), scope_mode: 'Chat', message_count: 0 },
        ],
        selectedConversationId: 'chat-a',
        selectedConversationIdsByMode: { Implement: 'chat-a' },
      }));

      const sendA = useChatStore.getState().sendMessage({
        conversationId: 'chat-a', content: 'A stays isolated.', taskId: 'task-1',
      });
      await Promise.resolve();
      appState.mode = 'Chat';
      appState.selectedTaskId = 'task-b';
      appState.selectedProjectId = 'project-2';
      providerState.selectedProviderId = 'provider-2';
      providerState.selectedModelId = 'model-2';
      deferredA.resolve([createChatMessageRecord({
        id: 'history-a', conversation_id: 'chat-a', role: 'user',
      })]);

      await expect(sendA).resolves.toMatchObject({ status: 'sent', conversationId: 'chat-a' });
      const options = getLatestStreamOptions<{
        conversationId?: string;
        providerId?: string;
        modelId?: string;
        onToolCall?: (
          toolName: string,
          args: Record<string, unknown>,
          toolCallId?: string,
        ) => Promise<unknown>;
      }>();
      expect(options.conversationId).toBe('chat-a');
      expect(options.providerId).toBe('provider-1');
      expect(options.modelId).toBe('model-1');
      expect(useChatStore.getState().getConversationMessages('chat-a').every(
        (message: ChatMessage) => message.conversation_id === 'chat-a',
      )).toBe(true);
      await options.onToolCall?.('read', { path: 'src/a.ts' }, 'read-from-a');
      expect(executeWorkspaceToolMock).toHaveBeenCalledWith(
        'read',
        { path: 'src/a.ts' },
        'Implement',
        expect.objectContaining({ projectId: 'project-1' }),
      );
    });

    it('does not revive stopped preparation A after generation B starts', async () => {
      appState.mode = 'Chat';
      context.tauriAvailable = true;
      const deferredA = createDeferred<Array<ReturnType<typeof createChatMessageRecord>>>();
      listMessagesMock.mockImplementationOnce(async () => deferredA.promise);
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          { ...createConversation('chat-a'), scope_mode: 'Chat', message_count: 1 },
          { ...createConversation('chat-b'), scope_mode: 'Chat', message_count: 0 },
        ],
        selectedConversationId: 'chat-a',
        selectedConversationIdsByMode: { Chat: 'chat-a' },
      }));

      const sendA = useChatStore.getState().sendMessage({
        conversationId: 'chat-a', content: 'late A',
      });
      await Promise.resolve();
      expect(listMessagesMock).toHaveBeenCalledWith('chat-a');
      expect(useChatStore.getState().getConversationRuntime('chat-a').phase).toBe('preparing');
      useChatStore.getState().stopConversationStream('chat-a');
      const sendB = await useChatStore.getState().sendMessage({
        conversationId: 'chat-b', content: 'live B',
      });
      deferredA.resolve([createChatMessageRecord({
        id: 'history-a', conversation_id: 'chat-a', role: 'user',
      })]);

      await expect(sendA).resolves.toMatchObject({ status: 'cancelled', conversationId: 'chat-a' });
      expect(sendB).toMatchObject({ status: 'sent', conversationId: 'chat-b' });
      expect(streamChatMock).toHaveBeenCalledTimes(1);
      expect(getLatestStreamOptions<{ conversationId?: string }>().conversationId).toBe('chat-b');
      expect(executeWorkspaceToolMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().getConversationRuntime('chat-a').phase).toBe('idle');
      expect(useChatStore.getState().getConversationRuntime('chat-b').phase).toBe('streaming');
      expect(useChatStore.getState().getConversationMessages('chat-a').some(
        (message: ChatMessage) => message.content === 'late A',
      )).toBe(false);
    });

    it('does not clear B composer references when A finishes preparing', async () => {
      appState.mode = 'Chat';
      context.tauriAvailable = true;
      const deferredA = createDeferred<Array<ReturnType<typeof createChatMessageRecord>>>();
      listMessagesMock.mockImplementationOnce(async () => deferredA.promise);
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          { ...createConversation('chat-a'), message_count: 1 },
          createConversation('chat-b'),
        ],
        selectedConversationId: 'chat-a',
        selectedConversationIdsByMode: { Chat: 'chat-a' },
      }));
      useChatStore.getState().replaceComposerContextRefs([
        { id: 'src/a.ts', kind: 'file', title: 'a.ts', path: 'src/a.ts' },
      ], 'chat-a');

      const sendA = useChatStore.getState().sendMessage({
        conversationId: 'chat-a', content: 'A keeps its references.',
      });
      await Promise.resolve();
      useChatStore.setState({
        selectedConversationId: 'chat-b',
        selectedConversationIdsByMode: { Chat: 'chat-b' },
      });
      const bRefs = [
        { id: 'src/b.ts', kind: 'file' as const, title: 'b.ts', path: 'src/b.ts' },
      ];
      useChatStore.getState().replaceComposerContextRefs(bRefs, 'chat-b');
      deferredA.resolve([createChatMessageRecord({
        id: 'history-a', conversation_id: 'chat-a', role: 'user',
      })]);

      await expect(sendA).resolves.toMatchObject({ status: 'sent', conversationId: 'chat-a' });
      expect(useChatStore.getState().composerContextRefs).toEqual(bRefs);
    });

    it('clears A toolbox references without touching B after a selection-only switch', async () => {
      appState.mode = 'Chat';
      context.tauriAvailable = true;
      const deferredA = createDeferred<Array<ReturnType<typeof createChatMessageRecord>>>();
      listMessagesMock.mockImplementationOnce(async () => deferredA.promise);
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          { ...createConversation('chat-a'), message_count: 1 },
          createConversation('chat-b'),
        ],
        selectedConversationId: 'chat-a',
        selectedConversationIdsByMode: { Chat: 'chat-a' },
      }));
      useChatStore.getState().replaceComposerContextRefs([
        { id: 'src/a.ts', kind: 'file', title: 'a.ts', path: 'src/a.ts' },
      ], 'chat-a');

      const sendA = useChatStore.getState().sendMessage({
        conversationId: 'chat-a', content: 'A sends while B is selected.',
      });
      await Promise.resolve();
      const bRefs = [
        { id: 'src/b.ts', kind: 'file' as const, title: 'b.ts', path: 'src/b.ts' },
      ];
      useChatStore.setState({
        selectedConversationId: 'chat-b',
        selectedConversationIdsByMode: { Chat: 'chat-b' },
        composerContextRefs: bRefs,
      });
      deferredA.resolve([createChatMessageRecord({
        id: 'history-a', conversation_id: 'chat-a', role: 'user',
      })]);

      await expect(sendA).resolves.toMatchObject({ status: 'sent', conversationId: 'chat-a' });
      await waitForToolboxPersistence();
      expect(useChatStore.getState().composerContextRefs).toEqual(bRefs);
      expect(deleteConversationToolboxStateMock).toHaveBeenCalledWith('chat-a');
      expect(deleteConversationToolboxStateMock).not.toHaveBeenCalledWith('chat-b');
    });

    it('keeps the Architect plan and branch captured at send when the selection changes', async () => {
      appState.mode = 'Architect';
      const planA = createScenarioPlan('blank', {
        id: 'plan-a-at-send', targetBranch: 'feature/plan-a', conversationId: undefined,
      });
      const planB = createScenarioPlan('started', {
        id: 'plan-b-after-send', targetBranch: 'feature/plan-b', conversationId: 'chat-b',
      });
      architectPlans.set(planA.id, planA);
      architectPlans.set(planB.id, planB);
      appState.activeArchitectPlanId = planA.id;
      appState.activePlanContext = { id: planA.id, targetBranch: planA.targetBranch };
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState());
      const conversationId = await useChatStore.getState().ensureConversationForCurrentMode();
      expect(conversationId).toMatch(/^pending-architect-/);

      providerState.providerConfigs = [{ ...DEFAULT_PROVIDER_CONFIGS[0], isLocal: false }];
      const credential = createDeferred<undefined>();
      providerState.resolveProviderApiKey.mockImplementationOnce(async () => credential.promise);

      const send = useChatStore.getState().sendMessage({
        conversationId: conversationId!, content: 'Keep plan A.',
      });
      await flushAsyncWork();
      expect(providerState.resolveProviderApiKey).toHaveBeenCalledWith('provider-1');
      appState.activeArchitectPlanId = planB.id;
      appState.activePlanContext = { id: planB.id, targetBranch: planB.targetBranch };
      credential.resolve(undefined);

      const result = await send;
      expect(result).toMatchObject({ status: 'sent' });
      expect(bindArchitectPlanConversationMock).toHaveBeenCalledWith({
        branchName: planA.targetBranch,
        planId: planA.id,
        conversationId: result.conversationId,
      });
      expect(syncArchitectPlanChatFromConversationMock).toHaveBeenCalledWith({
        branchName: planA.targetBranch,
        planId: planA.id,
        conversationId: result.conversationId,
      });
      expect(bindArchitectPlanConversationMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ planId: planB.id }),
      );
    });

    it('publishes a user message persisted just before Stop without deleting its anchor', async () => {
      appState.mode = 'Chat';
      context.tauriAvailable = true;
      const persistedUser = createDeferred<Awaited<ReturnType<typeof createMessageMock>>>();
      createMessageMock.mockImplementationOnce(async () => persistedUser.promise);
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-a')],
        selectedConversationId: 'chat-a',
        selectedConversationIdsByMode: { Chat: 'chat-a' },
      }));

      const send = useChatStore.getState().sendMessage({
        conversationId: 'chat-a', content: 'Persisted before Stop.',
      });
      await flushAsyncWork();
      expect(createMessageMock).toHaveBeenCalled();
      useChatStore.getState().stopConversationStream('chat-a');
      persistedUser.resolve({
        id: 'persisted-user',
        conversation_id: 'chat-a',
        turn_id: null,
        role: 'user',
        content: 'Persisted before Stop.',
        created_at: '2026-03-19T00:00:00.000Z',
        tool_traces_json: null,
        hidden_context: null,
        provider_input_items_json: null,
        provider_turn_state_json: null,
        context_refs_json: null,
      });

      await expect(send).resolves.toMatchObject({
        status: 'sent',
        conversationId: 'chat-a',
        userMessageId: 'persisted-user',
        assistantMessageId: null,
      });
      expect(useChatStore.getState().getConversationMessages('chat-a')).toEqual([
        expect.objectContaining({ id: 'persisted-user', role: 'user' }),
      ]);
      expect(deleteMessagesAfterMock).not.toHaveBeenCalled();
    });

  });
};
