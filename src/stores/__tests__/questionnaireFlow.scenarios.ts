import { describe, expect, it } from 'bun:test';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerQuestionnaireFlowScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    appState,
    createConversation,
    createManualFeatureTask,
    emitTaskStoreUpdate,
    loadChatStore,
    streamChatMock,
    taskStoreState,
  } = context;

  describe('useChatStore questionnaire flow', () => {
    it('moves an implement task to awaiting response when the assistant reply contains valid quick replies', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [
        createManualFeatureTask({
          draft: false,
          title: 'Quick export',
          status: 'Pending',
          feature_slug: 'quick-export',
          assigned_branch: 'feature/quick-export',
          branch_name: 'feature/quick-export',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
            title: 'Quick export',
          },
        ],
        messages: [],
        selectedConversationId: 'manual-conv',
        selectedConversationIdsByMode: { Implement: 'manual-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'manual-conv',
        content: 'Implémente l’export CSV.',
        taskId: 'manual-task-1',
      });
      const onComplete = (((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0]) as {
        onComplete?: (result: {
          visibleContent: string;
          toolTraces: unknown[];
          hiddenContext?: unknown;
          usage: null;
        }) => void;
      } | undefined)?.onComplete;
      onComplete?.({
        visibleContent: [
          'I need one blocking choice before I continue.',
          '',
          '[quick-replies]',
          '- Use CSV download only',
          '- Add CSV and TSV',
          '- Keep it behind a feature flag',
          '[/quick-replies]',
        ].join('\n'),
        toolTraces: [],
        hiddenContext: undefined,
        usage: null,
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(taskStoreState.startTask).toHaveBeenCalledWith('manual-task-1');
      expect(taskStoreState.markTaskAwaitingResponse).toHaveBeenCalledWith('manual-task-1');
      expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
        status: 'AwaitingResponse',
      });
    });

    it('returns an interruptive resolution for the question tool', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [
        createManualFeatureTask({
          draft: false,
          status: 'Pending',
          branch_name: 'feature/quick-export',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
            title: 'Quick export',
          },
        ],
        messages: [],
        selectedConversationId: 'manual-conv',
        selectedConversationIdsByMode: { Implement: 'manual-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'manual-conv',
        content: 'Continue.',
        taskId: 'manual-task-1',
      });

      const onToolCall = (((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0]) as {
        onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
      } | undefined)?.onToolCall;

      const result = await onToolCall?.('question', {
        intro: 'Need one blocking choice.',
        questions: [
          {
            id: 'scope',
            prompt: 'Which scope should I use?',
            choices: ['Minimal', 'Balanced', 'Large'],
          },
        ],
      });

      expect(result).toMatchObject({
        kind: 'interrupt',
        visibleContent: 'Need one blocking choice.',
      });
      expect(
        (result as { hiddenContext?: string } | undefined)?.hiddenContext,
      ).toContain('<questionnaire_context>');
    });

    it('moves an implement task to awaiting response when a question tool interrupt completes the assistant turn', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [
        createManualFeatureTask({
          draft: false,
          title: 'Quick export',
          status: 'InProgress',
          feature_slug: 'quick-export',
          assigned_branch: 'feature/quick-export',
          branch_name: 'feature/quick-export',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
            title: 'Quick export',
          },
        ],
        messages: [],
        selectedConversationId: 'manual-conv',
        selectedConversationIdsByMode: { Implement: 'manual-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'manual-conv',
        content: 'Continue.',
        taskId: 'manual-task-1',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? {}) as {
        onComplete?: (result: {
          visibleContent: string;
          toolTraces: unknown[];
          hiddenContext?: string;
          usage: null;
        }) => void;
        onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
      };

      const interruptResult = await streamOptions.onToolCall?.('question', {
        intro: 'Need one blocking choice.',
        questions: [
          {
            id: 'scope',
            prompt: 'Which scope should I use?',
            choices: ['Minimal', 'Balanced', 'Large'],
          },
        ],
      });

      streamOptions.onComplete?.({
        visibleContent:
          (interruptResult as { visibleContent?: string } | undefined)?.visibleContent ??
          'Need one blocking choice.',
        toolTraces: [],
        hiddenContext: (interruptResult as { hiddenContext?: string } | undefined)?.hiddenContext,
        usage: null,
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(taskStoreState.markTaskAwaitingResponse).toHaveBeenCalledWith('manual-task-1');
      expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
        status: 'AwaitingResponse',
      });
      expect(useChatStore.getState().getConversationRuntime('manual-conv').phase).toBe('idle');
    });

    it('moves an implement task to awaiting response when the assistant reply contains a structured questionnaire', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [
        createManualFeatureTask({
          draft: false,
          title: 'Quick export',
          status: 'Pending',
          feature_slug: 'quick-export',
          assigned_branch: 'feature/quick-export',
          branch_name: 'feature/quick-export',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
            title: 'Quick export',
          },
        ],
        messages: [],
        selectedConversationId: 'manual-conv',
        selectedConversationIdsByMode: { Implement: 'manual-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'manual-conv',
        content: 'Implémente l’export CSV.',
        taskId: 'manual-task-1',
      });
      const onComplete = (((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0]) as {
        onComplete?: (result: {
          visibleContent: string;
          toolTraces: unknown[];
          hiddenContext?: unknown;
          usage: null;
        }) => void;
      } | undefined)?.onComplete;
      onComplete?.({
        visibleContent: 'Need one blocking choice.',
        toolTraces: [],
        hiddenContext:
          '<questionnaire_context>\n' +
          '{"intro":"Need one blocking choice.","questions":[{"id":"scope","prompt":"Which scope should I use?","choices":["Minimal","Balanced","Large"]}]}\n' +
          '</questionnaire_context>',
        usage: null,
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(taskStoreState.markTaskAwaitingResponse).toHaveBeenCalledWith('manual-task-1');
      expect(
        useChatStore
          .getState()
          .getConversationMessages('manual-conv')
          .find((message: { role: string }) => message.role === 'assistant')?.questionnaire?.questions
          .length
      ).toBe(1);
    });

    it('reconciles an unresolved questionnaire to AwaitingResponse only once while persistence is pending', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [
        createManualFeatureTask({
          draft: false,
          title: 'Quick export',
          status: 'InProgress',
          feature_slug: 'quick-export',
          assigned_branch: 'feature/quick-export',
          branch_name: 'feature/quick-export',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
            title: 'Quick export',
          },
        ],
        messages: [
          {
            id: 'assistant-questionnaire',
            task_id: 'manual-task-1',
            conversation_id: 'manual-conv',
            role: 'assistant',
            content: 'Need one blocking choice.',
            timestamp: '2026-04-14T10:00:00.000Z',
            questionnaire: {
              intro: 'Need one blocking choice.',
              source: 'tool',
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
        selectedConversationId: 'manual-conv',
        selectedConversationIdsByMode: { Implement: 'manual-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
      });

      taskStoreState.markTaskAwaitingResponse.mockClear();
      let resolvePersistence: (() => void) | null = null;
      taskStoreState.markTaskAwaitingResponse.mockImplementationOnce(async (taskId: string) => {
        await new Promise<void>((resolve) => {
          resolvePersistence = resolve;
        });
        taskStoreState.tasks = taskStoreState.tasks.map((task) =>
          task.id === taskId ? { ...task, status: 'AwaitingResponse' } : task
        );
      });
      const previousTasks = taskStoreState.tasks;
      taskStoreState.tasks = taskStoreState.tasks.map((task) => ({ ...task }));
      emitTaskStoreUpdate(previousTasks);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(taskStoreState.markTaskAwaitingResponse).toHaveBeenCalledWith('manual-task-1');
      const tasksBeforeSecondRefresh = taskStoreState.tasks;
      taskStoreState.tasks = taskStoreState.tasks.map((task) => ({ ...task }));
      emitTaskStoreUpdate(tasksBeforeSecondRefresh);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(taskStoreState.markTaskAwaitingResponse).toHaveBeenCalledTimes(1);
      expect(resolvePersistence).toBeDefined();
      (resolvePersistence as unknown as () => void)();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
        status: 'AwaitingResponse',
      });
    });

    it('keeps an implement task in progress when the assistant reply has malformed quick replies', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [
        createManualFeatureTask({
          draft: false,
          title: 'Quick export',
          status: 'Pending',
          feature_slug: 'quick-export',
          assigned_branch: 'feature/quick-export',
          branch_name: 'feature/quick-export',
        }),
      ];

      const { streamChat } = await import('../../services/streamingChat');
      (
        streamChat as unknown as {
          mockImplementationOnce: (implementation: (options: {
            onComplete?: (result: {
              visibleContent: string;
              toolTraces: unknown[];
              hiddenContext?: unknown;
              usage: null;
            }) => void;
          }) => Promise<{ usage: null }>) => void;
        }
      ).mockImplementationOnce(async ({ onComplete }) => {
        onComplete?.({
          visibleContent: [
            'I still need clarification.',
            '',
            '[quick-replies]',
            '- Only one option',
            '[/quick-replies]',
          ].join('\n'),
          toolTraces: [],
          hiddenContext: undefined,
          usage: null,
        });
        return { usage: null };
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
            title: 'Quick export',
          },
        ],
        messages: [],
        selectedConversationId: 'manual-conv',
        selectedConversationIdsByMode: { Implement: 'manual-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'manual-conv',
        content: 'Implémente l’export CSV.',
        taskId: 'manual-task-1',
      });

      expect(taskStoreState.startTask).toHaveBeenCalledWith('manual-task-1');
      expect(taskStoreState.markTaskAwaitingResponse).not.toHaveBeenCalled();
      expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
        status: 'InProgress',
      });
    });

    it('tracks questionnaire progress locally, stores a structured summary, and resolves the question tool output on submit', async () => {
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

      const initialQuestionnaire = useChatStore
        .getState()
        .getActiveQuestionnaire('chat-conv');
      expect(initialQuestionnaire?.currentStep.id).toBe('scope');

      const firstStep = useChatStore
        .getState()
        .recordActiveQuestionnaireAnswer('chat-conv', 'Balanced');
      expect(firstStep?.completed).toBe(false);
      expect(
        useChatStore.getState().getActiveQuestionnaire('chat-conv')?.currentStep.id,
      ).toBe('risk');

      useChatStore
        .getState()
        .setActiveQuestionnaireDraftText('chat-conv', 'Stay below one day of rework');
      const secondStep = useChatStore
        .getState()
        .recordActiveQuestionnaireAnswer(
          'chat-conv',
          'Stay below one day of rework',
        );
      expect(secondStep?.completed).toBe(true);

      await useChatStore.getState().submitActiveQuestionnaire('chat-conv');

      const userMessages = useChatStore
        .getState()
        .getConversationMessages('chat-conv')
        .filter((message: { role: string }) => message.role === 'user');
      expect(userMessages.at(-1)?.content).toBe(
        'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
      );
      expect(userMessages.at(-1)?.questionnaire_response_summary).toEqual({
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
      });
      expect(userMessages.at(-1)?.provider_input_items).toEqual([
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
      ]);
      expect(
        useChatStore.getState().questionnaireDraftsByConversationId['chat-conv'],
      ).toBeUndefined();
    });

    it('reopens, cancels, and restores questionnaire response edits from the original summary', async () => {
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
      expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
        mode: 'editing_response',
        responseMessageId: 'user-questionnaire',
        currentStepIndex: 0,
        answersByStepId: {
          scope: 'Balanced',
          risk: 'Stay below one day of rework',
        },
      });

      useChatStore
        .getState()
        .recordActiveQuestionnaireAnswer('chat-conv', 'Large');
      useChatStore
        .getState()
        .setActiveQuestionnaireDraftText('chat-conv', 'Use two-day budget');
      useChatStore.getState().cancelQuestionnaireSession('chat-conv');

      expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toBeNull();

      expect(
        useChatStore.getState().startQuestionnaireResponseEdit('user-questionnaire'),
      ).toBe(true);
      expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
        mode: 'editing_response',
        currentStepIndex: 0,
        answersByStepId: {
          scope: 'Balanced',
          risk: 'Stay below one day of rework',
        },
        draftTextByStepId: {
          risk: 'Stay below one day of rework',
        },
      });
    });

    it('reopens questionnaire response edits from conversation-indexed messages after reload', async () => {
      appState.mode = 'Chat';

      const assistantMessage = {
        id: 'assistant-questionnaire',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'assistant' as const,
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
          source: 'tool' as const,
          questions: [
            {
              id: 'scope',
              prompt: 'Which scope should I use?',
              choices: ['Minimal', 'Balanced', 'Large'] as [string, string, string],
            },
            {
              id: 'risk',
              prompt: 'How risky can the change be?',
              choices: ['Safe', 'Moderate', 'Aggressive'] as [string, string, string],
              free_text_placeholder: 'Custom answer',
            },
          ],
        },
      };
      const responseMessage = {
        id: 'user-questionnaire',
        task_id: '',
        conversation_id: 'chat-conv',
        role: 'user' as const,
        content:
          'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
        timestamp: '2026-04-14T10:01:00.000Z',
        questionnaire_response_summary: {
          assistantMessageId: 'assistant-questionnaire',
          source: 'tool' as const,
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
      };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv', '')],
        messages: [],
        messagesByConversationId: {
          'chat-conv': [assistantMessage, responseMessage],
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
        questionnaireDraftsByConversationId: {},
        composerContextRefs: [],
      });

      expect(
        useChatStore.getState().startQuestionnaireResponseEdit('user-questionnaire'),
      ).toBe(true);
      expect(
        useChatStore.getState().questionnaireDraftsByConversationId['chat-conv'],
      ).toMatchObject({
        mode: 'editing_response',
        assistantMessageId: 'assistant-questionnaire',
        responseMessageId: 'user-questionnaire',
        currentStepIndex: 0,
        answersByStepId: {
          scope: 'Balanced',
          risk: 'Stay below one day of rework',
        },
        draftTextByStepId: {
          risk: 'Stay below one day of rework',
        },
      });
    });

  });
};
