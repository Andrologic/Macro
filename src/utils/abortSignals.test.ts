import { describe, expect, it } from 'bun:test';
import { createCombinedAbortSignal } from './abortSignals';

class FakeAbortSignal extends EventTarget {
  aborted = false;
  reason: unknown = undefined;
  private abortListenerCount = 0;

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    if (type === 'abort' && callback) {
      this.abortListenerCount += 1;
    }
    super.addEventListener(type, callback as EventListener, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ): void {
    if (type === 'abort' && callback) {
      this.abortListenerCount = Math.max(0, this.abortListenerCount - 1);
    }
    super.removeEventListener(type, callback as EventListener, options);
  }

  trigger(reason?: unknown): void {
    if (this.aborted) {
      return;
    }

    this.aborted = true;
    this.reason = reason;
    this.dispatchEvent(new Event('abort'));
  }

  getListenerCount(): number {
    return this.abortListenerCount;
  }
}

describe('createCombinedAbortSignal', () => {
  it('detaches listeners when disposed after a successful flow', () => {
    const left = new FakeAbortSignal();
    const right = new FakeAbortSignal();

    const handle = createCombinedAbortSignal([
      left as unknown as AbortSignal,
      right as unknown as AbortSignal,
    ]);

    expect(left.getListenerCount()).toBe(1);
    expect(right.getListenerCount()).toBe(1);
    expect(handle.signal.aborted).toBe(false);

    handle.dispose();

    expect(left.getListenerCount()).toBe(0);
    expect(right.getListenerCount()).toBe(0);
    expect(handle.signal.aborted).toBe(false);
  });

  it('propagates abort and removes listeners from all input signals', () => {
    const left = new FakeAbortSignal();
    const right = new FakeAbortSignal();

    const handle = createCombinedAbortSignal([
      left as unknown as AbortSignal,
      right as unknown as AbortSignal,
    ]);

    right.trigger('pagehide');

    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe('pagehide');
    expect(left.getListenerCount()).toBe(0);
    expect(right.getListenerCount()).toBe(0);
  });
});
