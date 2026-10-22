import { expect, it } from 'bun:test';
import { ConversationCaptures, type CaptureDependencies } from './conversationCaptures';
import { ContentHost } from './contentHost';
import { createReviewCaptureService } from './reviewCapture';
import type { ContentEvent } from './contentProtocol';
import type { DbConversation } from '../tauriIpc';

const memory = () => {
  let value: string | null = null;
  return { load: async () => value, compareAndSwap: async (before: string | null, next: string) => {
    if (before !== value) return false;
    value = next; return true;
  } };
};
function fixture() {
  const reads = { projects: 0, conversations: 0 };
  const projects = [{ id: 'project', name: 'Synthetic project' }];
  const conversations: DbConversation[] = [{ id: 'chat', title: 'Synthetic chat', description: null, scope_mode: 'Chat',
    project_id: null, task_id: null, group_id: null, provider_id: null, model_id: null, reasoning_effort: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', last_message: null, message_count: 0, is_pinned: false }];
  const storage = memory();
  const deps: CaptureDependencies = { instanceId: 'instance', workspaceId: 'workspace', storage,
    policy: () => ({ revision: 'visible-1', secrets: [] }), source: {
      projects: async () => { reads.projects++; return structuredClone(projects); }, tasks: async () => [],
      listConversations: async () => { reads.conversations++; return structuredClone(conversations); },
      listMessages: async () => [], getConversation: async id => conversations.find(c => c.id === id) ?? null,
      activity: () => ({ activity: 'idle', generatingMessageId: null }),
    } };
  const captures = new ConversationCaptures(deps);
  const host = new ContentHost({ accountId: 'account', instanceId: 'instance', signal: new AbortController().signal,
    conversations: captures, reviews: createReviewCaptureService(), storage: memory(), policy: async () => deps.policy(),
    commitReview: async () => false, reviewRefs: async () => [], resolveReview: async () => { throw Error('not_found'); } });
  return { reads, projects, conversations, storage, deps, captures, host };
}
it('uses two project source reads in real host preparation and stable observation', async () => {
  const f = fixture();
  try {
    await f.host.initialize(); await f.host.prepare();
    expect(f.reads).toEqual({ projects: 2, conversations: 2 });
    f.reads.projects = 0; f.reads.conversations = 0;
    await f.host.observe();
    expect(f.reads).toEqual({ projects: 2, conversations: 2 });
    const events: ContentEvent[] = []; await f.host.flush(async event => { events.push(event); }); expect(events).toEqual([]);
  } finally { await f.host.dispose(); }
});

it('preserves separate project and conversation clocks exactly against the existing observations', async () => {
  const old = fixture(), shared = fixture();
  const mutations = [() => {}, () => {}, () => {
    old.projects[0].name = shared.projects[0].name = 'Renamed project';
  }, () => {
    old.conversations[0].title = shared.conversations[0].title = 'Renamed conversation';
  }, () => { old.conversations.length = shared.conversations.length = 0; }];
  for (const mutate of mutations) {
    mutate();
    const projects = await old.captures.refreshProjects(); const conversations = await old.captures.refreshCatalog();
    const combined = await shared.captures.refreshHostCatalogs();
    expect(combined).toEqual({ projects, conversations });
    expect(JSON.parse((await shared.storage.load())!)).toEqual(JSON.parse((await old.storage.load())!));
  }
});
it('still emits an independently valid project change when the conversation source fails', async () => {
  const f = fixture();
  try {
    await f.host.initialize(); await f.host.prepare();
    f.projects[0].name = 'Changed project';
    f.deps.source.listConversations = async () => { throw Error('content_unavailable'); };
    await expect(f.host.observe()).rejects.toThrow('content_unavailable');
    const events: ContentEvent[] = []; await f.host.flush(async event => { events.push(event); });
    expect(events.map(event => event.change.kind)).toEqual(['projects.changed']);
    const revision = events[0].change.revision;
    expect(await f.captures.refreshProjects()).toBe(revision);
  } finally { await f.host.dispose(); }
});
it('retries a conflicting CAS with a fresh pair rather than publishing a mixed catalog', async () => {
  const f = fixture(); let attempts = 0;
  const original = f.storage.compareAndSwap;
  f.storage.compareAndSwap = async (before, next) => {
    if (++attempts === 1) { f.projects[0].name = 'New source'; f.conversations[0].title = 'New source'; return false; }
    return original(before, next);
  };
  const combined = await f.captures.refreshHostCatalogs();
  expect(combined.error).toBeUndefined(); expect(attempts).toBe(2);
  expect(f.reads).toEqual({ projects: 4, conversations: 4 });
  const reference = fixture(); reference.projects[0].name = 'New source'; reference.conversations[0].title = 'New source';
  await reference.captures.refreshProjects(); await reference.captures.refreshCatalog();
  expect(JSON.parse((await f.storage.load())!)).toEqual(JSON.parse((await reference.storage.load())!));
});
it('retires an in-flight observation on clear without starting a fallback in the new epoch', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = f.deps.source.projects;
  f.deps.source.projects = async () => { entered(); await gate; return original(); };
  const pending = f.captures.refreshHostCatalogs(); await started;
  f.captures.clear(); release();
  await expect(pending).rejects.toThrow('unavailable');
  expect(await f.storage.load()).toBeNull(); expect(f.reads.projects).toBe(1); // Stop immediately after the invalidated await.
});
it('keeps the verified project pair and retries a source change during assembly', async () => {
  const f = fixture(); const original = f.deps.source.projects; let calls = 0;
  f.deps.source.projects = async () => { if (++calls === 2) f.projects[0].name = 'Changed between reads'; return original(); };
  expect((await f.captures.refreshHostCatalogs()).error).toBeUndefined();
  expect(f.reads).toEqual({ projects: 4, conversations: 4 });
  const revision = await f.captures.refreshProjects(); expect(revision).toBe(1);
});
it('retains the exact sequenced event after an ACK failure with simultaneous catalog changes', async () => {
  const f = fixture();
  try {
    await f.host.initialize(); await f.host.prepare();
    f.projects[0].name = 'Project changed'; f.conversations[0].title = 'Chat changed';
    await f.host.observe(); let first: ContentEvent | undefined;
    await expect(f.host.flush(async event => { first = event; throw Error('lost ACK'); })).rejects.toThrow('lost ACK');
    const events: ContentEvent[] = []; await f.host.flush(async event => { events.push(event); });
    if (!first) throw Error('expected delivery');
    expect(events[0]).toEqual(first);
    expect(events.map(event => event.change.kind)).toEqual(['projects.changed', 'conversations.changed', 'conversation.changed']);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
  } finally { await f.host.dispose(); }
});
