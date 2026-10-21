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
export type ProducerSample = {
  scenario: string; size: number; sourceCalls: Record<string, number>; sourceRows: number;
  newCaptures: number; captureApiCalls: number; captureApiMs: number; captureApiFailures: number;
  usefulBytes: number; serializedBytes: number; observations: number; deliveries: number;
  results: Record<string, number>; events: Array<{ target: string; phase: string; kind: string; sequence: number; resource: string; sha256: string }>;
  eventAttempts: ProducerSample['events']; elapsedMs: number; checks: string[]; pageOffsets: number[];
};
export function createProducerFixture(size: number, target = 'pc-a') {
  let now = epoch; let requestSequence = 0; let appendSequence = 0; let phase = 'prepare';
  let sourceRows = 0; let newCaptures = 0; let captureApiCalls = 0; let captureApiMs = 0; let captureApiFailures = 0;
  let usefulBytes = 0; let serializedBytes = 0; let observations = 0; let deliveries = 0;
  const calls: Record<string, number> = {}; const results: Record<string, number> = {};
  const events: ProducerSample['events'] = []; const attempts: ProducerSample['events'] = [];
  const knownCaptures = new Set<string>();
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
      const items = reply.response.result.items as Array<{ message_id: string; text?: string }>;
      const expected = new Map(allMessages.filter(message => message.conversation_id === `synthetic-${conversation}`).map(message => [message.id, message.content]));
      assert(items.every(item => item.text === expected.get(item.message_id)), 'public content changed');
    }
    return reply;
  };
  const flush = async (loseAck = false) => {
    let lose = loseAck;
    await host.flush(async event => {
      assert(validateContentMessage(event), 'invalid producer event'); record(event);
      const scope = event.change.scope;
      const item = { target, phase, kind: event.change.kind, sequence: event.sequence, sha256: createHash('sha256').update(JSON.stringify(event)).digest('hex'), resource: 'conversation_id' in scope ? String(scope.conversation_id) : 'instance' };
      attempts.push(item);
      if (lose) { lose = false; throw new Error('Injected lost fixture acknowledgement'); }
      events.push(item);
    });
  };
  const observe = async () => { observations++; await host.observe(); await flush(); };
  const reset = () => {
    for (const key of Object.keys(calls)) delete calls[key]; for (const key of Object.keys(results)) delete results[key];
    sourceRows = newCaptures = captureApiCalls = captureApiMs = captureApiFailures = usefulBytes = serializedBytes = observations = deliveries = 0;
    events.length = 0; attempts.length = 0;
  };
  const sample = (scenario: string, elapsedMs: number, checks: string[], pageOffsets: number[] = []): ProducerSample => ({
    scenario, size, sourceCalls: { ...calls }, sourceRows, newCaptures, captureApiCalls, captureApiMs, captureApiFailures,
    usefulBytes, serializedBytes, observations, deliveries, results: { ...results }, events: [...events], eventAttempts: [...attempts], elapsedMs, checks, pageOffsets,
  });
  return { host, captures, prepare, deliver, read, observe, flush, reset, ref, events, attempts, sample, allMessages,
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
      assert(h.events.some(event => event.phase === 'error' && event.kind === 'conversation.resource_changed' && event.resource === 'synthetic-active'), 'error invalidation lost');
      assert(h.events.filter(event => event.phase === 'other-change' && event.kind === 'conversation.resource_changed').every(event => event.resource === 'synthetic-other'), 'unrelated update invalidated active resource');
      assert(h.events.some(event => event.phase === 'interaction' && event.kind === 'conversation.interactions_changed'), 'interaction event lost');
      assert(h.events.some(event => event.phase === 'finish' && event.kind === 'conversation.interactions_changed'), 'finish state change lost');
      const order = h.events.filter(event => ['error', 'interaction', 'finish'].includes(event.phase)).map(event => seen.indexOf(event.phase));
      assert(order.every((value, index) => !index || value >= order[index - 1]), 'events reordered');
      checks.push('error-state-retained', 'error-invalidation-retained', 'unrelated-resource-isolated', 'interaction-and-finish-invalidations-ordered');
    } else if (scenario === 'foreground-reconnect') {
      h.setTime(500); h.setPhase('disconnected'); h.append(); await h.host.observe();
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
      for (let i = 0; i < 2 && page.page.next_cursor; i++) {
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
      checks.push('public-page-content-and-offsets', 'expiration-refused', ...(lastContinuation ? ['stale-continuation-refused'] : ['history-fits-one-page']));
    } else if (scenario === 'multiple-targets') {
      const [healthy, slow] = extra; slow.block(); let settled = false;
      slowRead = slow.read().then(result => { settled = true; return result; });
      const [firstHealthy] = await bounded(Promise.all([h.read(), healthy.read()]));
      assert.equal(settled, false, 'slow barrier not exercised');
      slow.release(); assert.equal((await bounded(slowRead)).response.type, 'response');
      slow.failSource(); slow.setTime(4000); assert.equal((await slow.read()).response.code, 'unavailable');
      const page = firstHealthy.response.result.page;
      const continuation = page.next_cursor ? { snapshot_id: page.snapshot_id, cursor: page.next_cursor } : undefined;
      const unaffected = await h.read('active', continuation); assert.equal(unaffected.response.type, 'response');
      if (continuation) assert.equal(unaffected.response.result.page.snapshot_id, page.snapshot_id, 'healthy capture reset by other host failure');
      checks.push('healthy-hosts-finish-before-slow-release', 'slow-source-failure-isolated');
    }
    const elapsed = performance.now() - start;
    const sample = h.sample(scenario, elapsed, checks, offsets);
    for (const host of extra) {
      const value = host.sample(scenario, elapsed, [], []);
      sample.events.push(...value.events); sample.eventAttempts.push(...value.eventAttempts);
      for (const [method, count] of Object.entries(value.sourceCalls)) sample.sourceCalls[`${host.ref().instance_id}/${method}`] = count;
      for (const key of ['sourceRows', 'newCaptures', 'captureApiCalls', 'captureApiMs', 'captureApiFailures', 'usefulBytes', 'serializedBytes', 'observations', 'deliveries'] as const) sample[key] += value[key];
      for (const [status, count] of Object.entries(value.results)) sample.results[status] = (sample.results[status] ?? 0) + count;
    }
    return sample;
  } finally {
    for (const host of extra) host.release();
    await slowRead?.catch(() => undefined);
    await Promise.all([h, ...extra].map(host => host.host.dispose()));
  }
}
