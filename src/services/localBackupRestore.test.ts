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


it('blocks normal startup on browser storage failure and retries before hydration', async () => {
  const { createApplicationStartup } = await import('./applicationStartup');
  const values = new Map([['macro_chat_composer_drafts_v1', 'original']]);
  let quota = true;
  let pending = true;
  const events: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index],
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (quota && value === 'restored') throw new Error('synthetic quota');
      values.set(key, value);
    }, removeItem: (key: string) => values.delete(key),
  }});
  mock.module('./tauriIpc', () => ({
    isTauriAvailable: () => true,
    localBackupStatus: async () => ({ message: '', browser: pending ? {
      macro_chat_composer_drafts_v1: 'restored',
    } : null }),
    localBackupAcknowledge: async () => { events.push('acknowledge'); pending = false; },
  }));
  const { restoreBackupBrowserState } = await import('./localBackup');
  const dependencies = {
    install: () => () => {}, restore: restoreBackupBrowserState,
    initializeConfiguration: async () => { events.push('configuration'); },
    initializeLanguage: async () => { events.push('language'); },
    initializeSearch: async () => { events.push('search'); },
    installEffects: () => { events.push('effects'); return () => {}; },
    render: () => { events.push('hydrate'); },
    renderRecovery: () => { events.push('recovery'); },
    reload: () => { events.push('reload'); }, report: () => { events.push('report'); },
  };
  const failed = createApplicationStartup(dependencies);
  await failed.start();
  expect(events).toEqual(['language', 'recovery']);
  expect(values.get('macro_chat_composer_drafts_v1')).toBe('original');
  expect(pending).toBe(true);
  await failed.stop();
  quota = false;
  events.length = 0;
  const retry = createApplicationStartup(dependencies);
  await retry.start();
  expect(events).toEqual(['acknowledge', 'reload']);
  expect(values.get('macro_chat_composer_drafts_v1')).toBe('restored');
  await retry.stop();
  events.length = 0;
  const reopened = createApplicationStartup(dependencies);
  await reopened.start();
  expect(events).toEqual(['configuration', 'language', 'search', 'effects', 'hydrate']);
  await reopened.stop();
});
