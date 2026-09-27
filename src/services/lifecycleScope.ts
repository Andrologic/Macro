import type { LifecycleContext } from '../types/lifecycle';
export type { LifecycleContext } from '../types/lifecycle';

export class LifecycleStoppedError extends Error {
  constructor() { super('The resource owner has stopped.'); this.name = 'LifecycleStoppedError'; }
}

export const isLifecycleStopped = (error: unknown): boolean => error instanceof LifecycleStoppedError;

export function createLifecycleScope() {
  const controller = new AbortController();
  const releases = new Set<() => void>();
  const pending = new Set<Promise<unknown>>();
  const context: LifecycleContext = {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
    assertActive: () => { if (controller.signal.aborted) throw new LifecycleStoppedError(); },
  };
  return {
    ...context,
    own(dispose: () => void): () => void {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releases.delete(release);
        dispose();
      };
      if (context.isActive()) releases.add(release);
      else release();
      return release;
    },
    /** Track admitted work even after revocation; stopping is not rollback. */
    track<T>(work: Promise<T>): Promise<T> {
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    stop(): void {
      if (!context.isActive()) return;
      controller.abort();
      const failures: unknown[] = [];
      for (const release of [...releases].reverse()) {
        try { release(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Failed to release owned resources.');
    },
    async drain(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

export type LifecycleScope = ReturnType<typeof createLifecycleScope>;
