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
const INVOKE_TIMEOUT_MS = 30_000;

type RpcResponse = {
  status: 'success' | 'error';
  payload: unknown;
};

type PendingRequest = {
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

let socket: WebSocket | null = null;
let socketReady: Promise<WebSocket> | null = null;
let nextRequestId = 0;

const pendingRequests = new Map<number, PendingRequest>();
const eventListeners = new Map<string, Set<EventCallback<unknown>>>();

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
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (socketReady) return socketReady;

  socketReady = new Promise<WebSocket>((resolve, reject) => {
    const bridgeSocket = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/remote_ui_ws`);

    bridgeSocket.addEventListener('open', () => {
      socket = bridgeSocket;
      bridgeSocket.send('version:1.1.0');
      resolve(bridgeSocket);
    });
    bridgeSocket.addEventListener('message', handleMessage);
    bridgeSocket.addEventListener('error', () => {
      reject(new Error(`Impossible de joindre le runtime Tauri sur le port ${BRIDGE_PORT}.`));
    });
    bridgeSocket.addEventListener('close', () => {
      if (socket === bridgeSocket) socket = null;
      socketReady = null;
      rejectPendingRequests(new Error('La connexion au runtime Tauri a été interrompue.'));
    });
  });

  return socketReady;
};

export async function invokeBrowserRuntime<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  const bridgeSocket = await connect();
  const id = ++nextRequestId;

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Le runtime Tauri n'a pas répondu à la commande « ${command} ».`));
    }, INVOKE_TIMEOUT_MS);

    pendingRequests.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timeout,
    });
    bridgeSocket.send(JSON.stringify({ id, cmd: command, args, option: options }));
  });
}

export async function listenBrowserRuntime<T>(
  eventName: EventName,
  handler: EventCallback<T>,
  _options?: Options,
): Promise<UnlistenFn> {
  await connect();
  const name = String(eventName);
  const callbacks = eventListeners.get(name) ?? new Set<EventCallback<unknown>>();
  const callback = handler as EventCallback<unknown>;
  callbacks.add(callback);
  eventListeners.set(name, callbacks);

  return () => {
    callbacks.delete(callback);
    if (callbacks.size === 0) eventListeners.delete(name);
  };
}
