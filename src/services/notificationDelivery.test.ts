import { describe, expect, it } from 'bun:test';
import { createNotificationDelivery } from './notificationDelivery';

describe('notification renderer lifecycle', () => {
  it('retains pending actions, replaces keyed notifications and cancels dismissed entries', () => {
    const queue = createNotificationDelivery<{ title: string; action?: () => void }>();
    const action = () => {};
    queue.deliver('retry', { title: 'old' });
    queue.deliver('retry', { title: 'new', action });
    queue.deliver('removed', { title: 'removed' });
    queue.dismiss('removed');
    const seen: Array<{ title: string; action?: () => void }> = [];
    const detach = queue.attach((_id, payload) => seen.push(payload));
    expect(seen).toEqual([{ title: 'new', action }]);
    detach();
    queue.deliver('later', { title: 'later' });
    expect(seen).toHaveLength(1);
    const release = queue.attach((_id, payload) => seen.push(payload));
    detach(); // A stale cleanup must not disconnect the new renderer.
    queue.deliver('live', { title: 'live' });
    expect(seen.map(item => item.title)).toEqual(['new', 'later', 'live']);
    release();
  });
});

it('keeps undelivered entries after a renderer fails during attachment', () => {
  const queue = createNotificationDelivery<string>();
  queue.deliver('first', 'first');
  queue.deliver('second', 'second');
  expect(() => queue.attach((id) => { if (id === 'second') throw new Error('renderer failed'); })).toThrow('renderer failed');
  const recovered: string[] = [];
  const stop = queue.attach((_id, payload) => recovered.push(payload));
  expect(recovered).toEqual(['second']);
  stop();
});
