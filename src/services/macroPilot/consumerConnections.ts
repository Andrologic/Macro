import type { ConsumerSessionObservation, ReadStart } from './readAuthority';
import { PilotClientError, type PilotClientErrorCode } from './clientError';
import { ConsumerDirectory, type ConsumerDirectorySnapshot, type ConsumerDirectoryTransport } from './consumerDirectory';
import { consumerAbortable as guarded, consumerClock, consumerTimer, consumerLimits, consumerRetryPolicy, consumerRetryable, type ConsumerClock, type ConsumerLimits, type ConsumerRetryPolicy } from './consumerPolicy';
import { consumerWire, type ConsumerIdentity, type ConsumerOperation, type ConsumerTransport, type ConsumerReadRequest, type ConsumerCapability } from './consumerTransport';
import { PilotTargetClient, type ConsumerEventBatch, type ConsumerReadPage, type ConsumerTargetScope } from './targetClient';
import type { ContentRequest } from './contentProtocol';
import { stableJson } from './protocol';

type ReadOptions = NonNullable<Parameters<PilotTargetClient['read']>[2]>;
export type SharedConsumerReadOptions = Omit<ReadOptions, 'previous'> & { previous?: SharedConsumerReadPage };
type Phase = 'connecting' | 'ready' | 'revalidating' | 'error' | 'offline';
export interface ResourceState { revision: number | null; legacyRevision: number | null; removed: boolean; invalidated: boolean; version: number }
export interface ConsumerConnectionState {
  authority?: { deadline: number; valid: boolean };
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
  setVisible(visible: boolean): void;
  release(): void;
}
interface ReadPlan {
  key: string;
  resourceKey: string;
  ownerVersion: number;
  authorityEpoch: number;
  resume: boolean;
  operation: ConsumerOperation;
  body: ContentRequest<ConsumerOperation>['body'];
  options: ReadOptions;
  deadline: number;
  started: ReadStart;
}
interface Desired extends ReadPlan {
  signal: AbortSignal;
  cleanup(): void;
  resolve(page: ConsumerReadPage): void;
  reject(error: unknown): void;
}
interface Subscriber { visible: boolean; desired: Desired | null; resource: string | null; notify?: () => void; released: boolean }
interface Job { desired: ReadPlan; subscribers: Set<Subscriber>; controller: AbortController; dispatched: boolean; cleanup(): void }
interface Slot { signal: AbortSignal; run(): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }
interface Entry {
  id: string; client: PilotTargetClient; subscribers: Set<Subscriber>; life: AbortController;
  renewalTimer?: () => void; renewal: Promise<unknown> | null; renewalController: AbortController;
  authorityValid: boolean; authorityEpoch: number; presentationDeadline: number | null; streamId: string | null;
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
  private sessionObservation?: ConsumerSessionObservation;
  private online = true;

  constructor(private readonly transport: ConsumerTransport, private readonly directoryTransport: ConsumerDirectoryTransport,
    limits: ConsumerLimits, retry: ConsumerRetryPolicy, private readonly clock: ConsumerClock = consumerClock) {
    this.limits = consumerLimits(limits); this.retry = consumerRetryPolicy(retry);
    this.identity = Object.freeze({ ...transport.context() });
    if (directoryTransport.context().key !== this.identity.key) throw new PilotClientError('invalid_configuration');
    this.directory = new ConsumerDirectory(directoryTransport, this.limits);
    this.unsubscribe = transport.subscribe(() => { try { this.check(); } catch { this.dispose(); } });
  }
  private check(signal?: AbortSignal): void {
    if (this.closed || signal?.aborted || this.transport.context().key !== this.identity.key || this.transport.context().credentialGeneration !== this.identity.credentialGeneration || this.directoryTransport.context().key !== this.identity.key || this.directoryTransport.context().credentialGeneration !== this.identity.credentialGeneration) throw changed();
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
      this.sessionObservation = await guarded(this.directoryTransport.verify(this.identity, signal), signal) || undefined; check();
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
        entry.client.setSession(this.sessionObservation); entry.client.setAccess(access);
        const accessChanged = before !== entry.client.scope().generation;
        if (accessChanged) this.fence(entry);
        if (mode.entries.has(entry) || selected && entry.state.phase !== 'error' || accessChanged && (selected || wasAuthorized)) entry.blocked = false;
        if (selected || accessChanged && wasAuthorized) {
          if (entry.client.readAuthority() && !accessChanged && !entry.blocked && this.demanded(entry)) await guarded(this.renew(entry, signal), signal);
          check(); entry.authorityValid = true;
          if (entry.ready) entry.presentationDeadline = entry.client.readAuthority()?.deadline ?? null;
        }
        if (entry.authorityValid && !entry.blocked) { entry.state.phase = entry.ready ? 'ready' : 'connecting'; entry.state.error = null; this.scheduleRenewal(entry); this.notify(entry); }
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
    entry.authorityValid = false; entry.authorityEpoch++; entry.presentationDeadline = null;
    this.invalidate(entry);
    entry.renewalTimer?.(); entry.renewalTimer = undefined;
    entry.renewalController.abort(); entry.renewalController = new AbortController(); entry.renewal = null;
    entry.recoveryController.abort(); entry.recoveryController = new AbortController(); entry.recovering = null;
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
    if (!this.demanded(entry)) throw changed();
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
      entry = { id: instanceId, client: new PilotTargetClient(this.transport, instanceId, { access, session: this.sessionObservation, monotonic: () => this.clock.now() }), subscribers: new Set(), life: new AbortController(),
        renewal: null, renewalController: new AbortController(), authorityValid: true, authorityEpoch: 0, presentationDeadline: null, streamId: null, ready: false, preparing: null, monitoring: null, recovering: null, retries: 0, retryDeadline: null, controller: new AbortController(), recoveryController: new AbortController(),
        job: null, slot: null, active: false, blocked: false, notifyQueued: false,
        stamp: 0, state: { phase: 'connecting', version: 0, error: null, projectsRevision: null, catalogRevision: null, projectsVersion: 0, catalogVersion: 0 }, resources: new Map() };
      this.entries.set(instanceId, entry);
    }
    const target = entry;
    const subscriber: Subscriber = { visible: true, desired: null, resource: null, notify, released: false };
    const demanded = this.demanded(target);
    target.subscribers.add(subscriber); this.subscriberCount++;
    this.updateDemand(target, demanded);
    return {
      state: () => { this.current(target); if (subscriber.released) throw changed(); return { ...target.state, scope: target.client.scope(), capabilities: target.client.capabilities(), authority: this.presentationAuthority(target), resources: Object.fromEntries([...target.resources].map(([key, value]) => [key, { ...value }])) }; },
      read: async (operation, body, options = {}) => this.request(target, subscriber, operation, body, options) as unknown as Promise<SharedConsumerReadPage<typeof operation>>,
      setVisible: visible => {
        this.current(target); if (subscriber.released || subscriber.visible === visible) return;
        const demanded = [...target.subscribers].some(value => value.visible); subscriber.visible = visible;
        if (!visible) this.cancel(target, subscriber);
        this.updateDemand(target, demanded);
      },
      release: () => {
        if (subscriber.released) return;
        subscriber.released = true; subscriber.notify = undefined; this.cancel(target, subscriber); if (target.subscribers.delete(subscriber)) this.subscriberCount--;
        this.prune(target);
        if (!this.demanded(target)) this.stopUndemanded(target);
        if (!target.subscribers.size) { this.entries.delete(target.id); this.closeEntry(target); }
      },
    };
  }
  private demanded(entry: Entry): boolean { return [...entry.subscribers].some(value => value.visible); }
  private updateDemand(entry: Entry, wasDemanded: boolean): void {
    if (!this.demanded(entry)) { this.stopUndemanded(entry); return; }
    if (!this.online || entry.blocked) return;
    if (!wasDemanded && (!entry.authorityValid || entry.ready && entry.client.readAuthority())) {
      entry.retries = 0; entry.retryDeadline = null;
      void this.recover(entry, new PilotClientError('unavailable', 503, true)).catch(() => {});
    } else if (entry.authorityValid) { this.start(entry); this.scheduleRenewal(entry); }
  }
  private stopUndemanded(entry: Entry): void {
    // An established feed still receives invalidations. Only unfinished preparation is retired.
    if (!entry.ready) this.fence(entry);
    entry.renewalTimer?.(); entry.renewalTimer = undefined;
    entry.renewalController.abort(); entry.renewalController = new AbortController(); entry.renewal = null;
    entry.recoveryController.abort(); entry.recoveryController = new AbortController(); entry.recovering = null;
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
    this.current(entry); if (!this.online || entry.state.phase === 'offline') return Promise.reject(new PilotClientError('offline')); if (subscriber.released || !subscriber.visible) return Promise.reject(changed());
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
        deadline: this.clock.now() + this.retry.deadlineMs, started: options.started ?? { monotonic: this.clock.now(), wall: this.transport.now() }, resolve, reject, cleanup: () => { expiry.dispose(); signal.removeEventListener('abort', abort); } };
      subscriber.desired = desired;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (entry.job?.desired.key === key && !entry.job.controller.signal.aborted) entry.job.subscribers.add(subscriber);
    });
    this.runNext(entry); return promise;
  }
  private checkDesired(entry: Entry, desired: ReadPlan, signal: AbortSignal, scope?: string): void {
    this.current(entry, signal);
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
    // The shared plan owns its guards and fixed deadline, independently of any reader's signal.
    const source = first.desired;
    const desired: ReadPlan = { key: source.key, resourceKey: source.resourceKey, ownerVersion: source.ownerVersion,
      authorityEpoch: source.authorityEpoch, resume: source.resume, operation: source.operation, body: source.body,
      options: source.options, deadline: source.deadline, started: source.started };
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
          this.checkDesired(entry, desired, signal);
          const scope = stableJson(entry.client.scope());
          const result = await this.slot(entry, signal, () => { this.checkDesired(entry, desired, signal, scope); job.dispatched = true; return entry.client.read(desired.operation, desired.body, { ...desired.options, started: desired.started, signal }); });
          this.current(entry, signal); this.checkDesired(entry, desired, signal, scope);
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
        try { this.checkDesired(entry, desired, desired.signal, stableJson(page!.scope)); desired.resolve(structuredClone(page!)); }
        catch (failure) { desired.reject(failure); }
      }
    }
    job.subscribers.clear();
    if (error && !job.controller.signal.aborted && !(error instanceof PilotClientError && error.code === 'context_changed')) {
      if (consumerRetryable(error) && entry.client.readAuthority()) this.offline(entry); else this.block(entry, error);
    }
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
    if (!this.demanded(entry)) return;
    const life = entry.life; const epoch = entry.authorityEpoch;
    void this.ensureReady(entry).catch(error => {
      if (life.signal.aborted || entry.controller.signal.aborted || !entry.authorityValid || epoch !== entry.authorityEpoch) return;
      if (consumerRetryable(error)) void this.recover(entry, error).catch(() => {});
      else this.block(entry, error);
    });
  }
  private ensureReady(entry: Entry): Promise<void> {
    this.current(entry);
    if (!this.demanded(entry)) return Promise.reject(changed());
    if (!entry.authorityValid) return Promise.reject(new PilotClientError('unavailable'));
    if (entry.blocked) return Promise.reject(new PilotClientError(entry.state.error ?? 'unavailable'));
    if (entry.ready) return Promise.resolve();
    if (entry.preparing) return entry.preparing;
    const life = entry.life; const epoch = entry.authorityEpoch;
    const signal = AbortSignal.any([life.signal, entry.controller.signal]);
    const check = () => { this.current(entry, signal); if (!this.demanded(entry) || !entry.authorityValid || epoch !== entry.authorityEpoch || this.accountTerminal) throw changed(); };
    const pending = (async () => {
      await this.slot(entry, signal, () => entry.client.negotiate(signal)); check();
      const batch = await entry.client.events(signal); check();
      this.apply(entry, batch); check();
      entry.presentationDeadline = entry.client.readAuthority()?.deadline ?? null;
      entry.ready = true; entry.state.phase = 'ready'; entry.state.error = null; this.scheduleRenewal(entry); this.notify(entry);
    })();
    entry.preparing = pending;
    void pending.then(() => {
      if (!signal.aborted) queueMicrotask(() => this.monitor(entry, life));
    }, () => {}).finally(() => { if (entry.preparing === pending) { entry.preparing = null; if (epoch !== entry.authorityEpoch && entry.authorityValid && !entry.blocked && !entry.ready) this.start(entry); } });
    return pending;
  }
  private monitor(entry: Entry, life: AbortController): void {
    if (!this.online || entry.monitoring || life.signal.aborted || !entry.ready || entry.blocked) return;
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
      if (this.online && entry.ready && entry.state.phase === 'ready' && !entry.blocked && !entry.controller.signal.aborted) this.monitor(entry, entry.life);
    });
  }
  private apply(entry: Entry, batch: ConsumerEventBatch): void {
    this.current(entry);
    if (batch.page.reset) {
      if (entry.streamId === batch.page.stream_id) throw new PilotClientError('invalid_response');
      const previous = entry.streamId;
      this.invalidate(entry, true);
      this.cancelDesired(entry, desired => previous !== null && !desired.resume, changed());
      const plans: ReadPlan[] = [...entry.subscribers].flatMap(subscriber => subscriber.desired ? [subscriber.desired] : []);
      if (entry.job && !entry.job.controller.signal.aborted) plans.push(entry.job.desired);
      for (const desired of plans) if (!desired.options.previous) {
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
    entry.authorityValid = false; entry.authorityEpoch++; entry.presentationDeadline = null;
    // Retire publication and its stamps before any abort callback can run.
    this.invalidate(entry); entry.client.reset();
    entry.renewalTimer?.(); entry.renewalTimer = undefined;
    entry.renewalController.abort(); entry.renewalController = new AbortController(); entry.renewal = null;
    entry.life.abort(); entry.life = new AbortController();
    entry.preparing = null; entry.ready = false;
    if (!preserveRead) {
      entry.recoveryController.abort(); entry.recoveryController = new AbortController(); entry.recovering = null;
      for (const subscriber of entry.subscribers) this.cancel(entry, subscriber);
    }
    entry.state.phase = 'revalidating';
    this.notify(entry);
  }
  private recover(entry: Entry, error: unknown): Promise<void> {
    if (entry.recovering) return entry.recovering;
    entry.renewalTimer?.(); entry.renewalTimer = undefined;
    if (!consumerRetryable(error)) return Promise.reject(error);
    if (!this.demanded(entry)) { this.offline(entry); return Promise.reject(changed()); }
    // Capture before backoff: ordinary renewal may settle and clear the shared field meanwhile.
    let renewal = entry.renewal;
    void renewal?.catch(() => {});
    if (entry.job) {
      if (!entry.job.desired.options.previous) entry.job.desired.resume = true;
      for (const subscriber of entry.job.subscribers) if (subscriber.desired && !subscriber.desired.options.previous) subscriber.desired.resume = true;
    }
    const preserved = Boolean(entry.client.readAuthority() && entry.authorityValid && entry.ready);
    if (preserved) {
      entry.state.phase = 'offline'; entry.state.error = 'unavailable';
      entry.life.abort(); entry.life = new AbortController();
      this.notify(entry);
    }
    else { this.fence(entry, true); entry.blocked = true; }
    if (entry.retryDeadline === null) entry.retryDeadline = this.clock.now() + this.retry.deadlineMs;
    const epoch = entry.authorityEpoch;
    const expiry = deadline(Math.max(1, entry.retryDeadline - this.clock.now()));
    const signal = AbortSignal.any([entry.controller.signal, entry.recoveryController.signal, expiry.signal]);
    const check = () => {
      this.current(entry, signal);
      if (!this.demanded(entry) || this.accountTerminal || preserved && (!entry.authorityValid || entry.authorityEpoch !== epoch)) throw changed();
    };
    const pending = (async () => {
      let failure: unknown = error;
      while (consumerRetryable(failure) && entry.retries < this.retry.delaysMs.length) {
        const random = this.clock.random();
        if (!Number.isFinite(random) || random < 0 || random > 1) throw new PilotClientError('invalid_configuration');
        const delay = Math.min(this.retry.maxDelayMs, Math.max(1, Math.round(this.retry.delaysMs[entry.retries++] * (1 + (2 * random - 1) * this.retry.jitterRatio))));
        if (this.clock.now() + delay >= entry.retryDeadline!) throw failure;
        check(); await guarded(this.clock.sleep(delay, signal), signal); check();
        if (this.clock.now() >= entry.retryDeadline!) throw new PilotClientError('snapshot_expired');
        try {
          if (preserved) {
            if (entry.monitoring) await guarded(entry.monitoring.catch(() => {}), signal);
            check();
            await guarded(renewal ?? this.renew(entry, signal), signal); check();
            const batch = await guarded(entry.client.events(signal), signal); check();
            this.apply(entry, batch); check();
            entry.presentationDeadline = entry.client.readAuthority()?.deadline ?? null;
            entry.retries = 0; entry.retryDeadline = null;
            entry.state.phase = 'ready'; entry.state.error = null; this.scheduleRenewal(entry); this.notify(entry); queueMicrotask(() => this.monitor(entry, entry.life)); return;
          }
          await guarded(this.refreshTarget(entry), signal); this.current(entry, signal);
          if (this.clock.now() >= entry.retryDeadline!) throw new PilotClientError('snapshot_expired');
          if (entry.blocked) throw new PilotClientError(entry.state.error ?? 'forbidden');
          await guarded(this.ensureReady(entry), signal); this.current(entry, signal); return;
        } catch (next) { failure = next; renewal = null; check(); if (!consumerRetryable(next)) throw next; if (!preserved) { this.fence(entry, true); entry.blocked = true; } }
      }
      throw failure;
    })();
    entry.recovering = pending;
    void pending.catch(failure => {
      if (entry.recovering !== pending || entry.controller.signal.aborted || entry.recoveryController.signal.aborted || preserved && epoch !== entry.authorityEpoch) return;
      if (preserved && (consumerRetryable(failure) || expiry.signal.aborted)) this.offline(entry); else this.block(entry, failure);
    }).finally(() => { expiry.dispose(); if (entry.recovering === pending) { entry.recovering = null; if (entry.state.phase === 'ready') this.scheduleRenewal(entry); } });
    return pending;
  }
  private block(entry: Entry, error: unknown): void {
    if (entry.controller.signal.aborted) return;
    this.fence(entry); entry.blocked = true;
    entry.state.phase = 'error'; entry.state.error = error instanceof PilotClientError ? error.code : 'invalid_response';
    for (const subscriber of entry.subscribers) this.cancel(entry, subscriber, error);
    this.notify(entry);
  }
  private presentationAuthority(entry: Entry): { deadline: number; valid: boolean } | undefined {
    const grant = entry.client.readAuthority();
    // A new proof received during recovery cannot republish a capture before its own feed ACK.
    if (!grant) return undefined;
    const confirmed = Math.min(grant.deadline, entry.presentationDeadline ?? grant.deadline);
    return { deadline: confirmed, valid: entry.authorityValid && entry.presentationDeadline !== null && this.clock.now() < confirmed };
  }
  private offline(entry: Entry): void { entry.state.phase = 'offline'; entry.state.error = 'unavailable'; this.notify(entry); }
  private renew(entry: Entry, signal: AbortSignal): Promise<unknown> {
    this.current(entry, signal);
    if (!this.demanded(entry)) return Promise.reject(changed());
    if (entry.renewal) return entry.renewal;
    const epoch = entry.authorityEpoch, renewalSignal = AbortSignal.any([signal, entry.renewalController.signal]);
    const pending = entry.client.renew(renewalSignal); entry.renewal = pending;
    void pending.finally(() => { if (entry.renewal === pending) entry.renewal = null; }).catch(() => {});
    void pending.then(() => {
      this.current(entry, renewalSignal); if (entry.authorityEpoch !== epoch) throw changed();
      // Every current admission can contract the effective bound, independently of continuity.
      this.notify(entry);
    }).catch(() => {});
    return pending;
  }
  private scheduleRenewal(entry: Entry): void {
    entry.renewalTimer?.(); entry.renewalTimer = undefined;
    const grant = entry.client.readAuthority();
    if (!grant || entry.renewal || entry.recovering || entry.state.phase !== 'ready' || ![...entry.subscribers].some(value => value.visible) || entry.controller.signal.aborted || !this.online || entry.blocked) return;
    const remaining = grant.deadline - this.clock.now();
    const delay = Math.max(this.retry.delaysMs[0] ?? this.retry.pollIntervalMs, remaining / 2);
    const generation = entry.authorityEpoch;
    entry.renewalTimer = (this.clock.timer ?? consumerTimer)(() => {
      entry.renewalTimer = undefined;
      if (entry.authorityEpoch !== generation || entry.renewal || !this.online || ![...entry.subscribers].some(value => value.visible)) return;
      const signal = AbortSignal.any([entry.controller.signal, entry.renewalController.signal]);
      const pending = this.renew(entry, signal);
      void pending.then(() => {
        this.current(entry, signal); if (entry.authorityEpoch !== generation) throw changed();
        // Only a still-healthy feed confirms ordinary renewal; an exhausted recovery stays offline.
        if (!entry.recovering && entry.ready && entry.authorityValid && entry.state.phase === 'ready') {
          entry.presentationDeadline = entry.client.readAuthority()?.deadline ?? null; entry.retries = 0; entry.retryDeadline = null;
        }
      }).catch(error => {
        if (signal.aborted || entry.authorityEpoch !== generation) return;
        if (consumerRetryable(error)) void this.recover(entry, error).catch(() => {});
        else this.block(entry, error);
      }).finally(() => {
        if (!signal.aborted && entry.authorityEpoch === generation && entry.state.phase === 'ready') this.scheduleRenewal(entry);
      });
    }, delay);
  }
  /** Network changes preserve only B7 contexts. Lifecycle suspension still disposes the owner. */
  setTransportOnline(online: boolean): void {
    this.check(); if (online === this.online) return; this.online = online;
    for (const entry of this.entries.values()) {
      if (!online) {
        if (!entry.client.readAuthority()) { this.block(entry, new PilotClientError('offline')); continue; }
        this.offline(entry); entry.renewalTimer?.(); entry.renewalTimer = undefined;
        entry.life.abort(); entry.life = new AbortController();
        entry.recoveryController.abort(); entry.recoveryController = new AbortController(); entry.recovering = null;
        entry.renewalController.abort(); entry.renewalController = new AbortController(); entry.renewal = null;
        this.cancelJob(entry);
      } else if (entry.client.readAuthority()) {
        entry.retries = 0; entry.retryDeadline = null;
        void (async () => {
          if (entry.monitoring) await entry.monitoring.catch(() => {});
          await this.recover(entry, new PilotClientError('unavailable', 503, true));
          if (!entry.blocked) this.monitor(entry, entry.life);
        })().catch(() => {});
      }
    }
  }
  private closeEntry(entry: Entry): void {
    entry.authorityValid = false; entry.authorityEpoch++; entry.presentationDeadline = null; this.invalidate(entry); entry.client.reset();
    entry.renewalTimer?.(); entry.renewalController.abort(); entry.renewal = null;
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
