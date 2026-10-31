import { expect, it } from 'bun:test';
import { startWorkflowTaskMonitor } from './workflowTaskMonitor';

it('refreshes without overlap and stops scheduling after retirement during a read', async () => {
  const queue: Array<() => void> = [];
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const stop = startWorkflowTaskMonitor({ enabled: () => true, refresh: async () => { reads++; await pending; },
    schedule: callback => { queue.push(callback); return () => { const index = queue.indexOf(callback); if (index >= 0) queue.splice(index, 1); }; } });
  queue.shift()!();
  expect(reads).toBe(1);
  expect(queue).toHaveLength(0);
  stop(); release();
  await new Promise<void>(resolve => queueMicrotask(resolve));
  expect(queue).toHaveLength(0);
});

it('skips disabled generations and retries reads after a transient failure', async () => {
  const queue: Array<() => void> = [];
  let enabled = false, calls = 0, failures = 0;
  const stop = startWorkflowTaskMonitor({ enabled: () => enabled, refresh: async () => { calls++; throw new Error('Transient'); },
    report: () => { failures++; }, schedule: callback => { queue.push(callback); return () => undefined; } });
  queue.shift()!();
  expect(calls).toBe(0);
  enabled = true;
  queue.shift()!();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(calls).toBe(1); expect(failures).toBe(1); expect(queue).toHaveLength(1);
  stop();
});
