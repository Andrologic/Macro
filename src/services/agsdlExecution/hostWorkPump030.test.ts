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
  const completed: number[] = [];
  let calls = 0;
  const port: HostWorkPumpPort030<number, string> = {
    next: () => ++calls === 1 ? Promise.resolve(1) : calls === 2 ? Promise.resolve(2) : next.promise,
    evaluate: job => job === 1 ? first.promise : Promise.resolve('second'),
    complete: async job => { completed.push(job); if (job === 2) done.resolve(); },
    fail: async () => {},
  };
  const pump = runHostWorkPump030(port);
  await done.promise;
  expect(completed).toEqual([2]);
  first.resolve('first');
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
