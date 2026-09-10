import { ConversationCaptures, ConversationCaptureError, type ConversationRef } from './conversationCaptures';
import { type TextPolicy, utf8Bytes } from './conversationText';
import { createReviewCaptureService, type ReviewCaptureInfo, type ReviewCaptureRequest, type ReviewCaptureSource } from './reviewCapture';
import { validateContentMessage, validateContentResponse, type ContentCapture, type ContentDelivery, type ContentDeliveryResult, type ContentError, type ContentEvent, type ContentRequest, type ContentReviewRef } from './contentProtocol';
import type { KernelStorage } from './kernel';
import { PilotError, stableJson } from './protocol';

export const CONTENT_BUDGET = { conversations: 24 * 1024 * 1024, native: 32 * 1024 * 1024, host: 7 * 1024 * 1024 } as const;
export interface ReviewTarget { repoPath: string; source: ReviewCaptureSource; branches?: { base: string; head: string } }
interface ReviewRecord { ref: ContentReviewRef; token: string; revision: number; state: ContentCapture['state'] }
interface Receipt { digest: string; revision: number }
interface Journal {
  version: 1; stream: string; sequence: number; outbox: ContentEvent[];
  projects: number; conversations: number; refs: ConversationRef[];
  reviews: Record<string, ReviewRecord>; receipts: Record<string, Receipt>;
}
interface Snapshot { binding: string; target: ReviewTarget; info: ReviewCaptureInfo; capture: ContentCapture; cursors: Record<string, string> }
export interface ContentHostDependencies {
  accountId: string; instanceId: string; signal: AbortSignal;
  conversations: ConversationCaptures;
  reviews: ReturnType<typeof createReviewCaptureService>;
  storage: KernelStorage;
  commitReview(snapshotId: string, request: ReviewCaptureRequest, previous: string | null, next: string, executeBefore: string, target: ReviewTarget): Promise<boolean>;
  reviewRefs(): Promise<ContentReviewRef[]>;
  resolveReview(ref: ContentReviewRef): Promise<ReviewTarget>;
  policy(): Promise<TextPolicy>;
  now?: () => number;
}
const failure = (code: ContentError['code']): never => { throw new ContentHostError(code); };
class ContentHostError extends Error { constructor(readonly code: ContentError['code']) { super(code); } }
async function hash(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)))), b => b.toString(16).padStart(2, '0')).join('');
}
const operations = new Set(['projects.list', 'conversations.list', 'conversation.read', 'review.get', 'diff.files', 'diff.read', 'review.verdict']);

/** One lifecycle owner. Native capture handles and paths never enter the journal or wire response. */
export class ContentHost {
  private state!: Journal;
  private persisted: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private snapshots = new Map<string, Snapshot>();
  private replies = new Map<string, { digest: string; expires: number; response: unknown }>();
  private policyKey: string | null = null;
  private reviewOffset = 0;
  private readonly now: () => number;
  constructor(private readonly deps: ContentHostDependencies) { this.now = deps.now ?? Date.now; }
  async validateConversationSendTarget(ref: ConversationRef, expectedRevision: number): Promise<void> {
    return this.serial(async () => {
      await this.policy();
      const catalog = await this.deps.conversations.refreshCatalogMetadata();
      this.check();
      if (ref.kind !== 'conversation' || !catalog.refs.some(candidate => stableJson(candidate) === stableJson(ref))) throw new PilotError('invalid_reference');
      if (catalog.revision !== expectedRevision) failure('stale_revision');
    });
  }
  isAvailable(): boolean { return !this.disposed && !this.deps.signal.aborted; }
  private check() { if (this.disposed || this.deps.signal.aborted) failure('unavailable'); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => { this.check(); return work(); });
    this.tail = next.catch(() => undefined); return next;
  }
  async initialize(): Promise<void> {
    return this.serial(async () => {
      this.persisted = await this.deps.storage.load(); this.check();
      if (this.persisted !== null) {
        if (utf8Bytes(this.persisted) > CONTENT_BUDGET.host / 2) failure('resource_limit');
        const old = JSON.parse(this.persisted) as Journal;
        if (old.version !== 1 || !old.reviews || !old.receipts || !Array.isArray(old.refs) || !Number.isSafeInteger(old.projects) || !Number.isSafeInteger(old.conversations)) failure('unavailable');
        const validRevision = (value: number) => Number.isSafeInteger(value) && value >= 0;
        const validDigest = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
        if (!validRevision(old.projects) || !validRevision(old.conversations) ||
          Object.entries(old.reviews).some(([key, record]) => !record || stableJson(record.ref) !== key || !validRevision(record.revision) || record.revision === 0 ||
            !['pending', 'approved', 'changes_requested'].includes(record.state) || (record.token !== 'unavailable' && !validDigest(record.token)) ||
            !validateContentMessage({ contract_version: '2.0', type: 'request', account_id: this.deps.accountId, request_id: 'validate:journal', operation: 'review.get', body: { ref: record.ref } }) || record.ref.instance_id !== this.deps.instanceId) ||
          Object.entries(old.receipts).some(([key, receipt]) => !validDigest(key) || !receipt || !validDigest(receipt.digest) || !validRevision(receipt.revision) || receipt.revision === 0)) failure('unavailable');
        this.state = old;
      } else this.state = { version: 1, stream: '', sequence: 0, outbox: [], projects: 0, conversations: 0, refs: [], reviews: {}, receipts: {} };
      // C4 has its own revision CAS. A crash between it and this outbox cannot prove
      // event continuity, so every lifecycle starts a new producer stream.
      const next = structuredClone(this.state);
      next.stream = crypto.randomUUID(); next.sequence = 0; next.outbox = [];
      next.projects = 0; next.conversations = 0;
      await this.save(next);
    });
  }
  private async save(next: Journal, commit = (previous: string | null, value: string) => this.deps.storage.compareAndSwap(previous, value)): Promise<void> {
    this.check();
    const value = stableJson(next);
    // Count both the durable JSON and its in-memory representation, plus handles.
    if (utf8Bytes(value) * 2 + this.memoryBytes() > CONTENT_BUDGET.host) failure('resource_limit');
    if (!await commit(this.persisted, value)) { this.disposed = true; failure('unavailable'); }
    this.check(); this.persisted = value; this.state = next;
  }
  private memoryBytes(): number {
    return [...this.snapshots.values()].reduce((bytes, snapshot) => bytes + utf8Bytes(stableJson(snapshot)) * 2 + 1024,
      [...this.replies.values()].reduce((bytes, reply) => bytes + utf8Bytes(stableJson(reply)) * 2 + 256, 4096));
  }
  private event(next: Journal, change: ContentEvent['change']) {
    const event: ContentEvent = { contract_version: '2.0', type: 'event', account_id: this.deps.accountId,
      stream_id: next.stream, sequence: ++next.sequence, occurred_at: new Date(this.now()).toISOString(), change };
    if (!validateContentMessage(event)) failure('unavailable');
    next.outbox.push(event);
  }
  private async policy(): Promise<TextPolicy> {
    const policy = await this.deps.policy(); this.check();
    const key = await hash(policy); this.check();
    if (this.policyKey !== null && key !== this.policyKey) {
      this.deps.conversations.clear(); this.replies.clear();
      const snapshots = [...this.snapshots.values()]; this.snapshots.clear();
      await Promise.all(snapshots.map(snapshot => this.deps.reviews.release(snapshot.info.snapshot_id).catch(() => undefined)));
    }
    this.policyKey = key; return policy;
  }
  async prepare(): Promise<void> {
    await this.serial(() => this.policy());
    const projects = await this.deps.conversations.refreshProjects();
    const conversations = await this.deps.conversations.refreshCatalog();
    this.check();
    // Establish catalogs before advertising the producer. Their first observation
    // describes the baseline; it does not invalidate content exposed afterwards.
    await this.serial(async () => {
      const next = structuredClone(this.state);
      next.projects = projects; next.conversations = conversations.revision; next.refs = conversations.refs;
      await this.save(next);
    });
  }
  async observe(): Promise<void> {
    await this.serial(() => this.policy());
    let projects: number | null = null;
    let conversations: { revision: number; refs: ConversationRef[] } | null = null;
    let observationError: unknown;
    try { projects = await this.deps.conversations.refreshProjects(); }
    catch (error) { observationError = error; }
    this.check();
    try { conversations = await this.deps.conversations.refreshCatalog(); }
    catch (error) { observationError = error; }
    this.check();
    // C4 owns its own observation queue. Do not hold the host's decision queue
    // across a transcript scan; review deliveries can proceed in the meantime.
    await this.serial(async () => {
      for (const [key, reply] of this.replies) if (reply.expires <= this.now()) this.replies.delete(key);
      const next = structuredClone(this.state);
      if (projects !== null && projects > next.projects) {
        next.projects = projects;
        this.event(next, { kind: 'projects.changed', scope: { instance_id: this.deps.instanceId }, revision: projects });
      }
      if (conversations && conversations.revision > next.conversations) {
        next.conversations = conversations.revision;
        this.event(next, { kind: 'conversations.changed', scope: { instance_id: this.deps.instanceId }, revision: conversations.revision });
        const present = new Set(conversations.refs.map(stableJson));
        for (const ref of next.refs) if (!present.has(stableJson(ref))) this.event(next, { kind: 'conversation.removed', scope: ref, revision: conversations.revision });
        for (const ref of conversations.refs) this.event(next, { kind: 'conversation.changed', scope: ref, revision: conversations.revision });
        next.refs = conversations.refs;
      }
      if (stableJson(next) !== stableJson(this.state)) await this.save(next);
      // Discover local reviews without a remote read. A bounded rotating batch
      // prevents a large task catalog from monopolizing the producer.
      const refs = new Map((await this.deps.reviewRefs()).map(ref => [stableJson(ref), ref]));
      for (const record of Object.values(this.state.reviews)) refs.set(stableJson(record.ref), record.ref);
      const all = [...refs.values()];
      const batch = Array.from({ length: Math.min(1, all.length) }, (_, i) => all[(this.reviewOffset + i) % all.length]);
      this.reviewOffset = (this.reviewOffset + batch.length) % Math.max(1, all.length);
      for (const ref of batch) {
        try {
          const target = await this.deps.resolveReview(ref); this.check();
          const policy = await this.policy();
          const info = await this.deps.reviews.capture(target.repoPath, this.captureRequest(target, policy));
          try { await this.record(ref, target, info); }
          finally { await this.deps.reviews.release(info.snapshot_id); }
        } catch (error) {
          this.check();
          // Loss of the local source also invalidates the old revision.
          const code = error instanceof Error ? error.message : error;
          if (code !== 'not_found' && code !== 'stale_revision') continue;
          const next = structuredClone(this.state); const current = next.reviews[stableJson(ref)];
          if (current && current.token !== 'unavailable') {
            current.token = 'unavailable'; current.revision++; current.state = 'pending';
            this.event(next, { kind: 'review.changed', scope: current.ref, revision: current.revision }); await this.save(next);
          }
        }
      }
      for (const [id, snapshot] of this.snapshots) if (Date.parse(snapshot.info.expires_at) <= this.now()) {
        this.snapshots.delete(id); await this.deps.reviews.release(snapshot.info.snapshot_id).catch(() => undefined);
      }
    });
    if (observationError) throw observationError;
  }
  private captureRequest(target: ReviewTarget, policy: TextPolicy): ReviewCaptureRequest {
    return { source: target.source, policy_revision: 'visible-1', secret_values: [...policy.secrets] };
  }
  private async record(ref: ContentReviewRef, target: ReviewTarget, info: ReviewCaptureInfo): Promise<ReviewRecord> {
    this.check();
    if (!/^[a-f0-9]{64}$/.test(info.revision_token)) failure('content_unavailable');
    const token = await hash([target, info.revision_token]); this.check();
    const key = stableJson(ref); const old = this.state.reviews[key];
    if (old?.token === token) return old;
    const next = structuredClone(this.state);
    const record: ReviewRecord = { ref, token, revision: (old?.revision ?? 0) + 1, state: 'pending' };
    next.reviews[key] = record;
    // Discovery, whether background or review.get, has no earlier capture to
    // invalidate. Only a change to an established fingerprint emits an event.
    if (old) this.event(next, { kind: 'review.changed', scope: ref, revision: record.revision });
    await this.save(next); return record;
  }
  private binding(delivery: ContentDelivery, ref: ContentReviewRef): string {
    return stableJson([delivery.account_id, delivery.source_session_id, delivery.instance_id, ref]);
  }
  private snapshot(delivery: ContentDelivery, ref: ContentReviewRef, id: string): Snapshot {
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.binding !== this.binding(delivery, ref) || Date.parse(snapshot.info.expires_at) <= this.now()) return failure('snapshot_expired');
    if (this.state.reviews[stableJson(ref)]?.revision !== snapshot.capture.revision) return failure('stale_revision');
    return snapshot;
  }
  private async read(delivery: ContentDelivery, request: ContentRequest): Promise<unknown> {
    const scope = { accountId: delivery.account_id, sessionId: delivery.source_session_id, instanceId: delivery.instance_id };
    switch (request.operation) {
      case 'projects.list': return this.deps.conversations.projectsList(scope, request.body.continuation);
      case 'conversations.list': return this.deps.conversations.conversationsList(scope, request.body.kind, request.body.continuation);
      case 'conversation.read': return this.deps.conversations.conversationRead(scope, request.body.ref, request.body.continuation);
      case 'review.get': {
        const target = await this.deps.resolveReview(request.body.ref); this.check();
        const info = await this.deps.reviews.capture(target.repoPath, this.captureRequest(target, await this.policy()));
        try {
          this.check();
          const record = await this.record(request.body.ref, target, info);
          const capture: ContentCapture = { snapshot_id: crypto.randomUUID(), revision: record.revision,
            source: info.source.kind === 'commits' ? info.source : { ...info.source, head_sha: info.head_sha },
            observed_at: info.observed_at, expires_at: info.expires_at, export_policy_revision: info.export_policy_revision,
            availability: info.availability, file_count: info.file_count, state: record.state };
          this.snapshots.set(capture.snapshot_id, { binding: this.binding(delivery, request.body.ref), target, info, capture, cursors: {} });
          if (this.memoryBytes() + utf8Bytes(this.persisted ?? '') * 2 > CONTENT_BUDGET.host) { this.snapshots.delete(capture.snapshot_id); failure('resource_limit'); }
          return capture;
        } catch (error) { await this.deps.reviews.release(info.snapshot_id).catch(() => undefined); throw error; }
      }
      case 'diff.files': {
        const { ref, snapshot_id: id, continuation } = request.body; const snapshot = this.snapshot(delivery, ref, id);
        if (continuation && (continuation.snapshot_id !== id || !Object.hasOwn(snapshot.cursors, continuation.cursor))) failure('snapshot_expired');
        const page = await this.deps.reviews.files(snapshot.info.snapshot_id, continuation ? snapshot.cursors[continuation.cursor] : undefined); this.check();
        let cursor: string | null = null;
        if (page.next_cursor) {
          cursor = Object.keys(snapshot.cursors).find(key => snapshot.cursors[key] === page.next_cursor) ?? crypto.randomUUID();
          snapshot.cursors[cursor] = page.next_cursor;
          if (this.memoryBytes() + utf8Bytes(this.persisted ?? '') * 2 > CONTENT_BUDGET.host) { delete snapshot.cursors[cursor]; failure('resource_limit'); }
        }
        const { capture } = snapshot;
        return { page: { snapshot_id: id, revision: capture.revision, observed_at: capture.observed_at, expires_at: capture.expires_at,
          export_policy_revision: capture.export_policy_revision, offset: page.offset, total: page.total, next_cursor: cursor }, items: page.items };
      }
      case 'diff.read': {
        const { ref, snapshot_id, file_id, offset_bytes } = request.body; const snapshot = this.snapshot(delivery, ref, snapshot_id);
        const result = await this.deps.reviews.read(snapshot.info.snapshot_id, file_id, offset_bytes);
        return { ...result, snapshot_id };
      }
      default: return failure('validation_failed');
    }
  }
  /** The delivery is accepted only from the native authenticated producer transport. */
  handle(input: unknown, authorize: (delivery: ContentDelivery) => Promise<string>): Promise<ContentDeliveryResult> {
    return this.serial(async () => {
      if (!validateContentMessage(input) || input.type !== 'delivery') failure('validation_failed');
      const delivery = input as ContentDelivery; const request = delivery.request;
      if (delivery.account_id !== this.deps.accountId || delivery.instance_id !== this.deps.instanceId ||
        request.account_id !== delivery.account_id || request.request_id !== delivery.request_id || !operations.has(request.operation)) failure('validation_failed');
      const body = request.body as { instance_id?: string; ref?: { instance_id: string } };
      if ((body.instance_id ?? body.ref?.instance_id) !== this.deps.instanceId) failure('validation_failed');
      const replyKey = await hash([delivery.account_id, delivery.source_session_id, delivery.request_id]);
      const requestDigest = await hash(request);
      let deadline = 0;
      const guard = () => { this.check(); if (this.now() >= deadline || this.now() >= Date.parse(delivery.expires_at)) failure('unavailable'); };
      const authorizeNow = async () => { this.check(); deadline = Date.parse(await authorize(delivery)); if (!Number.isFinite(deadline) || deadline > this.now() + 10_000 || deadline > Date.parse(delivery.expires_at)) failure('unavailable'); guard(); };
      let response: unknown;
      try {
        if (Date.parse(delivery.expires_at) <= this.now()) failure('unavailable');
        await this.policy();
        const readingPolicy = this.policyKey;
        let result: unknown;
        if (request.operation === 'review.verdict') {
          const { ref, snapshot_id, idempotency_key, expected_revision, verdict } = request.body;
          const receiptKey = await hash([delivery.account_id, delivery.source_session_id, idempotency_key]);
          const digest = await hash(request.body); const receipt = this.state.receipts[receiptKey];
          await authorizeNow();
          if (receipt) {
            if (receipt.digest !== digest) failure('conflict');
            result = { outcome: 'duplicate', revision: receipt.revision };
          } else {
            const snapshot = this.snapshot(delivery, ref, snapshot_id);
            const target = await this.deps.resolveReview(ref); guard();
            if (stableJson(target) !== stableJson(snapshot.target)) failure('stale_revision');
            const current = this.state.reviews[stableJson(ref)];
            if (!current || current.revision !== expected_revision || snapshot.capture.revision !== expected_revision) failure('stale_revision');
            const policy = await this.policy(); guard();
            // The native command holds the repository lock across its final
            // fingerprint check and the SQLite decision/receipt transaction.
            const next = structuredClone(this.state); const record = next.reviews[stableJson(ref)];
            record.revision++; record.state = verdict === 'approve' ? 'approved' : 'changes_requested';
            next.receipts[receiptKey] = { digest, revision: record.revision };
            this.event(next, { kind: 'review.changed', scope: ref, revision: record.revision });
            guard(); await this.save(next, (previous, value) => this.deps.commitReview(snapshot.info.snapshot_id, this.captureRequest(target, policy), previous, value, new Date(deadline).toISOString(), target)); guard();
            result = { outcome: 'applied', revision: record.revision };
          }
        } else {
          const cached = this.replies.get(replyKey);
          if (cached && cached.expires > this.now()) {
            if (request.operation === 'diff.files' || request.operation === 'diff.read') this.snapshot(delivery, request.body.ref, request.body.snapshot_id);
            if (request.operation === 'review.get') {
              const capture = (cached.response as { result: ContentCapture }).result;
              this.snapshot(delivery, request.body.ref, capture.snapshot_id);
            }
            await authorizeNow();
            if (cached.digest !== requestDigest) failure('conflict');
            await this.policy(); guard();
            if (readingPolicy !== this.policyKey) failure('snapshot_expired');
            return { transport_version: '2.0', type: 'delivery.result', request_id: delivery.request_id, instance_id: delivery.instance_id, response: structuredClone(cached.response) } as ContentDeliveryResult;
          }
          result = await this.read(delivery, request); await authorizeNow();
        }
        await this.policy(); guard();
        if (readingPolicy !== this.policyKey) failure('snapshot_expired');
        response = { contract_version: '2.0', type: 'response', request_id: request.request_id, account_id: request.account_id, operation: request.operation, result };
        if (!validateContentResponse(request, response)) failure('content_unavailable');
        if (request.operation !== 'review.verdict') {
          this.replies.set(replyKey, { digest: requestDigest, expires: Math.min(Date.parse(delivery.expires_at), this.now() + 300_000), response });
          if (this.memoryBytes() + utf8Bytes(this.persisted ?? '') * 2 > CONTENT_BUDGET.host) { this.replies.delete(replyKey); failure('resource_limit'); }
        }
      } catch (error) {
        this.check();
        // No cached body or controlled error is emitted without current authorization.
        if (!deadline) await authorizeNow(); else guard();
        const nativeCode = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
        const codes = new Set(['content_unavailable', 'not_found', 'validation_failed', 'snapshot_expired', 'stale_revision', 'resource_limit']);
        const code = error instanceof ContentHostError || error instanceof ConversationCaptureError ? error.code : codes.has(nativeCode) ? nativeCode : 'unavailable';
        response = { contract_version: '2.0', type: 'error', request_id: request.request_id, account_id: request.account_id, operation: request.operation, code, retryable: code === 'unavailable' };
        if (!validateContentResponse(request, response)) failure('unavailable');
      }
      guard();
      return { transport_version: '2.0', type: 'delivery.result', request_id: delivery.request_id, instance_id: delivery.instance_id, response } as ContentDeliveryResult;
    });
  }
  async flush(send: (event: ContentEvent) => Promise<void>): Promise<void> {
    // HTTP can be slow. Retain only the event copy across the network wait,
    // letting deliveries enter the host queue before the durable acknowledgement.
    for (let sent = 0; sent < 100; sent++) {
      const event = await this.serial(async () => structuredClone(this.state.outbox[0] ?? null));
      if (!event) return;
      this.check(); await send(event); this.check();
      await this.serial(async () => {
        const head = this.state.outbox[0];
        if (head?.stream_id !== event.stream_id || head.sequence !== event.sequence) failure('unavailable');
        const next = structuredClone(this.state); next.outbox.shift(); await this.save(next);
      });
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.deps.conversations.clear(); this.snapshots.clear(); this.replies.clear();
    await this.deps.reviews.dispose(); await this.tail;
  }
}
