import { describe, expect, it } from 'bun:test';
import { MacroPilotNativeClient, PilotClientError, type PilotClientDependencies, type PilotInstanceAccess } from './nativeClient';
import { PilotTargetClient } from './targetClient';
import { validateA1 } from './protocol';
import { CONSUMER_CAPABILITIES, consumerWire, type ConsumerDispatch, type ConsumerOperation } from './consumerTransport';
import { PilotRuntime } from './runtime';
import { PilotKernel } from './kernel';
import type { DesktopStorePorts } from './desktopStorePorts';
import conversationFixture from '../../../contracts/macro-pilot/v2/fixtures/valid/response-conversation.read.json';
import conversationsFixture from '../../../contracts/macro-pilot/v2/fixtures/valid/response-conversations.list.json';
import catalogFixture from '../../../contracts/macro-pilot/v2/fixtures/valid/response-conversations.catalog.json';
import windowFixture from '../../../contracts/macro-pilot/v2/fixtures/valid/response-conversation.window.json';
import projectsFixture from '../../../contracts/macro-pilot/v2/fixtures/valid/response-projects.list.json';

const time = Date.parse('2026-01-01T00:00:00Z');
const account = { contract_version: '1.0' as const, type: 'account' as const, account_id: 'account:synthetic',
  identity: { provider: 'github' as const, subject: '123', login: 'synthetic' }, revision: 1 };
const session = { contract_version: '1.0' as const, type: 'device_session' as const,
  ref: { type: 'session' as const, account_id: account.account_id, session_id: 'session:synthetic' },
  device_id: 'device:synthetic', state: 'active' as const, issued_at: new Date(time).toISOString(), revision: 1 };
const instance = { contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: 'instance:local' },
  label: 'Synthetic desktop', connection_state: 'reachable', supported_contract_versions: ['1.0'], revision: 1 };
const ref = (instanceId: string) => ({ instance_id: instanceId, kind: 'conversation' as const, conversation_id: 'conversation:same' });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
type WireRequest = { url: URL; init: NonNullable<Parameters<PilotClientDependencies['fetch']>[1]>; request: Record<string, unknown>; requestId: string; instanceId: string };
const json = (data: unknown, requestId: string, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'x-request-id': requestId },
});
function terminal(request: Record<string, unknown>, instanceId: string) {
  const operation = request.operation as ConsumerOperation;
  const fixtures = { 'conversation.read': conversationFixture, 'conversations.list': conversationsFixture,
    'conversations.catalog': catalogFixture, 'conversation.window': windowFixture, 'projects.list': projectsFixture };
  const result = JSON.parse(JSON.stringify(fixtures[operation]).replaceAll('instance-demo', instanceId)) as typeof conversationFixture;
  result.request_id = String(request.request_id); result.account_id = account.account_id;
  if (operation === 'conversation.read') result.result.items[0].text = `From ${instanceId}`;
  return result;
}
const accepted = (w: WireRequest, expires = time + 60_000) => json({ transport_version: '2.0', type: 'accepted',
  request_id: w.requestId, exchange_id: w.requestId, expires_at: new Date(expires).toISOString() }, w.requestId, 202);
const sessionError = (requestId: string, code: 'unauthorized' | 'session_revoked' = 'session_revoked') => ({
  contract_version: '1.0', type: 'error', request_id: requestId,
  error: { code, message: 'Synthetic authentication error', retryable: false },
});
const remoteError = (w: WireRequest, code: string, status: number) => json({ contract_version: '2.0', type: 'error',
  request_id: w.requestId, account_id: account.account_id, operation: w.request.operation ?? 'events.read', code, retryable: ['unavailable', 'instance_offline'].includes(code) }, w.requestId, status);

async function harness() {
  const values: Record<string, unknown> = { macro_pilot_native_v1: { configurationId: 'config:synthetic',
    relayOrigin: 'https://relay.example', account, deviceSession: session, instance, instanceCreationId: 'creation:local' } };
  const secret = Buffer.alloc(32, 7).toString('base64url');
  const secrets = new Map([['session_token', secret], ['instance_key', Buffer.alloc(32, 8).toString('base64url')]]);
  const reads: string[] = [], requests: WireRequest[] = [];
  let next = 0, now = time;
  let intercept: ((w: WireRequest) => Promise<Response | undefined>) | undefined;
  let secretWait: ((kind: string) => Promise<void>) | undefined;
  const originals = new Map<string, Record<string, unknown>>();
  const dependencies: PilotClientDependencies = {
    fetch: (async (input, init = {}) => {
      const url = new URL(String(input));
      const requestId = new Headers(init.headers).get('x-request-id')!;
      let request = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (init.method === 'GET' && url.pathname.includes('/requests/')) request = originals.get(requestId)!;
      if (request.type === 'request') originals.set(requestId, request);
      const w = { url, init, request, requestId, instanceId: decodeURIComponent(/instances\/([^/]+)/u.exec(url.pathname)?.[1] ?? '') };
      requests.push(w);
      const overridden = await intercept?.(w);
      if (overridden) return overridden;
      if (url.pathname.endsWith('/me')) return json({ transport_version: '1.0', account, device_session: session }, requestId);
      if (request.type === 'negotiate') return json({ negotiation_version: '1.0', type: 'negotiated', request_id: requestId,
        ...(request.instance_id ? { instance_id: request.instance_id } : {}), selected_version: '2.0',
        ...(request.capabilities ? { capabilities: request.capabilities } : {}) }, requestId);
      if (request.operation === 'session.logout') return json({ contract_version: '2.0', type: 'response',
        request_id: requestId, account_id: account.account_id, operation: 'session.logout', result: { outcome: 'applied', revision: 2 } }, requestId);
      if (request.type === 'events.request') return json({ contract_version: '2.0', type: 'events.page', request_id: requestId,
        account_id: account.account_id, stream_id: `stream:${w.instanceId}`, after_sequence: 0, next_sequence: 0, reset: true, events: [] }, requestId);
      return json(terminal(request, w.instanceId), requestId);
    }) as PilotClientDependencies['fetch'],
    getStateSnapshot: async () => ({ schemaVersion: 1, values }),
    setStateValue: async (key, value) => { values[key] = structuredClone(value); return { schemaVersion: 1, values }; },
    secretRead: async scope => { reads.push(scope.kind); await secretWait?.(scope.kind); return secrets.get(scope.kind) ?? null; },
    secretWrite: async (scope, value) => { secrets.set(scope.kind, value); },
    secretDelete: async scope => { secrets.delete(scope.kind); },
    randomBytes: size => new Uint8Array(size).fill(++next), sha256: async () => new Uint8Array(32), now: () => new Date(now),
  };
  const client = new MacroPilotNativeClient(dependencies);
  await client.initialize();
  const transport = client.consumerTransport();
  const targets: PilotTargetClient[] = [];
  const target = (id = 'instance:a', access?: PilotInstanceAccess) => {
    const target = new PilotTargetClient(transport, id, { access }); targets.push(target); return target;
  };
  return { client, dependencies, transport, target, requests, reads, secret, values,
    intercept: (handler: typeof intercept) => { intercept = handler; },
    secretWait: (handler: typeof secretWait) => { secretWait = handler; },
    advance: (ms: number) => { now += ms; }, dispose: () => { for (const t of targets) t.dispose(); },
  };
}
const access = (id = 'instance:a', revision = 1, state: 'granted' | 'revoked' = 'granted'): PilotInstanceAccess => ({
  contract_version: '1.0', type: 'instance_access', ref: { type: 'instance_access', account_id: account.account_id,
    session_id: session.ref.session_id, instance_id: id }, state, permissions: ['supervise'], granted_at: new Date(time).toISOString(), revision,
});

describe('D1 desktop target reads', () => {
  it('reads the closed operation set and never exposes installation credentials', async () => {
    const h = await harness(); const a = h.target();
    try {
      expect(await a.negotiate()).toEqual(CONSUMER_CAPABILITIES);
      const read = await a.read('conversation.read', { ref: ref(a.instanceId) });
      expect(read.response.result.items[0]).toMatchObject({ text: 'From instance:a' });
      await a.read('projects.list', { instance_id: a.instanceId });
      await a.read('conversations.list', { instance_id: a.instanceId, kind: 'conversation' });
      await a.read('conversations.catalog', { instance_id: a.instanceId, kind: 'conversation' });
      await a.read('conversation.window', { ref: ref(a.instanceId) });
      expect(read.scope).toMatchObject({ configurationId: 'config:synthetic', relayOrigin: 'https://relay.example',
        accountId: account.account_id, sessionId: session.ref.session_id, epoch: 0, instanceId: a.instanceId });
      expect(JSON.stringify(read.scope)).not.toContain(h.secret);
      expect(h.reads.every(kind => kind === 'session_token')).toBe(true);
      for (const w of h.requests) {
        expect(new Headers(w.init.headers).get('authorization')).toBe(`Bearer ${h.secret}`);
        expect(new Headers(w.init.headers).has('x-instance-key')).toBe(false);
        expect(w.init.maxRedirections).toBe(0);
      }
    } finally { h.dispose(); }
  });

  it('rejects unsupported capabilities, dependent selections and mutations before effects', async () => {
    const h = await harness();
    try {
      expect(() => new PilotTargetClient(h.transport, 'instance:a', { capabilities: ['conversation-history-1'] })).toThrow('invalid_configuration');
      const a = h.target();
      for (const capabilities of [['conversation-history-1'], ['conversation-interactions-1'], ['conversation-files-1']]) {
        h.intercept(async w => w.request.type === 'negotiate' ? json({ negotiation_version: '1.0', type: 'negotiated',
          request_id: w.requestId, instance_id: a.instanceId, selected_version: '2.0', capabilities }, w.requestId) : undefined);
        await expect(a.negotiate()).rejects.toMatchObject({ code: 'invalid_response' });
      }
      h.intercept(async w => w.request.type === 'negotiate' ? json({ negotiation_version: '1.0', type: 'negotiated',
        request_id: w.requestId, instance_id: a.instanceId, selected_version: '2.0' }, w.requestId) : undefined);
      await a.negotiate();
      const count = h.requests.length;
      await expect(a.read('conversations.catalog', { instance_id: a.instanceId, kind: 'conversation' })).rejects.toMatchObject({ code: 'extension_unavailable' });
      await a.negotiate();
      await expect(a.read('conversation.read', { ref: ref(a.instanceId), consistency: 'network-reliability-1' })).rejects.toMatchObject({ code: 'extension_unavailable' });
      expect(h.requests.length).toBe(count + 1);
      const mutation = { kind: 'submit', request: { contract_version: '2.0', type: 'request', account_id: account.account_id,
        request_id: 'request:mutation', operation: 'conversation.action', body: { ref: ref(a.instanceId), expected_revision: 1, idempotency_key: 'synthetic:mutation:key', action: 'pin' } } };
      expect(() => consumerWire(a.instanceId, mutation as ConsumerDispatch)).toThrow('invalid_configuration');
      expect(() => new PilotTargetClient(h.transport, 'x'.repeat(129))).toThrow('invalid_configuration');
      expect(() => new PilotTargetClient(h.transport, '')).toThrow('invalid_configuration');
      expect(() => consumerWire('../bad', { kind: 'poll', request: {} } as ConsumerDispatch)).toThrow('invalid_configuration');
    } finally { h.dispose(); }
  });

  it('isolates two identical chat IDs while one target stalls, with no waiting queue', async () => {
    const h = await harness(); const a = h.target(), b = h.target('instance:b');
    const entered = deferred<void>(), delayed = deferred<Response>();
    try {
      await Promise.all([a.negotiate(), b.negotiate()]);
      h.intercept(async w => {
        if (w.instanceId === a.instanceId && w.request.type === 'request') { entered.resolve(); return delayed.promise; }
      });
      const body = { ref: ref(a.instanceId) };
      const pending = a.read('conversation.read', body);
      await entered.promise;
      body.ref.instance_id = b.instanceId;
      await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({ code: 'conflict' });
      const resultB = await b.read('conversation.read', { ref: ref(b.instanceId) });
      expect(resultB.response.result.items[0]).toMatchObject({ text: 'From instance:b' });
      const sent = h.requests.find(w => w.instanceId === a.instanceId && w.request.type === 'request')!;
      expect((sent.request.body as { ref: { instance_id: string } }).ref.instance_id).toBe(a.instanceId);
      delayed.resolve(json(terminal(sent.request, sent.instanceId), sent.requestId));
      const resultA = await pending;
      expect(resultA.response.result.items[0]).toMatchObject({ text: 'From instance:a' });
      expect(resultA.scope.instanceId).not.toBe(resultB.scope.instanceId);
      await expect(a.read('conversation.read', { ref: ref(b.instanceId) })).rejects.toMatchObject({ code: 'invalid_configuration' });
      expect(h.client.getState().status).toBe('connected');
    } finally { h.dispose(); }
  });

  it('keeps transport failures and observed access changes local to the target', async () => {
    const h = await harness(); const a = h.target('instance:a', access()), b = h.target('instance:b');
    try {
      await Promise.all([a.negotiate(), b.negotiate()]);
      const scopeB = b.scope();
      h.intercept(async w => { if (w.instanceId === a.instanceId && w.request.type === 'request') throw new Error('Synthetic transport failure'); return undefined; });
      await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({ code: 'offline' });
      expect(h.client.getState().status).toBe('connected');
      h.intercept(async w => w.instanceId === a.instanceId && w.request.type === 'request' ? remoteError(w, 'forbidden', 403) : undefined);
      await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({ code: 'forbidden' });
      expect(b.scope()).toEqual(scopeB);
      h.intercept(undefined); await a.negotiate();
      h.intercept(async w => w.instanceId === a.instanceId && w.request.type === 'request' ? remoteError(w, 'instance_offline', 503) : undefined);
      await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({ code: 'unavailable' });
      expect(a.capabilities()).toEqual([]);
      expect(b.scope()).toEqual(scopeB);
      a.setAccess(access(a.instanceId, 2, 'revoked'));
      const count = h.requests.length;
      await expect(a.negotiate()).rejects.toMatchObject({ code: 'forbidden' });
      expect(h.requests.length).toBe(count);
      expect(() => a.setAccess(access(a.instanceId, 1))).toThrow('stale_revision');
      expect(() => a.setAccess(access(b.instanceId, 3))).toThrow('invalid_configuration');
      await b.read('conversation.read', { ref: ref(b.instanceId) });
    } finally { h.dispose(); }
  });

  it('cancels a credential wait before dispatch and keeps the other target usable', async () => {
    const h = await harness(); const a = h.target(), b = h.target('instance:b');
    const entered = deferred<void>(), credential = deferred<void>();
    try {
      await Promise.all([a.negotiate(), b.negotiate()]);
      h.secretWait(async () => { entered.resolve(); await credential.promise; });
      const count = h.requests.length;
      const pending = a.read('conversation.read', { ref: ref(a.instanceId) });
      await entered.promise;
      a.reset();
      await expect(pending).rejects.toMatchObject({ code: 'context_changed' });
      credential.resolve(); h.secretWait(undefined);
      expect(h.requests.length).toBe(count);
      await b.read('conversation.read', { ref: ref(b.instanceId) });
    } finally { credential.resolve(); h.dispose(); }
  });

  for (const phase of ['POST', 'GET'] as const) it(`discards and cancels a late ${phase} response after generation replacement`, async () => {
    const h = await harness(); const a = h.target(), entered = deferred<WireRequest>(), late = deferred<Response>();
    let cancelled = 0;
    try {
      await a.negotiate();
      h.intercept(async w => {
        if (w.request.type !== 'request') return;
        if (phase === 'GET' && w.init.method !== 'GET') return accepted(w);
        entered.resolve(w); return late.promise;
      });
      const pending = a.read('conversation.read', { ref: ref(a.instanceId) });
      const w = await entered.promise;
      a.reset();
      await expect(pending).rejects.toMatchObject({ code: 'context_changed' });
      late.resolve(new Response(new ReadableStream({ cancel: () => { cancelled++; } }), { headers: { 'x-request-id': w.requestId } }));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(cancelled).toBe(1);
      h.intercept(undefined); await a.negotiate();
      await a.read('conversation.read', { ref: ref(a.instanceId) });
    } finally { h.dispose(); }
  });

  it('does not purge our session for the remote producer session_revoked error', async () => {
    const h = await harness(); const a = h.target(), b = h.target('instance:b');
    let provisioning = 0;
    try {
      await Promise.all([a.negotiate(), b.negotiate()]);
      h.dependencies.deviceName = async () => { provisioning++; throw new Error('Provisioning forbidden'); };
      h.intercept(async w => w.instanceId === a.instanceId && w.request.type === 'request' ? remoteError(w, 'session_revoked', 401) : undefined);
      await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({ code: 'session_revoked' });
      expect(h.requests.filter(w => w.url.pathname.endsWith('/me'))).toHaveLength(2);
      expect(provisioning).toBe(0);
      expect(h.client.getState()).toMatchObject({ status: 'connected', deviceSession: session, instance });
      await b.read('conversation.read', { ref: ref(b.instanceId) });
      expect(h.reads.every(kind => kind === 'session_token')).toBe(true);
    } finally { h.dispose(); }
  });

  for (const code of ['unauthorized', 'session_revoked'] as const) it(`clears dependent targets only after canonical /me ${code}`, async () => {
    const h = await harness(); const a = h.target(), b = h.target('instance:b');
    try {
      await Promise.all([a.negotiate(), b.negotiate()]);
      h.intercept(async w => w.url.pathname.endsWith('/me') ? json(sessionError(w.requestId, code), w.requestId, 401) :
        w.request.type === 'request' ? remoteError(w, 'session_revoked', 401) : undefined);
      await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({ code: 'session_revoked' });
      expect(h.client.getState()).toMatchObject({ status: 'signed_out', account: null, deviceSession: null });
      await expect(b.read('conversation.read', { ref: ref(b.instanceId) })).rejects.toMatchObject({ code: 'context_changed' });
    } finally { h.dispose(); }
  });

  it('does not restore context from a /me response arriving after logout', async () => {
    const h = await harness(); const a = h.target(), proof = deferred<Response>(), entered = deferred<WireRequest>();
    try {
      await a.negotiate();
      h.intercept(async w => {
        if (w.url.pathname.endsWith('/me')) { entered.resolve(w); return proof.promise; }
        if (w.instanceId === a.instanceId && w.request.type === 'request') return remoteError(w, 'session_revoked', 401);
      });
      const pending = a.read('conversation.read', { ref: ref(a.instanceId) });
      const w = await entered.promise;
      await h.client.logout();
      proof.resolve(json({ transport_version: '1.0', account, device_session: session }, w.requestId));
      await expect(pending).rejects.toMatchObject({ code: 'context_changed' });
      expect(h.client.getState().deviceSession).toBeNull();
    } finally { h.dispose(); }
  });

  it('correlates GET to the original request and refuses a renewed accepted expiry', async () => {
    const h = await harness(); const a = h.target();
    try {
      await a.negotiate();
      const ids: string[] = [];
      h.intercept(async w => {
        if (w.request.type !== 'request') return;
        ids.push(w.requestId);
        return w.init.method === 'POST' ? accepted(w, time + 50_000) : undefined;
      });
      await a.read('conversation.read', { ref: ref(a.instanceId) });
      expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
      h.intercept(async w => w.request.type === 'request' ? accepted(w, time + (w.init.method === 'POST' ? 50_000 : 55_000)) : undefined);
      await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({ code: 'invalid_response' });
    } finally { h.dispose(); }
  });

  for (const issue of ['accepted-id', 'terminal-id', 'operation', 'account', 'expired', 'too-far', 'redirect', 'oversized'] as const) {
    it(`rejects ${issue} without changing the producer state`, async () => {
      const h = await harness(); const a = h.target();
      try {
        await a.negotiate();
        h.intercept(async w => {
          if (w.request.type !== 'request') return;
          if (issue === 'expired') return accepted(w, time);
          if (issue === 'too-far') return accepted(w, time + 60_001);
          if (issue === 'accepted-id') return json({ transport_version: '2.0', type: 'accepted', request_id: w.requestId,
            exchange_id: 'wrong:exchange', expires_at: new Date(time + 50_000).toISOString() }, w.requestId, 202);
          if (issue === 'oversized') return new Response('[]', { headers: { 'content-length': String(256 * 1024 + 1) } });
          const result = terminal(w.request, w.instanceId);
          if (issue === 'terminal-id') result.request_id = 'wrong:request';
          if (issue === 'operation') result.operation = 'conversations.list';
          if (issue === 'account') result.account_id = 'account:other';
          const response = json(result, w.requestId);
          if (issue === 'redirect') Object.defineProperty(response, 'url', { value: 'https://other.example/api' });
          return response;
        });
        await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({
          code: issue === 'redirect' ? 'redirect_refused' : issue === 'oversized' ? 'response_too_large' : 'invalid_response',
        });
        expect(h.client.getState().status).toBe('connected');
      } finally { h.dispose(); }
    });
  }

  it('validates page continuation and expires prior scopes after a target reset', async () => {
    const h = await harness(); const a = h.target();
    try {
      await a.negotiate();
      h.intercept(async w => {
        if (w.request.type !== 'request') return;
        const response = terminal(w.request, w.instanceId);
        const continuing = Boolean((w.request.body as { continuation?: unknown }).continuation);
        response.result.page.total = 2;
        if (continuing) {
          response.result.page.offset = 1; response.result.items[0].position = 1; response.result.items[0].message_id = 'message:second';
        } else response.result.page.next_cursor = 'cursor:second' as never;
        return json(response, w.requestId);
      });
      const first = await a.read('conversation.read', { ref: ref(a.instanceId) });
      const continuation = { snapshot_id: first.response.result.page.snapshot_id, cursor: 'cursor:second' };
      const second = await a.read('conversation.read', { ref: ref(a.instanceId), continuation }, { previous: first, seenIdentities: new Set(['message-demo']) });
      expect(second.response.result.page.offset).toBe(1);
      await expect(a.read('conversation.read', { ref: { ...ref(a.instanceId), conversation_id: 'conversation:other' }, continuation }, { previous: first })).rejects.toMatchObject({ code: 'invalid_configuration' });
      a.reset(); await a.negotiate();
      await expect(a.read('conversation.read', { ref: ref(a.instanceId), continuation }, { previous: first })).rejects.toMatchObject({ code: 'context_changed' });
    } finally { h.dispose(); }
  });
});


describe('D1 target event lifecycle', () => {
  it('acknowledges only after application and never adopts a caller-edited cursor', async () => {
    const h = await harness(); const a = h.target();
    try {
      await a.negotiate();
      const initial = await a.events();
      await expect(a.events()).rejects.toMatchObject({ code: 'conflict' });
      initial.page.next_sequence = 999;
      a.acknowledgeEvents(initial);
      h.intercept(async w => {
        if (w.request.type !== 'events.request') return;
        expect(w.request.after_sequence).toBe(0);
        return json({ contract_version: '2.0', type: 'events.page', request_id: w.requestId, account_id: account.account_id,
          stream_id: w.request.stream_id, after_sequence: 0, next_sequence: 1, reset: false,
          events: [{ contract_version: '2.0', type: 'event', account_id: account.account_id, stream_id: w.request.stream_id,
            sequence: 1, occurred_at: new Date(time).toISOString(), change: { kind: 'conversation.changed', scope: ref(a.instanceId), revision: 2 } }] }, w.requestId);
      });
      const next = await a.events();
      expect(next.page.events).toHaveLength(1);
      expect(() => a.acknowledgeEvents(initial)).toThrow('context_changed');
      a.acknowledgeEvents(next);
      expect(() => a.acknowledgeEvents(next)).toThrow('context_changed');
    } finally { h.dispose(); }
  });

  it('allows a separate event request and retires only this target read on reset', async () => {
    const h = await harness(); const a = h.target(), b = h.target('instance:b');
    const entered = deferred<WireRequest>(), late = deferred<Response>();
    try {
      await Promise.all([a.negotiate(), b.negotiate()]);
      a.acknowledgeEvents(await a.events()); b.acknowledgeEvents(await b.events());
      const scopeB = b.scope();
      h.intercept(async w => {
        if (w.instanceId === a.instanceId && w.request.type === 'request') { entered.resolve(w); return late.promise; }
      });
      const reading = a.read('conversation.read', { ref: ref(a.instanceId) });
      const sent = await entered.promise;
      const reset = await a.events();
      expect(reset.page.reset).toBe(true);
      await expect(reading).rejects.toMatchObject({ code: 'context_changed' });
      late.resolve(json(terminal(sent.request, sent.instanceId), sent.requestId));
      expect(b.scope()).toEqual(scopeB);
      await b.read('conversation.read', { ref: ref(b.instanceId) });
      a.acknowledgeEvents(reset);
    } finally { h.dispose(); }
  });

  for (const issue of ['foreign-instance', 'gap', 'wrong-stream', 'unselected-reliability'] as const) {
    it(`refuses ${issue} event pages without resetting the other target`, async () => {
      const h = await harness(); const a = issue === 'unselected-reliability'
        ? new PilotTargetClient(h.transport, 'instance:a', { capabilities: [] }) : h.target();
      const b = h.target('instance:b');
      try {
        await Promise.all([a.negotiate(), b.negotiate()]);
        a.acknowledgeEvents(await a.events());
        const scopeB = b.scope();
        h.intercept(async w => {
          if (w.request.type !== 'events.request') return;
          const stream = issue === 'wrong-stream' ? 'stream:wrong' : w.request.stream_id;
          return json({ contract_version: '2.0', type: 'events.page', request_id: w.requestId, account_id: account.account_id,
            stream_id: stream, after_sequence: 0, next_sequence: 1, reset: false,
            events: [{ contract_version: '2.0', type: 'event', account_id: account.account_id, stream_id: stream,
              sequence: issue === 'gap' ? 2 : 1, occurred_at: new Date(time).toISOString(),
              change: { kind: issue === 'unselected-reliability' ? 'conversation.resource_changed' : 'conversation.changed',
                scope: ref(issue === 'foreign-instance' ? b.instanceId : a.instanceId), revision: 2 } }] }, w.requestId);
        });
        await expect(a.events()).rejects.toMatchObject({ code: 'invalid_response' });
        expect(b.scope()).toEqual(scopeB);
      } finally { a.dispose(); h.dispose(); }
    });
  }

  it('aborts an event wait on disposal without reopening the retired handle', async () => {
    const h = await harness(); const a = h.target(), entered = deferred<void>(), late = deferred<Response>();
    try {
      await a.negotiate();
      h.intercept(async w => { if (w.request.type === 'events.request') { entered.resolve(); return late.promise; } });
      const pending = a.events();
      await entered.promise; a.dispose();
      await expect(pending).rejects.toMatchObject({ code: 'context_changed' });
      a.reset();
      await expect(a.negotiate()).rejects.toMatchObject({ code: 'context_changed' });
      late.resolve(new Response(null, { status: 204 }));
    } finally { h.dispose(); }
  });
});

it('keeps a real PilotRuntime publishing locally while two clients read and one fails', async () => {
  const h = await harness(); const a = h.target(), b = h.target('instance:b');
  let polls = 0, readsA = 0, stored: string | null = null, portReads = 0;
  const gates: Array<ReturnType<typeof deferred<Response>>> = [];
  const localTasks = { tasks: [] }, localChat = { marker: 'local-chat' }, localApp = { marker: 'local-app' };
  const ports = { tasks: () => { portReads++; return localTasks; }, chat: () => localChat, app: () => localApp,
    taskLifecycle: () => ({}), taskCommandTargets: () => [] } as unknown as DesktopStorePorts;
  // D1 does not prepare or change the producer content composition. Its existing
  // v2 preparation and unsupported-platform paths remain in runtimeContent.test.
  const producer = { getState: h.client.getState, subscribe: h.client.subscribe,
    initialize: () => h.client.initialize(), request: h.client.request.bind(h.client) };
  const runtime = new PilotRuntime(producer, dependencies => new PilotKernel({ ...dependencies,
    storage: { load: async () => stored, compareAndSwap: async (previous, next) => { if (previous !== stored) return false; stored = next; return true; } },
    project: () => { ports.tasks(); return { snapshots: [], state: null }; },
  }), ports);
  const untilPolls = async (count: number) => {
    for (let attempt = 0; polls < count && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(polls).toBeGreaterThanOrEqual(count);
  };
  try {
    h.intercept(async w => {
      if (w.instanceId === 'instance:local' && w.url.pathname.endsWith('/deliveries/poll')) {
        polls++;
        expect(new Headers(w.init.headers).has('x-instance-key')).toBe(true);
        const gate = deferred<Response>(); gates.push(gate); return gate.promise;
      }
      if (w.instanceId === a.instanceId && w.request.type === 'request' && ++readsA > 1) throw new Error('Synthetic failed target');
    });
    await runtime.start(); await untilPolls(1);
    await Promise.all([a.negotiate(), b.negotiate()]);
    await Promise.all([a.read('conversation.read', { ref: ref(a.instanceId) }), b.read('conversation.read', { ref: ref(b.instanceId) })]);
    gates[0].resolve(new Response(null, { status: 204 })); await untilPolls(2);
    await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({ code: 'offline' });
    await b.read('conversation.read', { ref: ref(b.instanceId) });
    gates[1].resolve(new Response(null, { status: 204 })); await untilPolls(3);
    expect(runtime.isStarted()).toBe(true); expect(runtime.getStatus()).toBe('running');
    expect(h.client.getState().status).toBe('connected');
    expect(ports.app()).toBe(localApp as never); expect(ports.chat()).toBe(localChat as never); expect(ports.tasks()).toBe(localTasks as never);
    expect(portReads).toBeGreaterThanOrEqual(3);
    for (const w of h.requests.filter(w => w.instanceId !== 'instance:local')) expect(new Headers(w.init.headers).has('x-instance-key')).toBe(false);
  } finally {
    h.dispose(); await runtime.stop();
    for (const gate of gates) gate.resolve(new Response(null, { status: 204 }));
  }
});

for (const field of ['configurationId', 'relayOrigin', 'accountId', 'sessionId', 'epoch'] as const) {
  it(`retires a target when its non-secret ${field} context changes`, async () => {
    const h = await harness();
    let context = h.transport.context();
    const listeners = new Set<() => void>();
    const port = { ...h.transport, context: () => context,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const target = new PilotTargetClient(port, 'instance:a');
    try {
      await target.negotiate();
      context = { ...context, [field]: field === 'epoch' ? context.epoch + 1 : `changed:${context[field]}`, key: 'changed:context' };
      for (const listener of [...listeners]) listener();
      await expect(target.read('conversation.read', { ref: ref(target.instanceId) })).rejects.toMatchObject({ code: 'context_changed' });
      expect(listeners.size).toBe(0);
    } finally { target.dispose(); h.dispose(); }
  });
}


it('requires complete-capture identity tracking from the caller for pagination', async () => {
  const h = await harness(); const a = h.target();
  try {
    await a.negotiate();
    const first = await a.read('conversation.read', { ref: ref(a.instanceId) });
    await expect(a.read('conversation.read', { ref: ref(a.instanceId), continuation: { snapshot_id: 'snapshot-demo', cursor: 'cursor:missing' } },
      { previous: first })).rejects.toMatchObject({ code: 'invalid_configuration' });
  } finally { h.dispose(); }
});

for (const proof of ['offline', 'wrong-account', 'wrong-request-id', 'missing-header', 'wrong-body-id', 'malformed-401', 'wrong-status-503', 'transport-auth-error'] as const) {
  it(`keeps the emitter session and retires the target if /me is ${proof}`, async () => {
    const h = await harness(); const a = h.target(), b = h.target('instance:b');
    try {
      await Promise.all([a.negotiate(), b.negotiate()]);
      h.intercept(async w => {
        if (w.url.pathname.endsWith('/me')) {
          if (proof === 'offline') throw new Error('Synthetic failed proof');
          if (proof === 'transport-auth-error') throw new PilotClientError('session_revoked', 401);
          if (proof === 'missing-header') return new Response(JSON.stringify(sessionError(w.requestId)), { status: 401 });
          if (proof === 'wrong-body-id') return json(sessionError('request:foreign'), w.requestId, 401);
          if (proof === 'malformed-401') return json({}, w.requestId, 401);
          if (proof === 'wrong-status-503') return json(sessionError(w.requestId), w.requestId, 503);
          return json({ transport_version: '1.0', account: proof === 'wrong-account' ? { ...account, account_id: 'account:other' } : account,
            device_session: session }, proof === 'wrong-request-id' ? 'request:other' : w.requestId);
        }
        if (w.instanceId === a.instanceId && w.request.type === 'request') return remoteError(w, 'session_revoked', 401);
      });
      await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({ code: proof === 'offline' ? 'unavailable' : proof === 'transport-auth-error' ? 'session_revoked' : 'invalid_response' });
      expect(a.capabilities()).toEqual([]);
      expect(h.client.getState()).toMatchObject({ status: 'connected', deviceSession: session });
      await b.read('conversation.read', { ref: ref(b.instanceId) });
    } finally { h.dispose(); }
  });
}

it('does not extend an exchange deadline when its terminal GET arrives after expiry', async () => {
  const h = await harness(); const a = h.target();
  try {
    await a.negotiate();
    h.intercept(async w => {
      if (w.request.type !== 'request') return;
      if (w.init.method === 'POST') return accepted(w, time + 1000);
      h.advance(1001); return json(terminal(w.request, w.instanceId), w.requestId);
    });
    await expect(a.read('conversation.read', { ref: ref(a.instanceId) })).rejects.toMatchObject({ code: 'snapshot_expired' });
    expect(h.requests.filter(w => w.request.type === 'request')).toHaveLength(2);
  } finally { h.dispose(); }
});


it('uses only selected reliability semantics for conditional projects and conversation reads', async () => {
  const h = await harness(); const a = h.target();
  try {
    await a.negotiate();
    h.intercept(async w => {
      if (w.request.type !== 'request') return;
      if (w.request.operation === 'projects.list') return json({ contract_version: '2.0', type: 'response',
        request_id: w.requestId, account_id: account.account_id, operation: 'projects.list',
        result: { not_modified: true, revision: 7, observed_at: new Date(time).toISOString() } }, w.requestId);
      if (w.request.operation === 'conversations.list') {
        const response = JSON.parse(JSON.stringify(conversationsFixture).replaceAll('instance-demo', a.instanceId));
        response.request_id = w.requestId; response.account_id = account.account_id;
        Object.assign(response.result.items[0], { content_revision: 3, mode: 'Chat', provider_error: null });
        return json(response, w.requestId);
      }
    });
    const project = await a.read('projects.list', { instance_id: a.instanceId, known_revision: 7, consistency: 'network-reliability-1' });
    expect(project.response.result).toMatchObject({ not_modified: true, revision: 7 });
    const conversations = await a.read('conversations.list', { instance_id: a.instanceId, kind: 'conversation', consistency: 'network-reliability-1' });
    expect(conversations.response.result.items[0]).toMatchObject({ content_revision: 3, mode: 'Chat' });
    await a.read('conversation.read', { ref: ref(a.instanceId), consistency: 'network-reliability-1' });
  } finally { h.dispose(); }
});

it('implements backward window continuity only with both history and conversations selected', async () => {
  const h = await harness(); const a = h.target();
  const limited = new PilotTargetClient(h.transport, 'instance:b', { capabilities: ['conversations-1'] });
  try {
    await Promise.all([a.negotiate(), limited.negotiate()]);
    await expect(limited.read('conversation.window', { ref: ref(limited.instanceId), direction: 'backward' })).rejects.toMatchObject({ code: 'extension_unavailable' });
    h.intercept(async w => {
      if (w.request.operation !== 'conversation.window') return;
      const response = JSON.parse(JSON.stringify(windowFixture));
      const continuation = (w.request.body as { continuation?: unknown }).continuation;
      response.request_id = w.requestId; response.account_id = account.account_id;
      Object.assign(response.result.page, { direction: 'backward', total: 2, offset: continuation ? 0 : 1, next_cursor: continuation ? null : 'cursor:older' });
      Object.assign(response.result.items[0], { position: continuation ? 0 : 1, message_id: continuation ? 'message:older' : 'message:newer' });
      return json(response, w.requestId);
    });
    const newest = await a.read('conversation.window', { ref: ref(a.instanceId), direction: 'backward' });
    const older = await a.read('conversation.window', { ref: ref(a.instanceId), direction: 'backward',
      continuation: { snapshot_id: newest.response.result.page.snapshot_id, cursor: 'cursor:older' } },
      { previous: newest, seenIdentities: new Set(['message:newer']) });
    expect(older.response.result.page.offset).toBe(0);
  } finally { limited.dispose(); h.dispose(); }
});


it('does not readmit a disposed handle page through a new handle with the same target and counter', async () => {
  const h = await harness(); const first = h.target();
  try {
    await first.negotiate();
    const page = await first.read('conversation.read', { ref: ref(first.instanceId) });
    first.dispose();
    const replacement = h.target(); await replacement.negotiate();
    expect(replacement.scope().generation).toBe(page.scope.generation);
    expect(replacement.scope().connectionId).not.toBe(page.scope.connectionId);
    await expect(replacement.read('conversation.read', { ref: ref(replacement.instanceId),
      continuation: { snapshot_id: page.response.result.page.snapshot_id, cursor: 'cursor:retired' } },
      { previous: page, seenIdentities: new Set(['message-demo']) })).rejects.toMatchObject({ code: 'context_changed' });
  } finally { h.dispose(); }
});


it('accepts canonical revision zero, advances to one and preserves revocation fences', async () => {
  const h = await harness();
  const zero = access('instance:a', 0);
  const entered = deferred<WireRequest>(), late = deferred<Response>();
  try {
    expect(validateA1(zero)).toBe(true);
    const a = h.target('instance:a', zero), b = h.target('instance:b');
    await Promise.all([a.negotiate(), b.negotiate()]);
    const scopeB = b.scope();
    expect((await a.read('conversation.read', { ref: ref(a.instanceId) })).scope.accessRevision).toBe(0);
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => a.setAccess({ ...zero, revision })).toThrow('invalid_configuration');
    }
    const contradictory = { ...zero, permissions: ['respond' as const] };
    expect(validateA1(contradictory)).toBe(true);
    expect(() => a.setAccess(contradictory)).toThrow('stale_revision');
    const one = access(a.instanceId, 1);
    expect(validateA1(one)).toBe(true);
    a.setAccess(one); await a.negotiate();
    expect((await a.read('conversation.read', { ref: ref(a.instanceId) })).scope.accessRevision).toBe(1);
    expect(() => a.setAccess(zero)).toThrow('stale_revision');
    h.intercept(async w => {
      if (w.instanceId === a.instanceId && w.request.type === 'request') { entered.resolve(w); return late.promise; }
    });
    const pending = a.read('conversation.read', { ref: ref(a.instanceId) });
    const w = await entered.promise;
    const revoked = { ...access(a.instanceId, 2, 'revoked'), revoked_at: new Date(time).toISOString() };
    expect(validateA1(revoked)).toBe(true);
    a.setAccess(revoked);
    await expect(pending).rejects.toMatchObject({ code: 'context_changed' });
    late.resolve(json(terminal(w.request, w.instanceId), w.requestId));
    await expect(a.negotiate()).rejects.toMatchObject({ code: 'forbidden' });
    expect(() => a.setAccess(one)).toThrow('stale_revision');
    expect(b.scope()).toEqual(scopeB);
    await b.read('conversation.read', { ref: ref(b.instanceId) });
  } finally { h.dispose(); }
});
