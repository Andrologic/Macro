import { describe, expect, it } from 'bun:test';
import { ConsumerConnections } from './consumerConnections';
import { PilotClientError } from './clientError';
import { type ConsumerClock, type ConsumerLimits, type ConsumerRetryPolicy } from './consumerPolicy';
import type { ConsumerDispatch, ConsumerIdentity, ConsumerOperation, ConsumerTransport } from './consumerTransport';
import type { ContentEvent } from './contentProtocol';
import type { ConsumerDirectoryRequest } from './consumerDirectory';
import conversation from '../../../contracts/macro-pilot/v2/fixtures/valid/response-conversation.read.json';
import conversations from '../../../contracts/macro-pilot/v2/fixtures/valid/response-conversations.list.json';
import catalog from '../../../contracts/macro-pilot/v2/fixtures/valid/response-conversations.catalog.json';
import windowPage from '../../../contracts/macro-pilot/v2/fixtures/valid/response-conversation.window.json';
import projects from '../../../contracts/macro-pilot/v2/fixtures/valid/response-projects.list.json';

const time = Date.parse('2026-01-01T00:00:00Z');
// Synthetic counts and timings chosen only to exercise saturation and finite recovery.
const limits: ConsumerLimits = { targets: 2, subscribers: 3, activeReads: 2, directoryPages: 4, directoryItems: 8,
  directoryBytes: 8192, pageItems: 2, pageBytes: 2048, identities: 8, cursors: 4 };
const retry: ConsumerRetryPolicy = { delaysMs: [10, 20], maxDelayMs: 100, deadlineMs: 1000, jitterRatio: 0.5, pollIntervalMs: 100 };
const ref = (id: string) => ({ instance_id: id, kind: 'conversation' as const, conversation_id: 'conversation:same' });
const defer = <T>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const until = async (test: () => boolean) => { for (let n = 0; !test() && n < 100; n++) await new Promise(done => setTimeout(done, 1)); expect(test()).toBe(true); };
function harness(overrides: Partial<ConsumerLimits> = {}, policy = retry) {
  let identity: ConsumerIdentity = { key: 'context:synthetic', configurationId: 'config:synthetic', relayOrigin: 'https://relay.example', accountId: 'account:synthetic', sessionId: 'session:synthetic', epoch: 0 };
  let next = 0, now = time, verifications = 0;
  const listeners = new Set<() => void>();
  const calls: { id: string; dispatch: ConsumerDispatch; signal: AbortSignal }[] = [];
  const streams = new Map<string, { id: string; seq: number }>();
  const waiting = new Map<string, { request: Extract<ConsumerDispatch, { kind: 'events' }>['request']; done: ReturnType<typeof defer<unknown>>; cleanup(): void }>();
  const delays: number[] = [];
  let readHook: ((id: string, dispatch: ConsumerDispatch, signal: AbortSignal) => Promise<unknown>) | undefined;
  let verifyHook: (() => Promise<void>) | undefined;
  let sleepHook: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  let directoryHook: ((request: ConsumerDirectoryRequest) => Promise<unknown>) | undefined;
  const access = (id: string, revision = 0, state = 'granted') => ({ contract_version: '1.0', type: 'instance_access', ref: { type: 'instance_access', account_id: identity.accountId, session_id: identity.sessionId, instance_id: id }, state,
    permissions: ['supervise'], granted_at: new Date(time).toISOString(), ...(state === 'revoked' ? { revoked_at: new Date(time + 1).toISOString() } : {}), revision });
  const page = (request: ConsumerDirectoryRequest) => ({ contract_version: '1.0', type: 'page', item_type: request.item_type, has_more: false,
    items: ['instance:a', 'instance:b'].map(id => request.item_type === 'instance' ? { contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: id }, label: 'Synthetic PC', connection_state: 'reachable', supported_contract_versions: ['1.0', '2.0'], revision: 0 } : access(id)) });
  const terminal = (id: string, dispatch: ConsumerDispatch) => {
    const request = dispatch.request as { operation: ConsumerOperation; request_id: string };
    const source = { 'conversation.read': conversation, 'conversations.list': conversations, 'conversations.catalog': catalog, 'conversation.window': windowPage, 'projects.list': projects }[request.operation];
    const result = JSON.parse(JSON.stringify(source).replaceAll('instance-demo', id));
    result.account_id = identity.accountId; result.request_id = request.request_id;
    if (request.operation === 'conversation.read') result.result.items[0].text = `From ${id}`;
    return result;
  };
  const transport: ConsumerTransport = { context: () => identity, subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, id: () => `request:synthetic:${++next}`, now: () => now,
    send: async (_context, id, dispatch, signal) => {
      calls.push({ id, dispatch, signal });
      const request = dispatch.request;
      if (dispatch.kind === 'negotiate') {
        streams.set(id, { id: `stream:${++next}`, seq: 0 });
        return { status: 200, data: { negotiation_version: '1.0', type: 'negotiated', request_id: request.request_id, instance_id: id, selected_version: '2.0', capabilities: 'capabilities' in request ? request.capabilities : [] } };
      }
      if (dispatch.kind === 'events') {
        const stream = streams.get(id)!;
        if (dispatch.request.stream_id === null) return { status: 200, data: { contract_version: '2.0', type: 'events.page', request_id: request.request_id, account_id: identity.accountId, stream_id: stream.id, after_sequence: 0, next_sequence: 0, reset: true, events: [] } };
        const done = defer<unknown>();
        const abort = () => { if (waiting.get(id)?.done === done) waiting.delete(id); done.reject(new PilotClientError('context_changed')); };
        waiting.set(id, { request: dispatch.request, done, cleanup: () => signal.removeEventListener('abort', abort) });
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        return { status: 200, data: await done.promise };
      }
      if (readHook) return { status: 200, data: await readHook(id, dispatch, signal) };
      return { status: 200, data: terminal(id, dispatch) };
    } };
  const clock: ConsumerClock = { now: () => now, random: () => 1, sleep: async (ms, signal) => { delays.push(ms); if (sleepHook) return sleepHook(ms, signal); now += ms; if (signal.aborted) throw new PilotClientError('context_changed'); } };
  const owner = new ConsumerConnections(transport, { context: () => identity, verify: async () => { verifications++; await verifyHook?.(); }, query: async (_context, request) => directoryHook ? directoryHook(request) : page(request) }, { ...limits, ...overrides }, policy, clock);
  const emit = (id: string, changes: ContentEvent['change'][], reset = false) => {
    const pending = waiting.get(id); if (!pending) throw new Error(`No event demand for ${id}`); waiting.delete(id); pending.cleanup();
    const stream = streams.get(id)!; if (reset) { stream.id = `stream:${++next}`; stream.seq = 0; }
    const after = reset ? 0 : pending.request.after_sequence;
    const events = changes.map((change, i) => ({ contract_version: '2.0', type: 'event', account_id: identity.accountId, stream_id: stream.id, sequence: after + i + 1, occurred_at: new Date(now).toISOString(), change }));
    stream.seq = after + events.length;
    pending.done.resolve({ contract_version: '2.0', type: 'events.page', request_id: pending.request.request_id, account_id: identity.accountId, stream_id: stream.id, after_sequence: after, next_sequence: stream.seq, reset, events });
  };
  const failEvents = (id: string, error: unknown) => { const pending = waiting.get(id)!; waiting.delete(id); pending.cleanup(); pending.done.reject(error); };
  return { owner, calls, waiting, emit, terminal, delays, access, page, failEvents, sleep: (hook: typeof sleepHook) => { sleepHook = hook; }, verifications: () => verifications,
    read: (hook: typeof readHook) => { readHook = hook; }, verify: (hook: typeof verifyHook) => { verifyHook = hook; }, directory: (hook: typeof directoryHook) => { directoryHook = hook; },
    advance: (ms: number) => { now += ms; }, change: () => { identity = { ...identity, key: 'context:other', epoch: 1 }; for (const callback of [...listeners]) callback(); }, listeners,
  };
}

describe('shared consumer ownership', () => {
  it('is inert, requires discovery and enforces target/subscriber admission', async () => {
    const h = harness({ targets: 1, activeReads: 1, subscribers: 2 });
    expect(h.calls).toHaveLength(0); expect(() => h.owner.acquire('instance:a')).toThrow('forbidden');
    await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), a2 = h.owner.acquire('instance:a');
    expect(() => h.owner.acquire('instance:b')).toThrow('resource_limit');
    a2.release(); expect(() => h.owner.acquire('instance:b')).toThrow('resource_limit');
    a.release(); h.owner.dispose(); await until(() => h.owner.diagnostics().activeReads === 0); expect(h.listeners.size).toBe(0);
  });
  it('shares one handle, negotiation and event feed, coalesces reads and isolates identical IDs', async () => {
    const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), a2 = h.owner.acquire('instance:a'), b = h.owner.acquire('instance:b');
    try {
      await until(() => h.waiting.size === 2);
      const gate = defer<unknown>(); h.read(async (id, dispatch) => id === 'instance:a' ? gate.promise : h.terminal(id, dispatch));
      const first = a.read('conversation.read', { ref: ref('instance:a') });
      const second = a2.read('conversation.read', { ref: ref('instance:a') });
      const other = await b.read('conversation.read', { ref: ref('instance:b') });
      expect(other.response.result.items[0]).toMatchObject({ text: 'From instance:b' });
      await until(() => h.calls.filter(value => value.id === 'instance:a' && value.dispatch.kind === 'submit').length === 1);
      const sent = h.calls.find(value => value.id === 'instance:a' && value.dispatch.kind === 'submit')!;
      gate.resolve(h.terminal('instance:a', sent.dispatch));
      const [one, two] = await Promise.all([first, second]); expect(one).toEqual(two); expect(one).not.toBe(two);
      expect(h.calls.filter(value => value.id === 'instance:a' && value.dispatch.kind === 'negotiate')).toHaveLength(1);
      expect(h.owner.diagnostics()).toMatchObject({ targets: 2, subscribers: 3, desiredReads: 0 });
    } finally { h.owner.dispose(); }
  });
  it('detaches one shared cancellation and aborts only when the last reader leaves', async () => {
    const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), a2 = h.owner.acquire('instance:a');
    try {
      await until(() => h.waiting.has('instance:a'));
      const gate = defer<unknown>(); let readSignal!: AbortSignal;
      h.read(async (_id, _request, signal) => { readSignal = signal; return gate.promise; });
      const first = a.read('conversation.read', { ref: ref('instance:a') }); const rejected = first.catch(error => error);
      const second = a2.read('conversation.read', { ref: ref('instance:a') });
      await until(() => Boolean(readSignal)); a.release(); expect(await rejected).toMatchObject({ code: 'context_changed' }); expect(readSignal.aborted).toBe(false);
      const last = second.catch(error => error); a2.release(); expect(await last).toMatchObject({ code: 'context_changed' }); expect(readSignal.aborted).toBe(true);
      gate.resolve({ malformed: true }); await until(() => h.owner.diagnostics().activeReads === 0);
      expect(h.owner.diagnostics()).toMatchObject({ targets: 0, subscribers: 0, desiredReads: 0, resources: 0 });
    } finally { h.owner.dispose(); }
  });
  it('replaces queued desire without an unbounded queue and admits another target after cancellation', async () => {
    const h = harness({ activeReads: 1 }); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), b = h.owner.acquire('instance:b');
    try {
      await until(() => h.waiting.size === 2);
      const gate = defer<unknown>(); h.read(async (id, dispatch) => id === 'instance:a' ? gate.promise : h.terminal(id, dispatch));
      const slow = a.read('conversation.read', { ref: ref('instance:a') }); const slowReject = slow.catch(error => error);
      await until(() => h.owner.diagnostics().activeReads === 1);
      const old = b.read('projects.list', { instance_id: 'instance:b' }); const oldReject = old.catch(error => error);
      const next = b.read('conversations.list', { instance_id: 'instance:b', kind: 'conversation' }); expect(await oldReject).toMatchObject({ code: 'context_changed' });
      expect(h.owner.diagnostics().desiredReads).toBe(2); expect(h.owner.diagnostics().waitingReads).toBeLessThanOrEqual(1);
      a.release(); expect(await slowReject).toMatchObject({ code: 'context_changed' });
      // An injected port that ignores abort still cannot publish; settling releases physical admission.
      gate.resolve({ malformed: true }); expect((await next).scope.instanceId).toBe('instance:b');
      expect(h.calls.filter(value => value.dispatch.kind === 'submit' && value.dispatch.request.operation === 'projects.list')).toHaveLength(0);
    } finally { h.owner.dispose(); }
  });
  it('applies resource/catalog/project revisions before ACK, preserves tombstones and ignores observer failure', async () => {
    const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a', () => { throw new Error('UI failure'); });
    try {
      await until(() => h.waiting.has('instance:a'));
      const read = await a.read('conversation.read', { ref: ref('instance:a') }); const key = read.resourceKey;
      const before = a.state().resources[key].version;
      h.emit('instance:a', [{ kind: 'conversations.changed', scope: { instance_id: 'instance:a' }, revision: 3 }]);
      await until(() => h.waiting.has('instance:a'));
      expect(a.state().catalogRevision).toBe(3); expect(a.state().resources[key].version).toBe(before);
      expect(h.waiting.get('instance:a')!.request.after_sequence).toBe(1);
      h.emit('instance:a', [{ kind: 'conversation.resource_changed', scope: ref('instance:a'), revision: 2 }, { kind: 'projects.changed', scope: { instance_id: 'instance:a' }, revision: 7 }]);
      await until(() => h.waiting.has('instance:a'));
      expect(a.state().resources[key]).toMatchObject({ revision: 2, invalidated: true }); expect(a.state().projectsRevision).toBe(7);
      h.emit('instance:a', [{ kind: 'conversation.removed', scope: ref('instance:a'), revision: 20 }, { kind: 'conversation.resource_changed', scope: ref('instance:a'), revision: 4 }]);
      await until(() => h.waiting.has('instance:a')); expect(a.state().resources[key].removed).toBe(true);
      await expect(a.read('conversation.read', { ref: ref('instance:a') })).rejects.toMatchObject({ code: 'not_found' });
    } finally { h.owner.dispose(); }
  });
  it('rejects late content invalidated by an event and confines reset to its target', async () => {
    const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), b = h.owner.acquire('instance:b');
    try {
      await until(() => h.waiting.size === 2); const bScope = b.state().scope;
      const gate = defer<unknown>(); h.read(async (id, dispatch) => id === 'instance:a' ? gate.promise : h.terminal(id, dispatch));
      const pending = a.read('conversation.read', { ref: ref('instance:a') }); const rejected = pending.catch(error => error);
      await until(() => h.calls.some(value => value.id === 'instance:a' && value.dispatch.kind === 'submit'));
      h.emit('instance:a', [{ kind: 'conversation.resource_changed', scope: ref('instance:a'), revision: 8 }]); expect(await rejected).toMatchObject({ code: 'context_changed' });
      gate.resolve({ malformed: true }); await until(() => h.owner.diagnostics().activeReads === 0);
      await until(() => h.waiting.has('instance:a')); h.emit('instance:a', [], true); await until(() => h.waiting.has('instance:a'));
      expect(b.state().scope).toEqual(bScope); expect((await b.read('conversation.read', { ref: ref('instance:b') })).scope.instanceId).toBe('instance:b');
    } finally { h.owner.dispose(); }
  });
  it('shares sessions revalidation across target streams and never resurrects old pending reads', async () => {
    const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), b = h.owner.acquire('instance:b');
    try {
      await until(() => h.waiting.size === 2); const proof = defer<void>(); h.verify(() => proof.promise);
      h.emit('instance:a', [{ kind: 'sessions.changed', scope: { account_id: 'account:synthetic' }, revision: 2 }]);
      h.emit('instance:b', [{ kind: 'sessions.changed', scope: { account_id: 'account:synthetic' }, revision: 2 }]);
      await until(() => h.verifications() === 2); expect(a.state().phase).toBe('revalidating'); expect(b.state().phase).toBe('revalidating');
      proof.resolve(); await until(() => h.waiting.size === 2); expect(h.verifications()).toBe(2);
      h.emit('instance:b', [{ kind: 'sessions.changed', scope: { account_id: 'account:synthetic' }, revision: 2 }]);
      await until(() => h.waiting.size === 2); expect(h.verifications()).toBe(2);
    } finally { h.owner.dispose(); }
  });
  it('uses finite jittered retries without resetting on negotiation; manual retry is explicit', async () => {
    const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), b = h.owner.acquire('instance:b');
    try {
      await until(() => h.waiting.size === 2);
      h.read(async (id, dispatch) => { if (id === 'instance:a') throw new PilotClientError('unavailable', 503, true); return h.terminal(id, dispatch); });
      await expect(a.read('conversation.read', { ref: ref('instance:a') })).rejects.toBeInstanceOf(PilotClientError);
      expect(h.delays).toEqual([15, 30]); expect(h.calls.filter(value => value.id === 'instance:a' && value.dispatch.kind === 'submit')).toHaveLength(3);
      expect((await b.read('conversation.read', { ref: ref('instance:b') })).scope.instanceId).toBe('instance:b');
      h.read(undefined); await h.owner.retryTarget('instance:a'); expect((await a.read('conversation.read', { ref: ref('instance:a') })).scope.instanceId).toBe('instance:a');
    } finally { h.owner.dispose(); }
  });
  it('does not retry forbidden or malformed reads, and does not extend the initial deadline', async () => {
    for (const code of ['forbidden', 'invalid_response'] as const) {
      const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'); await until(() => h.waiting.has('instance:a'));
      h.read(async () => { throw new PilotClientError(code, 503, true); });
      await expect(a.read('conversation.read', { ref: ref('instance:a') })).rejects.toMatchObject({ code }); expect(h.delays).toEqual([]); h.owner.dispose();
    }
    const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a');
    try {
      await until(() => h.waiting.has('instance:a'));
      h.read(async () => { h.advance(1001); throw new PilotClientError('unavailable', 503, true); });
      await expect(a.read('conversation.read', { ref: ref('instance:a') })).rejects.toBeInstanceOf(PilotClientError);
      expect(h.calls.filter(value => value.dispatch.kind === 'submit')).toHaveLength(1);
    } finally { h.owner.dispose(); }
  });
  it('retires context references and late results on logout and permits no reopening', async () => {
    const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'); await until(() => h.waiting.has('instance:a'));
    const gate = defer<unknown>(); h.read(async () => gate.promise);
    const pending = a.read('conversation.read', { ref: ref('instance:a') }); const rejected = pending.catch(error => error);
    await until(() => h.owner.diagnostics().activeReads === 1); h.change(); expect(await rejected).toMatchObject({ code: 'context_changed' }); gate.resolve({ malformed: true });
    await until(() => h.owner.diagnostics().activeReads === 0);
    expect(h.owner.diagnostics()).toEqual({ targets: 0, subscribers: 0, activeReads: 0, waitingReads: 0, desiredReads: 0, resources: 0 });
    expect(() => h.owner.acquire('instance:a')).toThrow('context_changed'); expect(h.listeners.size).toBe(0);
  });
  it('applies a partial-directory revocation immediately and never grants from a prefix', async () => {
    const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a');
    try {
      await until(() => h.waiting.has('instance:a'));
      h.directory(async request => request.item_type === 'instance' ? h.page(request) : request.cursor ? { malformed: true }
        : { contract_version: '1.0', type: 'page', item_type: 'instance_access', items: [h.access('instance:a', 1, 'revoked')], has_more: true, next_cursor: 'cursor:next' });
      await expect(h.owner.refreshDirectory()).rejects.toMatchObject({ code: 'invalid_response' });
      expect(a.state().phase).toBe('error'); expect(a.state().error).toBe('forbidden'); expect(h.owner.directorySnapshot()).toBeNull();
      expect(() => h.owner.acquire('instance:b')).toThrow('forbidden');
    } finally { h.owner.dispose(); }
  });
});

it('retries an event outage once per configured delay, preserving the healthy target', async () => {
  const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), b = h.owner.acquire('instance:b');
  try {
    await until(() => h.waiting.size === 2); const scope = b.state().scope;
    for (let n = 0; n < 2; n++) {
      h.failEvents('instance:a', new PilotClientError('unavailable', 503, true));
      await until(() => h.waiting.size === 2);
    }
    h.failEvents('instance:a', new PilotClientError('unavailable', 503, true));
    await until(() => a.state().phase === 'error');
    expect(h.delays).toEqual([15, 30]); expect(b.state().scope).toEqual(scope);
    expect((await b.read('conversation.read', { ref: ref('instance:b') })).scope.instanceId).toBe('instance:b');
  } finally { h.owner.dispose(); }
});
it('cancels a retry timer without retaining a target or admitting a late retry', async () => {
  const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a');
  try {
    await until(() => h.waiting.has('instance:a')); const gate = defer<void>(); h.sleep(async () => gate.promise);
    h.failEvents('instance:a', new PilotClientError('offline'));
    await until(() => h.delays.length === 1); a.release(); gate.resolve();
    await until(() => h.owner.diagnostics().activeReads === 0);
    expect(h.owner.diagnostics().targets).toBe(0); expect(h.calls.filter(value => value.dispatch.kind === 'negotiate')).toHaveLength(1);
  } finally { h.owner.dispose(); }
});
it('refuses unsupported inputs, bounded continuation identities and stale owner stamps', async () => {
  const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a');
  try {
    await until(() => h.waiting.has('instance:a'));
    await expect(a.read('conversation.read', { ref: ref('instance:b') })).rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(a.read('conversation.read', { ref: ref('instance:a') }, { seenIdentities: new Set(Array.from({ length: 9 }, (_, n) => String(n))) })).rejects.toMatchObject({ code: 'resource_limit' });
    const previous = await a.read('conversation.read', { ref: ref('instance:a') });
    h.emit('instance:a', [{ kind: 'conversation.resource_changed', scope: ref('instance:a'), revision: 5 }]); await until(() => h.waiting.has('instance:a'));
    await expect(a.read('conversation.read', { ref: ref('instance:a') }, { previous })).rejects.toMatchObject({ code: 'snapshot_expired' });
    h.emit('instance:a', [{ kind: 'conversation.resource_changed', scope: ref('instance:a'), revision: 4 }]); await until(() => h.waiting.has('instance:a'));
    expect(a.state().resources[previous.resourceKey].revision).toBe(5);
  } finally { h.owner.dispose(); }
});
it('closes data on account deletion without regranting it after a successful account proof', async () => {
  const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), b = h.owner.acquire('instance:b');
  try {
    await until(() => h.waiting.size === 2);
    h.emit('instance:a', [{ kind: 'account.deleted', scope: { account_id: 'account:synthetic' }, revision: 1 }]);
    await until(() => a.state().phase === 'error'); expect(b.state().phase).toBe('error');
    expect(() => h.owner.acquire('instance:a')).toThrow('unauthorized'); expect(h.owner.directorySnapshot()).toBeNull();
    await expect(h.owner.retryTarget('instance:a')).rejects.toMatchObject({ code: 'unauthorized' });
  } finally { h.owner.dispose(); }
});
it('retires a suspended shared directory proof on disposal even when the injected proof is late', async () => {
  const h = harness(); const gate = defer<void>(); h.verify(() => gate.promise);
  const pending = h.owner.refreshDirectory().catch(error => error); h.owner.dispose();
  expect(await pending).toMatchObject({ code: 'context_changed' }); gate.resolve(); expect(h.calls).toHaveLength(0);
});

it('does not retry a malformed event stream or a producer revocation', async () => {
  for (const error of [new PilotClientError('invalid_response'), new PilotClientError('session_revoked', 401, true)]) {
    const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), b = h.owner.acquire('instance:b');
    try {
      await until(() => h.waiting.size === 2); const scope = b.state().scope;
      h.failEvents('instance:a', error); await until(() => a.state().phase === 'error');
      expect(h.delays).toEqual([]); expect(b.state().scope).toEqual(scope); expect(h.verifications()).toBe(1);
    } finally { h.owner.dispose(); }
  }
});
it('uses a finite deadline for event recovery and releases the healthy target during backoff', async () => {
  const h = harness({}, { ...retry, deadlineMs: 20, delaysMs: [10, 10], maxDelayMs: 20, pollIntervalMs: 1 });
  await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a'), b = h.owner.acquire('instance:b');
  try {
    await until(() => h.waiting.size === 2);
    h.failEvents('instance:a', new PilotClientError('unavailable', 503, true)); await until(() => h.waiting.size === 2);
    expect(h.delays).toEqual([15]);
    h.failEvents('instance:a', new PilotClientError('unavailable', 503, true)); await until(() => a.state().phase === 'error');
    expect(h.delays).toEqual([15]); expect(b.state().phase).toBe('ready');
  } finally { h.owner.dispose(); }
});

it('does not let an unrelated directory refresh automatically retry a forbidden target', async () => {
  const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a');
  try {
    await until(() => h.waiting.has('instance:a')); h.failEvents('instance:a', new PilotClientError('forbidden'));
    await until(() => a.state().phase === 'error'); const requests = h.calls.length;
    await h.owner.refreshDirectory(); expect(a.state().phase).toBe('error'); expect(h.calls).toHaveLength(requests);
    await h.owner.retryTarget('instance:a'); await until(() => h.waiting.has('instance:a')); expect(a.state().phase).toBe('ready');
  } finally { h.owner.dispose(); }
});

it('does not let an old retry timer retire a manually revalidated replacement', async () => {
  const h = harness(); await h.owner.refreshDirectory(); const a = h.owner.acquire('instance:a');
  try {
    await until(() => h.waiting.has('instance:a')); const timer = defer<void>(); h.sleep(async () => timer.promise);
    h.failEvents('instance:a', new PilotClientError('offline')); await until(() => h.delays.length === 1);
    await h.owner.retryTarget('instance:a'); await until(() => h.waiting.has('instance:a'));
    const current = a.state().scope; timer.resolve(); await new Promise(done => setTimeout(done, 1));
    expect(a.state().scope).toEqual(current); expect(a.state().phase).toBe('ready');
  } finally { h.owner.dispose(); }
});
