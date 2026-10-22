import { afterAll, expect, it, mock } from 'bun:test';
import type { DbConversation, DbMessage } from '../tauriIpc';

const calls: string[] = [];
let bootstrapCalls = 0;
let unavailable = false;
let boundedUnavailable = false;
let stored: string | null = null;
const projectStore = {
  standaloneProjects: [{ id: 'standalone', name: 'Standalone' }],
  projectGroups: [{ id: 'closed', projects: [{ id: 'archived', name: 'Archived' }] }],
};
const conversation: DbConversation = { id: 'global-chat', title: 'Global', description: null, scope_mode: 'Chat', task_id: null,
  project_id: null, group_id: null, provider_id: null, model_id: null, reasoning_effort: null, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z', last_message: null, message_count: 1, is_pinned: false };
const message: DbMessage = { id: 'persisted-user', conversation_id: conversation.id, role: 'user', content: 'Persisted text',
  created_at: conversation.created_at, token_count: null, tool_traces_json: null, hidden_context: 'private context',
  provider_input_items_json: null, provider_turn_state_json: null };
const core = await import('@tauri-apps/api/core');
mock.module('@tauri-apps/api/core', () => ({ ...core, invoke: async (command: string, args?: Record<string, unknown>) => {
  calls.push(command);
  if (command === 'workspace_get_bootstrap') { bootstrapCalls++; throw new Error('unexpected workspace bootstrap during capture read'); }
  if (command === 'workspace_list_tasks') return { tasks: [] };
  if (command === 'db_conversation_catalog_version') return { version: 1, generation: 'd'.repeat(32), incarnation: 'e'.repeat(32), revision: '0' };
  if (command === 'db_conversation_catalog_page') return { token: { version: 1, generation: 'd'.repeat(32), incarnation: 'e'.repeat(32), revision: '0' }, total_raw: '1', items: [structuredClone(conversation)], next_after: null, admission_estimate_bytes: 8192 };
  if (command === 'db_conversation_content_version') { if (unavailable) throw new Error('unavailable'); return {version:1,incarnation:'a'.repeat(32),revision:'1'}; }
  if (command === 'db_conversation_content_metadata') return {token:{version:1,incarnation:'a'.repeat(32),revision:'1'},opening:{total_raw:'1',total_exportable:'1',conversation,metadata:{conversation_id:conversation.id,revision:'1',archived:false,response_revision:'0',read_revision:'0',pending_tool:false,provider_failed:false,question_message_id:null,preview_message_id:null}},items:[{id:message.id,conversation_id:message.conversation_id,role:message.role,created_at:message.created_at}],next_after:null,admission_estimate_bytes:8192};
  if (command === 'db_conversation_content_window') { if (unavailable) throw new Error('unavailable'); return {token:{version:1,incarnation:'a'.repeat(32),revision:'1'},items:[{id:message.id,conversation_id:message.conversation_id,role:message.role,content:message.content,created_at:message.created_at,completion_reason:null,tool_traces_json:null,provider_turn_state_json:null,provenance_json:null,response_revision_decimal:null}],consumed_count:1,admission_estimate_bytes:8192}; }
  if (command === 'db_conversation_metadata') return [];
  if (command === 'db_list_conversations') return [structuredClone(conversation)];
  if (command === 'db_get_conversation') return structuredClone(conversation);
  if (command === 'db_list_messages_bounded') { if (boundedUnavailable) throw { message: 'resource_limit' }; return [structuredClone(message)]; }
  if (command === 'db_list_messages') { if (unavailable) throw new Error('/private/db broken'); return [structuredClone(message)]; }
  if (command === 'db_get_app_setting') return stored === null ? null : { value_json: stored };
  if (command === 'db_compare_and_swap_app_setting') {
    const applied = args?.expectedValueJson === stored;
    if (applied) stored = args?.valueJson as string;
    return { applied };
  }
  throw new Error(`Unexpected command: ${command}`);
} }));
mock.module('../../stores/useAppStore', () => ({ useAppStore: { getState: () => projectStore } }));
afterAll(() => mock.restore());
const { useChatStore } = await import('../../stores/useChatStore');
const { desktopConversationCaptureSource, desktopConversationManagementSource, conversationCaptureStorage } = await import('./conversationCaptureSource');
const { desktopStorePorts } = await import('../../composition/macroPilotDesktop');
const { ConversationCaptures } = await import('./conversationCaptures');

it('uses actual IPC wrappers and chat store with an unloaded cache, preserving UI and source data', async () => {
  const state = useChatStore.getState();
  expect(state.getConversationMessages(conversation.id)).toEqual([]);
  const source = desktopConversationCaptureSource(desktopStorePorts);
  const captures = new ConversationCaptures({ instanceId: 'instance', workspaceId: 'workspace', source,
    storage: conversationCaptureStorage('config', 'instance'), policy: () => ({ revision: 'visible-1', secrets: [] }) });
  const scope = { accountId: 'account', sessionId: 'session', instanceId: 'instance' };
  const projects = await captures.projectsList(scope);
  expect(projects.items.map(p => p.project_id)).toEqual(['archived', 'standalone']);
  expect(bootstrapCalls).toBe(0);
  const read = await captures.conversationRead(scope, { instance_id: 'instance', kind: 'conversation', conversation_id: conversation.id });
  expect(read.items[0]).toHaveProperty('text', 'Persisted text');
  expect(JSON.stringify(read)).not.toContain('private');
  expect(useChatStore.getState()).toBe(state);
  expect(state.getConversationMessages(conversation.id)).toEqual([]);
  expect(message.hidden_context).toBe('private context');
  expect(calls).toContain('db_conversation_content_window'); expect(calls).toContain('db_conversation_content_metadata');
  expect(calls).not.toContain('db_list_messages'); expect(calls).not.toContain('db_get_conversation');
  expect(calls.filter(c => /create|update|delete|rename/.test(c))).toEqual([]);
  unavailable = true;
  await expect(captures.conversationRead(scope, { instance_id: 'instance', kind: 'conversation', conversation_id: conversation.id })).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
});


it('historical bounded callers preserve the safe resource error without an unbounded fallback', async () => {
  const source = desktopConversationManagementSource(desktopStorePorts);
  const before = calls.filter(c => c === 'db_list_messages').length;
  expect(await source.listMessages(conversation.id)).toHaveLength(1);
  expect(calls).toContain('db_list_messages_bounded');
  expect(calls.filter(c => c === 'db_list_messages').length).toBe(before);
  boundedUnavailable = true;
  await expect(source.listMessages(conversation.id)).rejects.toMatchObject({ code: 'resource_limit', message: 'resource_limit' });
});

it('completed turns with a cleared runtime are idle while active turns stay busy', () => {
  const before = useChatStore.getState().conversationRuntimeById;
  const source = desktopConversationCaptureSource(desktopStorePorts);
  try {
    useChatStore.setState({ conversationRuntimeById: {} });
    expect(source.activity(conversation.id)).toEqual({ activity: 'idle', generatingMessageId: null });
    useChatStore.setState({ conversationRuntimeById: {
      [conversation.id]: { phase: 'streaming', sessionId: 'synthetic-session', turnId: 'synthetic-turn', assistantMessageId: 'assistant', lastError: null },
    } });
    expect(source.activity(conversation.id)).toMatchObject({ activity: 'busy', generatingMessageId: 'assistant' });
  } finally {
    useChatStore.setState({ conversationRuntimeById: before });
  }
});
