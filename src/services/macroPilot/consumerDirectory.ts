import type { ConsumerSessionObservation } from './readAuthority';
import type { ConsumerIdentity } from './consumerTransport';
import type { PilotInstance, PilotInstanceAccess } from './nativeClient';
import { PilotClientError } from './clientError';
import { stableJson, validateA1 } from './protocol';
import { consumerAbortable, consumerLimits, type ConsumerLimits } from './consumerPolicy';

export interface ConsumerDirectoryRequest {
  contract_version: '1.0';
  type: 'page_request';
  item_type: 'instance' | 'instance_access';
  limit: number;
  cursor?: string;
  scope?: { type: 'session'; account_id: string; session_id: string };
}
export interface ConsumerDirectoryTransport {
  context(): ConsumerIdentity;
  query(context: ConsumerIdentity, request: ConsumerDirectoryRequest, signal: AbortSignal): Promise<unknown>;
  verify(context: ConsumerIdentity, signal: AbortSignal): Promise<ConsumerSessionObservation | void>;
}
export interface ConsumerDirectorySnapshot {
  context: ConsumerIdentity;
  instances: PilotInstance[];
  accesses: PilotInstanceAccess[];
}
export function validDirectoryRequest(context: ConsumerIdentity, request: ConsumerDirectoryRequest): boolean {
  return validateA1(request) && request.type === 'page_request' && ['instance', 'instance_access'].includes(request.item_type) &&
    (request.item_type === 'instance' ? request.scope === undefined : stableJson(request.scope) === stableJson({
      type: 'session', account_id: context.accountId, session_id: context.sessionId,
    }));
}

// Relay presence and heartbeat are observations, not lifecycle revisions.
function durableResource(resource: PilotInstance | PilotInstanceAccess): unknown {
  if (resource.type === 'instance_access') return resource;
  return { contract_version: resource.contract_version, type: resource.type, ref: resource.ref, label: resource.label,
    supported_contract_versions: resource.supported_contract_versions, revision: resource.revision,
    revoked: resource.connection_state === 'revoked' };
}

/** Bounded, non-atomic v1 discovery. Only a complete traversal may publish grants. */
export class ConsumerDirectory {
  private readonly limits: Readonly<ConsumerLimits>;
  private readonly observed = new Map<string, PilotInstance | PilotInstanceAccess>();
  private observedBytes = 0;
  private exhausted = false;
  private contextKey: string | null = null;
  private active: AbortController | null = null;
  constructor(private readonly transport: ConsumerDirectoryTransport, limits: ConsumerLimits) { this.limits = consumerLimits(limits); }
  reset(): void { this.active?.abort(); this.active = null; this.observed.clear(); this.observedBytes = 0; this.exhausted = false; this.contextKey = null; }
  async read(signal: AbortSignal, deny: (resource: PilotInstance | PilotInstanceAccess) => void): Promise<ConsumerDirectorySnapshot> {
    if (this.active) throw new PilotClientError('conflict');
    const context = this.transport.context();
    if (this.contextKey !== context.key) { this.reset(); this.contextKey = context.key; }
    if (this.exhausted) throw new PilotClientError('resource_limit');
    const active = new AbortController(); this.active = active;
    try { return await this.traverse(context, AbortSignal.any([signal, active.signal]), deny); }
    finally { if (this.active === active) this.active = null; }
  }
  private async traverse(context: ConsumerIdentity, signal: AbortSignal, deny: (resource: PilotInstance | PilotInstanceAccess) => void): Promise<ConsumerDirectorySnapshot> {
    const check = () => {
      if (signal.aborted || this.transport.context().key !== context.key) throw new PilotClientError('context_changed');
    };
    const instances: PilotInstance[] = [], accesses: PilotInstanceAccess[] = [];
    const identities = new Set<string>(), cursors = new Set<string>();
    let pages = 0, items = 0, bytes = 0;
    for (const type of ['instance', 'instance_access'] as const) {
      let cursor: string | undefined;
      do {
        check();
        if (++pages > this.limits.directoryPages) throw new PilotClientError('resource_limit');
        const request: ConsumerDirectoryRequest = { contract_version: '1.0', type: 'page_request', item_type: type, limit: this.limits.pageItems,
          ...(cursor ? { cursor } : {}), ...(type === 'instance_access' ? { scope: { type: 'session', account_id: context.accountId, session_id: context.sessionId } } : {}) };
        const data = await consumerAbortable(this.transport.query(context, request, signal), signal);
        check();
        const page = data as { type?: string; item_type?: string; items?: (PilotInstance | PilotInstanceAccess)[]; has_more?: boolean; next_cursor?: string };
        if (!validateA1(data) || page.type !== 'page' || page.item_type !== type || !page.items || page.items.length > request.limit) throw new PilotClientError('invalid_response');
        const size = new TextEncoder().encode(JSON.stringify(data)).byteLength;
        bytes += size; items += page.items.length;
        if (size > this.limits.pageBytes || bytes > this.limits.directoryBytes || items > this.limits.directoryItems) throw new PilotClientError('resource_limit');
        // Validate this whole page before applying any observation from it.
        for (const item of page.items) {
          if (!Number.isSafeInteger(item.revision) || item.revision < 0) throw new PilotClientError('invalid_response');
          if (item.type === 'instance_access' && (item.ref.account_id !== context.accountId || item.ref.session_id !== context.sessionId)) throw new PilotClientError('invalid_response');
          const identity = `${type}:${stableJson(item.ref)}`;
          if (identities.has(identity)) throw new PilotClientError('invalid_response');
          if (identities.size >= this.limits.identities) throw new PilotClientError('resource_limit');
          identities.add(identity);
          const old = this.observed.get(identity);
          if (old && (item.revision < old.revision || item.revision === old.revision && stableJson(durableResource(old)) !== stableJson(durableResource(item)))) throw new PilotClientError('stale_revision');
        }
        for (const item of page.items) {
          const identity = `${type}:${stableJson(item.ref)}`;
          const old = this.observed.get(identity);
          const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
          const retained = this.observedBytes - (old ? size(old) : 0) + size(item);
          const denied = item.type === 'instance' ? item.connection_state !== 'reachable' : item.state !== 'granted' || !item.permissions.includes('supervise');
          if (denied) { check(); deny(structuredClone(item)); }
          if (!old && this.observed.size >= this.limits.identities || retained > this.limits.directoryBytes) {
            // Keep denial effective even when its observation cannot fit. A fresh owner is required.
            this.exhausted = true; throw new PilotClientError('resource_limit');
          }
          this.observed.set(identity, structuredClone(item)); this.observedBytes = retained;
          if (item.type === 'instance') instances.push(structuredClone(item));
          else accesses.push(structuredClone(item));
        }

        if (!page.has_more) break;
        if (!page.items.length || !page.next_cursor || cursors.has(`${type}:${page.next_cursor}`)) throw new PilotClientError('invalid_response');
        if (cursors.size >= this.limits.cursors) throw new PilotClientError('resource_limit');
        cursors.add(`${type}:${page.next_cursor}`); cursor = page.next_cursor;
      } while (cursor);
    }
    check();
    return { context: { ...context }, instances, accesses };
  }
}
