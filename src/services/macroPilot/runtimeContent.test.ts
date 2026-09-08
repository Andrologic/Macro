import { afterAll, beforeEach, expect, it, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ContentCapture, ContentDelivery, ContentDeliveryResult, ContentEvent, ContentRequest } from './contentProtocol';
import type { DbConversation, DbMessage } from '../tauriIpc';

const settings = new Map<string, string>();
const nativeCalls: string[] = [];
let supported = true;
let nativeRevision = 'a'.repeat(64);
let fresh = true;
let secretValues = ['configured-password'];
let repoPath = '/private/test-repository';
let bridge: ((command: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
let beforeFresh: (() => void) | undefined;
let nativeFailure: string | undefined;
let captureWait: Promise<void> | undefined;
let messageWait: Promise<void> | undefined;
let messagesUnavailable = false;
let taskRecords: Array<Record<string, unknown>> = [];
let branchRecords: Array<{ name: string; commit: string }> = [];
const conversation: DbConversation = { id: 'chat:one', title: 'Global chat', description: null, scope_mode: 'Chat', task_id: null, project_id: null, group_id: null, provider_id: null, model_id: null, reasoning_effort: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', last_message: null, message_count: 1, is_pinned: false };
let conversations: DbConversation[] = [];
let messages: DbMessage[] = [];
const nativeSnapshots = new Map<string, Record<string, unknown>>();
const core = await import('@tauri-apps/api/core');
mock.module('@tauri-apps/api/core', () => ({ ...core, invoke: async (command: string, args: Record<string, unknown> = {}) => {
  nativeCalls.push(command);
  if (bridge && (command === 'db_get_app_setting' || command === 'db_compare_and_swap_app_setting' || command === 'pilot_review_commit')) return bridge(command, args);
  if (command === 'db_get_app_setting') return settings.has(String(args.key)) ? { value_json: settings.get(String(args.key)) } : null;
  if (command === 'db_compare_and_swap_app_setting') {
    const applied = (settings.get(String(args.key)) ?? null) === args.expectedValueJson;
    if (applied) settings.set(String(args.key), String(args.valueJson));
    return { applied };
  }
  if (command === 'pilot_content_policy') { if (!supported) throw 'content_unavailable'; return secretValues; }
  if (command === 'workspace_get_bootstrap') return { standaloneProjects: [{ id: 'project:one', name: 'Project', path: repoPath }], projectGroups: [{ id: 'closed', isOpen: false, projects: [{ id: 'project:closed', name: 'Closed', path: '/private/closed' }] }] };
  if (command === 'workspace_list_tasks') return { tasks: taskRecords };
  if (command === 'git_branch_list') return { local: branchRecords, remote: [] };
  if (command === 'db_list_conversations') return structuredClone(conversations);
  if (command === 'db_get_conversation') return structuredClone(conversations.find(c => c.id === args.id) ?? null);
  if (command === 'db_list_messages') { if (messagesUnavailable) throw 'unavailable'; await messageWait; return structuredClone(messages.filter(message => message.conversation_id === args.conversationId)); }
  if (command === 'pilot_review_commit') {
    const input = args.input as { snapshotId: string; key: string; expectedValueJson: string | null; valueJson: string };
    beforeFresh?.();
    const nativeInput = args.input as { branches?: { base: string; head: string }; request: { source: { kind: string; base_sha?: string; head_sha?: string } } };
    if (nativeInput.request.source.kind === 'commits' && (
      branchRecords.find(branch => branch.name === nativeInput.branches?.base)?.commit !== nativeInput.request.source.base_sha ||
      branchRecords.find(branch => branch.name === nativeInput.branches?.head)?.commit !== nativeInput.request.source.head_sha)) throw 'stale_revision';
    if (bridge) {
      const ok = await bridge('pilot_review_fresh', { snapshotId: input.snapshotId, request: (args.input as { request: unknown }).request });
      if (!ok) throw 'stale_revision';
    } else if (!fresh) throw 'stale_revision';
    const applied = (settings.get(input.key) ?? null) === input.expectedValueJson;
    if (applied) settings.set(input.key, input.valueJson);
    return applied;
  }
  if (command.startsWith('pilot_review_')) {
    if (bridge) return bridge(command, args);
    const id = String(args.snapshotId);
    if (command === 'pilot_review_capture') {
      if (nativeFailure) throw nativeFailure;
      const request = args.request as { source: unknown };
      const observed = Date.now();
      const info = { snapshot_id: crypto.randomUUID(), revision_token: nativeRevision, source: request.source, head_sha: null,
        observed_at: new Date(observed).toISOString(), expires_at: new Date(observed + 300_000).toISOString(), export_policy_revision: 'visible-1', availability: 'complete', file_count: 1 };
      nativeSnapshots.set(info.snapshot_id, info); await captureWait; return info;
    }
    if (command === 'pilot_review_release') { nativeSnapshots.delete(id); return; }
    if (!nativeSnapshots.has(id)) throw 'snapshot_expired';
    if (command === 'pilot_review_fresh') { beforeFresh?.(); return fresh; }
    if (command === 'pilot_review_files') return { capture: nativeSnapshots.get(id), offset: 0, total: 1, next_cursor: null, items: [{ file_id: 'file:one', position: 0, old_path: 'hello.txt', new_path: 'hello.txt', change: 'modified', content_state: 'text', patch_bytes: 6 }] };
    if (command === 'pilot_review_read') return { snapshot_id: id, file_id: 'file:one', offset_bytes: 0, next_offset_bytes: null, total_bytes: 6, patch: '+hello' };
  }
  throw new Error(`Unexpected test IPC: ${command}`);
} }));
afterAll(() => mock.restore());
const { PilotRuntime } = await import('./runtime');
const { MacroPilotNativeClient } = await import('./nativeClient');
const { validateContentMessage } = await import('./contentProtocol');
const { useChatStore } = await import('../../stores/useChatStore');
const { CONTENT_BUDGET } = await import('./contentHost');
const { secretForms } = await import('./desktopContentHost');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('condition timed out'); await sleep(10); } }
const instanceId = 'instance:test';
const accountId = 'account:github:1';
const ref = { instance_id: instanceId, workspace_id: 'workspace:config:test', task_id: 'task:one', project_id: 'project:one', review_id: 'review:unstaged' };
let requestSequence = 0;
function request(operation: ContentRequest['operation'], body: unknown, requestId = `request:${++requestSequence}`): ContentRequest {
  return { contract_version: '2.0', type: 'request', account_id: accountId, request_id: requestId, operation, body } as ContentRequest;
}
function harness() {
  const account = { contract_version: '1.0', type: 'account', account_id: accountId, identity: { provider: 'github', subject: '1', login: 'test' }, revision: 1 };
  const session = { contract_version: '1.0', type: 'device_session', ref: { type: 'session', account_id: accountId, session_id: 'session:desktop' }, device_id: 'device:desktop', state: 'active', issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), revision: 1 };
  const values: Record<string, unknown> = { macro_pilot_native_v1: { configurationId: 'config:test', relayOrigin: 'https://pilot.example.test', account, deviceSession: session,
    instance: { contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: instanceId }, label: 'Test', connection_state: 'reachable', supported_contract_versions: ['1.0'], revision: 1 }, instanceCreationId: 'creation:test' } };
  const queue: ContentDelivery[] = [];
  const results: ContentDeliveryResult[] = [];
  const events: ContentEvent[] = [];
  const requests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  let wake: (() => void) | undefined;
  let loseResult = false;
  let loseEvent = false;
  let revoked = false;
  let eventWait: Promise<void> | undefined;
  let onAuthorize: (() => void) | undefined;
  const client = new MacroPilotNativeClient({
    randomBytes: size => crypto.getRandomValues(new Uint8Array(size)),
    sha256: async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value))),
    now: () => new Date(),
    getStateSnapshot: async () => ({ schemaVersion: 1, values }),
    setStateValue: async (key, value) => { values[key] = structuredClone(value); return { schemaVersion: 1, values }; },
    secretRead: async () => 'd'.repeat(43), secretWrite: async () => {}, secretDelete: async () => {},
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ path, body, headers });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'x-request-id': (data as { request_id?: string }).request_id ?? headers.get('x-request-id')! } });
      if (path.endsWith('/me')) return json({ account, device_session: session });
      if (path.endsWith('/disconnect') || path.endsWith('/logout')) return new Response(null, { status: 204 });
      const signal = init?.signal;
      if (path.endsWith('/poll')) {
        if (path.includes('/v1/')) { await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); }); throw Error('aborted'); }
        while (!queue.length && !signal?.aborted) await new Promise<void>(resolve => { wake = resolve; signal?.addEventListener('abort', () => resolve(), { once: true }); });
        if (signal?.aborted) throw Error('aborted');
        return json(queue.shift()!);
      }
      if (path.endsWith('/authorize')) {
        onAuthorize?.();
        if (revoked) return json({ code: 'session_revoked' }, 401);
        return json({ transport_version: '2.0', type: 'authorized', request_id: body.request_id, execute_before: new Date(Date.now() + 5000).toISOString() });
      }
      if (path.endsWith('/result')) {
        results.push(structuredClone(body) as unknown as ContentDeliveryResult);
        if (loseResult) { loseResult = false; throw Error('lost response'); }
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/events')) {
        events.push(structuredClone(body) as unknown as ContentEvent);
        await eventWait;
        if (loseEvent) { loseEvent = false; throw Error('lost acknowledgement'); }
        return new Response(null, { status: 204 });
      }
      throw Error(`Unexpected HTTP: ${path}`);
    },
  });
  const runtime = new PilotRuntime(client);
  async function deliver(input: ContentRequest, source = 'session:mobile') {
    const delivery: ContentDelivery = { transport_version: '2.0', type: 'delivery', request_id: input.request_id, instance_id: instanceId, account_id: accountId, source_session_id: source, expires_at: new Date(Date.now() + 60_000).toISOString(), request: input };
    expect(validateContentMessage(delivery)).toBe(true);
    const start = results.length; queue.push(delivery); wake?.();
    await until(() => results.slice(start).some(result => result.request_id === input.request_id));
    const result = results.slice(start).find(result => result.request_id === input.request_id)!;
    expect(validateContentMessage(result)).toBe(true); return result.response;
  }
  return { client, runtime, deliver, results, events, requests, values,
    waitEvents: (wait: Promise<void>) => { eventWait = wait; },
    loseResult: () => { loseResult = true; }, loseEvent: () => { loseEvent = true; }, revoke: () => { revoked = true; },
    authorize: (callback: () => void) => { onAuthorize = callback; } };
}
beforeEach(() => {
  settings.clear(); nativeCalls.length = 0; nativeSnapshots.clear(); supported = true; fresh = true; bridge = undefined; beforeFresh = undefined;
  nativeFailure = undefined; captureWait = undefined; messageWait = undefined; messagesUnavailable = false; branchRecords = [];
  taskRecords = [{ id: 'task:one', project_id: 'project:one', status: 'Todo', execution_targets: [] }];
  nativeRevision = 'a'.repeat(64); secretValues = ['configured-password']; repoPath = '/private/test-repository';
  conversations = [structuredClone(conversation)];
  messages = [{ id: 'message:user', conversation_id: conversation.id, role: 'user', content: 'Hello from persistence', created_at: conversation.created_at, token_count: null, tool_traces_json: null, hidden_context: '/private/hidden', provider_input_items_json: null, provider_turn_state_json: null }];
});
it('runs all content operations through the real runtime/client/IPC, retries verbatim and persists idempotent verdicts', async () => {
  const h = harness(); const chatState = useChatStore.getState();
  try {
    await h.runtime.start();
    const projects = await h.deliver(request('projects.list', { instance_id: instanceId }));
    expect(projects).toMatchObject({ type: 'response', result: { items: [{ project_id: 'project:closed' }, { project_id: 'project:one' }] } });
    const list = await h.deliver(request('conversations.list', { instance_id: instanceId, kind: 'conversation' }));
    expect(list).toMatchObject({ type: 'response', result: { items: [{ ref: { kind: 'conversation', conversation_id: conversation.id } }] } });
    const read = await h.deliver(request('conversation.read', { ref: { instance_id: instanceId, kind: 'conversation', conversation_id: conversation.id } }));
    expect(read).toMatchObject({ type: 'response', result: { items: [{ text: 'Hello from persistence' }] } });
    expect(JSON.stringify(read)).not.toContain('private'); expect(useChatStore.getState()).toBe(chatState);
    for (const kind of ['staged', 'unstaged', 'local_total']) {
      const r = await h.deliver(request('review.get', { ref: { ...ref, review_id: `review:${kind}` } }));
      expect(r).toMatchObject({ type: 'response', result: { source: { kind, head_sha: null } } });
      expect(JSON.stringify(r)).not.toContain('revision_token');
    }
    const get = request('review.get', { ref });
    h.loseResult();
    const got = await h.deliver(get);
    expect(got.type).toBe('response'); if (got.type !== 'response' || got.operation !== 'review.get') throw Error('review');
    await until(() => h.results.filter(result => result.request_id === get.request_id).length === 2);
    expect(h.results.at(-1)).toEqual(h.results.at(-2));
    const redelivery = await h.deliver(get); expect(redelivery).toEqual(got);
    const capture = got.result;
    const files = await h.deliver(request('diff.files', { ref, snapshot_id: capture.snapshot_id }));
    expect(files).toMatchObject({ type: 'response', result: { items: [{ file_id: 'file:one' }] } });
    const patch = await h.deliver(request('diff.read', { ref, snapshot_id: capture.snapshot_id, file_id: 'file:one', offset_bytes: 0 }));
    expect(patch).toMatchObject({ type: 'response', result: { patch: '+hello', snapshot_id: capture.snapshot_id } });
    const foreign = await h.deliver(request('diff.files', { ref, snapshot_id: capture.snapshot_id }), 'session:other');
    expect(foreign).toMatchObject({ type: 'error', code: 'snapshot_expired' });
    const verdictBody = { ref, snapshot_id: capture.snapshot_id, expected_revision: capture.revision, idempotency_key: 'verdict:one:unique', verdict: 'approve' };
    const verdict = await h.deliver(request('review.verdict', verdictBody));
    expect(verdict).toMatchObject({ type: 'response', result: { outcome: 'applied', revision: capture.revision + 1 } });
    await h.runtime.stop(); await h.runtime.start();
    const duplicate = await h.deliver(request('review.verdict', verdictBody));
    expect(duplicate).toMatchObject({ type: 'response', result: { outcome: 'duplicate', revision: capture.revision + 1 } });
    const conflict = await h.deliver(request('review.verdict', { ...verdictBody, verdict: 'request_changes' }));
    expect(conflict).toMatchObject({ type: 'error', code: 'conflict' });
    const persisted = [...settings.values()].join('');
    expect(persisted).not.toContain(repoPath); expect(persisted).not.toContain(secretValues[0]); expect(persisted).not.toContain('Hello from persistence');
    const contentRequests = h.requests.filter(r => r.path.includes('/v2/'));
    expect(contentRequests.length).toBeGreaterThan(10);
    for (const r of contentRequests) {
      expect(r.headers.get('authorization')).toBe(`Bearer ${'d'.repeat(43)}`); expect(r.headers.get('x-instance-key')).toBe('d'.repeat(43));
      if (r.body.request_id) expect(r.headers.get('x-request-id')).toBe(String(r.body.request_id));
    }
  } finally { await h.runtime.stop(); }
});
it('observes changes without remote reads, retries durable events and resets the stream on restart', async () => {
  const h = harness(); h.loseEvent();
  try {
    await h.runtime.start(); await until(() => h.events.length >= 2);
    expect(h.events[0]).toEqual(h.events[1]);
    const oldStream = h.events[0].stream_id;
    const oldRevision = h.events.find(e => e.change.kind === 'conversation.changed')?.change.revision ?? 0;
    messages[0].content = 'Changed while nobody is reading';
    await until(() => h.events.some(e => e.change.kind === 'conversation.changed' && e.change.revision > oldRevision));
    conversations = []; messages = [];
    await until(() => h.events.some(e => e.change.kind === 'conversation.removed'));
    await h.runtime.stop(); await h.runtime.start();
    await until(() => h.events.some(e => e.stream_id !== oldStream));
    expect(h.requests.filter(r => r.path.endsWith('/result'))).toHaveLength(0);
  } finally { await h.runtime.stop(); }
});
it('fails stale verdicts without requiring reads and keeps a revision on unchanged reads', async () => {
  const h = harness();
  try {
    await h.runtime.start();
    const a = await h.deliver(request('review.get', { ref }));
    const b = await h.deliver(request('review.get', { ref }));
    if (a.type !== 'response' || a.operation !== 'review.get' || b.type !== 'response' || b.operation !== 'review.get') throw Error('review');
    expect(a.result.revision).toBe(b.result.revision);
    fresh = false;
    const body = { ref, snapshot_id: b.result.snapshot_id, expected_revision: b.result.revision, idempotency_key: 'verdict:fresh:unique', verdict: 'request_changes' };
    expect(await h.deliver(request('review.verdict', body))).toMatchObject({ type: 'error', code: 'stale_revision' });
    fresh = true;
    expect(await h.deliver(request('review.verdict', body))).toMatchObject({ type: 'response', result: { outcome: 'applied' } });
    expect(nativeCalls).not.toContain('pilot_review_files'); expect(nativeCalls).not.toContain('pilot_review_read');
  } finally { await h.runtime.stop(); }
});
it('does not advertise content on an unsupported native platform while v1 remains running', async () => {
  supported = false; const h = harness();
  try {
    await h.runtime.start(); await until(() => nativeCalls.includes('pilot_content_policy')); await sleep(30);
    expect(h.requests.some(r => r.path.includes('/v1/') && r.path.endsWith('/poll'))).toBe(true);
    expect(h.requests.some(r => r.path.includes('/v2/'))).toBe(false);
  } finally { await h.runtime.stop(); }
});
it('drops content on revocation before emission and releases native captures', async () => {
  const h = harness();
  try {
    await h.runtime.start(); h.authorize(() => h.revoke());
    void h.deliver(request('review.get', { ref })).catch(() => undefined);
    await until(() => h.client.getState().deviceSession === null);
    await until(() => nativeSnapshots.size === 0);
    expect(h.results).toHaveLength(0);
  } finally { await h.runtime.stop(); }
});
it('refreshes configured raw and encoded secrets and shares a conservative aggregate cache budget', async () => {
  const h = harness();
  try {
    await h.runtime.start();
    const forms = secretForms(['configured-password']); expect(forms).toContain(btoa('configured-password'));
    messages[0].content = btoa('configured-password');
    const result = await h.deliver(request('conversation.read', { ref: { instance_id: instanceId, kind: 'conversation', conversation_id: conversation.id } }));
    expect(result).toMatchObject({ type: 'response', result: { items: [{ content_state: 'withheld' }] } });
    secretValues = ['rotated-password']; messages[0].content = 'rotated-password';
    const rotated = await h.deliver(request('conversation.read', { ref: { instance_id: instanceId, kind: 'conversation', conversation_id: conversation.id } }));
    expect(rotated).toMatchObject({ type: 'response', result: { items: [{ content_state: 'withheld' }] } });
    expect(Object.values(CONTENT_BUDGET).reduce((a, b) => a + b, 0)).toBeLessThan(64 * 1024 * 1024);
  } finally { await h.runtime.stop(); }
});
it('rejects invalidated diff reads and preserves an approved state through native resource pressure', async () => {
  const h = harness();
  try {
    await h.runtime.start();
    const response = await h.deliver(request('review.get', { ref }));
    if (response.type !== 'response' || response.operation !== 'review.get') throw Error('review');
    const capture = response.result;
    await h.deliver(request('review.verdict', { ref, snapshot_id: capture.snapshot_id, expected_revision: capture.revision, idempotency_key: 'verdict:capacity:unique', verdict: 'approve' }));
    nativeFailure = 'resource_limit';
    const calls = nativeCalls.filter(c => c === 'pilot_review_capture').length;
    await until(() => nativeCalls.filter(c => c === 'pilot_review_capture').length > calls);
    nativeFailure = undefined;
    const again = await h.deliver(request('review.get', { ref }));
    expect(again).toMatchObject({ type: 'response', result: { state: 'approved', revision: capture.revision + 1 } });
    nativeRevision = 'b'.repeat(64);
    await until(() => h.events.some(event => event.change.kind === 'review.changed' && event.change.scope.review_id === ref.review_id && event.change.revision > capture.revision + 1));
    expect(await h.deliver(request('diff.files', { ref, snapshot_id: capture.snapshot_id }))).toMatchObject({ type: 'error', code: 'stale_revision' });
    expect(await h.deliver(request('diff.read', { ref, snapshot_id: capture.snapshot_id, file_id: 'file:one', offset_bytes: 0 }))).toMatchObject({ type: 'error', code: 'stale_revision' });
  } finally { await h.runtime.stop(); }
});
it('rejects a candidate when the secret policy changes while authorization is in flight', async () => {
  const h = harness(); messages[0].content = 'new-private-password';
  try {
    await h.runtime.start();
    h.authorize(() => { secretValues = ['new-private-password']; });
    const result = await h.deliver(request('conversation.read', { ref: { instance_id: instanceId, kind: 'conversation', conversation_id: conversation.id } }));
    expect(result).toMatchObject({ type: 'error', code: 'snapshot_expired' });
    expect(JSON.stringify(h.results)).not.toContain('new-private-password');
  } finally { await h.runtime.stop(); }
});
it('waits for a late native capture after logout and never reintroduces its result', async () => {
  const h = harness(); let release!: () => void;
  try {
    await h.runtime.start(); await until(() => h.requests.some(r => r.path.includes('/v2/') && r.path.endsWith('/poll')));
    captureWait = new Promise<void>(resolve => { release = resolve; });
    const before = nativeCalls.filter(c => c === 'pilot_review_capture').length;
    void h.deliver(request('review.get', { ref })).catch(() => undefined);
    await until(() => nativeCalls.filter(c => c === 'pilot_review_capture').length > before);
    await h.client.logout();
    expect(h.client.getState().account).toBeNull();
    let stopped = false; const stopping = h.runtime.stop().then(() => { stopped = true; });
    await sleep(30); expect(stopped).toBe(false);
    release(); await stopping;
    expect(h.results).toHaveLength(0); expect(nativeSnapshots.size).toBe(0);
  } finally { release?.(); await h.runtime.stop(); }
});
it('serves a review while background transcripts are blocked and interleaves deliveries between Git observations', async () => {
  const h = harness(); let releaseMessages!: () => void; let releaseCapture!: () => void;
  try {
    await h.runtime.start(); await until(() => h.requests.some(r => r.path.includes('/v2/') && r.path.endsWith('/poll')));
    const before = nativeCalls.filter(c => c === 'db_list_messages').length;
    messageWait = new Promise<void>(resolve => { releaseMessages = resolve; });
    await until(() => nativeCalls.filter(c => c === 'db_list_messages').length > before);
    expect(await h.deliver(request('review.get', { ref }))).toMatchObject({ type: 'response' });
    releaseMessages(); messageWait = undefined;
    taskRecords = Array.from({ length: 10 }, (_, i) => ({ ...taskRecords[0], id: `task:many:${i}` }));
    captureWait = new Promise<void>(resolve => { releaseCapture = resolve; });
    const capturesBefore = nativeCalls.filter(c => c === 'pilot_review_capture').length;
    await until(() => nativeCalls.filter(c => c === 'pilot_review_capture').length > capturesBefore);
    const waiting = h.deliver(request('projects.list', { instance_id: instanceId }));
    await sleep(30); releaseCapture(); captureWait = undefined;
    expect(await waiting).toMatchObject({ type: 'response' });
    expect(nativeCalls.filter(c => c === 'pilot_review_capture').length - capturesBefore).toBe(1);
  } finally { releaseMessages?.(); releaseCapture?.(); await h.runtime.stop(); }
});
it('resolves canonical commit reviews and rechecks tracked branches at the native decision boundary', async () => {
  const commitRef = { ...ref, review_id: 'review:commits:one', run_id: 'run:one:valid' };
  const base = 'a'.repeat(40); const head = 'b'.repeat(40);
  taskRecords = [{ id: 'task:one', project_id: 'project:one', status: 'InReview', execution_targets: [{ projectId: 'project:one', executionMode: 'worktree', repoPath, targetBranchName: 'develop', branchName: 'feature/test' }] }];
  branchRecords = [{ name: 'develop', commit: base }, { name: 'feature/test', commit: head }];
  settings.set('macroPilot:supervision:v1:["config:test","instance:test"]', JSON.stringify({ version: 2, projection: null, snapshots: [], streams: {}, journal: {}, runs: [], reviews: [{
    contract_version: '1.0', type: 'review', ref: { ...commitRef, type: 'review' }, related_run: { type: 'run', instance_id: instanceId, workspace_id: ref.workspace_id, task_id: ref.task_id, run_id: 'run:one:valid' },
    git_revision: { base_sha: base, head_sha: head }, state: 'pending', revision: 1, updated_at: new Date().toISOString(),
  }] }));
  const h = harness();
  try {
    await h.runtime.start();
    expect(h.runtime.getStatus()).toBe('running');
    const result = await h.deliver(request('review.get', { ref: commitRef }));
    if (result.type !== 'response' || result.operation !== 'review.get') throw Error(JSON.stringify(result));
    expect(result.result.source).toEqual({ kind: 'commits', base_sha: base, head_sha: head });
    beforeFresh = () => { branchRecords[0].commit = head; };
    const verdict = await h.deliver(request('review.verdict', { ref: commitRef, snapshot_id: result.result.snapshot_id, expected_revision: result.result.revision, idempotency_key: 'verdict:branches:unique', verdict: 'approve' }));
    expect(verdict).toMatchObject({ type: 'error', code: 'stale_revision' });
    await until(() => h.events.some(e => e.change.kind === 'review.changed' && e.change.scope.review_id === commitRef.review_id && e.change.revision > result.result.revision));
    expect(await h.deliver(request('diff.files', { ref: commitRef, snapshot_id: result.result.snapshot_id }))).toMatchObject({ type: 'error', code: 'stale_revision' });
  } finally { await h.runtime.stop(); }
});
it('continues Git invalidations and durable event upload while transcript storage is unavailable', async () => {
  const h = harness();
  try {
    await h.runtime.start();
    const response = await h.deliver(request('review.get', { ref }));
    if (response.type !== 'response' || response.operation !== 'review.get') throw Error('review');
    messagesUnavailable = true; nativeRevision = 'e'.repeat(64);
    await until(() => h.events.some(event => event.change.kind === 'review.changed' && event.change.scope.review_id === ref.review_id && event.change.revision > response.result.revision));
    expect(await h.deliver(request('diff.files', { ref, snapshot_id: response.result.snapshot_id }))).toMatchObject({ type: 'error', code: 'stale_revision' });
    expect(await h.deliver(request('review.get', { ref }))).toMatchObject({ type: 'response' });
  } finally { await h.runtime.stop(); }
});
it('keeps deliveries moving while an event acknowledgement is blocked on HTTP', async () => {
  const h = harness(); let release!: () => void;
  h.waitEvents(new Promise<void>(resolve => { release = resolve; }));
  try {
    await h.runtime.start(); await until(() => h.events.length > 0);
    expect(await h.deliver(request('projects.list', { instance_id: instanceId }))).toMatchObject({ type: 'response' });
  } finally { release(); await h.runtime.stop(); }
});
it.skipIf(!process.env.PILOT_CAPTURE_BRIDGE)('uses real native Git captures through all runtime review handlers and detects a real edit before verdict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-runtime-')); repoPath = dir;
  const runGit = (...args: string[]) => { const result = Bun.spawnSync(['git', '-C', dir, ...args]); if (result.exitCode) throw Error(result.stderr.toString()); return result.stdout.toString(); };
  runGit('init', '-q'); runGit('config', 'user.name', 'Test'); runGit('config', 'user.email', 'test@example.invalid');
  await writeFile(join(dir, 'hello.txt'), 'before\n'); runGit('add', '.'); runGit('commit', '-qm', 'fixture');
  await writeFile(join(dir, 'hello.txt'), 'after\n');
  const before = runGit('status', '--porcelain=v1');
  const child = spawn(process.env.PILOT_CAPTURE_BRIDGE!, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const pending: Array<{ resolve(value: unknown): void; reject(reason: unknown): void }> = [];
  lines.on('line', line => { const value = JSON.parse(line); const call = pending.shift()!; if ('error' in value) call.reject(value.error); else call.resolve(value.result); });
  bridge = (command, args) => new Promise((resolve, reject) => { pending.push({ resolve, reject }); child.stdin.write(`${JSON.stringify({ command, args })}\n`); });
  const h = harness();
  try {
    await h.runtime.start();
    const response = await h.deliver(request('review.get', { ref }));
    if (response.type !== 'response' || response.operation !== 'review.get') throw Error(JSON.stringify(response));
    const capture: ContentCapture = response.result;
    const files = await h.deliver(request('diff.files', { ref, snapshot_id: capture.snapshot_id }));
    if (files.type !== 'response' || files.operation !== 'diff.files') throw Error('files');
    expect(files.result.items[0].new_path).toBe('hello.txt');
    const patch = await h.deliver(request('diff.read', { ref, snapshot_id: capture.snapshot_id, file_id: files.result.items[0].file_id, offset_bytes: 0 }));
    expect(JSON.stringify(patch)).toContain('+after');
    await writeFile(join(dir, 'hello.txt'), 'other\n');
    const verdict = await h.deliver(request('review.verdict', { ref, snapshot_id: capture.snapshot_id, expected_revision: capture.revision, idempotency_key: 'verdict:native:unique', verdict: 'approve' }));
    expect(verdict).toMatchObject({ type: 'error', code: 'stale_revision' });
    expect(runGit('status', '--porcelain=v1')).toBe(before);
    const next = await h.deliver(request('review.get', { ref }));
    if (next.type !== 'response' || next.operation !== 'review.get') throw Error('next');
    expect(next.result.revision).toBeGreaterThan(capture.revision);
    expect(await h.deliver(request('review.verdict', { ref, snapshot_id: next.result.snapshot_id, expected_revision: next.result.revision, idempotency_key: 'verdict:native:new', verdict: 'approve' }))).toMatchObject({ type: 'response', result: { outcome: 'applied' } });
    // Hold native patches near their actual 32 MiB limit, then create large
    // conversation snapshots while those native handles remain alive.
    await writeFile(join(dir, 'hello.txt'), 'x'.repeat(900_000));
    let nativeLimit = false; let nativeHeld = 0;
    for (let i = 0; i < 45; i++) {
      const held = await h.deliver(request('review.get', { ref }));
      if (held.type === 'error') { expect(held.code).toBe('resource_limit'); nativeLimit = true; break; }
      nativeHeld++;
    }
    expect(nativeLimit).toBe(true); expect(nativeHeld).toBeGreaterThan(25); expect(nativeHeld).toBeLessThan(40);
    messages = Array.from({ length: 100 }, (_, i) => ({ ...messages[0], id: `message:large:${i}`, content: 'visible '.repeat(2000) }));
    let contentLimit = false; let conversationsHeld = 0;
    for (let i = 0; i < 25; i++) {
      const held = await h.deliver(request('conversation.read', { ref: { instance_id: instanceId, kind: 'conversation', conversation_id: conversation.id } }));
      if (held.type === 'error') { expect(held.code).toBe('resource_limit'); contentLimit = true; break; }
      conversationsHeld++;
    }
    expect(contentLimit).toBe(true); expect(conversationsHeld).toBeGreaterThan(5);
    expect(Object.values(CONTENT_BUDGET).reduce((a, b) => a + b, 0)).toBeLessThan(64 * 1024 * 1024);
  } finally { await h.runtime.stop(); lines.close(); child.stdin.end(); child.kill(); await rm(dir, { recursive: true, force: true }); }
});
