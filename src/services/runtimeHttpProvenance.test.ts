import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { invokeWithReceipt } from './tauriRuntimeBridge';
import { invokeBrowserRuntimeWithReceipt } from './browserRuntimeTransport';
import { RuntimeCommandError } from './runtimeCommandError';
import { StreamStopUnconfirmedError } from './ai/streamCancellation';
import type { ConversationRuntimeState } from '../types';
import { EMPTY_CONVERSATION_RUNTIME } from '../domains/chat/runtimeState';
import { createChatTurnRuntime } from './chatTurnRuntime';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalSocket = globalThis.WebSocket;
const token = process.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN;
process.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN = 'fixture';
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  globalThis.WebSocket = originalSocket;
  if (token === undefined) delete process.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN;
  else process.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN = token;
});

type Reply = { status: 'success' | 'error'; payload: unknown };
let dispatch: (command: string) => Promise<Reply>;
let loseResponse = false;
let loseReadResponse = false;
let nextCallback = 0;
const callbacks = new Map<number, (payload: unknown) => void>();
beforeEach(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
  transformCallback: (callback: (payload: unknown) => void) => { callbacks.set(++nextCallback, callback); return nextCallback; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  ipc: (message: { cmd: string; callback: number; error: number }) => {
    if (loseResponse || (loseReadResponse && message.cmd.endsWith('|fetch_read_body'))) throw new Error('Synthetic transport dispatch failure');
    void dispatch(message.cmd).then(reply => callbacks.get(reply.status === 'success' ? message.callback : message.error)?.(reply.payload));
  },
} } }));
class Socket {
  static readonly OPEN = 1;
  static current: Socket;
  readyState = 1;
  listeners = new Map<string, (event: { data?: string }) => void>();
  constructor() { Socket.current = this; queueMicrotask(() => this.listeners.get('open')?.({})); }
  addEventListener(name: string, listener: (event: { data?: string }) => void) { this.listeners.set(name, listener); }
  send(frame: string) {
    if (frame.startsWith('version:')) return;
    const request = JSON.parse(frame) as { id: number; cmd: string };
    if (loseResponse || (loseReadResponse && request.cmd.endsWith('|fetch_read_body'))) { queueMicrotask(() => { this.readyState = 3; this.listeners.get('close')?.({}); }); return; }
    void dispatch(request.cmd).then(reply => this.listeners.get('message')?.({ data: JSON.stringify({ id: request.id, payload: JSON.stringify(reply) }) }));
  }
}
globalThis.WebSocket = Socket as unknown as typeof WebSocket;
const http = await import('./tauriHttp');
let pipelineFetch: typeof http.tauriFetch;
mock.module('./tauriHttp', () => ({ ...http, tauriFetch: (...args: Parameters<typeof http.tauriFetch>) => pipelineFetch(...args) }));
const { streamChat, sendChatNonStreaming } = await import('./streamingChat');
const { runAssistantStream } = await import('./chatStreamOrchestrator');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const runtime of ['native', 'browser'] as const) {
  const invoke = runtime === 'native' ? invokeWithReceipt : invokeBrowserRuntimeWithReceipt;
  for (const phase of ['refused', 'read-error', 'lost', 'lost-read', 'cleanup-error', 'send-error', 'send-cleanup-error'] as const) {
    test(`${runtime} reply provenance through HTTP and Chat: ${phase}`, async () => {
      let cleanups = 0;
      dispatch = async command => {
        if (command.endsWith('|fetch')) return phase === 'refused' ? { status: 'error', payload: 'Synthetic refusal' } : { status: 'success', payload: 7 };
        if (command === 'http_release_webview_resource') { cleanups++; return { status: phase === 'send-cleanup-error' ? 'error' : 'success', payload: 'removed' }; }
        if (command.endsWith('|fetch_send') && (phase === 'send-error' || phase === 'send-cleanup-error')) return { status: 'error', payload: 'Synthetic send failure' };
        if (command.endsWith('|fetch_cancel')) return { status: 'success', payload: null };
        if (command.endsWith('|fetch_send')) return { status: 'success', payload: { status: 401, statusText: 'Unauthorized', headers: [], url: 'https://example.invalid', rid: 9 } };
        if (command.endsWith('|fetch_read_body')) return { status: 'error', payload: 'Synthetic body failure' };
        cleanups++;
        return { status: phase === 'cleanup-error' ? 'error' : 'success', payload: null };
      };
      loseResponse = phase === 'lost';
      loseReadResponse = phase === 'lost-read';
      pipelineFetch = http.createBrowserRuntimeFetch(invoke);
      const controller = new AbortController();
      let state: ConversationRuntimeState = { ...EMPTY_CONVERSATION_RUNTIME, phase: 'streaming', sessionId: 'fixture', turnId: 'turn', assistantMessageId: 'assistant', abortController: controller };
      const owner = createChatTurnRuntime({ state: { read: () => state, project: (_id, next) => { state = next ?? EMPTY_CONVERSATION_RUNTIME; }, isDeleted: () => false }, cancelTransport: async () => {}, settled: () => {} });
      const run = runAssistantStream({ sessionId: 'fixture', providerId: 'custom', providerType: 'custom', modelId: 'fixture', baseUrl: 'https://example.invalid', messages: [], signal: controller.signal,
        lifecycle: { appendTokenChunk() {}, onComplete() {}, onError: () => { state = EMPTY_CONVERSATION_RUNTIME; } }, streamChatImpl: streamChat });
      owner.track('conversation', run);
      const error = await run.catch(error => error);
      await tick();
      if (phase === 'lost' || phase === 'lost-read' || phase === 'cleanup-error' || phase === 'send-cleanup-error') {
        expect(error).toBeInstanceOf(StreamStopUnconfirmedError);
        expect(() => owner.assertCanSend('conversation', { available: true, hasUnsavedResponse: false })).toThrow();
      } else {
        expect(error).not.toBeInstanceOf(StreamStopUnconfirmedError);
        expect(() => owner.assertCanSend('conversation', { available: true, hasUnsavedResponse: false })).not.toThrow();
        expect(cleanups).toBe(phase === 'send-error' ? 3 : phase === 'read-error' ? 2 : 0);
      }
      expect(callbacks.size).toBe(0);
      loseResponse = false;
      loseReadResponse = false;
    });
  }
  test(`${runtime} preserves structured response payload without matching its text`, async () => {
    dispatch = async () => ({ status: 'error', payload: { arbitrary: 'fixture', code: 17 } });
    const error = await invoke('synthetic').catch(error => error);
    expect(error).toBeInstanceOf(RuntimeCommandError);
    expect((error as RuntimeCommandError).payload).toEqual({ arbitrary: 'fixture', code: 17 });
  });
}

for (const status of [401, 503]) for (const streaming of [true, false]) {
  test(`${status} ${streaming ? 'streaming' : 'non-streaming'} retains body owner without retry, then releases on proof`, async () => {
    let confirm!: () => void;
    const receipt = new StreamStopUnconfirmedError('Body still owned', new Promise<void>(resolve => { confirm = resolve; }));
    let requests = 0;
    pipelineFetch = http.createBrowserRuntimeFetch(async <T>(command: string): Promise<T> => {
      if (command === 'http_release_webview_resource') return 'removed' as T;
      if (command.endsWith('|fetch')) { requests++; return 7 as T; }
      if (command.endsWith('|fetch_send')) return { status, statusText: 'Failure', url: 'https://example.invalid', headers: [], rid: 9 } as T;
      if (command.endsWith('|fetch_read_body')) throw receipt;
      return undefined as T;
    });
    let state: ConversationRuntimeState = { ...EMPTY_CONVERSATION_RUNTIME, phase: 'streaming', sessionId: 'fixture', turnId: 'turn', assistantMessageId: 'assistant', abortController: new AbortController() };
    const owner = createChatTurnRuntime({ state: { read: () => state, project: (_id, next) => { state = next ?? EMPTY_CONVERSATION_RUNTIME; }, isDeleted: () => false }, cancelTransport: async () => {}, settled: () => {} });
    const run = runAssistantStream({ sessionId: 'fixture', providerId: 'custom', providerType: 'custom', modelId: 'fixture', baseUrl: 'https://example.invalid', messages: [], signal: state.abortController!.signal,
      lifecycle: { appendTokenChunk() {}, onComplete() {}, onError: () => { state = EMPTY_CONVERSATION_RUNTIME; } },
      streamChatImpl: streaming ? streamChat : async options => { await sendChatNonStreaming(options); },
    });
    owner.track('conversation', run);
    expect(await run.catch(error => error)).toBe(receipt);
    expect(requests).toBe(1);
    expect(() => owner.assertCanSend('conversation', { available: true, hasUnsavedResponse: false })).toThrow();
    confirm();
    await receipt.whenStopped;
    await tick();
    expect(() => owner.assertCanSend('conversation', { available: true, hasUnsavedResponse: false })).not.toThrow();
  });
}


test('a separate owner returned by the native callback survives received-error provenance', async () => {
  let confirm!: () => void;
  const owner = new StreamStopUnconfirmedError('Separate native work', new Promise<void>(resolve => { confirm = resolve; }));
  dispatch = async () => ({ status: 'error', payload: owner });
  const result = await http.createBrowserRuntimeFetch(invokeWithReceipt)('https://example.invalid').catch(error => error);
  expect(result).toBe(owner);
  expect(result.stopped).toBe(false);
  confirm();
  await result.whenStopped;
  expect(result.stopped).toBe(true);
});


test('send success after cancellation failure still joins its newly created body', async () => {
  const controller = new AbortController();
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  let confirm!: () => void;
  const owner = new StreamStopUnconfirmedError('Cancellation still owned', new Promise<void>(resolve => { confirm = resolve; }));
  let cleanupStarted = false;
  const run = http.createBrowserRuntimeFetch(async <T>(command: string): Promise<T> => {
      if (command === 'http_release_webview_resource') return 'removed' as T;
    if (command.endsWith('|fetch')) return 7 as T;
    if (command.endsWith('|fetch_send')) {
      controller.abort();
      return { status: 200, statusText: 'OK', url: 'https://example.invalid', headers: [], rid: 9 } as T;
    }
    if (command.endsWith('|fetch_cancel')) throw owner;
    if (command.endsWith('|fetch_cancel_body')) { cleanupStarted = true; await cleanup; }
    return undefined as T;
  })('https://example.invalid', { signal: controller.signal });
  let ended = false;
  void run.then(() => { ended = true; }, () => { ended = true; });
  await tick();
  expect(cleanupStarted).toBe(true);
  expect(ended).toBe(false);
  finishCleanup();
  expect(await run.catch(error => error)).toBe(owner);
  confirm();
  await owner.whenStopped;
});

test('native missing callback remains pending until an actual reply', async () => {
  let finish!: (reply: Reply) => void;
  dispatch = () => new Promise<Reply>(resolve => { finish = resolve; });
  let ended = false;
  const run = invokeWithReceipt('synthetic');
  void run.then(() => { ended = true; }, () => { ended = true; });
  await tick();
  expect(ended).toBe(false);
  expect(callbacks.size).toBe(2);
  finish({ status: 'error', payload: 'reply received later' });
  expect(await run.catch(error => error)).toBeInstanceOf(RuntimeCommandError);
  expect(callbacks.size).toBe(0);
});

test('browser timeout is not a command error reply', async () => {
  let finish!: (reply: Reply) => void;
  dispatch = () => new Promise<Reply>(resolve => { finish = resolve; });
  const result = await invokeBrowserRuntimeWithReceipt('synthetic', undefined, undefined, 5).catch(error => error);
  expect(result).toBeInstanceOf(Error);
  expect(result).not.toBeInstanceOf(RuntimeCommandError);
  finish({ status: 'error', payload: 'late reply' });
  await tick();
});


for (const phase of ['aborted-send', 'successful-send', 'lost-release'] as const) {
  test(`request retirement preserves the distinct body: ${phase}`, async () => {
    const controller = new AbortController();
    const resources = new Set<number>();
    const releases: number[] = [];
    let releaseResult: string | undefined;
    const fetch = http.createBrowserRuntimeFetch(async <T>(command: string, args?: import('@tauri-apps/api/core').InvokeArgs): Promise<T> => {
      if (command.endsWith('|fetch')) { resources.add(7); return 7 as T; }
      if (command.endsWith('|fetch_send')) {
        if (phase === 'aborted-send') {
          resources.delete(7);
          controller.abort();
          throw new RuntimeCommandError('Synthetic aborted send reply');
        }
        resources.add(9);
        return { status: 200, statusText: 'OK', url: 'https://example.invalid', headers: [], rid: 9 } as T;
      }
      if (command === 'http_release_webview_resource') {
        const rid = (args as { rid: number }).rid;
        releases.push(rid);
        if (phase === 'lost-release') throw new Error('Retirement response lost');
        releaseResult = resources.delete(rid) ? 'removed' : 'alreadyAbsent';
        return releaseResult as T;
      }
      if (command.endsWith('|fetch_cancel')) throw new RuntimeCommandError('Synthetic missing abort sender');
      if (command.endsWith('|fetch_cancel_body')) resources.delete(9);
      if (command.endsWith('|fetch_read_body')) { expect(resources.has(9)).toBe(true); resources.delete(9); return [65, 1] as T; }
      return undefined as T;
    });
    const result = await fetch('https://example.invalid', { signal: controller.signal }).catch(error => error);
    expect(releases).toEqual([7]);
    if (phase === 'successful-send') {
      expect(result).toBeInstanceOf(Response);
      expect(releaseResult).toBe('removed');
      expect(resources.has(7)).toBe(false);
      expect(await result.text()).toBe('A');
    } else if (phase === 'aborted-send') {
      expect(releaseResult).toBe('alreadyAbsent');
      expect(result).not.toBeInstanceOf(StreamStopUnconfirmedError);
      expect(resources.size).toBe(0);
    } else {
      expect(result).toBeInstanceOf(StreamStopUnconfirmedError);
      expect(resources.has(9)).toBe(false);
    }
  });
}
