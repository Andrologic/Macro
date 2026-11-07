import type { ConversationContentToken, ConversationContentDescriptor, ConversationContentItem, ConversationContentMetadataInput, ConversationContentMetadataPage, ConversationContentWindowInput, ConversationContentWindow } from '../ipc/conversationContent';
import { projectFinalProvenance } from './assistantProvenance';
import type { ProviderFailure } from '../../types';
import { pilotTaskId } from './taskIdentity';
import type { DbConversation, DbMessage } from '../tauriIpc';
import type { KernelStorage } from './kernel';
import { stableJson } from './protocol';
import { completion, controlledText, messageText, utf8Bytes, type TextPolicy } from './conversationText';
import type { Conversation, ConversationCatalogToken, ConversationCatalogPageInput, ConversationCatalogPage, ConversationCatalogVersionInput } from '../../types/generated/ipc';
import { CATALOG_PAGE_BYTES, catalogToken, checkCatalogPage, ownCatalogRow, sameCatalogToken } from './conversationCatalog';
import { captureCost, parsedCaptureCost } from './conversationCaptureBudget';

export type CaptureErrorCode = 'unavailable' | 'content_unavailable' | 'not_found' | 'validation_failed' | 'snapshot_expired' | 'stale_revision' | 'resource_limit';
export class ConversationCaptureError extends Error {
  constructor(readonly code: CaptureErrorCode) { super(code); }
}
export interface CaptureScope { accountId: string; sessionId: string; instanceId: string; reliability?: boolean }
export type ConversationRef = { instance_id: string; kind: 'conversation'; conversation_id: string } |
  { instance_id: string; kind: 'implement'; workspace_id: string; task_id: string; conversation_id: string };
export interface CaptureProject { id: string; name: string }
export interface CaptureTask { id: string; project_id: string; conversation_id?: string | null }
export interface ConversationActivity { attention?: 'none' | 'generating' | 'user_request' | 'tool_approval' | 'error' | 'unknown'; providerFailure?: ProviderFailure | null; activity: 'busy' | 'idle' | 'error' | 'unknown'; generatingMessageId: string | null }
export interface NativeConversationContent {
  version(id: string): Promise<ConversationContentToken>;
  metadata(input: ConversationContentMetadataInput): Promise<ConversationContentMetadataPage>;
  window(input: ConversationContentWindowInput): Promise<ConversationContentWindow>;
}
export interface ConversationCaptureSource {
  nativeCatalog?: {
    version(input: ConversationCatalogVersionInput): Promise<ConversationCatalogToken>;
    page(input: ConversationCatalogPageInput): Promise<ConversationCatalogPage>;
  };
  nativeContent?: NativeConversationContent;
  runtimeActivity?(id: string): ConversationActivity;
  projects(): Promise<CaptureProject[]>;
  tasks(): Promise<CaptureTask[]>;
  listConversations(): Promise<DbConversation[]>;
  catalogMetadata?(): Promise<unknown>;
  getConversation(id: string): Promise<DbConversation | null>;
  listMessages(id: string): Promise<DbMessage[]>;
  activity(id: string): ConversationActivity;
  finalProvenance?(message: DbMessage): Promise<string | null>;
}
export interface CaptureDependencies {
  instanceId: string;
  workspaceId: string;
  source: ConversationCaptureSource;
  storage: KernelStorage;
  policy(): TextPolicy;
  now?: () => number;
  quotaBytes?: number;
}
export interface Continuation { snapshot_id: string; cursor: string }
export interface PageMetadata {
  snapshot_id: string; revision: number; observed_at: string; expires_at: string;
  export_policy_revision: string; offset: number; total: number; next_cursor: string | null;
}
export interface ProjectItem { instance_id: string; workspace_id: string; project_id: string; name: string }
export interface ConversationItem { ref: ConversationRef; title?: string; revision: number; activity: ConversationActivity['activity']; content_revision?: number; mode?: 'Chat' | 'Architect' | 'Implement'; provider_error?: ProviderFailure | null }
export type MessageItem = {
  message_id: string; position: number; role: 'user' | 'assistant'; created_at: string;
  completion: 'complete' | 'incomplete' | 'unknown';
} & ReturnType<typeof messageText>;
export interface CapturePage<T> { page: PageMetadata; items: T[] }
type Item = ProjectItem | ConversationItem | MessageItem;
type Operation = 'projects.list' | 'conversations.list' | 'conversation.read';
interface Observation {
  projects: CaptureProject[]; tasks: CaptureTask[]; conversations: DbConversation[];
  transcripts: Array<{ id: string; messages: DbMessage[]; provenMessages: Array<{ id: string; text: string }>; activity: ConversationActivity; nativeToken?: ConversationContentToken }>;
  policy: TextPolicy;
  metadata?: unknown;
}
interface CatalogRows {
  token: ConversationCatalogToken; total: bigint; raw: Conversation[]; visible: DbConversation[]; ticket: symbol;
}
export interface CatalogObservation { revision: number; refs: ConversationRef[]; resources: Record<string, number> }
export interface HostCatalogObservation { projects: number | null; conversations: CatalogObservation | null; error?: unknown }
type ContentObservation = { kind: 'legacy'; hash: string } | { kind: 'native'; source_epoch: string; token: ConversationContentToken };
interface ResourceRevision { revision: number; fingerprint: string; transcript?: string; content?: ContentObservation }
export interface NativeCapturePage extends CapturePage<MessageItem> { responseRevisions: Array<{ id: string; revision: string | null }>; contentToken: ConversationContentToken }
interface NativeCapture {
  token: ConversationContentToken; sourceEpoch: string; query: string; ref: ConversationRef;
  descriptors: ConversationContentDescriptor[];
  positions: Map<string, number>; baseBytes: number;
  pending?: { backward: boolean; positions: number[]; items: ConversationContentItem[]; bytes: number };
  page?: { key: string; result: NativeCapturePage; bytes: number };
}
interface Capture {
  binding: string; revision: number; observed: number; policy: string; items: Item[];
  bytes: number; cursors: Map<string, number>; conversationId?: string; native?: NativeCapture;
}
const MAX_QUOTA = 64 * 1024 * 1024;
const compareId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const id = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new ConversationCaptureError('validation_failed');
  return value;
};
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  if (bytes.length > MAX_QUOTA) throw new ConversationCaptureError('resource_limit');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function checkToken(token: ConversationContentToken): void {
  if (!token || token.version !== 1 || typeof token.incarnation !== 'string' || typeof token.revision !== 'string' || !/^[0-9a-f]{32}$/.test(token.incarnation) || !/^(0|[1-9][0-9]{0,18})$/.test(token.revision) || BigInt(token.revision) > 9223372036854775807n) throw new ConversationCaptureError('unavailable');
}
function decimal(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 19) throw new ConversationCaptureError('unavailable');
  const n = BigInt(value); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConversationCaptureError('resource_limit'); return Number(n);
}
/** One owner per instance. Serializes observations, durable revision CAS and capture
 * allocation. No transport authority is inferred here: the caller authenticates
 * and rechecks access before delivery, and calls clear() on lifecycle changes. */
export class ConversationCaptures {
  private readonly captures = new Map<string, Capture>();
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private sourceEpoch = crypto.randomUUID();
  private reservations = new Map<symbol, number>();
  private operationTickets?: Set<symbol>;
  private catalog?: CatalogRows;
  private catalogGeneration?: string;
  release(snapshotId: string): void { this.captures.delete(snapshotId); }
  get hasNativeContent(): boolean { return this.deps.source.nativeContent !== undefined; }
  constructor(private readonly deps: CaptureDependencies) {
    id(deps.instanceId); id(deps.workspaceId);
    const native = deps.source.nativeContent;
    if (native && ![native.version, native.metadata, native.window].every(port => typeof port === 'function')) throw new ConversationCaptureError('unavailable');
    const catalog = deps.source.nativeCatalog;
    if (catalog !== undefined && (!catalog || ![catalog.version, catalog.page].every(port => typeof port === 'function'))) throw new ConversationCaptureError('unavailable');
  }
  clear(): void { this.epoch++; this.sourceEpoch = crypto.randomUUID(); this.catalog = undefined; this.catalogGeneration = undefined; this.captures.clear(); this.reservations.clear(); }
  projectsList(scope: CaptureScope, continuation?: Continuation, limit = 100): Promise<CapturePage<ProjectItem>> {
    return this.read(scope, 'projects.list', null, continuation, limit) as Promise<CapturePage<ProjectItem>>;
  }
  projectsConditional(scope: CaptureScope, knownRevision: number): Promise<CapturePage<ProjectItem> | { not_modified: true; revision: number; observed_at: string }> {
    return this.read(scope, 'projects.list', null, undefined, 100, knownRevision) as ReturnType<ConversationCaptures['projectsConditional']>;
  }
  conversationsList(scope: CaptureScope, kind: ConversationRef['kind'], continuation?: Continuation, limit = 100): Promise<CapturePage<ConversationItem>> {
    if (kind !== 'implement' && kind !== 'conversation') return Promise.reject(new ConversationCaptureError('validation_failed'));
    return this.read(scope, 'conversations.list', kind, continuation, limit) as Promise<CapturePage<ConversationItem>>;
  }
  conversationRead(scope: CaptureScope, ref: ConversationRef, continuation?: Continuation, limit = 100): Promise<CapturePage<MessageItem>> {
    if (this.hasNativeContent) return this.nativeRead(scope, ref, continuation, limit, false).then(({ page, items }) => ({ page, items }));
    return this.read(scope, 'conversation.read', ref, continuation, limit) as Promise<CapturePage<MessageItem>>;
  }
  validateCached(scope: CaptureScope, operation: Operation, filter: ConversationRef | string | null, snapshotId: string): Promise<void> {
    return this.serial(async () => {
      this.pruneExpiredCaptures();
      const capture = this.captures.get(snapshotId);
      if (!capture) throw new ConversationCaptureError('snapshot_expired');
      if (capture.native) {
        if (operation !== 'conversation.read' || capture.binding !== this.baseBinding(scope, filter as ConversationRef)) throw new ConversationCaptureError('validation_failed');
        try { await this.validateNative(scope, filter as ConversationRef, capture); }
        catch (error) { if (this.captures.get(snapshotId) === capture) this.captures.delete(snapshotId); throw error; }
        return;
      }
      if (capture.binding !== stableJson([scope.accountId, scope.sessionId, scope.instanceId, operation, filter, Boolean(scope.reliability)])) throw new ConversationCaptureError('validation_failed');
      const current = await this.observe(operation === 'projects.list', new Set(operation === 'conversation.read' ? [(filter as ConversationRef).conversation_id] : []));
      const revision = scope.reliability && operation === 'conversation.read' ? current.resources[stableJson(filter)] : current.revision;
      if (capture.revision !== revision) throw new ConversationCaptureError('stale_revision');
      if ((this.deps.now ?? Date.now)() >= capture.observed + 300000) {
        this.captures.delete(snapshotId);
        throw new ConversationCaptureError('snapshot_expired');
      }
    });
  }
  /** Observe after source/policy changes to persist invalidation even without a read.
   * Returns the durable revision for the future content invalidation stream. */
  refresh(): Promise<number> { return this.serial(async () => (await this.observe()).revision); }
  refreshCatalog(): Promise<CatalogObservation> {
    return this.serial(async () => {
      this.pruneExpiredCaptures();
      // Only transcripts delivered to a client can have live cached pages to
      // invalidate. Keep observing their contents until those captures expire.
      const watched = new Set<string>();
      for (const capture of this.captures.values()) {
        if (capture.conversationId) watched.add(capture.conversationId);
      }
      const { observation, revision, resources } = await this.observe(false, watched);
      const refs = observation.conversations.map(conversation => this.reference(conversation, observation)).filter((ref): ref is ConversationRef => ref !== null);
      return { revision, refs, resources };
    });
  }
  /** Observe both host catalogs from the same verified source pair. Reusing
   * persisted rows never replaces fresh source checks in either read. */
  refreshHostCatalogs(): Promise<HostCatalogObservation> {
    return this.serial(async () => {
      const epoch = this.epoch;
      const check = () => { if (epoch !== this.epoch) throw new ConversationCaptureError('unavailable'); };
      this.pruneExpiredCaptures();
      const watched = new Set<string>();
      for (const capture of this.captures.values()) if (capture.conversationId) watched.add(capture.conversationId);
      try {
        const result = await this.observe(false, watched, true); check();
        if (result.projectsRevision === null) throw new ConversationCaptureError('unavailable');
        const refs = result.observation.conversations.map(conversation => this.reference(conversation, result.observation))
          .filter((ref): ref is ConversationRef => ref !== null);
        return { projects: result.projectsRevision, conversations: { revision: result.revision, refs, resources: result.resources } };
      } catch (error) {
        check();
        this.evictCatalog();
        // A failed conversation catalog must not hide an independently valid
        // project change. Partial full observations never publish a catalog.
        let projects: number | null = null;
        try { projects = (await this.observe(true)).revision; } catch { check(); }
        check(); return { projects, conversations: null, error };
      }
    });
  }
  /** Fresh identity/activity validation without hydrating histories. */
  refreshCatalogMetadata(reliability = false): Promise<CatalogObservation> {
    return this.serial(async () => {
      const { observation, revision, resources } = await this.observe(false, new Set());
      const refs = observation.conversations.filter(conversation => reliability || conversation.scope_mode !== 'Architect').map(conversation => this.reference(conversation, observation)).filter((ref): ref is ConversationRef => ref !== null);
      return { revision, refs, resources };
    });
  }
  refreshProjects(): Promise<number> { return this.serial(async () => (await this.observe(true)).revision); }
  /** Management delegates its page to this owner instead of assembling the transcript. */
  conversationWindow(scope: CaptureScope, ref: ConversationRef, continuation?: Continuation, backward = false, messageId?: string): Promise<NativeCapturePage> {
    if (!this.hasNativeContent) return Promise.reject(new ConversationCaptureError('unavailable'));
    return this.nativeRead(scope, ref, continuation, 50, backward, messageId, true);
  }
  private quota(extra = 0): void {
    let used = 0;
    for (const capture of this.captures.values()) used += capture.bytes;
    for (const bytes of this.reservations.values()) used += bytes;
    if (!Number.isSafeInteger(extra) || extra < 0 || used + extra > this.quotaLimit()) throw new ConversationCaptureError('resource_limit');
  }
  private quotaLimit(): number { return Math.min(MAX_QUOTA, this.deps.quotaBytes ?? MAX_QUOTA); }
  private reserve(bytes: number): symbol {
    this.quota(bytes); const ticket = Symbol(); this.reservations.set(ticket, bytes); this.operationTickets?.add(ticket); return ticket;
  }
  private free(ticket: symbol | undefined): void { if (ticket) { this.reservations.delete(ticket); this.operationTickets?.delete(ticket); } }
  private resize(ticket: symbol, bytes: number): void {
    const previous = this.reservations.get(ticket);
    if (previous === undefined) throw new ConversationCaptureError('unavailable');
    this.quota(Math.max(0, bytes - previous)); this.reservations.set(ticket, bytes);
  }
  private hold(value: unknown): symbol | undefined {
    return this.deps.source.nativeCatalog ? this.reserve(captureCost(value, this.quotaLimit()).retained) : undefined;
  }
  private containers(bytes: number): void { if (this.deps.source.nativeCatalog) this.reserve(bytes); }
  private snapshot<T>(value: T): T {
    this.hold(value);
    const temporary = this.hold(value);
    try { return structuredClone(value); } finally { this.free(temporary); }
  }
  private async fingerprint(value: unknown): Promise<string> {
    const ticket = this.deps.source.nativeCatalog ? this.reserve(captureCost(value, this.quotaLimit()).scratch) : undefined;
    try { return await digest(value); } finally { this.free(ticket); }
  }
  private encodedBytes(value: unknown): number {
    const ticket = this.deps.source.nativeCatalog ? this.reserve(captureCost(value, this.quotaLimit()).scratch) : undefined;
    try { return utf8Bytes(JSON.stringify(value)); } finally { this.free(ticket); }
  }
  private releaseSince(before: ReadonlySet<symbol>): void {
    for (const ticket of this.operationTickets ?? []) if (!before.has(ticket)) this.free(ticket);
  }
  private evictCatalog(): void { if (this.catalog) this.free(this.catalog.ticket); this.catalog = undefined; }
  private acceptGeneration(token: ConversationCatalogToken): void {
    if (this.catalogGeneration !== undefined && this.catalogGeneration !== token.generation) { this.clear(); throw new ConversationCaptureError('unavailable'); }
    this.catalogGeneration = token.generation;
  }
  private async catalogCall<T, R>(bytes: number, work: () => Promise<T>, consume: (value: T) => R, check: () => void): Promise<R> {
    const ticket = this.reserve(bytes);
    try { const value = await work(); check(); return consume(value); }
    catch (error) {
      check();
      const code = typeof error === 'string' ? error : error && typeof error === 'object' ? ('code' in error ? error.code : 'message' in error ? error.message : null) : null;
      throw new ConversationCaptureError(code === 'stale_revision' || code === 'resource_limit' ? code : 'unavailable');
    } finally { this.free(ticket); }
  }
  private async catalogRows(check: () => void): Promise<{ rows: CatalogRows; sealed: boolean }> {
    const ports = this.deps.source.nativeCatalog!;
    let token: ConversationCatalogToken | undefined;
    if (this.catalog) {
      token = await this.catalogCall(1024, () => ports.version({ expected_token: null }), value => catalogToken(value), check); check();
      this.acceptGeneration(token);
      if (sameCatalogToken(this.catalog.token, token)) return { rows: this.catalog, sealed: true };
      this.evictCatalog();
    }
    const raw: Conversation[] = []; const ticket = this.reserve(2048);
    let bytes = 2048, seen = 0n, total: bigint | undefined, after: string | null = null;
    do {
      await this.catalogCall(CATALOG_PAGE_BYTES, () => ports.page({ expected_token: token ?? null, after: after === null ? null : { id: after }, limit: 100 }), page => {
        if (captureCost(page, this.quotaLimit()).retained > CATALOG_PAGE_BYTES) throw new ConversationCaptureError('resource_limit');
        this.acceptGeneration(catalogToken(page.token));
        const checked = checkCatalogPage(page, token, after, total, seen);
        this.acceptGeneration(checked.token); token = checked.token; total = checked.total;
        const added = captureCost(page.items, this.quotaLimit()).retained;
        this.resize(ticket, bytes + added); bytes += added;
        for (const row of page.items) raw.push(ownCatalogRow(row));
        seen += BigInt(page.items.length); after = page.next_after?.id ?? null;
      }, check); check();
    } while (after !== null);
    this.resize(ticket, bytes + 64 + raw.length * 64);
    const visible = raw.filter((row): row is DbConversation => row.scope_mode === 'Chat' || row.scope_mode === 'Architect' || row.scope_mode === 'Implement')
      .sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || b.updated_at.localeCompare(a.updated_at) || compareId(a, b));
    Object.freeze(raw); Object.freeze(visible);
    return { rows: { token: token!, total: total!, raw, visible, ticket }, sealed: false };
  }
  private charge(capture: Capture): void {
    const native = capture.native!;
    capture.bytes = native.baseBytes + (native.pending?.bytes ?? 0) + (native.page?.bytes ?? 0) + capture.cursors.size * 128;
    this.quota();
  }
  private async nativeCall<T>(work: () => Promise<T>, check: () => void): Promise<T> {
    const epoch = this.epoch; const reservation = Symbol();
    this.quota(4 * 1024 * 1024); this.reservations.set(reservation, 4 * 1024 * 1024);
    try {
      const value = await work();
      if (epoch !== this.epoch) throw new ConversationCaptureError('unavailable');
      check();
      if (this.encodedBytes(value) > 4 * 1024 * 1024) throw new ConversationCaptureError('resource_limit');
      this.hold(value);
      return value;
    } finally { this.reservations.delete(reservation); }
  }
  private baseBinding(scope: CaptureScope, ref: ConversationRef): string {
    return stableJson([scope.accountId, scope.sessionId, scope.instanceId, 'conversation.read', ref, Boolean(scope.reliability)]);
  }
  private async validateNative(scope: CaptureScope, ref: ConversationRef, capture: Capture): Promise<Observation> {
    const epoch = this.epoch; const native = capture.native!;
    const check = () => {
      if (epoch !== this.epoch || native.sourceEpoch !== this.sourceEpoch) throw new ConversationCaptureError('unavailable');
      if (capture.binding !== this.baseBinding(scope, ref)) throw new ConversationCaptureError('validation_failed');
      if ((this.deps.now ?? Date.now)() >= capture.observed + 300000) throw new ConversationCaptureError('snapshot_expired');
    };
    check();
    try {
      const current = await this.observe(false, new Set([ref.conversation_id])); check();
      const revision = scope.reliability ? current.resources[stableJson(ref)] : current.revision;
      if (revision !== capture.revision) throw new ConversationCaptureError('stale_revision');
      const token = await this.deps.source.nativeContent!.version(ref.conversation_id); check(); checkToken(token);
      if (stableJson(token) !== stableJson(native.token)) throw new ConversationCaptureError('stale_revision');
      return current.observation;
    } catch (error) {
      const code = typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? error.message : null;
      if (code === 'not_found') throw new ConversationCaptureError('stale_revision');
      throw error;
    }
  }
  private nativeRead(scope: CaptureScope, ref: ConversationRef, continuation: Continuation | undefined, limit: number, backward: boolean, messageId?: string, management = false, attempt = 0, openingDeadline?: number): Promise<NativeCapturePage> {
    const deadlineAt = openingDeadline ?? (this.deps.now ?? Date.now)() + 10000;
    return this.serial(async () => {
      id(scope.accountId); id(scope.sessionId); id(ref.conversation_id);
      if (scope.instanceId !== this.deps.instanceId || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConversationCaptureError('validation_failed');
      if (messageId) id(messageId);
      this.pruneExpiredCaptures();
      const epoch = this.epoch; const now = (this.deps.now ?? Date.now)(); const deadline = deadlineAt;
      const check = () => { if (epoch !== this.epoch) throw new ConversationCaptureError('unavailable'); if ((this.deps.now ?? Date.now)() >= deadline) throw new ConversationCaptureError('content_unavailable'); };
      const ports = this.deps.source.nativeContent!;
      const query = stableJson([management, backward, messageId ?? null]);
      let snapshotId = continuation?.snapshot_id;
      let capture = snapshotId ? this.captures.get(snapshotId) : undefined;
      let pageReservation: symbol | undefined; let ownsCapture = false;
      try {
        let offset = 0; let observation: Observation;
        if (continuation) {
          if (!capture?.native) throw new ConversationCaptureError('snapshot_expired');
          if (capture.native.query !== query || capture.binding !== this.baseBinding(scope, ref) || !capture.cursors.has(continuation.cursor)) throw new ConversationCaptureError('validation_failed');
          ownsCapture = true; offset = capture.cursors.get(continuation.cursor)!;
          observation = await this.validateNative(scope, ref, capture); check();
        } else {
          const current = await this.observe(false, new Set([ref.conversation_id])); check(); observation = current.observation;
          const conversation = observation.conversations.find(c => c.id === ref.conversation_id);
          if (!conversation || (!scope.reliability && conversation.scope_mode === 'Architect') || stableJson(this.reference(conversation, observation)) !== stableJson(ref)) throw new ConversationCaptureError('not_found');
          const token = observation.transcripts.find(t => t.id === ref.conversation_id)!.nativeToken!;
          snapshotId = crypto.randomUUID();
          capture = { binding: this.baseBinding(scope, ref), revision: scope.reliability ? current.resources[stableJson(ref)] : current.revision, observed: now, policy: observation.policy.revision, items: [], bytes: 2048, cursors: new Map(), conversationId: ref.conversation_id,
            native: { token, sourceEpoch: this.sourceEpoch, query, ref, descriptors: [], positions: new Map(), baseBytes: 2048 } };
          this.quota(capture.bytes); this.captures.set(snapshotId, capture); ownsCapture = true;
          const native = capture.native!; const seen = new Set<string>();
          let after: ConversationContentMetadataInput['after'] = null; let raw = 0; let exported = 0;
          do {
            const page = await this.nativeCall(() => ports.metadata({ conversation_id: ref.conversation_id, expected_token: token, after, limit: 100 }), check); check();
            if (stableJson(page.token) !== stableJson(token) || page.items.length > 100 || (!page.items.length && page.next_after)) throw new ConversationCaptureError('unavailable');
            if (!after) { if (!page.opening || page.opening.conversation.id !== ref.conversation_id) throw new ConversationCaptureError('unavailable'); raw = decimal(page.opening.total_raw); exported = decimal(page.opening.total_exportable); }
            else if (page.opening) throw new ConversationCaptureError('unavailable');
            for (const descriptor of page.items) {
              id(descriptor.id);
              if (descriptor.conversation_id !== ref.conversation_id || typeof descriptor.role !== 'string' || !Number.isFinite(Date.parse(descriptor.created_at)) || seen.has(descriptor.id) || controlledText(descriptor.id, observation.policy).content_state !== 'complete') throw new ConversationCaptureError('content_unavailable');
              if (after && (descriptor.created_at < after.created_at || (descriptor.created_at === after.created_at && descriptor.id <= after.id))) throw new ConversationCaptureError('unavailable');
              const bytes = this.deps.source.nativeCatalog ? captureCost(descriptor, this.quotaLimit()).retained + 192 : this.encodedBytes(descriptor) + 192;
              this.quota(bytes);
              seen.add(descriptor.id); native.descriptors.push(descriptor); native.baseBytes += bytes;
            }
            if (page.next_after) { const last = page.items.at(-1)!; if (last.id !== page.next_after.id || last.created_at !== page.next_after.created_at) throw new ConversationCaptureError('unavailable'); }
            this.charge(capture); after = page.next_after;
          } while (after);
          if (native.descriptors.length !== raw) throw new ConversationCaptureError('unavailable');
          this.containers(128 + native.descriptors.length * 64);
          const descriptors = native.descriptors.filter(d => d.role === 'user' || d.role === 'assistant');
          if (descriptors.length !== exported) throw new ConversationCaptureError('unavailable');
          this.quota(descriptors.length * 16);
          descriptors.sort((a,b) => a.created_at.localeCompare(b.created_at) || compareId(a,b));
          native.descriptors = descriptors; descriptors.forEach((d, position) => native.positions.set(d.id, position));
          native.baseBytes = 2048 + utf8Bytes(capture.binding) + (this.deps.source.nativeCatalog ? captureCost(descriptors, this.quotaLimit()).retained : this.encodedBytes(descriptors)) + descriptors.length * 192;
          this.charge(capture); observation = await this.validateNative(scope, ref, capture); check();
          offset = backward ? descriptors.length : 0;
        }
        const native = capture!.native!; const total = native.descriptors.length;
        const pageKey = stableJson([offset, limit, backward, !continuation ? messageId ?? null : null]);
        if (native.page?.key === pageKey) { await this.validateNative(scope, ref, capture!); check(); return this.snapshot(native.page.result); }
        // Only the current rendered page is owned here; the host accounts for
        // any response it retains independently. Old cursor boundaries survive.
        native.page = undefined; this.charge(capture!);
        let positions: number[];
        if (!continuation && messageId) {
          const anchor = native.positions.get(messageId); if (anchor === undefined) throw new ConversationCaptureError('not_found');
          const context = Array.from({length:5},(_,i)=>anchor + (backward ? i+1 : -i-1)).filter(p=>p>=0&&p<total);
          positions = [anchor, ...context];
          for (let p = anchor + (backward ? -1 : 1); positions.length < limit && p >= 0 && p < total; p += backward ? -1 : 1) positions.push(p);
          positions = positions.slice(0,limit);
        } else {
          positions = Array.from({length:Math.min(limit,backward?offset:total-offset)},(_,i)=>backward?offset-i-1:offset+i);
        }
        pageReservation = Symbol(); this.quota(256 * 1024); this.reservations.set(pageReservation, 256 * 1024);
        const rendered: MessageItem[] = []; const responseRevisions: NativeCapturePage['responseRevisions'] = [];
        let publicBytes = 4096; let consumed = 0;
        while (consumed < positions.length) {
          check();
          const position = positions[consumed];
          if (native.pending && (native.pending.backward !== backward || native.pending.positions[0] !== position)) { native.pending = undefined; this.charge(capture!); }
          if (!native.pending) {
            const wanted = positions.slice(consumed); const ids = wanted.map(p=>native.descriptors[p].id);
            const batch = await this.nativeCall(()=>ports.window({ conversation_id: ref.conversation_id, expected_token: native.token, ids }), check); check();
            if (stableJson(batch.token) !== stableJson(native.token) || batch.consumed_count < 1 || batch.consumed_count > ids.length || batch.items.length !== batch.consumed_count) throw new ConversationCaptureError('unavailable');
            for (const [i,item] of batch.items.entries()) {
              const descriptor = native.descriptors[wanted[i]];
              if (item.id !== descriptor.id || item.conversation_id !== ref.conversation_id || item.role !== descriptor.role || item.created_at !== descriptor.created_at) throw new ConversationCaptureError('unavailable');
            }
            const pendingBytes = (this.deps.source.nativeCatalog ? captureCost(batch, this.quotaLimit()).retained : this.encodedBytes(batch)) + 64 * batch.items.length;
            this.quota(pendingBytes);
            native.pending = { backward, positions: wanted.slice(0,batch.consumed_count), items: batch.items, bytes: pendingBytes };
            if (native.pending.bytes > 4 * 1024 * 1024) throw new ConversationCaptureError('resource_limit'); this.charge(capture!);
          }
          const raw = native.pending.items[0];
          const activity = observation.transcripts.find(t=>t.id===ref.conversation_id)!.activity;
          const generating = raw.role === 'assistant' && activity.activity === 'busy' && (activity.generatingMessageId === null || activity.generatingMessageId === raw.id);
          const attested = await projectFinalProvenance(raw.id, raw.content, raw.provenance_json); check();
          const text = messageText(raw, generating, observation.policy, attested);
          const item: MessageItem = { message_id: raw.id, position, role: raw.role as 'user'|'assistant', created_at: new Date(raw.created_at).toISOString(), completion: generating ? 'unknown' : raw.role === 'user' ? 'complete' : completion(raw.completion_reason), ...text };
          const size = this.encodedBytes(item) + 1;
          if (publicBytes + size > 240 * 1024) { if (!rendered.length) throw new ConversationCaptureError('resource_limit'); break; }
          rendered.push(item); publicBytes += size;
          if (management && item.role === 'assistant' && item.completion === 'complete' && 'text' in item) responseRevisions.push({ id: raw.id, revision: raw.response_revision_decimal });
          native.pending.items.shift(); native.pending.positions.shift();
          if (!native.pending.items.length) native.pending = undefined;
          else native.pending.bytes = (this.deps.source.nativeCatalog ? captureCost(native.pending.items, this.quotaLimit()).retained : this.encodedBytes(native.pending.items)) + 64 * native.pending.items.length;
          consumed++; this.charge(capture!);
        }
        rendered.sort((a,b)=>a.position-b.position);
        const start = rendered[0]?.position ?? offset;
        const end = rendered.at(-1) ? rendered.at(-1)!.position + 1 : offset;
        const next = backward ? start : end;
        let cursor: string | null = null;
        if (backward ? next > 0 : next < total) {
          for (const [key, position] of capture!.cursors) if (position === next) { cursor = key; break; }
          if (!cursor) { this.quota(128); cursor = crypto.randomUUID(); capture!.cursors.set(cursor,next); }
        }
        const result: NativeCapturePage = { page: { snapshot_id: snapshotId!, revision: capture!.revision, observed_at: new Date(capture!.observed).toISOString(), expires_at: new Date(capture!.observed+300000).toISOString(), export_policy_revision: capture!.policy, offset: start, total, next_cursor: cursor, ...(backward ? {direction:'backward'} : {}) }, items: rendered, responseRevisions, contentToken: native.token };
        const resultBytes = (this.deps.source.nativeCatalog ? captureCost(result, this.quotaLimit()).retained : this.encodedBytes(result)) + 2048;
        this.quota(resultBytes);
        native.page = { key: pageKey, result, bytes: resultBytes }; this.charge(capture!);
        await this.validateNative(scope, ref, capture!); check(); return this.snapshot(result);
      } catch (error) {
        // An obsolete completion must never destroy captures of a new epoch.
        if (ownsCapture && snapshotId && this.captures.get(snapshotId) === capture) this.captures.delete(snapshotId);
        throw error;
      } finally { if (pageReservation) this.reservations.delete(pageReservation); }
    }).catch(error => {
      if (!continuation && attempt === 0 && error instanceof ConversationCaptureError && error.code === 'stale_revision') return this.nativeRead(scope, ref, undefined, limit, backward, messageId, management, 1, deadlineAt);
      throw error;
    });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const result = this.tail.then(async () => {
      if (epoch !== this.epoch) throw new ConversationCaptureError('unavailable');
      const tickets = new Set<symbol>(); this.operationTickets = tickets;
      try {
        const value = await work();
        if (epoch !== this.epoch) throw new ConversationCaptureError('unavailable');
        return value;
      } catch (error) {
        if (error instanceof ConversationCaptureError) throw error;
        const code = error && typeof error === 'object' && 'message' in error ? error.message : null;
        if (typeof code === 'string' && ['unavailable','content_unavailable','not_found','validation_failed','snapshot_expired','stale_revision','resource_limit'].includes(code)) throw new ConversationCaptureError(code as CaptureErrorCode);
        throw new ConversationCaptureError('unavailable');
      } finally {
        for (const ticket of tickets) this.free(ticket);
        if (this.operationTickets === tickets) this.operationTickets = undefined;
      }
    });
    this.tail = result.catch(() => undefined); return result;
  }
  private pruneExpiredCaptures(): void {
    const now = (this.deps.now ?? Date.now)();
    for (const [key, capture] of this.captures) {
      if (now >= capture.observed + 300000) this.captures.delete(key);
    }
  }
  private async load(projectsOnly = false, deadline = Infinity, transcriptIds?: ReadonlySet<string>): Promise<{ observation: Observation; catalogToken?: ConversationCatalogToken }> {
    const epoch = this.epoch;
    const check = () => {
      if (epoch !== this.epoch) throw new ConversationCaptureError('unavailable');
      if ((this.deps.now ?? Date.now)() >= deadline) throw new ConversationCaptureError('content_unavailable');
    };
    const source = this.deps.source;
    const policy = this.snapshot(this.deps.policy());
    if (policy.revision !== 'visible-1') throw new ConversationCaptureError('unavailable');
    for (const value of [this.deps.instanceId, this.deps.workspaceId]) {
      if (controlledText(value, policy).content_state !== 'complete') throw new ConversationCaptureError('content_unavailable');
    }
    const projectRows = await source.projects(); check(); this.hold(projectRows);
    this.containers(256 + projectRows.length * 256);
    const projects = projectRows.map(p => ({ id: id(p.id), name: p.name })).sort(compareId);
    if (new Set(projects.map(p => p.id)).size !== projects.length || projects.some(p => controlledText(p.id, policy).content_state !== 'complete')) throw new ConversationCaptureError('content_unavailable');
    if (projectsOnly) return { observation: { projects, tasks: [], conversations: [], transcripts: [], policy } };
    const taskRows = await source.tasks(); check(); this.hold(taskRows);
    this.containers(256 + taskRows.length * 512);
    const tasks = taskRows.map(t => ({ id: t.id, project_id: t.project_id, conversation_id: t.conversation_id })).sort(compareId);
    const wireTaskIds = tasks.map(task => id(pilotTaskId(task.id)));
    if (new Set(wireTaskIds).size !== tasks.length) throw new ConversationCaptureError('content_unavailable');
    const catalog = source.nativeCatalog ? await this.catalogRows(check) : undefined; check();
    const conversations = catalog ? catalog.rows.visible : (await source.listConversations()).slice().filter(c => c.scope_mode === 'Chat' || c.scope_mode === 'Architect' || c.scope_mode === 'Implement')
      .sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || b.updated_at.localeCompare(a.updated_at) || compareId(a, b));
    check(); this.hold(conversations);
    for (const rows of [projects, tasks, conversations]) for (const row of rows) {
      if (controlledText(row.id, policy).content_state !== 'complete') throw new ConversationCaptureError('content_unavailable');
    }
    const transcripts: Observation['transcripts'] = [];
    const temporary = source.nativeCatalog ? this.reserve(256 + conversations.length * 64) : undefined;
    if (source.nativeCatalog) this.reserve(256 + conversations.length * 128);
    const seen = new Set<string>();
    let bytes = source.nativeCatalog ? 0 : utf8Bytes(JSON.stringify([projects, tasks, conversations, policy]));
    if (bytes > MAX_QUOTA) throw new ConversationCaptureError('resource_limit');
    try {
      for (const conversation of conversations) {
        check(); id(conversation.id);
        if (seen.has(conversation.id)) throw new ConversationCaptureError('content_unavailable');
        seen.add(conversation.id);
        const currentActivity = (source.runtimeActivity ?? source.activity)(conversation.id);
        const activity = source.nativeCatalog ? this.snapshot(currentActivity) : currentActivity;
        if (transcriptIds !== undefined && !transcriptIds.has(conversation.id)) {
          transcripts.push({ id: conversation.id, messages: [], provenMessages: [], activity });
          continue;
        }
        if (source.nativeContent) {
          const nativeToken = await source.nativeContent.version(conversation.id); check(); checkToken(nativeToken); this.hold(nativeToken);
          transcripts.push({ id: conversation.id, messages: [], provenMessages: [], activity, nativeToken: source.nativeCatalog ? structuredClone(nativeToken) : nativeToken });
          continue;
        }
        const messageRows = await source.listMessages(conversation.id); check(); this.hold(messageRows);
        this.containers(256 + messageRows.length * 256);
        const messages = messageRows.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || compareId(a, b));
        const messageIds = new Set<string>(); const provenMessages: Array<{ id: string; text: string }> = [];
        for (const message of messages) {
          id(message.id);
          if (controlledText(message.id, policy).content_state !== 'complete') throw new ConversationCaptureError('content_unavailable');
          if (message.conversation_id !== conversation.id || messageIds.has(message.id) || !Number.isFinite(Date.parse(message.created_at))) throw new ConversationCaptureError('content_unavailable');
          messageIds.add(message.id);
          if (message.role === 'assistant') {
            const text = await source.finalProvenance?.(message); check();
            if (typeof text === 'string') { this.hold(text); this.containers(128); provenMessages.push({ id: message.id, text }); }
          }
        }
        if (!source.nativeCatalog) {
          bytes += utf8Bytes(JSON.stringify([messages, activity]));
          if (bytes > MAX_QUOTA) throw new ConversationCaptureError('resource_limit');
        }
        transcripts.push({ id: conversation.id, messages: source.nativeCatalog ? this.snapshot(messages) : messages, provenMessages, activity });
      }
      const metadata = !source.nativeContent && source.catalogMetadata ? await source.catalogMetadata() : undefined; check();
      const observation: Observation = { projects, tasks, conversations, transcripts, policy, ...(!source.nativeContent && source.catalogMetadata ? { metadata: source.nativeCatalog ? this.snapshot(metadata) : metadata } : {}) };
      if (!catalog) return { observation: source.nativeCatalog ? observation : structuredClone(observation) };
      if (!catalog.sealed) {
        await this.catalogCall(1024, () => source.nativeCatalog!.version({ expected_token: catalog.rows.token }), value => {
          const token = catalogToken(value); this.acceptGeneration(token);
          if (!sameCatalogToken(token, catalog.rows.token)) throw new ConversationCaptureError('unavailable');
        }, check); check();
        this.catalog = catalog.rows;
        this.operationTickets?.delete(catalog.rows.ticket);
      }
      return { observation, catalogToken: catalog.rows.token };
    } finally { this.free(temporary); }
  }
  private async observe(projectsOnly = false, transcriptIds?: ReadonlySet<string>, includeProjects = false): Promise<{ observation: Observation; revision: number; resources: Record<string, number>; projectsRevision: number | null }> {
    // Bound complete catalog inspection, including both observations and retry.
    const epoch = this.epoch; const sourceEpoch = this.sourceEpoch;
    const deadline = (this.deps.now ?? Date.now)() + 10_000;
    const guard = () => {
      if (epoch !== this.epoch) throw new ConversationCaptureError('unavailable');
      if ((this.deps.now ?? Date.now)() >= deadline) throw new ConversationCaptureError('content_unavailable');
    };
    // Independent reads detect edits during assembly; retry once, never mix pages.
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = new Set(this.operationTickets); const live = new Set<symbol>(); let kept = false;
      try {
      const previous = await this.deps.storage.load(); guard(); this.hold(previous);
      const beforeLoad = new Set(this.operationTickets);
      const first = await this.load(projectsOnly, deadline, transcriptIds); guard();
      const observation = first.observation;
      for (const ticket of this.operationTickets ?? []) if (!beforeLoad.has(ticket)) live.add(ticket);
      if (this.hasNativeContent && !this.deps.source.nativeCatalog) this.quota(2 * utf8Bytes(JSON.stringify(observation)) + (previous === null ? 0 : utf8Bytes(previous)));
      const fingerprint = await this.fingerprint(observation); guard();
      const beforeSecond = new Set(this.operationTickets);
      let matches = false;
      try {
        const second = await this.load(projectsOnly, deadline, transcriptIds); guard();
        const secondFingerprint = await this.fingerprint(second.observation); guard();
        matches = fingerprint === secondFingerprint && (!first.catalogToken || Boolean(second.catalogToken && sameCatalogToken(first.catalogToken, second.catalogToken)));
      } finally { this.releaseSince(beforeSecond); }
      if (!matches) { this.evictCatalog(); continue; }
      type Revision = { revision: number; fingerprint: string };
      type Journal = { version: number; resources?: Record<string, ResourceRevision>; projects?: Revision; conversations?: Revision; catalog?: string; transcripts?: Record<string, string> };
      if (previous !== null && this.deps.source.nativeCatalog) this.reserve(parsedCaptureCost(previous, this.quotaLimit()));
      const journal: Journal = previous === null ? { version: 4 } : JSON.parse(previous);
      if (!journal || ![2, 3, 4].includes(journal.version)) throw new ConversationCaptureError('unavailable');
      for (const clock of [journal.projects, journal.conversations]) if (clock && (!Number.isSafeInteger(clock.revision) || clock.revision < 1 || typeof clock.fingerprint !== 'string')) throw new ConversationCaptureError('unavailable');
      if (journal.catalog !== undefined && typeof journal.catalog !== 'string') throw new ConversationCaptureError('unavailable');
      if (journal.transcripts !== undefined && (!journal.transcripts || typeof journal.transcripts !== 'object' || Array.isArray(journal.transcripts) || Object.values(journal.transcripts).some(v => typeof v !== 'string'))) throw new ConversationCaptureError('unavailable');
      if (journal.resources !== undefined && (!journal.resources || typeof journal.resources !== 'object' || Array.isArray(journal.resources))) throw new ConversationCaptureError('unavailable');
      this.hold(journal.resources);
      const records: Record<string, ResourceRevision> = { ...journal.resources };
      for (const record of Object.values(records)) {
        if (!record || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.fingerprint !== 'string' || (record.transcript !== undefined && typeof record.transcript !== 'string')) throw new ConversationCaptureError('unavailable');
        if (record.content !== undefined) {
          if (!record.content || typeof record.content !== 'object' || Array.isArray(record.content)) throw new ConversationCaptureError('unavailable');
          if (record.content.kind === 'native') { if (typeof record.content.source_epoch !== 'string' || !record.content.source_epoch) throw new ConversationCaptureError('unavailable'); checkToken(record.content.token); }
          else if (record.content.kind !== 'legacy' || typeof record.content.hash !== 'string') throw new ConversationCaptureError('unavailable');
        }
      }
      let projectsRevision: number | null = null;
      if (includeProjects && !projectsOnly) {
        // Match load(true) exactly, including policy, without another source read.
        const projectFingerprint = await this.fingerprint({ projects: observation.projects, tasks: [], conversations: [], transcripts: [], policy: observation.policy }); guard();
        const oldProjects = journal.projects;
        projectsRevision = oldProjects ? oldProjects.revision + Number(oldProjects.fingerprint !== projectFingerprint) : 1;
        if (!Number.isSafeInteger(projectsRevision)) throw new ConversationCaptureError('resource_limit');
        journal.projects = { revision: projectsRevision, fingerprint: projectFingerprint };
      }
      const section = projectsOnly ? 'projects' : 'conversations';
      const old = journal[section];
      let changed = old?.fingerprint !== fingerprint;
      const changedKeys = new Set<string>();
      if (!projectsOnly) {
        if (this.deps.source.nativeCatalog) this.reserve(1024 + observation.conversations.length * 256 + observation.transcripts.length * 256);
        const catalog = await this.fingerprint({ ...observation, transcripts: observation.transcripts.map(t => ({ id: t.id, activity: t.activity })) }); guard();
        changed = journal.catalog === undefined ? old !== undefined : journal.catalog !== catalog;
        this.hold(journal.transcripts);
        const fingerprints = { ...journal.transcripts };
        const present = new Set<string>();
        const presentIds = new Set(observation.conversations.map(c => c.id));
        for (const conversation of observation.conversations) {
          const ref = this.reference(conversation, observation); if (!ref) continue;
          const key = stableJson(ref); present.add(key);
          const transcript = observation.transcripts.find(t => t.id === conversation.id)!;
          const resourceFingerprint = await this.fingerprint([conversation, ref, transcript.activity, observation.policy, ...(this.hasNativeContent ? [observation.projects, observation.tasks] : [])]); guard();
          const record = records[key];
          const visited = transcriptIds === undefined || transcriptIds.has(conversation.id);
          let content = record?.content;
          let hash = record?.transcript;
          if (visited) {
            if (transcript.nativeToken) content = { kind: 'native', source_epoch: sourceEpoch, token: transcript.nativeToken };
            else { hash = await this.fingerprint(transcript); guard(); content = { kind: 'legacy', hash }; }
            if (hash) Object.defineProperty(fingerprints, transcript.id, { value: hash, enumerable: true, configurable: true });
          }
          // Preserve unvisited content verbatim. A first native observation is a
          // representation change even when an old hash looks token-shaped.
          const contentChanged = visited && (transcript.nativeToken ? stableJson(record?.content) !== stableJson(content) : (record?.content?.kind === 'native' || (record?.transcript !== undefined && record.transcript !== hash)));
          if (!record || record.fingerprint !== resourceFingerprint || contentChanged) changedKeys.add(key);
          this.hold([key, content, hash, resourceFingerprint]);
          records[key] = { revision: record?.revision ?? 1, fingerprint: resourceFingerprint, ...(hash ? { transcript: hash } : {}), ...(content ? { content } : {}) };
        }
        for (const key of Object.keys(records)) if (!present.has(key)) { delete records[key]; changed = true; }
        for (const key of Object.keys(fingerprints)) if (!presentIds.has(key)) { delete fingerprints[key]; changed = true; }
        changed ||= changedKeys.size > 0;
        journal.catalog = catalog; journal.transcripts = fingerprints;
      }
      const floor = projectsOnly ? old?.revision ?? 0 : Object.values(journal.resources ?? {}).reduce((floor, record) => Math.max(floor, record.revision), old?.revision ?? 0);
      const revision = old ? floor + (changed || floor > old.revision ? 1 : 0) : floor + 1;
      if (!Number.isSafeInteger(revision)) throw new ConversationCaptureError('resource_limit');
      const resources: Record<string, number> = Object.create(null);
      if (!projectsOnly) {
        for (const [key, record] of Object.entries(records)) { if (changedKeys.has(key)) record.revision = revision; resources[key] = record.revision; }
        journal.resources = records;
      }
      journal.version = 4; journal[section] = { revision, fingerprint };
      if (this.deps.source.nativeCatalog) this.reserve(captureCost(journal, this.quotaLimit()).scratch);
      const resultTicket = this.hold(resources);
      const next = JSON.stringify(journal);
      if (utf8Bytes(next) > MAX_QUOTA) throw new ConversationCaptureError('resource_limit');
      guard();
      if (!await this.deps.storage.compareAndSwap(previous, next)) { guard(); this.evictCatalog(); continue; }
      guard();
      if (resultTicket) live.add(resultTicket);
      kept = true;
      return { observation, revision, resources, projectsRevision };
      } catch (error) {
        this.evictCatalog();
        guard();
        if (!(error instanceof ConversationCaptureError) || error.code !== 'stale_revision') throw error;
      } finally {
        for (const ticket of this.operationTickets ?? []) if (!before.has(ticket) && (!kept || !live.has(ticket))) this.free(ticket);
      }
    }
    throw new ConversationCaptureError('content_unavailable');
  }
  private reference(conversation: DbConversation, observation: Observation): ConversationRef | null {
    if (conversation.scope_mode === 'Chat' || conversation.scope_mode === 'Architect') return { instance_id: this.deps.instanceId, kind: 'conversation', conversation_id: conversation.id };
    const candidates = observation.tasks.filter(t =>
      (t.id === conversation.task_id || t.conversation_id === conversation.id) &&
      (!conversation.project_id || conversation.project_id === t.project_id) &&
      (!t.conversation_id || t.conversation_id === conversation.id));
    const task = candidates.length === 1 ? candidates[0] : undefined;
    if (!task || !observation.projects.some(p => p.id === task.project_id) ||
      (conversation.project_id && conversation.project_id !== task.project_id) || (task.conversation_id && task.conversation_id !== conversation.id)) return null;
    return { instance_id: this.deps.instanceId, kind: 'implement', workspace_id: this.deps.workspaceId, task_id: pilotTaskId(task.id), conversation_id: conversation.id };
  }
  private read(scope: CaptureScope, operation: Operation, filter: ConversationRef | string | null, continuation: Continuation | undefined, limit: number, knownRevision?: number): Promise<CapturePage<Item> | { not_modified: true; revision: number; observed_at: string }> {
    return this.serial(async () => {
      const epoch = this.epoch, deadline = (this.deps.now ?? Date.now)() + 10000;
      const check = () => { if (epoch !== this.epoch) throw new ConversationCaptureError('unavailable'); if ((this.deps.now ?? Date.now)() >= deadline) throw new ConversationCaptureError('content_unavailable'); };
      id(scope.accountId); id(scope.sessionId);
      if (scope.instanceId !== this.deps.instanceId || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConversationCaptureError('validation_failed');
      const binding = stableJson([scope.accountId, scope.sessionId, scope.instanceId, operation, filter, Boolean(scope.reliability)]);
      const now = (this.deps.now ?? Date.now)();
      this.pruneExpiredCaptures();
      let snapshotId = continuation?.snapshot_id;
      let capture = snapshotId ? this.captures.get(snapshotId) : undefined;
      let captureTicket: symbol | undefined;
      let offset = 0;
      if (continuation) {
        if (!capture) throw new ConversationCaptureError('snapshot_expired');
        if (capture.binding !== binding || !capture.cursors.has(continuation.cursor)) throw new ConversationCaptureError('validation_failed');
        offset = capture.cursors.get(continuation.cursor)!;
      }
      const { observation, revision: catalogRevision, resources } = await this.observe(operation === 'projects.list', new Set(operation === 'conversation.read' ? [(filter as ConversationRef).conversation_id] : [])); check();
      const revision = scope.reliability && operation === 'conversation.read' ? resources[stableJson(filter)] : catalogRevision;
      if (capture && capture.revision !== revision) throw new ConversationCaptureError('stale_revision');
      if (knownRevision !== undefined && scope.reliability && knownRevision === revision) return { not_modified: true, revision, observed_at: new Date(now).toISOString() };
      if (!capture) {
        if (this.deps.source.nativeCatalog) this.reserve(1024 + captureCost(operation === 'projects.list' ? observation.projects : operation === 'conversations.list' ? observation.conversations : observation.transcripts, this.quotaLimit()).scratch);
        let items: Item[] = [];
        if (operation === 'projects.list') {
          items = observation.projects.map(project => {
            const item: ProjectItem = { instance_id: scope.instanceId, workspace_id: this.deps.workspaceId, project_id: project.id, name: 'Project' };
            const name = controlledText(project.name, observation.policy); if ('text' in name) item.name = Array.from(name.text).slice(0, 120).join('');
            return item;
          });
        } else if (operation === 'conversations.list') {
          for (const conversation of observation.conversations) {
            const ref = this.reference(conversation, observation); if (!ref || ref.kind !== filter || (!scope.reliability && conversation.scope_mode === 'Architect')) continue;
            const item: ConversationItem = { ref, revision, activity: observation.transcripts.find(t => t.id === conversation.id)!.activity.activity };
            if (scope.reliability) {
              item.content_revision = resources[stableJson(ref)]; item.mode = conversation.scope_mode as ConversationItem['mode'];
              item.provider_error = observation.transcripts.find(t => t.id === conversation.id)!.activity.providerFailure ?? null;
            }
            const title = controlledText(conversation.title, observation.policy); if ('text' in title) item.title = title.text;
            items.push(item);
          }
        } else {
          const ref = filter as ConversationRef;
          const conversation = observation.conversations.find(c => c.id === ref?.conversation_id);
          if (!conversation || (!scope.reliability && conversation.scope_mode === 'Architect') || stableJson(this.reference(conversation, observation)) !== stableJson(ref)) throw new ConversationCaptureError('not_found');
          const persisted = await this.deps.source.getConversation(conversation.id); check(); this.hold(persisted);
          if (stableJson(persisted) !== stableJson(conversation)) throw new ConversationCaptureError('stale_revision');
          const transcript = observation.transcripts.find(t => t.id === conversation.id)!;
          items = transcript.messages.filter(m => m.role === 'user' || m.role === 'assistant').map((message, position) => {
            const generating = message.role === 'assistant' && transcript.activity.activity === 'busy' &&
              (transcript.activity.generatingMessageId === null || transcript.activity.generatingMessageId === message.id);
            const text = messageText(message, generating, observation.policy, transcript.provenMessages.find(proof => proof.id === message.id)?.text);
            const base = { message_id: message.id, position, role: message.role as 'user' | 'assistant', created_at: new Date(message.created_at).toISOString(),
              completion: generating ? 'unknown' as const : message.role === 'user' ? 'complete' as const : completion(message.completion_reason) };
            if ('text' in text) return { message_id: base.message_id, position, role: base.role, created_at: base.created_at, completion: base.completion, content_state: text.content_state, text: text.text };
            return { message_id: base.message_id, position, role: base.role, created_at: base.created_at, completion: base.completion, content_state: text.content_state, reason: text.reason };
          });
        }
        if (this.deps.source.nativeCatalog) this.reserve(captureCost(items, this.quotaLimit()).scratch);
        const bytes = (this.deps.source.nativeCatalog ? captureCost(items, this.quotaLimit()).retained : utf8Bytes(JSON.stringify(items))) + 2048;
        captureTicket = this.reserve(bytes);
        snapshotId = crypto.randomUUID();
        capture = { binding, revision, observed: now, policy: observation.policy.revision, items: structuredClone(items), bytes, cursors: new Map() };
        if (operation === 'conversation.read') capture.conversationId = (filter as ConversationRef).conversation_id;
      }
      if ((this.deps.now ?? Date.now)() >= capture.observed + 300000) { this.captures.delete(snapshotId!); throw new ConversationCaptureError('snapshot_expired'); }
      const pageItems: Item[] = []; let bytes = 4096;
      for (const item of capture.items.slice(offset, offset + limit)) {
        const size = this.encodedBytes(item) + 1;
        // Reserve 16 KiB for future response/transport envelopes.
        if (bytes + size > 240 * 1024) break;
        pageItems.push(item); bytes += size;
      }
      if (!pageItems.length && offset < capture.items.length) throw new ConversationCaptureError('resource_limit');
      const nextOffset = offset + pageItems.length;
      let cursor: string | null = null;
      if (nextOffset < capture.items.length) {
        for (const [key, position] of capture.cursors) if (position === nextOffset) { cursor = key; break; }
        cursor ??= crypto.randomUUID();
        if (!capture.cursors.has(cursor)) {
          if (captureTicket) this.resize(captureTicket, capture.bytes + 128); else this.quota(128);
          capture.cursors.set(cursor, nextOffset); capture.bytes += 128;
        }
      }
      const result = this.snapshot({ page: { snapshot_id: snapshotId!, revision: capture.revision, observed_at: new Date(capture.observed).toISOString(),
        expires_at: new Date(capture.observed + 300000).toISOString(), export_policy_revision: capture.policy, offset, total: capture.items.length, next_cursor: cursor }, items: pageItems });
      if (captureTicket) { this.captures.set(snapshotId!, capture); this.free(captureTicket); }
      return result;
    });
  }
}
