import { describe, expect, it, mock } from 'bun:test';
import type { AppMode, ChatMessage, Conversation } from '../../types';
import type { ArchitectPlanRecord } from '../../services/architectPlanService';
import { createDeferred } from '../../test-utils/deferred';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerArchitectLifecycleScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    appSettingValues,
    appState,
    architectPlanConversationSyncRecords,
    architectPlanMessages,
    architectPlans,
    bindArchitectPlanConversationMock,
    createChatMessageRecord,
    createChatSnapshotConversation,
    createConversation,
    createConversationMock,
    createIdleChatStoreState,
    createMessageMock,
    createPlan,
    createScenarioPlan,
    createTranscriptEntry,
    dbGetArchitectPlanConversationSyncMock,
    dbRestoreConversationReplayMock,
    dbUpsertArchitectPlanConversationSyncMock,
    deleteConversationMock,
    deleteMessagesAfterMock,
    expectArchitectSelection,
    flushAsyncWork,
    getArchitectPlanActivationPayloadMock,
    getArchitectPlanChatTranscriptMock,
    getChatBootstrapSnapshotMock,
    getChatSnapshotMock,
    getLocalProjectContextStateMock,
    importMessagesMock,
    loadChatStore,
    providerState,
    registerUseChatStoreMocks,
    savePreferenceForTest,
    sendArchitectMessageAndGetToolHandler,
    sendChatNonStreamingMock,
    setArchitectStoreState,
    setSendChatNonStreamingImplementation,
    streamChatMock,
    syncArchitectPlanChatFromConversationMock,
    updateArchitectPlanMock,
    updateConversationDetailsMock,
    updateConversationScopeMock,
    useAppStoreMock,
  } = context;

  describe('useChatStore Architect lifecycle', () => {
    it('keeps strategy mutations isolated when the strategy guard loads before the plan service mocks', async () => {
      mock.restore();
      await import('../../services/architectStrategyMutationGuard');
      await registerUseChatStoreMocks();

      const plan = createPlan({
        id: 'plan-early-guard',
        slug: 'plan-early-guard',
        title: 'Plan Early Guard',
        conversationId: 'plan-conv',
        status: 'draft',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Generate the strategy.',
      });
      updateArchitectPlanMock.mockClear();

      await onToolCall('strategy_generate', {
        nodes: [{ title: 'Implement checkout' }],
      });

      expect(updateArchitectPlanMock).toHaveBeenCalledTimes(1);
      expect(
        ((updateArchitectPlanMock as unknown as {
          mock: { calls: Array<Array<Record<string, unknown>>> };
        }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>,
      ).toMatchObject({
        branchName: 'develop',
        planId: 'plan-early-guard',
      });
    });

    it('restores a plan transcript into an existing empty conversation', async () => {
      const plan = createPlan();
      architectPlans.set(plan.id, plan);
      architectPlanMessages.set(plan.id, [
        {
          id: 'm-1',
          role: 'user',
          content: 'Where is the checkout regression?',
          createdAt: '2026-03-19T00:01:00.000Z',
        },
        {
          id: 'm-2',
          role: 'assistant',
          content: 'It comes from stale plan hydration.',
          createdAt: '2026-03-19T00:02:00.000Z',
        },
      ]);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('conv-1')],
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

      const result = await useChatStore.getState().ensureArchitectConversationForPlan({
        plan,
        targetBranch: 'develop',
        fallbackProjectId: 'project-1',
        fallbackGroupId: 'group-1',
      });

      expect(result).toEqual({
        conversationId: 'conv-1',
        restoredTranscript: true,
        createdConversation: false,
      });
      expect(useChatStore.getState().selectedConversationId).toBe('conv-1');
      expect(
        useChatStore
          .getState()
          .getConversationMessages('conv-1')
          .map((message: { content: string }) => message.content)
      ).toEqual(['Where is the checkout regression?', 'It comes from stale plan hydration.']);
      expect(
        useChatStore
          .getState()
          .conversations.find((conversation: Conversation) => conversation.id === 'conv-1')?.message_count
      ).toBe(2);
      expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    });

    it('does not duplicate restored transcript messages when called twice', async () => {
      const plan = createPlan();
      architectPlans.set(plan.id, plan);
      architectPlanMessages.set(plan.id, [
        {
          id: 'm-1',
          role: 'user',
          content: 'User question',
          createdAt: '2026-03-19T00:01:00.000Z',
        },
        {
          id: 'm-2',
          role: 'assistant',
          content: 'Assistant answer',
          createdAt: '2026-03-19T00:02:00.000Z',
        },
      ]);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('conv-1')],
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

      const first = await useChatStore.getState().ensureArchitectConversationForPlan({
        plan,
        targetBranch: 'develop',
      });
      const second = await useChatStore.getState().ensureArchitectConversationForPlan({
        plan,
        targetBranch: 'develop',
      });

      expect(first.restoredTranscript).toBe(true);
      expect(second.restoredTranscript).toBe(false);
      expect(useChatStore.getState().getConversationMessages('conv-1')).toHaveLength(2);
    });

    it('imports only the missing metadata suffix for a partially restored plan transcript', async () => {
      context.tauriAvailable = true;

      const plan = createPlan();
      architectPlans.set(plan.id, plan);
      architectPlanMessages.set(plan.id, [
        {
          id: 'm-1',
          role: 'user',
          content: 'First question',
          createdAt: '2026-03-19T00:01:00.000Z',
        },
        {
          id: 'm-2',
          role: 'assistant',
          content: 'Second answer',
          createdAt: '2026-03-19T00:02:00.000Z',
        },
      ]);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('conv-1')],
        messages: [
          {
            id: 'm-1',
            task_id: '',
            conversation_id: 'conv-1',
            role: 'user',
            content: 'First question',
            timestamp: '2026-03-19T00:01:00.000Z',
          },
        ],
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const result = await useChatStore.getState().ensureArchitectConversationForPlan({
        plan,
        targetBranch: 'develop',
      });

      expect(result.restoredTranscript).toBe(true);
      expect(importMessagesMock).toHaveBeenCalledWith('conv-1', [
        {
          id: 'm-2',
          role: 'assistant',
          content: 'Second answer',
          created_at: '2026-03-19T00:02:00.000Z',
        },
      ]);
      expect(
        useChatStore.getState().getConversationMessages('conv-1').map((message: { id: string; timestamp: string }) => ({
          id: message.id,
          timestamp: message.timestamp,
        }))
      ).toEqual([
        { id: 'm-1', timestamp: '2026-03-19T00:01:00.000Z' },
        { id: 'm-2', timestamp: '2026-03-19T00:02:00.000Z' },
      ]);
    });

    it('resynchronizes architect metadata when the local DB transcript is ahead', async () => {
      const plan = createPlan();
      architectPlans.set(plan.id, plan);
      architectPlanMessages.set(plan.id, [
        {
          id: 'm-1',
          role: 'user',
          content: 'First question',
          createdAt: '2026-03-19T00:01:00.000Z',
        },
      ]);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('conv-1')],
        messages: [
          {
            id: 'm-1',
            task_id: '',
            conversation_id: 'conv-1',
            role: 'user',
            content: 'First question',
            timestamp: '2026-03-19T00:01:00.000Z',
          },
          {
            id: 'm-2',
            task_id: '',
            conversation_id: 'conv-1',
            role: 'assistant',
            content: 'Second answer',
            timestamp: '2026-03-19T00:02:00.000Z',
          },
        ],
        selectedConversationId: null,
        selectedConversationIdsByMode: {},
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const result = await useChatStore.getState().ensureArchitectConversationForPlan({
        plan,
        targetBranch: 'develop',
      });

      expect(result.restoredTranscript).toBe(false);
      expect(syncArchitectPlanChatFromConversationMock).toHaveBeenCalledWith({
        branchName: 'develop',
        planId: plan.id,
        conversationId: 'conv-1',
      });
      expect(importMessagesMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().getConversationMessages('conv-1')).toHaveLength(2);
    });

    it('creates a dedicated conversation and restores transcript when the plan conversation is shared', async () => {
      const originalNow = Date.now;
      Date.now = () => 1773900000000;
      try {
        const plan = createPlan({ conversationId: 'shared-conv' });
        architectPlans.set(plan.id, plan);
        architectPlanMessages.set(plan.id, [
          {
            id: 'm-1',
            role: 'assistant',
            content: 'Shared transcripts should move.',
            createdAt: '2026-03-19T00:03:00.000Z',
          },
        ]);

        const { useChatStore } = await loadChatStore();
        useChatStore.setState({
          conversations: [createConversation('shared-conv')],
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

        const result = await useChatStore.getState().ensureArchitectConversationForPlan({
          plan,
          targetBranch: 'develop',
          fallbackProjectId: 'project-1',
          fallbackGroupId: 'group-1',
          sharedConversation: true,
        });

        expect(result.createdConversation).toBe(true);
        expect(result.restoredTranscript).toBe(true);
        expect(result.conversationId).toMatch(/^conv-conversation-session-1773900000000-/);
        expect(updateArchitectPlanMock).toHaveBeenCalledWith(expect.objectContaining({
          branchName: 'develop',
          planId: plan.id,
          conversationId: result.conversationId,
        }));
        expect(useChatStore.getState().getConversationMessages(result.conversationId!)).toHaveLength(1);
        expect(useChatStore.getState().selectedConversationId).toBe(result.conversationId);
      } finally {
        Date.now = originalNow;
      }
    });

    it('keeps a durable cleanup guard when plan transcript import fails after creating a conversation', async () => {
      context.tauriAvailable = true;
      const plan = createPlan({
        id: 'plan-import-cleanup',
        conversationId: 'shared-plan-import-conv',
      });
      architectPlans.set(plan.id, plan);
      architectPlanMessages.set(plan.id, [{
        id: 'plan-import-message',
        role: 'assistant',
        content: 'This import must either persist or be compensated.',
        createdAt: '2026-08-12T00:00:00.000Z',
      }]);
      importMessagesMock.mockImplementationOnce(async () => {
        throw new Error('injected transcript import failure');
      });
      deleteConversationMock.mockImplementationOnce(async () => {
        throw new Error('injected conversation cleanup failure');
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('shared-plan-import-conv')],
      }));

      await expect(
        useChatStore.getState().ensureArchitectConversationForPlan({
          plan,
          targetBranch: 'develop',
          fallbackProjectId: 'project-1',
          fallbackGroupId: 'group-1',
          sharedConversation: true,
        }),
      ).rejects.toThrow('nettoyage sera repris automatiquement');

      const pendingSagas = JSON.parse(
        appSettingValues.get('pendingLinkedTaskDeletions:v1') ?? '[]',
      );
      expect(pendingSagas).toEqual([expect.objectContaining({
        ownerType: 'plan',
        ownerId: plan.id,
        phase: 'task_deleted',
        targetBranch: 'develop',
      })]);

      await useChatStore.getState().initializeCritical();

      expect(appSettingValues.get('pendingLinkedTaskDeletions:v1')).toBe('[]');
    });

    it('prefers the active plan conversation over the project architect conversation fallback', async () => {
      const plan = createPlan({ conversationId: 'plan-conv' });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('plan-conv'), createConversation('project-architect-conversation')],
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

      const selectedConversationId = await useChatStore.getState().ensureConversationForCurrentMode();

      expect(selectedConversationId).toBe('plan-conv');
      expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
      expect(getLocalProjectContextStateMock).not.toHaveBeenCalled();
    });

    it('clears the previous architect conversation immediately when switching to a blank plan', async () => {
      context.tauriAvailable = true;

      const advancedPlan = createScenarioPlan('started', {
        id: 'plan-advanced',
        slug: 'plan-advanced',
        title: 'plan-advanced',
        label: 'Checkout refresh',
        conversationId: 'plan-advanced-conv',
      });
      const blankPlan = createScenarioPlan('blank', {
        id: 'plan-blank',
        slug: 'plan-blank',
        title: 'plan-blank',
        conversationId: undefined,
      });
      architectPlans.set(advancedPlan.id, advancedPlan);
      architectPlans.set(blankPlan.id, blankPlan);
      appState.activeArchitectPlanId = advancedPlan.id;
      appState.activePlanContext = { id: advancedPlan.id, targetBranch: 'develop' };

      context.chatSnapshotConversations = [
        createChatSnapshotConversation('plan-advanced-conv', {
          title: 'Checkout refresh',
          last_message: 'latest',
          message_count: 2,
          updated_at: '2026-03-19T00:04:00.000Z',
        }),
      ];
      context.chatSnapshotMessages = [
        createChatMessageRecord({
          id: 'm-1',
          conversation_id: 'plan-advanced-conv',
          role: 'user',
          content: 'First question',
        }),
        createChatMessageRecord({
          id: 'm-2',
          conversation_id: 'plan-advanced-conv',
          role: 'assistant',
          content: 'Second answer',
          created_at: '2026-03-19T00:02:00.000Z',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();

      expect(useChatStore.getState().selectedConversationId).toBe('plan-advanced-conv');

      context.tauriAvailable = false;
      useAppStoreMock.setState({
        activeArchitectPlanId: blankPlan.id,
        activePlanContext: { id: blankPlan.id, targetBranch: 'develop' },
      });

      expect(useChatStore.getState().selectedConversationId).toBeNull();
      expect(useChatStore.getState().selectedConversationIdsByMode.Architect).toBeNull();
      expect(useChatStore.getState().restoreStatus).toBe('resolving');

      await flushAsyncWork();

      const nextConversationId = useChatStore.getState().selectedConversationId;
      expect(nextConversationId).toBeTruthy();
      expect(nextConversationId).not.toBe('plan-advanced-conv');
      expect(useChatStore.getState().restoreStatus).toBe('ready');
      expect(useChatStore.getState().getConversationMessages(nextConversationId!)).toHaveLength(0);
      expect(getArchitectPlanActivationPayloadMock).toHaveBeenCalledWith(
        'develop',
        blankPlan.id,
        expect.any(Object)
      );
      expect(bindArchitectPlanConversationMock).not.toHaveBeenCalled();
      expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    });

    it('binds a blank architect plan conversation only when the first message is sent', async () => {
      const plan = createScenarioPlan('blank', {
        id: 'plan-blank-first-message',
        slug: 'plan-blank-first-message',
        title: 'plan-blank-first-message',
        conversationId: undefined,
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState());

      const conversationId =
        await useChatStore.getState().ensureConversationForCurrentMode();

      expect(conversationId).toBeTruthy();
      expect(bindArchitectPlanConversationMock).not.toHaveBeenCalled();
      expect(updateArchitectPlanMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId,
        }),
      );

      await useChatStore.getState().sendMessage({
        conversationId: conversationId!,
        content: 'On doit refondre le parcours checkout et la reprise panier.',
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(bindArchitectPlanConversationMock).toHaveBeenCalledWith({
        branchName: 'develop',
        planId: plan.id,
        conversationId: expect.not.stringMatching(/^pending-architect-/),
      });
      expect(architectPlans.get(plan.id)?.conversationId).not.toBe(conversationId);
      expect(architectPlans.get(plan.id)?.conversationId).toBeTruthy();
      expect(syncArchitectPlanChatFromConversationMock).toHaveBeenCalledWith({
        branchName: 'develop',
        planId: plan.id,
        conversationId: architectPlans.get(plan.id)?.conversationId,
      });
    });

    it('keeps the materialized Architect session as the owner of empty-placeholder cleanup', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Architect';
      const plan = createScenarioPlan('blank', {
        id: 'plan-materialized-cleanup',
        slug: 'plan-materialized-cleanup',
        title: 'plan-materialized-cleanup',
        conversationId: undefined,
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };
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
      useChatStore.setState(createIdleChatStoreState());
      const pendingConversationId =
        await useChatStore.getState().ensureConversationForCurrentMode();

      const result = await useChatStore.getState().sendMessage({
        conversationId: pendingConversationId!,
        content: 'Prépare le plan de migration.',
      });
      const materializedConversationId = result.conversationId;
      const userMessage = useChatStore
        .getState()
        .getConversationMessages(materializedConversationId)
        .find((message: ChatMessage) => message.role === 'user');

      expect(materializedConversationId).not.toBe(pendingConversationId);
      expect(useChatStore.getState().getConversationRuntime(materializedConversationId).phase).toBe(
        'streaming',
      );

      useChatStore.getState().stopConversationStream(materializedConversationId);
      await flushAsyncWork();

      expect(
        useChatStore
          .getState()
          .getConversationMessages(materializedConversationId)
          .filter((message: ChatMessage) => message.role === 'assistant'),
      ).toEqual([]);
      expect(deleteMessagesAfterMock).toHaveBeenCalledWith(
        materializedConversationId,
        userMessage!.id,
      );
    });

    it('does not transfer a pending Architect runtime to a tombstoned materialized conversation', async () => {
      context.tauriAvailable = true;
      appState.mode = 'Architect';
      const plan = createScenarioPlan('blank', {
        id: 'plan-materialized-deletion',
        slug: 'plan-materialized-deletion',
        title: 'plan-materialized-deletion',
        conversationId: undefined,
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };
      const materializedConversation = {
        id: 'materialized-architect-conv',
        title: 'Architect plan',
        description: '',
        scope_mode: 'Architect' as AppMode,
        task_id: null,
        group_id: 'group-1',
        project_id: 'project-1',
        provider_id: null,
        model_id: null,
        reasoning_effort: null,
        created_at: '2026-03-19T00:00:00.000Z',
        last_message: '',
        message_count: 0,
        updated_at: '2026-03-19T00:00:00.000Z',
        is_pinned: false,
      };
      const materialization = createDeferred<typeof materializedConversation>();
      (
        createConversationMock as unknown as {
          mockImplementationOnce: (
            implementation: () => Promise<typeof materializedConversation>,
          ) => void;
        }
      ).mockImplementationOnce(async () => materialization.promise);

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState());
      const pendingConversationId =
        await useChatStore.getState().ensureConversationForCurrentMode();
      const send = useChatStore.getState().sendMessage({
        conversationId: pendingConversationId!,
        content: 'Ne relance pas une conversation supprimée.',
      });
      await flushAsyncWork();

      let deletionPromise: Promise<void> | null = null;
      const unsubscribe = useChatStore.subscribe((state: { conversations: Conversation[] }) => {
        if (
          deletionPromise ||
          !state.conversations.some(
            (conversation: Conversation) => conversation.id === materializedConversation.id,
          )
        ) {
          return;
        }
        deletionPromise = useChatStore.getState().deleteConversation(
          materializedConversation.id,
          { mode: 'architect', typedProjectName: 'Macro' },
        );
      });

      materialization.resolve(materializedConversation);
      const result = await send;
      unsubscribe();
      await deletionPromise;

      expect(result).toMatchObject({
        status: 'cancelled',
        conversationId: materializedConversation.id,
      });
      expect(
        useChatStore.getState().getConversationRuntime(materializedConversation.id).phase,
      ).toBe('idle');
      expect(
        useChatStore.getState().getConversationRuntime(pendingConversationId!).phase,
      ).toBe('idle');
      expect(
        useChatStore.getState().conversationRuntimeById[pendingConversationId!],
      ).toBeUndefined();
      expect(useChatStore.getState()).toMatchObject({
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
      });
      expect(
        useChatStore
          .getState()
          .conversations.some((conversation: Conversation) => conversation.id === materializedConversation.id),
      ).toBe(false);
      expect(createMessageMock).not.toHaveBeenCalled();
    });

    it('removes a pending blank architect conversation when switching away before the first message', async () => {
      const blankPlan = createScenarioPlan('blank', {
        id: 'plan-pending-switch-away',
        slug: 'plan-pending-switch-away',
        title: 'plan-pending-switch-away',
        conversationId: undefined,
      });
      const startedPlan = createScenarioPlan('started', {
        id: 'plan-started-after-pending',
        slug: 'plan-started-after-pending',
        title: 'plan-started-after-pending',
        conversationId: 'started-plan-conv',
      });
      architectPlans.set(blankPlan.id, blankPlan);
      architectPlans.set(startedPlan.id, startedPlan);
      appState.activeArchitectPlanId = blankPlan.id;
      appState.activePlanContext = { id: blankPlan.id, targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(
        createIdleChatStoreState({
          conversations: [createConversation('started-plan-conv')],
        })
      );

      const pendingConversationId =
        await useChatStore.getState().ensureConversationForCurrentMode();
      expect(pendingConversationId).toMatch(/^pending-architect-/);
      expect(
        useChatStore
          .getState()
          .conversations.some(
            (conversation: Conversation) => conversation.id === pendingConversationId
          )
      ).toBe(true);

      appState.activeArchitectPlanId = startedPlan.id;
      appState.activePlanContext = { id: startedPlan.id, targetBranch: 'develop' };

      const selectedConversationId =
        await useChatStore.getState().ensureConversationForCurrentMode();

      expect(selectedConversationId).toBe('started-plan-conv');
      expect(
        useChatStore
          .getState()
          .conversations.some(
            (conversation: Conversation) => conversation.id === pendingConversationId
          )
      ).toBe(false);
      expect(useChatStore.getState().selectedConversationId).toBe('started-plan-conv');
    });

    it('uses a head-only architect activation without reading the transcript when DB sync matches', async () => {
      context.tauriAvailable = true;
      const plan = createScenarioPlan('started', {
        id: 'plan-head-sync-ok',
        slug: 'plan-head-sync-ok',
        title: 'plan-head-sync-ok',
        conversationId: 'plan-head-sync-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('plan-head-sync-conv', {
          message_count: 2,
          updated_at: '2026-03-19T00:02:00.000Z',
        }),
      ];
      context.chatSnapshotMessages = [
        createChatMessageRecord({
          id: 'head-sync-user',
          conversation_id: 'plan-head-sync-conv',
          role: 'user',
          content: 'Existing local question',
        }),
        createChatMessageRecord({
          id: 'head-sync-assistant',
          conversation_id: 'plan-head-sync-conv',
          role: 'assistant',
          content: 'Existing local answer',
          created_at: '2026-03-19T00:02:00.000Z',
        }),
      ];
      architectPlanConversationSyncRecords.set('plan-head-sync-conv', {
        conversation_id: 'plan-head-sync-conv',
        plan_id: plan.id,
        target_branch: 'develop',
        transcript_revision: 'revision-head-ok',
        message_count: 2,
        updated_at: '2026-03-19T00:02:00.000Z',
      });
      getArchitectPlanActivationPayloadMock.mockImplementationOnce(async () => ({
        plan,
        chatMessages: [],
        chatMessagesLoaded: false,
        chatTranscriptRevision: 'revision-head-ok',
        chatMessageCount: 2,
        conversationId: 'plan-head-sync-conv',
        sharedConversation: false,
        targetBranch: 'develop',
        resolutionMode: 'full',
      }));

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();

      expect(useChatStore.getState().selectedConversationId).toBe('plan-head-sync-conv');
      expect(dbGetArchitectPlanConversationSyncMock).toHaveBeenCalledWith('plan-head-sync-conv');
      expect(getArchitectPlanChatTranscriptMock).not.toHaveBeenCalled();
      expect(
        useChatStore
          .getState()
          .getConversationMessages('plan-head-sync-conv')
          .map((message: { id: string }) => message.id)
      ).toEqual(['head-sync-user', 'head-sync-assistant']);
    });

    it('loads and imports the architect transcript when head-only activation sync is missing', async () => {
      context.tauriAvailable = true;
      const plan = createScenarioPlan('started', {
        id: 'plan-head-sync-missing',
        slug: 'plan-head-sync-missing',
        title: 'plan-head-sync-missing',
        conversationId: 'plan-head-missing-conv',
      });
      architectPlans.set(plan.id, plan);
      architectPlanMessages.set(plan.id, [
        createTranscriptEntry({
          id: 'missing-sync-user',
          role: 'user',
          content: 'Restore transcript from metadata.',
        }),
        createTranscriptEntry({
          id: 'missing-sync-assistant',
          role: 'assistant',
          content: 'Transcript restored.',
          createdAt: '2026-03-19T00:02:00.000Z',
        }),
      ]);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('plan-head-missing-conv', {
          message_count: 0,
        }),
      ];
      getArchitectPlanActivationPayloadMock.mockImplementationOnce(async () => ({
        plan,
        chatMessages: [],
        chatMessagesLoaded: false,
        chatTranscriptRevision: 'revision-head-missing',
        chatMessageCount: 2,
        conversationId: 'plan-head-missing-conv',
        sharedConversation: false,
        targetBranch: 'develop',
        resolutionMode: 'full',
      }));

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();

      expect(getArchitectPlanChatTranscriptMock).toHaveBeenCalledWith('develop', plan.id);
      expect(importMessagesMock).toHaveBeenCalledWith(
        'plan-head-missing-conv',
        expect.arrayContaining([
          expect.objectContaining({ id: 'missing-sync-user' }),
          expect.objectContaining({ id: 'missing-sync-assistant' }),
        ])
      );
      expect(dbUpsertArchitectPlanConversationSyncMock).toHaveBeenCalledWith({
        conversation_id: 'plan-head-missing-conv',
        plan_id: plan.id,
        target_branch: 'develop',
        transcript_revision: 'test-revision-plan-head-sync-missing',
        message_count: 2,
      });
      expect(
        useChatStore
          .getState()
          .getConversationMessages('plan-head-missing-conv')
          .map((message: { id: string }) => message.id)
      ).toEqual(['missing-sync-user', 'missing-sync-assistant']);
    });

    it('reuses the app-store activation payload before falling back to the plan service', async () => {
      const plan = createScenarioPlan('blank', {
        id: 'plan-blank-shared-payload',
        slug: 'plan-blank-shared-payload',
        title: 'plan-blank-shared-payload',
        conversationId: undefined,
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };
      appState.pendingArchitectPlanActivationPayload = {
        plan,
        chatMessages: [],
        conversationId: null,
        sharedConversation: false,
        targetBranch: 'develop',
        resolutionMode: 'blank_fast_path',
      };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState());
      getArchitectPlanActivationPayloadMock.mockClear();

      const conversationId =
        await useChatStore.getState().ensureConversationForCurrentMode();

      expect(conversationId).toBeTruthy();
      expect(getArchitectPlanActivationPayloadMock).not.toHaveBeenCalled();
      expect(appState.pendingArchitectPlanActivationPayload).toBeNull();
    });

    it('hydrates the chat snapshot and resolves the active plan conversation during initialize', async () => {
      context.tauriAvailable = true;

      const plan = createPlan({ conversationId: 'plan-conv' });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      context.chatSnapshotConversations = [
        createChatSnapshotConversation('project-architect-conversation', {
          title: 'Architect - Macro',
          last_message: 'fallback',
          message_count: 1,
          updated_at: '2026-03-19T00:03:00.000Z',
        }),
        createChatSnapshotConversation('plan-conv', {
          title: 'Checkout refresh',
          last_message: 'latest',
          message_count: 2,
          updated_at: '2026-03-19T00:04:00.000Z',
        }),
      ];
      context.chatSnapshotMessages = [
        {
          id: 'm-2',
          conversation_id: 'plan-conv',
          role: 'assistant',
          content: 'Second answer',
          created_at: '2026-03-19T00:02:00.000Z',
        },
        {
          id: 'm-1',
          conversation_id: 'plan-conv',
          role: 'user',
          content: 'First question',
          created_at: '2026-03-19T00:01:00.000Z',
        },
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();

      expect(getChatBootstrapSnapshotMock).toHaveBeenCalledTimes(1);
      expect(getChatSnapshotMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().hydrationStatus).toBe('ready');
      expect(useChatStore.getState().restoreStatus).toBe('ready');
      expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
      expect(
        useChatStore.getState().getConversationMessages('plan-conv').map((message: { id: string }) => message.id)
      ).toEqual(['m-1', 'm-2']);
      expect(getLocalProjectContextStateMock).not.toHaveBeenCalled();
    });

    it('keeps a conversation hidden while a task-deletion saga is pending at bootstrap', async () => {
      context.tauriAvailable = true;
      appSettingValues.set(
        'pendingLinkedTaskDeletions:v1',
        JSON.stringify([{
          taskId: 'task-pending-cleanup',
          conversationId: 'conversation-pending-cleanup',
          phase: 'task_deleted',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        }]),
      );
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('conversation-pending-cleanup', {
          message_count: 1,
        }),
        createChatSnapshotConversation('conversation-visible', {
          message_count: 1,
        }),
      ];
      context.chatSnapshotMessages = [
        createChatMessageRecord({
          id: 'message-pending-cleanup',
          conversation_id: 'conversation-pending-cleanup',
        }),
        createChatMessageRecord({
          id: 'message-visible',
          conversation_id: 'conversation-visible',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();

      expect(useChatStore.getState().conversations.map((conversation: { id: string }) => conversation.id)).not.toContain(
        'conversation-pending-cleanup',
      );
      expect(useChatStore.getState().getConversationMessages('conversation-pending-cleanup')).toEqual([]);
    });

    it('keeps a linked conversation visible while a direct return to draft is recovering', async () => {
      context.tauriAvailable = true;
      appSettingValues.set(
        'pendingLinkedTaskDeletions:v1',
        JSON.stringify([{
          taskId: 'task-returning-to-draft',
          conversationId: 'conversation-returning-to-draft',
          phase: 'draft_reverting',
          targetBranch: '@direct-draft-revert',
          executionTargets: [],
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        }]),
      );
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('conversation-returning-to-draft', {
          message_count: 1,
        }),
      ];
      context.chatSnapshotMessages = [
        createChatMessageRecord({
          id: 'message-returning-to-draft',
          conversation_id: 'conversation-returning-to-draft',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();

      expect(useChatStore.getState().conversations.map((conversation: { id: string }) => conversation.id)).toContain(
        'conversation-returning-to-draft',
      );
      expect(deleteConversationMock).not.toHaveBeenCalledWith('conversation-returning-to-draft');
    });

    it('reports a semantically invalid deletion saga instead of silently tombstoning its conversation', async () => {
      context.tauriAvailable = true;
      const invalidSaga = JSON.stringify([{
        ownerType: 'conversation',
        ownerId: 'conversation-invalid-saga',
        conversationId: 'conversation-invalid-saga',
        phase: 'prepared',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }]);
      appSettingValues.set('pendingLinkedTaskDeletions:v1', invalidSaga);
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('conversation-invalid-saga'),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initializeCritical();

      expect(useChatStore.getState().hydrationStatus).toBe('error');
      expect(useChatStore.getState().lastError).toContain('journal de suppression liée est corrompu');
      expect(appSettingValues.get('pendingLinkedTaskDeletions:v1')).toBe(invalidSaga);
    });

    it('retries a failed SQLite replay recovery on the next bootstrap', async () => {
      context.tauriAvailable = true;
      context.chatSnapshotConversations = [createChatSnapshotConversation('replay-retry')];
      context.chatSnapshotMessages = [
        createChatMessageRecord({
          id: 'replay-anchor',
          conversation_id: 'replay-retry',
          content: 'Edited request',
        }),
      ];
      appSettingValues.set(
        'conversationReplayRecovery:replay-retry',
        JSON.stringify({
          replay_id: 'replay-retry-id',
          session_id: 'session-retry',
          turn_id: 'turn-retry',
          phase: 'launch_ready',
        }),
      );
      dbRestoreConversationReplayMock.mockImplementationOnce(async () => {
        throw new Error('injected SQLite restore failure');
      });
      dbRestoreConversationReplayMock.mockImplementationOnce(async () => {
        appSettingValues.delete('conversationReplayRecovery:replay-retry');
        context.chatSnapshotMessages = [
          createChatMessageRecord({
            id: 'replay-anchor',
            conversation_id: 'replay-retry',
            content: 'Original request',
          }),
          createChatMessageRecord({
            id: 'replay-tail',
            conversation_id: 'replay-retry',
            role: 'assistant',
            content: 'Restored tail',
          }),
        ];
        return true;
      });

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initializeCritical();
      expect(useChatStore.getState().conversations).toEqual([]);
      expect(useChatStore.getState().lastError).toContain('Replay recovery is pending');

      await useChatStore.getState().initializeCritical();
      expect(useChatStore.getState().conversations.map((conversation: { id: string }) => conversation.id))
        .toContain('replay-retry');
      expect(dbRestoreConversationReplayMock).toHaveBeenCalledTimes(2);
    });

    it('repairs stale scope metadata for the active plan conversation during initialize', async () => {
      context.tauriAvailable = true;

      const plan = createPlan({ conversationId: 'plan-conv' });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

      context.chatSnapshotConversations = [
        createChatSnapshotConversation('plan-conv', {
          scope_mode: 'Chat',
          group_id: null,
          project_id: null,
          title: 'Checkout refresh',
          last_message: 'latest',
          message_count: 1,
        }),
      ];
      context.chatSnapshotMessages = [
        createChatMessageRecord({
          id: 'm-1',
          conversation_id: 'plan-conv',
          role: 'user',
          content: 'Restore this history.',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();

      const repairedConversation = useChatStore
        .getState()
        .conversations.find((conversation: Conversation) => conversation.id === 'plan-conv');
      expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
      expect(useChatStore.getState().getConversationMessages('plan-conv')).toHaveLength(1);
      expect(repairedConversation).toEqual(
        expect.objectContaining({
          scope_mode: 'Architect',
          task_id: null,
          group_id: 'group-1',
          project_id: 'project-1',
        })
      );
      expect(updateConversationScopeMock).toHaveBeenCalledWith({
        id: 'plan-conv',
        scopeMode: 'Architect',
        taskId: null,
        groupId: 'group-1',
        projectId: 'project-1',
      });
      expect(createConversationMock).not.toHaveBeenCalled();
    });

    it('ignores stale active-plan resolutions when the project scope changes during startup', async () => {
      context.tauriAvailable = true;

      const plan = createPlan({ conversationId: 'plan-conv' });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

      context.chatSnapshotConversations = [
        createChatSnapshotConversation('plan-conv', {
          title: 'Checkout refresh',
          message_count: 1,
        }),
      ];
      context.chatSnapshotMessages = [
        createChatMessageRecord({
          id: 'm-1',
          conversation_id: 'plan-conv',
          role: 'assistant',
          content: 'Previous answer.',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initializeCritical();

      const firstResolution = createDeferred<{
        plan: ArchitectPlanRecord;
        chatMessages: never[];
        conversationId: string;
        sharedConversation: false;
        targetBranch: string;
        resolutionMode: 'full';
      }>();
      getArchitectPlanActivationPayloadMock
        .mockImplementationOnce(async () => firstResolution.promise)
        .mockImplementationOnce(async (_branchName: string) => ({
          plan,
          chatMessages: [],
          conversationId: 'plan-conv',
          sharedConversation: false,
          targetBranch: 'develop',
          resolutionMode: 'full',
        }));

      const staleResolution = useChatStore.getState().ensureConversationForCurrentMode();
      await Promise.resolve();

      useAppStoreMock.setState({ selectedProjectId: null });
      firstResolution.resolve({
        plan,
        chatMessages: [],
        conversationId: 'plan-conv',
        sharedConversation: false,
        targetBranch: 'develop',
        resolutionMode: 'full',
      });
      await staleResolution;
      await flushAsyncWork();

      expect(useChatStore.getState().lastError).not.toBe(
        'Failed to select the resolved conversation.'
      );
      expect(useChatStore.getState().restoreStatus).toBe('ready');
      expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
    });

    it('keeps the active plan conversation during initialize without replaying a project scope switch', async () => {
      context.tauriAvailable = true;

      const plan = createScenarioPlan('scoped_multi_project', {
        id: 'plan-cross-project',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };
      appState.selectedProjectId = 'project-1';

      context.chatSnapshotConversations = [
        createChatSnapshotConversation('project-architect-conversation', {
          description: '',
          title: 'Architect - Web',
          last_message: 'fallback',
          message_count: 1,
          updated_at: '2026-03-19T00:03:00.000Z',
        }),
        createChatSnapshotConversation('project-2-architect-fallback', {
          description: '',
          project_id: 'project-2',
          title: 'Architect - API',
          last_message: 'other fallback',
          message_count: 1,
          updated_at: '2026-03-19T00:05:00.000Z',
        }),
        createChatSnapshotConversation('plan-conv', {
          description: '',
          project_id: 'project-2',
          title: 'Checkout refresh',
          last_message: 'latest',
          message_count: 2,
          updated_at: '2026-03-19T00:04:00.000Z',
        }),
      ];
      context.chatSnapshotMessages = [
        createChatMessageRecord({
          id: 'm-1',
          conversation_id: 'plan-conv',
          role: 'user',
          content: 'First question',
        }),
        createChatMessageRecord({
          id: 'm-2',
          conversation_id: 'plan-conv',
          role: 'assistant',
          content: 'Second answer',
          created_at: '2026-03-19T00:02:00.000Z',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();

      expect(appState.switchProjectContext).not.toHaveBeenCalled();
      expectArchitectSelection(useChatStore, {
        planId: plan.id,
        conversationId: 'plan-conv',
      });
      expect(
        useChatStore.getState().getConversationMessages('plan-conv').map((message: { id: string }) => message.id)
      ).toEqual(['m-1', 'm-2']);
    });

    it('reuses the dedicated plan conversation after splitting a shared architect conversation once', async () => {
      const originalNow = Date.now;
      Date.now = () => 1773900000001;

      try {
        const plan = createScenarioPlan('blank', {
          id: 'plan-shared',
          conversationId: 'shared-conv',
        });
        architectPlans.set(plan.id, plan);
        architectPlanMessages.set(plan.id, [
          createTranscriptEntry({
            id: 'm-1',
            content: 'Shared transcripts should move.',
            createdAt: '2026-03-19T00:03:00.000Z',
          }),
        ]);

        const { useChatStore } = await loadChatStore();
        useChatStore.setState(
          createIdleChatStoreState({
            conversations: [createConversation('shared-conv')],
          })
        );

        const first = await useChatStore.getState().ensureArchitectConversationForPlan({
          plan,
          targetBranch: 'develop',
          fallbackProjectId: 'project-1',
          fallbackGroupId: 'group-1',
          sharedConversation: true,
        });

        updateArchitectPlanMock.mockClear();
        const updatedPlan = architectPlans.get(plan.id)!;
        const second = await useChatStore.getState().ensureArchitectConversationForPlan({
          plan: updatedPlan,
          targetBranch: 'develop',
          fallbackProjectId: 'project-1',
          fallbackGroupId: 'group-1',
        });

        expect(first.createdConversation).toBe(true);
        expect(second).toEqual({
          conversationId: first.conversationId,
          restoredTranscript: false,
          createdConversation: false,
        });
        expect(updateArchitectPlanMock).not.toHaveBeenCalled();
        expect(useChatStore.getState().conversations.filter((conversation: Conversation) => conversation.id === first.conversationId)).toHaveLength(1);
        expect(useChatStore.getState().selectedConversationId).toBe(first.conversationId);
      } finally {
        Date.now = originalNow;
      }
    });

    it('renames an auto-created canonical plan with the configured metadata model', async () => {
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
      const plan = createPlan({
        id: '1710000000000',
        slug: '1710000000000',
        title: '1710000000000',
        label: 'new plan',
        description: '',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('plan-conv'),
            title: 'Plan - new plan',
          },
        ],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'plan-conv',
        content: 'On doit refondre le flux checkout et restaurer le panier.',
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(1);
      expect(sendChatNonStreamingMock.mock.calls[0]?.[0]).toMatchObject({
        providerId: 'provider-2',
        modelId: 'metadata-model',
      });
      expect(updateArchitectPlanMock).toHaveBeenCalledWith({
        branchName: 'develop',
        planId: '1710000000000',
        label: 'Checkout refresh',
        description: 'Refresh checkout state and cart recovery.',
      });
      expect(architectPlans.get('1710000000000')?.label).toBe('Checkout refresh');
      expect(architectPlans.get('1710000000000')?.description).toBe(
        'Refresh checkout state and cart recovery.'
      );
      expect(useChatStore.getState().conversations[0]?.title).toBe(
        'Plan - Checkout refresh - 1710000000000'
      );
    });

    it('does not overwrite a manually renamed canonical plan on the first message', async () => {
      const plan = createPlan({
        id: '1710000000001',
        slug: '1710000000001',
        title: '1710000000001',
        label: 'Checkout rescue',
        description: '',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('plan-conv'),
            title: 'Plan - Checkout rescue - 1710000000001',
          },
        ],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'plan-conv',
        content: 'On doit stabiliser le checkout au plus vite.',
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(sendChatNonStreamingMock).not.toHaveBeenCalled();
      expect(updateArchitectPlanMock).not.toHaveBeenCalled();
      expect(architectPlans.get(plan.id)?.label).toBe('Checkout rescue');
      expect(useChatStore.getState().conversations[0]?.title).toBe(
        'Plan - Checkout rescue - 1710000000001'
      );
    });

    it('opens architect plan naming recovery after three failed AI naming attempts', async () => {
      setSendChatNonStreamingImplementation(async () => {
        throw new Error('model unavailable');
      });

      const plan = createPlan({
        id: '1710000000002',
        slug: '1710000000002',
        title: '1710000000002',
        label: 'new plan',
        description: '',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('plan-conv'),
            title: 'Plan - new plan',
          },
        ],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'plan-conv',
        content: 'On doit refondre le panier et la reprise de session.',
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(sendChatNonStreamingMock).toHaveBeenCalledTimes(3);
      expect(updateArchitectPlanMock).not.toHaveBeenCalled();
      expect(updateConversationDetailsMock).not.toHaveBeenCalled();
      expect(architectPlans.get(plan.id)?.label).toBe('new plan');
      expect(useChatStore.getState().architectPlanNamingRecovery).toMatchObject({
        conversationId: 'plan-conv',
        planId: plan.id,
        targetBranch: 'develop',
        stage: 'choice',
        isSubmitting: false,
        error: null,
      });
    });

    it('retries architect plan naming from recovery until it succeeds', async () => {
      setSendChatNonStreamingImplementation(async () => {
        throw new Error('model unavailable');
      });

      const plan = createPlan({
        id: '1710000000003',
        slug: '1710000000003',
        title: '1710000000003',
        label: 'new plan',
        description: '',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('plan-conv'),
            title: 'Plan - new plan',
          },
        ],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'plan-conv',
        content: 'On doit refondre le checkout et restaurer le panier.',
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      setSendChatNonStreamingImplementation(async () =>
        JSON.stringify({
          title: 'Checkout refresh',
          description: 'Refresh checkout state and cart recovery.',
        })
      );

      const retried = await useChatStore.getState().retryArchitectPlanNamingRecovery();

      expect(retried).toBe(true);
      expect(architectPlans.get(plan.id)?.label).toBe('Checkout refresh');
      expect(useChatStore.getState().architectPlanNamingRecovery).toBeNull();
      expect(useChatStore.getState().conversations[0]?.title).toBe(
        'Plan - Checkout refresh - 1710000000003'
      );
    });

    it('allows naming the plan manually from recovery', async () => {
      const plan = createPlan({
        id: '1710000000004',
        slug: '1710000000004',
        title: '1710000000004',
        label: 'new plan',
        description: '',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('plan-conv'),
            title: 'Plan - new plan',
          },
        ],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
        architectPlanNamingRecovery: {
          conversationId: 'plan-conv',
          planId: plan.id,
          targetBranch: 'develop',
          firstUserContent: 'On doit renommer ce plan.',
          providerId: 'provider-1',
          modelId: 'model-1',
          reasoningEffort: null,
          stage: 'manual',
          isSubmitting: false,
          error: null,
        },
      });

      const saved = await useChatStore
        .getState()
        .submitArchitectPlanManualName('Checkout recovery');

      expect(saved).toBe(true);
      expect(architectPlans.get(plan.id)?.label).toBe('Checkout recovery');
      expect(useChatStore.getState().architectPlanNamingRecovery).toBeNull();
      expect(useChatStore.getState().conversations[0]?.title).toBe(
        'Plan - Checkout recovery - 1710000000004'
      );
    });

    it('hydrates the active plan after a tool update without triggering implicit auto-plan on project switch', async () => {
      const plan = createPlan({
        id: 'plan-1',
        conversationId: 'plan-conv',
        projectId: 'project-2',
        projectIds: ['project-2'],
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };
      appState.selectedProjectId = 'project-1';

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('plan-conv')],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Refresh the plan context.',
      });

      expect(onToolCall).toBeDefined();
      await onToolCall('plan_update', {
        plan_id: plan.id,
        description: 'Updated scope',
      });

      expect(appState.activateArchitectPlan).toHaveBeenCalledWith(plan.id, {
        targetBranch: 'develop',
        persistActiveSelection: false,
      });
      expect(appState.switchProjectContext).toHaveBeenCalledWith('project-2', {
        restoreProjectContext: false,
        ensureAutoPlan: false,
      });
      expect(appState.activeArchitectPlanId).toBe(plan.id);
      expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
    });

    it('keeps the active plan and conversation on plan updates even when blank sibling drafts exist', async () => {
      const activePlan = createScenarioPlan('scoped_multi_project', {
        id: 'started-plan',
        conversationId: 'plan-conv',
        description: 'Started planning',
      });
      const blankSibling = createScenarioPlan('renamed_blank', {
        id: 'blank-sibling',
        conversationId: 'blank-conv',
        projectId: 'project-2',
        projectIds: ['project-2'],
      });
      architectPlans.set(activePlan.id, activePlan);
      architectPlans.set(blankSibling.id, blankSibling);
      appState.activeArchitectPlanId = activePlan.id;
      appState.activePlanContext = { targetBranch: 'develop' };
      appState.selectedProjectId = 'project-1';

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [
          createConversation('plan-conv'),
          createConversation('blank-conv', 'project-2'),
          {
            ...createConversation('project-2-architect-fallback', 'project-2'),
            title: 'Architect - API',
          },
        ],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Refresh the active plan context.',
      });

      await onToolCall('plan_update', {
        plan_id: activePlan.id,
        description: 'Updated scope',
      });

      expect(appState.activateArchitectPlan).toHaveBeenCalledWith(activePlan.id, {
        targetBranch: 'develop',
        persistActiveSelection: false,
      });
      expect(appState.switchProjectContext).toHaveBeenCalledWith('project-2', {
        restoreProjectContext: false,
        ensureAutoPlan: false,
      });
      expectArchitectSelection(useChatStore, {
        planId: activePlan.id,
        conversationId: 'plan-conv',
      });
      expect((updateArchitectPlanMock as unknown as {
        mock: { calls: Array<Array<Record<string, unknown>>> };
      }).mock.calls.every((call) => call[0]?.planId === activePlan.id)).toBe(true);
      expect(architectPlans.get(blankSibling.id)?.label).toBe(blankSibling.label);
    });

    it('allows plan label metadata updates after strategy has been created', async () => {
      const activePlan = createPlan({
        id: 'started-plan',
        conversationId: 'plan-conv',
        nodes: [
          {
            id: 'node-1',
            title: 'Implement checkout',
            description: '',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'feature/checkout',
            projectId: 'project-1',
            projectIds: ['project-1'],
          },
        ],
      });
      architectPlans.set(activePlan.id, activePlan);
      appState.activeArchitectPlanId = activePlan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Update the plan label.',
      });

      const result = await onToolCall('plan_update', {
        plan_id: activePlan.id,
        label: 'New label',
      });

      expect(result).toContain('Updated plan');
      expect(result).toContain('New label');
      expect(updateArchitectPlanMock).toHaveBeenCalledWith(
        expect.objectContaining({
          planId: activePlan.id,
          label: 'New label',
        }),
      );
    });

    it('does not re-resolve the architect conversation when only the selected task changes', async () => {
      context.tauriAvailable = true;

      const plan = createPlan({ conversationId: 'plan-conv' });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

      context.chatSnapshotConversations = [
        createChatSnapshotConversation('plan-conv', {
          title: 'Checkout refresh',
          last_message: 'latest',
          message_count: 2,
          updated_at: '2026-03-19T00:04:00.000Z',
        }),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();

      const initialSelectionRequestId = useChatStore.getState().selectionRequestId;
      useAppStoreMock.setState({ selectedTaskId: 'task-1' });
      await Promise.resolve();

      expect(useChatStore.getState().selectionRequestId).toBe(initialSelectionRequestId);
      expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
      expect(useChatStore.getState().restoreStatus).toBe('ready');
    });

  });
};
