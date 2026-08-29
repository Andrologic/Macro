import { describe, expect, it, mock } from 'bun:test';
import { createDeferred } from '../../test-utils/deferred';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerConversationSelectionScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    activateArchitectPlanForTest,
    appState,
    createArchitectStoreState,
    createChatSnapshotConversation,
    createCommitRestoredSelectionMock,
    createConversation,
    createConversationMock,
    createIdleChatStoreState,
    createMessageMock,
    deleteConversationToolboxStateMock,
    flushAsyncWork,
    getConversationToolboxStateMock,
    getLocalProjectContextStateMock,
    loadAiSelectionsPreference,
    loadChatStore,
    providerState,
    saveAiSelectionsPreference,
    streamChatMock,
    toolboxStateByConversationId,
    upsertConversationToolboxStateMock,
    useProviderStoreMock,
    waitForToolboxPersistence,
  } = context;

  describe('useChatStore conversation selection and AI restoration', () => {
    it('keeps composer drafts isolated by context and migrates the temporary draft', async () => {
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({ composerDraftsByContextKey: {} }));

      const state = useChatStore.getState();
      state.saveComposerDraftForContext('context:temporary', {
        text: 'Temporary draft',
        images: [],
        contextRefs: [],
      });
      state.saveComposerDraftForContext('conversation:existing', {
        text: 'Existing draft',
        images: [],
        contextRefs: [],
      });

      expect(useChatStore.getState().getComposerDraftForContext('conversation:existing')?.text)
        .toBe('Existing draft');
      useChatStore.getState().migrateComposerDraftContext(
        'context:temporary',
        'conversation:created'
      );

      expect(useChatStore.getState().getComposerDraftForContext('context:temporary')).toBeNull();
      expect(useChatStore.getState().getComposerDraftForContext('conversation:created')?.text)
        .toBe('Temporary draft');
      expect(useChatStore.getState().getComposerDraftForContext('conversation:existing')?.text)
        .toBe('Existing draft');

      useChatStore.getState().clearComposerDraftForContext('conversation:created');
      expect(useChatStore.getState().getComposerDraftForContext('conversation:created')).toBeNull();
    });

    it('removes a persisted composer draft after deleting its conversation', async () => {
      const { useChatStore } = await loadChatStore();
      const conversation = {
        ...createConversation('conversation-to-delete', ''),
        project_id: null,
        group_id: null,
        scope_mode: 'Chat' as const,
      };
      useChatStore.setState(createIdleChatStoreState({
        conversations: [conversation],
        selectedConversationId: conversation.id,
        selectedConversationIdsByMode: { Chat: conversation.id },
        composerDraftsByContextKey: {},
      }));
      useChatStore.getState().saveComposerDraftForContext(
        `conversation:${conversation.id}`,
        { text: 'Draft to delete', images: [], contextRefs: [] },
      );

      await useChatStore.getState().deleteConversation(conversation.id, { mode: 'chat' });

      expect(
        useChatStore.getState().getComposerDraftForContext(`conversation:${conversation.id}`),
      ).toBeNull();
    });

    it('drops an archived conversation draft and refuses to restore it', async () => {
      const { useChatStore } = await loadChatStore();
      const { useConversationArchiveStore } = await import('../useConversationArchiveStore');
      useChatStore.setState(createIdleChatStoreState({ composerDraftsByContextKey: {} }));
      useChatStore.getState().saveComposerDraftForContext('conversation:archived', {
        text: 'Private archived draft',
        images: [],
        contextRefs: [],
      });

      useConversationArchiveStore.getState().replaceArchivedConversationIds(['archived']);
      useChatStore.getState().discardComposerDraftForConversation('archived');
      useChatStore.getState().saveComposerDraftForContext('conversation:archived', {
        text: 'Must stay discarded',
        images: [],
        contextRefs: [],
      });

      expect(
        useChatStore.getState().getComposerDraftForContext('conversation:archived'),
      ).toBeNull();
    });

    it('clears Architect conversation selection when no plan is selected', async () => {
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(
        createIdleChatStoreState({
          conversations: [createConversation('conv-a')],
          selectedConversationId: null,
          selectedConversationIdsByMode: {},
          hydrationStatus: 'ready',
          restoreStatus: 'idle',
        }),
      );

      await useChatStore.getState().reapplySelectionForCurrentContext();

      expect(useChatStore.getState().selectedConversationId).toBeNull();
      expect(useChatStore.getState().selectedConversationIdsByMode.Architect).toBeNull();
      expect(useChatStore.getState().restoreStatus).toBe('ready');
      expect(getLocalProjectContextStateMock).not.toHaveBeenCalled();
      expect(createConversationMock).not.toHaveBeenCalled();
    });

    it('does not reuse remembered Architect conversations when no plan is selected', async () => {
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(
        createIdleChatStoreState({
          conversations: [createConversation('remembered-conv')],
          selectedConversationId: 'remembered-conv',
          selectedConversationIdsByMode: { Architect: 'remembered-conv' },
          hydrationStatus: 'ready',
          restoreStatus: 'ready',
        }),
      );

      const ensuredId = await useChatStore.getState().ensureConversationForCurrentMode();

      expect(ensuredId).toBeNull();
      expect(useChatStore.getState().selectedConversationId).toBeNull();
      expect(useChatStore.getState().selectedConversationIdsByMode.Architect).toBeNull();
      expect(getLocalProjectContextStateMock).not.toHaveBeenCalled();
      expect(createConversationMock).not.toHaveBeenCalled();
    });

    it('does not revive the only archived Chat conversation after clearing its selection', async () => {
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      const preferences = await import('../../services/preferences');
      await preferences.savePreference(
        preferences.PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS,
        ['archived-chat'],
      );
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(
        createIdleChatStoreState({
          conversations: [
            { ...createConversation('archived-chat'), scope_mode: 'Chat' },
          ],
          selectedConversationId: 'archived-chat',
          selectedConversationIdsByMode: {
            Chat: 'archived-chat',
            Architect: 'architect-selection-must-survive',
          },
          hydrationStatus: 'ready',
          restoreStatus: 'ready',
        }),
      );

      useChatStore.getState().clearSelectedConversation();

      expect(useChatStore.getState().selectedConversationId).toBeNull();
      expect(useChatStore.getState().selectedConversationIdsByMode.Chat).toBeNull();
      expect(useChatStore.getState().restoreStatus).toBe('ready');
      expect(
        useChatStore.getState().selectedConversationIdsByMode.Architect,
      ).toBe('architect-selection-must-survive');

      const ensuredId = await useChatStore
        .getState()
        .ensureConversationForCurrentMode();

      expect(ensuredId).toBeNull();
      expect(useChatStore.getState().selectedConversationId).toBeNull();
      expect(useChatStore.getState().selectedConversationIdsByMode.Chat).toBeNull();
    });

    it('rejects Architect sends before creating messages when no plan is selected', async () => {
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(
        createIdleChatStoreState({
          conversations: [createConversation('stale-architect-conv')],
          selectedConversationId: 'stale-architect-conv',
          selectedConversationIdsByMode: { Architect: 'stale-architect-conv' },
          hydrationStatus: 'ready',
          restoreStatus: 'ready',
        }),
      );

      await expect(
        useChatStore.getState().sendMessage({
          conversationId: 'stale-architect-conv',
          content: 'Prépare un plan.',
        }),
      ).rejects.toThrow('Select a plan before sending an Architect message.');

      expect(createMessageMock).not.toHaveBeenCalled();
      expect(streamChatMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().getConversationMessages('stale-architect-conv')).toHaveLength(0);
    });

    it('restores the provider, model, and thinking for the selected conversation', async () => {
      providerState.providerConfigs = [
        ...providerState.providerConfigs,
        {
          id: 'provider-2',
          name: 'Remote',
          providerType: 'openai',
          isEnabled: true,
          isLocal: true,
          hasStoredApiKey: false,
          apiKeyLoaded: true,
          apiKey: '',
        },
      ];
      providerState.modelsByProvider = {
        'provider-1': [{ id: 'model-1a', name: 'Model 1A', isEnabled: true }],
        'provider-2': [{ id: 'model-2a', name: 'Model 2A', isEnabled: true }],
      };

      await saveAiSelectionsPreference({
        version: 2,
        modeSelections: {
          Architect: {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
        },
        conversationSelections: {
          'conv-a': {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
          'conv-b': {
            providerId: 'provider-2',
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
        providerSelectionsByConversationId: {
          'conv-a': {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'low',
              updatedAt: '2026-03-19T00:00:00.000Z',
            },
          },
          'conv-b': {
            'provider-2': {
              modelId: 'model-2a',
              reasoningEffort: 'high',
              updatedAt: '2026-03-19T00:01:00.000Z',
            },
          },
        },
        providerSelectionsByMode: {
          Architect: {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'low',
              updatedAt: '2026-03-19T00:00:00.000Z',
            },
            'provider-2': {
              modelId: 'model-2a',
              reasoningEffort: 'high',
              updatedAt: '2026-03-19T00:01:00.000Z',
            },
          },
        },
      });

      context.tauriAvailable = true;
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('conv-a'),
        createChatSnapshotConversation('conv-b'),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();
      useChatStore.setState(
        createArchitectStoreState({
          conversations: [createConversation('conv-a'), createConversation('conv-b')],
          selectedConversationId: 'conv-a',
          selectedConversationIdsByMode: { Architect: 'conv-a' },
        }),
      );

      await useChatStore.getState().reapplySelectionForCurrentContext();

      expect(providerState.selectedProviderId).toBe('provider-1');
      expect(providerState.selectedModelId).toBe('model-1a');
      expect(providerState.selectedReasoningEffort).toBe('low');

      await useChatStore.getState().selectConversation('conv-b');

      expect(useChatStore.getState().selectedConversationId).toBe('conv-b');
      expect(providerState.selectedProviderId).toBe('provider-2');
      expect(providerState.selectedModelId).toBe('model-2a');
      expect(providerState.selectedReasoningEffort).toBe('high');
    });

    it('restores persisted toolbox composer source refs after selecting a conversation', async () => {
      context.tauriAvailable = true;
      context.citationRecords = [
        {
          id: 'source-1',
          type: 'source_passage',
          scope: 'source',
          source: 'notes.md',
          title: 'Persisted source',
          snippet: 'Important passage',
          messageId: 'assistant-1',
          conversationId: 'conv-b',
          timestamp: '2026-03-19T00:00:00.000Z',
          kind: 'used',
        },
      ];
      toolboxStateByConversationId.set('conv-b', {
        conversation_id: 'conv-b',
        composer_context_refs_json: JSON.stringify([
          {
            id: 'source-1',
            kind: 'source',
            title: 'Persisted source',
            subtitle: 'notes.md',
            sourceLabel: 'notes.md',
            snippet: 'Important passage',
          },
        ]),
        created_at: '2026-03-19T00:00:00.000Z',
        updated_at: '2026-03-19T00:00:00.000Z',
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(
        createArchitectStoreState({
          conversations: [createConversation('conv-a'), createConversation('conv-b')],
          selectedConversationId: 'conv-a',
          selectedConversationIdsByMode: { Architect: 'conv-a' },
        }),
      );
      useChatStore.setState({ composerContextRefs: [] });

      await useChatStore.getState().selectConversation('conv-b');

      expect(getConversationToolboxStateMock).toHaveBeenCalledWith('conv-b');
      expect(useChatStore.getState().composerContextRefs).toEqual([
        expect.objectContaining({
          id: 'source-1',
          kind: 'source',
          title: 'Persisted source',
          subtitle: 'notes.md',
          data: expect.objectContaining({
            id: 'source-1',
            conversationId: 'conv-b',
          }),
        }),
      ]);
    });

    it('ignores removed legacy context kinds while hydrating a conversation', async () => {
      context.tauriAvailable = true;
      toolboxStateByConversationId.set('conv-b', {
        conversation_id: 'conv-b',
        composer_context_refs_json: JSON.stringify([
          {
            id: 'legacy-ref-1',
            kind: ['ne', 'ed'].join(''),
            title: 'Legacy structured reference',
          },
        ]),
        created_at: '2026-03-19T00:00:00.000Z',
        updated_at: '2026-03-19T00:00:00.000Z',
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(
        createArchitectStoreState({
          conversations: [createConversation('conv-a'), createConversation('conv-b')],
          selectedConversationId: 'conv-a',
          selectedConversationIdsByMode: { Architect: 'conv-a' },
        }),
      );

      await useChatStore.getState().selectConversation('conv-b');

      expect(useChatStore.getState().composerContextRefs).toEqual([]);
    });

    it('ignores stale toolbox hydration after a newer conversation switch wins', async () => {
      context.tauriAvailable = true;
      context.citationRecords = [
        {
          id: 'source-a',
          type: 'source_passage',
          scope: 'source',
          source: 'a.md',
          title: 'Source A',
          snippet: 'Passage A',
          messageId: 'assistant-a',
          conversationId: 'conv-a',
          timestamp: '2026-03-19T00:00:00.000Z',
          kind: 'used',
        },
        {
          id: 'source-b',
          type: 'source_passage',
          scope: 'source',
          source: 'b.md',
          title: 'Source B',
          snippet: 'Passage B',
          messageId: 'assistant-b',
          conversationId: 'conv-b',
          timestamp: '2026-03-19T00:01:00.000Z',
          kind: 'used',
        },
      ];
      const staleToolboxState = createDeferred<{
        conversation_id: string;
        composer_context_refs_json: string;
        created_at: string;
        updated_at: string;
      } | null>();
      getConversationToolboxStateMock.mockImplementation(async (conversationId: string) => {
        if (conversationId === 'conv-a') {
          return staleToolboxState.promise;
        }
        if (conversationId === 'conv-b') {
          return {
            conversation_id: 'conv-b',
            composer_context_refs_json: JSON.stringify([
              {
                id: 'source-b',
                kind: 'source',
                title: 'Source B',
                subtitle: 'b.md',
                sourceLabel: 'b.md',
                snippet: 'Passage B',
              },
            ]),
            created_at: '2026-03-19T00:00:00.000Z',
            updated_at: '2026-03-19T00:00:00.000Z',
          };
        }
        return null;
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(
        createArchitectStoreState({
          conversations: [createConversation('conv-a'), createConversation('conv-b')],
          selectedConversationId: 'conv-b',
          selectedConversationIdsByMode: { Architect: 'conv-b' },
        }),
      );
      useChatStore.setState({ composerContextRefs: [] });

      const staleSwitch = useChatStore.getState().selectConversation('conv-a');
      await Promise.resolve();
      await Promise.resolve();
      const winningSwitch = useChatStore.getState().selectConversation('conv-b');

      await winningSwitch;
      staleToolboxState.resolve({
        conversation_id: 'conv-a',
        composer_context_refs_json: JSON.stringify([
          {
            id: 'source-a',
            kind: 'source',
            title: 'Source A',
            subtitle: 'a.md',
            sourceLabel: 'a.md',
            snippet: 'Passage A',
          },
        ]),
        created_at: '2026-03-19T00:00:00.000Z',
        updated_at: '2026-03-19T00:00:00.000Z',
      });
      await staleSwitch;

      expect(useChatStore.getState().selectedConversationId).toBe('conv-b');
      expect(useChatStore.getState().composerContextRefs).toEqual([
        expect.objectContaining({
          id: 'source-b',
          kind: 'source',
          title: 'Source B',
        }),
      ]);
    });

    it('persists and deletes toolbox composer refs for the selected conversation', async () => {
      context.tauriAvailable = true;
      const { useChatStore } = await loadChatStore();
      useChatStore.setState(
        createArchitectStoreState({
          conversations: [createConversation('conv-a')],
          selectedConversationId: 'conv-a',
          selectedConversationIdsByMode: { Architect: 'conv-a' },
        }),
      );
      useChatStore.setState({ composerContextRefs: [] });

      useChatStore.getState().addComposerContextRef({
        id: 'file-1',
        kind: 'file',
        title: 'README.md',
        subtitle: 'project-1',
        data: {
          id: 'file-1',
          path: 'README.md',
          relativePath: 'README.md',
          projectId: 'project-1',
          projectName: 'Project 1',
        },
      });
      await waitForToolboxPersistence();

      expect(upsertConversationToolboxStateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation_id: 'conv-a',
          composer_context_refs_json: expect.stringContaining('README.md'),
        }),
      );

      useChatStore.getState().clearComposerContextRefs();
      await waitForToolboxPersistence();

      expect(deleteConversationToolboxStateMock).toHaveBeenCalledWith('conv-a');
    });

    it('restores the conversation model from the database when preferences are empty', async () => {
      providerState.modelsByProvider = {
        'provider-1': [
          { id: 'model-1a', name: 'Model 1A', isEnabled: true },
          { id: 'model-1b', name: 'Model 1B', isEnabled: true },
        ],
      };

      await saveAiSelectionsPreference({
        version: 2,
        modeSelections: {},
        conversationSelections: {},
        providerSelectionsByConversationId: {},
        providerSelectionsByMode: {},
      });

      context.tauriAvailable = true;
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('conv-a', {
          provider_id: 'provider-1',
          model_id: 'model-1b',
          reasoning_effort: 'low',
        }),
      ];
      activateArchitectPlanForTest({ conversationId: 'conv-a' });

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();
      await useChatStore.getState().reapplySelectionForCurrentContext();

      expect(useChatStore.getState().selectedConversationId).toBe('conv-a');
      expect(providerState.selectedProviderId).toBe('provider-1');
      expect(providerState.selectedModelId).toBe('model-1b');
      expect(providerState.selectedReasoningEffort).toBe('low');

      const storedSelections = await loadAiSelectionsPreference();
      expect(storedSelections).toMatchObject({
        conversationSelections: {
          'conv-a': {
            providerId: 'provider-1',
            modelId: 'model-1b',
            reasoningEffort: 'low',
          },
        },
      });
    });

    it('prefers the database conversation model over a stale preference entry', async () => {
      providerState.modelsByProvider = {
        'provider-1': [
          { id: 'model-1a', name: 'Model 1A', isEnabled: true },
          { id: 'model-1b', name: 'Model 1B', isEnabled: true },
        ],
      };

      await saveAiSelectionsPreference({
        version: 2,
        modeSelections: {},
        conversationSelections: {
          'conv-a': {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'medium',
            updatedAt: '2026-03-18T00:00:00.000Z',
          },
        },
        providerSelectionsByConversationId: {},
        providerSelectionsByMode: {},
      });

      context.tauriAvailable = true;
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('conv-a', {
          provider_id: 'provider-1',
          model_id: 'model-1b',
          reasoning_effort: 'low',
          updated_at: '2026-03-19T00:00:00.000Z',
        }),
      ];
      activateArchitectPlanForTest({ conversationId: 'conv-a' });

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();
      await useChatStore.getState().reapplySelectionForCurrentContext();

      expect(providerState.selectedProviderId).toBe('provider-1');
      expect(providerState.selectedModelId).toBe('model-1b');
      expect(providerState.selectedReasoningEffort).toBe('low');

      const storedSelections = await loadAiSelectionsPreference();
      expect(storedSelections).toMatchObject({
        conversationSelections: {
          'conv-a': {
            providerId: 'provider-1',
            modelId: 'model-1b',
            reasoningEffort: 'low',
          },
        },
      });
    });

    it('marks restoreStatus as resolving while a manual conversation switch restores the AI selection', async () => {
      providerState.providerConfigs = [
        ...providerState.providerConfigs,
        {
          id: 'provider-2',
          name: 'Remote',
          providerType: 'openai',
          isEnabled: true,
          isLocal: true,
          hasStoredApiKey: false,
          apiKeyLoaded: true,
          apiKey: '',
        },
      ];
      providerState.modelsByProvider = {
        'provider-1': [{ id: 'model-1a', name: 'Model 1A', isEnabled: true }],
        'provider-2': [{ id: 'model-2a', name: 'Model 2A', isEnabled: true }],
      };

      await saveAiSelectionsPreference({
        version: 2,
        modeSelections: {
          Architect: {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
        },
        conversationSelections: {
          'conv-a': {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
          'conv-b': {
            providerId: 'provider-2',
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
        providerSelectionsByConversationId: {
          'conv-a': {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'low',
              updatedAt: '2026-03-19T00:00:00.000Z',
            },
          },
          'conv-b': {
            'provider-2': {
              modelId: 'model-2a',
              reasoningEffort: 'high',
              updatedAt: '2026-03-19T00:01:00.000Z',
            },
          },
        },
        providerSelectionsByMode: {
          Architect: {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'low',
              updatedAt: '2026-03-19T00:00:00.000Z',
            },
            'provider-2': {
              modelId: 'model-2a',
              reasoningEffort: 'high',
              updatedAt: '2026-03-19T00:01:00.000Z',
            },
          },
        },
      });

      context.tauriAvailable = true;
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('conv-a'),
        createChatSnapshotConversation('conv-b'),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();
      useChatStore.setState(
        createArchitectStoreState({
          conversations: [createConversation('conv-a'), createConversation('conv-b')],
          selectedConversationId: 'conv-a',
          selectedConversationIdsByMode: { Architect: 'conv-a' },
        }),
      );
      await useChatStore.getState().reapplySelectionForCurrentContext();

      const provider2Deferred = createDeferred();
      const baseCommit = createCommitRestoredSelectionMock();
      providerState.commitRestoredSelection = mock(async (selection, options) => {
        if (selection.providerId === 'provider-2') {
          await provider2Deferred.promise;
        }
        return baseCommit(selection, options);
      });

      const selectionPromise = useChatStore.getState().selectConversation('conv-b');
      await Promise.resolve();
      await Promise.resolve();

      expect(useChatStore.getState().selectedConversationId).toBe('conv-b');
      expect(useChatStore.getState().restoreStatus).toBe('resolving');

      provider2Deferred.resolve();
      await selectionPromise;

      expect(useChatStore.getState().restoreStatus).toBe('ready');
      expect(providerState.selectedProviderId).toBe('provider-2');
      expect(providerState.selectedModelId).toBe('model-2a');
      expect(providerState.selectedReasoningEffort).toBe('high');
    });

    it('keeps the latest manual conversation switch when two restores race', async () => {
      providerState.providerConfigs = [
        ...providerState.providerConfigs,
        {
          id: 'provider-2',
          name: 'Remote',
          providerType: 'openai',
          isEnabled: true,
          isLocal: true,
          hasStoredApiKey: false,
          apiKeyLoaded: true,
          apiKey: '',
        },
      ];
      providerState.modelsByProvider = {
        'provider-1': [{ id: 'model-1a', name: 'Model 1A', isEnabled: true }],
        'provider-2': [{ id: 'model-2a', name: 'Model 2A', isEnabled: true }],
      };

      await saveAiSelectionsPreference({
        version: 2,
        modeSelections: {
          Architect: {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
        },
        conversationSelections: {
          'conv-a': {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
          'conv-b': {
            providerId: 'provider-2',
            modelId: 'model-2a',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:01:00.000Z',
          },
        },
        providerSelectionsByConversationId: {
          'conv-a': {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'low',
              updatedAt: '2026-03-19T00:00:00.000Z',
            },
          },
          'conv-b': {
            'provider-2': {
              modelId: 'model-2a',
              reasoningEffort: 'high',
              updatedAt: '2026-03-19T00:01:00.000Z',
            },
          },
        },
        providerSelectionsByMode: {
          Architect: {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'low',
              updatedAt: '2026-03-19T00:00:00.000Z',
            },
            'provider-2': {
              modelId: 'model-2a',
              reasoningEffort: 'high',
              updatedAt: '2026-03-19T00:01:00.000Z',
            },
          },
        },
      });

      context.tauriAvailable = true;
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('conv-a'),
        createChatSnapshotConversation('conv-b'),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();
      useChatStore.setState(
        createArchitectStoreState({
          conversations: [createConversation('conv-a'), createConversation('conv-b')],
          selectedConversationId: 'conv-a',
          selectedConversationIdsByMode: { Architect: 'conv-a' },
        }),
      );
      await useChatStore.getState().reapplySelectionForCurrentContext();

      const provider1Deferred = createDeferred();
      const provider2Deferred = createDeferred();
      const provider1Completed = createDeferred();
      const provider2Completed = createDeferred();
      const baseCommit = createCommitRestoredSelectionMock();
      providerState.commitRestoredSelection = mock(async (selection, options) => {
        if (selection.providerId === 'provider-2') {
          await provider2Deferred.promise;
        }
        if (selection.providerId === 'provider-1') {
          await provider1Deferred.promise;
        }
        const committed = await baseCommit(selection, options);
        if (selection.providerId === 'provider-1') {
          provider1Completed.resolve();
        }
        if (selection.providerId === 'provider-2') {
          provider2Completed.resolve();
        }
        return committed;
      });

      const firstSwitch = useChatStore.getState().selectConversation('conv-b');
      await Promise.resolve();
      await Promise.resolve();

      const secondSwitch = useChatStore.getState().selectConversation('conv-a');
      await Promise.resolve();
      await Promise.resolve();

      provider1Deferred.resolve();
      await secondSwitch;
      provider2Deferred.resolve();
      await firstSwitch;

      expect(useChatStore.getState().selectedConversationId).toBe('conv-a');
      expect(providerState.selectedProviderId).toBe('provider-1');
      expect(providerState.selectedModelId).toBe('model-1a');
      expect(providerState.selectedReasoningEffort).toBe('low');
    });

    it('keeps the latest provider switch when provider restores race within a conversation', async () => {
      providerState.providerConfigs = [
        ...providerState.providerConfigs,
        {
          id: 'provider-2',
          name: 'Remote',
          providerType: 'openai',
          isEnabled: true,
          isLocal: true,
          hasStoredApiKey: false,
          apiKeyLoaded: true,
          apiKey: '',
        },
      ];
      providerState.modelsByProvider = {
        'provider-1': [{ id: 'model-1a', name: 'Model 1A', isEnabled: true }],
        'provider-2': [{ id: 'model-2a', name: 'Model 2A', isEnabled: true }],
      };

      await saveAiSelectionsPreference({
        version: 2,
        modeSelections: {
          Architect: {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
        },
        conversationSelections: {
          'conv-a': {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
        },
        providerSelectionsByConversationId: {
          'conv-a': {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'low',
              updatedAt: '2026-03-19T00:00:00.000Z',
            },
            'provider-2': {
              modelId: 'model-2a',
              reasoningEffort: 'high',
              updatedAt: '2026-03-19T00:01:00.000Z',
            },
          },
        },
        providerSelectionsByMode: {
          Architect: {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'low',
              updatedAt: '2026-03-19T00:00:00.000Z',
            },
            'provider-2': {
              modelId: 'model-2a',
              reasoningEffort: 'high',
              updatedAt: '2026-03-19T00:01:00.000Z',
            },
          },
        },
      });

      context.tauriAvailable = true;
      context.chatSnapshotConversations = [createChatSnapshotConversation('conv-a')];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();
      useChatStore.setState(
        createArchitectStoreState({
          conversations: [createConversation('conv-a')],
          selectedConversationId: 'conv-a',
          selectedConversationIdsByMode: { Architect: 'conv-a' },
        }),
      );
      await useChatStore.getState().reapplySelectionForCurrentContext();

      const provider1Deferred = createDeferred();
      const provider2Deferred = createDeferred();
      const provider1Completed = createDeferred();
      const provider2Completed = createDeferred();
      const baseCommit = createCommitRestoredSelectionMock();
      providerState.commitRestoredSelection = mock(async (selection, options) => {
        if (selection.providerId === 'provider-2') {
          await provider2Deferred.promise;
        }
        if (selection.providerId === 'provider-1') {
          await provider1Deferred.promise;
        }
        const committed = await baseCommit(selection, options);
        if (selection.providerId === 'provider-1') {
          provider1Completed.resolve();
        }
        if (selection.providerId === 'provider-2') {
          provider2Completed.resolve();
        }
        return committed;
      });

      providerState.selectProvider('provider-2');
      await Promise.resolve();
      await Promise.resolve();

      providerState.selectProvider('provider-1');
      await Promise.resolve();
      await Promise.resolve();

      provider1Deferred.resolve();
      await provider1Completed.promise;
      provider2Deferred.resolve();
      await provider2Completed.promise;
      await flushAsyncWork();

      expect(providerState.selectedProviderId).toBe('provider-1');
      expect(providerState.selectedModelId).toBe('model-1a');
      expect(providerState.selectedReasoningEffort).toBe('low');
    });

    it('remembers the last model and thinking used for each provider within a conversation', async () => {
      providerState.providerConfigs = [
        ...providerState.providerConfigs,
        {
          id: 'provider-2',
          name: 'Remote',
          providerType: 'openai',
          isEnabled: true,
          isLocal: true,
          hasStoredApiKey: false,
          apiKeyLoaded: true,
          apiKey: '',
        },
      ];
      providerState.modelsByProvider = {
        'provider-1': [{ id: 'model-1b', name: 'Model 1B', isEnabled: true }],
        'provider-2': [{ id: 'model-2b', name: 'Model 2B', isEnabled: true }],
      };

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();
      useChatStore.setState(createArchitectStoreState());

      useProviderStoreMock.setState({
        selectedProviderId: 'provider-1',
        selectedModelId: 'model-1b',
        selectedReasoningEffort: 'low',
      });
      await flushAsyncWork();

      useProviderStoreMock.setState({
        selectedProviderId: 'provider-2',
        selectedModelId: 'model-2b',
        selectedReasoningEffort: 'high',
      });
      await flushAsyncWork();

      providerState.selectProvider('provider-1');
      await flushAsyncWork();

      expect(providerState.selectedProviderId).toBe('provider-1');
      expect(providerState.selectedModelId).toBe('model-1b');
      expect(providerState.selectedReasoningEffort).toBe('low');

      providerState.selectProvider('provider-2');
      await flushAsyncWork();

      expect(providerState.selectedProviderId).toBe('provider-2');
      expect(providerState.selectedModelId).toBe('model-2b');
      expect(providerState.selectedReasoningEffort).toBe('high');
    });

    it('inherits only the active provider-model-thinking pair when creating a new conversation', async () => {
      providerState.providerConfigs = [
        ...providerState.providerConfigs,
        {
          id: 'provider-2',
          name: 'Remote',
          providerType: 'openai',
          isEnabled: true,
          isLocal: true,
          hasStoredApiKey: false,
          apiKeyLoaded: true,
          apiKey: '',
        },
      ];
      providerState.modelsByProvider = {
        'provider-1': [
          { id: 'model-1a', name: 'Model 1A', isEnabled: true },
          { id: 'model-1b', name: 'Model 1B', isEnabled: true },
        ],
        'provider-2': [{ id: 'model-2b', name: 'Model 2B', isEnabled: true }],
      };

      await saveAiSelectionsPreference({
        version: 2,
        modeSelections: {
          Architect: {
            providerId: 'provider-2',
            modelId: 'model-2b',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:02:00.000Z',
          },
        },
        conversationSelections: {
          'conv-source': {
            providerId: 'provider-2',
            modelId: 'model-2b',
            reasoningEffort: 'high',
            updatedAt: '2026-03-19T00:02:00.000Z',
          },
        },
        providerSelectionsByConversationId: {
          'conv-source': {
            'provider-1': {
              modelId: 'model-1b',
              reasoningEffort: 'low',
              updatedAt: '2026-03-19T00:00:00.000Z',
            },
            'provider-2': {
              modelId: 'model-2b',
              reasoningEffort: 'high',
              updatedAt: '2026-03-19T00:02:00.000Z',
            },
          },
        },
        providerSelectionsByMode: {
          Architect: {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'medium',
              updatedAt: '2026-03-19T00:01:00.000Z',
            },
            'provider-2': {
              modelId: 'model-2b',
              reasoningEffort: 'high',
              updatedAt: '2026-03-19T00:02:00.000Z',
            },
          },
        },
      });

      context.tauriAvailable = true;
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('conv-source'),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();
      useChatStore.setState(
        createArchitectStoreState({
          conversations: [createConversation('conv-source')],
          selectedConversationId: 'conv-source',
          selectedConversationIdsByMode: { Architect: 'conv-source' },
        }),
      );

      await useChatStore.getState().reapplySelectionForCurrentContext();
      const createdConversation = await useChatStore
        .getState()
        .createConversation('New Conversation', null, 'project-1');
      await flushAsyncWork();

      expect(useChatStore.getState().selectedConversationId).toBe(createdConversation.id);
      expect(providerState.selectedProviderId).toBe('provider-2');
      expect(providerState.selectedModelId).toBe('model-2b');
      expect(providerState.selectedReasoningEffort).toBe('high');

      providerState.selectProvider('provider-1');
      await flushAsyncWork();

      expect(providerState.selectedProviderId).toBe('provider-1');
      expect(providerState.selectedModelId).toBe('model-1a');
      expect(providerState.selectedReasoningEffort).toBe('medium');
    });

    it('migrates legacy AI context selections to version 2 and preserves the restored selection', async () => {
      providerState.modelsByProvider = {
        'provider-1': [{ id: 'model-1a', name: 'Model 1A', isEnabled: true }],
      };

      await saveAiSelectionsPreference({
        version: 1,
        modeSelections: {
          Architect: {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
        },
        conversationSelections: {
          'conv-a': {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
            updatedAt: '2026-03-19T00:00:00.000Z',
          },
        },
      });

      context.tauriAvailable = true;
      context.chatSnapshotConversations = [
        createChatSnapshotConversation('conv-a'),
      ];

      const { useChatStore } = await loadChatStore();
      await useChatStore.getState().initialize();
      useChatStore.setState(
        createArchitectStoreState({
          conversations: [createConversation('conv-a')],
          selectedConversationId: 'conv-a',
          selectedConversationIdsByMode: { Architect: 'conv-a' },
        }),
      );

      await useChatStore.getState().reapplySelectionForCurrentContext();

      expect(providerState.selectedProviderId).toBe('provider-1');
      expect(providerState.selectedModelId).toBe('model-1a');
      expect(providerState.selectedReasoningEffort).toBe('low');

      const storedSelections = await loadAiSelectionsPreference();
      expect(storedSelections).toMatchObject({
        version: 2,
        conversationSelections: {
          'conv-a': {
            providerId: 'provider-1',
            modelId: 'model-1a',
            reasoningEffort: 'low',
          },
        },
        providerSelectionsByConversationId: {
          'conv-a': {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'low',
            },
          },
        },
        providerSelectionsByMode: {
          Architect: {
            'provider-1': {
              modelId: 'model-1a',
              reasoningEffort: 'low',
            },
          },
        },
      });
    });
  });
};
