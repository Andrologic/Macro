import { pilotTaskId } from './taskIdentity';
import type { DbConversation, DbMessage } from '../tauriIpc';
import type { KernelStorage } from './kernel';
import { stableJson } from './protocol';
import { completion, controlledText, messageText, utf8Bytes, type TextPolicy } from './conversationText';

export type CaptureErrorCode = 'unavailable' | 'content_unavailable' | 'not_found' | 'validation_failed' | 'snapshot_expired' | 'stale_revision' | 'resource_limit';
export class ConversationCaptureError extends Error {
  constructor(readonly code: CaptureErrorCode) { super(code); }
}
export interface CaptureScope { accountId: string; sessionId: string; instanceId: string }
export type ConversationRef = { instance_id: string; kind: 'conversation'; conversation_id: string } |
  { instance_id: string; kind: 'implement'; workspace_id: string; task_id: string; conversation_id: string };
export interface CaptureProject { id: string; name: string }
export interface CaptureTask { id: string; project_id: string; conversation_id?: string | null }
export interface ConversationActivity { activity: 'busy' | 'idle' | 'error' | 'unknown'; generatingMessageId: string | null }
export interface ConversationCaptureSource {
  projects(): Promise<CaptureProject[]>;
  tasks(): Promise<CaptureTask[]>;
  listConversations(): Promise<DbConversation[]>;
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
export interface ConversationItem { ref: ConversationRef; title?: string; revision: number; activity: ConversationActivity['activity'] }
export type MessageItem = {
  message_id: string; position: number; role: 'user' | 'assistant'; created_at: string;
  completion: 'complete' | 'incomplete' | 'unknown';
} & ReturnType<typeof messageText>;
export interface CapturePage<T> { page: PageMetadata; items: T[] }
type Item = ProjectItem | ConversationItem | MessageItem;
type Operation = 'projects.list' | 'conversations.list' | 'conversation.read';
interface Observation {
  projects: CaptureProject[]; tasks: CaptureTask[]; conversations: DbConversation[];
  transcripts: Array<{ id: string; messages: DbMessage[]; provenMessages: Array<{ id: string; text: string }>; activity: ConversationActivity }>;
  policy: TextPolicy;
}
interface Capture {
  binding: string; revision: number; observed: number; policy: string; items: Item[];
  bytes: number; cursors: Map<string, number>;
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

/** One owner per instance. Serializes observations, durable revision CAS and capture
 * allocation. No transport authority is inferred here: the caller authenticates
 * and rechecks access before delivery, and calls clear() on lifecycle changes. */
export class ConversationCaptures {
  private readonly captures = new Map<string, Capture>();
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  constructor(private readonly deps: CaptureDependencies) { id(deps.instanceId); id(deps.workspaceId); }
  clear(): void { this.epoch++; this.captures.clear(); }
  projectsList(scope: CaptureScope, continuation?: Continuation, limit = 100): Promise<CapturePage<ProjectItem>> {
    return this.read(scope, 'projects.list', null, continuation, limit) as Promise<CapturePage<ProjectItem>>;
  }
  conversationsList(scope: CaptureScope, kind: ConversationRef['kind'], continuation?: Continuation, limit = 100): Promise<CapturePage<ConversationItem>> {
    if (kind !== 'implement' && kind !== 'conversation') return Promise.reject(new ConversationCaptureError('validation_failed'));
    return this.read(scope, 'conversations.list', kind, continuation, limit) as Promise<CapturePage<ConversationItem>>;
  }
  conversationRead(scope: CaptureScope, ref: ConversationRef, continuation?: Continuation, limit = 100): Promise<CapturePage<MessageItem>> {
    return this.read(scope, 'conversation.read', ref, continuation, limit) as Promise<CapturePage<MessageItem>>;
  }
  /** Observe after source/policy changes to persist invalidation even without a read.
   * Returns the durable revision for the future content invalidation stream. */
  refresh(): Promise<number> { return this.serial(async () => (await this.observe()).revision); }
  refreshCatalog(): Promise<{ revision: number; refs: ConversationRef[] }> {
    return this.serial(async () => {
      const { observation, revision } = await this.observe();
      const refs = observation.conversations.map(conversation => this.reference(conversation, observation)).filter((ref): ref is ConversationRef => ref !== null);
      return { revision, refs };
    });
  }
  /** Fresh identity/activity validation without hydrating unrelated histories.
   * Background refreshCatalog retains complete transcript change detection. */
  refreshCatalogMetadata(): Promise<{ revision: number; refs: ConversationRef[] }> {
    return this.serial(async () => {
      const { observation, revision } = await this.observe(false, null);
      const refs = observation.conversations.map(conversation => this.reference(conversation, observation)).filter((ref): ref is ConversationRef => ref !== null);
      return { revision, refs };
    });
  }
  refreshProjects(): Promise<number> { return this.serial(async () => (await this.observe(true)).revision); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const result = this.tail.then(async () => {
      if (epoch !== this.epoch) throw new ConversationCaptureError('unavailable');
      try {
        const value = await work();
        if (epoch !== this.epoch) { this.captures.clear(); throw new ConversationCaptureError('unavailable'); }
        return value;
      } catch (error) {
        if (error instanceof ConversationCaptureError) throw error;
        throw new ConversationCaptureError('unavailable');
      }
    });
    this.tail = result.catch(() => undefined); return result;
  }
  private async load(projectsOnly = false, deadline = Infinity, transcriptId?: string | null): Promise<Observation> {
    const checkDeadline = () => { if ((this.deps.now ?? Date.now)() >= deadline) throw new ConversationCaptureError('content_unavailable'); };
    const source = this.deps.source;
    const policy = structuredClone(this.deps.policy());
    if (policy.revision !== 'visible-1') throw new ConversationCaptureError('unavailable');
    for (const value of [this.deps.instanceId, this.deps.workspaceId]) {
      if (controlledText(value, policy).content_state !== 'complete') throw new ConversationCaptureError('content_unavailable');
    }
    const projects = (await source.projects()).map(p => ({ id: id(p.id), name: p.name })).sort(compareId);
    checkDeadline();
    if (new Set(projects.map(p => p.id)).size !== projects.length || projects.some(p => controlledText(p.id, policy).content_state !== 'complete')) throw new ConversationCaptureError('content_unavailable');
    if (projectsOnly) return { projects, tasks: [], conversations: [], transcripts: [], policy };
    const tasks = (await source.tasks()).map(t => ({ id: t.id, project_id: t.project_id, conversation_id: t.conversation_id })).sort(compareId);
    const wireTaskIds = tasks.map(task => id(pilotTaskId(task.id)));
    if (new Set(wireTaskIds).size !== tasks.length) throw new ConversationCaptureError('content_unavailable');
    const conversations = (await source.listConversations()).filter(c => c.scope_mode === 'Chat' || c.scope_mode === 'Implement')
      .sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || b.updated_at.localeCompare(a.updated_at) || compareId(a, b));
    for (const value of [...projects.map(p => p.id), ...tasks.map(t => t.id), ...conversations.map(c => c.id)]) {
      if (controlledText(value, policy).content_state !== 'complete') throw new ConversationCaptureError('content_unavailable');
    }
    checkDeadline();
    const transcripts: Observation['transcripts'] = [];
    const seen = new Set<string>(); let bytes = utf8Bytes(JSON.stringify([projects, tasks, conversations, policy]));
    if (bytes > MAX_QUOTA) throw new ConversationCaptureError('resource_limit');
    for (const conversation of conversations) {
      checkDeadline();
      id(conversation.id);
      if (seen.has(conversation.id)) throw new ConversationCaptureError('content_unavailable');
      seen.add(conversation.id);
      const activity = source.activity(conversation.id);
      if (transcriptId === null || (transcriptId !== undefined && conversation.id !== transcriptId)) {
        transcripts.push({ id: conversation.id, messages: [], provenMessages: [], activity });
        continue;
      }
      const messages = (await source.listMessages(conversation.id)).slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || compareId(a, b));
      checkDeadline();
      const messageIds = new Set<string>(); const provenMessages: Array<{ id: string; text: string }> = [];
      for (const message of messages) {
        id(message.id);
        if (controlledText(message.id, policy).content_state !== 'complete') throw new ConversationCaptureError('content_unavailable');
        if (message.conversation_id !== conversation.id || messageIds.has(message.id) || !Number.isFinite(Date.parse(message.created_at))) throw new ConversationCaptureError('content_unavailable');
        messageIds.add(message.id);
        if (message.role === 'assistant') {
          const text = await source.finalProvenance?.(message);
          checkDeadline();
          if (typeof text === 'string') provenMessages.push({ id: message.id, text });
        }
      }
      bytes += utf8Bytes(JSON.stringify([messages, activity]));
      if (bytes > MAX_QUOTA) throw new ConversationCaptureError('resource_limit');
      transcripts.push({ id: conversation.id, messages, provenMessages, activity });
    }
    return structuredClone({ projects, tasks, conversations, transcripts, policy });
  }
  private async observe(projectsOnly = false, transcriptId?: string | null): Promise<{ observation: Observation; revision: number }> {
    // Bound complete catalog inspection, including both observations and retry.
    const deadline = (this.deps.now ?? Date.now)() + 10_000;
    // Independent reads detect edits during assembly; retry once, never mix pages.
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = await this.deps.storage.load();
      const observation = await this.load(projectsOnly, deadline, transcriptId); const fingerprint = await digest(observation);
      if (fingerprint !== await digest(await this.load(projectsOnly, deadline, transcriptId))) continue;
      type Revision = { revision: number; fingerprint: string };
      type Journal = { version: 2; projects?: Revision; conversations?: Revision;
        catalog?: string; transcripts?: Record<string, string> };
      const journal: Journal = previous === null ? { version: 2 } : JSON.parse(previous);
      if (!journal || journal.version !== 2) throw new ConversationCaptureError('unavailable');
      const section = projectsOnly ? 'projects' : 'conversations';
      const old = journal[section];
      if (old && (!Number.isSafeInteger(old.revision) || old.revision < 1 || typeof old.fingerprint !== 'string')) throw new ConversationCaptureError('unavailable');
      let changed = old?.fingerprint !== fingerprint;
      if (!projectsOnly) {
        // Catalog and transcript observations share one monotonic revision. A
        // targeted read never substitutes empty histories for unobserved rows.
        const catalog = await digest({ ...observation, transcripts: observation.transcripts.map(t => ({ id: t.id, activity: t.activity })) });
        if (journal.catalog !== undefined && typeof journal.catalog !== 'string') throw new ConversationCaptureError('unavailable');
        if (journal.transcripts !== undefined && (!journal.transcripts || typeof journal.transcripts !== 'object' || Array.isArray(journal.transcripts) || Object.values(journal.transcripts).some(value => typeof value !== 'string'))) throw new ConversationCaptureError('unavailable');
        changed = journal.catalog === undefined ? old !== undefined : journal.catalog !== catalog;
        const fingerprints = { ...journal.transcripts };
        for (const transcript of observation.transcripts) {
          if (transcriptId === null || (transcriptId !== undefined && transcript.id !== transcriptId)) continue;
          const value = await digest(transcript);
          if (Object.hasOwn(fingerprints, transcript.id) && fingerprints[transcript.id] !== value) changed = true;
          Object.defineProperty(fingerprints, transcript.id, { value, enumerable: true, writable: true, configurable: true });
        }
        const present = new Set(observation.conversations.map(c => c.id));
        for (const key of Object.keys(fingerprints)) if (!present.has(key)) delete fingerprints[key];
        journal.catalog = catalog;
        journal.transcripts = fingerprints;
      }
      const revision = old ? old.revision + (changed ? 1 : 0) : 1;
      if (!Number.isSafeInteger(revision)) throw new ConversationCaptureError('resource_limit');
      journal[section] = { revision, fingerprint };
      const next = JSON.stringify(journal);
      if (utf8Bytes(next) > MAX_QUOTA) throw new ConversationCaptureError('resource_limit');
      if (!await this.deps.storage.compareAndSwap(previous, next)) continue;
      return { observation, revision };
    }
    throw new ConversationCaptureError('content_unavailable');
  }
  private reference(conversation: DbConversation, observation: Observation): ConversationRef | null {
    if (conversation.scope_mode === 'Chat') return { instance_id: this.deps.instanceId, kind: 'conversation', conversation_id: conversation.id };
    const candidates = observation.tasks.filter(t =>
      (t.id === conversation.task_id || t.conversation_id === conversation.id) &&
      (!conversation.project_id || conversation.project_id === t.project_id) &&
      (!t.conversation_id || t.conversation_id === conversation.id));
    const task = candidates.length === 1 ? candidates[0] : undefined;
    if (!task || !observation.projects.some(p => p.id === task.project_id) ||
      (conversation.project_id && conversation.project_id !== task.project_id) || (task.conversation_id && task.conversation_id !== conversation.id)) return null;
    return { instance_id: this.deps.instanceId, kind: 'implement', workspace_id: this.deps.workspaceId, task_id: pilotTaskId(task.id), conversation_id: conversation.id };
  }
  private read(scope: CaptureScope, operation: Operation, filter: ConversationRef | string | null, continuation: Continuation | undefined, limit: number): Promise<CapturePage<Item>> {
    return this.serial(async () => {
      id(scope.accountId); id(scope.sessionId);
      if (scope.instanceId !== this.deps.instanceId || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConversationCaptureError('validation_failed');
      const binding = stableJson([scope.accountId, scope.sessionId, scope.instanceId, operation, filter]);
      const now = (this.deps.now ?? Date.now)();
      for (const [key, capture] of this.captures) if (now >= capture.observed + 300000) this.captures.delete(key);
      let snapshotId = continuation?.snapshot_id;
      let capture = snapshotId ? this.captures.get(snapshotId) : undefined;
      let offset = 0;
      if (continuation) {
        if (!capture) throw new ConversationCaptureError('snapshot_expired');
        if (capture.binding !== binding || !capture.cursors.has(continuation.cursor)) throw new ConversationCaptureError('validation_failed');
        offset = capture.cursors.get(continuation.cursor)!;
      }
      const { observation, revision } = await this.observe(operation === 'projects.list', operation === 'conversation.read' ? (filter as ConversationRef).conversation_id : null);
      if (capture && capture.revision !== revision) throw new ConversationCaptureError('stale_revision');
      if (!capture) {
        let items: Item[] = [];
        if (operation === 'projects.list') {
          items = observation.projects.map(project => {
            const item: ProjectItem = { instance_id: scope.instanceId, workspace_id: this.deps.workspaceId, project_id: project.id, name: 'Project' };
            const name = controlledText(project.name, observation.policy); if ('text' in name) item.name = Array.from(name.text).slice(0, 120).join('');
            return item;
          });
        } else if (operation === 'conversations.list') {
          for (const conversation of observation.conversations) {
            const ref = this.reference(conversation, observation); if (!ref || ref.kind !== filter) continue;
            const item: ConversationItem = { ref, revision, activity: observation.transcripts.find(t => t.id === conversation.id)!.activity.activity };
            const title = controlledText(conversation.title, observation.policy); if ('text' in title) item.title = title.text;
            items.push(item);
          }
        } else {
          const ref = filter as ConversationRef;
          const conversation = observation.conversations.find(c => c.id === ref?.conversation_id);
          if (!conversation || stableJson(this.reference(conversation, observation)) !== stableJson(ref)) throw new ConversationCaptureError('not_found');
          const persisted = await this.deps.source.getConversation(conversation.id);
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
        const bytes = utf8Bytes(JSON.stringify(items)) + 2048;
        const used = [...this.captures.values()].reduce((sum, value) => sum + value.bytes, 0);
        if (used + bytes > Math.min(MAX_QUOTA, this.deps.quotaBytes ?? MAX_QUOTA)) throw new ConversationCaptureError('resource_limit');
        snapshotId = crypto.randomUUID();
        capture = { binding, revision, observed: now, policy: observation.policy.revision, items: structuredClone(items), bytes, cursors: new Map() };
        this.captures.set(snapshotId, capture);
      }
      if ((this.deps.now ?? Date.now)() >= capture.observed + 300000) { this.captures.delete(snapshotId!); throw new ConversationCaptureError('snapshot_expired'); }
      const pageItems: Item[] = []; let bytes = 4096;
      for (const item of capture.items.slice(offset, offset + limit)) {
        const size = utf8Bytes(JSON.stringify(item)) + 1;
        // Reserve 16 KiB for future response/transport envelopes.
        if (bytes + size > 240 * 1024) break;
        pageItems.push(item); bytes += size;
      }
      if (!pageItems.length && offset < capture.items.length) throw new ConversationCaptureError('resource_limit');
      const nextOffset = offset + pageItems.length;
      let cursor: string | null = null;
      if (nextOffset < capture.items.length) {
        cursor = [...capture.cursors].find(([, position]) => position === nextOffset)?.[0] ?? crypto.randomUUID();
        if (!capture.cursors.has(cursor)) {
          const used = [...this.captures.values()].reduce((sum, value) => sum + value.bytes, 0);
          if (used + 128 > Math.min(MAX_QUOTA, this.deps.quotaBytes ?? MAX_QUOTA)) throw new ConversationCaptureError('resource_limit');
          capture.cursors.set(cursor, nextOffset); capture.bytes += 128;
        }
      }
      return structuredClone({ page: { snapshot_id: snapshotId!, revision: capture.revision, observed_at: new Date(capture.observed).toISOString(),
        expires_at: new Date(capture.observed + 300000).toISOString(), export_policy_revision: capture.policy, offset, total: capture.items.length, next_cursor: cursor }, items: pageItems });
    });
  }
}
