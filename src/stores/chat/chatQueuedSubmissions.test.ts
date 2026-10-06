import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chatSendFixture } from '../../test-utils/chatSendFixture';
import { usePersistenceHealth } from '../../services/persistenceHealth';
import { captureQueuedSubmission, loadQueuedSubmissions, saveQueuedSubmissions, QUEUED_SUBMISSIONS_STORAGE_KEY } from './chatQueuedSubmissions';

const previousWindow = globalThis.window;
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  } });
  usePersistenceHealth.setState({ issues: {} });
});
afterEach(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow }));

describe('queued submissions local recovery', () => {
  it('round-trips the accepted intent without credentials or permissions', () => {
    const f = chatSendFixture('Architect');
    f.snapshot.provider.providerConfigs[0].apiKey = 'synthetic-secret';
    const entry = captureQueuedSubmission('queued-turn', f.input, f.snapshot);
    f.snapshot.architectPlan!.planId = 'new-plan';
    f.snapshot.executionContext.projectIds.push('different-project');
    f.snapshot.provider.selectedModelId = 'new-model';
    expect(saveQueuedSubmissions([entry])).toBe(true);
    const [restored] = loadQueuedSubmissions();
    expect(restored.intent.architectPlan?.planId).toBe('plan-1');
    expect(restored.intent.executionContext.projectIds).toEqual(['project-1']);
    expect(restored.intent.executionContext.actionableProjectIds).toEqual([]);
    expect(restored.intent.provider.selectedModelId).toBe('model-1');
    expect(window.localStorage.getItem(QUEUED_SUBMISSIONS_STORAGE_KEY)).not.toContain('synthetic-secret');
  });

  it('keeps the chosen conversation but no extracted text until the queued turn departs', () => {
    const f = chatSendFixture('Chat');
    f.snapshot.composerContextRefs = [{
      id: 'source', kind: 'conversation', title: 'Prior work', conversationId: 'source',
    }];
    const entry = captureQueuedSubmission('queued-source', f.input, f.snapshot);
    expect(saveQueuedSubmissions([entry])).toBe(true);
    const [restored] = loadQueuedSubmissions();
    expect(restored.input.contextRefs).toEqual([{
      id: 'source', kind: 'conversation', title: 'Prior work', conversationId: 'source',
    }]);
    expect(restored.input.contextRefs?.[0]?.snippet).toBeUndefined();
  });

  it('rejects an oversized writer without evicting accepted messages', () => {
    const f = chatSendFixture();
    const entry = captureQueuedSubmission('queued-turn', f.input, f.snapshot);
    expect(saveQueuedSubmissions([entry])).toBe(true);
    const raw = window.localStorage.getItem(QUEUED_SUBMISSIONS_STORAGE_KEY);
    expect(saveQueuedSubmissions(Array.from({ length: 51 }, (_, i) => ({ ...entry, id: `turn-${i}` })))).toBe(false);
    expect(window.localStorage.getItem(QUEUED_SUBMISSIONS_STORAGE_KEY)).toBe(raw);
    expect(usePersistenceHealth.getState().issues[QUEUED_SUBMISSIONS_STORAGE_KEY]).toBeDefined();
    expect(loadQueuedSubmissions()).toHaveLength(1);
  });

  it('preserves corrupt recovery data and reports it instead of overwriting it', () => {
    window.localStorage.setItem(QUEUED_SUBMISSIONS_STORAGE_KEY, '{broken');
    expect(loadQueuedSubmissions()).toEqual([]);
    expect(saveQueuedSubmissions([])).toBe(false);
    expect(window.localStorage.getItem(QUEUED_SUBMISSIONS_STORAGE_KEY)).toBe('{broken');
    expect(usePersistenceHealth.getState().issues[QUEUED_SUBMISSIONS_STORAGE_KEY]).toBeDefined();
  });
});


describe('queued durable direction subtype', () => {
  it('round-trips the exact user, original turn and delivery receipt in the existing storage key', () => {
    const f = chatSendFixture();
    const entry = captureQueuedSubmission('direction', { ...f.input, hiddenContext: 'retained local context' }, f.snapshot);
    entry.direction = { userMessageId: 'user', target: { sessionId: 'session', turnId: 'original-turn', assistantMessageId: null },
      delivery: { requestId: 'request', assistantMessageId: 'assistant', requestEnded: false } };
    expect(saveQueuedSubmissions([entry])).toBe(true); expect(loadQueuedSubmissions()).toEqual([entry]);
  });
  it('preserves malformed direction receipts rather than replacing corrupt storage', () => {
    const f = chatSendFixture(); const entry = captureQueuedSubmission('direction', f.input, f.snapshot);
    const raw = JSON.stringify([{ ...entry, direction: { userMessageId: 'user', target: { sessionId: 'session', turnId: 'turn', assistantMessageId: null },
      delivery: { requestId: 'request', assistantMessageId: 'assistant', requestEnded: 'yes' } } }]);
    window.localStorage.setItem(QUEUED_SUBMISSIONS_STORAGE_KEY, raw);
    expect(loadQueuedSubmissions()).toEqual([]); expect(saveQueuedSubmissions([])).toBe(false);
    expect(window.localStorage.getItem(QUEUED_SUBMISSIONS_STORAGE_KEY)).toBe(raw);
  });
});
