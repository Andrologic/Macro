import { afterAll, expect, it, mock } from 'bun:test';
import type { DbConversation, DbMessage } from '../tauriIpc';

const calls: string[] = [];
let bootstrapCalls = 0;
let unavailable = false;
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
  if (command === 'db_list_conversations') return [structuredClone(conversation)];
  if (command === 'db_get_conversation') return structuredClone(conversation);
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
const { desktopConversationCaptureSource, conversationCaptureStorage } = await import('./conversationCaptureSource');
const { ConversationCaptures } = await import('./conversationCaptures');

it('uses actual IPC wrappers and chat store with an unloaded cache, preserving UI and source data', async () => {
  const state = useChatStore.getState();
  expect(state.getConversationMessages(conversation.id)).toEqual([]);
  const source = desktopConversationCaptureSource();
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
  expect(calls).toContain('db_list_messages'); expect(calls).toContain('db_get_conversation');
  expect(calls.filter(c => /create|update|delete|rename/.test(c))).toEqual([]);
  unavailable = true;
  await expect(captures.conversationRead(scope, { instance_id: 'instance', kind: 'conversation', conversation_id: conversation.id })).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
});
