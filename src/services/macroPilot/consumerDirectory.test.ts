import { describe, expect, it } from 'bun:test';
import { ConsumerDirectory, type ConsumerDirectoryRequest } from './consumerDirectory';
import { consumerLimits, consumerRetryPolicy, type ConsumerLimits } from './consumerPolicy';
import type { ConsumerIdentity } from './consumerTransport';
import type { PilotInstanceAccess } from './nativeClient';

// Deliberately small synthetic admission, never operational composition defaults.
export const syntheticLimits: ConsumerLimits = { targets: 2, subscribers: 3, activeReads: 2, directoryPages: 4,
  directoryItems: 8, directoryBytes: 8192, pageItems: 2, pageBytes: 2048, identities: 8, cursors: 4 };
const context: ConsumerIdentity = { key: 'context:synthetic', configurationId: 'config:synthetic', relayOrigin: 'https://relay.example',
  accountId: 'account:synthetic', sessionId: 'session:synthetic', epoch: 0 };
export const syntheticAccess = (id = 'instance:a', revision = 0, state: 'granted' | 'revoked' = 'granted'): PilotInstanceAccess => ({
  contract_version: '1.0', type: 'instance_access', ref: { type: 'instance_access', account_id: context.accountId, session_id: context.sessionId, instance_id: id },
  state, permissions: ['supervise'], granted_at: '2026-01-01T00:00:00Z', ...(state === 'revoked' ? { revoked_at: '2026-01-01T01:00:00Z' } : {}), revision,
});
const instance = (id = 'instance:a') => ({ contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: id }, label: 'Synthetic PC',
  connection_state: 'reachable', supported_contract_versions: ['1.0'], revision: 0 });
const page = (type: string, items: unknown[], next?: string) => ({ contract_version: '1.0', type: 'page', item_type: type, items, has_more: Boolean(next), ...(next ? { next_cursor: next } : {}) });
function harness(limits = syntheticLimits) {
  let identity = { ...context };
  let query = async (request: ConsumerDirectoryRequest): Promise<unknown> => page(request.item_type, request.item_type === 'instance' ? [instance()] : [syntheticAccess()]);
  const requests: ConsumerDirectoryRequest[] = [];
  const directory = new ConsumerDirectory({ context: () => identity, verify: async () => {}, query: async (_context, request) => { requests.push(request); return query(request); } }, limits);
  return { directory, requests, query: (value: typeof query) => { query = value; }, change: () => { identity = { ...identity, key: 'context:other' }; } };
}
const signal = () => new AbortController().signal;
describe('consumer directory admission and observations', () => {
  it('requires all positive, safe, consistent limits and finite retry delays', () => {
    for (const key of Object.keys(syntheticLimits)) for (const value of [undefined, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => consumerLimits({ ...syntheticLimits, [key]: value })).toThrow('invalid_configuration');
    }
    expect(() => consumerLimits({ ...syntheticLimits, pageItems: 201 })).toThrow();
    expect(() => consumerRetryPolicy({ delaysMs: [20], maxDelayMs: 10, deadlineMs: 100, jitterRatio: 0, pollIntervalMs: 1 })).toThrow();
    expect(() => consumerRetryPolicy({ delaysMs: [], maxDelayMs: 10, deadlineMs: 100, jitterRatio: 0, pollIntervalMs: 1 })).not.toThrow();
  });
  it('reads the exact session scope and publishes a complete revision-zero catalog', async () => {
    const h = harness(); const denied: PilotInstanceAccess[] = [];
    const result = await h.directory.read(signal(), value => denied.push(value));
    expect(result.accesses[0].revision).toBe(0); expect(result.instances).toHaveLength(1); expect(denied).toEqual([]);
    expect(h.requests[1].scope).toEqual({ type: 'session', account_id: context.accountId, session_id: context.sessionId });
  });
  it('applies a valid denial before a later page fails, never returns partial grants', async () => {
    const h = harness(); await h.directory.read(signal(), () => {});
    h.query(async request => request.item_type === 'instance' ? page('instance', [instance()]) : request.cursor
      ? { malformed: true } : page('instance_access', [syntheticAccess('instance:a', 1, 'revoked')], 'cursor:next'));
    const denied: PilotInstanceAccess[] = [];
    await expect(h.directory.read(signal(), value => denied.push(value))).rejects.toMatchObject({ code: 'invalid_response' });
    expect(denied).toHaveLength(1); expect(denied[0].state).toBe('revoked');
    h.query(async request => page(request.item_type, request.item_type === 'instance' ? [instance()] : [syntheticAccess()]));
    await expect(h.directory.read(signal(), () => {})).rejects.toMatchObject({ code: 'stale_revision' });
  });
  it('accepts 0 to 1 then rejects old and contradictory access revisions', async () => {
    const h = harness(); await h.directory.read(signal(), () => {});
    h.query(async request => page(request.item_type, request.item_type === 'instance' ? [instance()] : [syntheticAccess('instance:a', 1)]));
    await h.directory.read(signal(), () => {});
    h.query(async request => page(request.item_type, request.item_type === 'instance' ? [instance()] : [{ ...syntheticAccess('instance:a', 1), permissions: ['respond'] }]));
    await expect(h.directory.read(signal(), () => {})).rejects.toMatchObject({ code: 'stale_revision' });
  });
  it('rejects wrong sessions, duplicate IDs, unsafe revisions and cursor cycles', async () => {
    for (const rows of [[{ ...syntheticAccess(), ref: { ...syntheticAccess().ref, session_id: 'session:other' } }],
      [syntheticAccess(), syntheticAccess()], [{ ...syntheticAccess(), revision: Number.MAX_SAFE_INTEGER + 1 }]]) {
      const h = harness(); h.query(async request => page(request.item_type, request.item_type === 'instance' ? [instance()] : rows));
      await expect(h.directory.read(signal(), () => {})).rejects.toMatchObject({ code: 'invalid_response' });
    }
    const h = harness(); let n = 0;
    h.query(async request => page(request.item_type, [instance(`instance:${++n}`)], 'cursor:loop'));
    await expect(h.directory.read(signal(), () => {})).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('bounds pages, items, bytes, identities and cursors without accepting a prefix', async () => {
    for (const limits of [{ directoryPages: 1 }, { directoryItems: 1 }, { directoryBytes: 50, pageBytes: 50 }, { identities: 1 }, { cursors: 1 }]) {
      const h = harness({ ...syntheticLimits, ...limits });
      if ('cursors' in limits) { let n = 0; h.query(async request => page(request.item_type, [instance(`instance:${++n}`)], `cursor:${n}`)); }
      await expect(h.directory.read(signal(), () => {})).rejects.toMatchObject({ code: 'resource_limit' });
    }
  });
  it('fences late pages after context change or reset and refuses overlapping traversals', async () => {
    for (const reset of [false, true]) {
      const h = harness(); let resolve!: (value: unknown) => void;
      h.query(() => new Promise(done => { resolve = done; }));
      const pending = h.directory.read(signal(), () => { throw new Error('late denial'); });
      await expect(h.directory.read(signal(), () => {})).rejects.toMatchObject({ code: 'conflict' });
      if (reset) h.directory.reset(); else h.change();
      resolve(page('instance', [instance()]));
      await expect(pending).rejects.toMatchObject({ code: 'context_changed' });
    }
  });
});
