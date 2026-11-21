import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ChatMessage } from '../../types';
import { chatSendFixture } from '../../test-utils/chatSendFixture';
import { createDeferred } from '../../test-utils/deferred';
import { captureQueuedSubmission, loadQueuedSubmissions, QUEUED_SUBMISSIONS_STORAGE_KEY } from './chatQueuedSubmissions';
import type { ChatIntentAdmission } from '../../services/ipc/chatAdmission';
import { createQueuedSubmissionRuntime, type QueuedSubmissionPreview } from './chatQueuedSubmissionRuntime';

beforeEach(() => window.localStorage.removeItem(QUEUED_SUBMISSIONS_STORAGE_KEY));
const entry = (id: string, content = id) => {
  const f = chatSendFixture();
  return captureQueuedSubmission(id, { ...f.input, content }, f.snapshot);
};
const setup = () => {
  let blocked = true;
  let previews: QueuedSubmissionPreview[] = [];
  const read = mock(async (_id: string): Promise<ChatMessage[]> => []);
  const send = mock(async (next: ReturnType<typeof entry>) => {
    await queue.complete(next);
    return { status: 'sent' as const, conversationId: next.input.conversationId, turnId: next.id, userMessageId: `user-${next.id}`, assistantMessageId: `assistant-${next.id}` };
  });
  const admit = mock(async (_entry: ReturnType<typeof entry>, _mutation: 'retain' | 'remove'): Promise<ChatIntentAdmission> => ({ kind: 'conversation' }));
  const finish = mock(async (_admission: ChatIntentAdmission) => {});
  const queue = createQueuedSubmissionRuntime({
    admit, finish,
    blocked: () => blocked, cancelled: () => false, read, send,
    publish: () => {}, saveImages: () => true, recovery: () => {}, pending: () => {}, attempted: () => {},
    previews: value => { previews = value; },
  });
  return { queue, read, send, admit, finish, release: () => { blocked = false; }, previews: () => previews };
};

describe('live queued messages', () => {
  it('shows accepted messages in order and removes a waiting message without sending it', async () => {
    const f = setup();
    await f.queue.accept(entry('first', 'Keep first'));
    await f.queue.accept(entry('second', 'Discard second'));
    expect(f.previews().map(x => [x.content, x.state])).toEqual([['Keep first', 'waiting'], ['Discard second', 'waiting']]);
    await f.queue.removeEntry('second');
    expect(loadQueuedSubmissions().map(x => x.id)).toEqual(['first']);
    f.release();
    await f.queue.drain(entry('first').input.conversationId);
    expect(f.send.mock.calls.map(([x]) => x.id)).toEqual(['first']);
  });

  it('rejects removal as soon as dispatch claims the message, even while history is loading', async () => {
    const f = setup();
    const messages = createDeferred<ChatMessage[]>();
    f.read.mockImplementationOnce(() => messages.promise);
    await f.queue.accept(entry('first'));
    f.release();
    const draining = f.queue.drain(entry('first').input.conversationId);
    expect(f.previews()[0].state).toBe('sending');
    await expect(f.queue.removeEntry('first')).rejects.toThrow('no longer available');
    expect(loadQueuedSubmissions()).toHaveLength(1);
    messages.resolve([]);
    await draining;
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('can remove a later message while the first is being sent', async () => {
    const f = setup();
    const sendDone = createDeferred<void>();
    const sendFirst = f.send.getMockImplementation()!;
    f.send.mockImplementationOnce(async x => { await sendDone.promise; return sendFirst(x); });
    await f.queue.accept(entry('first'));
    await f.queue.accept(entry('second'));
    f.release();
    const draining = f.queue.drain(entry('first').input.conversationId);
    await Promise.resolve();
    await f.queue.removeEntry('second');
    sendDone.resolve();
    await draining;
    await Promise.resolve();
    expect(f.send.mock.calls.map(([x]) => x.id)).toEqual(['first']);
    expect(loadQueuedSubmissions()).toEqual([]);
  });

  it('holds dispatch while removal is checking history and keeps remaining messages ordered', async () => {
    const f = setup();
    const messages = createDeferred<ChatMessage[]>();
    f.read.mockImplementationOnce(() => messages.promise);
    await f.queue.accept(entry('first'));
    await f.queue.accept(entry('second'));
    const removal = f.queue.removeEntry('first');
    f.release();
    await f.queue.drain(entry('first').input.conversationId);
    expect(f.send).not.toHaveBeenCalled();
    messages.resolve([]);
    await removal;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.send.mock.calls.map(([x]) => x.id)).toEqual(['second']);
  });

  it('releases the dispatch guard when removal cannot read history', async () => {
    const f = setup();
    const messages = createDeferred<ChatMessage[]>();
    f.read.mockImplementationOnce(() => messages.promise.then(() => { throw new Error('History unavailable'); }));
    const first = entry('first');
    await f.queue.accept(first);
    const removal = f.queue.removeEntry('first');
    f.release();
    await f.queue.drain(first.input.conversationId);
    expect(f.send).not.toHaveBeenCalled();
    messages.resolve([]);
    await expect(removal).rejects.toThrow('History unavailable');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('retains the message if durable removal fails', async () => {
    const f = setup();
    await f.queue.accept(entry('first'));
    const storage = window.localStorage;
    const values = new Map([[QUEUED_SUBMISSIONS_STORAGE_KEY, storage.getItem(QUEUED_SUBMISSIONS_STORAGE_KEY)!]]);
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => { throw new Error('Synthetic disk full'); },
    } });
    try { await expect(f.queue.removeEntry('first')).rejects.toThrow('could not be saved'); }
    finally { Object.defineProperty(window, 'localStorage', { configurable: true, value: storage }); }
    expect(loadQueuedSubmissions().map(x => x.id)).toEqual(['first']);
    expect(f.previews().map(x => x.id)).toEqual(['first']);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('pauses dispatch during history loading and retains messages until explicit retry', async () => {
    const f = setup();
    const messages = createDeferred<ChatMessage[]>();
    f.read.mockImplementationOnce(() => messages.promise);
    const first = entry('first');
    await f.queue.accept(first);
    f.release();
    const draining = f.queue.drain(first.input.conversationId);
    f.queue.pause(first.input.conversationId);
    messages.resolve([]);
    await draining;
    expect(f.send).not.toHaveBeenCalled();
    expect(f.previews()[0].state).toBe('paused');
    await f.queue.retry(first.input.conversationId);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});


describe('queued intent ownership', () => {
  it('waits for admission before storing and joins an admission interrupted by retirement', async () => {
    const f = setup();
    const entered = createDeferred<void>();
    const admission = createDeferred<ChatIntentAdmission>();
    f.admit.mockImplementationOnce(() => { entered.resolve(); return admission.promise; });
    const accepted = f.queue.accept(entry('pending'));
    const rejected = accepted.then(() => null, error => error);
    await entered.promise;
    expect(loadQueuedSubmissions()).toEqual([]);
    let retired = false;
    const retirement = f.queue.retire().then(() => { retired = true; });
    await Promise.resolve();
    expect(retired).toBe(false);
    admission.resolve({ kind: 'conversation' });
    expect((await rejected)?.message).toContain('owner has retired');
    await retirement;
    expect(loadQueuedSubmissions()).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('joins history loading on retirement and never starts its deferred send', async () => {
    const f = setup();
    const entered = createDeferred<void>();
    const history = createDeferred<ChatMessage[]>();
    f.read.mockImplementationOnce(() => { entered.resolve(); return history.promise; });
    const next = entry('pending');
    await f.queue.accept(next);
    f.release();
    const drain = f.queue.drain(next.input.conversationId);
    await entered.promise;
    let retired = false;
    const retirement = f.queue.retire().then(() => { retired = true; });
    await Promise.resolve();
    expect(retired).toBe(false);
    history.resolve([]);
    await Promise.all([drain, retirement]);
    expect(f.send).not.toHaveBeenCalled();
    expect(loadQueuedSubmissions().map(x => x.id)).toEqual(['pending']);
  });

  it('does not resurrect a removed copy when its native ACK is lost', async () => {
    const f = setup();
    await f.queue.accept(entry('removed'));
    f.finish.mockImplementationOnce(async () => { throw new Error('ACK lost'); });
    await expect(f.queue.removeEntry('removed')).rejects.toThrow('ACK lost');
    expect(loadQueuedSubmissions()).toEqual([]);
    await f.queue.accept(entry('new'));
    expect(loadQueuedSubmissions().map(x => x.id)).toEqual(['new']);
    expect(f.send).not.toHaveBeenCalled();
  });
});


it('removes a persisted orphan copy through the removal classification without dispatch', async () => {
  const f = setup();
  let deleted = false;
  f.admit.mockImplementation(async (next, mutation) => {
    if (deleted) {
      if (mutation !== 'remove') throw new Error('Deleted chat cannot retain work');
      return { kind: 'conversation' };
    }
    return { kind: 'globalChat', receipt: { operationId: 'native-queue', runtime: 'browser', revision: 0,
      identity: { conversationId: next.input.conversationId, kind: 'queue', id: next.id } } };
  });
  const queued = entry('orphan');
  await f.queue.accept(queued);
  expect(loadQueuedSubmissions()).toHaveLength(1);
  // Native SQLite separately proves that repository deletion yields only this
  // removal classification and leaves provider unknown + old marker intact.
  deleted = true;
  await f.queue.remove([queued.input.conversationId]);
  expect(loadQueuedSubmissions()).toEqual([]);
  expect(f.previews()).toEqual([]);
  expect(f.finish).toHaveBeenCalledWith({ kind: 'conversation' });
  expect(f.send).not.toHaveBeenCalled();
});
