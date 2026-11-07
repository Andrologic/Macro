import { expect, it } from 'bun:test';
import { runHostWorkPump030, type HostWorkPumpPort030 } from './hostWorkPump030';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('processes a second ticket while the first is still awaiting its evaluation', async () => {
  const first = deferred<string>();
  const next = deferred<number>();
  const done = deferred<void>();
  const firstDone = deferred<void>();
  const completed: number[] = [];
  let calls = 0;
  const port: HostWorkPumpPort030<number, string> = {
    next: () => ++calls === 1 ? Promise.resolve(1) : calls === 2 ? Promise.resolve(2) : next.promise,
    evaluate: job => job === 1 ? first.promise : Promise.resolve('second'),
    complete: async job => { completed.push(job); if (job === 2) done.resolve(); else firstDone.resolve(); },
    fail: async () => {},
  };
  const pump = runHostWorkPump030(port);
  await done.promise;
  expect(completed).toEqual([2]);
  first.resolve('first');
  await firstDone.promise;
  next.reject(new Error('host retired'));
  await pump;
  expect(completed).toEqual([2, 1]);
});

it('revokes the host once when an evaluation fails and never completes its ticket', async () => {
  const next = deferred<number>();
  const failed = deferred<void>();
  const expected = new Error('invalid transition');
  let calls = 0;
  let completions = 0;
  const failures: unknown[] = [];
  const port: HostWorkPumpPort030<number, string> = {
    next: () => ++calls === 1 ? Promise.resolve(1) : next.promise,
    evaluate: async () => { throw expected; },
    complete: async () => { completions++; },
    fail: async error => { failures.push(error); next.reject(new Error('host retired')); failed.resolve(); },
  };
  const pump = runHostWorkPump030(port);
  await failed.promise;
  await pump;
  expect(failures).toEqual([expected]);
  expect(completions).toBe(0);
});

it('surfaces failed revocation even if the next mailbox read never settles', async () => {
  const failure = new Error('revocation failed');
  const next = deferred<number>();
  let calls = 0;
  const pump = runHostWorkPump030<number, string>({
    next: () => ++calls === 1 ? Promise.resolve(1) : next.promise,
    evaluate: async () => { throw new Error('evaluation failed'); },
    complete: async () => {},
    fail: async () => { throw failure; },
  });
  const outcome = await Promise.race([
    pump.then(() => 'resolved', error => error),
    new Promise(resolve => setTimeout(() => resolve('timed out'), 100)),
  ]);
  expect(outcome).toBe(failure);
});

it('detaches a stalled evaluation after revocation and never sends its late result', async () => {
  const pending = deferred<string>();
  const next = deferred<number>();
  const completed: number[] = [];
  let calls = 0;
  const pump = runHostWorkPump030<number, string>({
    next: () => ++calls === 1 ? Promise.resolve(1) : calls === 2 ? Promise.resolve(2) : next.promise,
    evaluate: async job => job === 1 ? pending.promise : Promise.reject(new Error('broken')),
    complete: async job => { completed.push(job); },
    fail: async () => {},
  });
  const outcome = await Promise.race([pump.then(() => 'stopped'), new Promise(resolve => setTimeout(() => resolve('timed out'), 100))]);
  expect(outcome).toBe('stopped');
  pending.resolve('late');
  await Promise.resolve();
  await Promise.resolve();
  expect(completed).toEqual([]);
});

it('does not wait for a stuck completion after another evaluation revokes the host', async () => {
  const completion = deferred<void>();
  const started = deferred<void>();
  const next = deferred<number>();
  let calls = 0;
  const pump = runHostWorkPump030<number, string>({
    next: () => ++calls === 1 ? Promise.resolve(1) : calls === 2 ? started.promise.then(() => 2) : next.promise,
    evaluate: async job => { if (job === 2) throw new Error('broken'); return 'ok'; },
    complete: async () => { started.resolve(); await completion.promise; },
    fail: async () => {},
  });
  const outcome = await Promise.race([pump.then(() => 'stopped'), new Promise(resolve => setTimeout(() => resolve('timed out'), 100))]);
  expect(outcome).toBe('stopped');
  completion.resolve();
});

it('revokes only once when two evaluations fail together', async () => {
  const pending = deferred<number>();
  const trigger = deferred<void>();
  let calls = 0;
  let revocations = 0;
  const pump = runHostWorkPump030<number, string>({
    next: () => ++calls === 1 ? Promise.resolve(1) : calls === 2 ? Promise.resolve(2) : pending.promise,
    evaluate: async () => { await trigger.promise; throw new Error('broken'); },
    complete: async () => {},
    fail: async () => { revocations++; },
  });
  while (calls < 3) await Promise.resolve();
  trigger.resolve();
  await pump;
  expect(revocations).toBe(1);
});
