import type { DbMessage } from '../../services/tauriIpc';
import { createQueuedSubmissionRuntime } from '../chat/chatQueuedSubmissionRuntime';
import { loadConversationMessages, type ChatPersistenceAdapters } from '../../services/chatPersistenceService';
import { describe, expect, it, mock } from 'bun:test';
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
        expect(await h.store.getState().submitDuringActiveTurn({ ...payload, taskId: 'foreign-task' }, 'steer')).toBe('steered');
        const [entry] = loadQueuedSubmissions();
        expect(entry.direction?.target.turnId).toBe(first.turnId);
        expect(entry.input.taskId).toBeUndefined();
        expect(h.store.getState().getConversationMessages(conversationId).find((message: ChatMessage) => message.content === content)?.task_id).toBe('');
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
        h.rows.find(row => row.id === userId)!.provider_input_items_json = JSON.stringify([
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_DIRECTION_PREFIX first stale user' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_DIRECTION_PREFIX second stale user' }] },
        ]);
        h.store.getState().updateMessageFields(userId, { provider_input_items: JSON.parse(h.rows.find(row => row.id === userId)!.provider_input_items_json!) });
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

    it('keeps delivery recovery while the exact assistant has only placeholder or progress writes', async () => {
      const h = await createHarness();
      const finalEntered = c.createDeferred<void>(); const finalRelease = c.createDeferred<void>();
      c.streamChatMock.mockImplementation(async options => {
        const actual = options as unknown as StreamingChatOptions;
        const result = await runToolCallingLoop({ ...actual, maxTurns: 3 }, {
          kind: 'generic', streamTurn: async ({ messages }) => {
            h.requests.push(structuredClone(messages));
            if (h.requests.length === 1) { h.entered.resolve(); await h.release.promise; }
            return { result: { content: '', toolCalls: [], completionReason: 'completed' }, projectAssistant: () => ({ items: [] }) };
          }, projectTool: r => r.content, afterToolResults() {},
        }, createStreamAccumulator(actual));
        actual.onComplete(result); return { usage: null };
      });
      try {
        const first = await h.start(); await h.entered.promise;
        expect(await h.store.getState().submitDuringActiveTurn(payload, 'steer')).toBe('steered');
        c.updateMessageMock.mockImplementation(async (id, answer, options) => {
          const row = h.rows.find(r => r.id === id)!;
          if (options?.completionReason === 'completed') {
            finalEntered.resolve(); await finalRelease.promise;
            Object.assign(row, { content: answer, completion_reason: options.completionReason });
          } else Object.assign(row, { content: answer ?? '', generation_attempts_json: JSON.stringify(options?.generationAttempts) });
        });
        h.release.resolve(); await finalEntered.promise;
        expect(loadQueuedSubmissions()[0].direction?.delivery?.requestEnded).toBe(true);
        const assistant = h.rows.find(r => r.id === first.assistantMessageId)!;
        const send = mock(async () => { throw new Error('Unexpected provider replay'); });
        for (const progress of ['', 'Partial checkpoint']) {
          assistant.content = progress;
          const queue = createQueuedSubmissionRuntime({ blocked: () => false, cancelled: () => false,
            read: id => loadConversationMessages({ isTauriAvailable: () => true, ipc: { listMessages: c.listMessagesMock } } as unknown as ChatPersistenceAdapters,
              { conversationId: id, conversations: h.store.getState().conversations }),
            send, publish() {}, saveImages: () => true, recovery() {}, previews() {}, pending() {}, attempted() {},
          });
          await queue.retry(conversationId);
          expect(loadQueuedSubmissions()).toHaveLength(1); expect(send).not.toHaveBeenCalled();
        }
        finalRelease.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect((assistant as Partial<DbMessage>).completion_reason).toBe('completed'); expect(loadQueuedSubmissions()).toEqual([]);
      } finally { finalRelease.resolve(); await h.close(); }
    });

    it('confirms an optional-reason final save after reload without replaying its request', async () => {
      const h = await createHarness(); const storage = window.localStorage, write = storage.setItem;
      try {
        const first = await h.start(); await h.entered.promise;
        expect(await h.store.getState().submitDuringActiveTurn(payload, 'steer')).toBe('steered');
        c.updateMessageMock.mockImplementation(async (id, answer, options) => {
          Object.assign(h.rows.find(row => row.id === id)!, { content: answer, completion_reason: options?.completionReason });
        });
        // The real loop produces request-ended; this transport omits the completion reason.
        const options = c.getLatestStreamOptions<{ onComplete: StreamingChatOptions['onComplete'] }>();
        const complete = options.onComplete;
        options.onComplete = result => complete({ ...result, completionReason: undefined });
        storage.setItem = (key, value) => {
          if (key === QUEUED_SUBMISSIONS_STORAGE_KEY && JSON.parse(value).length === 0) throw new Error('Removal unavailable');
          write.call(storage, key, value);
        };
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(loadQueuedSubmissions()).toHaveLength(1);
        expect((h.rows.find(row => row.id === first.assistantMessageId) as Partial<DbMessage>).completion_reason).toBe('completed');
        storage.setItem = write;
        const { useChatStore: restarted } = await c.loadChatStore();
        restarted.setState(c.createIdleChatStoreState({ conversations: h.store.getState().conversations }));
        await restarted.getState().retryQueuedSubmissions(conversationId); await c.flushAsyncWork();
        expect(loadQueuedSubmissions()).toEqual([]); expect(h.requests).toHaveLength(2);
      } finally { storage.setItem = write; await h.close(); }
    });

    it('invalidates unpublished directions before awaiting their DB writes and deleting the turn', async () => {
      const h = await createHarness(); const dbRelease = c.createDeferred<void>();
      try {
        await h.start(); await h.entered.promise;
        const create = c.createMessageMock.getMockImplementation()!;
        c.createMessageMock.mockImplementation(async (...args) => { if (args[2] === content) await dbRelease.promise; return create(...args); });
        const submitting = h.store.getState().submitDuringActiveTurn(payload, 'steer'); await c.flushAsyncWork();
        c.updateMessageMock.mockImplementation(async () => { throw new Error('Final save unavailable'); });
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        const assistant = h.store.getState().getConversationMessages(conversationId).find((m: ChatMessage) => m.persistence_state === 'failed')!;
        c.deleteConversationTurnMock.mockImplementation(async (id, turn) => {
          for (let i = h.rows.length - 1; i >= 0; i--) if (h.rows[i].conversation_id === id && h.rows[i].turn_id === turn) h.rows.splice(i, 1);
        });
        const deleting = h.store.getState().deleteUnsavedAssistantResponse(assistant.id);
        await c.flushAsyncWork();
        expect(loadQueuedSubmissions()[0].direction?.deletionRequested).toBe(true);
        expect(c.deleteConversationTurnMock).not.toHaveBeenCalled();
        dbRelease.resolve(); await submitting; await deleting;
        expect(h.rows).toEqual([]); expect(loadQueuedSubmissions()).toEqual([]);
        expect(h.store.getState().getConversationMessages(conversationId)).toEqual([]);
        await expect(h.store.getState().retryAssistantPersistence(assistant.id)).rejects.toThrow('not waiting');
        await h.store.getState().retryQueuedSubmissions(conversationId);
        expect(h.requests).toHaveLength(1);
      } finally { dbRelease.resolve(); await h.close(); }
    });

    for (const refuseBeforeDeletion of [false, true]) it(`keeps deletion and recovery coherent when queue storage refuses, before=${refuseBeforeDeletion}`, async () => {
      const h = await createHarness(); const dbRelease = c.createDeferred<void>();
      const storage = window.localStorage, write = storage.setItem;
      let dbDeleted = false;
      try {
        await h.start(); await h.entered.promise;
        const create = c.createMessageMock.getMockImplementation()!;
        c.createMessageMock.mockImplementation(async (...args) => { const row = await create(...args); if (args[2] === content) await dbRelease.promise; return row; });
        const submitting = h.store.getState().submitDuringActiveTurn(payload, 'steer'); await c.flushAsyncWork();
        c.updateMessageMock.mockImplementation(async () => { throw new Error('Final save unavailable'); });
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        dbRelease.resolve(); await submitting;
        const assistant = h.store.getState().getConversationMessages(conversationId).find((m: ChatMessage) => m.persistence_state === 'failed')!;
        c.deleteConversationTurnMock.mockImplementation(async (id, turn) => {
          for (let i = h.rows.length - 1; i >= 0; i--) if (h.rows[i].conversation_id === id && h.rows[i].turn_id === turn) h.rows.splice(i, 1);
          dbDeleted = true;
        });
        storage.setItem = (key, value) => {
          if (key === QUEUED_SUBMISSIONS_STORAGE_KEY && (refuseBeforeDeletion || dbDeleted)) throw new Error('Queue write unavailable');
          write.call(storage, key, value);
        };
        if (refuseBeforeDeletion) {
          await expect(h.store.getState().deleteUnsavedAssistantResponse(assistant.id)).rejects.toThrow('could not be saved');
          expect(dbDeleted).toBe(false); expect(h.rows.some(r => r.id === assistant.id)).toBe(true);
        } else {
          await h.store.getState().deleteUnsavedAssistantResponse(assistant.id);
          expect(h.rows).toEqual([]); expect(h.store.getState().getConversationMessages(conversationId)).toEqual([]);
          expect(loadQueuedSubmissions()[0].direction?.deletionRequested).toBe(true);
          await expect(h.store.getState().retryAssistantPersistence(assistant.id)).rejects.toThrow('not waiting');
          const { useChatStore: restarted } = await c.loadChatStore();
          restarted.setState(c.createIdleChatStoreState({ conversations: h.store.getState().conversations }));
          await restarted.getState().retryQueuedSubmissions(conversationId);
          expect(h.requests).toHaveLength(1); expect(h.rows).toEqual([]);
          storage.setItem = write;
          await restarted.getState().retryQueuedSubmissions(conversationId);
          expect(loadQueuedSubmissions()[0].direction?.deletionRequested).toBe(true);
          await restarted.getState().removeQueuedSubmission(loadQueuedSubmissions()[0].id);
          expect(loadQueuedSubmissions()).toEqual([]); expect(h.requests).toHaveLength(1);
        }
      } finally { storage.setItem = write; dbRelease.resolve(); await h.close(); }
    });

    it('keeps a committed replay trim coherent when durable direction cleanup refuses', async () => {
      const h = await createHarness(); const dbRelease = c.createDeferred<void>();
      const storage = window.localStorage, write = storage.setItem;
      let trimmed = false;
      try {
        await h.start(); await h.entered.promise;
        const create = c.createMessageMock.getMockImplementation()!;
        c.createMessageMock.mockImplementation(async (...args) => { const row = await create(...args); if (args[2] === content) await dbRelease.promise; return row; });
        const submitting = h.store.getState().submitDuringActiveTurn(payload, 'steer'); await c.flushAsyncWork();
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork(); dbRelease.resolve(); await submitting;
        const originalUser = h.rows.find(row => row.role === 'user' && row.content === 'Initial request')!;
        c.dbPrepareConversationReplayMock.mockImplementation(async params => {
          const anchorIndex = h.rows.findIndex(row => row.id === params.messageId);
          h.rows.splice(anchorIndex + 1);
          originalUser.content = params.content;
          trimmed = true;
        });
        storage.setItem = (key, value) => {
          if (key === QUEUED_SUBMISSIONS_STORAGE_KEY && trimmed) throw new Error('Cleanup unavailable after replay DB commit');
          write.call(storage, key, value);
        };
        await h.store.getState().editMessage(originalUser.id, 'Edited request', { skipAgentCodeReplayCheck: true });
        await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(trimmed).toBe(true); expect(loadQueuedSubmissions()[0].direction?.deletionRequested).toBe(true);
        expect(h.rows.some(row => row.content === content)).toBe(false);
        expect(h.store.getState().getConversationMessages(conversationId).some((m: ChatMessage) => m.content === content)).toBe(false);
        expect(h.requests).toHaveLength(2); expect(directionMessages(h.requests[1])).toEqual([]);
        const { useChatStore: restarted } = await c.loadChatStore();
        restarted.setState(c.createIdleChatStoreState({ conversations: h.store.getState().conversations }));
        storage.setItem = write;
        await restarted.getState().retryQueuedSubmissions(conversationId); await c.flushAsyncWork();
        expect(h.requests).toHaveLength(2); expect(h.rows.some(row => row.content === content)).toBe(false);
        expect(restarted.getState().queuedSubmissionRecoveryByConversationId[conversationId].error).toContain('invalidated');
      } finally { storage.setItem = write; dbRelease.resolve(); await h.close(); }
    });

    it('reuses the captured source passages after DB failure and still revalidates access', async () => {
      const h = await createHarness();
      try {
        c.chatSnapshotConversations = [c.createChatSnapshotConversation(conversationId, { project_id: 'project-1', title: 'Target' }),
          c.createChatSnapshotConversation('direction-source', { project_id: 'project-1', title: 'Source' })];
        c.chatSnapshotMessages = [{ id: 'source-first', conversation_id: 'direction-source', role: 'assistant',
          content: 'SOURCE ORIGINAL', created_at: '2026-01-01', completion_reason: 'completed' }];
        await h.start(); await h.entered.promise;
        const create = c.createMessageMock.getMockImplementation()!;
        c.createMessageMock.mockImplementation(async (...args) => { if (args[2] === content) throw new Error('User write unavailable'); return create(...args); });
        expect(await h.store.getState().submitDuringActiveTurn({ ...payload, contextRefs: [
          { id: 'direction-source', kind: 'conversation', conversationId: 'direction-source', title: 'Source' },
        ] }, 'steer')).toBe('queued');
        const originalRefs = loadQueuedSubmissions()[0].input.contextRefs;
        expect(originalRefs?.[0].snippet).toContain('SOURCE ORIGINAL');
        const userId = loadQueuedSubmissions()[0].direction!.userMessageId;
        h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        c.chatSnapshotMessages = [{ id: 'source-second', conversation_id: 'direction-source', role: 'assistant',
          content: 'SOURCE CHANGED', created_at: '2026-01-02', completion_reason: 'completed' }];
        c.createMessageMock.mockImplementation(create);
        const source = c.chatSnapshotConversations.pop()!;
        await h.store.getState().retryQueuedSubmissions(conversationId); await c.flushAsyncWork();
        expect(h.requests).toHaveLength(1); expect(loadQueuedSubmissions()).toHaveLength(1);
        expect(h.rows.some(row => row.id === userId)).toBe(false);
        c.chatSnapshotConversations.push(source);
        await h.store.getState().retryQueuedSubmissions(conversationId); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(JSON.parse(h.rows.find(row => row.id === userId)!.context_refs_json!)).toEqual(originalRefs);
        expect(h.requests).toHaveLength(2);
        expect(JSON.stringify(h.requests[1])).toContain('SOURCE ORIGINAL'); expect(JSON.stringify(h.requests[1])).not.toContain('SOURCE CHANGED');
        expect(loadQueuedSubmissions()).toEqual([]);
      } finally { await h.close(); }
    });

    it('recovers a legacy direction from its saved user passages without reinterpreting the source', async () => {
      const h = await createHarness(); const dbRelease = c.createDeferred<void>();
      try {
        c.chatSnapshotConversations = [c.createChatSnapshotConversation(conversationId, { project_id: 'project-1' }),
          c.createChatSnapshotConversation('legacy-source', { project_id: 'project-1' })];
        c.chatSnapshotMessages = [{ id: 'original-source', conversation_id: 'legacy-source', role: 'user',
          content: 'ORIGINAL LEGACY PASSAGE', created_at: '2026-01-01' }];
        await h.start(); await h.entered.promise;
        const create = c.createMessageMock.getMockImplementation()!;
        c.createMessageMock.mockImplementation(async (...args) => { const row = await create(...args); if (args[2] === content) await dbRelease.promise; return row; });
        const submitting = h.store.getState().submitDuringActiveTurn({ ...payload, contextRefs: [
          { id: 'legacy-source', kind: 'conversation', title: 'Source', conversationId: 'legacy-source' },
        ] }, 'steer');
        await c.flushAsyncWork(); h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        dbRelease.resolve(); await submitting;
        const entry = loadQueuedSubmissions()[0];
        const originalRefs = JSON.parse(h.rows.find(row => row.id === entry.direction!.userMessageId)!.context_refs_json!);
        entry.input.contextRefs = entry.input.contextRefs!.map(({ snippet: _snippet, sourceUpdatedAt: _version, ...ref }) => ref);
        window.localStorage.setItem(QUEUED_SUBMISSIONS_STORAGE_KEY, JSON.stringify([entry]));
        c.chatSnapshotMessages = [{ id: 'changed-source', conversation_id: 'legacy-source', role: 'user',
          content: 'CHANGED LEGACY PASSAGE', created_at: '2026-01-02' }];
        const { useChatStore: restarted } = await c.loadChatStore();
        restarted.setState(c.createIdleChatStoreState({ conversations: h.store.getState().conversations }));
        await restarted.getState().retryQueuedSubmissions(conversationId); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(h.rows.filter(row => row.id === entry.direction!.userMessageId)).toHaveLength(1);
        expect(JSON.parse(h.rows.find(row => row.id === entry.direction!.userMessageId)!.context_refs_json!)).toEqual(originalRefs);
        expect(h.requests).toHaveLength(2);
        expect(JSON.stringify(h.requests[1])).toContain('ORIGINAL LEGACY PASSAGE');
        expect(JSON.stringify(h.requests[1])).not.toContain('CHANGED LEGACY PASSAGE');
        expect(loadQueuedSubmissions()).toEqual([]);
      } finally { dbRelease.resolve(); await h.close(); }
    });

    it('omits a stopped empty placeholder from reload and resumed provider history while retaining the user', async () => {
      const h = await createHarness();
      c.streamChatMock.mockImplementation(async options => {
        const actual = options as unknown as StreamingChatOptions;
        if (!h.requests.length) { h.requests.push(structuredClone(actual.messages)); h.entered.resolve(); await h.release.promise; return { usage: null }; }
        const result = await runToolCallingLoop(actual, { kind: 'generic', streamTurn: async ({ messages }) => {
          h.requests.push(structuredClone(messages)); return { result: { content: 'Recovered', toolCalls: [], completionReason: 'completed' }, projectAssistant: () => ({ items: [] }) };
        }, projectTool: r => r.content, afterToolResults() {} }, createStreamAccumulator(actual));
        actual.onComplete(result); return { usage: null };
      });
      try {
        const first = await h.start(); await h.entered.promise;
        expect(await h.store.getState().submitDuringActiveTurn(payload, 'steer')).toBe('steered');
        h.store.getState().stopConversationStream(conversationId); h.release.resolve(); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(h.rows.some(row => row.id === first.assistantMessageId)).toBe(true);
        h.store.setState({ messageLoadStatusByConversationId: {}, messages: [], messagesByConversationId: {}, messageIndexById: {} });
        await h.store.getState().ensureMessagesLoaded(conversationId);
        expect(h.store.getState().getConversationMessages(conversationId).some((m: ChatMessage) => m.id === first.assistantMessageId)).toBe(false);
        await h.store.getState().retryQueuedSubmissions(conversationId); await c.flushAsyncWork(); await c.flushAsyncWork();
        expect(h.requests[1].some(m => m.role === 'assistant' && m.content === '')).toBe(false);
        expect(h.rows.filter(row => row.role === 'user' && row.content === content)).toHaveLength(1);
        expect(loadQueuedSubmissions()).toEqual([]);
      } finally { await h.close(); }
    });
  });
}
