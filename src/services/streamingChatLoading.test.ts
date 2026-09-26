import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ReasoningTransportMode } from '../types';
import type { StreamingChatOptions } from './ai/contracts';
import { activeStreamResourcesBySessionId, cancelStream } from './ai/streamResources';

type Execution = typeof import('./streamingChatExecution');
let transportMode: ReasoningTransportMode | undefined;
let modelReads = 0;
mock.module('../stores/useProviderStore', () => ({
  useProviderStore: { getState: () => {
    modelReads += 1;
    return { modelsByProvider: { provider: [{ id: 'model', reasoningCapability: { transportMode } }] } };
  } },
}));
const { createStreamingChatService } = await import('./streamingChat');

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const options = (sessionId = 'pending'): StreamingChatOptions => ({
  sessionId, baseUrl: 'https://provider.example', providerId: 'provider', providerType: 'openai', modelId: 'model',
  messages: [{ role: 'user', content: 'hello' }],
  onToken: mock(() => undefined), onComplete: mock(() => undefined), onError: mock(() => undefined),
});
const execution = () => ({
  streamChat: mock<Execution['streamChat']>(async () => undefined),
  sendChatNonStreaming: mock<Execution['sendChatNonStreaming']>(async () => 'answer'),
});

afterEach(() => {
  cancelStream();
  expect(activeStreamResourcesBySessionId.size).toBe(0);
  transportMode = undefined;
});

describe('streamingChat module loading lifetime', () => {
  it.each(['resolve', 'reject'] as const)('settles cancellation without a signal before a late module %s', async (outcome) => {
    const pending = deferred<Execution>();
    const runtime = execution();
    const service = createStreamingChatService(() => pending.promise);
    const input = options();
    const running = service.streamChat(input);
    expect(activeStreamResourcesBySessionId.has('pending')).toBe(true);
    cancelStream('pending');
    await running;
    expect(input.onComplete).toHaveBeenCalledWith({ visibleContent: '', toolTraces: [] });
    expect(input.onError).not.toHaveBeenCalled();
    if (outcome === 'resolve') pending.resolve(runtime);
    else pending.reject(new Error('late module error'));
    await Promise.resolve();
    expect(runtime.streamChat).not.toHaveBeenCalled();
    expect(input.onComplete).toHaveBeenCalledTimes(1);
  });

  it('preserves a successor started reentrantly from completion of a cancelled import', async () => {
    const pending = deferred<Execution>();
    const service = createStreamingChatService(() => pending.promise);
    const second = options();
    let successor!: Promise<void>;
    const first = options();
    first.onComplete = () => { successor = service.streamChat(second); };
    const running = service.streamChat(first);
    const firstOwner = activeStreamResourcesBySessionId.get('pending');
    cancelStream('pending');
    await running;
    expect(activeStreamResourcesBySessionId.get('pending')).not.toBe(firstOwner);
    expect(activeStreamResourcesBySessionId.has('pending')).toBe(true);
    cancelStream('pending');
    await successor;
    expect(second.onComplete).toHaveBeenCalledTimes(1);
    pending.resolve(execution());
  });

  it('prunes only the captured owner when a cancellation callback synchronously starts a successor', async () => {
    const pending = deferred<Execution>();
    const service = createStreamingChatService(() => pending.promise);
    const first = service.streamChat(options());
    const owner = activeStreamResourcesBySessionId.get('pending')!;
    const abort = owner.cancel!;
    let second!: Promise<void>;
    owner.cancel = () => { abort(); second = service.streamChat(options()); };
    cancelStream('pending');
    await first;
    expect(activeStreamResourcesBySessionId.has('pending')).toBe(true);
    expect(activeStreamResourcesBySessionId.get('pending')).not.toBe(owner);
    cancelStream('pending');
    await second;
    pending.resolve(execution());
  });

  it('dispatches both waiting calls without the older call replacing or pruning the newer owner', async () => {
    const pending = deferred<Execution>();
    const secondFinish = deferred<void>();
    const service = createStreamingChatService(() => pending.promise);
    const a = options();
    const b = options();
    const first = service.streamChat(a);
    const firstOwner = activeStreamResourcesBySessionId.get('pending');
    const second = service.streamChat(b);
    const secondOwner = activeStreamResourcesBySessionId.get('pending');
    const runtime = execution();
    runtime.streamChat.mockImplementation(async (captured, resources) => {
      expect(activeStreamResourcesBySessionId.get('pending')).toBe(secondOwner);
      if (resources === secondOwner) await secondFinish.promise;
      captured.onComplete({ visibleContent: 'done', toolTraces: [] });
    });
    pending.resolve(runtime);
    await first;
    expect(runtime.streamChat).toHaveBeenCalledTimes(2);
    expect(runtime.streamChat.mock.calls.map(call => call[1])).toContain(firstOwner!);
    expect(activeStreamResourcesBySessionId.get('pending')).toBe(secondOwner);
    cancelStream('pending');
    expect(runtime.streamChat.mock.calls.find(call => call[1] === secondOwner)![0].signal!.aborted).toBe(true);
    secondFinish.resolve();
    await second;
  });

  it('does not dispatch a cancelled older invocation or remove its successor after the load resolves', async () => {
    const pending = deferred<Execution>();
    const runtime = execution();
    const finish = deferred<void>();
    runtime.streamChat.mockImplementation(async () => finish.promise);
    const service = createStreamingChatService(() => pending.promise);
    const first = service.streamChat(options());
    cancelStream('pending');
    const second = service.streamChat(options());
    const secondOwner = activeStreamResourcesBySessionId.get('pending');
    await first;
    pending.resolve(runtime);
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.streamChat).toHaveBeenCalledTimes(1);
    expect(activeStreamResourcesBySessionId.get('pending')).toBe(secondOwner);
    finish.resolve();
    await second;
  });

  it.each([undefined, 'none', 'openai_effort'] as const)('captures reasoning mode %s and callbacks before yielding', async (mode) => {
    transportMode = mode;
    const pending = deferred<Execution>();
    const runtime = execution();
    const input = options();
    const controller = new AbortController();
    input.signal = controller.signal;
    const capturedCallbacks = { onToken: input.onToken, onComplete: input.onComplete, onError: input.onError };
    const before = modelReads;
    const service = createStreamingChatService(() => pending.promise);
    const running = service.streamChat(input);
    transportMode = 'openrouter_reasoning';
    input.sessionId = 'changed';
    input.onComplete = mock(() => undefined);
    input.signal = new AbortController().signal;
    pending.resolve(runtime);
    await running;
    expect(modelReads - before).toBe(1);
    expect(runtime.streamChat.mock.calls[0][0]).toMatchObject({
      ...capturedCallbacks, sessionId: 'pending', providerId: 'provider', modelId: 'model',
      reasoningTransportMode: mode,
    });
    expect(activeStreamResourcesBySessionId.size).toBe(0);
    controller.abort();
    expect(runtime.streamChat.mock.calls[0][0].signal!.aborted).toBe(false);
  });

  it('relays an external abort while loading and skips loading for an already aborted caller', async () => {
    const pending = deferred<Execution>();
    const load = mock(() => pending.promise);
    const service = createStreamingChatService(load);
    const controller = new AbortController();
    const input = { ...options(), signal: controller.signal };
    const first = service.streamChat(input);
    controller.abort();
    await first;
    await service.streamChat(input);
    expect(load).toHaveBeenCalledTimes(1);
    expect(input.onComplete).toHaveBeenCalledTimes(2);
    pending.resolve(execution());
  });

  it('reports a loading failure once and releases the session', async () => {
    const error = new Error('module unavailable');
    const service = createStreamingChatService(async () => { throw error; });
    const input = options();
    await service.streamChat(input);
    expect(input.onError).toHaveBeenCalledTimes(1);
    expect(input.onError).toHaveBeenCalledWith(error);
    expect(input.onComplete).not.toHaveBeenCalled();
  });

  it('retries the module after a load failure through the same service', async () => {
    const runtime = execution();
    const load = mock(async () => runtime);
    load.mockRejectedValueOnce(new Error('transient load failure'));
    const service = createStreamingChatService(load);
    const failed = options();
    await service.streamChat(failed);
    expect(failed.onError).toHaveBeenCalledTimes(1);
    const next = options();
    expect(await service.sendChatNonStreaming(next)).toBe('answer');
    await service.streamChat(next);
    expect(load).toHaveBeenCalledTimes(2);
    expect(runtime.streamChat).toHaveBeenCalledTimes(1);
    expect(runtime.sendChatNonStreaming).toHaveBeenCalledTimes(1);
    expect(next.onError).not.toHaveBeenCalled();
  });

  it('settles non-streaming cancellation with one error before the module loads', async () => {
    const pending = deferred<Execution>();
    const service = createStreamingChatService(() => pending.promise);
    const input = options();
    const running = service.sendChatNonStreaming(input);
    cancelStream('pending');
    await expect(running).rejects.toThrow('Aborted');
    expect(input.onError).toHaveBeenCalledTimes(1);
    expect(input.onComplete).not.toHaveBeenCalled();
    const runtime = execution();
    pending.resolve(runtime);
    await Promise.resolve();
    expect(runtime.sendChatNonStreaming).not.toHaveBeenCalled();
  });
});
