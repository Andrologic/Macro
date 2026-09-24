import { beforeEach, expect, mock, test } from 'bun:test';
import { pilotTaskId } from './taskIdentity';
import type { PilotToolTraceMetadata } from '../tauriIpc';
const task = { id: 'task:v1:develop:plan%3Ademo:child', node_id: 'child', dependencies: ['task:v1:develop:plan%3Ademo:parent'], project_id: 'project:demo', project_ids: ['project:demo'], task_source: 'architect', plan_id: 'plan:demo',
  plan_storage_branch: 'develop', title: 'Synthetic task', description: 'Card description', status: 'Pending', draft: true,
  plan_title: 'Demo plan', feature_slug: null, merged_at: null, archived_at: null };
let configured: { command: string; worktreeSetupCommand: string } | undefined;
let traces: PilotToolTraceMetadata[] = []; let detailReads = 0; let artifactCalls = 0; let configCalls = 0; let visible = true;
const project = { id: 'project:demo', name: 'Demo', path: '/synthetic/demo' };
mock.module('../../stores/useAppStore', () => ({ useAppStore: { getState: () => ({ getProjectById: () => project }) } }));
mock.module('../../stores/useTaskStore', () => ({ useTaskStore: { getState: () => ({ tasks: [task], publishedStandaloneTasks: {}, renameTask: async (_id: string, _title: string, options: { beforeEffect(): Promise<void> }) => options.beforeEffect() }) }, getTaskLifecycleCapabilities: () => ({ canRename: true }), getTaskCommandTargets: () => [{ projectId: task.project_id }, { projectId: 'project:second' }] }));
mock.module('../../stores/useChatStore', () => ({ useChatStore: { getState: () => ({ conversations: [] }) } }));
mock.module('../index', () => ({ getServiceRuntimeCapabilities: () => ({ taskMutation: true, taskProjectCommands: true }) }));
mock.module('../architectPlanService', () => ({ readArchitectPlanSnapshot: async () => ({ id: 'plan:demo', nodes: [{ id: 'child', dependencies: ['parent'] }, { id: 'parent', dependencies: [] }], status: 'validated' }), getGitFlowBaseBranch: () => 'develop', resolveTargetBranch: (s: string) => s }));
mock.module('../architectPlanArtifactService', () => ({
  listVisibleTaskArtifacts: async (params: { task: { id: string; dependencies: string[] }; existingMetadataOnly?: boolean }) => { expect(params.existingMetadataOnly).toBe(true); expect(params.task.id).toBe(task.node_id); expect(params.task.dependencies).toEqual(['parent']); artifactCalls++; return [{ id: 'artifact:demo', title: 'Visible artifact', summary: 'Summary', visibility: 'inherited', contentType: 'text', contentHash: 'hash' }]; },
  readVisibleTaskArtifactContent: async () => { artifactCalls++; return { content: 'Actual artifact text', artifact: { contentHash: 'hash' } }; },
  taskArtifactContentHash: () => 'hash',
}));
mock.module('../taskProjectCommands', () => ({ loadTaskProjectCommandRegistry: async (_ids: string[], loader: unknown) => { expect(loader).toBe(configurationGetLoadedSnapshot); configCalls++; return {}; }, getTaskProjectCommand: () => configured }));
mock.module('../tauriIpc', () => ({ pilotToolTracesList: async () => ({ revision: 1, traces }), pilotToolTraceRead: async () => { detailReads++; return { revision: 1, detail: 'README.md' }; } }));
const { configurationGetLoadedSnapshot } = await import('../configurationClient');
const { desktopTaskCompletionSource } = await import('./desktopTaskCompletionSource');
const taskRef = { instance_id: 'instance:demo', workspace_id: 'workspace:demo', task_id: pilotTaskId(task.id) };
const conversationRef = { instance_id: taskRef.instance_id, kind: 'conversation' as const, conversation_id: 'chat:demo' };
const captures = { refreshCatalogMetadata: async () => ({ refs: visible ? [conversationRef] : [] }) };
const source = desktopTaskCompletionSource(taskRef.instance_id, taskRef.workspace_id, captures as never);
const policy = { revision: 'visible-1', secrets: ['secret-demo'] };
beforeEach(() => { traces = []; detailReads = 0; artifactCalls = 0; configCalls = 0; visible = true; configured = undefined; });
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
test('trace lists load bounded public metadata and fetch only the requested detail', async () => {
  traces = [{ message_id: 'message:demo', trace_index: 0, tool_call_id: 'call:demo', tool_name: 'read_file', status: 'done', has_detail: true, detail_bytes: 9 }];
  const loaded = await source.load('tools', conversationRef, policy);
  expect(detailReads).toBe(0); expect(loaded.items).toHaveLength(1);
  const item = loaded.items![0]; expect('trace_id' in item && await loaded.read!(item.trace_id)).toBe('README.md');
  expect(detailReads).toBe(1);
  visible = false; await expect(source.load('tools', conversationRef, policy)).rejects.toThrow('not_found');
});

test('confirmation lists setup before run and unsafe setup removes run availability', async () => {
  configured = { command: 'echo run', worktreeSetupCommand: 'echo setup' };
  const savedDraft = task.draft; task.draft = false;
  try {
    let loaded = await source.load('task', taskRef, policy);
    expect(loaded.task!.commands.map(command => command.command)).toEqual([{ content_state: 'complete', text: 'echo setup' }, { content_state: 'complete', text: 'echo setup' }, { content_state: 'complete', text: 'echo run' }, { content_state: 'complete', text: 'echo run' }]);
    expect(loaded.task!.actions).toContain('run_commands');
    configured.worktreeSetupCommand = 'echo secret-demo';
    loaded = await source.load('task', taskRef, policy);
    expect(loaded.task!.commands[0].command.content_state).toBe('withheld');
    expect(loaded.task!.actions).not.toContain('run_commands');
  } finally { task.draft = savedDraft; }
});

test('a project relocated while authorizing cannot receive a task mutation', async () => {
  const saved = project.path;
  try {
    await expect(source.execute(taskRef, 'rename', 'New title', async () => { project.path = '/synthetic/relocated'; })).rejects.toThrow('stale_revision');
  } finally { project.path = saved; }
});

test('finalization artifact visibility receives business dependency IDs', async () => {
  const saved = { task_source: task.task_source, node_id: task.node_id };
  task.task_source = 'plan_finalization'; task.node_id = 'finalization';
  try { await source.load('artifacts', taskRef, policy); expect(artifactCalls).toBe(1); }
  finally { Object.assign(task, saved); }
});
