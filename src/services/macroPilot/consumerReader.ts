import type { ConsumerConnections, ConsumerLease, SharedConsumerReadPage } from './consumerConnections';
import type { ConsumerDirectorySnapshot } from './consumerDirectory';
import type { ConsumerIdentity } from './consumerTransport';
import type { ContentConversationCard, ContentConversationRef } from './contentProtocol';
import { PilotClientError, type PilotClientErrorCode } from './clientError';
import { consumerTimer } from './consumerPolicy';
import { stableJson } from './protocol';

export const READER_PAGE_LIMIT = 10;
export const READER_ID_LIMIT = 500;
export interface ConsumerReaderPorts {
  createOwner(): ConsumerConnections;
  context(): ConsumerIdentity;
  subscribe(listener: () => void): () => void;
  localInstanceId?: string;
  monotonicNow?(): number;
  timer?(callback: () => void, ms: number): () => void;
}
type Operation = 'conversations.catalog' | 'conversation.window';
type Page = SharedConsumerReadPage<Operation>;
export interface ReaderRow { page: Page | null; busy: boolean; error: PilotClientErrorCode | null; limited: boolean }
export interface ReaderPanel {
  key: string; instanceId: string; label: string; phase: string; error: PilotClientErrorCode | null;
  passive?: boolean;
  archived: boolean; history: boolean; retryable: boolean; selected: { ref: ContentConversationRef; title: string } | null;
  catalog: ReaderRow; detail: ReaderRow; freshAnchor: boolean;
}
export interface ReaderChoice { id: string; label: string; available: boolean; local: boolean }
export interface ReaderSnapshot {
  phase: 'loading' | 'ready' | 'locked' | 'error' | 'ended'; error: PilotClientErrorCode | null;
  choices: readonly ReaderChoice[]; panels: readonly ReaderPanel[];
}
interface Channel {
  lease?: ConsumerLease; page: Page | null; busy: boolean; error: PilotClientErrorCode | null;
  ids: Set<string>; pages: number; seq: number; abort?: AbortController; timer?: () => void;
  anchor?: string;
}
interface Panel {
  visible: boolean;
  key: string; id: string; label: string; archived: boolean; phase: string; error: PilotClientErrorCode | null;
  selected: ReaderPanel['selected']; history: boolean; catalog: Channel; detail: Channel; freshAnchor: boolean;
}
const channel = (): Channel => ({ page: null, busy: false, error: null, ids: new Set(), pages: 0, seq: 0 });
const code = (e: unknown): PilotClientErrorCode => e instanceof PilotClientError ? e.code : 'unavailable';

/** Dialog-owned protected pages. Authority stays with the shared connection owner. */
export class ConsumerReader {
  private owner?: ConsumerConnections;
  private identity?: ConsumerIdentity;
  private unsubscribe?: () => void;
  private proofTimer?: () => void;
  private generation = 0;
  private available = true;
  private online = true;
  private readonly now: () => number;
  private readonly timer: typeof consumerTimer;
  private started = false;
  private closed = false;
  private readonly panels = new Map<string, Panel>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReaderSnapshot = { phase: 'loading', error: null, choices: [], panels: [] };
  constructor(private readonly ports: ConsumerReaderPorts) { this.now = ports.monotonicNow ?? (() => performance.now()); this.timer = ports.timer ?? consumerTimer; }
  getSnapshot = (): ReaderSnapshot => {
    // Recheck at restitution as well as on the timer. Never return an expired projection.
    let expired = false;
    for (const p of this.panels.values()) for (const row of [p.catalog, p.detail]) {
      if (row.page && (Date.parse(row.page.response.result.page.expires_at) <= Date.now() || row.page.captureDeadline !== undefined && this.now() >= row.page.captureDeadline)) {
        this.clear(row); row.error = 'snapshot_expired'; expired = true;
      }
    }
    if (expired) this.publish(this.snapshot.phase, this.snapshot.error, false);
    if (this.snapshot.panels.some(p => [p.catalog.page, p.detail.page].some(page => page && !this.valid(this.panels.get(p.key)![page.request.operation === 'conversations.catalog' ? 'catalog' : 'detail'], page)))) this.publish(this.snapshot.phase, this.snapshot.error, false);
    return this.snapshot;
  };
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(phase = this.snapshot.phase, error = this.snapshot.error, notify = true): void {
    if (this.closed) return;
    const row = (value: Channel, visible: boolean): ReaderRow => ({ page: visible && value.page && this.valid(value, value.page) ? value.page : null, busy: value.busy, error: value.error, limited: value.pages >= READER_PAGE_LIMIT || value.ids.size >= READER_ID_LIMIT });
    const choices = this.online && [...this.panels.values()].every(p => p.phase !== 'offline') ? this.snapshot.choices : [];
    this.snapshot = { phase, error, choices, panels: [...this.panels.values()].map(p => {
      const catalog = row(p.catalog, p.visible), detail = row(p.detail, p.visible);
      const passive = !this.online || p.phase === 'offline';
      const locked = Boolean(p.catalog.page && !catalog.page || p.detail.page && !detail.page);
      return { key: p.key, instanceId: p.id, label: passive || locked ? '' : p.label,
        phase: !p.visible ? 'revalidating' : locked ? 'authority_expired' : p.phase, error: p.error, archived: p.archived,
        history: p.history, passive, retryable: Boolean(p.catalog.lease) && this.online && phase === 'ready',
        selected: p.selected && (detail.page || catalog.page) ? { ...p.selected, title: catalog.page ? p.selected.title : '' } : null,
        catalog, detail, freshAnchor: p.freshAnchor };
    }) };
    if (notify) for (const listener of [...this.listeners]) listener();
  }
  setTransportOnline(online: boolean): void {
    if (this.closed || this.online === online) return;
    this.online = online;
    if (!online) {
      const retained = [...this.panels.values()].some(p => p.catalog.lease?.state().authority);
      if (!retained) { this.retire('locked', 'offline'); return; }
      this.owner?.setTransportOnline(false); this.publish();
    } else if (this.owner) { this.owner.setTransportOnline(true); this.publish('ready', null); }
    else if (this.available) void this.refresh();
  }

  start(available = true): void {
    if (this.started || this.closed) return;
    this.started = true; this.available = available;
    try {
      this.identity = this.ports.context();
      this.unsubscribe = this.ports.subscribe(() => {
        try { const current = this.ports.context(); if (current.key !== this.identity?.key || current.credentialGeneration !== this.identity?.credentialGeneration) this.dispose(); }
        catch { this.dispose(); }
      });
      if (available && this.online) void this.refresh(); else this.publish('locked', 'offline');
    } catch { this.dispose(); }
  }
  setAvailable(available: boolean): void {
    if (this.closed || this.available === available) return;
    this.available = available;
    if (!available) this.retire('locked', 'offline');
    else if (this.online) void this.refresh();
  }
  private current(owner: ConsumerConnections | undefined, generation: number): boolean {
    if (this.closed || !this.available || this.owner !== owner || generation !== this.generation) return false;
    try { const current = this.ports.context(); if (current.key === this.identity?.key && current.credentialGeneration === this.identity?.credentialGeneration) return true; } catch { /* Retire below. */ }
    this.dispose(); return false;
  }
  private clear(row: Channel, release = false): void {
    row.seq++; row.page = null; row.abort?.abort(); row.abort = undefined; row.timer?.(); row.timer = undefined;
    for (const p of this.panels.values()) if (p.catalog === row && p.selected) p.selected = { ...p.selected, title: '' };
    row.page = null; row.busy = false; row.error = null; row.ids.clear(); row.pages = 0; row.anchor = undefined;
    if (release) { row.lease?.release(); row.lease = undefined; }
  }
  private retire(phase: 'locked' | 'error', error: PilotClientErrorCode): void {
    this.generation++; this.proofTimer?.(); this.proofTimer = undefined;
    for (const p of this.panels.values()) { this.clear(p.catalog, true); this.clear(p.detail, true); p.selected = null; p.label = ''; p.phase = phase; p.error = error; }
    this.owner?.dispose(); this.owner = undefined;
    this.snapshot = { ...this.snapshot, choices: [] }; this.publish(phase, error);
  }
  async refresh(): Promise<void> {
    if (this.closed || !this.available || !this.online) return;
    const generation = ++this.generation;
    this.proofTimer?.();
    for (const p of this.panels.values()) { this.clear(p.catalog, true); this.clear(p.detail, true); p.selected = null; p.label = ''; p.freshAnchor = false; p.phase = 'revalidating'; p.error = null; }
    this.snapshot = { ...this.snapshot, choices: [] }; this.publish('loading', null);
    try {
      const owner = this.owner ??= this.ports.createOwner();
      this.proofTimer = this.timer(() => { if (this.current(owner, generation)) this.retire('error', 'unavailable'); }, 30_000);
      const directory = await owner.refreshDirectory();
      if (!this.current(owner, generation)) return;
      this.updateChoices(directory);
      for (const p of this.panels.values()) if (p.visible) this.attach(p);
      this.publish('ready', null);
    } catch (error) {
      if (this.current(this.owner, generation)) { for (const p of this.panels.values()) { p.phase = 'error'; p.error = code(error); } this.publish('error', code(error)); }
    } finally { if (generation === this.generation) { this.proofTimer?.(); this.proofTimer = undefined; } }
  }
  open(id: string, visible = true): void {
    if (this.snapshot.phase !== 'ready' || !this.owner) return;
    if ([...this.panels.values()].some(p => p.id === id)) return;
    if (this.panels.size >= 2) throw new PilotClientError('resource_limit');
    const choice = this.snapshot.choices.find(item => item.id === id);
    if (!choice?.available || choice.local) throw new PilotClientError('forbidden');
    const key = stableJson([this.identity, id]);
    const p: Panel = { visible, key, id, label: choice.label, archived: false, phase: 'connecting', error: null, selected: null, history: false, catalog: channel(), detail: channel(), freshAnchor: false };
    this.panels.set(key, p); if (visible) this.attach(p); this.publish();
  }
  setPanelVisible(key: string, visible: boolean): void {
    const p = this.panels.get(key); if (!p) return;
    p.visible = visible;
    if (visible && !p.catalog.lease && this.owner && this.available && this.online && this.snapshot.phase === 'ready') this.attach(p);
    p.catalog.lease?.setVisible(visible); p.detail.lease?.setVisible(visible); this.publish();
  }
  close(key: string): void {
    const p = this.panels.get(key); if (!p) return;
    this.panels.delete(key); this.clear(p.catalog, true); this.clear(p.detail, true); this.publish();
  }
  private updateChoices(directory: ConsumerDirectorySnapshot | null): void {
    this.snapshot = { ...this.snapshot, choices: directory?.instances.map(instance => {
      const access = directory.accesses.find(item => item.ref.instance_id === instance.ref.instance_id);
      return { id: instance.ref.instance_id, label: instance.label, local: instance.ref.instance_id === this.ports.localInstanceId,
        available: instance.connection_state === 'reachable' && access?.state === 'granted' && access.permissions.includes('supervise') };
    }) ?? [] };
  }
  private attach(p: Panel): void {
    const choice = this.snapshot.choices.find(item => item.id === p.id);
    p.label = choice?.label ?? '';
    try {
      if (!choice?.available || choice.local) throw new PilotClientError('forbidden');
      p.catalog.lease = this.owner!.acquire(p.id, () => this.sync(p));
      p.phase = 'connecting'; p.error = null;
      this.sync(p);
    } catch (error) { p.phase = 'error'; p.error = code(error); }
  }
  private captureValid(row: Channel, page: Page): boolean {
    if (!row.lease || Date.parse(page.response.result.page.expires_at) <= Date.now() || page.captureDeadline !== undefined && this.now() >= page.captureDeadline) return false;
    try {
      const state = row.lease.state();
      return ['ready', 'offline'].includes(state.phase) && stableJson(state.scope) === stableJson(page.scope) &&
        (state.resources[page.resourceKey]?.version ?? state.catalogVersion) === page.ownerVersion && !state.resources[page.resourceKey]?.removed;
    } catch { return false; }
  }
  private valid(row: Channel, page: Page): boolean {
    if (!this.captureValid(row, page)) return false;
    const state = row.lease!.state();
    return this.available && (state.authority ? state.authority.valid : this.online && state.phase === 'ready');
  }
  private canAct(p: Panel): boolean {
    if (!p.visible || !this.available || !this.online || p.phase !== 'ready') return false;
    try { return p.catalog.lease?.state().authority?.valid !== false; } catch { return false; }
  }
  private arm(row: Channel): void {
    row.timer?.(); if (!row.page) return;
    const page = row.page;
    const capture = Math.min(page.captureDeadline ?? Infinity, this.now() + Math.max(0, Date.parse(page.response.result.page.expires_at) - Date.now()));
    const authority = row.lease?.state().authority;
    const next = authority?.valid ? Math.min(capture, authority.deadline) : capture;
    row.timer = this.timer(() => {
      if (row.page !== page || this.closed) return;
      if (!this.captureValid(row, page)) { this.clear(row); row.error = 'snapshot_expired'; }
      else this.arm(row);
      this.publish();
    }, Math.max(1, next - this.now()));
  }
  private sync(p: Panel): void {
    if (!this.panels.has(p.key) || !p.catalog.lease || this.closed) return;
    try {
      const state = p.catalog.lease.state(); p.phase = state.phase; p.error = state.error;
      // Internal discovery may retire its directory independently of a healthy target's feed.
      const directory = this.owner?.directorySnapshot();
      this.updateChoices(directory ?? null);
      if (state.phase === 'error' && ['unauthorized', 'session_revoked', 'forbidden'].includes(state.error ?? '')) p.label = '';

      p.history = state.capabilities.includes('conversation-history-1');
      for (const row of [p.catalog, p.detail]) if (row.page && !this.captureValid(row, row.page)) {
        const expired = Date.parse(row.page.response.result.page.expires_at) <= Date.now() || row.page.captureDeadline !== undefined && this.now() >= row.page.captureDeadline;
        this.clear(row); if (expired) row.error = 'snapshot_expired'; if (row === p.detail) p.freshAnchor = false; if (row === p.catalog && p.selected) p.selected = { ...p.selected, title: '' };
      }
      if (p.selected && state.resources[stableJson(p.selected.ref)]?.removed) { this.clear(p.detail, true); p.selected = null; }
      if (state.phase !== 'ready' && state.phase !== 'offline') {
        if (state.phase === 'error') { this.clear(p.catalog); this.clear(p.detail, true); p.selected = null; p.freshAnchor = false; }
        for (const row of [p.catalog, p.detail]) { row.page = null; row.timer?.(); row.ids.clear(); row.pages = 0; }
      } else if (!state.capabilities.includes('conversations-1')) {
        p.error = 'extension_unavailable'; this.clear(p.catalog); this.clear(p.detail, true); p.selected = null;
      } else if (this.canAct(p)) {
        if (!p.catalog.page && !p.catalog.busy && !p.catalog.error) void this.load(p, 'catalog');
        if (p.selected && !p.detail.page && !p.detail.busy && !p.detail.error) void this.load(p, 'detail');
      }
      for (const row of [p.catalog, p.detail]) if (row.page) this.arm(row);
      this.publish();
    } catch { this.dispose(); }
  }
  select(key: string, ref: ContentConversationRef): void {
    const p = this.panels.get(key);
    const page = p?.catalog.page;
    if (!p || !this.canAct(p) || !page || !this.valid(p.catalog, page)) return;
    const card = (page.response.result.items as ContentConversationCard[]).find(item => stableJson(item.ref) === stableJson(ref) && item.mode === 'Chat');
    if (!card) return;
    this.clear(p.detail, true); p.selected = { ref: structuredClone(card.ref), title: card.title }; p.freshAnchor = false;
    p.detail.lease = this.owner!.acquire(p.id, () => this.sync(p)); void this.load(p, 'detail');
  }
  back(key: string): void { const p = this.panels.get(key); if (p) { this.clear(p.detail, true); p.selected = null; this.publish(); } }
  filter(key: string, archived: boolean): void {
    const p = this.panels.get(key); if (!p || !this.canAct(p)) return;
    this.back(key); this.clear(p.catalog); p.archived = archived; void this.load(p, 'catalog');
  }
  next(key: string, kind: 'catalog' | 'detail'): void {
    const p = this.panels.get(key); if (!p || !this.canAct(p) || !p[kind].page || p[kind].busy) return;
    const row = p[kind]; if (row.pages >= READER_PAGE_LIMIT || row.ids.size >= READER_ID_LIMIT || !row.page!.response.result.page.next_cursor) return;
    void this.load(p, kind, true);
  }
  restart(key: string, kind: 'catalog' | 'detail', anchored = false): void {
    const p = this.panels.get(key); if (!p || !this.canAct(p)) return;
    const row = p[kind];
    const anchor = anchored && kind === 'detail' && p.history ? (row.page?.response.result.items[0] as { message_id?: string } | undefined)?.message_id : undefined;
    if (anchored && !anchor) return;
    this.clear(row); row.anchor = anchor; if (kind === 'detail') p.freshAnchor = Boolean(anchor); void this.load(p, kind);
  }
  async retry(key: string): Promise<void> {
    const p = this.panels.get(key), owner = this.owner, generation = this.generation;
    if (!p || !owner || this.snapshot.phase !== 'ready') return;
    this.clear(p.catalog); this.clear(p.detail); p.selected = null;
    try {
      if (!p.catalog.lease) throw new PilotClientError('unavailable');
      await owner.retryTarget(p.id);
      if (this.current(owner, generation) && this.panels.get(key) === p) this.sync(p);
    } catch (error) { if (this.current(owner, generation) && this.panels.get(key) === p) { p.error = code(error); p.phase = 'error'; this.publish(); } }
  }
  private async load(p: Panel, kind: 'catalog' | 'detail', next = false): Promise<void> {
    const row = p[kind], owner = this.owner, generation = this.generation;
    if (!owner || !this.canAct(p) || !row.lease || row.busy || this.closed) return;
    const previous = next ? row.page ?? undefined : undefined;
    if (next && (!previous || !this.valid(row, previous))) return;
    row.abort?.abort(); row.timer?.();
    const abort = new AbortController(), seq = ++row.seq; row.abort = abort; row.busy = true; row.error = null; row.page = null;
    if (!next) { row.ids.clear(); row.pages = 0; }
    const continuation = previous ? { snapshot_id: previous.response.result.page.snapshot_id, cursor: previous.response.result.page.next_cursor! } : undefined;
    this.publish();
    try {
      const page: Page = kind === 'catalog'
        ? await row.lease.read('conversations.catalog', { instance_id: p.id, kind: 'conversation', filter: { mode: 'Chat', archived: p.archived ? 'archived' : 'active' }, ...(continuation ? { continuation } : {}) }, { signal: abort.signal, previous, seenIdentities: row.ids })
        : await row.lease.read('conversation.window', { ref: p.selected!.ref, ...(p.history ? { direction: 'backward' as const } : {}), ...(row.anchor ? { message_id: row.anchor } : {}), ...(continuation ? { continuation } : {}) }, { signal: abort.signal, previous, seenIdentities: row.ids });
      if (!this.current(owner, generation) || this.panels.get(p.key) !== p || row.seq !== seq || abort.signal.aborted) return;
      if (!this.valid(row, page)) throw new PilotClientError('snapshot_expired');
      const items = page.response.result.items;
      if (items.length > 50 || new TextEncoder().encode(JSON.stringify(page.response)).byteLength > 256 * 1024 ||
          kind === 'catalog' && (items as ContentConversationCard[]).some(item => item.mode !== 'Chat' || item.ref.instance_id !== p.id || item.ref.kind !== 'conversation' || item.archived !== p.archived)) throw new PilotClientError('invalid_response');
      // D1 expects canonical raw IDs; the set itself belongs to this fully qualified channel.
      const rawIds = items.map(item => 'ref' in item ? item.ref.conversation_id : item.message_id);
      if (row.ids.size + new Set(rawIds).size > READER_ID_LIMIT) throw new PilotClientError('resource_limit');
      for (const id of rawIds) row.ids.add(id);
      row.pages++; row.page = page;
      this.arm(row);
    } catch (error) {
      if (this.current(owner, generation) && this.panels.get(p.key) === p && row.seq === seq && !abort.signal.aborted) row.error = code(error);
    } finally {
      if (row.seq === seq) { row.busy = false; row.abort = undefined; if (!this.closed) this.publish(); }
    }
  }
  dispose(): void {
    if (this.closed) return;
    this.retire('locked', 'context_changed'); this.unsubscribe?.(); this.unsubscribe = undefined;
    this.panels.clear(); this.snapshot = { phase: 'ended', error: 'context_changed', choices: [], panels: [] };
    this.closed = true;
    for (const listener of [...this.listeners]) listener(); this.listeners.clear();
  }
}
