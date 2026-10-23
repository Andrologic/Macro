import { beforeEach, expect, mock, test } from 'bun:test';
import type { AdmittedHttpPart, ChatWorkPhase } from '../ipc/chatAdmission';
import type { StreamingChatOptions } from './contracts';

const ipc = await import('../tauriIpc');
let parts: AdmittedHttpPart[] = [];
let outcomes: string[] = [];
let starts = 0;
let startError: Error | undefined;
let finishGate: Promise<void> | undefined;
let finishPhase: ChatWorkPhase = 'completed';
let readGate: Promise<AdmittedHttpPart> | undefined;
let finishError: Error | undefined;
const handoff = mock(async (_context: unknown, _conversation: string, _request: string, _receipts: unknown[]) => {});
mock.module('../tauriIpc', () => ({ ...ipc,
  chatAdmissionCompleteSteerHandoff: handoff,
  chatAdmissionHttpStart: async () => { starts += 1; if (startError) throw startError; },
  chatAdmissionHttpRead: async () => {
    if (readGate) return readGate;
    const part = parts.shift();
    if (!part) throw new Error('Synthetic transport ended');
    return part;
  },
  chatAdmissionHttpFinish: async (_context: unknown, _conversation: string, _id: string, outcome: string) => {
    outcomes.push(outcome);
    if (finishError) throw finishError;
    await finishGate;
    return { phase: finishPhase, taskError: null };
  },
}));
const { createChatCompletionsAdapter } = await import('./chatCompletionsAdapter');
const { fetchProviderWithTimeout } = await import('./admittedHttpTransport');

const options = (): StreamingChatOptions => ({
  providerAdmission: { kind: 'globalChat', context: { handle: 'local-test-handle', runtime: 'test-runtime' } },
  conversationId: 'synthetic-chat', providerId: 'synthetic-provider', providerType: 'openai',
  baseUrl: 'https://example.invalid', modelId: 'synthetic-model', messages: [],
  onToken() {}, onComplete() {}, onError(error) { throw error; },
});

beforeEach(() => {
  parts = [];
  outcomes = [];
  handoff.mockClear();
  starts = 0;
  startError = undefined;
  finishGate = undefined;
  finishPhase = 'completed';
  readGate = undefined;
  finishError = undefined;
});

const runCodec = () => {
  const transport = createChatCompletionsAdapter(options(), { disableReasoning() {}, disableEffort() {} });
  return transport.adapter.streamTurn({ messages: [], tools: [], turnCount: 0, recovering: false, onDelta() {} })
    .finally(() => transport.dispose());
};

const setBody = (text: string) => {
  parts = [
    { kind: 'headers', status: 200, url: 'https://example.invalid/chat/completions', headers: [] },
    { kind: 'bytes', data: [...new TextEncoder().encode(text)] },
    { kind: 'end' },
  ];
};

test('the real SSE codec waits for native finalization after its terminal marker', async () => {
  setBody('data: {"choices":[{"delta":{"content":"Synthetic answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  let release!: () => void;
  finishGate = new Promise(resolve => { release = resolve; });
  let returned = false;
  const pending = runCodec().then(value => { returned = true; return value; });
  for (let i = 0; outcomes.length === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(outcomes).toEqual(['completed']);
  expect(returned).toBe(false);
  release();
  const value = await pending;
  expect('result' in value && value.result.admissionOutcome).toBe('completed');
  expect(starts).toBe(1);
});

test('EOF without a protocol terminal preserves partial provider content and does not resend', async () => {
  setBody('data: {"choices":[{"delta":{"content":"Partial","reasoning_content":"Observable thought"}}]}\n\n');
  finishPhase = 'unknown';
  const value = await runCodec();
  expect(outcomes).toEqual(['uncertain']);
  expect(starts).toBe(1);
  expect('result' in value && value.result.content).toContain('Partial');
  expect('result' in value && value.result.admissionOutcome).toBe('unknown');
  if ('result' in value) {
    expect(JSON.stringify(value.projectAssistant(value.result.content, [], false, true).items)).toContain('Observable thought');
  }
});

test('a lost admission acknowledgement cannot enter the generic request retry loop', async () => {
  startError = new Error('Synthetic lost IPC acknowledgement');
  await expect(runCodec()).rejects.toMatchObject({ code: 'CHAT_ADMISSION_UNAVAILABLE' });
  expect(starts).toBe(1);
});

test('headers failure joins and keeps the uncertain receipt before returning', async () => {
  finishPhase = 'unknown';
  await expect(fetchProviderWithTimeout(options(), 'https://example.invalid/chat/completions', {
    method: 'POST', body: '{}',
  }, 1000)).rejects.toMatchObject({ code: 'CHAT_ADMISSION_UNCERTAIN' });
  expect(outcomes).toEqual(['uncertain']);
  expect(starts).toBe(1);
});

test('failed cleanup releases a pending headers read without certifying the effect', async () => {
  readGate = new Promise(() => {});
  finishError = new Error('Synthetic lost cleanup IPC');
  await expect(fetchProviderWithTimeout(options(), 'https://example.invalid/chat/completions', {
    method: 'POST', body: '{}',
  }, 1)).rejects.toMatchObject({ code: 'CHAT_ADMISSION_UNAVAILABLE' });
  expect(outcomes).toEqual(['uncertain']);
  expect(starts).toBe(1);
});


test('HTTP handoff captures only already-consumed steers and waits for native completion', async () => {
  setBody('synthetic');
  const first = { operationId: 'first', runtime: 'test-runtime', revision: 0,
    identity: { conversationId: 'synthetic-chat', kind: 'steer' as const, id: 'first-message' } };
  let consumed = [first];
  const captured = { ...options(), providerSteerReceipts: () => [...consumed] };
  let finish!: () => void;
  finishGate = new Promise<void>(resolve => { finish = resolve; });
  const transport = await fetchProviderWithTimeout(captured, 'https://example.invalid/chat/completions', { method: 'POST', body: '{}' }, 1000);
  consumed = [...consumed, { ...first, operationId: 'later' }];
  const completed = transport.finish('completed');
  await Promise.resolve();
  expect(handoff).not.toHaveBeenCalled();
  finish();
  await completed;
  expect(handoff.mock.calls[0]?.[3]).toEqual([first]);
});

test('an uncertain HTTP provider never acknowledges a steer', async () => {
  setBody('synthetic');
  finishPhase = 'unknown';
  const captured = { ...options(), providerSteerReceipts: () => [{ operationId: 'held', runtime: 'test-runtime', revision: 0,
    identity: { conversationId: 'synthetic-chat', kind: 'steer' as const, id: 'held-message' } }] };
  const transport = await fetchProviderWithTimeout(captured, 'https://example.invalid/chat/completions', { method: 'POST', body: '{}' }, 1000);
  expect(await transport.finish('uncertain')).toBe('unknown');
  expect(handoff).not.toHaveBeenCalled();
});
