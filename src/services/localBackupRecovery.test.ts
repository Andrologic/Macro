import { afterEach, expect, it, mock } from 'bun:test';
import { applyBackupBrowserState, captureBackupBrowserState } from './localBackup';
import { chatSendFixture } from '../test-utils/chatSendFixture';
import { captureQueuedSubmission, loadQueuedSubmissions, QUEUED_SUBMISSIONS_STORAGE_KEY } from '../stores/chat/chatQueuedSubmissions';
import { loadUnsavedAssistantResponsesFromStorage, UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY } from '../stores/chat/chatLocalSessionState';
import { createQueuedSubmissionRuntime } from '../stores/chat/chatQueuedSubmissionRuntime';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  for (const [key, descriptor] of [['localStorage', originalStorage], ['window', originalWindow]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function fixture() {
  const f = chatSendFixture();
  const entry = captureQueuedSubmission('accepted-turn', f.input, f.snapshot);
  const response = { id: 'fallback', task_id: '', conversation_id: f.input.conversationId,
    role: 'assistant' as const, content: 'Réponse conservée', timestamp: '2026-10-03T10:00:00Z',
    turn_id: 'previous-turn', persistence_state: 'failed' as const, persistence_error: 'Synthetic failure' };
  const values = new Map([
    [QUEUED_SUBMISSIONS_STORAGE_KEY, JSON.stringify([entry])],
    [UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY, JSON.stringify({ [response.id]: response })],
    ['provider-secret', 'untouched'],
  ]);
  const storage = {
    get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (value === 'quota') throw new Error('quota'); values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  return { values, entry, response };
}
it('restores recovery identities and text with queued work paused after hydration', async () => {
  const { values, entry, response } = fixture();
  const archive = captureBackupBrowserState();
  expect(Object.keys(archive).sort()).toEqual([QUEUED_SUBMISSIONS_STORAGE_KEY, UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY].sort());
  values.clear();
  applyBackupBrowserState(archive);
  expect(loadQueuedSubmissions()).toEqual([entry]);
  expect(loadUnsavedAssistantResponsesFromStorage()).toEqual([response]);
  const send = mock(async () => { throw new Error('Must remain paused'); });
  const read = mock(async () => []);
  const previews = mock(() => {});
  const runtime = createQueuedSubmissionRuntime({ admit: async () => ({ kind: 'conversation' }), finish: async () => {}, blocked: () => false, cancelled: () => false,
    read, send, publish: () => {}, saveImages: () => true, recovery: () => {},
    previews, pending: () => {}, attempted: () => {} });
  await runtime.restore([entry.input.conversationId]);
  await runtime.drain(entry.input.conversationId);
  expect(send).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(previews).toHaveBeenLastCalledWith([{ id: entry.id, conversationId: entry.input.conversationId, content: entry.input.content, state: 'paused' }]);
});
it('replaces newer recovery values when a historical archive omits them', () => {
  const { values } = fixture();
  const previous = captureBackupBrowserState();
  applyBackupBrowserState({ macro_chat_composer_drafts_v1: '{}' });
  expect(loadQueuedSubmissions()).toEqual([]);
  expect(loadUnsavedAssistantResponsesFromStorage()).toEqual([]);
  expect(values.get('provider-secret')).toBe('untouched');
  applyBackupBrowserState(previous);
  expect(captureBackupBrowserState()).toEqual(previous);
});
it('rolls back all recovery values after a partially applied archive exceeds quota', () => {
  fixture();
  const previous = captureBackupBrowserState();
  expect(() => applyBackupBrowserState({
    [QUEUED_SUBMISSIONS_STORAGE_KEY]: '[]',
    [UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY]: 'quota',
  })).toThrow('quota');
  expect(captureBackupBrowserState()).toEqual(previous);
});
