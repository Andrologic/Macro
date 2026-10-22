import { ConsumerConnections } from '../../src/services/macroPilot/consumerConnections';
import type { ConsumerReaderPorts } from '../../src/services/macroPilot/consumerReader';
import type { ConsumerCapability, ConsumerDispatch, ConsumerTransport, ConsumerIdentity } from '../../src/services/macroPilot/consumerTransport';
import type { ConsumerDirectoryRequest } from '../../src/services/macroPilot/consumerDirectory';
import type { ContentEvent } from '../../src/services/macroPilot/contentProtocol';
import { connectReaderLimits, connectReaderRetry } from '../../src/composition/macroConnectConsumer';
import { type ConsumerRetryPolicy, consumerAbortable } from '../../src/services/macroPilot/consumerPolicy';
import { PilotClientError } from '../../src/services/macroPilot/clientError';

/** In-memory canonical producer fixtures. No native client, fetch, provider or real credentials. */
export function createConnectConsumerFixture(options: { authorityLifetimeMs?: number; monotonicNow?: () => number; timer?: (callback: () => void, ms: number) => () => void; retry?: ConsumerRetryPolicy } = {}) {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  let identity: ConsumerIdentity = { key: 'context:synthetic', configurationId: 'config:synthetic', relayOrigin: 'https://relay.example', accountId: 'account:synthetic', sessionId: 'session:synthetic', epoch: 0 };
  const listeners = new Set<() => void>();
  const grantedAt = new Date().toISOString();
  let sequence = 0;
  let capabilities: ConsumerCapability[] | undefined;
  const calls: { id: string; dispatch: ConsumerDispatch; signal: AbortSignal }[] = [];
  const streams = new Map<string, { id: string; sequence: number }>();
  const waiting = new Map<string, { request: Extract<ConsumerDispatch, { kind: 'events' }>['request']; resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }>();
  let owner: ConsumerConnections | undefined;
  let hook: ((id: string, dispatch: ConsumerDispatch, signal: AbortSignal) => Promise<unknown>) | undefined;
  let directoryHook: ((request: ConsumerDirectoryRequest) => Promise<unknown>) | undefined;
  const snapshots = new Map<string, { observed: string; expires: string; total: number; backward: boolean; anchor?: string }>();
  const context = () => ({ ...identity });
  const access = (id: string, revoked = false) => ({ contract_version: '1.0', type: 'instance_access', ref: { type: 'instance_access', account_id: identity.accountId, session_id: identity.sessionId, instance_id: id }, state: revoked ? 'revoked' : 'granted', permissions: ['supervise'], granted_at: grantedAt, ...(revoked ? { revoked_at: new Date().toISOString() } : {}), revision: revoked ? 1 : 0 });
  const directory = (request: ConsumerDirectoryRequest) => ({ contract_version: '1.0', type: 'page', item_type: request.item_type, has_more: false,
    items: ['instance:local', 'instance:alpha', 'instance:beta'].map(id => request.item_type === 'instance' ? { contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: id }, label: id === 'instance:local' ? 'Local PC' : id === 'instance:alpha' ? 'Alpha PC' : 'Beta PC', connection_state: 'reachable', supported_contract_versions: ['1.0', '2.0'], revision: 0 } : access(id)) });
  const terminal = (id: string, dispatch: ConsumerDispatch) => {
    if (dispatch.kind !== 'submit') throw new Error('Synthetic submit expected');
    const request = dispatch.request; const body = request.body as { continuation?: { snapshot_id: string; cursor: string }; direction?: string; message_id?: string; filter?: { archived?: string } };
    const backward = body.direction === 'backward', isCatalog = request.operation === 'conversations.catalog';
    const snapshotId = body.continuation?.snapshot_id ?? `snapshot:synthetic:${++sequence}`;
    const total = isCatalog ? 600 : 650;
    const anchor = body.message_id ? Number(body.message_id.split(':').at(-1)) + 6 : total;
    let start = body.continuation ? Number(body.continuation.cursor.split(':').at(-1)) : backward ? Math.min(total, anchor) : 0;
    const end = backward ? start : Math.min(total, start + 50); start = backward ? Math.max(0, start - 50) : start;
    if (!snapshots.has(snapshotId)) {
      if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value!);
      const observed = Date.now();
      snapshots.set(snapshotId, { observed: new Date(observed).toISOString(), expires: new Date(observed + 300_000).toISOString(), total, backward });
    }
    const snap = snapshots.get(snapshotId)!;
    const page = { snapshot_id: snapshotId, revision: 1, observed_at: snap.observed, expires_at: snap.expires, export_policy_revision: 'visible-1', offset: start, total,
      next_cursor: (backward ? start > 0 : end < total) ? `cursor:synthetic:${backward ? start : end}` : null, ...(backward ? { direction: 'backward' } : {}) };
    const items = Array.from({ length: end - start }, (_, n) => {
      const i = start + n;
      return isCatalog ? { ref: { instance_id: id, kind: 'conversation', conversation_id: i === 0 ? 'conversation:same' : `conversation:${String(i).padStart(6, '0')}` }, title: `${id === 'instance:alpha' ? 'Alpha' : 'Beta'} Chat ${i + 1}`, description: 'Synthetic preview', created_at: snap.observed, updated_at: snap.observed, mode: 'Chat', project: null,
        pinned: false, archived: body.filter?.archived === 'archived', unread: true, revision: 0, content_revision: 1, attention: 'none', provider_error: null }
        : { message_id: `message:${String(i).padStart(6, '0')}`, position: i, role: i % 2 ? 'assistant' : 'user', created_at: snap.observed, content_state: 'complete', completion: 'complete', text: `${id} message ${i + 1}\n<img src="https://example.invalid/pixel">\n[local](macro:synthetic)` };
    });
    return { contract_version: '2.0', type: 'response', account_id: identity.accountId, request_id: request.request_id, operation: request.operation, result: { page, items, ...(!isCatalog ? { read_token: null } : {}) } };
  };
  let negotiateHook: ((id: string, dispatch: Extract<ConsumerDispatch, { kind: 'negotiate' }>, signal: AbortSignal) => Promise<unknown>) | undefined;
  const negotiated = (id: string, dispatch: Extract<ConsumerDispatch, { kind: 'negotiate' }>) => {
    const chosen = capabilities ?? dispatch.request.capabilities ?? [];
    const issued = Date.now();
    return { negotiation_version: '1.0', type: 'negotiated', request_id: dispatch.request.request_id, instance_id: id, selected_version: '2.0', capabilities: chosen, ...(chosen.includes('read-authority-1') ? { read_authority: { authority_binding: `binding:${id}`, account_id: identity.accountId, session_id: identity.sessionId, device_id: 'device:synthetic', instance_id: id, producer_generation: `producer:${id}`, session_revision: 0, access_revision: 0, permissions: ['supervise'], issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + (options.authorityLifetimeMs ?? 30000)).toISOString() } } : {}) };
  };
  const transport: ConsumerTransport = { ...(options.authorityLifetimeMs ? { readAuthority: { suspensionBarrierVerified: true as const } } : {}), context, subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, id: () => `request:synthetic:${++sequence}`, now: () => Date.now(),
    send: async (_context, id, dispatch, signal) => {
      calls.push({ id, dispatch, signal }); if (calls.length > 512) calls.shift();
      if (dispatch.kind === 'negotiate') {
        if (!streams.has(id)) streams.set(id, { id: `stream:synthetic:${++sequence}`, sequence: 0 });
        return { status: 200, data: negotiateHook ? await negotiateHook(id, dispatch, signal) : negotiated(id, dispatch) };
      }
      if (dispatch.kind === 'events') {
        const stream = streams.get(id)!;
        if (dispatch.request.stream_id === null) {
          stream.id = `stream:synthetic:${++sequence}`; stream.sequence = 0;
          return { status: 200, data: { contract_version: '2.0', type: 'events.page', request_id: dispatch.request.request_id, account_id: identity.accountId, stream_id: stream.id, after_sequence: 0, next_sequence: 0, reset: true, events: [] } };
        }
        return { status: 200, data: await new Promise((resolve, reject) => {
          const abort = () => { if (waiting.get(id)?.request === dispatch.request) waiting.delete(id); reject(new PilotClientError('context_changed')); };
          waiting.set(id, { request: dispatch.request, resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) });
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        }) };
      }
      return { status: 200, data: hook ? await consumerAbortable(hook(id, dispatch, signal), signal) : terminal(id, dispatch) };
    } };
  const ports: ConsumerReaderPorts = { timer: options.timer, monotonicNow, context, subscribe: transport.subscribe, localInstanceId: 'instance:local',
    createOwner: () => owner = new ConsumerConnections(transport, { context, verify: async () => options.authorityLifetimeMs ? { deviceId: 'device:synthetic', sessionRevision: 0 } : undefined, query: async (_context, request) => directoryHook ? directoryHook(request) : directory(request) }, connectReaderLimits, options.retry ?? connectReaderRetry, { timer: options.timer, now: monotonicNow, random: () => 0.5, sleep: (ms, signal) => consumerAbortable(new Promise(resolve => setTimeout(resolve, ms)), signal) }) };
  const emit = (id: string, changes: ContentEvent['change'][], reset = false) => {
    const pending = waiting.get(id); if (!pending) throw new Error('No synthetic event wait'); waiting.delete(id); pending.cleanup();
    const stream = streams.get(id)!; if (reset) { stream.id = `stream:synthetic:${++sequence}`; stream.sequence = 0; }
    const after = reset ? 0 : pending.request.after_sequence;
    const events = changes.map((change, n) => ({ contract_version: '2.0', type: 'event', account_id: identity.accountId, stream_id: stream.id, sequence: after + n + 1, occurred_at: new Date().toISOString(), change }));
    stream.sequence = after + events.length;
    pending.resolve({ contract_version: '2.0', type: 'events.page', account_id: identity.accountId, request_id: pending.request.request_id, stream_id: stream.id, after_sequence: after, next_sequence: stream.sequence, reset, events });
  };
  const failEvents = (id: string, error: unknown) => { const pending = waiting.get(id); if (!pending) throw new Error('No synthetic event wait'); waiting.delete(id); pending.cleanup(); pending.reject(error); };
  return { ports, transport, failEvents, negotiated, negotiate: (value: typeof negotiateHook) => { negotiateHook = value; }, calls, waiting, terminal, directory, access, emit, owner: () => owner, listeners,
    capabilities: (value: ConsumerCapability[]) => { capabilities = value; },
    read: (value: typeof hook) => { hook = value; }, directoryRead: (value: typeof directoryHook) => { directoryHook = value; },
    changeCredential: () => { identity = { ...identity, credentialGeneration: (identity.credentialGeneration ?? 0) + 1 }; for (const callback of [...listeners]) callback(); },
    changeAccount: () => { identity = { ...identity, key: 'context:replacement', accountId: 'account:replacement', epoch: identity.epoch + 1 }; for (const callback of [...listeners]) callback(); } };
}
