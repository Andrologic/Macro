import type { ContentArtifact, ContentConversationRef, ContentDelivery, ContentEvent, ContentExportText, ContentTaskDetails, ContentTaskCard, ContentTaskRef, ContentTool } from './contentProtocol';
import type { KernelStorage } from './kernel';
import { controlledText, utf8Bytes, type TextPolicy } from './conversationText';
import { stableJson } from './protocol';

export const TASK_COMPLETION_CAPABILITIES = ['task-details-1', 'task-actions-1'] as const;
export const TASK_COMPLETION_OPERATIONS = new Set(['task.cards.list', 'task.get', 'task.artifacts.list', 'task.artifact.read', 'conversation.tools.list', 'conversation.tool.read', 'task.action']);
export type TaskAction = ContentTaskDetails['actions'][number];
export type DetailRef = ContentTaskRef | ContentConversationRef;
type CaptureRef = DetailRef | { instance_id: string };
type CaptureKind = DetailKind | 'cards';
export type DetailKind = 'task' | 'artifacts' | 'tools';
export interface DetailSource {
  /** Internal evidence participates in the fingerprint, never in the response. */
  fingerprint: unknown;
  task?: Omit<ContentTaskDetails, 'ref' | 'snapshot_id' | 'revision' | 'expires_at'>;
  items?: Array<ContentArtifact | ContentTool | ContentTaskCard>;
  read?(id: string): Promise<string | null>;
}
export interface TaskCompletionSource {
  cards(policy: TextPolicy): Promise<ContentTaskCard[]>;
  load(kind: DetailKind, ref: DetailRef, policy: TextPolicy): Promise<DetailSource>;
  execute(ref: ContentTaskRef, action: TaskAction, title: string | undefined, beforeEffect: () => Promise<void>): Promise<void>;
}
interface Revision { hash: string; revision: number }
interface Receipt { digest: string; revision: number; state: 'pending' | 'applied' }
interface Journal { version: 1; records: Record<string, Revision>; receipts: Record<string, Receipt> }
interface Capture {
  binding: string; key: string; kind: CaptureKind; ref: CaptureRef; revision: number;
  observed: number; policy: string; cursors: Map<string, number>; bodies: Map<string, string>;
}
const fail = (code: string): never => { throw new Error(code); };
const sha = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)))), b => b.toString(16).padStart(2, '0')).join('');
const itemId = (item: ContentArtifact | ContentTool | ContentTaskCard) => 'artifact_id' in item ? item.artifact_id : 'trace_id' in item ? item.trace_id : item.ref.task_id;

/** Owned by ContentHost's serial queue. Only fingerprints and action receipts persist. */
export class TaskCompletionHost {
  private journal: Journal = { version: 1, records: {}, receipts: {} };
  private persisted: string | null = null;
  private captures = new Map<string, Capture>();
  private observeOffset = 0;
  constructor(private readonly deps: {
    source: TaskCompletionSource; storage: KernelStorage; now?: () => number;
    emit(change: ContentEvent['change']): Promise<void>;
  }) {}
  private now() { return (this.deps.now ?? Date.now)(); }
  clear() { this.captures.clear(); }
  async initialize() {
    this.persisted = await this.deps.storage.load();
    if (this.persisted !== null) {
      if (utf8Bytes(this.persisted) > 1024 * 1024) fail('resource_limit');
      const value = JSON.parse(this.persisted) as Journal;
      if (value.version !== 1 || !value.records || !value.receipts ||
        Object.values(value.records).some(r => !/^[a-f0-9]{64}$/.test(r.hash) || !Number.isSafeInteger(r.revision) || r.revision < 1) ||
        Object.values(value.receipts).some(r => !/^[a-f0-9]{64}$/.test(r.digest) || !Number.isSafeInteger(r.revision) || r.revision < 1 || !['pending', 'applied'].includes(r.state))) fail('content_unavailable');
      this.journal = value;
    }
  }
  private async save(next: Journal) {
    const value = stableJson(next);
    if (utf8Bytes(value) > 1024 * 1024 || Object.keys(next.records).length > 2000 || Object.keys(next.receipts).length > 2000) fail('resource_limit');
    if (!await this.deps.storage.compareAndSwap(this.persisted, value)) fail('conflict');
    this.persisted = value; this.journal = next;
  }
  private prune() {
    for (const [id, capture] of this.captures) if (capture.observed + 300_000 <= this.now()) this.captures.delete(id);
  }
  private budget() {
    const size = [...this.captures.values()].reduce((sum, c) => sum + utf8Bytes(stableJson({ ...c, cursors: [...c.cursors], bodies: [...c.bodies] })), 0);
    if (size > 8 * 1024 * 1024 || this.captures.size > 128) fail('resource_limit');
  }
  private async load(kind: CaptureKind, ref: CaptureRef, policy: TextPolicy) {
    const cards = kind === 'cards' ? await this.deps.source.cards(policy) : undefined;
    const source: DetailSource = cards ? { fingerprint: cards, items: cards } : await this.deps.source.load(kind as DetailKind, ref as DetailRef, policy);
    if ((source.items?.length ?? 0) > 2000 || utf8Bytes(stableJson(source)) > 8 * 1024 * 1024) fail('resource_limit');
    const key = await sha([kind, ref]);
    const hash = await sha([source.fingerprint, source.task, source.items, policy]);
    const old = this.journal.records[key];
    if (!old || old.hash !== hash) {
      const next = structuredClone(this.journal);
      next.records[key] = { hash, revision: (old?.revision ?? 0) + 1 };
      // Queue invalidation before advancing the durable fingerprint; a crash may
      // repeat an event, but cannot silently advance past its invalidation.
      if (old) await this.emit(kind, ref, next.records[key].revision);
      await this.save(next);
    }
    return { source, key, revision: this.journal.records[key].revision };
  }
  private emit(kind: CaptureKind, ref: CaptureRef, revision: number) {
    return this.deps.emit(kind === 'cards' ? { kind: 'tasks.changed', scope: { instance_id: ref.instance_id }, revision } : kind === 'tools' ? { kind: 'tools.changed', scope: ref as ContentConversationRef, revision } :
      { kind: 'task.changed', scope: ref as ContentTaskRef, revision });
  }
  async observe(policy: TextPolicy) {
    this.prune();
    const captures = [...this.captures.values()];
    if (!captures.length) return;
    const capture = captures[this.observeOffset++ % captures.length];
    try { await this.load(capture.kind, capture.ref, policy); }
    catch {
      // An inaccessible source invalidates all its captures, without exposing why.
      for (const [id, item] of this.captures) if (item.key === capture.key) this.captures.delete(id);
      await this.emit(capture.kind, capture.ref, capture.revision + 1);
    }
  }
  private binding(delivery: ContentDelivery, kind: CaptureKind, ref: CaptureRef) {
    return stableJson([delivery.account_id, delivery.source_session_id, delivery.instance_id, kind, ref]);
  }
  private async current(delivery: ContentDelivery, id: string, kind: CaptureKind, ref: CaptureRef, policy: TextPolicy) {
    this.prune();
    const capture = this.captures.get(id);
    if (!capture || capture.binding !== this.binding(delivery, kind, ref) || capture.policy !== await sha(policy)) return fail('snapshot_expired');
    const loaded = await this.load(kind, ref, policy);
    if (loaded.revision !== capture.revision) return fail('stale_revision');
    return { capture, source: loaded.source };
  }
  async handle(delivery: ContentDelivery, policy: TextPolicy, authorize: () => Promise<void>): Promise<unknown> {
    this.prune();
    const request = delivery.request;
    if (request.operation === 'task.action') {
      const body = request.body;
      const key = await sha([delivery.account_id, delivery.source_session_id, body.idempotency_key]);
      const digest = await sha(body); const old = this.journal.receipts[key];
      await authorize();
      if (old) {
        if (old.digest !== digest || old.state !== 'applied') return fail('conflict');
        return { outcome: 'duplicate', revision: old.revision };
      }
      const { capture, source } = await this.current(delivery, body.snapshot_id, 'task', body.ref, policy);
      if (capture.revision !== body.expected_revision) return fail('stale_revision');
      if (!source.task?.actions.includes(body.action)) return fail('content_unavailable');
      const revision = body.expected_revision + 1;
      const next = structuredClone(this.journal);
      next.receipts[key] = { digest, revision, state: 'pending' };
      await this.save(next);
      let firstEffect = true;
      await this.deps.source.execute(body.ref, body.action, body.title, async () => {
        await authorize();
        // The source's reservation guards subsequent effects against retargeting.
        // The first effect must still match the captured pre-mutation revision.
        if (firstEffect) {
          await this.current(delivery, body.snapshot_id, 'task', body.ref, policy);
          await authorize(); firstEffect = false;
        }
      });
      if (firstEffect) return fail('content_unavailable');
      const done = structuredClone(this.journal); done.receipts[key].state = 'applied';
      await this.emit('task', body.ref, revision);
      await this.save(done);
      for (const [id, c] of this.captures) if (stableJson(c.ref) === stableJson(body.ref)) this.captures.delete(id);
      return { outcome: 'applied', revision };
    }
    if (request.operation === 'task.artifact.read' || request.operation === 'conversation.tool.read') {
      const { ref, snapshot_id, item_id, offset_bytes } = request.body;
      const kind = request.operation === 'task.artifact.read' ? 'artifacts' : 'tools';
      const { capture, source } = await this.current(delivery, snapshot_id, kind, ref, policy);
      if (!source.items?.some(item => itemId(item) === item_id) || !source.read) return fail('not_found');
      const raw = await source.read(item_id);
      if (raw === null) return fail('content_unavailable');
      if (utf8Bytes(raw) > 1024 * 1024) return fail('resource_limit');
      const content = /<\/?(?:think|analysis|reasoning)(?:\s|>)/i.test(raw) ? { content_state: 'withheld' as const, reason: 'unknown_provenance' as const } : controlledText(raw, policy);
      const fullHash = await sha(raw); const previous = capture.bodies.get(item_id);
      if (previous && previous !== fullHash) return fail('stale_revision');
      capture.bodies.set(item_id, fullHash); this.budget();
      // Recheck index/visibility after loading the requested body.
      await this.current(delivery, snapshot_id, kind, ref, policy);
      if (content.content_state === 'withheld') {
        if (offset_bytes !== 0) return fail('validation_failed');
        return { snapshot_id, item_id, offset_bytes: 0, next_offset_bytes: null, total_bytes: 0, content };
      }
      const bytes = new TextEncoder().encode(raw);
      if (offset_bytes > bytes.length || (offset_bytes < bytes.length && (bytes[offset_bytes] & 0xc0) === 0x80)) return fail('validation_failed');
      let end = Math.min(bytes.length, offset_bytes + 16384);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      return { snapshot_id, item_id, offset_bytes, next_offset_bytes: end === bytes.length ? null : end,
        total_bytes: bytes.length, content: { content_state: 'complete', text: new TextDecoder().decode(bytes.slice(offset_bytes, end)) } };
    }
    if (request.operation !== 'task.cards.list' && request.operation !== 'task.get' && request.operation !== 'task.artifacts.list' && request.operation !== 'conversation.tools.list') return fail('validation_failed');
    const ref: CaptureRef = request.operation === 'task.cards.list' ? { instance_id: request.body.instance_id } : request.body.ref;
    const kind: CaptureKind = request.operation === 'task.cards.list' ? 'cards' : request.operation === 'task.get' ? 'task' : request.operation === 'task.artifacts.list' ? 'artifacts' : 'tools';
    const continuation = 'continuation' in request.body ? request.body.continuation : undefined;
    let id: string; let capture: Capture; let source: DetailSource; let offset = 0;
    if (continuation) {
      id = continuation.snapshot_id;
      ({ capture, source } = await this.current(delivery, id, kind, ref, policy));
      if (!capture.cursors.has(continuation.cursor)) return fail('snapshot_expired');
      offset = capture.cursors.get(continuation.cursor)!;
    } else {
      const loaded = await this.load(kind, ref, policy); source = loaded.source;
      id = crypto.randomUUID();
      capture = { binding: this.binding(delivery, kind, ref), key: loaded.key, kind, ref, revision: loaded.revision,
        observed: this.now(), policy: await sha(policy), cursors: new Map(), bodies: new Map() };
      this.captures.set(id, capture);
      try { this.budget(); } catch (error) { this.captures.delete(id); throw error; }
    }
    if (kind === 'task') {
      if (!source.task) return fail('content_unavailable');
      return { ...source.task, ref, snapshot_id: id, revision: capture.revision, expires_at: new Date(capture.observed + 300_000).toISOString() };
    }
    const all = source.items ?? [];
    const items: typeof all = [];
    let size = 0;
    for (const item of all.slice(offset, offset + 50)) {
      const nextSize = utf8Bytes(JSON.stringify(item));
      if (size + nextSize > 180_000) break;
      items.push(item); size += nextSize;
    }
    const end = offset + items.length;
    let cursor: string | null = null;
    if (end < all.length) {
      cursor = [...capture.cursors].find(([, value]) => value === end)?.[0] ?? crypto.randomUUID();
      capture.cursors.set(cursor, end); this.budget();
    }
    return { page: { snapshot_id: id, revision: capture.revision, observed_at: new Date(capture.observed).toISOString(),
      expires_at: new Date(capture.observed + 300_000).toISOString(), export_policy_revision: 'visible-1', offset, total: all.length, next_cursor: cursor }, items };
  }
}

export function exportDetailText(text: string, policy: TextPolicy): ContentExportText {
  const result = controlledText(text, policy);
  return 'text' in result ? { content_state: result.content_state, text: result.text } : { content_state: 'withheld', reason: result.reason === 'unsafe_content' ? 'unsafe_content' : 'unknown_provenance' };
}
