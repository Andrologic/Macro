import { describe, expect, it } from 'bun:test';
import type { AgentCodeCheckpoint, CompactionPass, Conversation } from '../../types';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerReplayAndEditingScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    appState,
    createConversation,
    createDeferred,
    createIdleChatStoreState,
    createMessageMock,
    dbCompleteConversationReplayMock,
    dbFinalizeConversationReplayMock,
    dbMarkConversationReplayLaunchedMock,
    dbPrepareConversationReplayMock,
    dbRestoreConversationReplayMock,
    deleteMessagesAfterMock,
    flushAsyncWork,
    fsExistsMock,
    fsReadFileWithOptionsMock,
    fsWriteFileMock,
    loadChatStore,
    streamChatMock,
    updateMessageMock,
  } = context;

  describe('useChatStore replay and editing', () => {
    it('durably rolls back a confirmed code rewind before a replay launches', async () => {
      context.tauriAvailable = true;
      let diskContent = 'original';
      let diskRevision = 'original-revision';
      fsExistsMock.mockImplementation(async () => true);
      fsReadFileWithOptionsMock.mockImplementation(async () => ({
        content: diskContent,
        revision: diskRevision,
        language: 'typescript',
        is_binary: false,
        size: diskContent.length,
        encoding: 'utf-8',
      }));
      fsWriteFileMock.mockImplementation(async (params) => {
        diskContent = params.content;
        diskRevision = params.content === 'original'
          ? 'original-revision'
          : 'rewound-revision';
        return {
          path: params.path,
          bytes_written: params.content.length,
          created: false,
          revision: diskRevision,
        };
      });

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().restoreAgentCodeForReplay({
        conversationId: 'chat-conv',
        messageId: 'user-1',
        targetCheckpointId: null,
        affectedFiles: [
          {
            path: 'src/file.ts',
            realPath: '/repos/web/src/file.ts',
            action: 'modify',
            status: 'modified',
            workspacePath: '/repos/web',
            target: {
              exists: true,
              content: 'rewound',
              revision: 'rewound-revision',
            },
            current: {
              exists: true,
              content: 'original',
              revision: 'original-revision',
            },
          },
        ],
      });

      expect(diskContent).toBe('rewound');
      expect(JSON.parse(
        context.appSettingValues.get('agentCodeReplayRecovery:chat-conv') ?? '{}',
      )).toMatchObject({ phase: 'pending', conversationId: 'chat-conv' });

      await useChatStore.getState().rollbackPendingAgentCodeReplay('chat-conv');

      expect(diskContent).toBe('original');
      expect(
        context.appSettingValues.has('agentCodeReplayRecovery:chat-conv'),
      ).toBe(false);
    });

    it('waits for a launched replay and restores its code before deleting the conversation', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      let diskContent = 'original';
      let diskRevision = 'original-revision';
      fsExistsMock.mockImplementation(async () => true);
      fsReadFileWithOptionsMock.mockImplementation(async () => ({
        content: diskContent,
        revision: diskRevision,
        language: 'typescript',
        is_binary: false,
        size: diskContent.length,
        encoding: 'utf-8',
      }));
      fsWriteFileMock.mockImplementation(async (params) => {
        diskContent = params.content;
        diskRevision = params.content === 'original'
          ? 'original-revision'
          : 'rewound-revision';
        return {
          path: params.path,
          bytes_written: params.content.length,
          created: false,
          revision: diskRevision,
        };
      });
      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as { signal?: AbortSignal };
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { usage: null };
      }) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [{ ...createConversation('chat-conv', ''), scope_mode: 'Chat' }],
        messages: [
          { id: 'replay-user', task_id: '', conversation_id: 'chat-conv', role: 'user', content: 'Original request', timestamp: '2026-04-14T10:00:00.000Z' },
          { id: 'replay-assistant', task_id: '', conversation_id: 'chat-conv', role: 'assistant', content: 'Existing answer', timestamp: '2026-04-14T10:01:00.000Z' },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      }));
      await useChatStore.getState().restoreAgentCodeForReplay({
        conversationId: 'chat-conv',
        messageId: 'replay-user',
        targetCheckpointId: null,
        affectedFiles: [
          {
            path: 'src/file.ts',
            realPath: '/repos/web/src/file.ts',
            action: 'modify',
            status: 'modified',
            workspacePath: '/repos/web',
            target: {
              exists: true,
              content: 'rewound',
              revision: 'rewound-revision',
            },
            current: {
              exists: true,
              content: 'original',
              revision: 'original-revision',
            },
          },
        ],
      });

      await useChatStore.getState().editMessage('replay-user', 'Updated request', {
        skipAgentCodeReplayCheck: true,
      });
      expect(dbMarkConversationReplayLaunchedMock).toHaveBeenCalledTimes(1);
      expect(diskContent).toBe('rewound');

      await useChatStore.getState().deleteConversation('chat-conv');

      expect(diskContent).toBe('original');
      expect(
        context.appSettingValues.has('agentCodeReplayRecovery:chat-conv'),
      ).toBe(false);
      expect(useChatStore.getState().conversations).toEqual([]);
    });

    it('replaces an edited questionnaire response, trims later messages, and restarts the chat from the updated answer', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [
          {
            id: 'assistant-questionnaire',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'assistant',
            content: 'Need two clarifications.',
            timestamp: '2026-04-14T10:00:00.000Z',
            provider_input_items: [
              {
                type: 'function_call',
                call_id: 'call_question',
                name: 'question',
                arguments:
                  '{"intro":"Need two clarifications.","questions":[{"id":"scope","prompt":"Which scope should I use?","choices":["Minimal","Balanced","Large"]},{"id":"risk","prompt":"How risky can the change be?","choices":["Safe","Moderate","Aggressive"],"free_text_placeholder":"Custom answer"}]}',
              },
            ],
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
          },
          {
            id: 'user-questionnaire',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'user',
            content:
              'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
            timestamp: '2026-04-14T10:01:00.000Z',
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
            provider_input_items: [
              {
                type: 'function_call_output',
                call_id: 'call_question',
                output:
                  'Questionnaire responses:\n- Which scope should I use?: Balanced\n- How risky can the change be?: Stay below one day of rework',
              },
              {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text:
                      'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
                  },
                ],
              },
            ],
          },
          {
            id: 'assistant-after',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'assistant',
            content: 'Thanks, I can continue.',
            timestamp: '2026-04-14T10:02:00.000Z',
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
      });

      expect(
        useChatStore.getState().startQuestionnaireResponseEdit('user-questionnaire'),
      ).toBe(true);
      useChatStore
        .getState()
        .recordActiveQuestionnaireAnswer('chat-conv', 'Large');
      expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
        mode: 'editing_response',
        responseMessageId: 'user-questionnaire',
        currentStepIndex: 0,
        answersByStepId: {
          scope: 'Large',
          risk: 'Stay below one day of rework',
        },
      });

      await useChatStore.getState().submitActiveQuestionnaire('chat-conv');
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const conversationMessages = useChatStore.getState().getConversationMessages('chat-conv');
      const updatedUserMessage = conversationMessages.find(
        (message: { id: string }) => message.id === 'user-questionnaire'
      );
      expect(updatedUserMessage?.questionnaire_response_summary).toEqual({
        assistantMessageId: 'assistant-questionnaire',
        source: 'tool',
        originToolCallId: 'call_question',
        items: [
          {
            id: 'scope',
            prompt: 'Which scope should I use?',
            answer: 'Large',
          },
          {
            id: 'risk',
            prompt: 'How risky can the change be?',
            answer: 'Stay below one day of rework',
          },
        ],
      });
      expect(updatedUserMessage?.content).toBe(
        'Which scope should I use?: Large\nHow risky can the change be?: Stay below one day of rework',
      );
      expect(
        conversationMessages.some((message: { id: string }) => message.id === 'assistant-after')
      ).toBe(false);
      expect(useChatStore.getState().questionnaireDraftsByConversationId['chat-conv']).toBeUndefined();

      expect(updateMessageMock).toHaveBeenCalledWith(
        'user-questionnaire',
        'Which scope should I use?: Large\nHow risky can the change be?: Stay below one day of rework',
        expect.objectContaining({
          hiddenContext: expect.stringContaining('<questionnaire_response_context>'),
          providerInputItems: [
            {
              type: 'function_call_output',
              call_id: 'call_question',
              output:
                'Questionnaire responses:\n- Which scope should I use?: Large\n- How risky can the change be?: Stay below one day of rework',
            },
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text:
                    'Which scope should I use?: Large\nHow risky can the change be?: Stay below one day of rework',
                },
              ],
            },
          ],
        }),
      );
      expect(dbPrepareConversationReplayMock).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'chat-conv',
          messageId: 'user-questionnaire',
        }),
      );
      expect(streamChatMock).toHaveBeenCalledTimes(1);
      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(streamOptions.messages.some((message) =>
        message.role === 'user' &&
        message.content ===
          'Which scope should I use?: Large\nHow risky can the change be?: Stay below one day of rework'
      )).toBe(true);
    });

    it('prunes session compaction markers at and after a replayed message', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          createConversation('chat-conv', ''),
          createConversation('other-conv', ''),
        ],
        messages: [
          {
            id: 'u1',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'user',
            content: 'First user request',
            timestamp: '2026-04-14T10:00:00.000Z',
          },
          {
            id: 'a1',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'assistant',
            content: 'First assistant answer',
            timestamp: '2026-04-14T10:01:00.000Z',
          },
          {
            id: 'u2',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'user',
            content: 'Second user request',
            timestamp: '2026-04-14T10:02:00.000Z',
          },
          {
            id: 'a2',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'assistant',
            content: 'Second assistant answer',
            timestamp: '2026-04-14T10:03:00.000Z',
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
        sessionCompactionEventsByConversationId: {
          'chat-conv': [
            {
              id: 'compaction-before-replay',
              status: 'completed' as const,
              displayAfterMessageId: 'u1',
              logicalUpToMessageId: 'a1',
              kind: 'manual' as const,
              startedAt: '2026-04-14T10:01:10.000Z',
              completedAt: '2026-04-14T10:01:20.000Z',
            },
            {
              id: 'compaction-at-replay',
              status: 'completed' as const,
              displayAfterMessageId: 'u2',
              logicalUpToMessageId: 'u2',
              kind: 'safety_prestream' as const,
              startedAt: '2026-04-14T10:02:10.000Z',
              completedAt: '2026-04-14T10:02:20.000Z',
            },
            {
              id: 'compaction-after-replay',
              status: 'running' as const,
              displayAfterMessageId: 'a2',
              kind: 'manual' as const,
              startedAt: '2026-04-14T10:03:10.000Z',
            },
            {
              id: 'compaction-without-anchor',
              status: 'completed' as const,
              displayAfterMessageId: null,
              kind: 'manual' as const,
              startedAt: '2026-04-14T10:04:10.000Z',
              completedAt: '2026-04-14T10:04:20.000Z',
            },
          ],
          'other-conv': [
            {
              id: 'other-compaction',
              status: 'completed' as const,
              displayAfterMessageId: 'other-message',
              kind: 'manual' as const,
              startedAt: '2026-04-14T10:05:10.000Z',
              completedAt: '2026-04-14T10:05:20.000Z',
            },
          ],
        },
      });

      await useChatStore.getState().editMessage('u2', 'Second user request updated', {
        skipAgentCodeReplayCheck: true,
      });
      await flushAsyncWork();

      expect(dbPrepareConversationReplayMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'chat-conv', messageId: 'u2' }),
      );
      expect(
        useChatStore.getState().sessionCompactionEventsByConversationId[
          'chat-conv'
        ],
      ).toEqual([
        expect.objectContaining({
          id: 'compaction-before-replay',
          displayAfterMessageId: 'u1',
        }),
      ]);
      expect(
        useChatStore.getState().sessionCompactionEventsByConversationId[
          'other-conv'
        ],
      ).toEqual([
        expect.objectContaining({
          id: 'other-compaction',
        }),
      ]);
    });

    it('keeps the transcript tail in state when the atomic replay trim fails', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      dbPrepareConversationReplayMock.mockImplementation(async () => {
        throw new Error('injected replay trim failure');
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [
          {
            id: 'replay-user',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'user',
            content: 'Original request',
            timestamp: '2026-04-14T10:00:00.000Z',
          },
          {
            id: 'replay-assistant',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'assistant',
            content: 'Existing answer',
            timestamp: '2026-04-14T10:01:00.000Z',
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().editMessage('replay-user', 'Updated request', {
        skipAgentCodeReplayCheck: true,
      });

      expect(dbPrepareConversationReplayMock).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().getConversationMessages('chat-conv').map((message: { id: string }) => message.id),
      ).toEqual(['replay-user', 'replay-assistant']);
      expect(streamChatMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().lastError).toContain('injected replay trim failure');
    });

    it('restores the replay snapshot after a post-trim launch failure', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      createMessageMock.mockImplementationOnce(async () => {
        throw new Error('injected placeholder persistence failure');
      });
      context.citationRecords = [
        {
          id: 'citation-tail',
          type: 'file',
          scope: 'context',
          source: 'tail.md',
          title: 'Tail',
          messageId: 'replay-assistant',
          conversationId: 'chat-conv',
          timestamp: '2026-04-14T10:01:00.000Z',
        },
      ];
      const { useChatStore } = await loadChatStore();
      const originalConversation = {
        ...createConversation('chat-conv', ''),
        last_message: 'Existing answer',
        message_count: 2,
        updated_at: '2026-04-14T10:01:00.000Z',
      };
      useChatStore.setState(createIdleChatStoreState({
        conversations: [originalConversation],
        messages: [
          { id: 'replay-user', task_id: '', conversation_id: 'chat-conv', role: 'user', content: 'Original request', timestamp: '2026-04-14T10:00:00.000Z' },
          { id: 'replay-assistant', task_id: '', conversation_id: 'chat-conv', role: 'assistant', content: 'Existing answer', timestamp: '2026-04-14T10:01:00.000Z' },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        agentCodeCheckpointsByConversationId: { 'chat-conv': [] },
        sessionCompactionEventsByConversationId: { 'chat-conv': [] },
      }));

      await useChatStore.getState().editMessage('replay-user', 'Updated request', {
        skipAgentCodeReplayCheck: true,
      });

      expect(dbRestoreConversationReplayMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'chat-conv' }),
      );
      expect(useChatStore.getState().getConversationMessages('chat-conv')).toEqual([
        expect.objectContaining({ id: 'replay-user', content: 'Original request' }),
        expect.objectContaining({ id: 'replay-assistant', content: 'Existing answer' }),
      ]);
      expect(context.citationRecords).toContainEqual(expect.objectContaining({ id: 'citation-tail' }));
      expect(useChatStore.getState().conversations).toContainEqual(originalConversation);
    });

    it('immediately restores a launched replay when the provider fails before its first token', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as { onError?: (error: Error) => void };
        options.onError?.(new Error('injected provider failure before first token'));
        return { usage: null };
      }) as unknown as typeof streamChatMock);
      context.citationRecords = [
        {
          id: 'citation-tail',
          type: 'file',
          scope: 'context',
          source: 'tail.md',
          title: 'Tail',
          messageId: 'replay-assistant',
          conversationId: 'chat-conv',
          timestamp: '2026-04-14T10:01:00.000Z',
        },
      ];
      const { useChatStore } = await loadChatStore();
      const originalConversation = {
        ...createConversation('chat-conv', ''),
        last_message: 'Existing answer',
        message_count: 2,
        updated_at: '2026-04-14T10:01:00.000Z',
      };
      const originalCheckpoints: AgentCodeCheckpoint[] = [];
      const originalCompactionEvents: CompactionPass[] = [];
      useChatStore.setState(createIdleChatStoreState({
        conversations: [originalConversation],
        messages: [
          { id: 'replay-user', task_id: '', conversation_id: 'chat-conv', role: 'user', content: 'Original request', timestamp: '2026-04-14T10:00:00.000Z' },
          { id: 'replay-assistant', task_id: '', conversation_id: 'chat-conv', role: 'assistant', content: 'Existing answer', timestamp: '2026-04-14T10:01:00.000Z' },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        agentCodeCheckpointsByConversationId: { 'chat-conv': originalCheckpoints },
        sessionCompactionEventsByConversationId: { 'chat-conv': originalCompactionEvents },
      }));

      await useChatStore.getState().editMessage('replay-user', 'Updated request', {
        skipAgentCodeReplayCheck: true,
      });
      await flushAsyncWork();

      expect(dbMarkConversationReplayLaunchedMock).toHaveBeenCalledTimes(1);
      expect(dbRestoreConversationReplayMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'chat-conv' }),
      );
      expect(dbFinalizeConversationReplayMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().getConversationMessages('chat-conv')).toEqual([
        expect.objectContaining({ id: 'replay-user', content: 'Original request' }),
        expect.objectContaining({ id: 'replay-assistant', content: 'Existing answer' }),
      ]);
      expect(useChatStore.getState().conversations).toContainEqual(originalConversation);
      expect(useChatStore.getState().agentCodeCheckpointsByConversationId['chat-conv']).toBe(
        originalCheckpoints,
      );
      expect(useChatStore.getState().sessionCompactionEventsByConversationId['chat-conv']).toBe(
        originalCompactionEvents,
      );
      expect(context.citationRecords).toContainEqual(expect.objectContaining({ id: 'citation-tail' }));
    });

    it('restores only the replay conversation when another conversation changes before provider failure', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      const providerFailure = createDeferred<void>();
      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as { onError?: (error: Error) => void };
        await providerFailure.promise;
        options.onError?.(new Error('injected provider failure after another conversation changed'));
        return { usage: null };
      }) as unknown as typeof streamChatMock);
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [
          { ...createConversation('chat-replay', ''), message_count: 2, last_message: 'Existing answer' },
          { ...createConversation('chat-other', ''), message_count: 1, last_message: 'Before replay recovery' },
        ],
        messages: [
          { id: 'replay-user', task_id: '', conversation_id: 'chat-replay', role: 'user', content: 'Original request', timestamp: '2026-04-14T10:00:00.000Z' },
          { id: 'replay-assistant', task_id: '', conversation_id: 'chat-replay', role: 'assistant', content: 'Existing answer', timestamp: '2026-04-14T10:01:00.000Z' },
          { id: 'other-user', task_id: '', conversation_id: 'chat-other', role: 'user', content: 'Before replay recovery', timestamp: '2026-04-14T10:02:00.000Z' },
        ],
        selectedConversationId: 'chat-replay',
        selectedConversationIdsByMode: { Chat: 'chat-replay' },
        agentCodeCheckpointsByConversationId: { 'chat-replay': [], 'chat-other': [] },
        sessionCompactionEventsByConversationId: { 'chat-replay': [], 'chat-other': [] },
      }));

      await useChatStore.getState().editMessage('replay-user', 'Updated request', {
        skipAgentCodeReplayCheck: true,
      });
      await flushAsyncWork();
      useChatStore.getState().addMessage({
        id: 'other-assistant',
        task_id: '',
        conversation_id: 'chat-other',
        role: 'assistant',
        content: 'Concurrent message must survive.',
        timestamp: '2026-04-14T10:03:00.000Z',
      });
      providerFailure.resolve();
      await flushAsyncWork();

      expect(useChatStore.getState().getConversationMessages('chat-replay')).toEqual([
        expect.objectContaining({ id: 'replay-user', content: 'Original request' }),
        expect.objectContaining({ id: 'replay-assistant', content: 'Existing answer' }),
      ]);
      expect(useChatStore.getState().getConversationMessages('chat-other')).toEqual([
        expect.objectContaining({ id: 'other-user' }),
        expect.objectContaining({ id: 'other-assistant', content: 'Concurrent message must survive.' }),
      ]);
      expect(
        useChatStore.getState().conversations.find((conversation: Conversation) => conversation.id === 'chat-other'),
      ).toMatchObject({ message_count: 2, last_message: 'Concurrent message must survive.' });
    });

    it('immediately restores a launched replay when it is aborted before its first token', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      streamChatMock.mockImplementationOnce((async (...args: unknown[]) => {
        const options = (args[0] ?? {}) as { signal?: AbortSignal };
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { usage: null };
      }) as unknown as typeof streamChatMock);
      context.citationRecords = [
        {
          id: 'citation-tail',
          type: 'file',
          scope: 'context',
          source: 'tail.md',
          title: 'Tail',
          messageId: 'replay-assistant',
          conversationId: 'chat-conv',
          timestamp: '2026-04-14T10:01:00.000Z',
        },
      ];
      const { useChatStore } = await loadChatStore();
      const originalConversation = {
        ...createConversation('chat-conv', ''),
        last_message: 'Existing answer',
        message_count: 2,
        updated_at: '2026-04-14T10:01:00.000Z',
      };
      useChatStore.setState(createIdleChatStoreState({
        conversations: [originalConversation],
        messages: [
          { id: 'replay-user', task_id: '', conversation_id: 'chat-conv', role: 'user', content: 'Original request', timestamp: '2026-04-14T10:00:00.000Z' },
          { id: 'replay-assistant', task_id: '', conversation_id: 'chat-conv', role: 'assistant', content: 'Existing answer', timestamp: '2026-04-14T10:01:00.000Z' },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        agentCodeCheckpointsByConversationId: { 'chat-conv': [] },
        sessionCompactionEventsByConversationId: { 'chat-conv': [] },
      }));

      await useChatStore.getState().editMessage('replay-user', 'Updated request', {
        skipAgentCodeReplayCheck: true,
      });
      await flushAsyncWork();
      useChatStore.getState().stopConversationStream('chat-conv');
      await flushAsyncWork();

      expect(dbMarkConversationReplayLaunchedMock).toHaveBeenCalledTimes(1);
      expect(dbRestoreConversationReplayMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'chat-conv' }),
      );
      expect(useChatStore.getState().getConversationMessages('chat-conv')).toEqual([
        expect.objectContaining({ id: 'replay-user', content: 'Original request' }),
        expect.objectContaining({ id: 'replay-assistant', content: 'Existing answer' }),
      ]);
      expect(useChatStore.getState().conversations).toContainEqual(originalConversation);
      expect(context.citationRecords).toContainEqual(expect.objectContaining({ id: 'citation-tail' }));
    });

    it('does not start the provider when durable replay completion fails', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';
      dbCompleteConversationReplayMock.mockImplementationOnce(async () => {
        throw new Error('injected replay completion failure');
      });
      context.citationRecords = [
        {
          id: 'citation-tail',
          type: 'file',
          scope: 'context',
          source: 'tail.md',
          title: 'Tail',
          messageId: 'replay-assistant',
          conversationId: 'chat-conv',
          timestamp: '2026-04-14T10:01:00.000Z',
        },
      ];
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        messages: [
          { id: 'replay-user', task_id: '', conversation_id: 'chat-conv', role: 'user', content: 'Original request', timestamp: '2026-04-14T10:00:00.000Z' },
          { id: 'replay-assistant', task_id: '', conversation_id: 'chat-conv', role: 'assistant', content: 'Existing answer', timestamp: '2026-04-14T10:01:00.000Z' },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        agentCodeCheckpointsByConversationId: { 'chat-conv': [] },
        sessionCompactionEventsByConversationId: { 'chat-conv': [] },
      }));

      await useChatStore.getState().editMessage('replay-user', 'Updated request', {
        skipAgentCodeReplayCheck: true,
      });

      expect(createMessageMock).not.toHaveBeenCalled();
      expect(streamChatMock).not.toHaveBeenCalled();
      expect(dbMarkConversationReplayLaunchedMock).not.toHaveBeenCalled();
      expect(dbRestoreConversationReplayMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'chat-conv' }),
      );
      expect(useChatStore.getState().getConversationMessages('chat-conv')).toEqual([
        expect.objectContaining({ id: 'replay-user', content: 'Original request' }),
        expect.objectContaining({ id: 'replay-assistant', content: 'Existing answer' }),
      ]);
      expect(context.citationRecords).toContainEqual(expect.objectContaining({ id: 'citation-tail' }));
    });

    it('blocks direct edits that would rewind agent code checkpoints without confirmation', async () => {
      context.tauriAvailable = false;
      appState.mode = 'Chat';

      const checkpoint: AgentCodeCheckpoint = {
        id: 'checkpoint-1',
        conversationId: 'chat-conv',
        assistantMessageId: 'assistant-after',
        toolCallId: 'call-write',
        toolName: 'write',
        sequence: 1,
        createdAt: '2026-05-11T10:00:00.000Z',
        files: [
          {
            path: 'src/new-file.ts',
            realPath: '/repo/src/new-file.ts',
            status: 'created',
            before: { exists: false, content: null },
            after: { exists: true, content: 'export const value = 1;\n' },
          },
        ],
      };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [
          {
            id: 'user-before-code',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'user',
            content: 'Change the code',
            timestamp: '2026-05-11T09:59:00.000Z',
          },
          {
            id: 'assistant-after',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'assistant',
            content: 'Done.',
            timestamp: '2026-05-11T10:00:00.000Z',
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        agentCodeCheckpointsByConversationId: {
          'chat-conv': [checkpoint],
        },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
      });

      await useChatStore
        .getState()
        .editMessage('user-before-code', 'Change the code again');

      expect(updateMessageMock).not.toHaveBeenCalled();
      expect(deleteMessagesAfterMock).not.toHaveBeenCalled();
      expect(streamChatMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().lastError).toContain(
        'confirm the code checkpoint restore',
      );
    });

    it('submits legacy quick-reply questionnaires without fabricating a function call output', async () => {
      appState.mode = 'Chat';

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [
          {
            id: 'assistant-questionnaire',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'assistant',
            content: 'Need one decision.',
            timestamp: '2026-04-14T10:00:00.000Z',
            questionnaire: {
              intro: 'Need one decision.',
              source: 'legacy_quick_replies',
              questions: [
                {
                  id: 'scope',
                  prompt: 'Which scope should I use?',
                  choices: ['Minimal', 'Balanced', 'Large'],
                },
              ],
            },
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
      });

      useChatStore
        .getState()
        .recordActiveQuestionnaireAnswer('chat-conv', 'Balanced');

      await useChatStore.getState().submitActiveQuestionnaire('chat-conv');

      const userMessage = useChatStore
        .getState()
        .getConversationMessages('chat-conv')
        .filter((message: { role: string }) => message.role === 'user')
        .at(-1);

      expect(userMessage?.questionnaire_response_summary).toEqual({
        assistantMessageId: 'assistant-questionnaire',
        source: 'legacy_quick_replies',
        items: [
          {
            id: 'scope',
            prompt: 'Which scope should I use?',
            answer: 'Balanced',
          },
        ],
      });
      expect(userMessage?.provider_input_items).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Which scope should I use?: Balanced',
            },
          ],
        },
      ]);
    });

    it('keeps edited legacy questionnaire responses free of function_call_output items', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Chat';

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [
          {
            id: 'assistant-questionnaire',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'assistant',
            content: 'Need one decision.',
            timestamp: '2026-04-14T10:00:00.000Z',
            questionnaire: {
              intro: 'Need one decision.',
              source: 'legacy_quick_replies',
              questions: [
                {
                  id: 'scope',
                  prompt: 'Which scope should I use?',
                  choices: ['Minimal', 'Balanced', 'Large'],
                },
              ],
            },
          },
          {
            id: 'user-questionnaire',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'user',
            content: 'Which scope should I use?: Balanced',
            timestamp: '2026-04-14T10:01:00.000Z',
            questionnaire_response_summary: {
              assistantMessageId: 'assistant-questionnaire',
              source: 'legacy_quick_replies',
              items: [
                {
                  id: 'scope',
                  prompt: 'Which scope should I use?',
                  answer: 'Balanced',
                },
              ],
            },
            provider_input_items: [
              {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: 'Which scope should I use?: Balanced',
                  },
                ],
              },
            ],
          },
          {
            id: 'assistant-after',
            task_id: '',
            conversation_id: 'chat-conv',
            role: 'assistant',
            content: 'Thanks, I can continue.',
            timestamp: '2026-04-14T10:02:00.000Z',
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
      });

      expect(
        useChatStore.getState().startQuestionnaireResponseEdit('user-questionnaire'),
      ).toBe(true);
      useChatStore
        .getState()
        .recordActiveQuestionnaireAnswer('chat-conv', 'Large');
      expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
        mode: 'editing_response',
        responseMessageId: 'user-questionnaire',
        currentStepIndex: 0,
        answersByStepId: {
          scope: 'Large',
        },
      });

      await useChatStore.getState().submitActiveQuestionnaire('chat-conv');
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const updatedUserMessage = useChatStore
        .getState()
        .getConversationMessages('chat-conv')
        .find((message: { id: string }) => message.id === 'user-questionnaire');

      expect(updatedUserMessage?.provider_input_items).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Which scope should I use?: Large',
            },
          ],
        },
      ]);
      expect(updateMessageMock).toHaveBeenCalledWith(
        'user-questionnaire',
        'Which scope should I use?: Large',
        expect.objectContaining({
          providerInputItems: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'Which scope should I use?: Large',
                },
              ],
            },
          ],
        }),
      );
    });

  });
};
