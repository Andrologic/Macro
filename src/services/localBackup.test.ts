import { afterEach, expect, it } from 'bun:test';
import { applyBackupBrowserState, captureBackupBrowserState } from './localBackup';
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); });
it('round-trips included browser state and leaves unrelated credentials untouched', () => {
  const values = new Map([['macro_chat_message_images', '{"original":[]}'], ['provider-secret', 'private']]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return values.size; }, key: (i: number) => [...values.keys()][i], getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => values.delete(key),
  }});
  const before = captureBackupBrowserState();
  expect(before).toEqual({ macro_chat_message_images: '{"original":[]}' });
  applyBackupBrowserState({ macro_chat_composer_drafts_v1: '{}' });
  expect(values.get('provider-secret')).toBe('private');
  applyBackupBrowserState(before);
  expect(captureBackupBrowserState()).toEqual(before);
});
it('compensates a quota error and rejects unexpected keys', () => {
  const values = new Map([['macro_chat_message_images', 'original']]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return values.size; }, key: (i: number) => [...values.keys()][i], getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (value === 'oversized') throw new Error('quota'); values.set(key, value); }, removeItem: (key: string) => values.delete(key),
  }});
  expect(() => applyBackupBrowserState({ macro_chat_message_images: 'oversized' })).toThrow('quota');
  expect(values.get('macro_chat_message_images')).toBe('original');
  expect(() => applyBackupBrowserState({ 'provider-secret': 'import' })).toThrow('Invalid');
});
