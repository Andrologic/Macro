// Sends the first message of a published transfer through the ordinary chat
// store, as ChatZone does. Started by the native transfer scenario: commands that
// read the conversation are answered by the native process from its database and
// archive; the first model request is captured and never answered.
// Protocol: JSON lines. stdin carries the setup, then native replies. stdout lines
// prefixed with NEXT_REQUEST: carry native calls and the captured request.
import { mock } from 'bun:test';
import type { Conversation, ProviderConfig } from '../src/types';

interface Setup {
  conversation: Conversation;
  provider: { id: string; type: string; modelId: string; contextWindowTokens: number };
  prompt: string;
}
type Reply = { id: number; ok?: unknown; error?: string };

const NATIVE = new Set([
  'db_list_messages', 'db_list_conversation_citations', 'db_get_conversation_compaction_state', 'db_pilot_message_images',
  'connect_archive_open', 'connect_archive_page', 'connect_archive_materialize', 'connect_archive_release',
]);
const emit = (value: unknown) => process.stdout.write(`NEXT_REQUEST:${JSON.stringify(value)}\n`);
const lines = (async function* () {
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      yield buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
    }
  }
})();
const next = async () => {
  const line = await lines.next();
  if (line.done) throw new Error('native_closed');
  return JSON.parse(line.value) as unknown;
};
let sequence = 0;
let pending = Promise.resolve();
const native = (command: string, args: unknown) => {
  // Serialize round trips: the native side answers one call at a time.
  const result = pending.then(async () => {
    const id = ++sequence;
    emit({ id, command, args });
    const reply = await next() as Reply;
    if (reply.id !== id) throw new Error('native_reply_out_of_order');
    if (reply.error !== undefined) throw new Error(reply.error);
    return reply.ok;
  });
  pending = result.then(() => undefined, () => undefined);
  return result;
};

const setup = await next() as Setup;
const settings = new Map<string, string>();
const unexpected: string[] = [];
let captured = false;
let purpose: string | null = null;
const capture = (request: unknown) => {
  if (captured) return;
  captured = true;
  emit({ request, purpose });
  // A compaction request blocks the send until it is answered: stop here,
  // once stdout has been flushed.
  process.stdout.write(`NEXT_REQUEST:${JSON.stringify({ done: true, unexpected })}\n`, () => process.exit(0));
};
const invoke = mock(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (command === 'ai_stream_chat') {
    capture({ kind: 'native', body: args!.request });
    return;
  }
  if (NATIVE.has(command)) return native(command, args);
  if (command === 'db_list_provider_models') {
    // The context window is a per-model user setting: impose the scenario's.
    const models = await native(command, args) as Record<string, unknown>[];
    const window = { context_window_tokens: setup.provider.contextWindowTokens, context_window_source: 'user_override' };
    const selected = models.filter(model => model.model_id === setup.provider.modelId);
    return selected.length ? models.map(model => model.model_id === setup.provider.modelId ? { ...model, ...window } : model)
      : [...models, { id: setup.provider.modelId, provider_id: setup.provider.id, model_id: setup.provider.modelId, name: 'Target model',
        description: null, owned_by: null, pricing_prompt: null, pricing_completion: null, pricing_request: null,
        reasoning_efforts: null, default_reasoning_effort: null, input_limit_tokens: null, output_limit_tokens: null,
        context_limits_updated_at: null, is_enabled: true, is_manual: true, first_seen_at: '2026-01-01T00:00:00Z',
        last_seen_at: '2026-01-01T00:00:00Z', ...window }];
  }
  switch (command) {
    case 'mcp_runtime_get_snapshot': return { generatedAt: '2026-01-01T00:00:00Z', servers: [] };
    case 'workspace_architect_list_plans': return { activePlanId: null, plans: [] };
    case 'db_get_project_context_state':
    case 'ai_get_dev_provider_overrides': return null;
    case 'db_reveal_provider_api_key': return 'synthetic-key';
    case 'ai_sync_provider_models':
    case 'db_list_provider_configs': return [];
    case 'config_get_snapshot': return { effective: { agents: {}, tools: { riskLevel: 'balanced', builtIn: {}, modes: {}, mcpServers: {} }, providers: {} }, projectEffective: {} };
    case 'tool_get_mode_policy': return { allowed_tool_ids: [], enforce_macro_only_writes: false };
    // Settings are read from the database (provenance receipts live there);
    // writes stay in memory.
    case 'db_get_app_setting': return settings.has(String(args!.key))
      ? { key: args!.key, value_json: settings.get(String(args!.key)) } : native(command, args);
    case 'db_set_app_setting': settings.set(String(args!.key), String(args!.valueJson)); return;
    case 'db_compare_and_swap_app_setting': {
      const params = args as { key: string; expectedValueJson: string | null; valueJson: string };
      const stored = settings.has(params.key) ? settings.get(params.key)!
        : (await native('db_get_app_setting', { key: params.key }) as { value_json: string } | null)?.value_json ?? null;
      const applied = stored === params.expectedValueJson;
      if (applied) settings.set(params.key, params.valueJson);
      return { applied };
    }
    case 'db_delete_app_setting': settings.delete(String(args!.key)); return;
    case 'chat_admission_begin_intent': return { kind: 'conversation' };
    // A published transfer is a Global Chat conversation: native admission
    // owns the provider request, whose body is captured instead of sent.
    case 'chat_admission_begin': purpose = String(args!.purpose); return { kind: 'globalChat', context: { handle: 'next-request', runtime: String(args!.runtime) } };
    case 'chat_admission_http_start': {
      const request = args!.request as { url: string; body: string };
      capture({ kind: 'http', url: request.url, body: JSON.parse(request.body) });
      return new Promise(() => {});
    }
    case 'db_get_conversation_toolbox_state': return null;
    // The new turn stays in memory; the published rows are not modified.
    case 'db_create_message': {
      const p = args!.params as Record<string, unknown>;
      return { id: p.id ?? crypto.randomUUID(), conversation_id: p.conversationId, role: p.role, content: p.content,
        turn_id: p.turnId, created_at: new Date().toISOString(), token_count: 0, context_refs_json: '[]' };
    }
    case 'chat_admission_reserve_response': {
      const context = args!.context as { runtime: string };
      return { operationId: 'next-request', runtime: context.runtime, revision: 1, identity: { conversationId: args!.conversationId } };
    }
    case 'db_update_message':
    case 'db_delete_conversation_toolbox_state':
    case 'chat_admission_finish_intent':
    case 'chat_admission_close_preparation':
    case 'chat_admission_acknowledge_completion': return;
    case 'config_list_pending_changes': return [];
    case 'state_get_snapshot':
    case 'state_patch': return { schemaVersion: 1, values: {} };
    case 'repository_instructions_load': return { sources: [], issues: [], totalBytes: 0, fileLimit: 10, byteLimit: 10000 };
    case 'frontend_log':
    case 'db_update_conversation_ai_selection':
    case 'db_update_conversation':
    case 'db_upsert_conversation_context_diagnostics':
    case 'ai_cancel_stream': return;
    default: unexpected.push(command); throw new Error(`Unhandled next-request IPC: ${command}`);
  }
});
mock.module('../src/services/tauriRuntimeBridge', () => ({
  invoke,
  isBrowserRuntimeBridgeEnabled: () => false,
  listen: async () => () => {},
}));
mock.module('@tauri-apps/plugin-http', () => ({
  fetch: async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://models.dev/api.json') return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    capture({ kind: 'http', url: String(url), body: JSON.parse(String(init?.body)) });
    // The request stays open: no model is called.
    return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
  },
}));
Object.assign(globalThis, { window: Object.assign(globalThis.window ?? {}, { __TAURI_INTERNALS__: { invoke } }) });

const { useChatStore } = await import('../src/stores/useChatStore');
const { useProviderStore } = await import('../src/stores/useProviderStore');
const { useAppStore } = await import('../src/stores/useAppStore');
const provider: ProviderConfig = {
  id: setup.provider.id, name: 'Target provider', providerType: setup.provider.type,
  baseUrl: setup.provider.type === 'chatgpt' ? '' : 'https://synthetic.invalid/v1',
  hasStoredApiKey: setup.provider.type !== 'chatgpt', isEnabled: true, isLocal: false,
  authStatus: 'authenticated', nativeToolCalling: setup.provider.type === 'chatgpt',
};
useAppStore.setState({ mode: 'Chat' });
useProviderStore.setState({
  isLoading: false, providerConfigs: [provider],
  selectedProviderId: provider.id, selectedModelId: setup.provider.modelId,
  modelsByProvider: { [provider.id]: [{ id: setup.provider.modelId, name: 'Target model', provider_id: provider.id,
    isEnabled: true, nativeToolCalling: provider.nativeToolCalling,
    contextWindowTokens: setup.provider.contextWindowTokens, contextWindowSource: 'user_override' }] },
});
useChatStore.setState({ conversations: [setup.conversation] });
try {
  if (!await useChatStore.getState().selectConversation(setup.conversation.id)) throw new Error('select_failed');
  const result = await useChatStore.getState().sendMessage({ conversationId: setup.conversation.id, content: setup.prompt });
  // The launch continues after sendMessage resolves: wait for the first model
  // request, or for the turn to end without one.
  const ended = () => !useChatStore.getState().conversationRuntimeById[setup.conversation.id];
  for (let waited = 0; !captured && waited < 15_000 && !(waited > 100 && ended()); waited += 10) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!captured) {
    const assistant = useChatStore.getState().messages.filter(message => message.role === 'assistant').at(-1);
    emit({ result, assistant: assistant?.content ?? null, error: useChatStore.getState().error ?? null });
  }
} catch (error) {
  emit({ failure: error instanceof Error ? error.message : String(error), unexpected });
}
process.stdout.write(`NEXT_REQUEST:${JSON.stringify({ done: true, unexpected })}\n`, () => process.exit(0));
