import { expect, it, mock } from 'bun:test';
import { createDeferred } from '../test-utils/deferred';

const opened = createDeferred<void>();
const closing = createDeferred<void>();
const failure = new Error('registration ACK lost');
const closed = createDeferred<void>();
const calls: Array<[string, string]> = [];
mock.module('./tauriIpc', () => ({
  isTauriAvailable: () => true,
  chatAdmissionOpenBrowser: async (runtime: string) => { calls.push(['open', runtime]); await opened.promise; throw failure; },
  chatAdmissionCloseBrowser: async (runtime: string) => { calls.push(['close', runtime]); closing.resolve(); await closed.promise; },
  chatAdmissionBegin: async (runtime: string) => { calls.push(['begin', runtime]); return { kind: 'conversation' as const }; },
  chatAdmissionClosePreparation: async () => undefined,
  chatAdmissionFinishResponse: async () => undefined,
}));
const { ensureChatBrowser, retireChatBrowser, beginChatAdmission } = await import('./chatAdmission');

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
