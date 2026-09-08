import { describe, expect, it, spyOn } from 'bun:test';
import { MacroPilotNativeClient, type PilotClientDependencies } from './nativeClient';

const identity = { account_id: 'account-demo', revision: 4, provider: 'github' as const, subject: '123456', login: 'example', session_id: 'session-demo' };
const account = { contract_version: '1.0', type: 'account', account_id: identity.account_id,
  identity: { provider: 'github', subject: identity.subject, login: identity.login }, revision: 1 };
const session = { contract_version: '1.0', type: 'device_session', ref: { type: 'session', account_id: identity.account_id, session_id: identity.session_id },
  device_id: 'device-demo', state: 'active', issued_at: '2026-09-08T10:00:00Z', revision: 1 };
const devices = ['session-demo', 'session-other'].map((id) => ({ session_id: id, device_id: `device-${id}`, label: id,
  client_kind: 'desktop' as const, state: 'active' as const, created_at: '2026-09-08T10:00:00Z', expires_at: '2026-10-08T10:00:00Z' }));
const page = { snapshot_id: 'snapshot-demo', revision: 4, observed_at: '2026-09-08T10:00:00Z', expires_at: '2026-09-08T10:05:00Z',
  export_policy_revision: 'visible-1', offset: 0, total: 2, next_cursor: null };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
type Request = { type: string; operation?: string; request_id: string; account_id?: string; body?: Record<string, unknown> };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const harness = () => {
  const localData = { projects: ['project-local'], conversations: ['conversation-local'], identities: ['identity-local'] };
  const values: Record<string, unknown> = { localData: structuredClone(localData), macro_pilot_native_v1: {
    configurationId: 'config-demo', relayOrigin: 'https://relay.example', account, deviceSession: session,
    instance: null, instanceAccess: null, instanceCreationId: 'creation-demo', attempt: null,
  } };
  const secrets = new Map([['session_token:session-demo', 'token-secret'], ['instance_key:creation-demo', 'instance-secret']]);
  const requests: Array<{ url: string; body: Request; headers: Headers }> = [];
  let intercept: ((request: Request, url: string) => Promise<Response | undefined> | Response | undefined) | undefined;
  let random = 0;
  const deps: PilotClientDependencies = {
    fetch: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Request : { type: '', request_id: '' };
      requests.push({ url: String(url), body, headers: new Headers(init?.headers) });
      const override = await intercept?.(body, String(url));
      if (override) return override;
      if (String(url).endsWith('/me')) return json({ account, device_session: session });
      if (body.type === 'negotiate') return json({ negotiation_version: '1.0', type: 'negotiated', request_id: body.request_id, selected_version: '2.0' });
      let result: unknown = { outcome: 'applied', revision: 5 };
      if (body.operation === 'account.get') result = identity;
      if (body.operation === 'sessions.list') result = { page, items: devices };
      return json({ contract_version: '2.0', type: 'response', request_id: body.request_id, account_id: body.account_id, operation: body.operation, result });
    },
    getStateSnapshot: async () => ({ schemaVersion: 1, values }),
    setStateValue: async (key, value) => { values[key] = structuredClone(value); return { schemaVersion: 1, values }; },
    secretRead: async scope => secrets.get(`${scope.kind}:${scope.resource_id}`) ?? null,
    secretWrite: async (scope, secret) => { secrets.set(`${scope.kind}:${scope.resource_id}`, secret); },
    secretDelete: async scope => { secrets.delete(`${scope.kind}:${scope.resource_id}`); },
    randomBytes: size => new Uint8Array(size).fill(++random), sha256: async () => new Uint8Array(32), now: () => new Date('2026-09-08T10:01:00Z'),
  };
  return { client: new MacroPilotNativeClient(deps), deps, requests, values, secrets, localData,
    intercept: (handler: NonNullable<typeof intercept>) => { intercept = handler; } };
};
const response = (request: Request, result: unknown) => json({ contract_version: '2.0', type: 'response', request_id: request.request_id,
  account_id: request.account_id, operation: request.operation, result });

describe('native account v2 over the HTTP boundary', () => {
  it('loads verified identity and sessions without an instance or producer key', async () => {
    const h = harness(); await h.client.initialize();
    expect(await h.client.getAccountCatalog()).toEqual({ identity, sessions: devices, revision: 4 });
    const calls = h.requests.slice(1);
    expect(calls[0].url).toBe('https://relay.example/pilot/extensions/negotiate');
    expect(calls[0].body).not.toHaveProperty('instance_id');
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe('Bearer token-secret');
      expect(call.headers.get('x-instance-key')).toBeNull();
      expect(call.headers.get('x-request-id')).toBe(call.body.request_id);
    }
  });

  it('fails closed on wrong correlation and missing account extension', async () => {
    const h = harness(); await h.client.initialize();
    h.intercept(request => request.type === 'negotiate' ? json({ negotiation_version: '1.0', type: 'negotiated', request_id: 'wrong', selected_version: '2.0' }) : undefined);
    await expect(h.client.getAccountCatalog()).rejects.toMatchObject({ code: 'invalid_response' });
    h.intercept(() => json({}, 404));
    await expect(h.client.getAccountCatalog()).rejects.toMatchObject({ code: 'extension_unavailable' });
    expect(h.client.getState().deviceSession).not.toBeNull();
  });

  it('uses one immutable paginated catalog and rejects changing metadata or repeated devices', async () => {
    for (const fault of ['none', 'revision', 'duplicate']) {
      const h = harness(); await h.client.initialize();
      h.intercept(request => {
        if (request.operation !== 'sessions.list') return;
        const second = Boolean(request.body?.continuation);
        if (second) expect(request.body?.continuation).toEqual({ snapshot_id: 'snapshot-demo', cursor: 'cursor-next' });
        return response(request, { page: { ...page, offset: second ? 1 : 0, next_cursor: second ? null : 'cursor-next',
          revision: second && fault === 'revision' ? 5 : 4 }, items: [devices[second && fault !== 'duplicate' ? 1 : 0]] });
      });
      if (fault === 'none') expect((await h.client.getAccountCatalog()).sessions).toHaveLength(2);
      else await expect(h.client.getAccountCatalog()).rejects.toMatchObject({ code: fault === 'revision' ? 'stale_revision' : 'invalid_response' });
    }
  });

  it('refuses foreign devices and unconfirmed deletion without sending mutations', async () => {
    const h = harness(); await h.client.initialize(); await h.client.getAccountCatalog();
    const count = h.requests.length;
    await expect(h.client.revokeSession('foreign-device')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.client.deleteAccount({ ...identity, login: 'someone-else' })).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(h.requests).toHaveLength(count);
    expect(await h.client.deleteAccount(identity)).toEqual({ revocationConfirmed: true });
    expect(h.requests.at(-1)?.body.body?.confirmation).toBe('delete_cloud_account');
  });

  it('blocks concurrent mutations before a second HTTP effect', async () => {
    const h = harness(); await h.client.initialize(); await h.client.getAccountCatalog();
    const pending = deferred<Response>();
    const started = deferred<Request>();
    h.intercept(request => { if (request.operation === 'session.revoke') { started.resolve(request); return pending.promise; } });
    const first = h.client.revokeSession('session-other');
    await expect(h.client.revokeSession('session-other')).rejects.toMatchObject({ code: 'conflict' });
    const request = await started.promise;
    pending.resolve(response(request, { outcome: 'applied', revision: 5 }));
    await expect(first).resolves.toEqual({ revocationConfirmed: true });
    expect(h.requests.filter(r => r.body.operation === 'session.revoke')).toHaveLength(1);
    expect(String(request.body?.idempotency_key).length).toBeGreaterThanOrEqual(16);
  });

  for (const operation of ['session.revoke', 'sessions.revoke_all', 'account.delete', 'session.logout'] as const) {
    it(`clears relay secrets after lost ${operation} acknowledgement, preserves all local records, never retries`, async () => {
      const h = harness(); await h.client.initialize(); await h.client.getAccountCatalog();
      h.intercept(request => { if (request.operation === operation) throw new Error('lost response'); return undefined; });
      const result = operation === 'session.revoke' ? await h.client.revokeSession('session-demo') :
        operation === 'sessions.revoke_all' ? await h.client.revokeAllSessions() :
          operation === 'account.delete' ? await h.client.deleteAccount(identity) : await h.client.logout();
      expect(result).toEqual({ revocationConfirmed: false });
      expect(h.client.getState()).toMatchObject({ status: 'signed_out', account: null, instance: null, deviceSession: null });
      expect(h.secrets.size).toBe(0);
      expect(h.values.localData).toEqual(h.localData);
      expect(h.requests.filter(r => r.body.operation === operation)).toHaveLength(1);
      await expect(h.client.getAccountCatalog()).rejects.toMatchObject({ code: 'unauthorized' });
      expect(h.requests.filter(r => r.body.operation === operation)).toHaveLength(1);
    });
  }

  it('clears a revoked session on account reads and keeps definitive stale mutations actionable', async () => {
    const h = harness(); await h.client.initialize(); await h.client.getAccountCatalog();
    h.intercept(request => request.operation === 'account.delete' ? json({ code: 'stale_revision' }, 409) : undefined);
    await expect(h.client.deleteAccount(identity)).rejects.toMatchObject({ code: 'stale_revision' });
    expect(h.client.getState().deviceSession).not.toBeNull();
    h.intercept(request => request.operation === 'account.get' ? json({ code: 'session_revoked' }, 401) : undefined);
    await expect(h.client.getAccountCatalog()).rejects.toMatchObject({ code: 'session_revoked' });
    expect(h.secrets.size).toBe(0);
  });

  it('discards old account responses after revocation and origin replacement', async () => {
    const h = harness(); await h.client.initialize();
    const pending = deferred<Response>();
    const started = deferred<Request>();
    h.intercept((request, url) => {
      if (request.operation === 'account.get') { started.resolve(request); return pending.promise; }
      if (url.endsWith('/revoked')) return json({ code: 'session_revoked' }, 401);
      if (url.endsWith('/auth/attempts')) return json({ transport_version: '1.0', attempt_id: 'attempt-new', poll_secret: 'poll-secret',
        user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-08T10:10:00Z', interval: 5 });
    });
    const loading = h.client.getAccountCatalog().catch(error => error);
    const original = await started.promise;
    await expect(h.client.request('GET', '/revoked', undefined, { authenticated: true })).rejects.toMatchObject({ code: 'session_revoked' });
    await h.client.connect('https://new-relay.example', 'New desktop');
    pending.resolve(response(original, identity));
    expect(await loading).toMatchObject({ code: 'context_changed' });
    expect(h.client.getState()).toMatchObject({ relayOrigin: 'https://new-relay.example', status: 'authorizing', account: null });
    expect(h.requests.filter(r => r.body.operation === 'sessions.list')).toHaveLength(0);
  });

  it('grants all current permissions in the v1 association API', async () => {
    const h = harness();
    const state = h.values.macro_pilot_native_v1 as Record<string, unknown>;
    state.instance = { ref: { instance_id: 'instance-demo' } };
    await h.client.initialize();
    h.intercept((_request, url) => url.endsWith('/resolve') ? json({ status: 'granted' }) : undefined);
    await h.client.resolveAccess('access-demo', 'grant');
    expect(h.requests.at(-1)?.body as unknown).toEqual({ transport_version: '1.0', verdict: 'grant', permissions: ['supervise', 'respond', 'approve_tools', 'review'] });
  });
  it('treats a revoked caller acknowledgement as uncertain and rejects stale captures', async () => {
    const h = harness(); await h.client.initialize(); await h.client.getAccountCatalog();
    h.intercept(request => request.operation === 'sessions.revoke_all' ? json({ code: 'session_revoked' }, 401) : undefined);
    await expect(h.client.revokeAllSessions()).resolves.toEqual({ revocationConfirmed: false });
    expect(h.client.getState().deviceSession).toBeNull();
    expect(h.secrets.size).toBe(0);
    const expired = harness(); await expired.client.initialize();
    expired.intercept(request => request.operation === 'sessions.list' ? response(request, {
      page: { ...page, observed_at: '2026-09-08T09:50:00Z', expires_at: '2026-09-08T09:55:00Z' }, items: devices,
    }) : undefined);
    await expect(expired.client.getAccountCatalog()).rejects.toMatchObject({ code: 'snapshot_expired' });
  });

  it('retains failed secret cleanup for startup and blocks reusing its credentials', async () => {
    const h = harness(); await h.client.initialize(); await h.client.getAccountCatalog();
    const remove = h.deps.secretDelete;
    h.deps.secretDelete = async scope => { if (scope.kind === 'instance_key') throw new Error('vault locked'); await remove(scope); };
    await expect(h.client.deleteAccount(identity)).rejects.toMatchObject({ code: 'vault_unavailable' });
    expect(h.client.getState().deviceSession).toBeNull();
    expect(h.secrets.has('session_token:session-demo')).toBe(false);
    expect(h.values.macro_pilot_native_v1).toHaveProperty('pendingSecretCleanup');
    await expect(h.client.getAccountCatalog()).rejects.toMatchObject({ code: 'unauthorized' });
    h.deps.secretDelete = remove;
    await new MacroPilotNativeClient(h.deps).initialize();
    expect(h.secrets.size).toBe(0);
    expect(h.values.localData).toEqual(h.localData);
  });

  it('deletes the bearer even if relay metadata cannot be cleared', async () => {
    const h = harness(); await h.client.initialize(); await h.client.getAccountCatalog();
    h.deps.setStateValue = async () => { throw new Error('storage unavailable'); };
    await expect(h.client.deleteAccount(identity)).rejects.toMatchObject({ code: 'vault_unavailable' });
    expect(h.client.getState().deviceSession).toBeNull();
    expect(h.secrets.size).toBe(0);
    await expect(h.client.request('GET', '/me', undefined, { authenticated: true })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(h.values.localData).toEqual(h.localData);
  });

  for (const operation of ['session.revoke', 'sessions.revoke_all', 'account.delete', 'session.logout'] as const) {
    it(`normalizes a failed response body after ${operation} and prevents bearer replay`, async () => {
      const h = harness(); await h.client.initialize(); await h.client.getAccountCatalog();
      h.intercept(request => request.operation === operation ? new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError('connection reset while reading body')); },
      }), { status: 200 }) : undefined);
      const result = operation === 'session.revoke' ? await h.client.revokeSession('session-demo') :
        operation === 'sessions.revoke_all' ? await h.client.revokeAllSessions() :
          operation === 'account.delete' ? await h.client.deleteAccount(identity) : await h.client.logout();
      expect(result).toEqual({ revocationConfirmed: false });
      expect(h.secrets.size).toBe(0);
      expect(h.client.getState().deviceSession).toBeNull();
      const sent = h.requests.length;
      await expect(h.client.getAccountCatalog()).rejects.toMatchObject({ code: 'unauthorized' });
      expect(h.requests).toHaveLength(sent);
      expect(h.values.localData).toEqual(h.localData);
    });
  }

  for (const phase of ['headers', 'body'] as const) {
    it(`lets logout cancel a stalled ${phase} read without allowing concurrent mutations`, async () => {
      const h = harness(); await h.client.initialize();
      const started = deferred<Request>();
      const logoutStarted = deferred<Request>();
      const pendingRead = deferred<Response>();
      const pendingLogout = deferred<Response>();
      let bodyCancelled = false;
      const bodyReading = deferred<void>();
      let readSignal: AbortSignal | null | undefined;
      const originalFetch = h.deps.fetch;
      h.deps.fetch = (url, init) => {
        if (String(init?.body).includes('account.get')) readSignal = init?.signal;
        return originalFetch(url, init);
      };
      h.intercept(request => {
        if (request.operation === 'account.get') {
          started.resolve(request);
          return phase === 'headers' ? pendingRead.promise : new Response(new ReadableStream({ pull() { bodyReading.resolve(); }, cancel() { bodyCancelled = true; } }, { highWaterMark: 0 }));
        }
        if (request.operation === 'session.logout') { logoutStarted.resolve(request); return pendingLogout.promise; }
      });
      const read = h.client.getAccountCatalog().catch(error => error);
      const original = await started.promise;
      if (phase === 'body') await bodyReading.promise;
      const logout = h.client.logout();
      const logoutRequest = await logoutStarted.promise;
      expect(readSignal?.aborted).toBe(true);
      expect(await read).toMatchObject({ code: 'context_changed' });
      await expect(h.client.logout()).rejects.toMatchObject({ code: 'conflict' });
      await expect(h.client.revokeSession('session-other')).rejects.toMatchObject({ code: 'conflict' });
      pendingLogout.resolve(response(logoutRequest, { outcome: 'applied', revision: 5 }));
      await expect(logout).resolves.toEqual({ revocationConfirmed: true });
      expect(h.secrets.size).toBe(0);
      if (phase === 'body') expect(bodyCancelled).toBe(true);
      pendingRead.resolve(response(original, identity));
      expect(h.requests.filter(request => request.body.operation === 'sessions.list')).toHaveLength(0);
    });
  }

  it('bounds an account request even if transport ignores its abort signal', async () => {
    const h = harness(); await h.client.initialize();
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      expect(milliseconds).toBe(30_000);
      return deadline.signal;
    });
    try {
      const started = deferred<Request>();
      const pending = deferred<Response>();
      h.intercept(request => { if (request.operation === 'account.get') { started.resolve(request); return pending.promise; } });
      const read = h.client.getAccountCatalog().catch(error => error);
      await started.promise;
      deadline.abort();
      expect(await read).toMatchObject({ code: 'offline' });
      expect(h.client.getState().deviceSession).not.toBeNull();
    } finally { timeout.mockRestore(); }
  });

  it('lets logout preempt the initial session read without restoring stale connection state', async () => {
    const h = harness();
    const started = deferred<void>();
    const pending = deferred<Response>();
    h.intercept((_request, url) => { if (url.endsWith('/me')) { started.resolve(); return pending.promise; } });
    const initialize = h.client.initialize().catch(error => error);
    await started.promise;
    await expect(h.client.logout()).resolves.toEqual({ revocationConfirmed: true });
    expect(await initialize).toMatchObject({ code: 'context_changed' });
    pending.resolve(json({ account, device_session: session }));
    expect(h.client.getState()).toMatchObject({ status: 'signed_out', deviceSession: null, account: null });
    expect(h.secrets.size).toBe(0);
  });

});
