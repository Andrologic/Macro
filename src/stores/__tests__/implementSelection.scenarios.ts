import { describe, expect, it } from 'bun:test';
import type { Conversation } from '../../types';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerImplementSelectionScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    appState,
    createConversation,
    createImplementTask,
    createManualFeatureTask,
    getLocalProjectContextStateMock,
    gitBranchListMock,
    loadChatStore,
    providerState,
    queueSendChatNonStreamingImplementation,
    savePreferenceForTest,
    sendChatNonStreamingMock,
    streamChatMock,
    taskStoreState,
    updateConversationDetailsMock,
    updateConversationScopeMock,
  } = context;

  describe('useChatStore Implement selection and manual features', () => {
    it('reuses the same implement conversation for the selected task', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [createImplementTask()];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-latest'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
            updated_at: '2026-03-19T00:05:00.000Z',
          },
          {
            ...createConversation('implement-older'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
            updated_at: '2026-03-19T00:01:00.000Z',
          },
        ],
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

      const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();
      const conversation = await useChatStore.getState().createConversation('New Conversation', null, null);

      expect(ensuredId).toBe('implement-latest');
      expect(conversation.id).toBe('implement-latest');
      expect(useChatStore.getState().conversations).toHaveLength(2);
      expect(useChatStore.getState().selectedConversationId).toBe('implement-latest');
      expect(useChatStore.getState().selectedConversationIdsByMode.Implement).toBe('implement-latest');
    });

    it('keeps an explicitly selected task outside the header project scope', async () => {
      appState.mode = 'Implement';
      appState.selectedProjectId = 'project-1';
      appState.selectedTaskId = 'task-b';
      taskStoreState.tasks = [createImplementTask({
        id: 'task-b',
        title: 'Implement project B',
        project_id: 'project-2',
        project_ids: ['project-2'],
      })];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({ conversations: [], selectedConversationId: null });
      const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();
      const conversation = useChatStore.getState().conversations.find(
        (candidate: Conversation) => candidate.id === ensuredId,
      );

      expect(appState.selectedTaskId).toBe('task-b');
      expect(conversation).toMatchObject({
        task_id: 'task-b',
        project_id: 'project-2',
      });
    });

    it('keeps an archived selected task readable without replacing its conversation', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-archived';
      taskStoreState.tasks = [createImplementTask({
        id: 'task-archived',
        archived_at: '2026-08-14T10:00:00.000Z',
      })];
      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [{
          ...createConversation('archived-conversation'),
          scope_mode: 'Implement',
          task_id: 'task-archived',
        }],
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
      });

      expect(await useChatStore.getState().ensureConversationForCurrentMode()).toBe(
        'archived-conversation',
      );
      expect(appState.selectedTaskId).toBe('task-archived');
    });

    it('restores an implement task from local project context before selecting its conversation', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = null;
      taskStoreState.tasks = [
        createImplementTask({ id: 'task-1', status: 'Pending' }),
        createImplementTask({
          id: 'task-2',
          title: 'Implement search',
          status: 'InProgress',
          sequence_index: 1,
        }),
      ];
      getLocalProjectContextStateMock.mockImplementationOnce(async () => ({
        architectConversationId: null,
        implementConversationId: 'implement-task-1',
        lastTaskId: 'task-1',
      }));

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-task-1'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
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

      const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();

      expect(appState.selectedTaskId as string | null).toBe('task-1');
      expect(ensuredId).toBe('implement-task-1');
      expect(useChatStore.getState().selectedConversationId).toBe('implement-task-1');
    });

    it('restores an in-progress implement task when no local task context exists', async () => {
      const originalNow = Date.now;
      Date.now = () => 1773930000000;

      try {
        appState.mode = 'Implement';
        appState.selectedTaskId = null;
        taskStoreState.tasks = [
          createImplementTask({ id: 'task-pending', status: 'Pending', sequence_index: 0 }),
          createImplementTask({
            id: 'task-active',
            title: 'Implement active task',
            status: 'InProgress',
            sequence_index: 1,
          }),
        ];
        getLocalProjectContextStateMock.mockImplementationOnce(async () => ({
          architectConversationId: null,
          implementConversationId: null,
          lastTaskId: null,
        }));

        const { useChatStore } = await loadChatStore();
        useChatStore.setState({
          conversations: [],
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

        const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();
        const conversation = useChatStore
          .getState()
          .conversations.find((candidate: Conversation) => candidate.id === ensuredId);

        expect(appState.selectedTaskId as string | null).toBe('task-active');
        expect(conversation?.task_id).toBe('task-active');
        expect(conversation?.title).toBe('Task - Implement active task');
      } finally {
        Date.now = originalNow;
      }
    });

    it('clears implement selection and does not create a conversation when no task is eligible for the current scope', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = null;
      taskStoreState.tasks = [
        createImplementTask({
          id: 'task-outside-scope',
          project_id: 'project-elsewhere',
          project_ids: ['project-elsewhere'],
        }),
      ];
      getLocalProjectContextStateMock.mockImplementationOnce(async () => ({
        architectConversationId: null,
        implementConversationId: null,
        lastTaskId: 'task-outside-scope',
      }));

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [],
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

      const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();

      expect(ensuredId).toBeNull();
      expect(appState.selectedTaskId).toBeNull();
      expect(useChatStore.getState().selectedConversationId).toBeNull();
      expect(useChatStore.getState().selectedConversationIdsByMode.Implement ?? null).toBeNull();
      expect(useChatStore.getState().conversations).toHaveLength(0);
      expect(
        useChatStore
          .getState()
          .conversations.some((conversation: Conversation) => Boolean(conversation.task_id))
      ).toBe(false);
    });

    it('clears a previously selected taskless implement conversation when no tasks are available', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = null;
      taskStoreState.tasks = [];
      getLocalProjectContextStateMock.mockImplementationOnce(async () => ({
        architectConversationId: null,
        implementConversationId: 'debug-conv',
        lastTaskId: null,
      }));

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('debug-conv'),
            scope_mode: 'Implement',
            task_id: null,
            title: 'Repository review',
          },
        ],
        messages: [],
        selectedConversationId: 'debug-conv',
        selectedConversationIdsByMode: { Implement: 'debug-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();

      expect(ensuredId).toBeNull();
      expect(useChatStore.getState().selectedConversationId).toBeNull();
      expect(useChatStore.getState().selectedConversationIdsByMode.Implement).toBeNull();
      expect(useChatStore.getState().conversations).toHaveLength(1);
    });

    it('syncs the selected task when an existing implement conversation is restored', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = null;
      taskStoreState.tasks = [createImplementTask({ id: 'task-1' })];
      getLocalProjectContextStateMock.mockImplementationOnce(async () => ({
        architectConversationId: null,
        implementConversationId: 'implement-conv',
        lastTaskId: null,
      }));

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
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();

      expect(ensuredId).toBe('implement-conv');
      expect(appState.selectedTaskId as string | null).toBe('task-1');
      expect(useChatStore.getState().selectedConversationId).toBe('implement-conv');
    });

    it('creates a task-scoped implement conversation when none exists yet', async () => {
      const originalNow = Date.now;
      Date.now = () => 1773910000000;

      try {
        appState.mode = 'Implement';
        appState.selectedTaskId = 'task-1';
        taskStoreState.tasks = [createImplementTask()];

        const { useChatStore } = await loadChatStore();
        useChatStore.setState({
          conversations: [],
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

        const conversation = await useChatStore.getState().createConversation('New Conversation', null, null);

        expect(conversation.id).toMatch(/^conv-conversation-session-1773910000000-/);
        expect(conversation.task_id).toBe('task-1');
        expect(conversation.project_id).toBe('project-1');
        expect(conversation.title).toBe('Task - Implement checkout');
        expect(useChatStore.getState().selectedConversationId).toBe(conversation.id);
        expect(useChatStore.getState().selectedConversationIdsByMode.Implement).toBe(conversation.id);
      } finally {
        Date.now = originalNow;
      }
    });

    it('keeps new chat conversations detached from task and project context', async () => {
      appState.mode = 'Chat';
      appState.selectedGroupId = 'group-1';
      appState.selectedProjectId = 'project-1';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [createImplementTask()];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [],
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

      const conversation = await useChatStore.getState().createConversation(
        'New Conversation',
        'task-1',
        'project-1',
        'group-1'
      );

      expect(conversation.task_id).toBeNull();
      expect(conversation.project_id).toBeNull();
      expect(conversation.group_id).toBeNull();
      expect(useChatStore.getState().selectedConversationIdsByMode.Chat).toBe(conversation.id);
    });

    it('updates the durable workspace scope of a chat conversation', async () => {
      appState.mode = 'Chat';
      context.tauriAvailable = true;
      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-1'),
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
          },
        ],
        selectedConversationId: 'chat-1',
        selectedConversationIdsByMode: { Chat: 'chat-1' },
        conversationRuntimeById: {},
      });

      await useChatStore.getState().setChatConversationWorkspace('chat-1', {
        groupId: 'group-1',
        projectId: 'project-1',
      });

      const conversation = useChatStore.getState().conversations[0];
      expect(conversation?.group_id).toBe('group-1');
      expect(conversation?.project_id).toBe('project-1');
      expect(updateConversationScopeMock).toHaveBeenCalledWith({
        id: 'chat-1',
        scopeMode: 'Chat',
        taskId: null,
        groupId: 'group-1',
        projectId: 'project-1',
      });
    });

    it('recreates a fresh implement conversation after deleting the previous one', async () => {
      const originalNow = Date.now;
      Date.now = () => 1773920000000;

      try {
        appState.mode = 'Implement';
        appState.selectedTaskId = 'task-1';
        taskStoreState.tasks = [createImplementTask()];

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
          lastError: null,
          abortController: null,
          messageImagesByMessageId: {},
          composerContextRefs: [],
        });

        await useChatStore.getState().deleteConversation('implement-conv', { mode: 'implement' });

        expect(useChatStore.getState().selectedConversationId).toBeNull();
        expect(useChatStore.getState().selectedConversationIdsByMode.Implement).toBeNull();

        const recreatedId = await useChatStore.getState().ensureConversationForCurrentMode();

        expect(recreatedId).toMatch(/^conv-conversation-session-1773920000000-/);
        expect(useChatStore.getState().conversations).toHaveLength(1);
        expect(useChatStore.getState().conversations[0]?.task_id).toBe('task-1');
        expect(useChatStore.getState().selectedConversationId).toBe(recreatedId);
        expect(useChatStore.getState().selectedConversationIdsByMode.Implement).toBe(recreatedId);
      } finally {
        Date.now = originalNow;
      }
    });

    it('finalizes a manual feature draft before the first assistant response', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [createManualFeatureTask({ task_kind: 'bugfix' })];
      providerState.providerConfigs = [
        ...providerState.providerConfigs,
        {
          id: 'provider-2',
          name: 'Metadata Provider',
          providerType: 'openai',
          isEnabled: true,
          isLocal: true,
          hasStoredApiKey: false,
          apiKeyLoaded: true,
          apiKey: '',
        },
      ];
      providerState.modelsByProvider = {
        ...providerState.modelsByProvider,
        'provider-2': [{ id: 'metadata-model', name: 'Metadata Model', isEnabled: true }],
      };
      await savePreferenceForTest('metadataModelConfig', {
        mode: 'dedicated',
        providerId: 'provider-2',
        modelId: 'metadata-model',
        reasoningEffort: null,
      });

      queueSendChatNonStreamingImplementation(async () =>
        JSON.stringify({
          title: 'Quick export',
          description: 'Add a quick CSV export from the table.',
          featureSlug: 'quick-export',
          taskKind: 'feature',
        })
      );

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
            title: 'New feature',
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
        content: 'Ajoute un export CSV rapide depuis le tableau.',
        taskId: 'manual-task-1',
      });

      expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
      expect(sendChatNonStreamingMock.mock.calls[0]?.[0]).toMatchObject({
        providerId: 'provider-2',
        modelId: 'metadata-model',
      });
      expect(taskStoreState.finalizeManualFeatureDraft).toHaveBeenCalledWith({
        taskId: 'manual-task-1',
        conversationId: 'manual-conv',
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
        featureSlug: 'quick-export',
        taskKind: 'bugfix',
      });
      expect(taskStoreState.startTask).toHaveBeenCalledWith('manual-task-1');
      expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
        draft: false,
        status: 'InProgress',
        feature_slug: 'quick-export',
        task_kind: 'bugfix',
        branch_name: 'bugfix/quick-export',
      });
      expect(
        useChatStore.getState().conversations.find((conversation: Conversation) => conversation.id === 'manual-conv')
      ).toMatchObject({
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
      });
    });

    it('keeps a standalone manual feature initialized after assistant generation fails, then retries as an in-progress task', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [createManualFeatureTask()];

      queueSendChatNonStreamingImplementation(async () =>
        JSON.stringify({
          title: 'Quick export',
          description: 'Add a quick CSV export from the table.',
          featureSlug: 'quick-export',
          taskKind: 'feature',
        })
      );

      streamChatMock
        .mockImplementationOnce((async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as {
            onError?: (error: Error) => void;
          };
          options.onError?.(new Error('Assistant unavailable.'));
          return { usage: null };
        }) as unknown as typeof streamChatMock)
        .mockImplementationOnce((async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as {
            onComplete?: (result: {
              visibleContent: string;
              toolTraces: unknown[];
              hiddenContext?: string;
              usage: null;
            }) => void;
          };
          options.onComplete?.({
            visibleContent: 'C’est reparti.',
            toolTraces: [],
            hiddenContext: undefined,
            usage: null,
          });
          return { usage: null };
        }) as unknown as typeof streamChatMock);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
            title: 'New feature',
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
        content: 'Ajoute un export CSV rapide depuis le tableau.',
        taskId: 'manual-task-1',
      });

      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();

      expect(taskStoreState.revertManualFeatureToDraft).not.toHaveBeenCalled();
      expect(taskStoreState.markTaskFailed).toHaveBeenCalledWith('manual-task-1');
      expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
        draft: false,
        status: 'Failed',
        feature_slug: 'quick-export',
        branch_name: 'feature/quick-export',
      });
      expect(
        useChatStore.getState().conversations.find((conversation: Conversation) => conversation.id === 'manual-conv')
      ).toMatchObject({
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
      });

      const firstUserMessage = useChatStore
        .getState()
        .getConversationMessages('manual-conv')
        .find((message: { role: string }) => message.role === 'user');
      expect(firstUserMessage).toBeDefined();

      await useChatStore.getState().editMessage(
        (firstUserMessage as { id: string }).id,
        (firstUserMessage as { content: string }).content,
      );

      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();

      expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
      expect(taskStoreState.retryTask).toHaveBeenCalledWith('manual-task-1');
      expect(taskStoreState.finalizeManualFeatureDraft).toHaveBeenLastCalledWith({
        taskId: 'manual-task-1',
        conversationId: 'manual-conv',
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
        featureSlug: 'quick-export',
        taskKind: 'feature',
      });
      expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
        draft: false,
        status: 'InProgress',
        feature_slug: 'quick-export',
        branch_name: 'feature/quick-export',
      });
      expect(
        useChatStore.getState().conversations.find((conversation: Conversation) => conversation.id === 'manual-conv')
      ).toMatchObject({
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
      });
    });

    it('rolls a standalone manual feature back to draft when initialization fails before the assistant stream starts', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [createManualFeatureTask()];

      queueSendChatNonStreamingImplementation(async () =>
        JSON.stringify({
          title: 'Quick export',
          description: 'Add a quick CSV export from the table.',
          featureSlug: 'quick-export',
          taskKind: 'feature',
        })
      );
      taskStoreState.startTask.mockImplementationOnce(async () => {
        throw new Error('Worktree could not be prepared.');
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
            title: 'New feature',
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

      let thrown: unknown = null;
      try {
        await useChatStore.getState().sendMessage({
          conversationId: 'manual-conv',
          content: 'Ajoute un export CSV rapide depuis le tableau.',
          taskId: 'manual-task-1',
        });
      } catch (error) {
        thrown = error;
      }

      expect((thrown as { message?: string } | null)?.message).toBe(
        'Worktree could not be prepared.'
      );
      expect(streamChatMock).not.toHaveBeenCalled();
      expect(taskStoreState.finalizeManualFeatureDraft).toHaveBeenCalledWith({
        taskId: 'manual-task-1',
        conversationId: 'manual-conv',
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
        featureSlug: 'quick-export',
        taskKind: 'feature',
      });
      expect(taskStoreState.revertManualFeatureToDraft).toHaveBeenCalledWith({
        taskId: 'manual-task-1',
        conversationId: 'manual-conv',
        title: 'New feature',
        description: '',
      });
      expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
        draft: true,
        status: 'Pending',
        feature_slug: null,
        branch_name: '',
      });
    });

    it('deletes the linked manual feature draft when deleting its empty implement conversation', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [createManualFeatureTask()];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
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

      await useChatStore.getState().deleteConversation('manual-conv', { mode: 'implement' });

      expect(taskStoreState.deleteManualFeatureDraft).toHaveBeenCalledWith('manual-task-1');
      expect(useChatStore.getState().conversations).toHaveLength(0);
      expect(taskStoreState.tasks).toHaveLength(0);
    });

    it('requests a different manual feature slug when the first branch name is already taken', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      taskStoreState.tasks = [createManualFeatureTask()];
      context.gitBranchesByRepo = {
        '/repos/web': {
          local: [{ name: 'bugfix/quick-export', is_head: false, commit: 'abc123' }],
          remote: [],
          current: 'develop',
        },
      };

      queueSendChatNonStreamingImplementation(async () =>
        JSON.stringify({
          title: 'Quick export',
          description: 'Add a quick CSV export from the table.',
          featureSlug: 'quick-export',
          taskKind: 'bugfix',
        })
      );
      queueSendChatNonStreamingImplementation(async () =>
        JSON.stringify({
          title: 'Quick export',
          description: 'Add a quick CSV export from the table.',
          featureSlug: 'quick-export-fast',
          taskKind: 'bugfix',
        })
      );

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('manual-conv'),
            scope_mode: 'Implement',
            task_id: 'manual-task-1',
            title: 'New feature',
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
        content: 'Ajoute un export CSV rapide depuis le tableau.',
        taskId: 'manual-task-1',
      });

      expect(gitBranchListMock).toHaveBeenCalledWith('/repos/web');
      expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(2);
      expect(taskStoreState.finalizeManualFeatureDraft).toHaveBeenCalledWith({
        taskId: 'manual-task-1',
        conversationId: 'manual-conv',
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
        featureSlug: 'quick-export-fast',
        taskKind: 'bugfix',
      });
      expect(taskStoreState.getTaskById('manual-task-1')).toMatchObject({
        task_kind: 'bugfix',
        branch_name: 'bugfix/quick-export-fast',
      });
      expect(updateConversationDetailsMock).toHaveBeenCalledWith({
        id: 'manual-conv',
        title: 'Quick export',
        description: 'Add a quick CSV export from the table.',
      });
    });

    it('keeps an implement task in progress when the assistant reply has no quick replies', async () => {
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
          visibleContent: 'Implementation ready.',
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

  });
};
