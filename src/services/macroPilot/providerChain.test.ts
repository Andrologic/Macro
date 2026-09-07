import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Conversation, ProviderConfig, Project } from '../../types';
import type { CatalogedImplementTask } from '../implementTaskCatalog';

// Exercise the desktop action, stores, orchestration, serializer and adapter.
// Only native IPC/events and the HTTP plugin are replaced; no account or disk is read.
const listeners = new Map<string, Set<(event: { payload: Record<string, unknown> }) => void>>();
const requests: Record<string, unknown>[] = [];
const commands: string[] = [];
const unexpectedCommands: string[] = [];
const toolResults: Record<string, unknown>[] = [];
let allowedTools: string[] = [];
let persistedTask: CatalogedImplementTask;
let scopedModels: Record<string, unknown> = {};
let httpBodyCancelled = false;
let httpController: ReadableStreamDefaultController<Uint8Array> | null = null;
let lastHttp: { url: string; init: RequestInit } | null = null;
let messageSequence = 0;
const messages: Record<string, unknown>[] = [];
const settings = new Map<string, string>();
const config = () => ({
  effective: { agents: {}, tools: { riskLevel: 'balanced', builtIn: Object.fromEntries(allowedTools.map((id) => [id, true])), modes: {}, mcpServers: {} }, providers: {} },
  projectEffective: { 'project-target': { agents: { models: scopedModels }, tools: { riskLevel: 'balanced', builtIn: Object.fromEntries(allowedTools.map((id) => [id, true])), modes: {}, mcpServers: {} } } },
});
const invoke = mock(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  commands.push(command);
  switch (command) {
    case 'mcp_runtime_get_snapshot': return { generatedAt: '2026-01-01T00:00:00Z', servers: [] };
    case 'fs_list_dir': return [];
    case 'fs_read_file': return { content: '', language: 'text', is_binary: false, size: 0, encoding: 'utf8' };
    case 'workspace_architect_list_plans': return { activePlanId: null, plans: [] };
    case 'db_get_project_context_state': return null;
    case 'db_delete_messages_after': messages.splice(messages.findIndex((message) => message.id === args!.afterMessageId) + 1); return;
    case 'db_reveal_provider_api_key': return 'synthetic-key';
    case 'ai_submit_tool_result': toolResults.push(args!.request as Record<string, unknown>); return;
    case 'workspace_get_active_root': return project.path;
    case 'workspace_list_tasks': return { tasks: [persistedTask] };
    case 'workspace_update_standalone_task_status': persistedTask = { ...persistedTask, status: args!.status as CatalogedImplementTask['status'] }; return;
    case 'direct_checkpoint_ensure':
    case 'workspace_set_active_root': return;
    case 'config_get_snapshot': return config();
    case 'tool_get_mode_policy': return { allowed_tool_ids: allowedTools, enforce_macro_only_writes: false };
    case 'db_set_app_setting': {
      const params = args as { key: string; valueJson: string };
      settings.set(params.key, params.valueJson); return;
    }
    case 'db_delete_app_setting': settings.delete(String(args!.key)); return;
    case 'terminal_read':
    case 'terminal_run': return { id: 'synthetic-terminal', project_id: null, cwd: '/synthetic/target', status: 'idle', output: 'Synthetic output', project_name: null, mount_name: null, workspace_path: null, last_command: null, exit_code: 0, timed_out: false, output_truncated: false, updated_at: '2026-01-01T00:00:00Z' };
    case 'db_get_app_setting': return settings.has(String(args!.key)) ? { key: args!.key, value_json: settings.get(String(args!.key)) } : null;
    case 'db_get_conversation_compaction_state': return null;
    case 'config_list_pending_changes': return [];
    case 'state_get_snapshot': return { schemaVersion: 1, values: {} };
    case 'state_patch': return { schemaVersion: 1, values: {} };
    case 'db_list_messages': return messages;
    case 'db_create_message': {
      const p = args!.params as Record<string, unknown>;
      const message = { id: p.id ?? `message-${++messageSequence}`, conversation_id: p.conversationId,
        role: p.role, content: p.content, turn_id: p.turnId, created_at: new Date().toISOString(),
        token_count: 0, tool_traces_json: p.toolTracesJson, hidden_context: p.hiddenContext };
      messages.push(message);
      return message;
    }
    case 'repository_instructions_load': return { sources: [], issues: [], totalBytes: 0, fileLimit: 10, byteLimit: 10000 };
    case 'ai_stream_chat': {
      requests.push(args!.request as Record<string, unknown>);
      return;
    }
    case 'frontend_log':
    case 'db_update_conversation_ai_selection':
    case 'db_delete_conversation_toolbox_state':
    case 'db_update_message':
    case 'db_update_conversation':
    case 'db_upsert_conversation_context_diagnostics':
    case 'db_upsert_conversation_toolbox_state':
    case 'ai_cancel_stream': return;
    default: unexpectedCommands.push(command); throw new Error(`Unhandled test IPC: ${command}`);
  }
});
mock.module('../tauriRuntimeBridge', () => ({
  invoke,
  isBrowserRuntimeBridgeEnabled: () => false,
  listen: async (event: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    const handlers = listeners.get(event) ?? new Set();
    listeners.set(event, handlers);
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  },
}));
const httpFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
  lastHttp = { url: String(url), init: init ?? {} };
  const body = new ReadableStream<Uint8Array>({ start(controller) { httpController = controller;
    init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
  }, cancel() { httpBodyCancelled = true; } });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
});
mock.module('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));
const { desktopActions } = await import('./desktopActions');
const { useAppStore } = await import('../../stores/useAppStore');
const { useTaskStore } = await import('../../stores/useTaskStore');
const { useChatStore } = await import('../../stores/useChatStore');
const { useProviderStore } = await import('../../stores/useProviderStore');
const { useToolsStore } = await import('../../stores/useToolsStore');
const { useConfigStore } = await import('../../stores/useConfigStore');
const initialChat = useChatStore.getState();
const initialTask = useTaskStore.getState();
const initialProvider = useProviderStore.getState();
const initialApp = useAppStore.getState();
const initialTools = useToolsStore.getState();
const initialConfig = useConfigStore.getState();
const { useTerminalStore } = await import('../../stores/useTerminalStore');
const initialTerminal = useTerminalStore.getState();
const guard = { assertCurrent() {}, async authorizeBeforeEffect() {} };
const project: Project = {
  id: 'project-target', name: 'Target', path: '/synthetic/target', mountName: 'target',
  created_at: '2026-01-01T00:00:00Z', status: 'active', directEdit: true,
  metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
};
const task: CatalogedImplementTask = {
  id: 'task-target', plan_id: '', project_id: project.id, project_ids: [project.id],
  title: 'Synthetic task', description: 'Work on the target project', status: 'InProgress',
  dependencies: [], estimated_changes: [], assigned_branch: '', branch_name: '', branch_id: null,
  branch_task_index: 0, blocked_by_task_ids: [], blocked_by: [], is_blocked: false, is_ready: true,
  needs_revalidation: false, sequence_index: 0,
  execution_targets: [{ projectId: project.id, branchName: '', worktreeKey: 'target', checkpointId: 'synthetic-checkpoint', executionMode: 'direct', repoPath: project.path }],
  task_source: 'standalone', plan_title: null, plan_status: null, plan_target_branch: null,
  draft: false, standalone_kind: 'legacy', base_branch: null, feature_slug: null,
  conversation_id: 'conversation-target', archived_at: null, archive_reason: null, merged_at: null,
};
const provider: ProviderConfig = {
  id: 'custom-chatgpt', name: 'Synthetic linked provider', providerType: 'chatgpt', baseUrl: '',
  hasStoredApiKey: false, isEnabled: true, isLocal: false, authStatus: 'authenticated', nativeToolCalling: true,
};
const conversation: Conversation = {
  id: 'conversation-target', title: 'Target conversation', description: '', scope_mode: 'Implement',
  task_id: task.id, group_id: 'group-target', project_id: project.id, provider_id: provider.id,
  model_id: 'synthetic-model', reasoning_effort: null, last_message: '', message_count: 1,
  updated_at: '2026-01-01T00:00:00Z', is_unread: false,
};
const eventually = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
};
const emit = (event: string, payload: Record<string, unknown>) => {
  for (const handler of listeners.get(event) ?? []) handler({ payload });
};
beforeEach(() => {
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
  invoke.mockClear(); httpFetch.mockClear();
  unexpectedCommands.length = 0; toolResults.length = 0; allowedTools = [];
  persistedTask = { ...task }; scopedModels = {}; lastHttp = null; httpController = null; httpBodyCancelled = false;
  settings.clear();
  commands.length = 0; requests.length = 0; messages.length = 0; listeners.clear();
  messages.push({ id: 'prior-user', conversation_id: conversation.id, role: 'user', content: 'Prior context', created_at: '2026-01-01T00:00:00Z' });
  useAppStore.setState({ ...initialApp, mode: 'Chat', selectedGroupId: 'group-target', selectedProjectId: 'project-other', selectedTaskId: 'task-other',
    projectGroups: [{ id: 'group-target', name: 'Synthetic', isOpen: true, projects: [project, { ...project, id: 'project-other', name: 'Other', path: '/synthetic/other' }] }], standaloneProjects: [] }, true);
  useTaskStore.setState({ ...initialTask, tasks: [persistedTask] }, true);
  useChatStore.setState({ ...initialChat, conversations: [{ ...conversation }, { ...conversation, id: 'conversation-other', scope_mode: 'Chat', task_id: null, project_id: 'project-other', provider_id: 'provider-other', model_id: 'model-other' }], selectedConversationId: 'conversation-other' }, true);
  useProviderStore.setState({ ...initialProvider, isLoading: false, providerConfigs: [{ ...provider }],
    selectedProviderId: 'provider-other', selectedModelId: 'model-other',
    providerSettingsById: { [provider.id]: { providerId: provider.id, filterFreeModels: false, copilotSendTimeoutMs: 45000 } },
    modelsByProvider: { [provider.id]: [{ id: 'synthetic-model', name: 'Synthetic model', provider_id: provider.id, isEnabled: true,
      nativeToolCalling: true, contextWindowTokens: 100000, contextWindowSource: 'user_override' }] } }, true);
  useToolsStore.setState(initialTools, true);
  useConfigStore.setState(initialConfig, true);
  useTerminalStore.setState(initialTerminal, true);
});
afterEach(async () => {
  useChatStore.getState().stopConversationStream(conversation.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(unexpectedCommands).toEqual([]);
  expect([...listeners.values()].every((handlers) => handlers.size === 0)).toBe(true);
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});
afterAll(() => {
  useAppStore.setState(initialApp, true);
  useTaskStore.setState(initialTask, true);
  useChatStore.setState(initialChat, true);
  useProviderStore.setState(initialProvider, true);
  useToolsStore.setState(initialTools, true);
  useConfigStore.setState(initialConfig, true);
  useTerminalStore.setState(initialTerminal, true);
  mock.restore();
});
const cases = [
  { name: 'ChatGPT native', type: 'chatgpt', local: false, native: true },
  { name: 'Copilot native', type: 'copilot', local: false, native: true },
  { name: 'OpenAI-compatible HTTP', type: 'openai', local: false, native: false },
  { name: 'local native', type: 'ollama', local: true, native: true },
];
const configureProvider = (entry: typeof cases[number]) => {
  useProviderStore.setState({ providerConfigs: [{ ...provider, providerType: entry.type, isLocal: entry.local,
    baseUrl: 'https://synthetic.invalid/v1', apiKey: undefined,
    apiKeyLoaded: false, hasStoredApiKey: !entry.native,
    authStatus: entry.type === 'copilot' ? 'connected' : 'authenticated' }] });
};
const complete = async (native: boolean) => {
  if (native) {
    emit('ai:done', { request_id: requests.at(-1)!.request_id, output_text: 'Synthetic answer', tool_calls: [] });
  } else {
    httpController!.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Synthetic answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    httpController!.close();
  }
  await eventually(() => !useChatStore.getState().conversationRuntimeById[conversation.id]);
  expect(useChatStore.getState().messages.some((message) => message.content === 'Synthetic answer')).toBe(true);
};
describe('Pilot provider chain', () => {
  it.each(cases)('routes a targeted reply through $name while another conversation is selected', async (entry) => {
    configureProvider(entry);
    await desktopActions.reply(task.id, conversation.id, 'Continue the target task', guard);
    await eventually(() => entry.native ? requests.length === 1 : lastHttp !== null);
    if (entry.native) {
      expect(requests[0]).toMatchObject({ provider_id: provider.id, model_id: 'synthetic-model', conversation_id: conversation.id,
        workspace_path: project.path, focused_project_id: project.id });
      expect(lastHttp).toBeNull();
      expect(requests[0]!.copilot_send_timeout_ms).toBe(entry.type === 'copilot' ? 45000 : null);
    } else {
      expect(requests).toHaveLength(0);
      expect(lastHttp!.url).toBe('https://synthetic.invalid/v1/chat/completions');
      expect(new Headers(lastHttp!.init.headers).get('Authorization')).toBe('Bearer synthetic-key');
      expect(JSON.parse(String(lastHttp!.init.body))).toMatchObject({ model: 'synthetic-model', stream: true });
    }
    expect(useChatStore.getState().conversations.find((item) => item.id === conversation.id))
      .toMatchObject({ provider_id: provider.id, model_id: 'synthetic-model', reasoning_effort: null });
    await complete(entry.native);
    expect(useChatStore.getState().selectedConversationId).toBe('conversation-other');
    expect(useAppStore.getState().selectedProjectId).toBe('project-other');
  });
  it.each(['Pending', 'Failed'] as const)('starts a %s task through the real task store', async (status) => {
    persistedTask = { ...task, status };
    useTaskStore.setState({ tasks: [persistedTask] });
    const result = await desktopActions.start(task.id, guard);
    await eventually(() => requests.length === 1);
    expect(result.conversationId).toBe(conversation.id);
    expect(useTaskStore.getState().getTaskById(task.id)?.status).toBe('InProgress');
    await complete(true);
  });
  it('resumes an AwaitingResponse task and uses the project model ahead of conversation and UI models', async () => {
    persistedTask = { ...task, status: 'AwaitingResponse' };
    useTaskStore.setState({ tasks: [persistedTask] });
    const projectProvider = { ...provider, id: 'project-http', providerType: 'openai', baseUrl: 'https://project.invalid/v1', hasStoredApiKey: true, authStatus: undefined };
    scopedModels = { implementBuild: { providerId: projectProvider.id, modelId: 'project-model', reasoningEffort: null } };
    useProviderStore.setState({ providerConfigs: [provider, projectProvider], modelsByProvider: { [projectProvider.id]: [{
      ...useProviderStore.getState().modelsByProvider[provider.id]![0]!, id: 'project-model',
    }] } });
    await desktopActions.reply(task.id, conversation.id, 'Approved direction', guard);
    await eventually(() => lastHttp !== null);
    expect(requests).toHaveLength(0);
    expect(lastHttp!.url).toBe('https://project.invalid/v1/chat/completions');
    expect(JSON.parse(String(lastHttp!.init.body)).model).toBe('project-model');
    expect(useTaskStore.getState().getTaskById(task.id)?.status).toBe('InProgress');
    await complete(false);
  });
  it.each(cases)('cancels the targeted $name transport', async (entry) => {
    configureProvider(entry);
    await desktopActions.reply(task.id, conversation.id, 'Continue', guard);
    await eventually(() => entry.native ? requests.length === 1 : lastHttp !== null);
    await desktopActions.cancel(conversation.id, guard);
    await eventually(() => useChatStore.getState().getConversationRuntime(conversation.id).phase === 'idle');
    if (entry.native) {
      expect(invoke.mock.calls.filter(([command]) => command === 'ai_cancel_stream').at(-1)?.[1])
        .toEqual({ requestId: requests[0]!.request_id });
    } else {
      await eventually(() => httpBodyCancelled);
      expect(httpBodyCancelled).toBe(true);
      expect(commands).not.toContain('ai_cancel_stream');
    }
    expect(useChatStore.getState().selectedConversationId).toBe('conversation-other');
  });

  it('resumes a questionnaire created by a native provider tool request', async () => {
    allowedTools = ['question'];
    await desktopActions.reply(task.id, conversation.id, 'Ask for clarification', guard);
    await eventually(() => requests.length === 1);
    emit('ai:tool-request', { request_id: requests[0]!.request_id, tool_call_id: 'question-call', tool_name: 'question',
      args: { questions: [{ id: 'scope', prompt: 'Which scope?', choices: ['Small', 'Medium', 'Large'] }] } });
    await eventually(() => toolResults.length === 1);
    expect(toolResults[0]).toMatchObject({ tool_call_id: 'question-call', interrupt: true, is_error: false });
    emit('ai:done', { request_id: requests[0]!.request_id, output_text: toolResults[0]!.visible_content, hidden_context: toolResults[0]!.hidden_context, tool_calls: [], completion_reason: 'stop' });
    await eventually(() => !useChatStore.getState().conversationRuntimeById[conversation.id]);
    const questionnaire = useChatStore.getState().getActiveQuestionnaire(conversation.id);
    expect(questionnaire?.taskId).toBe(task.id);
    await desktopActions.answerDecision({ conversation_id: conversation.id,
      assistant_message_id: questionnaire!.assistantMessageId, task_id: task.id }, [{ step_id: 'scope', answer: 'Small' }], guard);
    await eventually(() => requests.length === 2);
    expect(requests[1]).toMatchObject({ provider_id: provider.id, model_id: 'synthetic-model', conversation_id: conversation.id });
    expect(JSON.stringify(requests[1]!.messages)).toContain('Small');
    await complete(true);
  });

  it.each([cases[0]!, cases[2]!])('continues $name after Pilot approval', async (entry) => {
    configureProvider(entry);
    allowedTools = ['terminal_run'];
    await desktopActions.reply(task.id, conversation.id, 'Run the requested command', guard);
    await eventually(() => entry.native ? requests.length === 1 : lastHttp !== null);
    const toolArgs = { session_id: 'synthetic-terminal', command: 'echo synthetic' };
    if (entry.native) {
      emit('ai:tool-request', { request_id: requests[0]!.request_id, tool_call_id: 'terminal-call', tool_name: 'terminal_run', args: toolArgs });
    } else {
      const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'terminal-call', type: 'function', function: { name: 'terminal_run', arguments: JSON.stringify(toolArgs) } }] }, finish_reason: 'tool_calls' }] };
      httpController!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`));
      httpController!.close();
    }
    await eventually(() => Boolean(useChatStore.getState().getPendingToolApproval(conversation.id)));
    expect(toolResults).toHaveLength(0);
    expect(commands).not.toContain('terminal_run');
    const approval = useChatStore.getState().getPendingToolApproval(conversation.id)!;
    await desktopActions.resolveApproval({ conversation_id: conversation.id,
      assistant_message_id: approval.assistantMessageId, tool_call_id: 'terminal-call' },
    { verdict: 'approve', grant_scope: 'once' }, guard);
    if (entry.native) {
      await eventually(() => toolResults.length === 1);
      expect(toolResults[0]).toMatchObject({ request_id: requests[0]!.request_id, tool_call_id: 'terminal-call', is_error: false });
      expect(requests).toHaveLength(1);
    } else {
      await eventually(() => httpFetch.mock.calls.length === 2);
      const transcript = JSON.parse(String(lastHttp!.init.body)).messages;
      expect(transcript).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'terminal-call', content: expect.stringContaining('Synthetic output') }));
      expect(requests).toHaveLength(0);
      expect(toolResults).toHaveLength(0);
    }
    expect(commands).toContain('terminal_run');
    expect(useChatStore.getState().getPendingToolApproval(conversation.id)).toBeNull();
    await complete(entry.native);
  });

});
