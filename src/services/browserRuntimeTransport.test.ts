import { afterAll, beforeAll, expect, test } from 'bun:test';

type Listener = (event: { code?: number; data?: string; reason?: string }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static failConnections = 0;

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  throwOnSend = false;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (FakeWebSocket.failConnections > 0) {
        FakeWebSocket.failConnections -= 1;
        this.emit('error');
        this.emit('close');
      } else {
        this.emit('open');
      }
    });
  }

  addEventListener(name: string, listener: Listener): void {
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  send(payload: string): void {
    if (this.throwOnSend) throw new Error('socket closed before send');
    this.sent.push(payload);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  emit(name: string, event: { code?: number; data?: string; reason?: string } = {}): void {
    this.listeners.get(name)?.forEach((listener) => listener(event));
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  process.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN = 'test-token';
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  delete process.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN;
});

test('authentifie les invocations et rétablit la connexion des écouteurs', async () => {
  const transport = await import('./browserRuntimeTransport');
  const unlisten = await transport.listenBrowserRuntime('fs:change', () => undefined);
  expect(FakeWebSocket.instances[0]?.url).toContain('token=test-token');

  FakeWebSocket.instances[0]?.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);

  const invocation = transport.invokeBrowserRuntime<{ ok: true }>('state_get_snapshot');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const activeSocket = FakeWebSocket.instances.at(-1)!;
  const request = JSON.parse(activeSocket.sent.at(-1)!) as { id: number };
  activeSocket.emit('message', {
    data: JSON.stringify({
      id: request.id,
      payload: JSON.stringify({ status: 'success', payload: { ok: true } }),
    }),
  });
  await expect(invocation).resolves.toEqual({ ok: true });

  const interruptedInvocation = transport.invokeBrowserRuntime('git_status');
  await new Promise((resolve) => setTimeout(resolve, 0));
  activeSocket.emit('close');
  await expect(interruptedInvocation).rejects.toThrow(
    'Macro could not connect to the desktop runtime. It will retry automatically.',
  );
  await new Promise((resolve) => setTimeout(resolve, 650));

  const reconnectedSocket = FakeWebSocket.instances.at(-1)!;
  reconnectedSocket.throwOnSend = true;
  await expect(transport.invokeBrowserRuntime('git_status')).rejects.toThrow(
    'socket closed before send',
  );
  reconnectedSocket.throwOnSend = false;

  await expect(
    transport.invokeBrowserRuntime('silent_command', undefined, undefined, 20),
  ).rejects.toThrow('dans le délai maximal autorisé');

  const errorOnlyConnectionCount = FakeWebSocket.instances.length;
  reconnectedSocket.emit('error');
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(FakeWebSocket.instances.length).toBe(errorOnlyConnectionCount + 1);
  const recoveredSocket = FakeWebSocket.instances.at(-1)!;
  const invocationAfterRecovery = transport.invokeBrowserRuntime<{ recovered: true }>(
    'state_get_snapshot',
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const recoveredRequest = JSON.parse(recoveredSocket.sent.at(-1)!) as { id: number };
  reconnectedSocket.emit('message', {
    data: JSON.stringify({
      id: recoveredRequest.id,
      payload: JSON.stringify({ status: 'success', payload: { recovered: false } }),
    }),
  });
  reconnectedSocket.emit('close');
  recoveredSocket.emit('message', {
    data: JSON.stringify({
      id: recoveredRequest.id,
      payload: JSON.stringify({ status: 'success', payload: { recovered: true } }),
    }),
  });
  await expect(invocationAfterRecovery).resolves.toEqual({ recovered: true });

  FakeWebSocket.failConnections = 2;
  const connectionCount = FakeWebSocket.instances.length;
  recoveredSocket.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 3_800));
  expect(FakeWebSocket.instances.length).toBe(connectionCount + 3);
  unlisten();
}, 10_000);

test('arrête définitivement la reconnexion quand un autre onglet prend la session', async () => {
  const transport = await import('./browserRuntimeTransport');
  const unlisten = await transport.listenBrowserRuntime('runtime:event', () => undefined);
  const activeSocket = FakeWebSocket.instances.at(-1)!;
  const connectionCount = FakeWebSocket.instances.length;

  const interruptedInvocation = transport.invokeBrowserRuntime('state_get_snapshot');
  await new Promise((resolve) => setTimeout(resolve, 0));
  activeSocket.emit('close', { code: 4009, reason: 'session_replaced' });

  await expect(interruptedInvocation).rejects.toMatchObject({
    code: 'BROWSER_RUNTIME_SESSION_REPLACED',
  });
  await expect(transport.invokeBrowserRuntime('git_status')).rejects.toMatchObject({
    code: 'BROWSER_RUNTIME_SESSION_REPLACED',
  });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(FakeWebSocket.instances).toHaveLength(connectionCount);
  unlisten();
});
