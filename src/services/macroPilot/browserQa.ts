import type { PilotClientDependencies } from './nativeClient';

const LOGICAL_ORIGIN = 'https://browser-qa.invalid';
const QA_ORIGIN = 'http://127.0.0.1:4176';

/** Explicit development-only transport; no native vault and no external requests. */
export function createBrowserQaDependencies(base: PilotClientDependencies): PilotClientDependencies {
  if (!import.meta.env.DEV || import.meta.env.VITE_MACRO_BROWSER_QA !== '1'
      || globalThis.location?.origin !== 'http://127.0.0.1:1426') {
    throw new Error('Browser QA requires its isolated development origin.');
  }
  const values: Record<string, unknown> = {};
  const secrets = new Map<string, string>();
  let bootstrap: Promise<void> | null = null;
  const scopeKey = (scope: Parameters<PilotClientDependencies['secretRead']>[0]) =>
    JSON.stringify(scope);
  const initialize = () => bootstrap ??= (async () => {
    const response = await fetch(`${QA_ORIGIN}/__qa/bootstrap`, { redirect: 'error' });
    if (!response.ok) throw new Error('Browser QA bootstrap unavailable.');
    const data = await response.json();
    if (data.logicalOrigin !== LOGICAL_ORIGIN) throw new Error('Browser QA origin mismatch.');
    const configurationId = 'config:browser-qa';
    values.macro_pilot_native_v1 = {
      configurationId, relayOrigin: LOGICAL_ORIGIN, account: data.account,
      deviceSession: data.device_session, instance: data.instance, instanceAccess: data.instance_access,
      instanceCreationId: 'creation:browser-qa', pendingInstanceLabel: null, pendingSecretCleanup: [], attempt: null,
    };
    for (const [kind, resource_id, value] of [
      ['session_token', data.device_session.ref.session_id, data.session_token],
      ['instance_key', 'creation:browser-qa', data.instance_key],
    ]) {
      secrets.set(scopeKey({ configuration_id: configurationId, relay_origin: LOGICAL_ORIGIN, kind, resource_id } as Parameters<PilotClientDependencies['secretRead']>[0]), value);
    }
  })();
  return {
    ...base,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== LOGICAL_ORIGIN || !url.pathname.startsWith('/pilot/') || url.search || url.hash) {
        throw new Error('External requests disabled in browser QA.');
      }
      const response = await fetch(QA_ORIGIN + url.pathname, { ...init, redirect: 'error' });
      // Preserve the logical HTTPS identity checked by the production client.
      Object.defineProperty(response, 'url', { value: url.href });
      return response;
    },
    getStateSnapshot: async () => { await initialize(); return { schemaVersion: 1, values }; },
    setStateValue: async (key, value) => { values[key] = structuredClone(value); return { schemaVersion: 1, values }; },
    secretRead: async scope => secrets.get(scopeKey(scope)) ?? null,
    secretWrite: async (scope, value) => { secrets.set(scopeKey(scope), value); },
    secretDelete: async scope => { secrets.delete(scopeKey(scope)); },
    vaultActivate: undefined, vaultInvalidate: undefined, vaultResume: undefined, vaultSubscribe: undefined,
    deviceName: async () => 'Ordinateur de test',
  };
}
