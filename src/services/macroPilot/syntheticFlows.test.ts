import { afterAll, beforeEach, expect, it, mock, spyOn } from 'bun:test';
import type { DbConversation, DbMessage } from '../tauriIpc';
import type { ContentDelivery, ContentRequest } from './contentProtocol';
import { account, instanceId, origin, syntheticFixture } from '../../../dev/pilot-synthetic/fixture';

// Fail closed at the native boundary, including credentials and native HTTP.
const calls: string[] = [];
const forbiddenCalls: string[] = [];
const settings = new Map<string, string>();
const conversation: DbConversation = {
  id: 'conversation:synthetic', title: 'Synthetic conversation', description: null,
  scope_mode: 'Chat', task_id: null, project_id: null, group_id: null, provider_id: null,
  model_id: null, reasoning_effort: null, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z', last_message: null, message_count: 1, is_pinned: false,
};
const message: DbMessage = { id: 'message:synthetic', conversation_id: conversation.id, role: 'user',
  content: 'Synthetic hello', created_at: '2026-01-01T00:00:00Z', token_count: null, tool_traces_json: null, hidden_context: null, provider_input_items_json: null, provider_turn_state_json: null };
const core = await import('@tauri-apps/api/core');
mock.module('@tauri-apps/api/core', () => ({ ...core, invoke: async (command: string, args: Record<string, unknown> = {}) => {
  calls.push(command);
  if (command === 'db_get_app_setting') return settings.has(String(args.key)) ? { value_json: settings.get(String(args.key)) } : null;
  if (command === 'db_compare_and_swap_app_setting') {
    const applied = (settings.get(String(args.key)) ?? null) === args.expectedValueJson;
    if (applied) settings.set(String(args.key), String(args.valueJson));
    return { applied };
  }
  if (command === 'pilot_content_policy') return [];
  if (command === 'pilot_review_capture') throw 'content_unavailable'; // Git review is outside this in-memory fixture.
  if (command === 'db_list_conversations') return [structuredClone(conversation)];
  if (command === 'db_get_conversation') return args.id === conversation.id ? structuredClone(conversation) : null;
  if (command === 'db_list_messages') return args.conversationId === conversation.id ? [structuredClone(message)] : [];
  forbiddenCalls.push(command);
  throw Error(`Forbidden synthetic IPC: ${command}`);
} }));
const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { throw Error('Real network forbidden in synthetic flows'); }, { preconnect: () => { throw Error('Network preconnect forbidden'); } }));
const { MacroPilotNativeClient } = await import('./nativeClient');
const { PilotRuntime } = await import('./runtime');
const { desktopStorePorts } = await import('../../composition/macroPilotDesktop');
const { validateContentMessage } = await import('./contentProtocol');
const { useTaskStore } = await import('../../stores/useTaskStore');
const { useAppStore } = await import('../../stores/useAppStore');
const { useChatStore } = await import('../../stores/useChatStore');
afterAll(() => mock.restore());

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('Synthetic flow timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
let sequence = 0;
function delivery(operation: ContentRequest['operation'], body: unknown): ContentDelivery {
  const request = { contract_version: '2.0', type: 'request', account_id: account.account_id,
    request_id: `request:synthetic:${++sequence}`, operation, body } as ContentRequest;
  const value: ContentDelivery = { transport_version: '2.0', type: 'delivery', request_id: request.request_id,
    instance_id: instanceId, account_id: account.account_id, source_session_id: 'session:synthetic-mobile',
    expires_at: new Date(Date.now() + 60_000).toISOString(), request };
  expect(validateContentMessage(value)).toBe(true);
  return value;
}
async function deliver(h: ReturnType<typeof syntheticFixture>, operation: ContentRequest['operation'], body: unknown) {
  const value = delivery(operation, body);
  h.enqueue(value);
  await until(() => h.results.some(result => result.request_id === value.request_id)).catch(error => { throw Error(`${error.message}: ${JSON.stringify({ calls, forbiddenCalls, failures: h.failures, requests: h.requests.map(r => r.path) })}`); });
  const result = h.results.find(result => result.request_id === value.request_id)!;
  expect(validateContentMessage(result)).toBe(true);
  return result.response;
}
async function connect(client: InstanceType<typeof MacroPilotNativeClient>) {
  await client.initialize();
  expect(client.getState().status).toBe('unconfigured');
  const attempt = await client.connect(origin, 'Synthetic desktop');
  expect(attempt.verificationUri).toBe('https://github.com/login/device'); // Display data only; never opened.
  expect(await client.pollAuth()).toEqual(account);
  expect(client.getState().status).toBe('confirming_account');
  await expect(client.confirmAccount('account:foreign')).rejects.toMatchObject({ code: 'invalid_configuration' });
  await client.confirmAccount(account.account_id);
  await client.createOrAttachInstance({ label: 'Synthetic desktop' });
}
function assertIsolated(h: ReturnType<typeof syntheticFixture>) {
  expect(forbiddenCalls).toEqual([]);
  expect(network).not.toHaveBeenCalled();
  expect(h.failures).toEqual([]);
  expect(calls.some(command => /secret|vault|http|shell/.test(command))).toBe(false);
  const persisted = JSON.stringify(h.values) + [...settings.values()].join('');
  for (const secret of h.secrets.values()) expect(persisted).not.toContain(secret);
}
beforeEach(() => {
  calls.length = 0; forbiddenCalls.length = 0; settings.clear(); network.mockClear();
  useAppStore.setState({ standaloneProjects: [{ id: 'project:synthetic', name: 'Synthetic project', path: '/synthetic/project', mountName: 'synthetic', created_at: '2026-01-01T00:00:00Z', status: 'active', gitSetupState: 'not_git', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } }], projectGroups: [] });
  useChatStore.setState({ conversations: [{ id: conversation.id, title: conversation.title, scope_mode: 'Chat', task_id: null, project_id: null, last_message: '', message_count: 1, updated_at: conversation.updated_at, is_unread: false }], messages: [], messagesByConversationId: {},
    questionnaireDraftsByConversationId: {}, pendingToolApprovalByConversationId: {}, conversationRuntimeById: {} });
  useTaskStore.setState({ tasks: [{ id: 'task:synthetic', project_id: 'project:synthetic', title: 'Synthetic task', description: 'A public synthetic card',
    status: 'Pending', task_source: 'standalone', draft: true, plan_id: 'plan:synthetic', plan_title: null, plan_status: null, plan_target_branch: null, standalone_kind: 'manual_feature', base_branch: null, feature_slug: null, conversation_id: null, archived_at: null, archive_reason: null, merged_at: null, assigned_branch: '', branch_name: '', branch_id: null, branch_task_index: 0, blocked_by_task_ids: [], blocked_by: [], is_blocked: false, is_ready: false, needs_revalidation: false, sequence_index: 0, dependencies: [], estimated_changes: [], execution_targets: [{ projectId: 'project:synthetic', executionMode: 'direct', branchName: 'develop', worktreeKey: 'synthetic' }],
  } satisfies ReturnType<typeof useTaskStore.getState>['tasks'][number]] });
});

it('connects, confirms, reads catalogs through the real runtime, restarts, and durably signs out', async () => {
  const h = syntheticFixture();
  let client = new MacroPilotNativeClient(h.dependencies);
  let runtime = new PilotRuntime(client, undefined, desktopStorePorts);
  try {
    await connect(client);
    expect(await client.getAccountCatalog()).toMatchObject({ identity: { login: 'synthetic-only' }, sessions: [{ state: 'active' }] });
    await runtime.start();
    expect(await deliver(h, 'task.cards.list', { instance_id: instanceId })).toMatchObject({ type: 'response', result: { items: [{ title: { text: 'Synthetic task' } }] } });
    expect(await deliver(h, 'conversations.list', { instance_id: instanceId, kind: 'conversation' })).toMatchObject({ type: 'response', result: { items: [{ ref: { conversation_id: conversation.id } }] } });
    const body = { ref: { instance_id: instanceId, kind: 'conversation', conversation_id: conversation.id } };
    expect(JSON.stringify(await deliver(h, 'conversation.read', body))).toContain('Synthetic hello');
    expect(calls).toContain('db_list_messages');
    await runtime.stop();
    client = new MacroPilotNativeClient(h.dependencies);
    runtime = new PilotRuntime(client, undefined, desktopStorePorts);
    await runtime.start();
    expect(client.getState().status).toBe('connected');
    expect(JSON.stringify(await deliver(h, 'conversation.read', body))).toContain('Synthetic hello');
    h.retainSecrets(); // Simulate failed physical cleanup after durable logout.
    expect(await client.logout()).toEqual({ revocationConfirmed: true });
    await runtime.stop();
    const saved = h.values.macro_pilot_native_v1 as { deviceSession: unknown; pendingSecretCleanup: unknown[] };
    expect(saved.deviceSession).toBeNull();
    expect(saved.pendingSecretCleanup.length).toBeGreaterThan(0);
    expect(h.secrets.size).toBeGreaterThan(0);
    const requestsAfterLogout = h.requests.length;
    client = new MacroPilotNativeClient(h.dependencies);
    runtime = new PilotRuntime(client, undefined, desktopStorePorts);
    await runtime.start();
    expect(client.getState().deviceSession).toBeNull();
    expect(runtime.getStatus()).toBe('inactive');
    expect(h.requests).toHaveLength(requestsAfterLogout);
    assertIsolated(h);
  } finally { await runtime.stop(); }
});

it.each(['cancelled', 'intervention_required', 'suspended'] as const)(
  'fences an authorized delivery on %s, preserves the block, and resumes only explicitly', async status => {
    const h = syntheticFixture();
    const client = new MacroPilotNativeClient(h.dependencies);
    const runtime = new PilotRuntime(client, undefined, desktopStorePorts);
    try {
      await connect(client);
      await runtime.start();
      await deliver(h, 'task.cards.list', { instance_id: instanceId });
      let readsAtBlock = 0;
      const resultCount = h.results.length;
      h.onAuthorize(() => {
        readsAtBlock = calls.filter(command => command === 'db_list_messages').length;
        h.block(status);
      });
      h.enqueue(delivery('conversation.read', { ref: { instance_id: instanceId, kind: 'conversation', conversation_id: conversation.id } }));
      await until(() => client.getState().vaultStatus === status && runtime.getStatus() === 'inactive');
      const requestCount = h.requests.length;
      const vaultReadsAtBlock = h.reads;
      for (let i = 0; i < 2; i++) {
        await client.initialize();
        await expect(client.getAccountCatalog()).rejects.toMatchObject({ code: status === 'intervention_required' ? 'vault_intervention_required' : `vault_${status}` });
        await runtime.retry();
      }
      expect(h.resumes).toBe(0);
      expect(h.reads).toBe(vaultReadsAtBlock);
      expect(h.results).toHaveLength(resultCount);
      expect(calls.filter(command => command === 'db_list_messages')).toHaveLength(readsAtBlock);
      expect(h.requests).toHaveLength(requestCount);
      expect(client.getState()).toMatchObject({ status: 'vault_unavailable', vaultStatus: status });
      h.onAuthorize();
      await client.resumeVaultAccess();
      expect(h.resumes).toBe(1);
      expect(JSON.stringify(await deliver(h, 'conversation.read', { ref: { instance_id: instanceId, kind: 'conversation', conversation_id: conversation.id } }))).toContain('Synthetic hello');
      expect(h.requests.filter(item => item.path.endsWith('/claim'))).toHaveLength(1);
      expect(h.requests.filter(item => item.path === '/pilot/v1/instances')).toHaveLength(1);
      assertIsolated(h);
    } finally { await runtime.stop(); }
  },
);

it('rejects real relay destinations and keeps the production HTTPS guard', async () => {
  const h = syntheticFixture();
  const client = new MacroPilotNativeClient(h.dependencies);
  await client.initialize();
  await expect(client.connect('http://127.0.0.1:1422', 'Synthetic desktop')).rejects.toMatchObject({ code: 'invalid_configuration' });
  expect(h.requests).toHaveLength(0);
  await expect(h.dependencies.fetch('https://example.com/pilot/v1/auth/attempts')).rejects.toThrow('Only the synthetic origin');
  expect(h.requests).toHaveLength(0);
  expect(network).not.toHaveBeenCalled();
  expect(forbiddenCalls).toEqual([]);
});

it('discards a late explicit recovery after logout and cannot restart the producer', async () => {
  const h = syntheticFixture();
  const client = new MacroPilotNativeClient(h.dependencies);
  let runtime = new PilotRuntime(client, undefined, desktopStorePorts);
  let release!: () => void;
  let entered = false;
  const resumed = h.dependencies.vaultResume!;
  const wait = new Promise<void>(resolve => { release = resolve; });
  h.dependencies.vaultResume = async (...args) => { entered = true; await wait; return resumed(...args); };
  let recovery: Promise<unknown> | undefined;
  try {
    await connect(client);
    await runtime.start();
    await deliver(h, 'task.cards.list', { instance_id: instanceId });
    h.block('suspended');
    recovery = client.resumeVaultAccess().catch(error => error);
    await until(() => entered);
    h.retainSecrets();
    await client.logout();
    const count = h.requests.length;
    release();
    expect(await recovery).toMatchObject({ code: 'context_changed' });
    expect(client.getState().deviceSession).toBeNull();
    await runtime.stop();
    const restarted = new MacroPilotNativeClient(h.dependencies);
    runtime = new PilotRuntime(restarted, undefined, desktopStorePorts);
    await runtime.start();
    expect(restarted.getState().deviceSession).toBeNull();
    expect(runtime.getStatus()).toBe('inactive');
    expect(h.requests).toHaveLength(count);
    assertIsolated(h);
  } finally { release(); await recovery; await runtime.stop(); }
});
