import { beforeEach, expect, mock, test } from 'bun:test';
import type { DbMessage } from '../tauriIpc';
const task = { id: 'task:demo', project_id: 'project:demo', project_ids: ['project:demo'], task_source: 'architect', plan_id: 'plan:demo',
  plan_storage_branch: 'develop', title: 'Synthetic task', description: 'Card description', status: 'Pending', draft: true,
  plan_title: 'Demo plan', feature_slug: null, merged_at: null, archived_at: null };
let messages: DbMessage[] = []; let artifactCalls = 0; let configCalls = 0; let visible = true;
const project = { id: 'project:demo', name: 'Demo', path: '/synthetic/demo' };
mock.module('../../stores/useAppStore', () => ({ useAppStore: { getState: () => ({ getProjectById: () => project }) } }));
mock.module('../../stores/useTaskStore', () => ({ useTaskStore: { getState: () => ({ tasks: [task], publishedStandaloneTasks: {} }) }, getTaskLifecycleCapabilities: () => ({ canRename: true }) }));
mock.module('../../stores/useChatStore', () => ({ useChatStore: { getState: () => ({ conversations: [] }) } }));
mock.module('../index', () => ({ getServiceRuntimeCapabilities: () => ({ taskMutation: true, taskProjectCommands: true }) }));
mock.module('../architectPlanService', () => ({ getArchitectPlan: async () => ({ id: 'plan:demo', nodes: [], status: 'validated' }), getGitFlowBaseBranch: () => 'develop', resolveTargetBranch: (s: string) => s }));
mock.module('../architectPlanArtifactService', () => ({
  listVisibleTaskArtifacts: async () => { artifactCalls++; return [{ id: 'artifact:demo', title: 'Visible artifact', summary: 'Summary', visibility: 'inherited', contentType: 'text', contentHash: 'hash' }]; },
  readVisibleTaskArtifactContent: async () => { artifactCalls++; return { content: 'Actual artifact text', artifact: { contentHash: 'hash' } }; },
  taskArtifactContentHash: () => 'hash',
}));
mock.module('../taskProjectCommands', () => ({ loadTaskProjectCommandRegistry: async () => { configCalls++; return {}; }, getTaskProjectCommand: () => undefined }));
mock.module('../tauriIpc', () => ({ listMessages: async () => messages }));
const { desktopTaskCompletionSource } = await import('./desktopTaskCompletionSource');
const taskRef = { instance_id: 'instance:demo', workspace_id: 'workspace:demo', task_id: 'task:demo' };
const conversationRef = { instance_id: taskRef.instance_id, kind: 'conversation' as const, conversation_id: 'chat:demo' };
const captures = { refreshCatalogMetadata: async () => ({ refs: visible ? [conversationRef] : [] }) };
const source = desktopTaskCompletionSource(taskRef.instance_id, taskRef.workspace_id, captures as never);
const policy = { revision: 'visible-1', secrets: ['secret-demo'] };
beforeEach(() => { messages = []; artifactCalls = 0; configCalls = 0; visible = true; });
test('card catalog includes descriptions and badges without per-task artifact or configuration reads', async () => {
  const cards = await source.cards(policy);
  expect(cards[0]).toMatchObject({ description: { text: 'Card description' }, draft: true, plan_title: { text: 'Demo plan' }, finalization: false });
  expect(artifactCalls).toBe(0); expect(configCalls).toBe(0);
});
test('artifact details use the desktop visibility service and reject another workspace', async () => {
  const loaded = await source.load('artifacts', taskRef, policy);
  expect(artifactCalls).toBe(1);
  const item = loaded.items![0]; expect(item).toMatchObject({ visibility: 'inherited' });
  expect(await loaded.read!('artifact_id' in item ? item.artifact_id : '')).toBe('Actual artifact text');
  await expect(source.load('artifacts', { ...taskRef, workspace_id: 'workspace:other' }, policy)).rejects.toThrow('not_found');
});
test('only visible structured trace fields are exposed; replay and hidden context are excluded', async () => {
  messages = [{ id: 'message:demo', conversation_id: 'chat:demo', role: 'assistant', content: '<think>private reasoning</think>',
    hidden_context: 'hidden secret', provider_input_items_json: '["private input"]', provider_turn_state_json: '{"private":"replay"}',
    tool_traces_json: JSON.stringify([{ tool_call_id: 'call:demo', tool_name: 'read_file', status: 'done', detail: 'README.md', args: { private: 'not visible' } }]),
    created_at: '2026-01-01T00:00:00Z', token_count: null }];
  const loaded = await source.load('tools', conversationRef, policy);
  expect(JSON.stringify(loaded)).not.toContain('private'); expect(JSON.stringify(loaded)).not.toContain('hidden');
  expect(loaded.items).toHaveLength(1);
  const item = loaded.items![0]; expect('trace_id' in item && await loaded.read!(item.trace_id)).toBe('README.md');
  visible = false; await expect(source.load('tools', conversationRef, policy)).rejects.toThrow('not_found');
});
