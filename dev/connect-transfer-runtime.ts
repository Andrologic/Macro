// Runs the real Pilot runtime of one desktop in the native transfer scenario.
// The runtime starts as in the app and listens for transfers on its own; the
// source sends when the native process asks it to. Transfer, chat admission and
// conversation commands are answered by the native process. Content polls reach
// the local relay, so the runtime elects its producer with its own capabilities;
// the rest of the phone relay and the Pilot content stores are local fakes.
// Protocol: JSON lines. stdin carries the setup, native replies and controls;
// stdout lines prefixed with TRANSFER_RUNTIME: carry native calls and events.
import { mock } from 'bun:test';
import type { ConnectTransferSendInput } from '../src/services/ipc/pilot';

interface Setup {
  role: 'source' | 'target';
  connection: Omit<ConnectTransferSendInput['connection'], 'capabilities'>;
  send?: { conversationId: string; targetInstanceId: string; providerId: string; modelId: string };
  /** Loopback relay and this instance's credentials, held natively in the app. */
  relay: { url: string; token: string; key: string };
}
type Line = { id?: number; ok?: unknown; error?: unknown; control?: 'send' | 'stop' };

const NATIVE = new Set([
  'connect_transfer_send', 'connect_transfer_receive', 'connect_transfer_interrupt_idle',
  'chat_admission_open_browser', 'chat_admission_begin_reconciliation', 'chat_admission_complete_reconciliation',
  'db_list_conversations', 'db_conversation_metadata', 'db_list_messages',
]);
const emit = (value: unknown) => process.stdout.write(`TRANSFER_RUNTIME:${JSON.stringify(value)}\n`);
const replies = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
const controls: Array<Line['control']> = [];
let wakeControl: (() => void) | undefined;
let sequence = 0;
// Calls run concurrently: a pending receive must not block the send that
// interrupts it, as with Tauri IPC.
const native = (command: string, args: unknown) => new Promise<unknown>((resolve, reject) => {
  const id = ++sequence;
  replies.set(id, { resolve, reject });
  emit({ id, command, args });
});
let setupReady: (setup: Setup) => void;
const setupLine = new Promise<Setup>(resolve => { setupReady = resolve; });
void (async () => {
  let buffer = '', first = true;
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = JSON.parse(buffer.slice(0, end)) as Line;
      buffer = buffer.slice(end + 1);
      if (first) { first = false; setupReady(line as unknown as Setup); continue; }
      if (line.control) { controls.push(line.control); wakeControl?.(); continue; }
      const pending = replies.get(line.id!);
      replies.delete(line.id!);
      if ('error' in line) pending?.reject(line.error); else pending?.resolve(line.ok);
    }
  }
  // The native process is gone: never outlive it.
  process.exit(1);
})();
const control = async () => {
  while (!controls.length) await new Promise<void>(resolve => { wakeControl = resolve; });
  return controls.shift()!;
};

const setup = await setupLine;
const settings = new Map<string, string>();
const unexpected: string[] = [];
const core = await import('@tauri-apps/api/core');
mock.module('@tauri-apps/api/core', () => ({ ...core, invoke: async (command: string, args: Record<string, unknown> = {}) => {
  if (NATIVE.has(command)) return native(command, args);
  // Pilot content for the phone: an empty, current catalog.
  if (command === 'pilot_content_policy') return [];
  if (command === 'pilot_files_authorize') return;
  if (command === 'pilot_files_list') return [];
  if (command === 'db_conversation_catalog_version') return { version: 1, generation: 'd'.repeat(32), incarnation: 'e'.repeat(32), revision: '1' };
  if (command === 'db_conversation_catalog_page') return { token: { version: 1, generation: 'd'.repeat(32), incarnation: 'e'.repeat(32), revision: '1' }, total_raw: '0', items: [], next_after: null, admission_estimate_bytes: 8192 };
  if (command === 'host_telemetry_read') return { sampleId: 'sample:synthetic', observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5000).toISOString(), availability: 'available', reason: null, cpuPercent: 25, memoryUsedBytes: 1024, memoryTotalBytes: 4096 };
  if (command === 'workspace_list_tasks') return { tasks: [] };
  // Settings are read from the database; writes stay in memory.
  if (command === 'db_get_app_setting') return settings.has(String(args.key))
    ? { key: args.key, value_json: settings.get(String(args.key)) } : native(command, args);
  if (command === 'db_compare_and_swap_app_setting') {
    const stored = settings.has(String(args.key)) ? settings.get(String(args.key))!
      : (await native('db_get_app_setting', { key: args.key }) as { value_json: string } | null)?.value_json ?? null;
    const applied = stored === args.expectedValueJson;
    if (applied) settings.set(String(args.key), String(args.valueJson));
    return { applied };
  }
  if (command === 'frontend_log') { process.stderr.write(`${String(args.message)}\n`); return; }
  unexpected.push(command);
  throw new Error(`Unhandled transfer-runtime IPC: ${command}`);
} }));
mock.module('../src/services/macroPilot/desktopTaskCatalog', () => ({ desktopPilotTasks: () => [] }));
// A browser window, as in the app, seen by the IPC wrappers as the native
// desktop runtime (`requireNativePilotVault`).
const { Window } = await import('happy-dom');
const page = new Window({ url: 'http://localhost/' });
Object.assign(page, { __TAURI_INTERNALS__: { invoke: () => undefined } });
for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'navigator']) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? page : page[key as keyof typeof page] });
}

const { PilotRuntime } = await import('../src/services/macroPilot/runtime');
const { MacroPilotNativeClient } = await import('../src/services/macroPilot/nativeClient');
const { desktopStorePorts } = await import('../src/composition/macroPilotDesktop');
const { useChatStore } = await import('../src/stores/useChatStore');

// The phone-facing relay is a local fake, except for content polls.
const account = { contract_version: '1.0', type: 'account', account_id: setup.connection.accountId, identity: { provider: 'github', subject: '1', login: 'synthetic' }, revision: 1 };
const session = { contract_version: '1.0', type: 'device_session', ref: { type: 'session', account_id: account.account_id, session_id: 'session:desktop' }, device_id: 'device:desktop', state: 'active', issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), revision: 1 };
const values: Record<string, unknown> = { macro_pilot_native_v1: { configurationId: 'config:synthetic', relayOrigin: 'https://pilot.example.test', account, deviceSession: session,
  instance: { contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: setup.connection.instanceId }, label: setup.role, connection_state: 'reachable', supported_contract_versions: ['1.0'], revision: 1 }, instanceCreationId: 'creation:synthetic' } };
const idle = (signal?: AbortSignal | null) => new Promise<never>((_resolve, reject) => {
  if (signal?.aborted) reject(new Error('aborted')); else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});
const client = new MacroPilotNativeClient({
  randomBytes: size => crypto.getRandomValues(new Uint8Array(size)),
  sha256: async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value))),
  now: () => new Date(),
  getStateSnapshot: async () => ({ schemaVersion: 1, values }),
  setStateValue: async (key, value) => { values[key] = structuredClone(value); return { schemaVersion: 1, values }; },
  secretRead: async () => 'd'.repeat(43), secretWrite: async () => {}, secretDelete: async () => {},
  fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    const requestId = new Headers(init?.headers).get('x-request-id')!;
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
    if (path.endsWith('/me')) return json({ account, device_session: session });
    if (path.endsWith('/disconnect')) return new Response(null, { status: 204 });
    if (path === `/pilot/v2/instances/${setup.connection.instanceId}/deliveries/poll`) {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${setup.relay.token}`);
      headers.set('x-instance-key', setup.relay.key);
      const relayed = await fetch(`${setup.relay.url}${path}`, { method: 'POST', headers, body: init?.body, signal: init?.signal });
      // As received from the configured origin: the loopback URL is not a redirect.
      return new Response(relayed.status === 204 ? null : await relayed.arrayBuffer(), { status: relayed.status, headers: relayed.headers });
    }
    if (path.endsWith('/poll') || path.endsWith('/events')) return idle(init?.signal);
    throw new Error(`Unexpected Pilot HTTP: ${path}`);
  },
});
client.transferConnection = capabilities => ({ ...setup.connection, capabilities: [...capabilities] });
const runtime = new PilotRuntime(client, undefined, desktopStorePorts);
await runtime.start();
emit({ event: 'started' });
for (;;) {
  const next = await control();
  if (next === 'stop') break;
  if (next === 'send') {
    const { conversationId, targetInstanceId, providerId, modelId } = setup.send!;
    try {
      const target = await runtime.sendConversation(conversationId, targetInstanceId, { providerId, modelId });
      emit({ event: 'sent', target });
    } catch (error) {
      emit({ event: 'failed', error: error instanceof Error ? { message: error.message, outcome: (error as { outcome?: string }).outcome ?? null } : error });
    }
  }
}
const conversations = useChatStore.getState().conversations.map(conversation => conversation.id);
await runtime.stop();
emit({ event: 'stopped', conversations, unexpected });
process.stdout.write('', () => process.exit(0));
