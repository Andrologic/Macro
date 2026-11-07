import { expect, it } from 'bun:test';
import { createConnectConsumerFixture } from './connectConsumer';
import { ConsumerReader } from '../../src/services/macroPilot/consumerReader';
import { connectReaderRetry } from '../../src/composition/macroConnectConsumer';
import type { ContentEventsPage } from '../../src/services/macroPilot/contentProtocol';

const until = async (check: () => boolean) => {
  const end = performance.now() + 2000;
  while (!check() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 2));
  expect(check()).toBe(true);
};

for (const stage of ['immediate', 'after-budget', 'capture-expired'] as const) it(`reboots the real fixture stream and reads a fresh capture on Retry: ${stage}`, async () => {
  const realDateNow = Date.now;
  let now = 0, wall = realDateNow();
  Date.now = () => wall;
  const timers = new Map<object, { at: number; run(): void }>();
  const clock = { now: () => now, timer: (run: () => void, ms: number) => {
    const key = {}; timers.set(key, { at: now + ms, run }); return () => { timers.delete(key); };
  }, advance: (ms: number) => {
    now += ms; wall += ms;
    for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.run(); }
  } };
  const h = createConnectConsumerFixture({ authorityLifetimeMs: 30000, monotonicNow: clock.now, timer: clock.timer,
    retry: { ...connectReaderRetry, delaysMs: [5, 10], deadlineMs: 60, maxDelayMs: 20, pollIntervalMs: 5 } });
  const reader = new ConsumerReader(h.ports), bootstraps: ContentEventsPage[] = [], send = h.transport.send;
  h.transport.send = async (...args) => {
    const reply = await send(...args);
    if (args[2].kind === 'events' && args[2].request.stream_id === null) bootstraps.push(reply.data as ContentEventsPage);
    return reply;
  };
  try {
    reader.start(); await until(() => reader.getSnapshot().phase === 'ready'); reader.open('instance:alpha');
    await until(() => Boolean(reader.getSnapshot().panels[0]?.catalog.page) && h.waiting.has('instance:alpha'));
    const old = reader.getSnapshot().panels[0].catalog.page!;
    h.emit('instance:alpha', [{ kind: 'projects.changed', scope: { instance_id: 'instance:alpha' }, revision: 77 }]);
    await until(() => h.waiting.get('instance:alpha')?.request.after_sequence === 1);
    if (stage !== 'immediate') {
      reader.setTransportOnline(false); clock.advance(stage === 'capture-expired' ? 300001 : 30001); reader.setTransportOnline(true);
      await until(() => h.waiting.has('instance:alpha')); await new Promise(resolve => setTimeout(resolve, 110));
      expect(h.waiting.size).toBe(0); expect(reader.getSnapshot().panels[0].catalog.page).toBeNull();
      if (stage === 'capture-expired') expect(reader.getSnapshot().panels[0].catalog.error).toBe('snapshot_expired');
    }
    await reader.retry(reader.getSnapshot().panels[0].key); expect(reader.getSnapshot().panels[0].phase).toBe('ready');
    await until(() => Boolean(reader.getSnapshot().panels[0].catalog.page) && h.waiting.has('instance:alpha'));
    const fresh = reader.getSnapshot().panels[0].catalog.page!;
    expect(fresh).not.toBe(old); expect(fresh.response.result.page.snapshot_id).not.toBe(old.response.result.page.snapshot_id);
    expect(old.captureDeadline).toBe(300000); expect(fresh.captureDeadline).toBe(now + 300000);
    expect(fresh.response.result.page.observed_at).toBe(new Date(wall).toISOString());
    expect(fresh.response.result.page.expires_at).toBe(new Date(wall + 300000).toISOString());
    expect(fresh.scope.generation).toBeGreaterThan(old.scope.generation);
    expect(bootstraps).toHaveLength(2); expect(bootstraps[1].stream_id).not.toBe(bootstraps[0].stream_id);
    for (const page of bootstraps) expect(page).toMatchObject({ reset: true, after_sequence: 0, next_sequence: 0, events: [] });
    expect(h.waiting.get('instance:alpha')!.request).toMatchObject({ stream_id: bootstraps[1].stream_id, after_sequence: 0 });
    const lease = h.owner()!.acquire('instance:alpha'); expect(lease.state().projectsRevision).toBeNull();
    h.emit('instance:alpha', [{ kind: 'projects.changed', scope: { instance_id: 'instance:alpha' }, revision: 1 }]);
    await until(() => h.waiting.get('instance:alpha')?.request.after_sequence === 1);
    expect(lease.state().projectsRevision).toBe(1); lease.release();
    expect(reader.getSnapshot().panels[0].catalog.page).toBe(fresh);
    expect(h.waiting.get('instance:alpha')!.request.stream_id).toBe(bootstraps[1].stream_id);
    const reads = h.calls.filter(call => call.dispatch.kind === 'submit'); expect(reads).toHaveLength(2);
    const last = reads.at(-1)!.dispatch; expect(last.kind).toBe('submit');
    if (last.kind === 'submit') expect(last.request.body).not.toHaveProperty('continuation');
  } finally { reader.dispose(); Date.now = realDateNow; }
  expect(timers.size).toBe(0); expect(h.waiting.size).toBe(0); expect(h.listeners.size).toBe(0);
});
