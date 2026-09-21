import { expect, test } from 'bun:test';
import { ContentHost } from './contentHost';
import { TaskCompletionHost, type TaskCompletionSource } from './taskCompletionHost';
import type { ContentDelivery, ContentEvent, ContentTaskDetails, ContentTaskRef } from './contentProtocol';
const ref: ContentTaskRef = { instance_id: 'instance:demo', workspace_id: 'workspace:demo', task_id: 'task:demo' };
const policy = { revision: 'visible-1', secrets: ['secret-demo'] };
const text = (text: string) => ({ content_state: 'complete' as const, text });
function setup() {
  let persisted: string | null = null; let version = 1; let calls = 0; let clock = 0;
  let changeOnEffect = true; let body = 'é'.repeat(10000); let effectFailure: string | null = null;
  const events: ContentEvent['change'][] = [];
  const task: Omit<ContentTaskDetails, 'ref' | 'snapshot_id' | 'revision' | 'expires_at'> = {
    title: text('Demo'), description: text('Synthetic description'), source: 'standalone', status: 'Pending', draft: false,
    plan_title: null, feature: null, task_kind: 'feature', archived: false, merged: false, finalization: false, merge_state: null,
    actions: ['rename'], commands: [],
  };
  const source: TaskCompletionSource = { cards: async () => [{ ...task, ref }], load: async kind => ({ fingerprint: version,
    ...(kind === 'task' ? { task } : { items: Array.from({ length: 51 }, (_, position) => ({ artifact_id: `artifact:${position}`, position,
      title: text('Artifact'), summary: text('Demo'), visibility: 'own' as const, content_type: 'text' })), read: async () => body }),
  }), execute: async (_ref, _action, _title, beforeEffect) => { await beforeEffect(); calls++; if (effectFailure) throw new Error(effectFailure); if (changeOnEffect) version++; } };
  const deps = { source, storage: { load: async () => persisted, compareAndSwap: async (old: string | null, next: string) => {
    if (old !== persisted) return false; persisted = next; return true;
  } }, now: () => clock, emit: async (change: ContentEvent['change']) => { events.push(change); } };
  const host = new TaskCompletionHost(deps);
  const delivery = (operation: string, body: unknown, session = 'session:demo') => ({ transport_version: '2.0', type: 'delivery',
    request_id: 'request:demo', instance_id: ref.instance_id, account_id: 'account:demo', source_session_id: session,
    expires_at: '2030-01-01T00:00:00Z', request: { contract_version: '2.0', type: 'request', request_id: 'request:demo', account_id: 'account:demo', operation, body },
  }) as ContentDelivery;
  const read = (operation: string, body: unknown, session?: string) => host.handle(delivery(operation, body, session), policy, async () => {});
  return { host, deps, read, events, calls: () => calls, change: () => version++, setBody: (s: string) => { body = s; },
    expire: () => { clock = 300001; }, unchangedEffect: () => { changeOnEffect = false; }, failEffect: (code = 'unavailable') => { effectFailure = code; }, persisted: () => persisted };
}
test('pages and UTF-8 details are bound to scope, revision, policy and expiry', async () => {
  const s = setup(); await s.host.initialize();
  const first = await s.read('task.artifacts.list', { ref }) as { page: { snapshot_id: string; next_cursor: string }; items: unknown[] };
  expect(first.items.length).toBe(50);
  const continuation = { snapshot_id: first.page.snapshot_id, cursor: first.page.next_cursor };
  const next = await s.read('task.artifacts.list', { ref, continuation }) as { items: unknown[] };
  expect(next.items.length).toBe(1);
  await expect(s.read('task.artifacts.list', { ref, continuation }, 'session:other')).rejects.toThrow('snapshot_expired');
  const request = { ref, snapshot_id: first.page.snapshot_id, item_id: 'artifact:0', offset_bytes: 0 };
  const chunk = await s.read('task.artifact.read', request) as { next_offset_bytes: number; content: { text: string } };
  expect(chunk.next_offset_bytes).toBe(16384); expect(chunk.content.text).toBe('é'.repeat(8192));
  await expect(s.read('task.artifact.read', { ...request, offset_bytes: 1 })).rejects.toThrow('validation_failed');
  s.setBody('changed without index update');
  await expect(s.read('task.artifact.read', request)).rejects.toThrow('stale_revision');
  s.change();
  await expect(s.read('task.artifacts.list', { ref, continuation })).rejects.toThrow('stale_revision');
  expect(s.events[0].kind).toBe('task.changed');
  s.expire(); await expect(s.read('task.artifacts.list', { ref, continuation })).rejects.toThrow('snapshot_expired');
});
test('inspects the whole body before excerpting and never persists content', async () => {
  const s = setup(); await s.host.initialize(); s.setBody('a'.repeat(20000) + 'secret-demo');
  const page = await s.read('task.artifacts.list', { ref }) as { page: { snapshot_id: string } };
  const result = await s.read('task.artifact.read', { ref, snapshot_id: page.page.snapshot_id, item_id: 'artifact:0', offset_bytes: 0 }) as { content: unknown; total_bytes: number };
  expect(result.content).toEqual({ content_state: 'withheld', reason: 'unsafe_content' }); expect(result.total_bytes).toBe(0);
  expect(s.persisted()).not.toContain('Synthetic description'); expect(s.persisted()).not.toContain('secret-demo');
});
test('actions reauthorize before effects and retain idempotence across restart', async () => {
  const s = setup(); await s.host.initialize();
  const capture = await s.read('task.get', { ref }) as ContentTaskDetails;
  const body = { ref, snapshot_id: capture.snapshot_id, expected_revision: capture.revision, idempotency_key: 'action:demo', action: 'rename', confirmation: 'confirm_task_action', title: 'New' };
  expect(await s.read('task.action', body)).toEqual({ outcome: 'applied', revision: 2 });
  expect(await s.read('task.action', body)).toEqual({ outcome: 'duplicate', revision: 2 }); expect(s.calls()).toBe(1);
  const restarted = new TaskCompletionHost(s.deps); await restarted.initialize();
  const original = s.host; Object.assign(original, restarted);
  expect(await s.read('task.action', body)).toEqual({ outcome: 'duplicate', revision: 2 }); expect(s.calls()).toBe(1);
  await expect(s.read('task.action', { ...body, title: 'Other' })).rejects.toThrow('conflict');
});
test.each(['content_unavailable', 'forbidden', 'stale_revision'])('partial effects followed by %s require inspection, never a fresh retry', async code => {
  const s = setup(); await s.host.initialize(); s.failEffect(code);
  const capture = await s.read('task.get', { ref }) as ContentTaskDetails;
  const body = { ref, snapshot_id: capture.snapshot_id, expected_revision: capture.revision, idempotency_key: 'action:demo', action: 'rename', confirmation: 'confirm_task_action', title: 'New' };
  await expect(s.read('task.action', body)).rejects.toThrow('conflict');
  expect(s.calls()).toBe(1);
  expect(Object.values(JSON.parse(s.persisted()!).receipts)[0]).toMatchObject({ state: 'pending' });
  await expect(s.read('task.action', body)).rejects.toThrow('conflict'); expect(s.calls()).toBe(1);
});
test('cards are paged separately from command and detail preparation', async () => {
  const s = setup(); await s.host.initialize();
  const result = await s.read('task.cards.list', { instance_id: ref.instance_id }) as { page: { total: number }; items: Array<Record<string, unknown>> };
  expect(result.page.total).toBe(1); expect(result.items[0].description).toEqual(text('Synthetic description'));
});
test('revoked authorization at the effect boundary consumes the key without running the effect', async () => {
  const s = setup(); await s.host.initialize();
  const capture = await s.read('task.get', { ref }) as ContentTaskDetails;
  const body = { ref, snapshot_id: capture.snapshot_id, expected_revision: capture.revision, idempotency_key: 'action:revoked', action: 'rename', confirmation: 'confirm_task_action', title: 'New' };
  const delivery = { transport_version: '2.0', type: 'delivery', request_id: 'request:demo', instance_id: ref.instance_id,
    account_id: 'account:demo', source_session_id: 'session:demo', expires_at: '2030-01-01T00:00:00Z',
    request: { contract_version: '2.0', type: 'request', request_id: 'request:demo', account_id: 'account:demo', operation: 'task.action', body } } as ContentDelivery;
  let checks = 0;
  await expect(s.host.handle(delivery, policy, async () => { if (++checks > 1) throw new Error('forbidden'); })).rejects.toThrow('conflict');
  expect(s.calls()).toBe(0);
  await expect(s.read('task.action', body)).rejects.toThrow('conflict');
});

test('unchanged successful effects advance the persisted revision of later reads', async () => {
  const s = setup(); await s.host.initialize(); s.unchangedEffect();
  const before = await s.read('task.get', { ref }) as ContentTaskDetails;
  const result = await s.read('task.action', { ref, snapshot_id: before.snapshot_id, expected_revision: before.revision,
    idempotency_key: 'action:unchanged', action: 'rename', title: 'Demo', confirmation: 'confirm_task_action' }) as { revision: number };
  const after = await s.read('task.get', { ref }) as ContentTaskDetails;
  expect(result.revision).toBe(before.revision + 1); expect(after.revision).toBe(result.revision);
});
test('enforces the shared body budget across distinct items and keeps rejected reads from poisoning captures', async () => {
  const s = setup(); await s.host.initialize(); s.setBody('x'.repeat(1024 * 1024));
  const page = await s.read('task.artifacts.list', { ref }) as { page: { snapshot_id: string } };
  let accepted = 0;
  for (let index = 0; index < 9; index++) {
    try { await s.read('task.artifact.read', { ref, snapshot_id: page.page.snapshot_id, item_id: `artifact:${index}`, offset_bytes: 0 }); accepted++; }
    catch (error) { expect((error as Error).message).toBe('resource_limit'); }
  }
  expect(accepted).toBeGreaterThan(0); expect(accepted).toBeLessThan(9);
  await expect(s.read('task.artifact.read', { ref, snapshot_id: page.page.snapshot_id, item_id: 'artifact:0', offset_bytes: 16384 })).resolves.toBeDefined();
});

test('source loss invalidations advance revisions before a source becomes available again', async () => {
  const s = setup(); await s.host.initialize();
  const before = await s.read('task.get', { ref }) as ContentTaskDetails;
  const originalLoad = s.deps.source.load;
  s.deps.source.load = async () => { throw new Error('not_found'); };
  await s.host.observe(policy);
  const invalidation = s.events.at(-1)!;
  expect(invalidation.revision).toBeGreaterThan(before.revision);
  s.deps.source.load = originalLoad;
  const restored = await s.read('task.get', { ref }) as ContentTaskDetails;
  expect(restored.revision).toBeGreaterThan(invalidation.revision);
});

test('a post-action policy change is a conflict at the transport boundary', async () => {
  const s = setup(); let changedPolicy = false; let hostJournal: string | null = null;
  const original = s.deps.source.execute;
  s.deps.source.execute = async (...args) => { await original(...args); changedPolicy = true; };
  const host = new ContentHost({ accountId: 'account:demo', instanceId: ref.instance_id, signal: new AbortController().signal,
    conversations: { clear: () => {} } as never, reviews: {} as never,
    storage: { load: async () => hostJournal, compareAndSwap: async (old, next) => { if (old !== hostJournal) return false; hostJournal = next; return true; } },
    commitReview: async () => false, reviewRefs: async () => [], resolveReview: async () => { throw new Error('unused'); },
    policy: async () => ({ revision: 'visible-1', secrets: changedPolicy ? ['new-policy-secret'] : [] }),
    taskCompletion: { source: s.deps.source, storage: s.deps.storage }, now: () => 0,
  });
  await host.initialize();
  const request = (operation: string, body: unknown) => ({ transport_version: '2.0', type: 'delivery', request_id: 'request:demo',
    instance_id: ref.instance_id, account_id: 'account:demo', source_session_id: 'session:demo', expires_at: '2030-01-01T00:00:00Z',
    request: { contract_version: '2.0', type: 'request', request_id: 'request:demo', account_id: 'account:demo', operation, body } });
  const authorize = async () => new Date(5000).toISOString();
  const get = await host.handle(request('task.get', { ref }), authorize);
  const capture = (get.response as { result: ContentTaskDetails }).result;
  const result = await host.handle(request('task.action', { ref, snapshot_id: capture.snapshot_id, expected_revision: capture.revision,
    idempotency_key: 'action:policy-change', action: 'rename', title: 'Renamed', confirmation: 'confirm_task_action' }), authorize);
  expect(s.calls()).toBe(1);
  expect(result.response).toMatchObject({ type: 'error', code: 'conflict', retryable: false });
  expect(Object.values(JSON.parse(s.persisted()!).receipts)[0]).toMatchObject({ state: 'applied' });
});
