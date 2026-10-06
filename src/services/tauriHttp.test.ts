import { expect, mock, test } from 'bun:test';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { createBrowserRuntimeFetch, type RuntimeInvoke } from './tauriHttp';

test('sérialise une réponse HTTP et libère son corps lors d’une annulation', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridgeInvoke: RuntimeInvoke = async <T>(
    command: string,
    args?: InvokeArgs,
  ): Promise<T> => {
    calls.push({ command, args });
    switch (command) {
      case 'plugin:http|fetch':
        return 7 as T;
      case 'plugin:http|fetch_send':
        return {
          status: 200,
          statusText: 'OK',
          url: 'https://example.test/data',
          headers: [['content-type', 'text/plain']],
          rid: 9,
        } as T;
      case 'plugin:http|fetch_read_body':
        return [65, 1] as T;
      default:
        return undefined as T;
    }
  };
  const fetch = createBrowserRuntimeFetch(bridgeInvoke);

  const response = await fetch('https://example.test/data');
  await expect(response.text()).resolves.toBe('A');

  const controller = new AbortController();
  const abortedResponse = await fetch('https://example.test/data', {
    signal: controller.signal,
  });
  controller.abort();
  await expect(abortedResponse.text()).rejects.toThrow('Request cancelled');
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(calls).toContainEqual({
    command: 'plugin:http|fetch_cancel_body',
    args: { rid: 9 },
  });

  const completedController = new AbortController();
  const completedResponse = await fetch('https://example.test/data', {
    signal: completedController.signal,
  });
  await expect(completedResponse.text()).resolves.toBe('A');
  const cancellationsBeforeLateAbort = calls.filter(({ command }) =>
    command.startsWith('plugin:http|fetch_cancel'),
  ).length;
  completedController.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    calls.filter(({ command }) => command.startsWith('plugin:http|fetch_cancel')).length,
  ).toBe(cancellationsBeforeLateAbort);
});


const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const core = await import('@tauri-apps/api/core');
let nativeInvoke: RuntimeInvoke;
const nativeCalls: string[] = [];
mock.module('@tauri-apps/api/core', () => ({ ...core, invoke: <T>(command: string, args?: InvokeArgs) => {
  nativeCalls.push(command);
  return nativeInvoke<T>(command, args);
} }));
const http = await import('./tauriHttp');
const nativeFetch = http.tauriFetch;
let pipelineFetch: typeof nativeFetch;
mock.module('./tauriHttp', () => ({ ...http, tauriFetch: (...args: Parameters<typeof nativeFetch>) => pipelineFetch(...args) }));
const { streamChat } = await import('./streamingChat');
const { runAssistantStream } = await import('./chatStreamOrchestrator');
const { createChatTurnRuntime } = await import('./chatTurnRuntime');
const { EMPTY_CONVERSATION_RUNTIME } = await import('../domains/chat/runtimeState');
const { StreamStopUnconfirmedError } = await import('./ai/streamCancellation');

for (const runtime of ['bridge', 'native'] as const) {
  for (const phase of ['done', 'abort', 'cleanup-rejected', 'read-rejected', 'read-receipt'] as const) {
    test(`${runtime} HTTP joins physical read and cleanup in the Chat pipeline (${phase})`, async () => {
      const read = deferred<number[]>();
      const cleanup = deferred<void>();
      const reading = deferred<void>();
      const lateProof = deferred<void>();
      const readOwner = new StreamStopUnconfirmedError('Read has a late local receipt', lateProof.promise);
      let reads = 0;
      let cancellations = 0;
      const controller = new AbortController();
      const chunk = new TextEncoder().encode(phase === 'abort'
        ? 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
        : 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      const invoke: RuntimeInvoke = async <T>(command: string): Promise<T> => {
        if (command === 'plugin:http|fetch') return 7 as T;
        if (command === 'plugin:http|fetch_send') return { status: 200, statusText: 'OK', url: 'https://example.invalid', headers: [], rid: 9 } as T;
        if (command === 'plugin:http|fetch_read_body') {
          reads++;
          if (reads === 1) return [...chunk, 0] as T;
          reading.resolve();
          return await read.promise as T;
        }
        if (command === 'plugin:http|fetch_cancel_body') { cancellations++; await cleanup.promise; }
        return undefined as T;
      };
      nativeInvoke = invoke;
      nativeCalls.length = 0;
      pipelineFetch = runtime === 'native' ? nativeFetch : createBrowserRuntimeFetch(invoke);
      const sessionId = `${runtime}-${phase}`;
      let state: import('../types').ConversationRuntimeState = { ...EMPTY_CONVERSATION_RUNTIME, phase: 'streaming', sessionId, turnId: 'turn', assistantMessageId: 'assistant', abortController: controller };
      const settled = mock(() => {});
      const owner = createChatTurnRuntime({ state: { read: () => state, project: (_id, next) => { state = next ?? EMPTY_CONVERSATION_RUNTIME; }, isDeleted: () => false }, cancelTransport: async () => {}, settled });
      const run = runAssistantStream({ sessionId, providerId: 'custom', providerType: 'custom', modelId: 'fixture', baseUrl: 'https://example.invalid', messages: [], signal: controller.signal,
        onGenerationAttemptProgress: attempt => { if (phase === 'abort' && attempt.rawText) controller.abort(); },
        lifecycle: { appendTokenChunk() {}, onComplete: () => { state = EMPTY_CONVERSATION_RUNTIME; }, onError: () => { state = { ...state, phase: 'error', abortController: null }; }, onAbort: () => { state = EMPTY_CONVERSATION_RUNTIME; } }, streamChatImpl: streamChat,
      });
      let ended = false;
      void run.then(() => { ended = true; }, () => { ended = true; });
      owner.track('conversation', run);
      await reading.promise;
      for (let attempt = 0; attempt < 100 && cancellations === 0; attempt++) await tick();
      expect(cancellations).toBe(1);
      expect(ended).toBe(false);
      expect(() => owner.assertCanSend('conversation', { available: true, hasUnsavedResponse: false })).toThrow('already running');
      if (phase === 'done') {
        read.resolve([0]);
        await tick();
        expect(ended).toBe(false);
        cleanup.resolve();
      } else {
        if (phase === 'cleanup-rejected') cleanup.reject(new Error('Cleanup IPC receipt lost'));
        else cleanup.resolve();
        await tick();
        // An acknowledged cleanup cannot stand in for the in-flight read.
        expect(ended).toBe(false);
        if (phase === 'read-rejected') read.reject(new Error('Read IPC receipt lost'));
        else if (phase === 'read-receipt') read.reject(readOwner);
        else read.resolve([0]);
      }
      if (phase === 'cleanup-rejected' || phase === 'read-rejected' || phase === 'read-receipt') {
        await expect(run).rejects.toBeInstanceOf(StreamStopUnconfirmedError);
        expect(() => owner.assertCanSend('conversation', { available: true, hasUnsavedResponse: false })).toThrow('already running');
        expect(settled).not.toHaveBeenCalled();
        if (phase === 'read-receipt') {
          lateProof.resolve();
          await readOwner.whenStopped;
          await tick();
          owner.assertCanSend('conversation', { available: true, hasUnsavedResponse: false });
        }
      } else {
        await run;
        await tick();
        owner.assertCanSend('conversation', { available: true, hasUnsavedResponse: false });
      }
      if (runtime === 'native') expect(nativeCalls).toContain('plugin:http|fetch_read_body');
    });
  }
}

test('runtime HTTP preserves client options, response metadata, cloning and received EOF', async () => {
  const calls: Array<{ command: string; args?: InvokeArgs }> = [];
  const invoke: RuntimeInvoke = async <T>(command: string, args?: InvokeArgs): Promise<T> => {
    calls.push({ command, args });
    if (command === 'plugin:http|fetch') return 7 as T;
    if (command === 'plugin:http|fetch_send') return { status: 201, statusText: 'Created', url: 'https://example.invalid/final', headers: [['set-cookie', 'synthetic=1'], ['content-type', 'text/plain']], rid: 9 } as T;
    if (command === 'plugin:http|fetch_read_body') return [65, 1] as T;
    return undefined as T;
  };
  const options = { method: 'POST', headers: { 'x-fixture': 'yes' }, body: 'payload', maxRedirections: 3, connectTimeout: 1000, proxy: { all: 'http://proxy.invalid' }, danger: { acceptInvalidCerts: false } };
  const response = await createBrowserRuntimeFetch(invoke)('https://example.invalid', options);
  const clone = response.clone();
  expect(await response.text()).toBe('A');
  expect(await clone.text()).toBe('A');
  expect(response.status).toBe(201);
  expect(clone.url).toBe('https://example.invalid/final');
  expect(clone.headers.get('set-cookie')).toBe('synthetic=1');
  expect(calls[0].args).toMatchObject({ clientConfig: { method: 'POST', maxRedirections: 3, connectTimeout: 1000, proxy: options.proxy, danger: options.danger, data: Array.from(new TextEncoder().encode('payload')) } });
  expect(options.maxRedirections).toBe(3);
  expect(calls.some(call => call.command === 'plugin:http|fetch_cancel_body')).toBe(false);
});

test('runtime HTTP waits for disposal of a null response body', async () => {
  const cleanup = deferred<void>();
  const started = deferred<void>();
  const invoke: RuntimeInvoke = async <T>(command: string): Promise<T> => {
    if (command === 'plugin:http|fetch') return 7 as T;
    if (command === 'plugin:http|fetch_send') return { status: 204, statusText: 'No Content', url: 'https://example.invalid', headers: [], rid: 9 } as T;
    if (command === 'plugin:http|fetch_cancel_body') { started.resolve(); await cleanup.promise; }
    return undefined as T;
  };
  let ended = false;
  const pending = createBrowserRuntimeFetch(invoke)('https://example.invalid');
  void pending.then(() => { ended = true; });
  await started.promise;
  expect(ended).toBe(false);
  cleanup.resolve();
  expect((await pending).body).toBe(null);
});
