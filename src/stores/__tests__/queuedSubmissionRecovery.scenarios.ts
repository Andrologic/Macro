import { describe, expect, it } from 'bun:test';
import { loadQueuedSubmissions, QUEUED_SUBMISSIONS_STORAGE_KEY } from '../chat/chatQueuedSubmissions';
import { useConversationArchiveStore } from '../useConversationArchiveStore';
import { beginAppShutdownGate } from '../../services/appShutdownGate';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export function registerQueuedSubmissionRecoveryScenarios(c: UseChatStoreScenarioContext) {
  const prepare = async () => {
    c.tauriAvailable = true;
    c.appState.mode = 'Chat';
    const { useChatStore: store } = await c.loadChatStore();
    store.setState(c.createIdleChatStoreState({
      conversations: [{ ...c.createConversation('queued-conv'), scope_mode: 'Chat', task_id: null }],
      selectedConversationId: 'queued-conv',
      conversationRuntimeById: { 'queued-conv': { phase: 'streaming', sessionId: 'active', turnId: 'active-turn' } },
    }));
    return store;
  };
  const release = (store: Awaited<ReturnType<typeof prepare>>) => {
    store.setState({ conversationRuntimeById: {}, isStreaming: false });
  };

  describe('queued submission recovery through the real send contract', () => {
    it('retains a failed pre-persistence send across restart and retries once', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Keep this message' }, 'queue');
      const accepted = loadQueuedSubmissions();
      expect(accepted).toHaveLength(1);
      c.createMessageMock.mockImplementationOnce(async () => { throw new Error('disk unavailable'); });
      release(store);
      await store.getState().retryQueuedSubmissions('queued-conv');
      expect(loadQueuedSubmissions()).toEqual(accepted);
      expect(c.streamChatMock).not.toHaveBeenCalled();
      const { useChatStore: restarted } = await c.loadChatStore();
      restarted.setState(c.createIdleChatStoreState({ conversations: store.getState().conversations }));
      await restarted.getState().retryQueuedSubmissions('queued-conv');
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(c.createMessageMock.mock.calls.filter(call => call[1] === 'user')).toHaveLength(2);
      expect(c.createMessageMock.mock.calls.at(-2)?.[3]?.turnId).toBe(accepted[0].id);
      expect(c.streamChatMock).toHaveBeenCalledTimes(1);
    });

    it('retains original mode, provider and references after navigation', async () => {
      const store = await prepare();
      const ref = { id: 'file:readme', kind: 'file' as const, title: 'README', path: '/synthetic/README.md' };
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Read original', contextRefs: [ref] }, 'queue');
      ref.title = 'Changed';
      c.appState.mode = 'Architect';
      c.appState.activeArchitectPlanId = 'different-plan';
      c.providerState.selectedProviderId = 'different-provider';
      c.providerState.selectedModelId = 'different-model';
      release(store);
      await store.getState().retryQueuedSubmissions('queued-conv');
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(c.createMessageMock.mock.calls[0]?.[3]?.contextRefs).toMatchObject([{ title: 'README' }]);
      expect(c.streamChatMock).toHaveBeenCalledTimes(1);
      expect(c.getLatestStreamOptions()).toMatchObject({ providerId: 'provider-1' });
    });

    it('keeps the Architect plan after selecting a different plan and mode', async () => {
      const store = await prepare();
      c.appState.mode = 'Architect';
      c.appState.activeArchitectPlanId = 'original-plan';
      c.appState.activePlanContext = { id: 'original-plan', targetBranch: 'develop' };
      const plan = c.createPlan({ id: 'original-plan', conversationId: 'queued-conv' });
      c.architectPlans.set(plan.id, plan);
      store.setState({ conversations: [{ ...c.createConversation('queued-conv'), scope_mode: 'Architect', task_id: null }] });
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Original plan discussion' }, 'queue');
      c.appState.mode = 'Chat';
      c.appState.activeArchitectPlanId = 'different-plan';
      release(store);
      await store.getState().retryQueuedSubmissions('queued-conv');
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(c.streamChatMock).toHaveBeenCalledTimes(1);
      expect(c.getArchitectPlanMock).toHaveBeenCalledWith('develop', 'original-plan');
      expect(c.getArchitectPlanMock).not.toHaveBeenCalledWith(expect.anything(), 'different-plan');
    });

    it('reconciles an already saved turn without another user message or stream', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Already saved' }, 'queue');
      const [entry] = loadQueuedSubmissions();
      c.listMessagesMock.mockImplementationOnce(async () => [{
        id: 'saved-user', conversation_id: 'queued-conv', role: 'user', content: 'Already saved',
        turn_id: entry.id, created_at: '2026-09-22T00:00:00Z',
      }]);
      release(store);
      await Promise.all([store.getState().retryQueuedSubmissions('queued-conv'), store.getState().retryQueuedSubmissions('queued-conv')]);
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(c.createMessageMock).not.toHaveBeenCalled();
      expect(c.streamChatMock).not.toHaveBeenCalled();
      expect(store.getState().getConversationMessages('queued-conv')).toMatchObject([{ id: 'saved-user' }]);
    });

    it('rejects acceptance on storage failure so the caller can retain its draft', async () => {
      const store = await prepare();
      const storage = window.localStorage;
      const setItem = storage.setItem;
      storage.setItem = (key, value) => {
        if (key === QUEUED_SUBMISSIONS_STORAGE_KEY) throw new Error('quota');
        setItem.call(storage, key, value);
      };
      try {
        await expect(store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Unsaved' }, 'queue')).rejects.toThrow('could not be saved');
        expect(loadQueuedSubmissions()).toEqual([]);
      } finally { storage.setItem = setItem; }
    });

    it('does not send a queued message through a provider disabled since acceptance', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Retained' }, 'queue');
      const configs = c.providerState.providerConfigs;
      c.providerState.providerConfigs = configs.map(config => ({ ...config, isEnabled: false }));
      try {
        release(store);
        await store.getState().retryQueuedSubmissions('queued-conv');
        expect(loadQueuedSubmissions()).toHaveLength(1);
        expect(c.createMessageMock).not.toHaveBeenCalled();
        expect(c.streamChatMock).not.toHaveBeenCalled();
      } finally { c.providerState.providerConfigs = configs; }
    });

    it('keeps accepted messages on shutdown without starting another turn', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'After restart' }, 'queue');
      const releaseShutdown = beginAppShutdownGate();
      release(store);
      try {
        await store.getState().retryQueuedSubmissions('queued-conv');
        expect(loadQueuedSubmissions()).toHaveLength(1);
        expect(c.createMessageMock).not.toHaveBeenCalled();
      } finally { releaseShutdown(); }
    });

    it('pauses archived conversations and removes the queue on conversation deletion', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Retained' }, 'queue');
      release(store);
      useConversationArchiveStore.setState({ archivedConversationIds: new Set(['queued-conv']) });
      try {
        await store.getState().retryQueuedSubmissions('queued-conv');
        expect(loadQueuedSubmissions()).toHaveLength(1);
        expect(c.createMessageMock).not.toHaveBeenCalled();
      } finally { useConversationArchiveStore.setState({ archivedConversationIds: new Set() }); }
      await store.getState().deleteConversation('queued-conv');
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(c.streamChatMock).not.toHaveBeenCalled();
    });

    it('retains attachments when the user message is saved but image storage fails', async () => {
      const store = await prepare();
      const images = [{ id: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AQID', createdAt: '2026-09-22T00:00:00Z' }];
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Image', images }, 'queue');
      const storage = window.localStorage;
      const setItem = storage.setItem;
      storage.setItem = (key, value) => {
        if (key === 'macro_chat_message_images') throw new Error('quota');
        setItem.call(storage, key, value);
      };
      release(store);
      try { await store.getState().retryQueuedSubmissions('queued-conv'); }
      finally { storage.setItem = setItem; }
      const [entry] = loadQueuedSubmissions();
      expect(entry.input.images).toEqual(images);
      expect(c.streamChatMock).not.toHaveBeenCalled();
      c.listMessagesMock.mockImplementationOnce(async () => [{
        id: 'saved-image-user', conversation_id: 'queued-conv', role: 'user', content: 'Image',
        turn_id: entry.id, created_at: '2026-09-22T00:00:00Z',
      }]);
      release(store);
      await store.getState().retryQueuedSubmissions('queued-conv');
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(store.getState().getMessageImages('saved-image-user')).toEqual(images);
      expect(c.createMessageMock.mock.calls.filter(call => call[1] === 'user')).toHaveLength(1);
    });
  });
}
