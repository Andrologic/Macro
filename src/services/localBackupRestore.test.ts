import { afterEach, expect, it, mock } from 'bun:test';
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => { mock.restore(); if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); });
it('requests a fresh bootstrap exactly after applying and acknowledging browser restoration', async () => {
  let pending = true;
  const values = new Map([['macro_chat_questionnaire_drafts', '{"old":{}}']]);
  const restored = '{"restored":{"assistantMessageId":"assistant","currentStepIndex":0,"answersByStepId":{},"draftTextByStepId":{}}}';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index], getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => values.delete(key),
  }});
  mock.module('./tauriIpc', () => ({
    isTauriAvailable: () => true,
    localBackupStatus: async () => ({ message: '', browser: pending ? { macro_chat_questionnaire_drafts: restored } : null }),
    localBackupAcknowledge: async () => { expect(values.get('macro_chat_questionnaire_drafts')).toBe(restored); pending = false; },
  }));
  const { restoreBackupBrowserState } = await import('./localBackup');
  expect(await restoreBackupBrowserState()).toBe(true);
  expect(await restoreBackupBrowserState()).toBe(false);
  expect(values.get('macro_chat_questionnaire_drafts')).toBe(restored);
});
