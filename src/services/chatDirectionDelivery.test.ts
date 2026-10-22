import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ChatMessage, ConversationRuntimeState } from '../types';
import { EMPTY_CONVERSATION_RUNTIME } from '../domains/chat/runtimeState';
import { chatSendFixture } from '../test-utils/chatSendFixture';
import { createChatTurnRuntime, type ChatTurnIdentity } from './chatTurnRuntime';
import { createQueuedSubmissionRuntime } from '../stores/chat/chatQueuedSubmissionRuntime';
import { loadQueuedSubmissions, type QueuedSubmission } from '../stores/chat/chatQueuedSubmissions';
import { createStreamAccumulator } from './ai/streamAccumulator';
import { runToolCallingLoop, type ToolCallingAdapter } from './ai/toolCallingLoop';
import type { StreamingChatOptions, StreamMessage } from './ai/contracts';

const previousWindow = globalThis.window;
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } } });
});
afterEach(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow }));

function fixture(readBarrier?: Promise<void>) {
  const send = chatSendFixture();
  const identity = { conversationId: 'conversation-1', sessionId: 'original-session',
    turnId: 'original-turn', assistantMessageId: 'original-assistant' } satisfies ChatTurnIdentity;
  const controller = new AbortController();
  const states = new Map<string, ConversationRuntimeState>();
  const rows: ChatMessage[] = [];
  const sendRecovery = mock(async (_entry: QueuedSubmission, _saved?: ChatMessage) => ({
    status: 'sent' as const, conversationId: identity.conversationId, turnId: identity.turnId,
    userMessageId: 'direction-message', assistantMessageId: 'recovery-assistant',
  }));
  const queue = createQueuedSubmissionRuntime({
    blocked: id => states.get(id)?.phase === 'streaming', cancelled: () => false,
    read: async () => { if (readBarrier) await readBarrier; return rows; }, send: sendRecovery, publish: () => {}, saveImages: () => true,
    recovery: () => {}, previews: () => {}, pending: () => {}, attempted: () => {},
  });
  const owner = createChatTurnRuntime({
    state: { read: id => states.get(id) ?? EMPTY_CONVERSATION_RUNTIME,
      project: (id, state) => { if (state) states.set(id, state); else states.delete(id); }, isDeleted: () => false },
    cancelTransport: () => {}, settled: () => {},
    directions: {
      attempt: (ids, current, requestId) => queue.markDirectionDelivery(ids, current, requestId),
      ended: (ids, _current, requestId) => queue.directionRequestEnded(ids, requestId),
      confirmed: (ids, current) => queue.confirmDirections(ids, current.assistantMessageId),
      recover: id => queue.pause(id),
    },
  });
  owner.rememberSession(identity.conversationId, identity.sessionId);
  owner.set(identity.conversationId, { ...identity, phase: 'preparing', abortController: controller, lastError: null });
  const accepts = owner.claimStream(identity, controller)!;
  const entry = queue.capture('direction-id', { ...send.input, images: [{ id: 'image', mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,AQID', createdAt: '2026-01-01' }] }, send.snapshot);
  entry.direction = { userMessageId: 'direction-message', target: { ...identity } };
  queue.accept(entry);
  rows.push({ id: 'direction-message', conversation_id: identity.conversationId, turn_id: identity.turnId,
    task_id: '', role: 'user', content: send.input.content, timestamp: '2026-01-01' });
  const enqueue = () => owner.enqueueSteer(identity.conversationId, { role: 'user', content: 'Direction' }, identity, entry.id);
  const options: StreamingChatOptions = {
    providerId: 'fixture', providerType: 'openai', modelId: 'fixture', baseUrl: 'https://example.invalid',
    messages: [{ role: 'user', content: 'Initial request' }], signal: controller.signal,
    enableWebSearch: false, enableWebFetch: false, onToken() {}, onComplete() {}, onError(error) { throw error; },
    hasPendingSteers: () => accepts() && owner.hasPendingSteers(identity),
    preparePendingSteers: requestId => owner.deliverSteers(identity, requestId, accepts),
    onSteerRequestEnded: requestId => owner.steerRequestEnded(identity, requestId), isRequestCurrent: accepts,
  };
  return { identity, controller, owner, queue, entry, rows, sendRecovery, enqueue, options, accepts };
}

for (const kind of ['generic', 'native'] as const) {
  describe(`${kind} durable direction pipeline`, () => {
    for (const budget of [3, 4]) {
      test(`preserves the last frontier with budget ${budget}`, async () => {
        const h = fixture(); const requests: StreamMessage[][] = [];
        const result = await runToolCallingLoop({ ...h.options, maxTurns: budget, allowedToolIds: ['read'], onToolCall: async () => 'result' }, {
          kind, streamTurn: async ({ messages }) => {
            requests.push(structuredClone(messages));
            if (requests.length === 3) h.enqueue();
            if (requests.length < 3) return { result: { content: '', toolCalls: [{ id: `tool-${requests.length}`, type: 'function', function: { name: 'read', arguments: '{}' } }] }, projectAssistant: () => ({ items: [] }) };
            return { result: { content: 'Answer', toolCalls: [], completionReason: 'completed' }, projectAssistant: () => ({ items: [] }) };
          }, projectTool: result => result.content, afterToolResults() {},
        }, createStreamAccumulator(h.options));
        expect(result.visibleContent).toContain('Answer');
        expect(requests).toHaveLength(budget);
        const [saved] = loadQueuedSubmissions();
        expect(saved.direction?.userMessageId).toBe('direction-message');
        if (budget === 3) {
          expect(saved.direction?.delivery).toBeUndefined();
          h.owner.beginCompletion(h.identity); h.owner.confirmSteers(h.identity);
          expect(loadQueuedSubmissions()).toHaveLength(1);
        } else {
          expect(requests[3].filter(message => message.content === 'Direction')).toHaveLength(1);
          expect(saved.direction?.delivery?.requestEnded).toBe(true);
          // Merely finishing a request does not retire a durable direction.
          expect(loadQueuedSubmissions()).toHaveLength(1);
          h.owner.beginCompletion(h.identity); h.owner.confirmSteers(h.identity);
          expect(loadQueuedSubmissions()).toHaveLength(0);
        }
      });
    }
    test('never consumes during compaction at the last tool iteration', async () => {
      const h = fixture(); let requests = 0;
      const options = { ...h.options, maxTurns: 3, allowedToolIds: ['read'],
        onToolCall: async () => 'confirmed result', onBeforeFollowUpRequest: async ({ messages }: { messages: StreamMessage[] }) => {
          if (requests === 3) h.enqueue(); return messages;
        } };
      const adapter: ToolCallingAdapter = { kind, streamTurn: async () => {
        requests += 1;
        return { result: { content: '', toolCalls: [{ id: `tool-${requests}`, type: 'function', function: { name: 'read', arguments: '{"path":"fixture"}' } }] },
          projectAssistant: () => ({ items: [] }) };
      }, projectTool: result => result.content, afterToolResults() {} };
      const result = await runToolCallingLoop(options, adapter, createStreamAccumulator(options));
      expect(result.completionReason).toBe('tool_turn_limit'); expect(requests).toBe(3);
      expect(loadQueuedSubmissions()[0].direction?.delivery).toBeUndefined();
      expect(h.owner.hasPendingSteers(h.identity)).toBe(true);
    });
    test('a possible delivery is never automatically replayed after an effect', async () => {
      const h = fixture(); let requests = 0; let effects = 0;
      await expect(runToolCallingLoop({ ...h.options, maxTurns: 2 }, {
        kind, streamTurn: async () => {
          requests += 1;
          if (requests === 1) { h.enqueue(); return { result: { content: 'First', toolCalls: [] }, projectAssistant: () => ({ items: [] }) }; }
          effects += 1; throw new Error('Connection lost after effect');
        }, projectTool: result => result.content, afterToolResults() {},
      }, createStreamAccumulator(h.options))).rejects.toThrow('Connection lost');
      h.owner.reset(); h.owner.set(h.identity.conversationId, null);
      await h.queue.retry(h.identity.conversationId);
      expect(effects).toBe(1); expect(h.sendRecovery).not.toHaveBeenCalled();
      expect(loadQueuedSubmissions()[0].direction?.delivery?.requestEnded).toBe(false);
    });
  });
}

test('a rejected durable delivery marker prevents any provider handoff', async () => {
  const h = fixture(); h.enqueue();
  window.localStorage.setItem = () => { throw new Error('quota'); };
  expect(() => h.owner.deliverSteers(h.identity, 'request-2', h.accepts)).toThrow('could not be saved');
  expect(loadQueuedSubmissions()[0].direction?.delivery).toBeUndefined();
  expect(h.owner.hasPendingSteers(h.identity)).toBe(true);
});

test('a storage observer can Stop after the marker without a late provider request', async () => {
  const h = fixture(); h.enqueue();
  const write = window.localStorage.setItem;
  window.localStorage.setItem = (key, value) => { write(key, value); h.controller.abort(); };
  expect(h.owner.deliverSteers(h.identity, 'request-2', h.accepts)).toEqual([]);
  expect(loadQueuedSubmissions()[0].direction?.delivery?.requestEnded).toBe(false);
});

test('an earlier completed assistant never confirms a new direction of the same turn', async () => {
  const h = fixture(); h.owner.set(h.identity.conversationId, null);
  h.rows.unshift({ id: 'original-assistant', conversation_id: h.identity.conversationId, turn_id: h.identity.turnId,
    task_id: '', role: 'assistant', content: 'Earlier answer', timestamp: '2026-01-01', completion_reason: 'completed' });
  await h.queue.retry(h.identity.conversationId);
  expect(h.sendRecovery).toHaveBeenCalledWith(expect.objectContaining({ id: 'direction-id' }), expect.objectContaining({ id: 'direction-message' }));
  expect(loadQueuedSubmissions()).toHaveLength(1);
});

for (const end of ['stop', 'reset', 'release'] as const) {
  test(`${end} preserves accepted direction content and images`, async () => {
    const h = fixture(); h.enqueue();
    if (end === 'stop') await h.owner.stop(h.identity.conversationId);
    else if (end === 'reset') h.owner.reset();
    else { h.owner.track(h.identity.conversationId, Promise.resolve()); await new Promise(resolve => setImmediate(resolve)); }
    expect(loadQueuedSubmissions()[0]).toMatchObject({ id: 'direction-id', direction: { userMessageId: 'direction-message' }, input: { images: h.entry.input.images } });
    expect(h.sendRecovery).not.toHaveBeenCalled();
  });
}

test('a DB await owned by an old generation does not enqueue into its overflow replacement', () => {
  const h = fixture(); const captured = h.owner.captureSteerOwner(h.identity.conversationId);
  h.owner.set(h.identity.conversationId, { ...h.identity, phase: 'preparing', abortController: h.controller, lastError: null });
  h.owner.claimStream(h.identity, h.controller);
  expect(captured.isCurrent()).toBe(false);
  expect(h.accepts()).toBe(false);
});


test('turn deletion invalidates sibling directions while preserving another conversation', async () => {
  const h = fixture();
  const sibling = structuredClone(h.entry); sibling.id = 'sibling-direction'; sibling.direction!.userMessageId = 'sibling-user';
  const other = structuredClone(h.entry); other.id = 'other-direction'; other.input.conversationId = 'other-conversation'; other.direction!.userMessageId = 'other-user';
  h.queue.accept(sibling); h.queue.accept(other);
  const ids = await h.queue.invalidateDirectionTurns(h.identity.conversationId, [h.identity.turnId]);
  h.queue.finishDirectionDeletion(ids);
  expect(loadQueuedSubmissions().map(entry => entry.id)).toEqual(['other-direction']);
});

test('request ended plus a saved exact assistant retires recovery after restart without a replay', async () => {
  const h = fixture(); h.enqueue();
  h.owner.deliverSteers(h.identity, 'request-2', h.accepts); h.owner.steerRequestEnded(h.identity, 'request-2'); h.owner.reset();
  h.owner.set(h.identity.conversationId, null);
  h.rows.push({ id: h.identity.assistantMessageId, conversation_id: h.identity.conversationId, turn_id: h.identity.turnId,
    task_id: '', role: 'assistant', content: 'Confirmed', timestamp: '2026-01-01', completion_reason: 'completed' });
  await h.queue.retry(h.identity.conversationId);
  expect(loadQueuedSubmissions()).toEqual([]); expect(h.sendRecovery).not.toHaveBeenCalled();
});

test('a replacement generation recovers the prior pending batch before accepting its own', () => {
  const h = fixture(); h.enqueue();
  h.owner.set(h.identity.conversationId, { ...h.identity, phase: 'preparing', abortController: h.controller, lastError: null });
  const next = h.owner.claimStream(h.identity, h.controller)!;
  expect(h.owner.deliverSteers(h.identity, 'successor-request', next)).toEqual([]);
  expect(loadQueuedSubmissions()[0].direction?.delivery).toBeUndefined();
  expect(h.owner.deliverSteers(h.identity, 'late-original-request', h.accepts)).toEqual([]);
});

for (const detach of ['confirmed', 'remove', 'restore'] as const) {
  test(`${detach} keeps active IO discoverable by turn invalidation until it settles`, async () => {
    const h = fixture();
    let resolveWrite!: () => void;
    const pending = new Promise<void>(resolve => { resolveWrite = resolve; });
    const writing = h.queue.writeDirection(h.entry.id, () => pending);
    await Promise.resolve();
    if (detach === 'confirmed') {
      h.enqueue();
      h.owner.deliverSteers(h.identity, 'request', h.accepts);
      h.owner.steerRequestEnded(h.identity, 'request');
      h.queue.confirmDirections([h.entry.id], h.identity.assistantMessageId);
    } else if (detach === 'remove') h.queue.remove([h.identity.conversationId]);
    else h.queue.restore([]);
    expect(loadQueuedSubmissions()).toEqual([]);
    let invalidated = false;
    const invalidating = h.queue.invalidateDirectionTurns(h.identity.conversationId, [h.identity.turnId])
      .then(ids => { invalidated = true; return ids; });
    await Promise.resolve(); await Promise.resolve();
    expect(invalidated).toBe(false);
    expect(loadQueuedSubmissions()[0].direction?.deletionRequested).toBe(true);
    await expect(h.queue.writeDirection(h.entry.id, async () => {})).rejects.toThrow('invalidated');
    resolveWrite(); await writing;
    const ids = await invalidating;
    expect(ids).toEqual([h.entry.id]);
    h.queue.finishDirectionDeletion(ids);
    expect(loadQueuedSubmissions()).toEqual([]);
  });
}


test('manual removal holds the mutation lock across its read and refuses a simultaneous retry or write', async () => {
  let releaseRead!: () => void;
  const readBarrier = new Promise<void>(resolve => { releaseRead = resolve; });
  const h = fixture(readBarrier);
  h.queue.pause(h.identity.conversationId);
  h.owner.set(h.identity.conversationId, null);
  const removing = h.queue.removeEntry(h.entry.id);
  try {
    await expect(h.queue.retry(h.identity.conversationId)).rejects.toThrow('finish');
    await expect(h.queue.writeDirection(h.entry.id, async () => {})).rejects.toThrow('finish');
    expect(loadQueuedSubmissions()).toHaveLength(1);
  } finally { releaseRead(); await removing; }
  expect(loadQueuedSubmissions()).toEqual([]);
  expect(h.sendRecovery).not.toHaveBeenCalled();
});
