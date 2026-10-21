import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ConversationCaptures, type ConversationActivity, type ConversationRef } from '../../src/services/macroPilot/conversationCaptures';
import { ContentHost } from '../../src/services/macroPilot/contentHost';
import { createReviewCaptureService } from '../../src/services/macroPilot/reviewCapture';
import { validateContentMessage, validateContentResponse, CONVERSATION_READ_OPERATIONS, type ContentDelivery, type ContentRequest } from '../../src/services/macroPilot/contentProtocol';
import type { InteractionState } from '../../src/services/macroPilot/conversationInteractions';
import type { DbConversation, DbMessage } from '../../src/services/tauriIpc';
import { fixtureMessages, profiles } from '../../contracts/macro-connect/metrics/v1/fixtures.mjs';

const date = profiles.fixture.seed_timestamp as string;
const epoch = Date.parse(date);
const forbidden = async (): Promise<never> => { throw new Error('Forbidden producer-fixture side effect'); };
const memory = () => {
  let value: string | null = null;
  return { load: async () => value, compareAndSwap: async (previous: string | null, next: string) => {
    if (previous !== value) return false;
    value = next; return true;
  } };
};
export type ProducerEvent = {
  target: string; phase: string; kind: string; sequence: number; resource: string; revision: number; atMs: number; sha256: string;
};
export type ExpectedProducerEvent = Omit<ProducerEvent, 'sha256'>;
/** Explicit baseline oracle, independent of the events observed from the host.
 * Streams have independent sequences. There is no cross-target total order. */
export function expectedProducerTrace(scenario: string): ExpectedProducerEvent[] {
  const pair = (target: string, phase: string, atMs: number, revision: number, firstSequence: number, conversation = 'active'): ExpectedProducerEvent[] => [
    { target, phase, atMs, revision, sequence: firstSequence, kind: 'conversations.changed', resource: 'instance' },
    { target, phase, atMs, revision, sequence: firstSequence + 1, kind: 'conversation.resource_changed', resource: `synthetic-${conversation}` },
  ];
  if (scenario === 'visible-unrelated-update') return [
    ...pair('pc-a', 'other-change', 1000, 2, 1, 'other'),
    ...pair('pc-a', 'active-change', 2000, 3, 3),
    ...pair('pc-a', 'error', 3000, 4, 5),
    { target: 'pc-a', phase: 'interaction', atMs: 4000, revision: 2, sequence: 7, kind: 'conversation.interactions_changed', resource: 'synthetic-active' },
    ...pair('pc-a', 'finish', 5000, 5, 8),
    { target: 'pc-a', phase: 'finish', atMs: 5000, revision: 3, sequence: 10, kind: 'conversation.interactions_changed', resource: 'synthetic-active' },
  ];
  if (scenario === 'foreground-reconnect') {
    // The ACK is lost at 500ms, but the stored event retains its original time.
    return pair('pc-a', 'resumed', 500, 2, 1);
  }
  if (scenario === 'multiple-targets') return [
    ...pair('pc-a', 'append-2000', 2000, 2, 1),
    ...pair('pc-slow', 'append-2000', 2000, 2, 1),
    ...pair('pc-slow', 'error-4000', 4000, 3, 3),
  ];
  assert(Object.hasOwn(profiles.scenarios, scenario), 'unknown trace recipe');
  return [];
}
export function assertProducerTrace(events: ProducerEvent[], expected: ExpectedProducerEvent[]) {
  const targets = [...new Set([...events, ...expected].map(event => event.target))].sort();
  for (const target of targets) {
    const stream = events.filter(event => event.target === target);
    assert(stream.every((event, index) => event.sequence === index + 1), 'producer event sequence gap or duplicate');
    const actual = stream.map(({ sha256: _hash, ...event }) => event);
    assert.deepEqual(actual, expected.filter(event => event.target === target), `producer event trace mismatch: ${target}`);
  }
}
/** Fixture user rows all fit 100 items in the existing byte bound. Exact
 * cardinality/content/order is checked, not just membership of returned rows. */
export function assertProducerPage(result: any, source: readonly DbMessage[], offset: number, snapshotId?: string) {
  const rows = [...source].sort((a, b) => a.created_at.localeCompare(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  assert.equal(result.page.total, rows.length, 'producer page total mismatch');
  assert.equal(result.page.offset, offset, 'producer page offset mismatch');
  if (snapshotId) assert.equal(result.page.snapshot_id, snapshotId, 'producer continuation snapshot mismatch');
  const expected = rows.slice(offset, offset + 100).map((row, index) => ({
    message_id: row.id, position: offset + index, role: row.role, created_at: new Date(row.created_at).toISOString(),
    completion: 'complete', content_state: 'complete', text: row.content,
  }));
  assert.deepEqual(result.items, expected, 'producer page window mismatch');
  const nextOffset = offset + expected.length;
  if (nextOffset < rows.length) assert(typeof result.page.next_cursor === 'string' && result.page.next_cursor.length > 0, 'producer page missing continuation');
  else assert.equal(result.page.next_cursor, null, 'producer page unexpected continuation');
  return nextOffset;
}
export type ProducerSample = {
  scenario: string; size: number; sourceCalls: Record<string, number>; sourceRows: number;
  newCaptures: number; captureApiCalls: number; captureApiMs: number; captureApiFailures: number;
  usefulBytes: number; serializedBytes: number; observations: number; deliveries: number;
  results: Record<string, number>; events: ProducerEvent[]; expectedEvents: ExpectedProducerEvent[];
  observationTrace: Array<{ target: string; phase: string; atMs: number }>;
  eventAttempts: ProducerSample['events']; elapsedMs: number; checks: string[]; pageOffsets: number[];
};
export function createProducerFixture(size: number, target = 'pc-a') {
  let now = epoch; let requestSequence = 0; let appendSequence = 0; let phase = 'prepare';
  let sourceRows = 0; let newCaptures = 0; let captureApiCalls = 0; let captureApiMs = 0; let captureApiFailures = 0;
  let usefulBytes = 0; let serializedBytes = 0; let observations = 0; let deliveries = 0;
  const calls: Record<string, number> = {}; const results: Record<string, number> = {};
  const events: ProducerSample['events'] = []; const attempts: ProducerSample['events'] = [];
  const knownCaptures = new Set<string>();
  const cursorOffsets = new Map<string, number>(); const cursorsByOffset = new Map<string, string>();
  const observationTrace: ProducerSample['observationTrace'] = [];
  const allMessages: DbMessage[] = ['active', 'other'].flatMap(conversation => fixtureMessages(size, conversation).map((message: any) => ({
    ...message, token_count: null, hidden_context: null, tool_traces_json: null, provider_input_items_json: null, provider_turn_state_json: null,
  })));
  const conversations: DbConversation[] = ['active', 'other'].map(conversation => ({
    id: `synthetic-${conversation}`, title: 'Synthetic conversation', description: null, scope_mode: 'Chat',
    task_id: null, project_id: null, group_id: null, provider_id: null, model_id: null, reasoning_effort: null,
    created_at: date, updated_at: date, last_message: null, message_count: size, is_pinned: false,
  }));
  const activities = new Map(conversations.map(conversation => [conversation.id, { activity: 'idle', generatingMessageId: null } as ConversationActivity]));
  let interaction: InteractionState = { question: null, generation_id: null, actions: [] };
  let sourceFailure = false;
  let gate: Promise<void> | undefined; let gateRelease: (() => void) | undefined;
  const count = (method: string, id = '') => { const key = id ? `${method}:${id}` : method; calls[key] = (calls[key] ?? 0) + 1; };
  const ref = (conversation = 'active'): ConversationRef => ({ instance_id: target, kind: 'conversation', conversation_id: `synthetic-${conversation}` });
  const captures = new ConversationCaptures({ instanceId: target, workspaceId: `workspace:${target}`, now: () => now,
    storage: memory(), policy: () => ({ revision: 'visible-1', secrets: [] }), source: {
      projects: async () => { count('projects'); return [{ id: 'project:synthetic', name: 'Synthetic' }]; },
      tasks: async () => { count('tasks'); return []; },
      listConversations: async () => { count('listConversations'); return structuredClone(conversations); },
      getConversation: async id => { count('getConversation', id); return structuredClone(conversations.find(c => c.id === id) ?? null); },
      listMessages: async id => { count('listMessages', id); await gate; if (sourceFailure) throw new Error('Injected memory source failure'); const rows = allMessages.filter(message => message.conversation_id === id); sourceRows += rows.length; return structuredClone(rows); },
      activity: id => { count('activity', id); return structuredClone(activities.get(id)!); },
    } });
  // Wrap public APIs on this owned fixture only. No private fields or production
  // global prototype is changed. Failed calls retain their elapsed time/count.
  for (const method of ['projectsList', 'projectsConditional', 'conversationsList', 'conversationRead'] as const) {
    const original = captures[method].bind(captures) as (...args: any[]) => Promise<any>;
    (captures as any)[method] = async (...args: any[]) => {
      const start = performance.now(); captureApiCalls++;
      try {
        const result = await original(...args);
        const id = result.page?.snapshot_id;
        if (id && !knownCaptures.has(id)) { knownCaptures.add(id); newCaptures++; }
        return result;
      } catch (error) { captureApiFailures++; throw error; }
      finally { captureApiMs += performance.now() - start; }
    };
  }
  const host = new ContentHost({ accountId: 'account:synthetic', instanceId: target, now: () => now, signal: new AbortController().signal,
    conversations: captures, storage: memory(), policy: async () => ({ revision: 'visible-1', secrets: [] }),
    reviews: createReviewCaptureService({ capture: forbidden, files: forbidden, read: forbidden, fresh: forbidden, release: forbidden }),
    resolveReview: forbidden, commitReview: forbidden, reviewRefs: async () => [],
    interactions: { storage: memory(), source: {
      load: async () => { count('interaction.load'); return { state: structuredClone(interaction), fingerprint: interaction }; },
      execute: forbidden,
    } },
  });
  host.enableReliability();
  const dataBytes = (value: any, key = ''): number => typeof value === 'string' ? (key === 'text' ? Buffer.byteLength(value) : 0)
    : Array.isArray(value) ? value.reduce((sum, entry) => sum + dataBytes(entry), 0)
    : value && typeof value === 'object' ? Object.entries(value).reduce((sum, [name, entry]) => sum + dataBytes(entry, name), 0) : 0;
  const record = (value: unknown) => { serializedBytes += Buffer.byteLength(JSON.stringify(value)); usefulBytes += dataBytes(value); };
  const prepare = async () => { await host.initialize(); await host.prepare(); };
  const deliver = async (operation: string, body: object): Promise<any> => {
    const enhancedBody = ['projects.list', 'conversations.list', 'conversation.read'].includes(operation) ? { ...body, consistency: 'network-reliability-1' } : body;
    const request = { contract_version: '2.0', type: 'request', account_id: 'account:synthetic', request_id: `request:${++requestSequence}`, operation, body: enhancedBody } as ContentRequest;
    const delivery: ContentDelivery = { transport_version: '2.0', type: 'delivery', account_id: 'account:synthetic', instance_id: target,
      request_id: request.request_id, source_session_id: 'session:synthetic', expires_at: new Date(now + 60000).toISOString(), request,
      capabilities: ['network-reliability-1', 'conversations-1', 'conversation-interactions-1'] };
    assert(validateContentMessage(delivery), `invalid synthetic request: ${operation}`);
    deliveries++; record(delivery);
    const result = await host.handle(delivery, async () => new Date(now + 9000).toISOString());
    assert(validateContentResponse(request, result.response), 'invalid producer response');
    if (CONVERSATION_READ_OPERATIONS.has(request.operation)) await host.validateConversationEmission(delivery, result);
    record(result); const status = result.response.type === 'error' ? result.response.code : 'response';
    results[status] = (results[status] ?? 0) + 1;
    return { delivery, result, response: result.response };
  };
  const read = async (conversation = 'active', continuation?: { snapshot_id: string; cursor: string }): Promise<any> => {
    const reply = await deliver('conversation.read', { ref: ref(conversation), ...(continuation ? { continuation } : {}) });
    if (reply.response.type === 'response') {
      const page = reply.response.result.page;
      const source = allMessages.filter(message => message.conversation_id === `synthetic-${conversation}`);
      const key = (cursor: string) => JSON.stringify([conversation, page.snapshot_id, cursor]);
      const expectedOffset = continuation ? cursorOffsets.get(JSON.stringify([conversation, continuation.snapshot_id, continuation.cursor])) : 0;
      assert.notEqual(expectedOffset, undefined, 'producer returned success for unknown continuation');
      const nextOffset = assertProducerPage(reply.response.result, source, expectedOffset!, continuation?.snapshot_id);
      if (page.next_cursor) {
        const position = JSON.stringify([conversation, page.snapshot_id, nextOffset]);
        const previous = cursorsByOffset.get(position);
        if (previous) assert.equal(page.next_cursor, previous, 'producer replay cursor changed');
        cursorsByOffset.set(position, page.next_cursor);
        const oldOffset = cursorOffsets.get(key(page.next_cursor));
        if (oldOffset !== undefined) assert.equal(oldOffset, nextOffset, 'producer cursor reused at another offset');
        cursorOffsets.set(key(page.next_cursor), nextOffset);
      }
    }
    return reply;
  };
  const flush = async (loseAck = false) => {
    let lose = loseAck;
    await host.flush(async event => {
      assert(validateContentMessage(event), 'invalid producer event'); record(event);
      const scope = event.change.scope;
      const item = { target, phase, kind: event.change.kind, sequence: event.sequence, revision: event.change.revision, atMs: Date.parse(event.occurred_at) - epoch, sha256: createHash('sha256').update(JSON.stringify(event)).digest('hex'), resource: 'conversation_id' in scope ? String(scope.conversation_id) : 'instance' };
      attempts.push(item);
      if (lose) { lose = false; throw new Error('Injected lost fixture acknowledgement'); }
      events.push(item);
    });
  };
  const observeOnly = async () => { observations++; observationTrace.push({ target, phase, atMs: now - epoch }); await host.observe(); };
  const observe = async () => { await observeOnly(); await flush(); };
  const reset = () => {
    for (const key of Object.keys(calls)) delete calls[key]; for (const key of Object.keys(results)) delete results[key];
    sourceRows = newCaptures = captureApiCalls = captureApiMs = captureApiFailures = usefulBytes = serializedBytes = observations = deliveries = 0;
    events.length = 0; attempts.length = 0; observationTrace.length = 0;
  };
  const sample = (scenario: string, elapsedMs: number, checks: string[], pageOffsets: number[] = []): ProducerSample => ({
    scenario, size, sourceCalls: { ...calls }, sourceRows, newCaptures, captureApiCalls, captureApiMs, captureApiFailures,
    usefulBytes, serializedBytes, observations, deliveries, results: { ...results }, events: [...events], expectedEvents: expectedProducerTrace(scenario), observationTrace: [...observationTrace], eventAttempts: [...attempts], elapsedMs, checks, pageOffsets,
  });
  return { host, captures, prepare, deliver, read, observe, observeOnly, flush, reset, ref, events, attempts, sample, allMessages,
    setPhase: (value: string) => { phase = value; }, setTime: (offset: number) => { now = epoch + offset; },
    append: (conversation = 'active') => { const row = allMessages.find(message => message.conversation_id === `synthetic-${conversation}`)!;
      allMessages.push({ ...row, id: `append-${conversation}-${++appendSequence}`, content: 'synthetic appended content', created_at: date }); },
    edit: (conversation = 'active') => { allMessages.find(message => message.conversation_id === `synthetic-${conversation}`)!.content = 'synthetic edited content'; },
    activity: (value: ConversationActivity) => { activities.set('synthetic-active', value); },
    question: (pending: boolean) => { interaction = pending ? { question: { assistant_message_id: 'message:question', steps: [{ step_id: 'choice', prompt: 'Synthetic?', choices: ['Yes'], free_text_allowed: false }] }, generation_id: null, actions: ['answer'] } : { question: null, generation_id: null, actions: [] }; },
    failSource: () => { sourceFailure = true; },
    block: () => { assert(!gate, 'source already blocked'); gate = new Promise<void>(resolve => { gateRelease = resolve; }); },
    release: () => { gateRelease?.(); gate = undefined; gateRelease = undefined; },
  };
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Producer fixture barrier timeout')), 5000); })]); }
  finally { clearTimeout(timer); }
}
export async function runProducerRecipe(scenario: string, size: number): Promise<ProducerSample> {
  assert(Object.hasOwn(profiles.scenarios, scenario), 'unknown recipe');
  const h = createProducerFixture(size); const extra: ReturnType<typeof createProducerFixture>[] = [];
  let slowRead: Promise<any> | undefined; const checks: string[] = []; const offsets: number[] = [];
  try {
    if (scenario !== 'cold-open-return') await h.prepare();
    if (['idle-hidden', 'visible-unrelated-update', 'foreground-reconnect'].includes(scenario)) await h.read();
    if (scenario === 'visible-unrelated-update') {
      await h.read('other'); await h.deliver('conversation.interactions', { ref: h.ref() });
    }
    if (scenario === 'multiple-targets') {
      extra.push(createProducerFixture(size, 'pc-b'), createProducerFixture(size, 'pc-slow'));
      for (const host of extra) await host.prepare();
    }
    h.reset(); for (const host of extra) host.reset();
    const start = performance.now();
    if (scenario === 'idle-hidden') {
      // Ten manual observation cycles over a virtual ten-second window. No real
      // runtime timer or hidden UI is claimed by this library-only recipe.
      for (let i = 1; i <= 10; i++) { h.setTime(i * 1000); await h.observe(); }
      assert(h.events.length === 0, 'idle source unexpectedly changed'); checks.push('unchanged-source-no-events');
    } else if (scenario === 'cold-open-return') {
      await h.prepare();
      let action = 0;
      for (const conversation of ['active', 'other', 'active']) { h.setTime([0, 4000, 6000][action++]); const reply = await h.read(conversation); assert.equal(reply.response.type, 'response'); }
      checks.push('cold-host-public-content');
    } else if (scenario === 'visible-unrelated-update') {
      const seen: string[] = [];
      for (const [phase, change] of [
        ['other-change', () => h.append('other')], ['active-change', () => h.append()],
        ['error', () => h.activity({ activity: 'error', generatingMessageId: null, providerFailure: { category: 'unknown', message: 'provider_failed', recovery: 'review_before_retry' } })],
        ['interaction', () => h.question(true)], ['finish', () => { h.question(false); h.activity({ activity: 'idle', generatingMessageId: null }); }],
      ] as const) {
        h.setTime((seen.length + 1) * 1000); h.setPhase(phase); change(); await h.observe(); seen.push(phase);
        if (phase === 'error') {
          const catalog = await h.deliver('conversations.list', { instance_id: 'pc-a', kind: 'conversation' });
          assert(catalog.response.result.items.some((item: any) => item.ref.conversation_id === 'synthetic-active' && item.provider_error?.message === 'provider_failed'), 'error state lost');
        }
      }
      checks.push('error-state-retained', 'exhaustive-event-trace');
    } else if (scenario === 'foreground-reconnect') {
      h.setTime(500); h.setPhase('disconnected'); h.append(); await h.observeOnly();
      await assert.rejects(h.flush(true), /Injected lost/);
      const lost = { ...h.attempts[0] }; h.setTime(1500); h.setPhase('resumed'); await h.flush();
      assert.equal(h.events[0].sequence, lost.sequence, 'lost ACK event changed');
      assert.equal(h.events[0].sha256, lost.sha256, 'lost ACK payload changed');
      assert(h.events.every((event, index) => !index || event.sequence === h.events[index - 1].sequence + 1), 'replayed outbox not FIFO');
      h.setTime(2000); assert.equal((await h.read()).response.type, 'response');
      checks.push('lost-ack-retains-canonical-event', 'resumed-outbox-fifo');
    } else if (scenario === 'history-pagination') {
      const first = await h.read(); assert.equal(first.response.type, 'response');
      let page = first.response.result; offsets.push(page.page.offset);
      let lastContinuation: { snapshot_id: string; cursor: string } | undefined;
      const expectedPages = Math.min(2, Math.ceil(size / 100) - 1);
      for (let i = 0; i < expectedPages; i++) {
        assert(page.page.next_cursor, 'history ended before expected window');
        h.setTime((i + 1) * 2000);
        lastContinuation = { snapshot_id: page.page.snapshot_id, cursor: page.page.next_cursor };
        const next = await h.read('active', lastContinuation); assert.equal(next.response.type, 'response');
        assert.equal(next.response.result.page.snapshot_id, first.response.result.page.snapshot_id, 'immutable page identity changed');
        page = next.response.result; offsets.push(page.page.offset);
      }
      if (lastContinuation) {
        h.setTime(6000); const same = await h.read('active', lastContinuation); assert.deepEqual(same.response.result.items, page.items, 'page replay content changed');
        h.edit(); const stale = await h.read('active', lastContinuation); assert.equal(stale.response.code, 'stale_revision');
      }
      h.setTime(300001);
      const expired = await h.read('active', lastContinuation ?? { snapshot_id: page.page.snapshot_id, cursor: 'synthetic:missing' });
      assert.equal(expired.response.code, 'snapshot_expired');
      assert.deepEqual(offsets, Array.from({ length: expectedPages + 1 }, (_, index) => index * 100), 'history window offsets mismatch');
      if (!lastContinuation) assert(size <= 100, 'multi-page history falsely considered complete');
      checks.push('exact-public-page-windows', 'expiration-refused', ...(lastContinuation ? ['stale-continuation-refused'] : ['history-fits-one-page']));
    } else if (scenario === 'multiple-targets') {
      const [healthy, slow] = extra; slow.block(); let settled = false;
      slowRead = slow.read().then(result => { settled = true; return result; });
      await bounded(Promise.all([h.read(), healthy.read()]));
      assert.equal(settled, false, 'slow barrier not exercised');
      slow.release(); assert.equal((await bounded(slowRead)).response.type, 'response');
      // Canonical data mutations at 2000ms, followed by their real observations.
      slow.setTime(2000); slow.setPhase('append-2000'); slow.append(); await slow.observe();
      h.setTime(2000); h.setPhase('append-2000'); h.append(); await h.observe();
      const refreshed = await h.read(); assert.equal(refreshed.response.type, 'response');
      assert.equal(refreshed.response.result.page.revision, 2, 'healthy append revision missing');
      slow.setTime(4000); slow.setPhase('error-4000');
      slow.activity({ activity: 'error', generatingMessageId: null, providerFailure: { category: 'unknown', message: 'provider_failed', recovery: 'review_before_retry' } });
      await slow.observe();
      const slowCatalog = await slow.deliver('conversations.list', { instance_id: 'pc-slow', kind: 'conversation' });
      assert.equal(slowCatalog.response.type, 'response');
      assert(slowCatalog.response.result.items.some((item: any) => item.ref.conversation_id === 'synthetic-active' && item.provider_error?.message === 'provider_failed'), 'slow public error state missing');
      // Additional port failure, separate from the canonical public error state.
      slow.failSource(); assert.equal((await slow.read()).response.code, 'unavailable');
      h.setTime(6000); h.setPhase('observe-6000'); await h.observe();
      const page = refreshed.response.result.page;
      assert.equal(page.total, size + 1, 'healthy canonical mutation missing');
      assert(page.next_cursor, 'appended fixture must have a continuation');
      const continuation = { snapshot_id: page.snapshot_id, cursor: page.next_cursor };
      const unaffected = await h.read('active', continuation); assert.equal(unaffected.response.type, 'response');
      assert.equal(unaffected.response.result.page.snapshot_id, page.snapshot_id, 'healthy capture reset by other host failure');
      assert.equal(unaffected.response.result.page.revision, page.revision, 'slow error changed healthy revision');
      checks.push('healthy-hosts-finish-before-slow-release', 'slow-source-failure-isolated', 'canonical-mutations-and-observations', 'exhaustive-event-trace');
    }
    const elapsed = performance.now() - start;
    const sample = h.sample(scenario, elapsed, checks, offsets);
    for (const host of extra) {
      const value = host.sample(scenario, elapsed, [], []);
      sample.events.push(...value.events); sample.eventAttempts.push(...value.eventAttempts); sample.observationTrace.push(...value.observationTrace);
      for (const [method, count] of Object.entries(value.sourceCalls)) sample.sourceCalls[`${host.ref().instance_id}/${method}`] = count;
      for (const key of ['sourceRows', 'newCaptures', 'captureApiCalls', 'captureApiMs', 'captureApiFailures', 'usefulBytes', 'serializedBytes', 'observations', 'deliveries'] as const) sample[key] += value[key];
      for (const [status, count] of Object.entries(value.results)) sample.results[status] = (sample.results[status] ?? 0) + count;
    }
    assertProducerTrace(sample.events, sample.expectedEvents);
    if (scenario === 'multiple-targets') assert.deepEqual(sample.observationTrace, [
      { target: 'pc-a', phase: 'append-2000', atMs: 2000 }, { target: 'pc-a', phase: 'observe-6000', atMs: 6000 },
      { target: 'pc-slow', phase: 'append-2000', atMs: 2000 }, { target: 'pc-slow', phase: 'error-4000', atMs: 4000 },
    ], 'canonical multi-target observations missing');
    return sample;
  } finally {
    for (const host of extra) host.release();
    await slowRead?.catch(() => undefined);
    await Promise.all([h, ...extra].map(host => host.host.dispose()));
  }
}
