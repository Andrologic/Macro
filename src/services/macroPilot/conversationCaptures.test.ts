import { describe, expect, it } from 'bun:test';
import type { DbConversation, DbMessage } from '../tauriIpc';
import { ConversationCaptures, type CaptureDependencies, type ConversationActivity, type ConversationRef } from './conversationCaptures';
import { completion, controlledText, legacyFinalText, messageText, utf8Bytes } from './conversationText';
import { mapDbMessageToChatMessage } from '../chatDbMappers';

const date = '2026-01-01T00:00:00Z';
const scope = { accountId: 'account', sessionId: 'session', instanceId: 'instance' };
const ref: ConversationRef = { instance_id: 'instance', kind: 'conversation', conversation_id: 'chat' };
const policy = { revision: 'visible-1', secrets: ['boundary-secret'] };
function conversation(id = 'chat'): DbConversation {
  return { id, title: 'Conversation', description: null, scope_mode: 'Chat', task_id: null, project_id: null, group_id: null,
    provider_id: null, model_id: null, reasoning_effort: null, created_at: date, updated_at: date, last_message: null, message_count: 1, is_pinned: false };
}
function message(id = 'm1', content = 'Bonjour'): DbMessage {
  return { id, conversation_id: 'chat', role: 'user', content, created_at: date, token_count: null, tool_traces_json: null,
    hidden_context: null, provider_input_items_json: null, provider_turn_state_json: null };
}
function setup() {
  let stored: string | null = null; let now = Date.parse(date); let failed = false;
  const conversations = [conversation()]; const messages = [message()];
  const activity: ConversationActivity = { activity: 'idle', generatingMessageId: null };
  const deps: CaptureDependencies = { instanceId: 'instance', workspaceId: 'workspace', policy: () => policy, now: () => now,
    storage: { load: async () => stored, compareAndSwap: async (old, next) => { if (stored !== old) return false; stored = next; return true; } },
    source: { projects: async () => [{ id: 'p1', name: 'One' }, { id: 'p2', name: '/home/private' }],
      tasks: async () => [{ id: 'task', project_id: 'p1', conversation_id: 'implement' }],
      listConversations: async () => structuredClone(conversations), getConversation: async id => structuredClone(conversations.find(c => c.id === id) ?? null),
      listMessages: async id => { if (failed) throw new Error('/home/private: database unavailable'); return structuredClone(messages.filter(m => m.conversation_id === id)); },
      activity: () => structuredClone(activity) } };
  return { deps, captures: new ConversationCaptures(deps), conversations, messages, activity, fail: () => { failed = true; },
    advance: () => { now += 300000; }, get stored() { return stored; } };
}

describe('visible-1 text provenance', () => {
  it('recognizes a single complete legacy prefix and rejects ambiguous grammars', () => {
    expect(legacyFinalText('<think>private</think>\nFinal')).toBe('Final');
    for (const text of ['plain unknown', '<think>open', '<think>a<think>b</think>Final', '<think>x</think><think>y</think>Final', '<think>x</think><analysis>hidden', '<THINK>x</THINK>Final', '<think>x</think></think>']) expect(legacyFinalText(text)).toBeNull();
  });
  it('does not trust mapper presentation or completion reason alone', () => {
    const row = { ...message(), role: 'assistant', content: 'unclassified private content', completion_reason: 'completed' };
    expect(mapDbMessageToChatMessage(row, new Map()).content).toBe(row.content);
    expect(messageText(row, false, policy)).toEqual({ content_state: 'withheld', reason: 'unknown_provenance' });
    expect(messageText({ ...row, content: '<think>private</think>final' }, true, policy)).toEqual({ content_state: 'pending', reason: 'generating' });
    expect(completion('length')).toBe('incomplete'); expect(completion('length_recovered')).toBe('complete'); expect(completion('interrupted')).toBe('unknown');
  });
  it('matches structured provider final evidence with display content', () => {
    const row = { ...message(), role: 'assistant', content: 'Final', provider_turn_state_json: JSON.stringify({ provider: 'chatgpt', output_items: [
      { type: 'reasoning', summary: [{ text: 'private' }] }, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Final' }] },
    ] }) };
    expect(messageText(row, false, policy)).toEqual({ content_state: 'complete', text: 'Final' });
    expect(messageText({ ...row, content: 'Different' }, false, policy).content_state).toBe('withheld');
  });
  it('inspects full text before UTF-8 excerpting and rejects private paths, PEM and budget exhaustion', () => {
    expect(controlledText('é'.repeat(8190) + 'boundary-secret', policy).content_state).toBe('withheld');
    const excerpt = controlledText('😀'.repeat(5000), policy);
    expect(excerpt.content_state).toBe('excerpt'); expect('text' in excerpt && utf8Bytes(excerpt.text)).toBe(16384);
    for (const text of ['/Users/private', '-----BEGIN PRIVATE KEY-----', 'ghp_', 'sk-' + 'a'.repeat(20)]) expect(controlledText(text, policy).content_state).toBe('withheld');
    expect(controlledText('1234', { ...policy, inspectionBytes: 3 }).content_state).toBe('withheld');
  });
});

describe('immutable conversation captures', () => {
  it('lists every project and separates global Chat from real Implement links', async () => {
    const env = setup();
    env.conversations.push({ ...conversation('implement'), scope_mode: 'Implement', task_id: 'task', project_id: 'p1' },
      { ...conversation('orphan'), scope_mode: 'Implement', task_id: null }, { ...conversation('architect'), scope_mode: 'Architect' });
    expect((await env.captures.projectsList(scope)).items).toEqual([
      { instance_id: 'instance', workspace_id: 'workspace', project_id: 'p1', name: 'One' },
      { instance_id: 'instance', workspace_id: 'workspace', project_id: 'p2', name: 'Project' },
    ]);
    const chats = await env.captures.conversationsList(scope, 'conversation');
    expect(chats.items.map(i => i.ref)).toEqual([ref]);
    const tasks = await env.captures.conversationsList(scope, 'implement');
    expect(tasks.items[0].ref).toEqual({ instance_id: 'instance', kind: 'implement', workspace_id: 'workspace', task_id: 'task', conversation_id: 'implement' });
    expect(tasks.items).toHaveLength(1);
  });
  it('orders persisted catalogs and messages deterministically, with immutable contiguous pages', async () => {
    const env = setup(); env.messages.push(message('m0'), message('m2'));
    env.conversations.push({ ...conversation('pinned'), is_pinned: true }, conversation('aaa'));
    expect((await env.captures.conversationsList(scope, 'conversation')).items.map(i => i.ref.conversation_id)).toEqual(['pinned', 'aaa', 'chat']);
    const first = await env.captures.conversationRead(scope, ref, undefined, 1);
    expect(first.items[0].message_id).toBe('m0'); first.items[0].message_id = 'tampered';
    const next = await env.captures.conversationRead(scope, ref, { snapshot_id: first.page.snapshot_id, cursor: first.page.next_cursor! }, 2);
    expect(next.items.map(i => i.message_id)).toEqual(['m1', 'm2']); expect(next.page.offset).toBe(1); expect(next.page.next_cursor).toBeNull();
    expect(next.page.revision).toBe(first.page.revision); expect(next.page.total).toBe(3);
    expect(env.messages[0].id).toBe('m1');
    const renewed = await env.captures.conversationRead(scope, ref);
    expect(renewed.page.snapshot_id).not.toBe(first.page.snapshot_id); expect(renewed.page.revision).toBe(first.page.revision);
    const restarted = new ConversationCaptures(env.deps); expect((await restarted.conversationRead(scope, ref)).page.revision).toBe(first.page.revision);
  });
  for (const change of ['backdated', 'rename', 'delete', 'activity', 'policy'] as const) it(`invalidates pages on ${change}`, async () => {
    const env = setup(); env.messages.push(message('m2'));
    const first = await env.captures.conversationRead(scope, ref, undefined, 1);
    if (change === 'backdated') env.messages.push({ ...message('old'), created_at: '2025-01-01T00:00:00Z' });
    if (change === 'rename') env.conversations[0].title = 'Renamed';
    if (change === 'delete') env.conversations.splice(0);
    if (change === 'activity') env.activity.activity = 'busy';
    if (change === 'policy') env.deps.policy = () => ({ revision: 'visible-1', secrets: ['new secret'] });
    await expect(env.captures.conversationRead(scope, ref, { snapshot_id: first.page.snapshot_id, cursor: first.page.next_cursor! })).rejects.toMatchObject({ code: 'stale_revision' });
    expect(await env.captures.refresh()).toBe(first.page.revision + 1);
  });
  it('withholds active text and preserves interrupted completion independently', async () => {
    const env = setup(); env.messages[0] = { ...message(), role: 'assistant', content: '<think>private</think>Visible', completion_reason: 'length' };
    env.activity.activity = 'busy'; env.activity.generatingMessageId = 'm1';
    const pending = (await env.captures.conversationRead(scope, ref)).items[0];
    expect(pending.content_state).toBe('pending'); expect(pending).not.toHaveProperty('text'); expect(pending.completion).toBe('unknown');
    env.activity.activity = 'error';
    const final = (await env.captures.conversationRead(scope, ref)).items[0];
    expect(final.content_state).toBe('complete'); expect(final.completion).toBe('incomplete'); expect(final).toHaveProperty('text', 'Visible');
  });
  it('returns sanitized failure, not empty data; enforces scope, cursor, expiry and quota', async () => {
    const env = setup(); env.messages.push(message('m2'));
    const first = await env.captures.conversationRead(scope, ref, undefined, 1);
    const continuation = { snapshot_id: first.page.snapshot_id, cursor: first.page.next_cursor! };
    await expect(env.captures.conversationRead({ ...scope, sessionId: 'other' }, ref, continuation)).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(env.captures.conversationRead(scope, ref, { ...continuation, cursor: 'guessed' })).rejects.toMatchObject({ code: 'validation_failed' });
    env.advance(); await expect(env.captures.conversationRead(scope, ref, continuation)).rejects.toMatchObject({ code: 'snapshot_expired' });
    env.deps.quotaBytes = 1; await expect(env.captures.projectsList(scope)).rejects.toMatchObject({ code: 'resource_limit' });
    env.fail(); await expect(env.captures.conversationRead(scope, ref)).rejects.toMatchObject({ message: 'unavailable' });
  });
  it('clears captures and cancels queued reads when lifecycle changes', async () => {
    const env = setup(); const read = env.captures.projectsList(scope); env.captures.clear();
    await expect(read).rejects.toMatchObject({ code: 'unavailable' });
  });
});

it('produces A2 conforming envelopes with bounded pages including escaped UTF-8 text', async () => {
  const validatorPath = '../../../contracts/macro-pilot/v2/validate.mjs';
  const { validateMessage, validatePageContinuation } = await import(validatorPath);
  const env = setup(); env.messages.splice(0);
  for (let i = 0; i < 5; i++) env.messages.push(message(`message-${i.toString().padStart(2, '0')}`, '\u0001'.repeat(16000)));
  env.deps.source.projects = async () => [{ id: 'long-name', name: '😀'.repeat(200) }];
  const wrap = (operation: string, result: unknown) => ({ contract_version: '2.0', request_id: 'request', account_id: 'account', type: 'response', operation, result });
  expect(validateMessage(wrap('projects.list', await env.captures.projectsList(scope))).valid).toBe(true);
  expect(validateMessage(wrap('conversations.list', await env.captures.conversationsList(scope, 'conversation'))).valid).toBe(true);
  let page = await env.captures.conversationRead(scope, ref);
  let seen = page.items.length;
  expect(page.items.length).toBeLessThan(5);
  while (page.page.next_cursor) {
    const envelope = wrap('conversation.read', page);
    expect(validateMessage(envelope).valid).toBe(true); expect(utf8Bytes(JSON.stringify(envelope))).toBeLessThan(256 * 1024);
    const next = await env.captures.conversationRead(scope, ref, { snapshot_id: page.page.snapshot_id, cursor: page.page.next_cursor });
    expect(validatePageContinuation(envelope, wrap('conversation.read', next)).valid).toBe(true);
    seen += next.items.length; page = next;
  }
  expect(seen).toBe(5); expect(validateMessage(wrap('conversation.read', page)).valid).toBe(true);
});

it('does not recover sent user text from hidden context and rejects malformed marker fragments', () => {
  const row = { ...message(), content: '', hidden_context: '{"private":"secret"}' };
  expect(messageText(row, false, policy)).toEqual({ content_state: 'complete', text: '' });
  for (const suffix of ['<thi', '< analysis>secret', '</ reasoning>', '<|analysis|>secret']) {
    expect(messageText({ ...message(), role: 'assistant', content: `<think>reason</think>${suffix}` }, false, policy).content_state).toBe('withheld');
  }
});

it('rejects an unstable source and storage corruption without fabricating a capture', async () => {
  const env = setup(); let reads = 0;
  env.deps.source.listMessages = async () => [message('message', `Version ${reads++}`)];
  await expect(env.captures.conversationRead(scope, ref)).rejects.toMatchObject({ code: 'content_unavailable' });
  env.deps.source.listMessages = async () => [];
  env.deps.storage.load = async () => '{invalid';
  await expect(env.captures.projectsList(scope)).rejects.toMatchObject({ code: 'unavailable' });
});

it('never falls back to legacy grammar after explicit provider provenance rejection', () => {
  const content = '<think>first reasoning</think>still private';
  const row = { ...message(), role: 'assistant', content };
  for (const output of [
    { type: 'message', role: 'assistant', channel: 'analysis', status: 'completed', content: [{ type: 'output_text', text: content }] },
    { type: 'message', role: 'assistant', channel: 'final', status: 'completed', content: [{ type: 'output_text', text: 'Different final output' }] },
    { type: 'message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: content }] },
  ]) {
    const result = messageText({ ...row, provider_turn_state_json: JSON.stringify({ provider: 'chatgpt', output_items: [output] }) }, false, policy);
    expect(result).toEqual({ content_state: 'withheld', reason: 'unknown_provenance' });
  }
  for (const state of ['', '{invalid', '{}', JSON.stringify({ provider: 'unknown', output_items: [] })]) {
    expect(messageText({ ...row, provider_turn_state_json: state }, false, policy)).toEqual({ content_state: 'withheld', reason: 'unknown_provenance' });
  }
  expect(messageText(row, false, policy)).toEqual({ content_state: 'complete', text: 'still private' });
});

it('withholds malformed closed reasoning markers and maps every normative completion reason', () => {
  for (const tag of ['thin', 'analysi', 'reasonin', 'fina']) {
    const content = `<think>first</think><${tag}>ambiguous</${tag}>`;
    expect(legacyFinalText(content)).toBeNull();
    expect(messageText({ ...message(), role: 'assistant', content }, false, policy)).toEqual({ content_state: 'withheld', reason: 'unknown_provenance' });
  }
  for (const reason of ['completed', 'length_recovered', 'incomplete_recovered']) expect(completion(reason)).toBe('complete');
  for (const reason of ['length', 'incomplete', 'tool_turn_limit', 'post_tool_empty_fallback']) expect(completion(reason)).toBe('incomplete');
  for (const reason of [null, undefined, '', 'open', 'interrupted']) expect(completion(reason)).toBe('unknown');
});

it('does not reorder arrays owned by an injected canonical source', async () => {
  const env = setup(); const rows = Object.freeze([message('z'), message('a')]);
  env.deps.source.listMessages = async () => rows as unknown as DbMessage[];
  expect((await env.captures.conversationRead(scope, ref)).items.map(i => i.message_id)).toEqual(['a', 'z']);
  expect(rows.map(m => m.id)).toEqual(['z', 'a']);
});

it('keeps project catalogs usable when conversation history cannot be loaded or exceeds its budget', async () => {
  const env = setup(); let transcriptReads = 0;
  env.deps.source.listMessages = async () => { transcriptReads++; throw new Error('Oversized or unavailable history'); };
  env.deps.source.listConversations = async () => { throw new Error('Conversation database unavailable'); };
  const first = await env.captures.projectsList(scope, undefined, 1);
  const next = await env.captures.projectsList(scope, { snapshot_id: first.page.snapshot_id, cursor: first.page.next_cursor! });
  expect(next.items[0].project_id).toBe('p2'); expect(transcriptReads).toBe(0);
  expect(await env.captures.refreshProjects()).toBe(first.page.revision);
  env.deps.source.projects = async () => [{ id: 'p1', name: 'Renamed' }];
  await expect(env.captures.projectsList(scope, { snapshot_id: first.page.snapshot_id, cursor: first.page.next_cursor! })).rejects.toMatchObject({ code: 'stale_revision' });
});

it('projects newly persisted provider-neutral receipt evidence and invalidates after it changes', async () => {
  const env = setup(); env.messages[0] = { ...message(), role: 'assistant', content: 'New final output' };
  let proven = false; env.deps.source.finalProvenance = async () => proven ? 'New final output' : null;
  expect((await env.captures.conversationRead(scope, ref)).items[0].content_state).toBe('withheld');
  proven = true;
  const page = await env.captures.conversationRead(scope, ref);
  expect(page.items[0]).toHaveProperty('text', 'New final output');
  expect(page.page.revision).toBe(2);
});

it('withholds historical display mixtures even when they begin with a recognized reasoning block', () => {
  for (const suffix of ['[TOOL] terminal', '[System: The agent loop stopped due to an API error: private detail]', '🔍 **Recherche web:** private query', '<tool_context>private result</tool_context>']) {
    const row = { ...message(), role: 'assistant', content: `<think>reason</think>Answer\n${suffix}` };
    expect(messageText(row, false, policy)).toEqual({ content_state: 'withheld', reason: 'unknown_provenance' });
  }
  expect(messageText({ ...message(), role: 'assistant', content: '<think>reason</think>Answer', tool_traces_json: '[{"id":"tool"}]' }, false, policy).content_state).toBe('withheld');
});
