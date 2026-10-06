import type { DbConversation, DbMessage, ConversationMetadata, ConversationActionInput, ConversationActionResult, MessageSearchPage } from '../tauriIpc';
import { ConversationCaptures, ConversationCaptureError, type ConversationCaptureSource, type ConversationRef, type CaptureScope, type MessageItem, type PageMetadata } from './conversationCaptures';
import type { ContentConversationCard, ContentConversationFilter, ContentConversationSearchHit, ContentDelivery } from './contentProtocol';
import type { KernelStorage } from './kernel';
import { stableJson } from './protocol';
import { controlledText, messageText, utf8Bytes, type TextPolicy } from './conversationText';

export const CONVERSATION_CAPABILITY = 'conversations-1';
export const CONVERSATION_OPERATIONS = new Set(['conversations.catalog', 'conversations.search', 'conversation.window', 'conversation.acknowledge', 'conversation.action', 'conversation.create']);
export interface ConversationManagementSource extends ConversationCaptureSource {
  metadata(): Promise<ConversationMetadata[]>;
  search(query: string, conversationIds: string[], offset: number): Promise<MessageSearchPage>;
  message(id: string): Promise<DbMessage | null>;
  responseVersion(message: DbMessage): Promise<number>;
  acknowledge(conversationId: string, observed: number[], executeBefore?: string): Promise<void>;
  action(input: ConversationActionInput): Promise<ConversationActionResult>;
  synchronize(): Promise<void>;
}
interface Dependencies {
  instanceId: string; source: ConversationManagementSource; captures: ConversationCaptures;
  storage: KernelStorage; now?: () => number;
}
interface Catalog { cards: ContentConversationCard[]; conversations: DbConversation[]; fingerprint: string; revision: number }
type Items = ContentConversationCard[] | ContentConversationSearchHit[] | MessageItem[];
interface Snapshot { binding: string; fingerprint: string; revision: number; observed: number; items: Items; cursors: Map<string, number>; bytes: number; ref?: ConversationRef; nativeSnapshot?: string }
interface ReadTicket { binding: string; conversationId: string; observed: number[]; expires: number }
function fail(code: ConstructorParameters<typeof ConversationCaptureError>[0]): never { throw new ConversationCaptureError(code); }
export async function conversationHash(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)))), b => b.toString(16).padStart(2, '0')).join('');
}
export const normalizeConversationSearch = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('und');
function bounded(text: string, policy: TextPolicy, length: number): string {
  const checked = controlledText(text, policy);
  return 'text' in checked ? Array.from(checked.text.replace(/\s+/g, ' ').trim()).slice(0, length).join('') : '';
}
/** Matching uses folded text; snippets retain original Unicode and offsets.
 * The full source has already passed policy inspection before this crop. */
function searchExcerpt(text: string, normalizedIndex: number, policy: TextPolicy): string {
  let originalIndex = 0; let foldedIndex = 0;
  for (const point of text) {
    const width = normalizeConversationSearch(point).length;
    if (foldedIndex + width > normalizedIndex) break;
    foldedIndex += width; originalIndex += point.length;
  }
  let start = Math.max(0, originalIndex - 60);
  if (start && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  // Crop only the inspected text. Checking a whole long suffix again with the
  // short-field budget would produce an empty excerpt for an early match.
  return bounded(Array.from(text.slice(start, start + 1280)).slice(0, 320).join(''), policy, 320);
}
function matches(card: ContentConversationCard, filter: ContentConversationFilter = {}): boolean {
  const archive = filter.archived ?? 'active';
  if (archive !== 'all' && card.archived !== (archive === 'archived')) return false;
  if (filter.project_id && card.project?.project_id !== filter.project_id) return false;
  if (filter.mode && card.mode !== filter.mode) return false;
  if (filter.attention === 'unread' && !card.unread) return false;
  if (filter.attention === 'running' && card.attention !== 'generating') return false;
  if (filter.attention === 'needs_attention' && !['user_request', 'tool_approval', 'error'].includes(card.attention)) return false;
  return true;
}
/** Authenticated host owns this instance and serializes calls. All handles bind
 * account, session, instance and query. clear() purges them on policy/lifecycle changes. */
export class ConversationManager {
  private snapshots = new Map<string, Snapshot>();
  private tickets = new Map<string, ReadTicket>();
  private epoch = 0;
  constructor(private deps: Dependencies) {}
  clear(): void { this.epoch++; this.snapshots.clear(); this.tickets.clear(); this.deps.captures.clear(); }
  private now() { return (this.deps.now ?? Date.now)(); }
  private binding(delivery: ContentDelivery, target: unknown) { return stableJson([delivery.account_id, delivery.source_session_id, delivery.instance_id, target]); }
  private prune() {
    for (const [key, s] of this.snapshots) if (s.observed + 300000 <= this.now()) this.snapshots.delete(key);
    for (const [key, t] of this.tickets) if (t.expires <= this.now()) this.tickets.delete(key);
  }
  private quota(extra = 0) {
    if ([...this.snapshots.values()].reduce((n, s) => n + s.bytes + s.cursors.size * 128, this.tickets.size * 1024 + extra) > 8 * 1024 * 1024) fail('resource_limit');
  }
  private async catalog(policy: TextPolicy): Promise<Catalog> {
    const epoch = this.epoch;
    const deadline = this.now() + 10000;
    const read = async () => {
      const projects = await this.deps.source.projects();
      const conversations = await this.deps.source.listConversations();
      const metadata = await this.deps.source.metadata();
      const refs = await this.deps.captures.refreshCatalogMetadata(true);
      const cards: ContentConversationCard[] = [];
      for (const c of conversations) {
        if (this.now() >= deadline) fail('content_unavailable');
        const ref = refs.refs.find(r => r.conversation_id === c.id); if (!ref) continue;
        const m = metadata.find(m => m.conversation_id === c.id); if (!m) fail('content_unavailable');
        if (![c.created_at, c.updated_at].every(value => Number.isFinite(Date.parse(value)))) fail('content_unavailable');
        const activity = this.deps.source.activity(c.id);
        const project = projects.find(p => p.id === c.project_id);
        let description = bounded(c.description ?? '', policy, 320);
        if (!description && m.preview_message_id) {
          const preview = await this.deps.source.message(m.preview_message_id);
          if (preview?.conversation_id === c.id && preview.role === 'user') {
            const text = messageText(preview, false, policy);
            if ('text' in text) description = bounded(text.text, policy, 320);
          }
        }
        cards.push({ ref, title: bounded(c.title, policy, 240),
          // A latest user message can supply an inspected preview; legacy
          // last_message can include reasoning, tools or partial output.
          description, created_at: new Date(c.created_at).toISOString(), updated_at: new Date(c.updated_at).toISOString(),
          mode: c.scope_mode, project: project ? { project_id: project.id, name: bounded(project.name, policy, 120) } : null,
          pinned: c.is_pinned, archived: m.archived, unread: m.response_revision > m.read_revision, revision: m.revision,
          content_revision: refs.resources[stableJson(ref)], attention: activity.attention ?? (activity.activity === 'busy' ? 'generating' : activity.activity === 'error' ? 'error' : activity.activity === 'unknown' ? 'unknown' : 'none'),
          provider_error: activity.activity === 'error' ? activity.providerFailure as ContentConversationCard['provider_error'] ?? null : null });
      }
      cards.sort((a,b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at) || a.ref.conversation_id.localeCompare(b.ref.conversation_id));
      if (utf8Bytes(stableJson(cards)) > 4 * 1024 * 1024) fail('resource_limit');
      return { cards, conversations, fingerprint: await conversationHash(cards) };
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = await this.deps.storage.load();
      const value = await read(); if (value.fingerprint !== (await read()).fingerprint) continue;
      const old = previous === null ? null : JSON.parse(previous) as { fingerprint: string; revision: number };
      if (old && (!Number.isSafeInteger(old.revision) || old.revision < 1 || !/^[a-f0-9]{64}$/.test(old.fingerprint))) fail('unavailable');
      const revision = (old?.revision ?? 0) + (old?.fingerprint === value.fingerprint ? 0 : 1);
      if (!Number.isSafeInteger(revision)) fail('resource_limit');
      if (epoch !== this.epoch) fail('unavailable');
      if (!await this.deps.storage.compareAndSwap(previous, stableJson({ fingerprint: value.fingerprint, revision }))) continue;
      return { ...value, revision };
    }
    return fail('content_unavailable');
  }
  private allocate(binding: string, catalog: Catalog, items: Items, ref?: ConversationRef, nativeSnapshot?: string): string {
    const bytes = utf8Bytes(stableJson(items)) * 2 + 2048; this.quota(bytes);
    const key = crypto.randomUUID(); this.snapshots.set(key, { binding, fingerprint: catalog.fingerprint, revision: catalog.revision, observed: this.now(), items: structuredClone(items), cursors: new Map(), bytes, ref, nativeSnapshot }); return key;
  }
  private page(snapshotId: string, offset: number, policy: TextPolicy, backward = false): { page: PageMetadata; items: Items } {
    const snapshot = this.snapshots.get(snapshotId)!;
    const items: Items = [];
    let bytes = 4096;
    for (const item of (backward ? snapshot.items.slice(Math.max(0, offset - 50), offset).reverse() : snapshot.items.slice(offset, offset + 50))) {
      const size = utf8Bytes(stableJson(item)) + 1;
      if (bytes + size > 240 * 1024) break;
      (items as Array<Items[number]>).push(item); bytes += size;
    }
    if (!items.length && (backward ? offset > 0 : offset < snapshot.items.length)) fail('resource_limit');
    if (backward) { items.reverse(); offset -= items.length; }
    const end = offset + items.length;
    let cursor: string | null = null;
    if (backward ? offset > 0 : end < snapshot.items.length) {
      cursor = [...snapshot.cursors].find(([,p]) => p === (backward ? offset : end))?.[0] ?? crypto.randomUUID();
      this.quota(128); snapshot.cursors.set(cursor,backward ? offset : end);
    }
    return { page: { snapshot_id: snapshotId, revision: snapshot.revision, observed_at: new Date(snapshot.observed).toISOString(), expires_at: new Date(snapshot.observed + 300000).toISOString(), export_policy_revision: policy.revision,
      offset, total: snapshot.items.length, next_cursor: cursor, ...(backward ? { direction: 'backward' as const } : {}) }, items };
  }
  async handle(delivery: ContentDelivery, policy: TextPolicy, authorize: () => Promise<string>): Promise<unknown> {
    const epoch = this.epoch;
    const check = () => { if (epoch !== this.epoch) fail('unavailable'); };
    this.prune();
    if (!delivery.capabilities?.includes(CONVERSATION_CAPABILITY)) fail('validation_failed');
    const request = delivery.request;
    const body = request.body as Record<string, unknown>;
    const catalog = await this.catalog(policy); check();
    const backward = body.direction === 'backward';
    if (backward && !delivery.capabilities?.includes('conversation-history-1')) fail('validation_failed');
    if (request.operation === 'conversation.action' || request.operation === 'conversation.create') {
      const input = request.body;
      const deadline = await authorize(); check();
      const isCreate = request.operation === 'conversation.create';
      if (!isCreate) {
        const ref = request.body.ref;
        const card = catalog.cards.find(c => stableJson(c.ref) === stableJson(ref));
        if (!card || card.mode !== 'Chat' || ref.kind !== 'conversation') fail('not_found');
      } else if (request.body.project_id && !(await this.deps.source.projects()).some(p => p.id === request.body.project_id)) fail('not_found');
      if ('title' in input && input.title && controlledText(input.title, policy).content_state !== 'complete') fail('validation_failed');
      const receiptKey = await conversationHash([delivery.account_id, delivery.source_session_id, input.idempotency_key]);
      const conversationId = isCreate ? `chat-${receiptKey.slice(0,40)}` : request.body.ref.conversation_id;
      const result = await this.deps.source.action({ receipt_key: receiptKey, digest: await conversationHash([request.operation, input]), action: isCreate ? 'create' : request.body.action,
        conversation_id: conversationId, expected_revision: isCreate ? null : request.body.expected_revision, title: input.title ?? null,
        project_id: isCreate ? request.body.project_id ?? null : null, execute_before: deadline });
      check(); await this.deps.source.synchronize();
      return { outcome: result.outcome, revision: result.revision, ref: { instance_id: delivery.instance_id, kind: 'conversation', conversation_id: result.conversation_id } };
    }
    if (request.operation === 'conversation.acknowledge') {
      const deadline = await authorize(); check();
      const ticket = this.tickets.get(request.body.read_token);
      if (!ticket || ticket.expires <= this.now() || ticket.binding !== this.binding(delivery, request.body.ref)) fail('snapshot_expired');
      if (!catalog.cards.some(c => stableJson(c.ref) === stableJson(request.body.ref))) fail('not_found');
      await this.deps.source.acknowledge(ticket.conversationId, ticket.observed, deadline); check();
      await this.deps.source.synchronize(); return { acknowledged: true };
    }
    const continuation = body.continuation as { snapshot_id: string; cursor: string } | undefined;
    const target: Record<string, unknown> = { operation: request.operation, ...body }; delete target.continuation;
    const binding = this.binding(delivery, target);
    let key = continuation?.snapshot_id; let offset = 0;
    if (continuation) {
      const snapshot = this.snapshots.get(continuation.snapshot_id);
      if (!snapshot || snapshot.observed + 300000 <= this.now()) fail('snapshot_expired');
      if (snapshot.binding !== binding || !snapshot.cursors.has(continuation.cursor)) fail('validation_failed');
      if (request.operation !== 'conversation.window' && snapshot.fingerprint !== catalog.fingerprint) fail('stale_revision');
      offset = snapshot.cursors.get(continuation.cursor)!;
    } else if (request.operation === 'conversations.catalog' || request.operation === 'conversations.search') {
      const cards = catalog.cards.filter(c => c.ref.kind === request.body.kind && matches(c, request.body.filter));
      let items: Items = cards;
      if (request.operation === 'conversations.search') {
        const query = normalizeConversationSearch(request.body.query.trim());
        const results: ContentConversationSearchHit[] = [];
        for (const card of cards) {
          const row = catalog.conversations.find(c => c.id === card.ref.conversation_id)!;
          const rawTitle = controlledText(row.title, policy, 1024 * 1024);
          const rawDescription = controlledText(row.description ?? '', policy, 1024 * 1024);
          const metadata = `${'text' in rawTitle ? rawTitle.text : ''} ${'text' in rawDescription ? rawDescription.text : ''}`;
          const index = normalizeConversationSearch(metadata).indexOf(query);
          if (index >= 0) results.push({ hit_id: crypto.randomUUID(), ref: card.ref, title: card.title, source: 'metadata', excerpt: searchExcerpt(metadata, index, policy), message_id: null });
        }
        if (results.length > 2000) fail('resource_limit');
        let searchOffset = 0; const deadline = this.now() + 10000;
        for (;;) {
          if (this.now() >= deadline) fail('content_unavailable');
          const candidates = await this.deps.source.search(request.body.query, cards.map(c => c.ref.conversation_id), searchOffset);
          for (const candidate of candidates.results) {
            const card = cards.find(c => c.ref.conversation_id === candidate.conversationId); if (!card) fail('content_unavailable');
            const message = await this.deps.source.message(candidate.messageId);
            if (!message || message.conversation_id !== card.ref.conversation_id || !['user','assistant'].includes(message.role)) continue;
            const activity = this.deps.source.activity(message.conversation_id);
            const text = messageText(message, message.role === 'assistant' && activity.activity === 'busy' && (activity.generatingMessageId === null || activity.generatingMessageId === message.id), policy, await this.deps.source.finalProvenance?.(message), 1024 * 1024);
            if (!('text' in text)) continue;
            const normalized = normalizeConversationSearch(text.text); const terms = query.split(/\s+/).filter(Boolean);
            if (!terms.every(t => normalized.includes(t))) continue;
            // Never export the raw FTS snippet, which can contain reasoning/context.
            const index = normalized.indexOf(terms[0]);
            results.push({ hit_id: crypto.randomUUID(), ref: card.ref, title: card.title, source: 'message', excerpt: searchExcerpt(text.text, index, policy), message_id: message.id });
            if (results.length > 2000) fail('resource_limit');
          }
          check();
          if (candidates.nextOffset === null) break;
          if (candidates.nextOffset <= searchOffset) fail('content_unavailable'); searchOffset = candidates.nextOffset;
        }
        if ((await this.catalog(policy)).fingerprint !== catalog.fingerprint) fail('stale_revision');
        items = results;
      }
      key = this.allocate(binding, catalog, items);
    } else if (request.operation === 'conversation.window') {
      if (!catalog.cards.some(c => stableJson(c.ref) === stableJson(request.body.ref))) fail('not_found');
      const scope: CaptureScope = { accountId: delivery.account_id, sessionId: delivery.source_session_id, instanceId: delivery.instance_id, reliability: true };
      let page = await this.deps.captures.conversationRead(scope, request.body.ref); const nativeSnapshot = page.page.snapshot_id;
      const items: MessageItem[] = [...page.items];
      while (page.page.next_cursor) {
        page = await this.deps.captures.conversationRead(scope, request.body.ref, { snapshot_id: nativeSnapshot, cursor: page.page.next_cursor }); items.push(...page.items);
        if (utf8Bytes(stableJson(items)) > 4 * 1024 * 1024) fail('resource_limit');
      }
      if (request.body.message_id) { const position = items.findIndex(m => m.message_id === request.body.message_id); if (position < 0) fail('not_found'); offset = backward ? Math.min(items.length, position + 6) : Math.max(0,position-5); }
      if (backward && !request.body.message_id) offset = items.length;
      key = this.allocate(binding, catalog, items, request.body.ref, nativeSnapshot);
    } else return fail('validation_failed');
    check();
    const snapshot = this.snapshots.get(key!)!;
    if (request.operation === 'conversation.window') {
      await this.deps.captures.validateCached({ accountId: delivery.account_id, sessionId: delivery.source_session_id, instanceId: delivery.instance_id, reliability: true }, 'conversation.read', request.body.ref, snapshot.nativeSnapshot!);
      const result = this.page(key!, offset, policy, backward);
      const observed: number[] = [];
      for (const item of result.items as MessageItem[]) {
        if (item.role !== 'assistant' || !('text' in item) || item.completion !== 'complete') continue;
        const raw = await this.deps.source.message(item.message_id); if (!raw || raw.conversation_id !== request.body.ref.conversation_id) fail('stale_revision');
        const text = messageText(raw, false, policy, await this.deps.source.finalProvenance?.(raw));
        if (!('text' in text) || text.text !== item.text) fail('stale_revision');
        observed.push(await this.deps.source.responseVersion(raw));
      }
      let token: string | null = null;
      if (observed.length) { this.quota(1024); token = crypto.randomUUID(); this.tickets.set(token, { binding: this.binding(delivery, request.body.ref), conversationId: request.body.ref.conversation_id, observed, expires: snapshot.observed + 300000 }); }
      check(); return { ...result, read_token: token };
    }
    check(); return this.page(key!, offset, policy);
  }
}
