import { expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { ConversationCaptures, type CaptureDependencies, type ConversationRef } from './conversationCaptures';
import { ContentHost } from './contentHost';
import { createReviewCaptureService } from './reviewCapture';
import type { ContentEvent, ContentRequest } from './contentProtocol';
import { validateContentMessage, validateContentResponse } from './contentProtocol';
import type { DbConversation, DbMessage } from '../tauriIpc';
import { safeProviderFailure } from '../chatErrorPresentation';

const now = Date.parse('2026-01-01T00:00:00Z');
const consistency = 'network-reliability-1' as const;
const ref = (id: string): ConversationRef => ({ instance_id: 'instance', kind: 'conversation', conversation_id: id });
const memory = () => {
  let value: string | null = null;
  return { load: async () => value, compareAndSwap: async (old: string | null, next: string) => {
    if (old !== value) return false; value = next; return true;
  } };
};
async function harness(enhanced: boolean) {
  let reads = 0; let clock = now; let authorized = true; let authorizations = 0;
  const conversations: DbConversation[] = ['a', 'b'].map(id => ({ id, title: id, scope_mode: 'Chat', description: null,
    task_id: null, project_id: null, group_id: null, provider_id: null, model_id: null, reasoning_effort: null,
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), last_message: null, message_count: 101, is_pinned: false }));
  const messages: DbMessage[] = conversations.flatMap(c => Array.from({ length: 101 }, (_, i) => ({ id: `${c.id}:${i.toString().padStart(3, '0')}`,
    conversation_id: c.id, role: 'user', content: 'Synthetic public fixture '.repeat(8), created_at: new Date(now + i).toISOString(),
    token_count: null, tool_traces_json: null, hidden_context: null, provider_input_items_json: null, provider_turn_state_json: null })));
  const deps: CaptureDependencies = { instanceId: 'instance', workspaceId: 'workspace', now: () => clock, storage: memory(), policy: () => ({ revision: 'visible-1', secrets: [] }),
    source: { projects: async () => Array.from({ length: 100 }, (_, i) => ({ id: `project:${i}`, name: `Project ${i}` })), tasks: async () => [],
      listConversations: async () => structuredClone(conversations), getConversation: async id => conversations.find(c => c.id === id) ?? null,
      activity: () => ({ activity: 'idle', generatingMessageId: null }), listMessages: async id => { reads++; return structuredClone(messages.filter(m => m.conversation_id === id)); } } };
  const captures = new ConversationCaptures(deps);
  const host = new ContentHost({ accountId: 'account', instanceId: 'instance', now: () => clock, signal: new AbortController().signal,
    conversations: captures, reviews: createReviewCaptureService(), storage: memory(), policy: async () => deps.policy(),
    commitReview: async () => false, reviewRefs: async () => [], resolveReview: async () => { throw Error('not_found'); } });
  await host.initialize(); await host.prepare(); if (enhanced) host.enableReliability();
  let sequence = 0; const wire: unknown[] = []; const events: ContentEvent[] = [];
  const request = (operation: string, body: object, requestId = `request:${++sequence}`) => ({ contract_version: '2.0', type: 'request', account_id: 'account', request_id: requestId,
    operation, body: { ...body, ...(enhanced ? { consistency } : {}) } }) as ContentRequest;
  const deliver = async (req: ContentRequest, sessionId = 'session') => {
    wire.push(req);
    const result = await host.handle({ transport_version: '2.0', type: 'delivery', request_id: req.request_id, instance_id: 'instance', source_session_id: sessionId,
      account_id: 'account', expires_at: new Date(clock + 60_000).toISOString(), request: req, ...(enhanced ? { capabilities: [consistency] } : {}) }, async () => {
      authorizations++; if (!authorized) throw Error('revoked'); return new Date(clock + 9000).toISOString();
    });
    expect(validateContentResponse(req, result.response)).toBe(true); wire.push(result.response); return result.response;
  };
  const observe = async () => { await host.observe(); await host.flush(async event => { expect(validateContentMessage(event)).toBe(true); events.push(event); }); };
  return { host, captures, conversations, messages, deps, request, deliver, wire, events, observe,
    get reads() { return reads; }, get authorizations() { return authorizations; }, revoke: () => { authorized = false; }, expire: () => { clock += 300_000; } };
}

it('measures legacy and negotiated desktop scenarios without payload diagnostics', async () => {
  const measurements = [];
  for (const enhanced of [false, true]) {
    const h = await harness(enhanced);
    try {
      const projects = await h.deliver(h.request('projects.list', { instance_id: 'instance' }));
      if (projects.type !== 'response' || projects.operation !== 'projects.list' || !('page' in projects.result)) throw Error('projects');
      await h.deliver(h.request('conversation.read', { ref: ref('a') }));
      const b = await h.deliver(h.request('conversation.read', { ref: ref('b') }));
      if (b.type !== 'response' || b.operation !== 'conversation.read') throw Error('transcript');
      h.wire.length = 0; const startReads = h.reads; const start = performance.now();
      h.messages[0].content = 'Synthetic change A'; await h.observe();
      const next = await h.deliver(h.request('conversation.read', { ref: ref('b'), continuation: { snapshot_id: b.result.page.snapshot_id, cursor: b.result.page.next_cursor } }));
      let rereads = 0; let resets = 0;
      if (next.type === 'error') {
        expect(next.code).toBe('stale_revision'); resets++; rereads++;
        await h.deliver(h.request('conversation.read', { ref: ref('b') }));
      }
      await h.deliver(h.request('projects.list', { instance_id: 'instance', ...(enhanced ? { known_revision: projects.result.page.revision } : {}) }));
      const resourceEvents = h.events.filter(e => e.change.kind === 'conversation.resource_changed');
      if (enhanced) {
        expect(resourceEvents.map(e => (e.change.scope as ConversationRef).conversation_id)).toEqual(['a']);
        expect(h.events.some(e => e.change.kind === 'conversation.changed')).toBe(false);
        expect(next.type).toBe('response'); expect(rereads).toBe(0);
      }
      const bodies = [...h.wire, ...h.events].map(value => JSON.stringify(value));
      measurements.push({ mode: enhanced ? 'negotiated' : 'legacy', logical_exchanges: h.wire.length / 2, producer_events: h.events.length,
        transcript_source_reads: h.reads - startReads, transcript_rereads: rereads, capture_resets: resets,
        json_bytes: bodies.reduce((n, body) => n + Buffer.byteLength(body), 0), gzip_body_bytes: bodies.reduce((n, body) => n + gzipSync(body).byteLength, 0),
        elapsed_ms: Math.round((performance.now() - start) * 100) / 100 });
    } finally { await h.host.dispose(); }
  }
  expect(measurements[1].json_bytes).toBeLessThan(measurements[0].json_bytes);
  console.log('SYNTHETIC_DESKTOP_MEASUREMENTS', JSON.stringify(measurements));
});

it('revalidates cached transcript replies and access after loss of acknowledgement', async () => {
  const h = await harness(true);
  try {
    const request = h.request('conversation.read', { ref: ref('b') });
    const first = await h.deliver(request); const checks = h.authorizations;
    expect(await h.deliver(request)).toEqual(first); expect(h.authorizations).toBeGreaterThan(checks);
    h.messages.find(m => m.conversation_id === 'b')!.content = 'Changed B';
    expect(await h.deliver(request)).toMatchObject({ type: 'error', code: 'stale_revision' });
    h.revoke(); await expect(h.deliver(request)).rejects.toThrow('revoked');
  } finally { await h.host.dispose(); }
});

it('keeps conditional project responses fresh and clears captures on expiry or lifecycle loss', async () => {
  const h = await harness(true);
  try {
    const first = await h.deliver(h.request('projects.list', { instance_id: 'instance' }));
    if (first.type !== 'response' || first.operation !== 'projects.list' || !('page' in first.result)) throw Error('projects');
    const conditional = h.request('projects.list', { instance_id: 'instance', known_revision: first.result.page.revision });
    expect(await h.deliver(conditional)).toMatchObject({ result: { not_modified: true } });
    h.deps.source.projects = async () => [{ id: 'changed', name: 'Changed' }];
    expect(await h.deliver(conditional)).toMatchObject({ result: { items: [{ project_id: 'changed' }] } });
    const req = h.request('conversation.read', { ref: ref('a') }); await h.deliver(req);
    h.expire(); expect(await h.deliver(req)).toMatchObject({ type: 'response' });
    h.captures.clear(); expect(await h.deliver(req)).toMatchObject({ type: 'error', code: 'snapshot_expired' });
  } finally { await h.host.dispose(); }
});

it('refuses unnegotiated or malformed extensions and exports only fixed diagnostic values', async () => {
  const h = await harness(false);
  try {
    const req = h.request('conversation.read', { ref: ref('a'), consistency });
    await expect(h.deliver(req)).rejects.toThrow('validation_failed');
    expect(validateContentMessage(h.request('projects.list', { instance_id: 'instance', known_revision: 1 }))).toBe(false);
    for (const kind of ['auth', 'rate_limited', 'provider_overloaded', 'context_overflow', 'invalid_tool_protocol', 'unknown']) {
      const failure = safeProviderFailure({ origin: 'provider', displayTarget: 'transcript', title: 'private', message: 'secret /private/path', kind });
      expect(JSON.stringify(failure)).not.toMatch(/secret|private/);
      h.deps.source.activity = () => ({ activity: 'error', generatingMessageId: null, providerFailure: failure });
      const page = await h.captures.conversationsList({ accountId: 'account', sessionId: 'session', instanceId: 'instance', reliability: true }, 'conversation');
      expect(page.items[0].provider_error).toEqual(failure);
    }
  } finally { await h.host.dispose(); }
});
