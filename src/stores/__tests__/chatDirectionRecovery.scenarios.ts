import { describe, expect, it } from 'bun:test';
import type { ChatMessage } from '../../types';
import type { StreamingChatOptions, StreamMessage } from '../../services/ai/contracts';
import { createStreamAccumulator } from '../../services/ai/streamAccumulator';
import { runToolCallingLoop } from '../../services/ai/toolCallingLoop';
import { serializeAgsdlChatContext } from '../../services/agsdl/selectionContext';
import { loadQueuedSubmissions, QUEUED_SUBMISSIONS_STORAGE_KEY } from '../chat/chatQueuedSubmissions';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export function registerChatDirectionRecoveryScenarios(c: UseChatStoreScenarioContext) {
  const conversationId = 'direction-pipeline';
  const content = 'Inspect the direction image';
  const images = [{ id: 'direction-image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AQID', createdAt: '2026-01-01' }];
  const hiddenContext = '<private_message_metadata>PRIVATE_DIRECTION_PREFIX</private_message_metadata>\n' + serializeAgsdlChatContext({
    id: 'agent', conversationId, document: 'agsdl', planId: 'plan', branchName: 'develop',
    version: 'direction-version', persistedRevision: 1, path: '/agents/helper', title: 'Direction helper',
  });
  const payload = { conversationId, content, images, hiddenContext, contextRefs: [] };
  const createHarness = async (kind: 'generic' | 'native' = 'generic') => {
    c.tauriAvailable = true; c.appState.mode = 'Chat';
    const originals = { create: c.createMessageMock.getMockImplementation()!, list: c.listMessagesMock.getMockImplementation()!,
      stream: c.streamChatMock.getMockImplementation()!, instructions: c.repositoryInstructionsLoadMock.getMockImplementation()!, update: c.updateMessageMock.getMockImplementation()! };
    const rows: Awaited<ReturnType<typeof c.createMessageMock>>[] = [];
    c.createMessageMock.mockImplementation(async (...args) => { const row = await originals.create(...args); rows.push(row); return row; });
    c.listMessagesMock.mockImplementation(async id => rows.filter(row => row.conversation_id === id));
    const release = c.createDeferred<void>(); const entered = c.createDeferred<void>();
    const requests: StreamMessage[][] = []; let overflow = false;
    c.streamChatMock.mockImplementation(async options => {
      const actual = options as unknown as StreamingChatOptions;
      const result = await runToolCallingLoop({ ...actual, maxTurns: 3 }, {
        kind, streamTurn: async ({ messages }) => {
          requests.push(structuredClone(messages));
          if (requests.length === 1) { entered.resolve(); await release.promise; if (overflow) throw new Error('maximum context length exceeded: 128000 tokens'); }
          return { result: { content: 'Confirmed answer', toolCalls: [], completionReason: 'completed' }, projectAssistant: () => ({ items: [] }) };
        }, projectTool: result => result.content, afterToolResults() {},
      }, createStreamAccumulator(actual));
      actual.onComplete(result); return { usage: null };
    });
    const { useChatStore: store } = await c.loadChatStore();
    store.setState(c.createIdleChatStoreState({ conversations: [{ ...c.createConversation(conversationId), scope_mode: 'Chat', task_id: null }],
      selectedConversationId: conversationId, selectedConversationIdsByMode: { Chat: conversationId } }));
    const start = () => store.getState().sendMessage({ conversationId, content: 'Initial request', contextRefs: [] });
    return { store, start, rows, requests, release, entered, originals, overflow: () => { overflow = true; },
      async close() { release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        c.createMessageMock.mockImplementation(originals.create); c.listMessagesMock.mockImplementation(originals.list);
        c.streamChatMock.mockImplementation(originals.stream); c.repositoryInstructionsLoadMock.mockImplementation(originals.instructions); c.updateMessageMock.mockImplementation(originals.update); } };
  };
  const assertFiltered = (message: StreamMessage) => {
    for (const wire of [JSON.stringify(message.content), ...(message.provider_input_items ? [JSON.stringify(message.provider_input_items)] : [])]) {
      expect(wire).not.toContain('PRIVATE_DIRECTION_PREFIX'); expect(wire).not.toContain('private_message_metadata');
      expect(wire.split('<agsdl_selection>').length - 1).toBe(1); expect(wire).toContain('direction-version');
    }
  };
  const directionMessages = (messages: StreamMessage[]) => messages.filter(message => JSON.stringify(message.content).includes(content));

  describe('durable active directions through the store and shared provider loop', () => {
    for (const kind of ['generic', 'native'] as const) it(`filters direct delivery and retires only after request and persistence: ${kind}`, async () => {
      const h = await createHarness(kind);
      try {
        const first = await h.start(); await h.entered.promise;
        expect(await h.store.getState().submitDuringActiveTurn(payload, 'steer')).toBe('steered');
        const [entry] = loadQueuedSubmissions();
        expect(entry.direction?.target.turnId).toBe(first.turnId);
        expect(entry.direction?.userMessageId).toBe(h.rows.find(row => row.content === content)?.id);
        expect(h.rows.find(row => row.content === content)?.hidden_context).toBe(hiddenContext);
        expect(entry.direction?.delivery).toBeUndefined();
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(h.requests).toHaveLength(2); const [direction] = directionMessages(h.requests[1]);
        expect(directionMessages(h.requests[1])).toHaveLength(1); assertFiltered(direction);
        expect(JSON.stringify(direction.content)).toContain(images[0].dataUrl);
        expect(loadQueuedSubmissions()).toEqual([]);
      } finally { await h.close(); }
    });

    it('returns late DB acceptance as recovery and retries the same user and images after navigation', async () => {
      const h = await createHarness(); const dbRelease = c.createDeferred<void>();
      try {
        const first = await h.start(); await h.entered.promise;
        const create = c.createMessageMock.getMockImplementation()!;
        c.createMessageMock.mockImplementation(async (...args) => { const row = await create(...args); if (args[2] === content) await dbRelease.promise; return row; });
        const submitting = h.store.getState().submitDuringActiveTurn(payload, 'steer');
        await c.flushAsyncWork(); expect(loadQueuedSubmissions()).toHaveLength(1);
        const userId = loadQueuedSubmissions()[0].direction!.userMessageId;
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(h.store.getState().getConversationRuntime(conversationId).phase).toBe('idle');
        c.appState.mode = 'Architect'; c.providerState.selectedProviderId = 'foreign'; c.providerState.selectedModelId = 'foreign-model';
        const foreignRefs = [{ id: 'foreign', kind: 'file' as const, title: 'Other draft', path: '/synthetic/foreign.txt' }];
        h.store.setState({ selectedConversationId: 'foreign', composerContextRefs: foreignRefs });
        dbRelease.resolve(); expect(await submitting).toBe('queued');
        expect(h.requests).toHaveLength(1); expect(loadQueuedSubmissions()).toHaveLength(1);
        // A completed predecessor of the same turn is not the recovery assistant.
        const originalAssistant = h.rows.find(row => row.id === first.assistantMessageId)!;
        Object.assign(originalAssistant, { completion_reason: 'completed' });
        await h.store.getState().retryQueuedSubmissions(conversationId); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(c.createMessageMock.mock.calls.filter(call => call[1] === 'user' && call[2] === content)).toHaveLength(1);
        expect(h.rows.filter(row => row.id === userId)).toHaveLength(1);
        expect(h.requests).toHaveLength(2); const [direction] = directionMessages(h.requests[1]); assertFiltered(direction);
        expect(JSON.stringify(direction.content)).toContain(images[0].dataUrl);
        expect(h.store.getState().messageImagesByMessageId[userId]).toEqual(images);
        expect(h.store.getState().composerContextRefs).toEqual(foreignRefs);
        expect(c.getLatestStreamOptions()).toMatchObject({ providerId: 'provider-1', modelId: 'model-1' });
        expect(loadQueuedSubmissions()).toEqual([]);
      } finally { dbRelease.resolve(); await h.close(); }
    });

    for (const persisted of [false, true]) it(`recovers a DB acknowledgement by exact UUID, persisted=${persisted}`, async () => {
      const h = await createHarness();
      try {
        await h.start(); await h.entered.promise; const create = c.createMessageMock.getMockImplementation()!;
        c.createMessageMock.mockImplementation(async (...args) => {
          if (args[2] !== content) return create(...args);
          if (persisted) await create(...args); throw new Error('DB acknowledgement lost');
        });
        expect(await h.store.getState().submitDuringActiveTurn(payload, 'steer')).toBe(persisted ? 'steered' : 'queued');
        expect(loadQueuedSubmissions()).toHaveLength(1);
        c.createMessageMock.mockImplementation(create);
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(h.requests).toHaveLength(persisted ? 2 : 1);
        if (!persisted) { await h.store.getState().retryQueuedSubmissions(conversationId); await c.flushAsyncWork(); await c.flushAsyncWork(); }
        expect(h.rows.filter(row => row.role === 'user' && row.content === content)).toHaveLength(1);
        expect(loadQueuedSubmissions()).toEqual([]);
      } finally { await h.close(); }
    });

    it('excludes a preparing direction from the initial body and delivers it only at the next request', async () => {
      const h = await createHarness(); const ready = c.createDeferred<void>(); const preparing = c.createDeferred<void>();
      try {
        c.repositoryInstructionsLoadMock.mockImplementation(async (...args) => { preparing.resolve(); await ready.promise; return h.originals.instructions(...args); });
        const sending = h.start(); await preparing.promise;
        expect(h.store.getState().getConversationRuntime(conversationId).phase).toBe('preparing');
        expect(await h.store.getState().submitDuringActiveTurn(payload, 'steer')).toBe('steered');
        ready.resolve(); await sending; await h.entered.promise;
        expect(directionMessages(h.requests[0])).toEqual([]);
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(directionMessages(h.requests[1])).toHaveLength(1); expect(loadQueuedSubmissions()).toEqual([]);
      } finally { ready.resolve(); await h.close(); }
    });

    it('overflow excludes a pending direction and leaves the original entry explicitly recoverable', async () => {
      const h = await createHarness();
      try {
        h.overflow(); await h.start(); await h.entered.promise;
        expect(await h.store.getState().submitDuringActiveTurn(payload, 'steer')).toBe('steered');
        const accepted = loadQueuedSubmissions()[0];
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(h.requests).toHaveLength(2); expect(directionMessages(h.requests[1])).toEqual([]);
        expect(loadQueuedSubmissions()).toMatchObject([{ id: accepted.id, direction: { userMessageId: accepted.direction!.userMessageId } }]);
        expect(loadQueuedSubmissions()[0].direction?.delivery).toBeUndefined();
        expect(h.store.getState().queuedSubmissionRecoveryByConversationId[conversationId].count).toBe(1);
      } finally { await h.close(); }
    });

    it('retires a delivered direction after retrying the exact unsaved assistant without another provider request', async () => {
      const h = await createHarness();
      try {
        await h.start(); await h.entered.promise;
        expect(await h.store.getState().submitDuringActiveTurn(payload, 'steer')).toBe('steered');
        c.updateMessageMock.mockImplementation(async (_id, answer) => { if (answer?.includes('Confirmed answer')) throw new Error('final DB unavailable'); });
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(loadQueuedSubmissions()).toHaveLength(1); expect(loadQueuedSubmissions()[0].direction?.delivery?.requestEnded).toBe(true);
        const assistant = h.store.getState().getConversationMessages(conversationId).find((message: ChatMessage) => message.role === 'assistant' && message.persistence_state === 'failed')!;
        expect(assistant).toBeDefined(); expect(h.requests).toHaveLength(2);
        c.updateMessageMock.mockImplementation(h.originals.update);
        await h.store.getState().retryAssistantPersistence(assistant.id); await c.flushAsyncWork();
        expect(loadQueuedSubmissions()).toEqual([]); expect(h.requests).toHaveLength(2);
        expect(h.rows.filter(row => row.role === 'user' && row.content === content)).toHaveLength(1);
      } finally { await h.close(); }
    });

    it('refuses an intent-storage failure before DB and keeps the composer revision', async () => {
      const h = await createHarness(); const storage = window.localStorage, write = storage.setItem;
      try {
        await h.start(); await h.entered.promise;
        const refs = [{ id: 'draft', kind: 'file' as const, title: 'Draft', path: '/synthetic/draft.txt' }];
        h.store.setState({ composerContextRefs: refs });
        const users = h.rows.filter(row => row.role === 'user').length;
        storage.setItem = (key, value) => { if (key === QUEUED_SUBMISSIONS_STORAGE_KEY) throw new Error('queue quota'); write.call(storage, key, value); };
        await expect(h.store.getState().submitDuringActiveTurn(payload, 'steer')).rejects.toThrow('could not be saved');
        expect(h.rows.filter(row => row.role === 'user')).toHaveLength(users); expect(h.store.getState().composerContextRefs).toEqual(refs);
        expect(loadQueuedSubmissions()).toEqual([]);
      } finally { storage.setItem = write; await h.close(); }
    });
  });
}
