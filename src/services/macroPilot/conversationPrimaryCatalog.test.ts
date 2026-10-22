import { expect, test, spyOn } from 'bun:test';
import { Buffer } from 'node:buffer';
import { ConversationCaptures, type CaptureDependencies, type ConversationActivity } from './conversationCaptures';
import { ContentHost, CONTENT_BUDGET } from './contentHost';
import { createReviewCaptureService } from './reviewCapture';
import { desktopConversationCaptureSource, desktopConversationManagementSource } from './conversationCaptureSource';
import type { DesktopStorePorts } from './desktopStorePorts';
import type { Conversation, ConversationCatalogToken, ConversationCatalogPage, ConversationCatalogPageInput } from '../../types/generated/ipc';
import type { DbConversation } from '../tauriIpc';
import type { ContentDelivery, ContentEvent } from './contentProtocol';
import { captureCost, parsedCaptureCost } from './conversationCaptureBudget';
import { stableJson } from './protocol';

const date = '2026-01-01T00:00:00Z';
const scope = { accountId: 'account', sessionId: 'session', instanceId: 'instance', reliability: true };
const memory = () => {
  let value: string | null = null;
  return { load: async () => value, compareAndSwap: async (before: string | null, next: string) => {
    if (before !== value) return false; value = next; return true;
  }, get value() { return value; } };
};
const row = (id: string): Conversation => ({ id, title: 'Synthetic ' + id, description: null, scope_mode: 'Chat',
  task_id: null, project_id: null, group_id: null, provider_id: null, model_id: null, reasoning_effort: null,
  created_at: date, updated_at: date, last_message: null, message_count: 0, is_pinned: false });
function fixture(native = true, count = 5, quotaBytes: number = CONTENT_BUDGET.conversations) {
  const rows = Array.from({ length: count }, (_, i) => row('c' + i));
  const projects = [{ id: 'project', name: 'Synthetic project' }];
  const tasks: Array<{ id: string; project_id: string; conversation_id?: string }> = [];
  const activity: ConversationActivity = { activity: 'idle', generatingMessageId: null };
  let revision = 9007199254740993n, generation = 'a'.repeat(32), clock = Date.parse(date);
  const reads = { projects: 0, tasks: 0, activity: 0, version: 0, page: 0, legacy: 0 };
  const token = (): ConversationCatalogToken => ({ version: 1, generation, incarnation: 'b'.repeat(32), revision: String(revision) });
  const equal = (t: ConversationCatalogToken | null) => !t || JSON.stringify(t) === JSON.stringify(token());
  const storage = memory();
  const source: CaptureDependencies['source'] = {
    projects: async () => { reads.projects++; return structuredClone(projects); },
    tasks: async () => { reads.tasks++; return structuredClone(tasks); },
    listConversations: async () => { reads.legacy++; return structuredClone(rows) as DbConversation[]; },
    getConversation: async id => structuredClone(rows.find(r => r.id === id) ?? null) as DbConversation | null,
    listMessages: async () => [],
    activity: () => { reads.activity++; return activity; },
    nativeContent: { version: async () => ({ version: 1, incarnation: 'c'.repeat(32), revision: '0' }),
      metadata: async input => ({ token: { version: 1, incarnation: 'c'.repeat(32), revision: '0' }, items: [], next_after: null, admission_estimate_bytes: 4096, opening: { total_raw: '0', total_exportable: '0', conversation: rows.find(r => r.id === input.conversation_id)! as DbConversation, metadata: { conversation_id: input.conversation_id, revision: '0', archived: false, response_revision: '0', read_revision: '0', pending_tool: false, provider_failed: false, question_message_id: null, preview_message_id: null } } }), window: async () => { throw Error('unexpected window'); } },
  };
  const ports: NonNullable<typeof source.nativeCatalog> = {
    version: async input => { reads.version++; if (!equal(input.expected_token)) throw 'stale_revision'; return token(); },
    page: async input => {
      reads.page++;
      if (!equal(input.expected_token)) throw 'stale_revision';
      const sorted = [...rows].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
      const start = input.after ? sorted.findIndex(r => r.id === input.after!.id) + 1 : 0;
      const items = structuredClone(sorted.slice(start, start + Math.min(2, input.limit)));
      return { token: token(), ...(!input.after ? { total_raw: String(rows.length) } : {}), items,
        next_after: start + items.length < rows.length ? { id: items.at(-1)!.id } : null, admission_estimate_bytes: 8192 };
    },
  };
  if (native) source.nativeCatalog = ports;
  const deps: CaptureDependencies = { instanceId: 'instance', workspaceId: 'workspace', source, storage,
    policy: () => ({ revision: 'visible-1', secrets: [] }), quotaBytes, now: () => clock };
  const captures = new ConversationCaptures(deps);
  const host = new ContentHost({ accountId: 'account', instanceId: 'instance', signal: new AbortController().signal,
    conversations: captures, reviews: createReviewCaptureService(), storage: memory(), policy: async () => deps.policy(),
    reviewRefs: async () => [], resolveReview: async () => { throw Error('not_found'); }, commitReview: async () => false, now: () => clock });
  return { rows, projects, tasks, activity, reads, token, ports, source, deps, captures, host, storage,
    bump: () => revision++, restore: () => { generation = 'd'.repeat(32); }, advance: (n: number) => { clock += n; },
    reset: () => { for (const key of Object.keys(reads) as Array<keyof typeof reads>) reads[key] = 0; },
  };
}
function owned(f: ReturnType<typeof fixture>) {
  return f.captures as unknown as { catalog?: { ticket: symbol }; captures: Map<string, { bytes: number }>; reservations: Map<symbol, number>; reserve(bytes: number): symbol; fingerprint(value: unknown): Promise<string> };
}
function barrier() {
  let release!: () => void, arrived!: () => void;
  const reached = new Promise<void>(r => { arrived = r; }), gate = new Promise<void>(r => { release = r; });
  return { reached, release, wait: async () => { arrived(); await gate; } };
}

test('cold, warm and changed catalogs use the expected ports without hiding other domains', async () => {
  const f = fixture();
  await f.captures.refreshHostCatalogs();
  expect(f.reads).toEqual({ projects: 2, tasks: 2, activity: 10, version: 2, page: 3, legacy: 0 });
  f.reset(); const previous = f.storage.value;
  await f.captures.refreshHostCatalogs();
  expect(f.reads).toEqual({ projects: 2, tasks: 2, activity: 10, version: 2, page: 0, legacy: 0 });
  expect(f.storage.value).toBe(previous);
  f.reset(); f.rows[0].description = 'Invisible but fingerprinted'; f.bump();
  const changed = await f.captures.refreshHostCatalogs();
  expect(f.reads.version).toBe(3); expect(f.reads.page).toBe(3); expect(changed.conversations?.revision).toBe(2);
  f.reset(); f.activity.activity = 'busy'; f.projects[0].name = 'New project'; f.tasks.push({ id: 'task', project_id: 'project' });
  const dynamic = await f.captures.refreshHostCatalogs();
  expect(dynamic.conversations?.revision).toBe(3); expect(dynamic.projects).toBe(2);
  expect(f.reads).toEqual({ projects: 2, tasks: 2, activity: 10, version: 2, page: 0, legacy: 0 });
});

test('the fifteen persisted values preserve legacy fingerprints, ordering and clocks', async () => {
  const a = fixture(false), b = fixture();
  for (const f of [a, b]) {
    f.rows[0].updated_at = '2026-01-01T00:00:00+01:00'; f.rows[1].updated_at = '2026-01-01T00:00:00-01:00';
    f.rows[2].is_pinned = true; f.rows[3].scope_mode = 'Architect'; f.rows[4].scope_mode = 'Implement';
    f.rows[4].task_id = 'task'; f.rows[4].project_id = 'project'; f.tasks.push({ id: 'task', project_id: 'project', conversation_id: 'c4' });
  }
  const updates: Array<Partial<Conversation>> = [{}, { title: 'Changed' }, { description: 'Hidden' }, { scope_mode: 'Architect' },
    { task_id: 'different' }, { group_id: 'group' }, { project_id: 'project' }, { provider_id: 'provider' }, { model_id: 'model' },
    { reasoning_effort: 'high' }, { created_at: '2025-01-01' }, { updated_at: 'historical raw date' }, { last_message: 'Preview' },
    { message_count: -2 }, { is_pinned: true }, { id: 'renamed' }];
  for (const update of updates) {
    Object.assign(a.rows[0], update); Object.assign(b.rows[0], update); b.bump();
    expect(await b.captures.refreshHostCatalogs()).toEqual(await a.captures.refreshHostCatalogs());
    expect(JSON.parse(b.storage.value!)).toEqual(JSON.parse(a.storage.value!));
  }
  b.bump(); const before = b.storage.value; await b.captures.refreshHostCatalogs();
  expect(b.storage.value).toBe(before); // Token alone is never a public clock.
});

test('BINARY pagination admits historical Unicode and excluded modes before public filtering', async () => {
  const f = fixture(true, 0);
  f.rows.push({ ...row('\u{10000}'), scope_mode: 'Other' }, { ...row('\ue000'), scope_mode: 'Other' }, { ...row(''), scope_mode: 'Other' }, row('chat'));
  const anchors: Array<string | null> = []; const page = f.ports.page;
  f.ports.page = async input => { anchors.push(input.after?.id ?? null); expect(input.expected_token?.revision ?? f.token().revision).toBe('9007199254740993'); return page(input); };
  expect((await f.captures.refreshCatalogMetadata()).refs.map(r => r.conversation_id)).toEqual(['chat']);
  expect(anchors).toEqual([null, 'chat']);
  f.captures.clear(); f.rows[0].scope_mode = 'Chat';
  await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow('validation_failed'); // Existing public ID rule.
});

for (const phase of ['interpage', 'seal', 'pair'] as const) test(`a mutation at ${phase} discards the old observation and retries one fresh pair`, async () => {
  const f = fixture(); const page = f.ports.page, version = f.ports.version; let once = true;
  if (phase === 'interpage') f.ports.page = async input => {
    if (input.after && once) { once = false; f.rows[0].title = 'Mutated'; f.bump(); } return page(input);
  };
  else f.ports.version = async input => {
    if (once && (phase === 'seal' ? input.expected_token !== null : f.reads.version === 1)) {
      once = false; f.rows[0].title = 'Mutated'; f.bump();
    }
    return version(input);
  };
  const result = await f.captures.refreshHostCatalogs();
  expect(result.error).toBeUndefined(); expect(f.reads.projects).toBe(phase === 'pair' ? 4 : 3);
  const witness = fixture(false); witness.rows[0].title = 'Mutated'; await witness.captures.refreshHostCatalogs();
  expect(JSON.parse(f.storage.value!)).toEqual(JSON.parse(witness.storage.value!));
  expect(f.reads.legacy).toBe(0);
});

test('insert/delete/replace and restored generations retire previous rows and continuations', async () => {
  const f = fixture(); const first = await f.captures.conversationsList(scope, 'conversation', undefined, 1);
  f.rows.push(row('inserted')); f.bump(); expect((await f.captures.refreshCatalogMetadata()).refs).toHaveLength(6);
  f.rows.splice(0, 1); f.bump(); expect((await f.captures.refreshCatalogMetadata()).refs).toHaveLength(5);
  f.rows[0] = { ...row(f.rows[0].id), title: 'Replacement' }; f.bump();
  const current = await f.captures.refreshCatalogMetadata();
  await expect(f.captures.validateCached(scope, 'conversations.list', 'conversation', first.page.snapshot_id)).rejects.toThrow('stale_revision');
  f.restore(); await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow('unavailable');
  expect(owned(f).catalog).toBeUndefined(); expect(owned(f).captures.size).toBe(0);
  expect((await f.captures.refreshCatalogMetadata()).revision).toBe(current.revision);
});

const malformed: Record<string, (p: ConversationCatalogPage) => void> = {
  total: p => { p.total_raw = '9007199254740993'; },
  decimal: p => { p.token.revision = '01'; },
  overflow: p => { p.token.revision = '9223372036854775808'; },
  missing: p => { delete p.total_raw; },
  anchor: p => { p.next_after = { id: 'fiction' }; },
  duplicate: p => { p.items[1] = p.items[0]; },
  order: p => { p.items.reverse(); },
  empty: p => { p.items = []; },
  type: p => { p.items[0].title = 1 as unknown as string; },
  surrogate: p => { p.items[0].id = '\ud800'; },
  estimate: p => { p.admission_estimate_bytes = Number.MAX_SAFE_INTEGER; },
  pin: p => { p.items[0].is_pinned = 1 as unknown as boolean; },
};
for (const [name, change] of Object.entries(malformed)) test(`malformed native ${name} cannot publish a prefix or use legacy`, async () => {
  const f = fixture(); const page = f.ports.page;
  f.ports.page = async input => { const p = await page(input); change(p); return p; };
  await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow('unavailable');
  expect(f.storage.value).toBeNull(); expect(f.reads.legacy).toBe(0); expect(owned(f).reservations.size).toBe(0);
});
test('native absence is explicit, whereas errors and incomplete ports never fall back', async () => {
  const f = fixture();
  f.ports.page = async () => { throw { message: 'resource_limit' }; };
  await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow('resource_limit'); expect(f.reads.legacy).toBe(0);
  f.source.nativeCatalog = { version: f.ports.version } as typeof f.source.nativeCatalog;
  expect(() => new ConversationCaptures(f.deps)).toThrow('unavailable');
  const legacy = fixture(false); await legacy.captures.refreshCatalogMetadata(); expect(legacy.reads.legacy).toBe(2);
});

test('quota refuses before invoke or page projection, with no retained fragments', async () => {
  const tooSmall = fixture(true, 5, 4 * 1024 * 1024 - 1);
  await expect(tooSmall.captures.refreshCatalogMetadata()).rejects.toThrow('resource_limit');
  expect(tooSmall.reads.page).toBe(0);
  const f = fixture(true, 5, 4 * 1024 * 1024 + 16384);
  f.rows[0].description = 'x'.repeat(16000);
  const freeze = spyOn(Object, 'freeze'); let projected: unknown[] = [];
  try {
    await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow('resource_limit');
    projected = freeze.mock.calls.map(args => args[0]).filter(v => v && typeof v === 'object' && 'title' in v);
  } finally { freeze.mockRestore(); }
  expect(f.reads.page).toBe(1); expect(projected).toEqual([]);
  expect(owned(f).catalog).toBeUndefined(); expect(owned(f).reservations.size).toBe(0); expect(f.storage.value).toBeNull();
});

test('a failed conversation quota frees its work before an independent project success', async () => {
  const f = fixture(true, 5, 4 * 1024 * 1024 + 16384);
  f.rows[0].description = 'x'.repeat(16000);
  const result = await f.captures.refreshHostCatalogs();
  expect(result.projects).toBe(1); expect(result.conversations).toBeNull();
  expect(result.error).toMatchObject({ code: 'resource_limit' }); expect(owned(f).reservations.size).toBe(0);
});

for (const boundary of ['page', 'version'] as const) test(`clear retires late ${boundary} results and only their own tickets`, async () => {
  const f = fixture(); if (boundary === 'version') await f.captures.refreshCatalogMetadata();
  const gate = barrier();
  if (boundary === 'page') { const page = f.ports.page; let once = true; f.ports.page = async input => { const p = await page(input); if (once) { once = false; await gate.wait(); } return p; }; }
  else { const version = f.ports.version; let once = true; f.ports.version = async input => { const t = await version(input); if (once) { once = false; await gate.wait(); } return t; }; }
  const pending = f.captures.refreshCatalogMetadata(); await gate.reached;
  f.captures.clear(); expect(owned(f).catalog).toBeUndefined(); expect(owned(f).reservations.size).toBe(0);
  const fresh = f.captures.refreshCatalogMetadata(); gate.release();
  await expect(pending).rejects.toThrow('unavailable'); expect((await fresh).refs).toHaveLength(5);
  expect(owned(f).reservations.size).toBe(1); f.captures.clear(); expect(owned(f).reservations.size).toBe(0);
});

test('CAS retries share the initial deadline and cannot keep late or partial observations', async () => {
  const f = fixture(); let commits = 0;
  f.deps.storage.load = async () => { f.advance(6000); return null; };
  f.deps.storage.compareAndSwap = async () => { commits++; return false; };
  await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow('content_unavailable');
  expect(commits).toBe(1); expect(f.reads.projects).toBe(2);
  const delayed = fixture(); const page = delayed.ports.page;
  delayed.ports.page = async input => { const value = await page(input); delayed.advance(10000); return value; };
  await expect(delayed.captures.refreshCatalogMetadata()).rejects.toThrow('content_unavailable');
  expect(delayed.storage.value).toBeNull(); expect(owned(delayed).catalog).toBeUndefined();
});

test('the real ContentHost emission validation retires a prepared cached result after mutation', async () => {
  const f = fixture(); await f.host.initialize();
  const delivery: ContentDelivery = { transport_version: '2.0', type: 'delivery', request_id: 'request', instance_id: 'instance',
    account_id: 'account', source_session_id: 'session', expires_at: '2026-01-01T00:05:00Z', capabilities: ['conversations-1'],
    request: { contract_version: '2.0', type: 'request', request_id: 'request', account_id: 'account', operation: 'conversations.list', body: { instance_id: 'instance', kind: 'conversation' } } };
  try {
    const prepared = await f.host.handle(delivery, async () => '2026-01-01T00:00:10Z');
    f.rows[0].title = 'Changed before emission'; f.bump();
    const decision = await f.host.prepareConversationEmission(delivery, prepared);
    expect(decision.type).toBe('invalidated');
    if (decision.type === 'invalidated') expect(decision.result.response).toMatchObject({ type: 'error', code: 'stale_revision' });
    expect(f.reads.legacy).toBe(0);
  } finally { await f.host.dispose(); }
});

test('ContentHost → desktop source → actual invoke counts ports, rows and payload bytes against legacy', async () => {
  const f = fixture(); const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: Array<{ command: string; rows: number; bytes: number }> = [];
  const runtime: Record<string, unknown> = {};
  const stores = { app: () => ({ standaloneProjects: f.projects, projectGroups: [] }), tasks: () => ({ tasks: f.tasks }),
    chat: () => ({ conversationRuntimeById: runtime, pendingToolApprovalByConversationId: {} }) } as unknown as DesktopStorePorts;
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    let result: unknown;
    if (command === 'db_conversation_catalog_version') result = await f.ports.version(args.input as { expected_token: ConversationCatalogToken | null });
    else if (command === 'db_conversation_catalog_page') result = await f.ports.page(args.input as ConversationCatalogPageInput);
    else if (command === 'db_list_conversations') result = await f.source.listConversations();
    else throw Error('unexpected IPC command ' + command);
    calls.push({ command, rows: Array.isArray(result) ? result.length : command.endsWith('_page') ? (result as ConversationCatalogPage).items.length : 0,
      bytes: Buffer.byteLength(JSON.stringify(result), 'utf8') });
    return result;
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
  const summaries: Array<{ phase: string; versions: number; pages: number; legacy: number; rows: number; bytes: number;
    pageBytes: number; tokenBytes: number; legacyBytes: number; rowCopies: number; observationCopies: number; clones: number; digests: number; ownerDigests: number;
    reservations: number; requestedUnits: number; peakUnits: number }> = [];
  let requestedUnits = 0, peakUnits = 0, legacyDigests = 0;
  const freeze = spyOn(Object, 'freeze'); const sha = spyOn(crypto.subtle, 'digest'); const clone = spyOn(globalThis, 'structuredClone');
  const sample = (phase: string) => {
    summaries.push({ phase, versions: calls.filter(c => c.command.endsWith('_version')).length,
      pages: calls.filter(c => c.command.endsWith('_page')).length, legacy: calls.filter(c => c.command === 'db_list_conversations').length,
      rows: calls.reduce((n, c) => n + c.rows, 0), bytes: calls.reduce((n, c) => n + c.bytes, 0),
      pageBytes: calls.filter(c => c.command.endsWith('_page')).reduce((n, c) => n + c.bytes, 0),
      tokenBytes: calls.filter(c => c.command.endsWith('_version')).reduce((n, c) => n + c.bytes, 0),
      legacyBytes: calls.filter(c => c.command === 'db_list_conversations').reduce((n, c) => n + c.bytes, 0),
      rowCopies: freeze.mock.calls.filter(args => args[0] && typeof args[0] === 'object' && 'title' in args[0]).length,
      observationCopies: clone.mock.calls.filter(args => args[0] && typeof args[0] === 'object' && 'conversations' in args[0] && 'transcripts' in args[0]).length,
      clones: clone.mock.calls.length, digests: sha.mock.calls.length, ownerDigests: ownerHash.mock.calls.length + legacyDigests,
      reservations: allocation.mock.calls.length, requestedUnits, peakUnits });
    calls.length = 0; freeze.mockClear(); sha.mockClear(); clone.mockClear(); allocation.mockClear(); ownerHash.mockClear(); requestedUnits = 0; peakUnits = 0; legacyDigests = 0;
  };
  const source = desktopConversationCaptureSource(stores);
  const primary = new ConversationCaptures({ ...f.deps, source, storage: memory() });
  const host = new ContentHost({ accountId: 'account', instanceId: 'instance', signal: new AbortController().signal,
    conversations: primary, reviews: createReviewCaptureService(), storage: memory(), policy: async () => f.deps.policy(), now: f.deps.now,
    reviewRefs: async () => [], resolveReview: async () => { throw Error('not_found'); }, commitReview: async () => false });
  const owner = primary as unknown as ReturnType<typeof owned>; const originalReserve = owner.reserve.bind(primary);
  const ownerHash = spyOn(owner, 'fingerprint');
  const allocation = spyOn(owner, 'reserve').mockImplementation(bytes => {
    const ticket = originalReserve(bytes); requestedUnits += bytes;
    peakUnits = Math.max(peakUnits, [...owner.reservations.values()].reduce((n, b) => n + b, 0) + [...owner.captures.values()].reduce((n, c) => n + c.bytes, 0));
    return ticket;
  });
  try {
    expect(desktopConversationManagementSource(stores).nativeCatalog).toBeUndefined();
    await host.initialize(); await host.prepare(); sample('cold');
    await host.observe(); sample('stable');
    expect(summaries[1].rowCopies).toBe(0); expect(summaries[1].observationCopies).toBe(0); expect(summaries[1].digests).toBeGreaterThan(0);
    runtime.c0 = { phase: 'streaming', assistantMessageId: 'message' };
    await host.observe(); sample('activity');
    f.rows[0].title = 'Changed persisted'; f.bump(); await host.observe(); sample('mutation');
    const events: ContentEvent[] = []; await host.flush(async event => { events.push(event); });
    expect(events.some(e => e.change.kind === 'conversations.changed')).toBe(true);
    f.rows[0].title = 'Synthetic c0'; // Compare payload bytes against the same five original rows.
    const legacy = new ConversationCaptures({ ...f.deps, source: { ...source, nativeCatalog: undefined }, storage: memory() });
    const legacyHash = spyOn(legacy as unknown as ReturnType<typeof owned>, 'fingerprint');
    try { await legacy.refreshHostCatalogs(); legacyDigests = legacyHash.mock.calls.length; sample('legacy'); } finally { legacyHash.mockRestore(); }
    expect(summaries.map(({ phase, versions, pages, legacy, rows }) => ({ phase, versions, pages, legacy, rows }))).toEqual([
      { phase: 'cold', versions: 2, pages: 3, legacy: 0, rows: 5 },
      { phase: 'stable', versions: 2, pages: 0, legacy: 0, rows: 0 },
      { phase: 'activity', versions: 2, pages: 0, legacy: 0, rows: 0 },
      { phase: 'mutation', versions: 3, pages: 3, legacy: 0, rows: 5 },
      { phase: 'legacy', versions: 0, pages: 0, legacy: 2, rows: 10 },
    ]);
    expect(summaries[1].bytes).toBeLessThan(summaries[4].bytes);
    expect(summaries[1].ownerDigests).toBe(summaries[4].ownerDigests);
    console.info('primary-catalog-port-measurements', JSON.stringify({ raw: f.rows.length, visible: f.rows.length, pageSize: 2, samples: summaries }));
  } finally {
    freeze.mockRestore(); sha.mockRestore(); clone.mockRestore(); allocation.mockRestore(); ownerHash.mockRestore(); await host.dispose();
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('an empty catalog seals once and reuses without inventing rows or revisions', async () => {
  const f = fixture(true, 0);
  expect((await f.captures.refreshHostCatalogs()).conversations?.refs).toEqual([]);
  expect(f.reads.page).toBe(1); expect(f.reads.version).toBe(2);
  f.reset(); expect((await f.captures.refreshCatalogMetadata()).revision).toBe(1);
  expect(f.reads.page).toBe(0); expect(f.reads.version).toBe(2);
});

test('retained public captures share the quota with the cache, pair and scratchs, then release', async () => {
  const f = fixture(true, 10, 4 * 1024 * 1024 + 512 * 1024);
  for (const r of f.rows) r.title = 'x'.repeat(1000);
  const snapshots: string[] = [];
  for (let i = 0; i < 100; i++) {
    try {
      const page = await f.captures.conversationsList(scope, 'conversation');
      snapshots.push(page.page.snapshot_id);
      page.items[0].title = 'Tampered delivery';
    } catch (error) { expect(error).toMatchObject({ code: 'resource_limit' }); break; }
  }
  expect(snapshots.length).toBeGreaterThan(1); expect(snapshots.length).toBeLessThan(100);
  expect(owned(f).captures.size).toBe(snapshots.length);
  expect([...owned(f).reservations.keys()]).toEqual(owned(f).catalog ? [owned(f).catalog!.ticket] : []);
  for (const id of snapshots) f.captures.release(id);
  f.reset(); expect((await f.captures.refreshCatalogMetadata()).refs).toHaveLength(10);
  expect(f.reads.page).toBe(0); expect(owned(f).reservations.size).toBe(1);
  f.captures.clear(); expect(owned(f).reservations.size).toBe(0);
});

test('quota at the final response copy refuses before publishing its reserved capture', async () => {
  const f = fixture(); const owner = f.captures as unknown as { snapshot(value: unknown): unknown };
  const copy = owner.snapshot.bind(f.captures); let reached = false;
  const snapshot = spyOn(owner, 'snapshot').mockImplementation(value => {
    if (value && typeof value === 'object' && 'page' in value) {
      reached = true; expect(owned(f).captures.size).toBe(0);
      f.deps.quotaBytes = [...owned(f).reservations.values()].reduce((n, bytes) => n + bytes, 0);
    }
    return copy(value);
  });
  try {
    await expect(f.captures.conversationsList(scope, 'conversation')).rejects.toThrow('resource_limit');
    expect(reached).toBe(true); expect(owned(f).captures.size).toBe(0);
    expect([...owned(f).reservations.keys()]).toEqual([owned(f).catalog!.ticket]);
  } finally { snapshot.mockRestore(); f.captures.clear(); }
  expect(owned(f).reservations.size).toBe(0);
});

test('a stable catalog still reads the watched C1 token twice and invalidates its resource', async () => {
  const f = fixture(true, 1); let versions = 0, contentRevision = '0';
  f.source.nativeContent!.version = async () => { versions++; return { version: 1, incarnation: 'c'.repeat(32), revision: contentRevision }; };
  const page = await f.captures.conversationRead(scope, { instance_id: 'instance', kind: 'conversation', conversation_id: 'c0' });
  versions = 0; f.reset(); contentRevision = '1';
  const result = await f.captures.refreshHostCatalogs();
  expect(versions).toBe(2); expect(f.reads.page).toBe(0);
  expect(result.conversations?.revision).toBeGreaterThan(page.page.revision);
});

test('a repeated total or foreign page token cannot be hidden by a correct first page', async () => {
  for (const defect of ['total', 'token'] as const) {
    const f = fixture(); const read = f.ports.page;
    f.ports.page = async input => { const p = await read(input); if (input.after) {
      if (defect === 'total') p.total_raw = '5'; else p.token.incarnation = 'e'.repeat(32);
    } return p; };
    await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow('unavailable');
    expect(f.storage.value).toBeNull(); expect(owned(f).catalog).toBeUndefined(); expect(owned(f).reservations.size).toBe(0);
  }
});

test('a cache replaced by the second load keeps the first observation charged, then only its own durable ticket', async () => {
  const f = fixture(); const version = f.ports.version; let changed = false;
  let firstTickets: symbol[] = [], oldCache: symbol | undefined;
  f.ports.version = async input => {
    if (!input.expected_token && !changed) {
      changed = true; oldCache = owned(f).catalog?.ticket;
      firstTickets = [...owned(f).reservations.keys()].slice(0, -1).filter(ticket => ticket !== oldCache);
      f.rows[0].description = 'Mutation between the pair'; f.bump();
    }
    return version(input);
  };
  const read = f.ports.page;
  f.ports.page = async input => {
    if (changed && !input.after) {
      expect(owned(f).reservations.has(oldCache!)).toBe(false);
      // Retiring the cache does not retire the still-live first observation.
      if (f.reads.page === 3) expect(firstTickets.every(ticket => owned(f).reservations.has(ticket))).toBe(true);
    }
    return read(input);
  };
  expect((await f.captures.refreshHostCatalogs()).error).toBeUndefined();
  expect(f.reads.page).toBe(9);
  expect(owned(f).reservations.size).toBe(1);
  expect(owned(f).reservations.has(owned(f).catalog!.ticket)).toBe(true);
  f.reset(); await f.captures.refreshCatalogMetadata(); expect(f.reads.page).toBe(0);
});

test('CAS loss retries a fresh pair and exhausted or exceptional attempts leave no cache ticket', async () => {
  for (const failure of ['once', 'always', 'throw'] as const) {
    const f = fixture(); const commit = f.deps.storage.compareAndSwap; let calls = 0;
    f.deps.storage.compareAndSwap = async (before, next) => {
      calls++;
      if (failure === 'throw') throw Error('synthetic storage failure');
      return failure === 'once' && calls > 1 ? commit(before, next) : false;
    };
    if (failure === 'once') {
      await f.captures.refreshCatalogMetadata(); expect(calls).toBe(2); expect(f.reads.page).toBe(6);
      expect(owned(f).reservations.size).toBe(1); expect(owned(f).reservations.has(owned(f).catalog!.ticket)).toBe(true);
    } else {
      await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow(failure === 'always' ? 'content_unavailable' : 'unavailable');
      expect(owned(f).catalog).toBeUndefined(); expect(owned(f).reservations.size).toBe(0);
    }
  }
});

for (const boundary of ['digest', 'CAS'] as const) test(`clear during ${boundary} retires the cache and late completion`, async () => {
  const f = fixture(); const gate = barrier(); let once = true;
  const hash = crypto.subtle.digest.bind(crypto.subtle);
  const spy = boundary === 'digest' ? spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    const result = await hash(...args); if (once) { once = false; await gate.wait(); } return result;
  }) : undefined;
  if (boundary === 'CAS') f.deps.storage.compareAndSwap = async () => { await gate.wait(); return true; };
  try {
    const pending = f.captures.refreshCatalogMetadata(); await gate.reached;
    f.captures.clear(); gate.release(); await expect(pending).rejects.toThrow('unavailable');
    expect(owned(f).catalog).toBeUndefined(); expect(owned(f).reservations.size).toBe(0); expect(owned(f).captures.size).toBe(0);
  } finally { spy?.mockRestore(); }
});

test('a generation discovered after quota eviction still retires retained captures', async () => {
  const f = fixture(); const snapshot = await f.captures.conversationsList(scope, 'conversation');
  f.ports.page = async () => { throw 'resource_limit'; }; f.bump();
  await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow('resource_limit');
  expect(owned(f).catalog).toBeUndefined(); expect(owned(f).captures.size).toBe(1);
  f.restore(); f.ports.page = async () => ({ token: f.token(), total_raw: '0', items: [], next_after: null, admission_estimate_bytes: 0 });
  await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow('unavailable');
  expect(owned(f).captures.has(snapshot.page.snapshot_id)).toBe(false); expect(owned(f).reservations.size).toBe(0);
});

test('journal admission precedes parsing and digest admission precedes hashing', async () => {
  const f = fixture(); f.deps.storage.load = async () => ' '.repeat(CONTENT_BUDGET.conversations);
  const parse = spyOn(JSON, 'parse');
  try {
    await expect(f.captures.refreshCatalogMetadata()).rejects.toThrow('resource_limit'); expect(parse).not.toHaveBeenCalled(); expect(f.reads.page).toBe(0);
  } finally { parse.mockRestore(); }
  const g = fixture(); const version = g.ports.version; const sha = spyOn(crypto.subtle, 'digest');
  g.ports.version = async input => {
    const result = await version(input);
    if (input.expected_token) g.deps.quotaBytes = [...owned(g).reservations.values()].reduce((n, b) => n + b, 0);
    return result;
  };
  try {
    await expect(g.captures.refreshCatalogMetadata()).rejects.toThrow('resource_limit'); expect(sha).not.toHaveBeenCalled();
    expect(owned(g).catalog).toBeUndefined(); expect(owned(g).reservations.size).toBe(0);
  } finally { sha.mockRestore(); }
});

test('the admission walk counts escaped keys and recursive canonical fragments without serializing', () => {
  const value = { 'escaped\nkey': [{ hidden: '\u0000\\"\u{10000}' }], optional: undefined };
  const stringify = spyOn(JSON, 'stringify'); let cost: ReturnType<typeof captureCost>;
  try {
    cost = captureCost(value, 1024 * 1024); expect(stringify).not.toHaveBeenCalled();
    expect(() => captureCost({ large: 'x'.repeat(1000) }, 1024)).toThrow('resource_limit');
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => captureCost(cycle, 1024)).toThrow('unavailable');
  } finally { stringify.mockRestore(); }
  const canonical = stableJson(value);
  expect(cost!.scratch).toBeGreaterThan(2 * Buffer.byteLength(canonical));
  expect(cost!.retained).toBeGreaterThan(Buffer.byteLength(canonical));
  expect(parsedCaptureCost(JSON.stringify(value), 1024 * 1024)).toBeGreaterThan(Buffer.byteLength(canonical));
});
