import type {
  InvokeArgs,
  InvokeOptions,
} from '@tauri-apps/api/core';
import type {
  Event,
  EventCallback,
  EventName,
  Options,
  UnlistenFn,
} from '@tauri-apps/api/event';
import type { McpInteractionRequest } from '../types/generated/ipc';

const BRIDGE_PORT = 1430;
const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;
const INVOKE_TIMEOUT_MS = 10 * 60_000;
const SESSION_REPLACED_CLOSE_CODE = 4009;
const MAX_BUFFERED_MCP_FRAMES = 32;

type RpcResponse = {
  status: 'success' | 'error';
  payload: unknown;
};

type PendingRequest = {
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type McpChannel = {
  onRequest: (request: McpInteractionRequest) => void;
  nextIndex: number;
  buffered: Map<number, McpInteractionRequest>;
  endIndex: number | null;
  leaseId: string | null;
};

let socket: WebSocket | null = null;
let socketReady: Promise<WebSocket> | null = null;
let nextRequestId = 0;
let connectionGeneration = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let terminalDisconnectError: Error | null = null;

const pendingRequests = new Map<number, PendingRequest>();
const eventListeners = new Map<string, Set<EventCallback<unknown>>>();
const mcpChannels = new Map<number, McpChannel>();
const mcpLeaseChannels = new Map<string, number>();
const mcpDisconnectListeners = new Set<() => void>();

export function onBrowserRuntimeMcpDisconnect(listener: () => void): () => void {
  mcpDisconnectListeners.add(listener);
  return () => mcpDisconnectListeners.delete(listener);
}

const discardMcpChannels = (): void => {
  if (mcpChannels.size === 0) return;
  mcpChannels.clear();
  mcpLeaseChannels.clear();
  for (const listener of mcpDisconnectListeners) listener();
};

const browserRuntimeConnectionError = (code: string, technicalDetails?: string): Error =>
  Object.assign(
    new Error('Macro could not connect to the desktop runtime. It will retry automatically.'),
    { code, technicalDetails },
  );

const browserRuntimeSessionReplacedError = (): Error =>
  Object.assign(
    new Error(
      'Macro moved the desktop runtime session to another browser tab. Reload this tab to take control again.',
    ),
    { code: 'BROWSER_RUNTIME_SESSION_REPLACED' },
  );

const scheduleReconnect = (): void => {
  if (terminalDisconnectError || eventListeners.size === 0 || reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect().catch(() => {
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      scheduleReconnect();
    });
  }, reconnectDelayMs);
};

const rejectPendingRequests = (reason: unknown): void => {
  for (const request of pendingRequests.values()) {
    clearTimeout(request.timeout);
    request.reject(reason);
  }
  pendingRequests.clear();
};

const handleMessage = (message: MessageEvent<string>): void => {
  if (message.data === 'pong' || message.data.startsWith('version:')) return;

  let envelope: {
    event?: string;
    id?: number;
    payload?: unknown;
    mcpChannelId?: number;
    frame?: { index?: number; message?: McpInteractionRequest; end?: boolean };
  };
  try {
    envelope = JSON.parse(message.data) as typeof envelope;
  } catch {
    console.warn('Le pont Tauri a renvoyé un message illisible.');
    return;
  }

  if (typeof envelope.mcpChannelId === 'number') {
    const channel = mcpChannels.get(envelope.mcpChannelId);
    const frame = envelope.frame;
    const index = frame?.index;
    if (!channel || !frame || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return;
    if (frame.end === true) {
      channel.endIndex = index;
    } else if ('message' in frame && index >= channel.nextIndex) {
      if (index - channel.nextIndex >= MAX_BUFFERED_MCP_FRAMES) {
        socket?.close(1008, 'MCP channel frame gap exceeded');
        return;
      }
      channel.buffered.set(index, frame.message as McpInteractionRequest);
    }
    while (channel.buffered.has(channel.nextIndex)) {
      const request = channel.buffered.get(channel.nextIndex)!;
      channel.buffered.delete(channel.nextIndex);
      channel.nextIndex += 1;
      channel.onRequest(request);
    }
    if (channel.leaseId && channel.endIndex === channel.nextIndex) {
      mcpChannels.delete(envelope.mcpChannelId);
      for (const [leaseId, channelId] of mcpLeaseChannels) {
        if (channelId === envelope.mcpChannelId) mcpLeaseChannels.delete(leaseId);
      }
      for (const listener of mcpDisconnectListeners) listener();
    }
    return;
  }

  if (typeof envelope.id === 'number') {
    const request = pendingRequests.get(envelope.id);
    if (!request) return;

    pendingRequests.delete(envelope.id);
    clearTimeout(request.timeout);
    try {
      const response = JSON.parse(String(envelope.payload ?? 'null')) as RpcResponse;
      if (response.status === 'success') {
        request.resolve(response.payload);
      } else {
        request.reject(response.payload);
      }
    } catch (error) {
      request.reject(error);
    }
    return;
  }

  if (typeof envelope.event !== 'string') return;
  const callbacks = eventListeners.get(envelope.event);
  if (!callbacks) return;

  const event: Event<unknown> = {
    event: envelope.event,
    id: -1,
    payload: envelope.payload,
  };
  callbacks.forEach((callback) => callback(event));
};

const connect = (): Promise<WebSocket> => {
  if (terminalDisconnectError) return Promise.reject(terminalDisconnectError);
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (socketReady) return socketReady;

  const generation = ++connectionGeneration;
  socketReady = new Promise<WebSocket>((resolve, reject) => {
    let opened = false;
    const token = import.meta.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN;
    if (!token) {
      reject(new Error('Le jeton du runtime Tauri est absent. Relancez la commande de debug dédiée.'));
      socketReady = null;
      return;
    }
    const bridgeSocket = new WebSocket(
      `ws://127.0.0.1:${BRIDGE_PORT}/remote_ui_ws?token=${encodeURIComponent(token)}`,
    );

    bridgeSocket.addEventListener('open', () => {
      if (generation !== connectionGeneration) {
        bridgeSocket.close();
        return;
      }
      opened = true;
      terminalDisconnectError = null;
      socket = bridgeSocket;
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      bridgeSocket.send('version:1.1.0');
      resolve(bridgeSocket);
    });
    bridgeSocket.addEventListener('message', (message) => {
      if (generation === connectionGeneration) handleMessage(message);
    });
    bridgeSocket.addEventListener('error', () => {
      if (generation !== connectionGeneration) return;
      if (socket === bridgeSocket) socket = null;
      socketReady = null;
      reject(browserRuntimeConnectionError('BROWSER_RUNTIME_UNAVAILABLE', `WebSocket port: ${BRIDGE_PORT}`));
      rejectPendingRequests(browserRuntimeConnectionError('BROWSER_RUNTIME_CONNECTION_ERROR'));
      discardMcpChannels();
      if (opened) scheduleReconnect();
    });
    bridgeSocket.addEventListener('close', (event) => {
      if (generation !== connectionGeneration) return;
      if (socket === bridgeSocket) socket = null;
      socketReady = null;
      discardMcpChannels();
      if (event.code === SESSION_REPLACED_CLOSE_CODE) {
        terminalDisconnectError = browserRuntimeSessionReplacedError();
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        rejectPendingRequests(terminalDisconnectError);
        return;
      }
      rejectPendingRequests(browserRuntimeConnectionError('BROWSER_RUNTIME_CONNECTION_CLOSED'));
      if (opened) scheduleReconnect();
    });
  });

  return socketReady;
};

export async function invokeBrowserRuntime<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
  timeoutMs: number = INVOKE_TIMEOUT_MS,
): Promise<T> {
  return invokeBrowserRuntimeWithId(++nextRequestId, command, args, options, timeoutMs);
}

async function invokeBrowserRuntimeWithId<T>(
  id: number,
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
  timeoutMs: number = INVOKE_TIMEOUT_MS,
): Promise<T> {
  const bridgeSocket = await connect();

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Le runtime Tauri n'a pas répondu à la commande « ${command} » dans le délai maximal autorisé.`));
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timeout,
    });
    try {
      bridgeSocket.send(JSON.stringify({ id, cmd: command, args, option: options }));
    } catch (error) {
      pendingRequests.delete(id);
      clearTimeout(timeout);
      reject(error);
    }
  });
}

/** The only Channel-shaped browser RPC; the native path still uses Tauri's Channel. */
export async function openBrowserRuntimeMcpInteractionPort(
  onRequest: (request: McpInteractionRequest) => void,
): Promise<string> {
  const id = ++nextRequestId;
  mcpChannels.set(id, { onRequest, nextIndex: 0, buffered: new Map(), endIndex: null, leaseId: null });
  try {
    const leaseId = await invokeBrowserRuntimeWithId<string>(id, 'mcp_runtime_open_interaction_port');
    const channel = mcpChannels.get(id);
    if (!channel || channel.endIndex === channel.nextIndex) {
      await invokeBrowserRuntime<void>('mcp_runtime_close_interaction_port', { leaseId }).catch(() => undefined);
      throw new Error('Le canal du formulaire MCP a été fermé pendant son ouverture.');
    }
    channel.leaseId = leaseId;
    mcpLeaseChannels.set(leaseId, id);
    return leaseId;
  } catch (error) {
    mcpChannels.delete(id);
    throw error;
  }
}

export async function closeBrowserRuntimeMcpInteractionPort(leaseId: string): Promise<void> {
  await invokeBrowserRuntime<void>('mcp_runtime_close_interaction_port', { leaseId });
  const channelId = mcpLeaseChannels.get(leaseId);
  if (channelId !== undefined) mcpChannels.delete(channelId);
  mcpLeaseChannels.delete(leaseId);
}

export async function listenBrowserRuntime<T>(
  eventName: EventName,
  handler: EventCallback<T>,
  _options?: Options,
): Promise<UnlistenFn> {
  const name = String(eventName);
  const callbacks = eventListeners.get(name) ?? new Set<EventCallback<unknown>>();
  const callback = handler as EventCallback<unknown>;
  callbacks.add(callback);
  eventListeners.set(name, callbacks);
  try {
    await connect();
  } catch {
    scheduleReconnect();
  }

  return () => {
    callbacks.delete(callback);
    if (callbacks.size === 0) eventListeners.delete(name);
    if (eventListeners.size === 0 && reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
}
