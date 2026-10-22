import { PilotClientError, type PilotClientErrorCode } from './clientError';
import { ConsumerDirectory, type ConsumerDirectorySnapshot, type ConsumerDirectoryTransport } from './consumerDirectory';
import { consumerAbortable as guarded, consumerClock, consumerLimits, consumerRetryPolicy, consumerRetryable, type ConsumerClock, type ConsumerLimits, type ConsumerRetryPolicy } from './consumerPolicy';
import { consumerWire, type ConsumerIdentity, type ConsumerOperation, type ConsumerTransport, type ConsumerReadRequest, type ConsumerCapability } from './consumerTransport';
import { PilotTargetClient, type ConsumerEventBatch, type ConsumerReadPage, type ConsumerTargetScope } from './targetClient';
import type { ContentRequest } from './contentProtocol';
import { stableJson } from './protocol';

type ReadOptions = NonNullable<Parameters<PilotTargetClient['read']>[2]>;
export type SharedConsumerReadOptions = Omit<ReadOptions, 'previous'> & { previous?: SharedConsumerReadPage };
type Phase = 'connecting' | 'ready' | 'revalidating' | 'error';
export interface ResourceState { revision: number | null; legacyRevision: number | null; removed: boolean; invalidated: boolean; version: number }
export interface ConsumerConnectionState {
  scope: ConsumerTargetScope;
  capabilities: readonly ConsumerCapability[];
  phase: Phase;
  version: number;
  error: PilotClientErrorCode | null;
  projectsRevision: number | null;
  catalogRevision: number | null;
  projectsVersion: number;
  catalogVersion: number;
  resources: Readonly<Record<string, ResourceState>>;
}
export type SharedConsumerReadPage<O extends ConsumerOperation = ConsumerOperation> = ConsumerReadPage<O> & { resourceKey: string; ownerVersion: number };
export interface ConsumerLease {
  state(): ConsumerConnectionState;
  read<O extends ConsumerOperation>(operation: O, body: ContentRequest<O>['body'], options?: SharedConsumerReadOptions): Promise<SharedConsumerReadPage<O>>;
  release(): void;
}
interface Desired {
  key: string;
  resourceKey: string;
  ownerVersion: number;
  authorityEpoch: number;
  resume: boolean;
  operation: ConsumerOperation;
  body: ContentRequest<ConsumerOperation>['body'];
  options: ReadOptions;
  deadline: number;
  signal: AbortSignal;
  cleanup(): void;
  resolve(page: ConsumerReadPage): void;
  reject(error: unknown): void;
}
interface Subscriber { desired: Desired | null; resource: string | null; notify?: () => void; released: boolean }
interface Job { desired: Desired; subscribers: Set<Subscriber>; controller: AbortController; dispatched: boolean; cleanup(): void }
interface Slot { signal: AbortSignal; run(): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }
interface Entry {
  id: string; client: PilotTargetClient; subscribers: Set<Subscriber>; life: AbortController;
  authorityValid: boolean; authorityEpoch: number; streamId: string | null;
  ready: boolean; preparing: Promise<void> | null; monitoring: Promise<void> | null; recovering: Promise<void> | null;
  retries: number; retryDeadline: number | null; controller: AbortController; recoveryController: AbortController;
  job: Job | null; slot: Slot | null; active: boolean; blocked: boolean; notifyQueued: boolean;
  stamp: number; state: Omit<ConsumerConnectionState, 'scope' | 'resources' | 'capabilities'>; resources: Map<string, ResourceState>;
}
const changed = () => new PilotClientError('context_changed');

function deadline(ms: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/** Demand-created owner for one native context. No UI, persistence or retained read results. */
export class ConsumerConnections {
  private readonly limits: Readonly<ConsumerLimits>;
  private readonly retry: Readonly<ConsumerRetryPolicy>;
  private readonly identity: ConsumerIdentity;
  private readonly directory: ConsumerDirectory;
  private readonly entries = new Map<string, Entry>();
  private readonly controller = new AbortController();
  private unsubscribe: () => void;
  private catalog: ConsumerDirectorySnapshot | null = null;
  private authorityEpoch = 0;
  private discoveryController: AbortController | null = null;
  private discoveryMode: { kind: 'public' | 'targets'; entries: Set<Entry> } | null = null;
  private discovering: Promise<ConsumerDirectorySnapshot> | null = null;
  private accountRevalidation: Promise<unknown> | null = null;
  private activeReads = 0;
  private subscriberCount = 0;
  private closed = false;
  private accountRevision = -1;
  private accountTerminal = false;

  constructor(private readonly transport: ConsumerTransport, private readonly directoryTransport: ConsumerDirectoryTransport,
    limits: ConsumerLimits, retry: ConsumerRetryPolicy, private readonly clock: ConsumerClock = consumerClock) {
    this.limits = consumerLimits(limits); this.retry = consumerRetryPolicy(retry);
    this.identity = Object.freeze({ ...transport.context() });
    if (directoryTransport.context().key !== this.identity.key) throw new PilotClientError('invalid_configuration');
    this.directory = new ConsumerDirectory(directoryTransport, this.limits);
    this.unsubscribe = transport.subscribe(() => { try { this.check(); } catch { this.dispose(); } });
  }
  private check(signal?: AbortSignal): void {
    if (this.closed || signal?.aborted || this.transport.context().key !== this.identity.key || this.directoryTransport.context().key !== this.identity.key) throw changed();
  }
  private current(entry: Entry, signal?: AbortSignal): void {
    this.check(signal);
    if (entry.controller.signal.aborted || this.entries.get(entry.id) !== entry) throw changed();
  }
  directorySnapshot(): ConsumerDirectorySnapshot | null { this.check(); return this.catalog ? structuredClone(this.catalog) : null; }
  /** Public discovery closes all protected views until the complete proof succeeds. */
  refreshDirectory(): Promise<ConsumerDirectorySnapshot> {
    this.check();
    if (this.accountTerminal) throw new PilotClientError('unauthorized');
    if (this.discovering && this.discoveryMode?.kind === 'public') return this.discovering;
    this.authorityEpoch++;
    for (const entry of this.entries.values()) this.lockAuthority(entry);
    return this.discover({ kind: 'public', entries: new Set() });
  }
  private refreshTarget(entry: Entry): Promise<ConsumerDirectorySnapshot> {
    this.current(entry);
    if (this.accountTerminal) throw new PilotClientError('unauthorized');
    if (this.discovering) {
      this.discoveryMode?.entries.add(entry);
      return this.discovering;
    }
    return this.discover({ kind: 'targets', entries: new Set([entry]) });
  }
  private discover(mode: { kind: 'public' | 'targets'; entries: Set<Entry> }): Promise<ConsumerDirectorySnapshot> {
    const previous = this.discovering;
    this.discoveryController?.abort();
    const controller = new AbortController(); this.discoveryController = controller; this.discoveryMode = mode;
    this.catalog = null;
    const epoch = this.authorityEpoch;
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    const check = () => {
      this.check(signal);
      if (this.accountTerminal || epoch !== this.authorityEpoch) throw changed();
    };
    const pending = (async () => {
      // Retire an interrupted target traversal before starting the public one.
      if (previous) await guarded(previous.catch(() => undefined), signal);
      check();
      await guarded(this.directoryTransport.verify(this.identity, signal), signal); check();
      const result = await this.directory.read(signal, resource => {
        check();
        const entry = this.entries.get(resource.ref.instance_id);
        if (entry) {
          if (resource.type === 'instance_access') entry.client.setAccess(resource);
          this.block(entry, new PilotClientError(resource.type === 'instance' && resource.connection_state === 'unreachable' ? 'unavailable' : 'forbidden'));
        }
      });
      check();
      for (const entry of this.entries.values()) {
        const access = result.accesses.find(value => value.ref.instance_id === entry.id);
        const instance = result.instances.find(value => value.ref.instance_id === entry.id);
        if (!access || !instance || instance.connection_state !== 'reachable' || access.state !== 'granted' || !access.permissions.includes('supervise')) {
          this.block(entry, new PilotClientError(access?.state === 'revoked' ? 'forbidden' : 'unavailable'));
          continue;
        }
        const wasAuthorized = entry.authorityValid;
        const selected = mode.kind === 'public' || mode.entries.has(entry);
        const before = entry.client.scope().generation;
        entry.client.setAccess(access);
        const accessChanged = before !== entry.client.scope().generation;
        if (accessChanged) this.fence(entry);
        if (mode.entries.has(entry) || selected && entry.state.phase !== 'error' || accessChanged && (selected || wasAuthorized)) entry.blocked = false;
        if (selected || accessChanged && wasAuthorized) entry.authorityValid = true;
        if (entry.authorityValid && !entry.blocked) { entry.state.phase = entry.ready ? 'ready' : 'connecting'; entry.state.error = null; this.notify(entry); }
      }
      check(); this.catalog = result;
      for (const entry of this.entries.values()) if (entry.authorityValid && !entry.blocked && !entry.ready) this.start(entry);
      return structuredClone(result);
    })();
    this.discovering = pending;
    void pending.finally(() => {
      if (this.discovering === pending) { this.discovering = null; this.discoveryController = null; this.discoveryMode = null; }
    }).catch(() => {});
    return pending;
  }
  private lockAuthority(entry: Entry): void {
    entry.authorityValid = false; entry.authorityEpoch++;
    entry.recoveryController.abort(); entry.recoveryController = new AbortController(); entry.recovering = null;
    this.invalidate(entry);
    for (const subscriber of entry.subscribers) this.cancel(entry, subscriber);
    if (!entry.blocked) entry.state.phase = 'revalidating';
    this.notify(entry);
  }
  /** Foreground/account revalidation has the same closed public discovery semantics. */
  async revalidate(): Promise<void> { await this.refreshDirectory(); this.check(); }
  async retryTarget(instanceId: string): Promise<void> {
    this.check(); const entry = this.entries.get(instanceId);
    if (!entry) throw changed();
    this.fence(entry); entry.blocked = true;
    entry.retries = 0; entry.retryDeadline = null;
    await this.refreshTarget(entry); this.current(entry);
    if (entry.blocked) throw new PilotClientError('forbidden');
    await this.ensureReady(entry);
  }
  acquire(instanceId: string, notify?: () => void): ConsumerLease {
    this.check();
    if (this.accountTerminal) throw new PilotClientError('unauthorized');
    if (this.subscriberCount >= this.limits.subscribers) throw new PilotClientError('resource_limit');
    const access = this.catalog?.accesses.find(value => value.ref.instance_id === instanceId);
    const instance = this.catalog?.instances.find(value => value.ref.instance_id === instanceId);
    if (!access || !instance || access.state !== 'granted' || !access.permissions.includes('supervise')) throw new PilotClientError('forbidden');
    if (instance.connection_state !== 'reachable') throw new PilotClientError('unavailable');
    let entry = this.entries.get(instanceId);
    if (!entry) {
      if (this.entries.size >= this.limits.targets) throw new PilotClientError('resource_limit');
      entry = { id: instanceId, client: new PilotTargetClient(this.transport, instanceId, { access }), subscribers: new Set(), life: new AbortController(),
        authorityValid: true, authorityEpoch: 0, streamId: null, ready: false, preparing: null, monitoring: null, recovering: null, retries: 0, retryDeadline: null, controller: new AbortController(), recoveryController: new AbortController(),
        job: null, slot: null, active: false, blocked: false, notifyQueued: false,
        stamp: 0, state: { phase: 'connecting', version: 0, error: null, projectsRevision: null, catalogRevision: null, projectsVersion: 0, catalogVersion: 0 }, resources: new Map() };
      this.entries.set(instanceId, entry);
    }
    const target = entry;
    const subscriber: Subscriber = { desired: null, resource: null, notify, released: false };
    target.subscribers.add(subscriber); this.subscriberCount++;
    this.start(target);
    return {
      state: () => { this.current(target); if (subscriber.released) throw changed(); return { ...target.state, scope: target.client.scope(), capabilities: target.client.capabilities(), resources: Object.fromEntries([...target.resources].map(([key, value]) => [key, { ...value }])) }; },
      read: async (operation, body, options = {}) => this.request(target, subscriber, operation, body, options) as unknown as Promise<SharedConsumerReadPage<typeof operation>>,
      release: () => {
        if (subscriber.released) return;
        subscriber.released = true; subscriber.notify = undefined; this.cancel(target, subscriber); if (target.subscribers.delete(subscriber)) this.subscriberCount--;
        this.prune(target);
        if (!target.subscribers.size) { this.entries.delete(target.id); this.closeEntry(target); }
      },
    };
  }
  private notify(entry: Entry): void {
    entry.state.version++;
    if (entry.notifyQueued) return;
    entry.notifyQueued = true;
    queueMicrotask(() => {
      entry.notifyQueued = false;
      if (entry.controller.signal.aborted) return;
      for (const subscriber of entry.subscribers) { try { subscriber.notify?.(); } catch { /* UI observers cannot prevent event application/ACK. */ } }
    });
  }
  private prune(entry: Entry): void {
    const visible = new Set([...entry.subscribers].map(value => value.resource));
    for (const key of entry.resources.keys()) if (!visible.has(key)) entry.resources.delete(key);
  }
  private cancel(entry: Entry, subscriber: Subscriber, error: unknown = changed()): void {
    const desired = subscriber.desired; subscriber.desired = null;
    if (desired) { desired.cleanup(); desired.reject(error); }
    const job = entry.job;
    if (job?.subscribers.delete(subscriber) && !job.subscribers.size) { job.controller.abort(); job.cleanup(); }
  }
  private cancelJob(entry: Entry): void {
    for (const subscriber of [...entry.job?.subscribers ?? []]) this.cancel(entry, subscriber);
  }
  private request(entry: Entry, subscriber: Subscriber, operation: ConsumerOperation, body: ContentRequest<ConsumerOperation>['body'], options: ReadOptions): Promise<ConsumerReadPage> {
    this.current(entry); if (subscriber.released) return Promise.reject(changed());
    if (!entry.authorityValid) return Promise.reject(new PilotClientError('unavailable'));
    if (entry.blocked) return Promise.reject(new PilotClientError(entry.state.error ?? 'unavailable'));
    // Bound caller-owned continuation metadata before making any retained copy.
    if ((options.seenIdentities?.size ?? 0) > this.limits.identities) return Promise.reject(new PilotClientError('resource_limit'));
    let estimated = 0;
    const serialized = JSON.stringify({ body, previous: options.previous, seen: options.seenIdentities ? [...options.seenIdentities] : [] }, (key, value: unknown) => {
      const text = typeof value === 'string' ? value : '';
      if (text.length > 2 * 256 * 1024) throw new PilotClientError('resource_limit');
      estimated += key.length + text.length + 4;
      if (estimated > 2 * 256 * 1024) throw new PilotClientError('resource_limit');
      return value;
    });
    if (new TextEncoder().encode(serialized).byteLength > 2 * 256 * 1024) return Promise.reject(new PilotClientError('resource_limit'));
    consumerWire(entry.id, { kind: 'submit', request: { contract_version: '2.0', type: 'request', account_id: this.identity.accountId, request_id: 'request:admission', operation, body } as ConsumerReadRequest });
    const saved = structuredClone({ body, previous: options.previous, seenIdentities: options.seenIdentities });
    const key = stableJson({ operation, body: saved.body, previous: saved.previous ? { scope: saved.previous.scope, request: saved.previous.request, page: (saved.previous.response.result as { page?: unknown }).page, ownerVersion: (saved.previous as SharedConsumerReadPage).ownerVersion } : null,
      seen: saved.seenIdentities ? [...saved.seenIdentities] : [] });
    const previous = options.previous as SharedConsumerReadPage | undefined;
    const resourceRef = (body as { ref?: object }).ref;
    const resourceKey = resourceRef ? stableJson(resourceRef) : operation === 'projects.list' ? 'projects' : 'catalog';
    const stamp = entry.resources.get(resourceKey)?.version ?? (resourceKey === 'projects' ? entry.state.projectsVersion : entry.state.catalogVersion);
    if (previous && (previous.resourceKey !== resourceKey || previous.ownerVersion !== stamp)) return Promise.reject(new PilotClientError('snapshot_expired'));
    this.cancel(entry, subscriber);
    const resource = (body as { ref?: object }).ref;
    subscriber.resource = resource ? stableJson(resource) : null; this.prune(entry);
    if (subscriber.resource && !entry.resources.has(subscriber.resource)) {
      if (entry.resources.size >= this.limits.identities) { subscriber.resource = null; return Promise.reject(new PilotClientError('resource_limit')); }
      entry.resources.set(subscriber.resource, { revision: null, legacyRevision: null, removed: false, invalidated: false, version: ++entry.stamp });
    }
    if (subscriber.resource && entry.resources.get(subscriber.resource)?.removed) return Promise.reject(new PilotClientError('not_found'));
    const expiry = deadline(this.retry.deadlineMs);
    const signal = AbortSignal.any([entry.controller.signal, expiry.signal, ...(options.signal ? [options.signal] : [])]);
    const promise = new Promise<ConsumerReadPage>((resolve, reject) => {
      const abort = () => this.cancel(entry, subscriber);
      const desired: Desired = { key, resourceKey, ownerVersion: entry.resources.get(resourceKey)?.version ?? stamp, authorityEpoch: entry.authorityEpoch, resume: false, operation, body: saved.body, options: { previous: saved.previous, seenIdentities: saved.seenIdentities }, signal,
        deadline: this.clock.now() + this.retry.deadlineMs, resolve, reject, cleanup: () => { expiry.dispose(); signal.removeEventListener('abort', abort); } };
      subscriber.desired = desired;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (entry.job?.desired.key === key && !entry.job.controller.signal.aborted) entry.job.subscribers.add(subscriber);
    });
    this.runNext(entry); return promise;
  }
  private checkDesired(entry: Entry, desired: Desired, scope?: string): void {
    this.current(entry, desired.signal);
    if (this.accountTerminal || !entry.authorityValid || entry.authorityEpoch !== desired.authorityEpoch) throw changed();
    const resource = entry.resources.get(desired.resourceKey);
    if (resource?.removed) throw new PilotClientError('not_found');
    const version = resource?.version ?? (desired.resourceKey === 'projects' ? entry.state.projectsVersion : entry.state.catalogVersion);
    if (version !== desired.ownerVersion || scope && stableJson(entry.client.scope()) !== scope) throw new PilotClientError('snapshot_expired');
  }
  private cancelDesired(entry: Entry, predicate: (desired: Desired) => boolean, error: unknown = changed()): void {
    for (const subscriber of entry.subscribers) if (subscriber.desired && predicate(subscriber.desired)) this.cancel(entry, subscriber, error);
  }
  private runNext(entry: Entry): void {
    if (entry.job || entry.blocked || entry.controller.signal.aborted) return;
    const first = [...entry.subscribers].find(value => value.desired);
    if (!first?.desired) return;
    const desired = first.desired;
    const job: Job = { desired, subscribers: new Set([...entry.subscribers].filter(value => value.desired?.key === desired.key)), controller: new AbortController(), dispatched: false, cleanup: () => {} };
    entry.job = job;
    const expiry = deadline(Math.max(1, desired.deadline - this.clock.now())); job.cleanup = () => expiry.dispose();
    const signal = AbortSignal.any([job.controller.signal, entry.controller.signal, expiry.signal]);
    const work = async (): Promise<ConsumerReadPage> => {
      for (;;) {
        this.current(entry, signal);
        if (this.clock.now() >= desired.deadline) throw new PilotClientError('snapshot_expired');
        try {
          if (entry.recovering) await guarded(entry.recovering, signal);
          await guarded(this.ensureReady(entry), signal);
          this.checkDesired(entry, desired);
          const scope = stableJson(entry.client.scope());
          const result = await this.slot(entry, signal, () => { this.checkDesired(entry, desired, scope); job.dispatched = true; return entry.client.read(desired.operation, desired.body, { ...desired.options, signal }); });
          this.current(entry, signal); this.checkDesired(entry, desired, scope);
          if (this.clock.now() >= desired.deadline) throw new PilotClientError('snapshot_expired');
          const ref = (desired.body as { ref?: object }).ref;
          const resourceKey = ref ? stableJson(ref) : desired.operation === 'projects.list' ? 'projects' : 'catalog';
          const resource = entry.resources.get(resourceKey);
          const resultRevision = (result.response.result as { page?: { revision: number }; revision?: number }).page?.revision ?? (result.response.result as { revision?: number }).revision;
          // Only the primary captures share numeric clocks with host events.
          const known = desired.operation === 'conversation.read' && resource
            ? (desired.body as { consistency?: string }).consistency === 'network-reliability-1'
              ? resource.revision : resource.legacyRevision === null && entry.state.catalogRevision === null ? null : Math.max(resource.legacyRevision ?? -1, entry.state.catalogRevision ?? -1)
            : desired.operation === 'projects.list' ? entry.state.projectsRevision
              : desired.operation === 'conversations.list' ? entry.state.catalogRevision : null;
          if (known !== null && resultRevision !== undefined && resultRevision < known) throw new PilotClientError('stale_revision');
          if (resource) resource.invalidated = false;
          return { ...result, resourceKey, ownerVersion: resource?.version ?? (resourceKey === 'projects' ? entry.state.projectsVersion : entry.state.catalogVersion) } as SharedConsumerReadPage;
        } catch (error) {
          job.dispatched = false;
          if (this.clock.now() >= desired.deadline) throw new PilotClientError('snapshot_expired');
          if (signal.aborted || desired.options.previous || !entry.recovering && !consumerRetryable(error)) throw error;
          await guarded(entry.recovering ?? this.recover(entry, error), signal);
        }
      }
    };
    void work().then(page => this.finish(entry, job, undefined, page), error => this.finish(entry, job, error));
  }
  private finish(entry: Entry, job: Job, error?: unknown, page?: ConsumerReadPage): void {
    if (entry.job !== job) return;
    entry.job = null; job.cleanup();
    for (const subscriber of job.subscribers) {
      const desired = subscriber.desired;
      if (!desired || desired.key !== job.desired.key) continue;
      subscriber.desired = null; desired.cleanup();
      if (error) desired.reject(error);
      else {
        try { this.checkDesired(entry, desired, stableJson(page!.scope)); desired.resolve(structuredClone(page!)); }
        catch (failure) { desired.reject(failure); }
      }
    }
    job.subscribers.clear();
    if (error && !job.controller.signal.aborted && !(error instanceof PilotClientError && error.code === 'context_changed')) this.block(entry, error);
    this.runNext(entry);
  }
  /** At most one waiting admission per target, and one active reading slot per target. */
  private slot<T>(entry: Entry, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    this.current(entry, signal);
    if (entry.slot) return Promise.reject(new PilotClientError('conflict'));
    return new Promise<T>((resolve, reject) => {
      const cancel = () => { if (entry.slot === slot) { entry.slot = null; slot.cleanup(); reject(changed()); } };
      const slot: Slot = { signal, run, resolve: value => resolve(value as T), reject, cleanup: () => signal.removeEventListener('abort', cancel) };
      entry.slot = slot; signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel(); else this.pump();
    });
  }
  private pump(): void {
    for (const entry of [...this.entries.values()]) {
      if (this.activeReads >= this.limits.activeReads) return;
      if (!entry.slot || entry.active) continue;
      const slot = entry.slot; entry.slot = null; slot.cleanup();
      if (slot.signal.aborted) { slot.reject(changed()); continue; }
      this.entries.delete(entry.id); this.entries.set(entry.id, entry);
      entry.active = true; this.activeReads++;
      void guarded(Promise.resolve().then(() => slot.run()), slot.signal).then(slot.resolve, slot.reject).finally(() => { entry.active = false; this.activeReads--; this.pump(); });
    }
  }
  private start(entry: Entry): void {
    const life = entry.life; const epoch = entry.authorityEpoch;
    void this.ensureReady(entry).catch(error => {
      if (life.signal.aborted || entry.controller.signal.aborted || !entry.authorityValid || epoch !== entry.authorityEpoch) return;
      if (consumerRetryable(error)) void this.recover(entry, error).catch(() => {});
      else this.block(entry, error);
    });
  }
  private ensureReady(entry: Entry): Promise<void> {
    this.current(entry);
    if (!entry.authorityValid) return Promise.reject(new PilotClientError('unavailable'));
    if (entry.blocked) return Promise.reject(new PilotClientError(entry.state.error ?? 'unavailable'));
    if (entry.ready) return Promise.resolve();
    if (entry.preparing) return entry.preparing;
    const life = entry.life; const epoch = entry.authorityEpoch;
    const signal = AbortSignal.any([life.signal, entry.controller.signal]);
    const check = () => { this.current(entry, signal); if (!entry.authorityValid || epoch !== entry.authorityEpoch || this.accountTerminal) throw changed(); };
    const pending = (async () => {
      await this.slot(entry, signal, () => entry.client.negotiate(signal)); check();
      const batch = await entry.client.events(signal); check();
      this.apply(entry, batch); check();
      entry.ready = true; entry.state.phase = 'ready'; entry.state.error = null; this.notify(entry);
    })();
    entry.preparing = pending;
    void pending.then(() => {
      if (!signal.aborted) queueMicrotask(() => this.monitor(entry, life));
    }, () => {}).finally(() => { if (entry.preparing === pending) { entry.preparing = null; if (epoch !== entry.authorityEpoch && entry.authorityValid && !entry.blocked && !entry.ready) this.start(entry); } });
    return pending;
  }
  private monitor(entry: Entry, life: AbortController): void {
    if (entry.monitoring || life.signal.aborted || !entry.ready || entry.blocked) return;
    const signal = AbortSignal.any([life.signal, entry.controller.signal]);
    const pending = (async () => {
      for (;;) {
        this.current(entry, signal);
        const batch = await entry.client.events(signal); this.current(entry, signal);
        this.apply(entry, batch);
        if (!batch.page.events.length) await guarded(this.clock.sleep(this.retry.pollIntervalMs, signal), signal);
      }
    })();
    entry.monitoring = pending;
    void pending.catch(async error => {
      if (signal.aborted) return;
      if (consumerRetryable(error)) { try { await this.recover(entry, error); } catch { /* Recovery owns the terminal state. */ } }
      else this.block(entry, error);
    }).finally(() => {
      if (entry.monitoring === pending) entry.monitoring = null;
      if (entry.ready && !entry.blocked && !entry.controller.signal.aborted) this.monitor(entry, entry.life);
    });
  }
  private apply(entry: Entry, batch: ConsumerEventBatch): void {
    this.current(entry);
    if (batch.page.reset) {
      if (entry.streamId === batch.page.stream_id) throw new PilotClientError('invalid_response');
      const previous = entry.streamId;
      this.invalidate(entry, true);
      this.cancelDesired(entry, desired => previous !== null && !desired.resume, changed());
      for (const subscriber of entry.subscribers) if (subscriber.desired && !subscriber.desired.options.previous) {
        const desired = subscriber.desired;
        desired.ownerVersion = entry.resources.get(desired.resourceKey)?.version ?? (desired.resourceKey === 'projects' ? entry.state.projectsVersion : entry.state.catalogVersion);
        desired.authorityEpoch = entry.authorityEpoch; desired.resume = false;
      }
    }
    entry.streamId = batch.page.stream_id;
    let account = false, deleted = false;
    for (const event of batch.page.events) {
      const change = event.change;
      if (change.kind === 'sessions.changed' || change.kind === 'account.deleted') {
        if (change.kind === 'account.deleted' || change.revision > this.accountRevision) { account = true; this.accountRevision = Math.max(this.accountRevision, change.revision); deleted ||= change.kind === 'account.deleted'; }
        continue;
      }
      if (change.kind === 'projects.changed') {
        if (change.revision > (entry.state.projectsRevision ?? -1)) { entry.state.projectsRevision = change.revision; entry.state.projectsVersion = ++entry.stamp; this.cancelDesired(entry, desired => desired.operation === 'projects.list'); }
      }
      else if (change.kind === 'conversations.changed') {
        if (change.revision > (entry.state.catalogRevision ?? -1)) { entry.state.catalogRevision = change.revision; entry.state.catalogVersion = ++entry.stamp; this.cancelDesired(entry, desired => desired.operation.startsWith('conversations.')); }
      }
      else if ('conversation_id' in change.scope) {
        if (change.kind === 'conversation.removed') {
          entry.state.catalogRevision = Math.max(entry.state.catalogRevision ?? -1, change.revision);
          entry.state.catalogVersion = ++entry.stamp;
          this.cancelDesired(entry, desired => desired.operation.startsWith('conversations.'));
        }
        const key = stableJson(change.scope); const state = entry.resources.get(key);
        if (state) {
          const domain = change.kind === 'conversation.resource_changed' ? 'revision' : change.kind === 'conversation.changed' ? 'legacyRevision' : null;
          if (domain && state[domain] !== null && change.revision <= state[domain]!) continue;
          if (domain) state[domain] = change.revision;
          if (change.kind === 'conversation.removed') state.removed = true;
          state.invalidated = true; state.version = ++entry.stamp;
          this.cancelDesired(entry, desired => desired.resourceKey === key, change.kind === 'conversation.removed' ? new PilotClientError('not_found') : changed());
        }
      }
    }
    // Commit owner invalidations first. UI observers run in a later microtask.
    if (account) { entry.resources.clear(); this.cancelJob(entry); entry.state.phase = 'revalidating'; }
    entry.client.acknowledgeEvents(batch); if (batch.page.reset || batch.page.events.length) this.notify(entry);
    if (account) this.revalidateAccount(deleted);
  }
  private revalidateAccount(deleted = false): void {
    if (deleted && !this.accountTerminal) { this.authorityEpoch++; this.discoveryController?.abort(); }
    this.accountTerminal ||= deleted;
    if (deleted) {
      this.catalog = null;
      for (const target of this.entries.values()) this.block(target, new PilotClientError('unauthorized'));
    }
    if (this.accountRevalidation) return;
    const revision = this.accountRevision;
    const terminal = this.accountTerminal;
    const pending = terminal ? guarded(this.directoryTransport.verify(this.identity, this.controller.signal), this.controller.signal) : this.revalidate();
    this.accountRevalidation = pending;
    void pending.catch(error => { for (const target of this.entries.values()) this.block(target, error); })
      .finally(() => {
        if (this.accountRevalidation !== pending) return;
        this.accountRevalidation = null;
        if (!this.closed && (this.accountRevision > revision || this.accountTerminal !== terminal)) this.revalidateAccount();
      });
  }

  private invalidate(entry: Entry, retireClocks = false): void {
    if (retireClocks) { entry.state.catalogRevision = null; entry.state.projectsRevision = null; } entry.state.catalogVersion = ++entry.stamp; entry.state.projectsVersion = ++entry.stamp;
    this.prune(entry);
    for (const subscriber of entry.subscribers) if (subscriber.resource && !entry.resources.has(subscriber.resource)) entry.resources.set(subscriber.resource, { revision: null, legacyRevision: null, removed: false, invalidated: true, version: ++entry.stamp });
    for (const state of entry.resources.values()) { if (retireClocks) { state.revision = null; state.legacyRevision = null; state.removed = false; } state.invalidated = true; state.version = ++entry.stamp; }
  }
  private fence(entry: Entry, preserveRead = false): void {
    entry.authorityValid = false; entry.authorityEpoch++;
    entry.life.abort(); entry.life = new AbortController(); entry.client.reset();
    entry.preparing = null; entry.ready = false; this.invalidate(entry);
    if (!preserveRead) {
      entry.recoveryController.abort(); entry.recoveryController = new AbortController(); entry.recovering = null;
      for (const subscriber of entry.subscribers) this.cancel(entry, subscriber);
    }
    entry.state.phase = 'revalidating';
    this.notify(entry);
  }
  private recover(entry: Entry, error: unknown): Promise<void> {
    if (entry.recovering) return entry.recovering;
    if (!consumerRetryable(error)) return Promise.reject(error);
    if (entry.job) for (const subscriber of entry.job.subscribers) if (subscriber.desired && !subscriber.desired.options.previous) subscriber.desired.resume = true;
    this.fence(entry, true); entry.blocked = true;
    if (entry.retryDeadline === null) entry.retryDeadline = this.clock.now() + this.retry.deadlineMs;
    const expiry = deadline(Math.max(1, entry.retryDeadline - this.clock.now()));
    const signal = AbortSignal.any([entry.controller.signal, entry.recoveryController.signal, expiry.signal]);
    const pending = (async () => {
      let failure: unknown = error;
      while (consumerRetryable(failure) && entry.retries < this.retry.delaysMs.length) {
        const random = this.clock.random();
        if (!Number.isFinite(random) || random < 0 || random > 1) throw new PilotClientError('invalid_configuration');
        const delay = Math.min(this.retry.maxDelayMs, Math.max(1, Math.round(this.retry.delaysMs[entry.retries++] * (1 + (2 * random - 1) * this.retry.jitterRatio))));
        if (this.clock.now() + delay >= entry.retryDeadline!) throw failure;
        await guarded(this.clock.sleep(delay, signal), signal); this.current(entry, signal);
        if (this.clock.now() >= entry.retryDeadline!) throw new PilotClientError('snapshot_expired');
        try {
          await guarded(this.refreshTarget(entry), signal); this.current(entry, signal);
          if (this.clock.now() >= entry.retryDeadline!) throw new PilotClientError('snapshot_expired');
          if (entry.blocked) throw new PilotClientError(entry.state.error ?? 'forbidden');
          await guarded(this.ensureReady(entry), signal); this.current(entry, signal); return;
        } catch (next) { failure = next; if (!consumerRetryable(next)) throw next; this.fence(entry, true); entry.blocked = true; }
      }
      throw failure;
    })();
    entry.recovering = pending;
    void pending.catch(failure => { if (entry.recovering === pending && !entry.controller.signal.aborted && !entry.recoveryController.signal.aborted) this.block(entry, failure); }).finally(() => { expiry.dispose(); if (entry.recovering === pending) entry.recovering = null; });
    return pending;
  }
  private block(entry: Entry, error: unknown): void {
    if (entry.controller.signal.aborted) return;
    this.fence(entry); entry.blocked = true;
    entry.state.phase = 'error'; entry.state.error = error instanceof PilotClientError ? error.code : 'invalid_response';
    for (const subscriber of entry.subscribers) this.cancel(entry, subscriber, error);
    this.notify(entry);
  }
  private closeEntry(entry: Entry): void {
    entry.controller.abort(); entry.life.abort(); entry.recoveryController.abort(); entry.client.dispose();
    if (entry.slot) { entry.slot.cleanup(); entry.slot.reject(changed()); entry.slot = null; }
    for (const subscriber of entry.subscribers) { subscriber.released = true; subscriber.notify = undefined; this.cancel(entry, subscriber); }
    entry.job?.cleanup(); entry.job = null; entry.preparing = null; entry.monitoring = null; entry.recovering = null;
    entry.subscribers.clear(); entry.resources.clear();
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.controller.abort(); this.discoveryController?.abort(); this.directory.reset(); this.catalog = null; this.discovering = null; this.accountRevalidation = null; this.unsubscribe();
    for (const entry of this.entries.values()) this.closeEntry(entry);
    this.entries.clear(); this.subscriberCount = 0;
  }
  /** Counts only. Never exports request bodies, response bodies, credentials or callbacks. */
  diagnostics(): { targets: number; subscribers: number; activeReads: number; waitingReads: number; desiredReads: number; resources: number } {
    return { targets: this.entries.size, subscribers: this.subscriberCount, activeReads: this.activeReads,
      waitingReads: [...this.entries.values()].filter(value => value.slot).length,
      desiredReads: [...this.entries.values()].reduce((n, entry) => n + [...entry.subscribers].filter(value => value.desired).length, 0),
      resources: [...this.entries.values()].reduce((n, entry) => n + entry.resources.size, 0) };
  }
}
