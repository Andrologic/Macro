import {
  validateContentMessage, validateContentResponse, validateContentPageContinuation,
  type ContentEventsPage, type ContentPage, type ContentRequest,
} from './contentProtocol';
import { PilotClientError } from './clientError';
import type { PilotInstanceAccess } from './nativeClient';
import { stableJson } from './protocol';
import {
  CONSUMER_CAPABILITIES, CONSUMER_READ_OPERATIONS, checkConsumerCapabilities, checkConsumerTarget,
  selectedConsumerCapabilities, validConsumerResponse,
  type ConsumerCapability, type ConsumerIdentity, type ConsumerOperation,
  type ConsumerReadRequest, type ConsumerReadRequestFor, type ConsumerReadResponse, type ConsumerTransport,
  type ConsumerDispatch,
} from './consumerTransport';

export interface ConsumerTargetScope extends ConsumerIdentity {
  instanceId: string;
  connectionId: string;
  generation: number;
  accessRevision?: number;
}
export interface ConsumerReadPage<O extends ConsumerOperation = ConsumerOperation> {
  scope: ConsumerTargetScope;
  request: ConsumerReadRequestFor<O>;
  response: ConsumerReadResponse<O>;
}
export interface ConsumerEventBatch {
  scope: ConsumerTargetScope;
  page: ContentEventsPage;
  /** Acknowledge only after applying this page. It contains no credentials. */
  receipt: object;
}
interface Slot { controller: AbortController }
const invalid = (): never => { throw new PilotClientError('invalid_response'); };
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new PilotClientError('context_changed')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

/** One explicit target handle. No global registry, transcript cache or mutation. */
export class PilotTargetClient {
  private readonly identity: ConsumerIdentity;
  private readonly connectionId: string;
  private readonly offered: readonly ConsumerCapability[];
  private selected: readonly ConsumerCapability[] | null = null;
  private generation = 0;
  private closed = false;
  private access: PilotInstanceAccess | undefined;
  private unsubscribe: () => void = () => undefined;
  private reading: Slot | null = null;
  private monitoring: Slot | null = null;
  private cursor: { stream: string; sequence: number } | null = null;
  // No page or event body is retained while waiting for application acknowledgement.
  private pending: { receipt: object; generation: number; stream: string; sequence: number } | null = null;

  constructor(private readonly transport: ConsumerTransport, readonly instanceId: string,
    options: { capabilities?: readonly ConsumerCapability[]; access?: PilotInstanceAccess } = {}) {
    checkConsumerTarget(instanceId);
    this.identity = Object.freeze({ ...transport.context() });
    this.connectionId = transport.id();
    checkConsumerCapabilities(options.capabilities ?? CONSUMER_CAPABILITIES);
    this.offered = Object.freeze([...(options.capabilities ?? CONSUMER_CAPABILITIES)]);
    if (options.access) this.setAccess(options.access);
    this.unsubscribe = transport.subscribe(() => {
      try { this.check(); } catch { this.dispose(); }
    });
  }

  scope(): ConsumerTargetScope {
    return { ...this.identity, instanceId: this.instanceId, connectionId: this.connectionId, generation: this.generation,
      ...(this.access ? { accessRevision: this.access.revision } : {}) };
  }
  capabilities(): readonly ConsumerCapability[] { return [...this.selected ?? []]; }

  /** Observed directory access is a fence, never a replacement for relay checks. */
  setAccess(access: PilotInstanceAccess): void {
    if (this.closed) throw new PilotClientError('context_changed');
    if (access.ref.account_id !== this.identity.accountId || access.ref.session_id !== this.identity.sessionId ||
      access.ref.instance_id !== this.instanceId || !Number.isSafeInteger(access.revision) || access.revision < 0) {
      throw new PilotClientError('invalid_configuration');
    }
    if (this.access && (access.revision < this.access.revision || access.revision === this.access.revision && stableJson(access) !== stableJson(this.access))) throw new PilotClientError('stale_revision');
    if (!this.access || stableJson(this.access) !== stableJson(access)) this.reset();
    this.access = structuredClone(access);
  }

  reset(): void {
    this.generation++;
    this.selected = null;
    this.reading?.controller.abort(); this.reading = null;
    this.monitoring?.controller.abort(); this.monitoring = null;
    this.cursor = null; this.pending = null;
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.reset(); this.access = undefined; this.unsubscribe();
  }

  private check(generation = this.generation, signal?: AbortSignal): void {
    if (this.closed || generation !== this.generation || signal?.aborted || this.transport.context().key !== this.identity.key) {
      throw new PilotClientError('context_changed');
    }
  }
  private authority(): void {
    if (this.access && (this.access.state !== 'granted' || !this.access.permissions.includes('supervise'))) throw new PilotClientError('forbidden');
  }
  private async exclusive<T>(kind: 'reading' | 'monitoring', signal: AbortSignal | undefined,
    work: (generation: number, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check(); this.authority();
    if (this[kind] || kind === 'monitoring' && this.pending) throw new PilotClientError('conflict');
    const slot = { controller: new AbortController() };
    const combined = AbortSignal.any([slot.controller.signal, ...(signal ? [signal] : [])]);
    const generation = this.generation;
    this[kind] = slot;
    try { return await work(generation, combined); }
    catch (error) {
      // An obsolete request must never reset its replacement or another target.
      if (generation === this.generation && !combined.aborted && error instanceof PilotClientError &&
        ['forbidden', 'unauthorized', 'session_revoked', 'unavailable', 'extension_unavailable', 'invalid_response'].includes(error.code)) this.reset();
      throw error;
    } finally { if (this[kind] === slot) this[kind] = null; }
  }

  private async send(dispatch: ConsumerDispatch, generation: number, signal: AbortSignal) {
    this.check(generation, signal); this.authority();
    const response = await this.transport.send(this.identity, this.instanceId, dispatch, signal);
    this.check(generation, signal); this.authority();
    if (!validConsumerResponse(dispatch, response.status, response.data)) return invalid();
    if (!validateContentMessage(response.data)) return invalid();
    if (response.data.type === 'error') {
      // Synthetic ports have the same closed errors as the native transport.
      const code = response.data.code;
      throw new PilotClientError(code === 'unsupported_version' ? 'extension_unavailable' :
        code === 'instance_offline' || code === 'content_unavailable' ? 'unavailable' :
          ['unauthorized', 'session_revoked', 'forbidden', 'not_found', 'stale_revision', 'snapshot_expired', 'resource_limit', 'conflict', 'validation_failed', 'unavailable'].includes(code)
            ? code as ConstructorParameters<typeof PilotClientError>[0] : 'invalid_response', response.status, response.data.retryable);
    }
    return response.data;
  }

  async negotiate(signal?: AbortSignal): Promise<readonly ConsumerCapability[]> {
    this.check(); this.authority();
    if (this.reading) throw new PilotClientError('conflict');
    this.reset();
    return this.exclusive('reading', signal, async (generation, signal) => {
      const request = { negotiation_version: '1.0' as const, type: 'negotiate' as const,
        request_id: this.transport.id(), instance_id: this.instanceId, supported_versions: ['2.0'], capabilities: [...this.offered] };
      const response = await this.send({ kind: 'negotiate', request }, generation, signal);
      if (response.type !== 'negotiated') return invalid();
      if (response.selected_version !== '2.0') throw new PilotClientError('extension_unavailable');
      this.selected = selectedConsumerCapabilities(response);
      return this.capabilities();
    });
  }

  read<O extends ConsumerOperation>(operation: O, body: ContentRequest<O>['body'],
    options: { signal?: AbortSignal; previous?: ConsumerReadPage<O>; seenIdentities?: ReadonlySet<string> } = {}): Promise<ConsumerReadPage<O>> {
    return this.exclusive('reading', options.signal, async (generation, outerSignal) => {
      if (!this.selected) throw new PilotClientError('extension_unavailable');
      if (!CONSUMER_READ_OPERATIONS.includes(operation)) throw new PilotClientError('invalid_configuration');
      // Request fields contain identifiers only; no returned transcript is retained here.
      const request = structuredClone({ contract_version: '2.0', type: 'request', request_id: this.transport.id(),
        account_id: this.identity.accountId, operation, body }) as ConsumerReadRequest;
      if (!validateContentMessage(request)) throw new PilotClientError('invalid_configuration');
      const input = request.body as { consistency?: string; continuation?: { snapshot_id: string; cursor: string }; direction?: string };
      if (['conversations.catalog', 'conversation.window'].includes(operation) && !this.selected.includes('conversations-1') ||
        input.direction === 'backward' && !this.selected.includes('conversation-history-1') ||
        input.consistency && !this.selected.includes('network-reliability-1')) throw new PilotClientError('extension_unavailable');
      if (input.continuation) {
        const previous = options.previous;
        if (!previous || stableJson(previous.scope) !== stableJson(this.scope())) throw new PilotClientError('context_changed');
        const withoutCursor = (value: object) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'continuation'));
        if (previous.request.operation !== operation || stableJson(withoutCursor(previous.request.body)) !== stableJson(withoutCursor(request.body))) throw new PilotClientError('invalid_configuration');
        if (!options.seenIdentities) throw new PilotClientError('invalid_configuration');
        const before = (previous.response as ConsumerReadResponse).result as { page?: ContentPage };
        if (!before.page || Date.parse(before.page.expires_at) <= this.transport.now() ||
          input.continuation.snapshot_id !== before.page.snapshot_id || input.continuation.cursor !== before.page.next_cursor) throw new PilotClientError('snapshot_expired');
      }
      const deadline = this.transport.now() + 60_000;
      const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(60_000)]);
      let response = await this.send({ kind: 'submit', request }, generation, signal);
      let expiry: number | undefined;
      let polls = 0;
      while (response.type === 'accepted') {
        const expires = Date.parse(response.expires_at);
        if (expires <= this.transport.now() || expires > deadline || expiry !== undefined && expires !== expiry) return invalid();
        expiry = expires;
        await pause(polls++ === 0 ? 100 : 500, signal);
        this.check(generation, signal);
        if (this.transport.now() >= Math.min(expiry, deadline)) throw new PilotClientError('snapshot_expired');
        response = await this.send({ kind: 'poll', request }, generation, signal);
      }
      if (this.transport.now() >= Math.min(expiry ?? deadline, deadline)) throw new PilotClientError('snapshot_expired');
      if (response.type !== 'response' || !validateContentResponse(request, response)) return invalid();
      const result = response.result as { page?: ContentPage };
      if (result.page && Date.parse(result.page.expires_at) <= this.transport.now()) throw new PilotClientError('snapshot_expired');
      if (input.continuation && !validateContentPageContinuation(options.previous!.response, response,
        { request, seenIdentities: options.seenIdentities })) return invalid();
      this.check(generation, signal);
      return { scope: this.scope(), request, response } as ConsumerReadPage<O>;
    });
  }

  events(signal?: AbortSignal): Promise<ConsumerEventBatch> {
    return this.exclusive('monitoring', signal, async (generation, signal) => {
      if (!this.selected) throw new PilotClientError('extension_unavailable');
      const request = { contract_version: '2.0' as const, type: 'events.request' as const,
        request_id: this.transport.id(), account_id: this.identity.accountId,
        stream_id: this.cursor?.stream ?? null, after_sequence: this.cursor?.sequence ?? 0 };
      const response = await this.send({ kind: 'events', request }, generation, signal);
      if (response.type !== 'events.page' || request.stream_id === null && !response.reset) return invalid();
      for (const event of response.events) {
        const scope = event.change.scope;
        if ('instance_id' in scope ? scope.instance_id !== this.instanceId : scope.account_id !== this.identity.accountId) return invalid();
        if (event.change.kind === 'conversation.resource_changed' && !this.selected!.includes('network-reliability-1')) return invalid();
      }
      if (response.reset) {
        // A reset retires reads/captures of this target, not the other targets.
        this.generation++; this.reading?.controller.abort(); this.reading = null;
        this.cursor = null; this.pending = null;
      }
      const receipt = Object.freeze({});
      this.pending = { receipt, generation: this.generation, stream: response.stream_id, sequence: response.next_sequence };
      return { scope: this.scope(), page: response, receipt };
    });
  }

  acknowledgeEvents(batch: ConsumerEventBatch): void {
    this.check(); this.authority();
    if (!this.pending || this.pending.receipt !== batch.receipt || this.pending.generation !== this.generation) throw new PilotClientError('context_changed');
    this.cursor = { stream: this.pending.stream, sequence: this.pending.sequence };
    this.pending = null;
  }
}
