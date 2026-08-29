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

const BRIDGE_PORT = 1430;
const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;
const INVOKE_TIMEOUT_MS = 10 * 60_000;
const SESSION_REPLACED_CLOSE_CODE = 4009;

type RpcResponse = {
  status: 'success' | 'error';
  payload: unknown;
};

type PendingRequest = {
  command: string;
  reject: (reason?: unknown) => void;
  requestId: string | null;
  resolve: (value: unknown) => void;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
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

const readCorrelatedRequestId = (args?: InvokeArgs): string | null => {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  const nestedRequest = record.request;
  const requestId = record.requestId ?? (
    nestedRequest && typeof nestedRequest === 'object'
      ? (nestedRequest as Record<string, unknown>).requestId
      : null
  );
  return typeof requestId === 'string' && requestId.trim() ? requestId : null;
};

const logRpcStage = (
  stage: 'started' | 'succeeded' | 'failed',
  request: Pick<PendingRequest, 'command' | 'requestId' | 'startedAt'> & { bridgeRequestId: number },
  error?: unknown,
): void => {
  console.info(JSON.stringify({
    event: `browser_runtime_rpc_${stage}`,
    at: new Date().toISOString(),
    command: request.command,
    requestId: request.requestId,
    bridgeRequestId: request.bridgeRequestId,
    durationMs: Math.round(performance.now() - request.startedAt),
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  }));
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
  };
  try {
    envelope = JSON.parse(message.data) as typeof envelope;
  } catch {
    console.warn('Le pont Tauri a renvoyé un message illisible.');
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
        logRpcStage('succeeded', { ...request, bridgeRequestId: envelope.id });
        request.resolve(response.payload);
      } else {
        logRpcStage('failed', { ...request, bridgeRequestId: envelope.id }, response.payload);
        request.reject(response.payload);
      }
    } catch (error) {
      logRpcStage('failed', { ...request, bridgeRequestId: envelope.id }, error);
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
      if (opened) scheduleReconnect();
    });
    bridgeSocket.addEventListener('close', (event) => {
      if (generation !== connectionGeneration) return;
      if (socket === bridgeSocket) socket = null;
      socketReady = null;
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
  const bridgeSocket = await connect();
  const id = ++nextRequestId;
  const startedAt = performance.now();
  const requestId = readCorrelatedRequestId(args);

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      const error = new Error(`Le runtime Tauri n'a pas répondu à la commande « ${command} » dans le délai maximal autorisé.`);
      logRpcStage('failed', { command, requestId, startedAt, bridgeRequestId: id }, error);
      reject(error);
    }, timeoutMs);
    pendingRequests.set(id, {
      command,
      resolve: (value) => resolve(value as T),
      reject,
      requestId,
      startedAt,
      timeout,
    });
    logRpcStage('started', { command, requestId, startedAt, bridgeRequestId: id });
    try {
      bridgeSocket.send(JSON.stringify({ id, cmd: command, args, option: options }));
    } catch (error) {
      pendingRequests.delete(id);
      clearTimeout(timeout);
      reject(error);
    }
  });
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
