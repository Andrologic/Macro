import { describe, expect, it } from 'bun:test';
import {
  ToastBatchController,
  TOAST_BATCH_DURATION_MS,
} from './toastBatchController';

interface ScheduledTimer {
  id: number;
  runAt: number;
  callback: () => void;
}

const createSchedulerHarness = () => {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, ScheduledTimer>();

  const scheduler = {
    now: () => now,
    setTimeout: (callback: () => void, delayMs: number) => {
      const timerId = nextTimerId++;
      timers.set(timerId, {
        id: timerId,
        runAt: now + delayMs,
        callback,
      });
      return timerId as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number);
    },
  };

  const advanceBy = (delayMs: number) => {
    const targetTime = now + delayMs;

    while (true) {
      const nextTimer = Array.from(timers.values())
        .filter((timer) => timer.runAt <= targetTime)
        .sort((left, right) => left.runAt - right.runAt)[0];

      if (!nextTimer) {
        break;
      }

      timers.delete(nextTimer.id);
      now = nextTimer.runAt;
      nextTimer.callback();
    }

    now = targetTime;
  };

  return {
    scheduler,
    advanceBy,
  };
};

describe('toast batch controller', () => {
  it('expires every active toast together based on the most recent arrival', () => {
    const { scheduler, advanceBy } = createSchedulerHarness();
    const controller = new ToastBatchController(TOAST_BATCH_DURATION_MS, scheduler);
    const expiredBatches: Array<Array<string | number>> = [];

    controller.setExpiryHandler((toastIds) => {
      expiredBatches.push(toastIds);
    });

    controller.registerToast('toast-a');
    advanceBy(3000);
    controller.registerToast('toast-b');

    expect(controller.getSnapshot().activeToastIds).toEqual(['toast-a', 'toast-b']);

    advanceBy(4999);
    expect(expiredBatches).toEqual([]);

    advanceBy(1);
    expect(expiredBatches).toEqual([['toast-a', 'toast-b']]);
    expect(controller.getSnapshot()).toEqual({
      activeToastIds: [],
      deadlineAt: null,
      remainingMs: null,
      isPaused: false,
    });
  });

  it('pauses and resumes the shared timer without losing the remaining delay', () => {
    const { scheduler, advanceBy } = createSchedulerHarness();
    const controller = new ToastBatchController(TOAST_BATCH_DURATION_MS, scheduler);
    const expiredBatches: Array<Array<string | number>> = [];

    controller.setExpiryHandler((toastIds) => {
      expiredBatches.push(toastIds);
    });

    controller.registerToast('toast-a');
    advanceBy(2000);
    controller.pauseBatchTimer();

    expect(controller.getSnapshot()).toEqual({
      activeToastIds: ['toast-a'],
      deadlineAt: null,
      remainingMs: 3000,
      isPaused: true,
    });

    advanceBy(10000);
    expect(expiredBatches).toEqual([]);

    controller.resumeBatchTimer();
    advanceBy(2999);
    expect(expiredBatches).toEqual([]);

    advanceBy(1);
    expect(expiredBatches).toEqual([['toast-a']]);
  });

  it('keeps the shared timer running when a single toast is manually removed', () => {
    const { scheduler, advanceBy } = createSchedulerHarness();
    const controller = new ToastBatchController(TOAST_BATCH_DURATION_MS, scheduler);
    const expiredBatches: Array<Array<string | number>> = [];

    controller.setExpiryHandler((toastIds) => {
      expiredBatches.push(toastIds);
    });

    controller.registerToast('toast-a');
    controller.registerToast('toast-b');
    advanceBy(2000);
    controller.unregisterToast('toast-b');

    expect(controller.getSnapshot().activeToastIds).toEqual(['toast-a']);

    advanceBy(2999);
    expect(expiredBatches).toEqual([]);

    advanceBy(1);
    expect(expiredBatches).toEqual([['toast-a']]);
  });
});
