import type { PilotClientDependencies } from '../../src/services/macroPilot/nativeClient';
import type { PilotSecretScope, PilotVaultLease } from '../../src/services/tauriIpc';
import type { ContentDelivery, ContentDeliveryResult } from '../../src/services/macroPilot/contentProtocol';

// This module is test tooling, never a production transport or vault fallback.
if (process.env.NODE_ENV !== 'test') throw new Error('Synthetic Pilot fixtures require NODE_ENV=test');
export const origin = 'https://pilot.synthetic.invalid';
export const account = {
  contract_version: '1.0', type: 'account', account_id: 'account:synthetic',
  identity: { provider: 'github', subject: '999999999999', login: 'synthetic-only' }, revision: 1,
} as const;
export const instanceId = 'instance:synthetic';
const sessionId = 'session:synthetic';
const token = Buffer.alloc(32, 7).toString('base64url');
const pollToken = Buffer.alloc(32, 8).toString('base64url');
const expiry = () => new Date(Date.now() + 300_000).toISOString();
const session = { contract_version: '1.0', type: 'device_session',
  ref: { type: 'session', account_id: account.account_id, session_id: sessionId },
  device_id: 'device:synthetic', state: 'active', issued_at: new Date().toISOString(), revision: 1 };
const instance = { contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: instanceId },
  label: 'Synthetic desktop', connection_state: 'reachable', supported_contract_versions: ['1.0'], revision: 1 };
const scopeKey = (scope: PilotSecretScope) => JSON.stringify(scope);

export function syntheticFixture() {
  const values: Record<string, unknown> = {};
  const secrets = new Map<string, string>();
  const requests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  const results: ContentDeliveryResult[] = [];
  const queue: ContentDelivery[] = [];
  const failures: string[] = [];
  const listeners = new Set<(lease: PilotVaultLease) => void>();
  let generation = 0;
  let status: PilotVaultLease['status'] = 'ready';
  let resumes = 0;
  let reads = 0;
  let keepSecrets = false;
  let wake: (() => void) | undefined;
  let authorizeHook: (() => void) | undefined;
  const lease = (): PilotVaultLease => ({ generation: String(generation), status });
  const check = (supplied?: string) => {
    if (supplied !== String(generation)) throw 'context_changed';
    if (status !== 'ready') throw status;
  };
  const dependencies: PilotClientDependencies = {
    getStateSnapshot: async () => ({ schemaVersion: 1, values: structuredClone(values) }),
    setStateValue: async (key, value) => { values[key] = structuredClone(value); return { schemaVersion: 1, values: structuredClone(values) }; },
    secretRead: async (scope, supplied) => { check(supplied); reads++; return secrets.get(scopeKey(scope)) ?? null; },
    secretWrite: async (scope, secret, supplied) => { check(supplied); secrets.set(scopeKey(scope), secret); },
    secretDelete: async (scope, supplied) => { check(supplied); if (keepSecrets) throw 'cancelled'; secrets.delete(scopeKey(scope)); },
    vaultActivate: async () => { generation++; return lease(); },
    vaultInvalidate: async () => { generation++; return lease(); },
    vaultResume: async () => { resumes++; status = 'ready'; generation++; return lease(); },
    vaultSubscribe: async listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    randomBytes: size => crypto.getRandomValues(new Uint8Array(size)),
    sha256: async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
    now: () => new Date(),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== origin || url.username || url.password) {
        failures.push('non-synthetic origin'); throw new Error('Only the synthetic origin is allowed');
      }
      const path = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const headers = new Headers(init?.headers);
      requests.push({ path, body, headers });
      const json = (data: unknown, code = 200) => new Response(JSON.stringify(data), {
        status: code, headers: { 'content-type': 'application/json', 'x-request-id': (data as { request_id?: string }).request_id ?? headers.get('x-request-id')! },
      });
      if (path === '/pilot/v1/auth/attempts') return json({ transport_version: '1.0', attempt_id: 'attempt:synthetic',
        poll_secret: pollToken, user_code: 'TEST-ONLY', verification_uri: 'https://github.com/login/device', expires_at: expiry(), interval: 5 }, 201);
      if (path.startsWith('/pilot/v1/auth/attempts/')) {
        if (headers.get('authorization') !== `Bearer ${pollToken}`) throw Error('Missing poll proof');
        if (path.endsWith('/claim')) return json({ account, device_session: session, session_token: token });
        return json({ status: 'identified', account });
      }
      if (headers.get('authorization') !== `Bearer ${token}`) { failures.push('missing session proof'); throw Error('Missing session proof'); }
      if (path === '/pilot/v1/me') return json({ account, device_session: session });
      if (path === '/pilot/v1/instances') return json({ instance, instance_access: {
        contract_version: '1.0', type: 'instance_access',
        ref: { type: 'instance_access', account_id: account.account_id, session_id: sessionId, instance_id: instanceId },
        state: 'granted', permissions: ['supervise'], granted_at: new Date().toISOString(), revision: 1,
      } }, 201);
      if (path === '/pilot/extensions/negotiate') return json({ negotiation_version: '1.0', type: 'negotiated', request_id: body.request_id, selected_version: '2.0' });
      if (path === '/pilot/v2/account/requests') {
        const identity = { ...account.identity, account_id: account.account_id, session_id: sessionId, revision: 1 };
        const result = body.operation === 'account.get' ? identity : body.operation === 'sessions.list' ? {
          page: { snapshot_id: 'snapshot:synthetic', revision: 1, observed_at: new Date().toISOString(), expires_at: expiry(), export_policy_revision: 'visible-1', offset: 0, total: 1, next_cursor: null },
          items: [{ session_id: sessionId, device_id: session.device_id, label: 'Synthetic desktop', client_kind: 'desktop', state: 'active', created_at: session.issued_at, expires_at: expiry() }],
        } : body.operation === 'session.logout' ? { outcome: 'applied', revision: 2 } : undefined;
        if (!result) { failures.push('unknown account operation'); throw Error('Unexpected account operation'); }
        return json({ contract_version: '2.0', type: 'response', request_id: body.request_id, account_id: account.account_id, operation: body.operation, result });
      }
      const instanceKey = [...secrets].find(([key]) => JSON.parse(key).kind === 'instance_key')?.[1];
      if (!instanceKey || headers.get('x-instance-key') !== instanceKey) { failures.push('missing producer proof'); throw Error('Missing producer proof'); }
      if (path.endsWith('/disconnect') || path.endsWith('/events')) return new Response(null, { status: 204 });
      if (path.endsWith('/poll')) {
        const signal = init?.signal;
        while ((!path.includes('/v2/') || !queue.length) && !signal?.aborted) {
          await new Promise<void>(resolve => {
            const done = () => { signal?.removeEventListener('abort', done); resolve(); };
            if (path.includes('/v2/')) wake = done;
            signal?.addEventListener('abort', done, { once: true });
          });
        }
        if (signal?.aborted) throw Error('aborted');
        return json(queue.shift());
      }
      if (path.endsWith('/authorize')) {
        authorizeHook?.();
        return json({ transport_version: '2.0', type: 'authorized', request_id: body.request_id, execute_before: new Date(Date.now() + 5000).toISOString() });
      }
      if (path.endsWith('/result')) { results.push(structuredClone(body) as unknown as ContentDeliveryResult); return new Response(null, { status: 204 }); }
      failures.push(`unexpected route: ${path}`); throw Error(`Unexpected synthetic route: ${path}`);
    },
  };
  return { dependencies, values, secrets, requests, results, failures,
    enqueue(delivery: ContentDelivery) { queue.push(delivery); wake?.(); },
    block(next: Exclude<PilotVaultLease['status'], 'ready'>) { status = next; generation++; listeners.forEach(listener => listener(lease())); },
    onAuthorize(hook?: () => void) { authorizeHook = hook; },
    retainSecrets() { keepSecrets = true; },
    get resumes() { return resumes; }, get reads() { return reads; },
  };
}
