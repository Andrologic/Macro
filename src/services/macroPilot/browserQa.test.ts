import { afterEach, expect, test } from 'bun:test';
import { createBrowserQaDependencies } from './browserQa';
import type { PilotClientDependencies } from './nativeClient';
const oldFetch = globalThis.fetch;
const oldLocation = globalThis.location;
const oldDev = process.env.DEV;
const oldQa = process.env.VITE_MACRO_BROWSER_QA;
afterEach(() => {
  globalThis.fetch = oldFetch; globalThis.location = oldLocation;
  if (oldDev === undefined) delete process.env.DEV; else process.env.DEV = oldDev;
  if (oldQa === undefined) delete process.env.VITE_MACRO_BROWSER_QA; else process.env.VITE_MACRO_BROWSER_QA = oldQa;
});
const nativeCalls: string[] = [];
const forbidden = async () => { nativeCalls.push('native'); throw new Error('Native vault must not be used'); };
const base = { fetch: forbidden, getStateSnapshot: forbidden, setStateValue: forbidden,
  secretRead: forbidden, secretWrite: forbidden, secretDelete: forbidden,
  vaultActivate: forbidden, randomBytes: (size: number) => new Uint8Array(size),
  sha256: async () => new Uint8Array(32), now: () => new Date(),
} as PilotClientDependencies;
function enable(origin = 'http://127.0.0.1:1426') {
  process.env.DEV = 'true'; process.env.VITE_MACRO_BROWSER_QA = '1';
  globalThis.location = { origin } as Location;
}
test('browser QA refuses another origin and never falls back to the native vault', async () => {
  enable('https://example.com'); expect(() => createBrowserQaDependencies(base)).toThrow('isolated');
  enable(); nativeCalls.length = 0;
  globalThis.fetch = (async () => new Response('', {status: 503})) as unknown as typeof fetch;
  const qa = createBrowserQaDependencies(base);
  expect(qa.vaultActivate).toBeUndefined();
  await expect(qa.getStateSnapshot()).rejects.toThrow('unavailable');
  expect(nativeCalls).toEqual([]);
});
test('browser QA isolates credentials in memory and rejects external routes', async () => {
  enable(); nativeCalls.length = 0;
  const seen: string[] = [];
  globalThis.fetch = (async input => {
    seen.push(String(input));
    return Response.json({ logicalOrigin: 'https://browser-qa.invalid', account: {},
      device_session: { ref: {session_id: 'session:qa'} }, session_token: 'synthetic-token',
      instance: {ref: {instance_id: 'instance:qa'}}, instance_key: 'synthetic-key', instance_access: {},
    });
  }) as typeof fetch;
  const qa = createBrowserQaDependencies(base);
  const state = await qa.getStateSnapshot();
  expect(JSON.stringify(state)).not.toContain('synthetic-token');
  const scope = {configuration_id: 'config:browser-qa', relay_origin: 'https://browser-qa.invalid', kind: 'session_token' as const, resource_id: 'session:qa'};
  expect(await qa.secretRead(scope)).toBe('synthetic-token');
  expect(await qa.secretRead({...scope, configuration_id: 'config:foreign'})).toBeNull();
  expect(await qa.secretRead({...scope, kind: 'instance_key', resource_id: 'creation:browser-qa'})).toBe('synthetic-key');
  expect((state.values.macro_pilot_native_v1 as {instanceCreationId: string}).instanceCreationId).toBe('creation:browser-qa');
  await expect(qa.fetch('https://example.com/pilot/v1/me')).rejects.toThrow('External');
  await expect(qa.fetch('https://browser-qa.invalid/pilot/v1/me?token=secret')).rejects.toThrow('External');
  expect(seen).toEqual(['http://127.0.0.1:4176/__qa/bootstrap']);
  expect(nativeCalls).toEqual([]);
});
