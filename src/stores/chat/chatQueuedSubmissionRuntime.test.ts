import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ChatMessage } from '../../types';
import { chatSendFixture } from '../../test-utils/chatSendFixture';
import { createDeferred } from '../../test-utils/deferred';
import { captureQueuedSubmission, loadQueuedSubmissions, QUEUED_SUBMISSIONS_STORAGE_KEY } from './chatQueuedSubmissions';
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
    queue.complete(next);
    return { status: 'sent' as const, conversationId: next.input.conversationId, turnId: next.id, userMessageId: `user-${next.id}`, assistantMessageId: `assistant-${next.id}` };
  });
  const queue = createQueuedSubmissionRuntime({
    blocked: () => blocked, cancelled: () => false, read, send,
    publish: () => {}, saveImages: () => true, recovery: () => {}, pending: () => {}, attempted: () => {},
    previews: value => { previews = value; },
  });
  return { queue, read, send, release: () => { blocked = false; }, previews: () => previews };
};

describe('live queued messages', () => {
  it('shows accepted messages in order and removes a waiting message without sending it', async () => {
    const f = setup();
    f.queue.accept(entry('first', 'Keep first'));
    f.queue.accept(entry('second', 'Discard second'));
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
    f.queue.accept(entry('first'));
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
    f.queue.accept(entry('first'));
    f.queue.accept(entry('second'));
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
    f.queue.accept(entry('first'));
    f.queue.accept(entry('second'));
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
    f.queue.accept(first);
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
    f.queue.accept(entry('first'));
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
    f.queue.accept(first);
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
