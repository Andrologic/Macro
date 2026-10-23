import { expect, it, mock } from 'bun:test';
import { createDeferred } from '../test-utils/deferred';

const opened = createDeferred<void>();
const closing = createDeferred<void>();
const failure = new Error('registration ACK lost');
const closed = createDeferred<void>();
const calls: Array<[string, string]> = [];
const recoveryCalls: string[] = [];
let writerError: Error | null = null;
let recoveryReceipt = { operationId: 'marker', runtime: 'browser', revision: 0,
  identity: { conversationId: 'chat', kind: 'unsaved' as const, id: 'parent' } };
mock.module('./tauriIpc', () => ({
  isTauriAvailable: () => true,
  chatAdmissionOpenBrowser: async (runtime: string) => { calls.push(['open', runtime]); await opened.promise; throw failure; },
  chatAdmissionCloseBrowser: async (runtime: string) => { calls.push(['close', runtime]); closing.resolve(); await closed.promise; },
  chatAdmissionBegin: async (runtime: string) => { calls.push(['begin', runtime]); return { kind: 'conversation' as const }; },
  chatAdmissionClosePreparation: async () => undefined,
  chatAdmissionReserveResponse: async (context: {handle: string; runtime: string}, conversationId: string, messageId: string) => {
    expect(messageId).toBe('answer');
    recoveryCalls.push('reserve');
    recoveryReceipt = { ...recoveryReceipt, runtime: context.runtime, identity: { conversationId, kind: 'unsaved', id: context.handle } };
    return recoveryReceipt;
  },
  chatAdmissionFinishResponse: async () => { recoveryCalls.push('writer'); if (writerError) throw writerError; },
  chatAdmissionFinishIntent: async (receipt: unknown) => { expect(receipt).toEqual(recoveryReceipt); recoveryCalls.push('copy-ack'); },
  chatAdmissionPrepareResponseRecovery: async () => { recoveryCalls.push('prepare-recovery'); return {kind: 'globalChat', receipt: recoveryReceipt}; },
  chatAdmissionRecoverResponse: async () => { recoveryCalls.push('recover-writer'); if (writerError) throw writerError; },
}));
const { ensureChatBrowser, retireChatBrowser, beginChatAdmission, reserveChatResponse, finishChatResponse, recoverChatResponse, responseCopyAdmission } = await import('./chatAdmission');

it('retires a registration with a lost ACK before admitting a replacement browser', async () => {
  const registration = ensureChatBrowser().then(() => null, (error: unknown) => error);
  await Promise.resolve();
  const retirement = retireChatBrowser();
  const next = beginChatAdmission('chat', 'turn', 'attempt');
  opened.resolve();
  expect(await registration).toBe(failure);
  await closing.promise;
  expect(calls.map(([kind]) => kind)).toEqual(['open', 'close']);
  expect(calls[0][1]).toBe(calls[1][1]);
  closed.resolve();
  await retirement;
  await next;
  expect(calls.map(([kind]) => kind)).toEqual(['open', 'close', 'begin']);
  expect(calls[2][1]).not.toBe(calls[0][1]);
});


it('keeps the recovery copy until the native writer confirms every external child', async () => {
  recoveryCalls.length = 0;
  const message = { id: 'answer', conversation_id: 'chat', role: 'assistant' as const,
    turn_id: 'turn', task_id: '', content: 'Saved response', timestamp: '2026-01-01' };
  const context = { handle: 'parent', runtime: 'browser' };
  expect(() => responseCopyAdmission(message.id, {kind:'globalChat', context})).toThrow('no native admission');
  await reserveChatResponse(context, 'chat', message.id);
  writerError = new Error('unknown provider');
  const remove = () => { recoveryCalls.push('remove'); return true; };
  await expect(finishChatResponse(context, 'chat', message, remove)).rejects.toThrow('unknown provider');
  expect(recoveryCalls).toEqual(['reserve', 'writer']);
  writerError = null;
  await finishChatResponse(context, 'chat', message, remove);
  expect(recoveryCalls).toEqual(['reserve', 'writer', 'writer', 'remove', 'copy-ack']);
  expect(() => responseCopyAdmission(message.id, {kind:'globalChat', context})).toThrow('no native admission');
});

it('recovery after browser loss never falls back to an ordinary writer after native refusal', async () => {
  recoveryCalls.length = 0;
  const message = { id: 'answer', conversation_id: 'chat', role: 'assistant' as const,
    turn_id: 'turn', task_id: '', content: 'Saved response', timestamp: '2026-01-01' };
  writerError = new Error('retired provider unknown');
  const fallback = async () => { throw new Error('Forbidden ordinary writer'); };
  const remove = () => { recoveryCalls.push('remove'); return true; };
  await expect(recoverChatResponse(message, fallback, remove)).rejects.toThrow('retired provider unknown');
  expect(recoveryCalls).toEqual(['prepare-recovery', 'recover-writer']);
  writerError = null;
  await recoverChatResponse(message, fallback, remove);
  expect(recoveryCalls).toEqual(['prepare-recovery', 'recover-writer', 'prepare-recovery', 'recover-writer', 'remove', 'copy-ack']);
});
