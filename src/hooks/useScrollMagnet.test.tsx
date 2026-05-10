import { afterEach, describe, expect, it } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useScrollMagnet, type SeparatorState } from './useScrollMagnet';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let scrollContainer: HTMLDivElement | null = null;
let latestState: SeparatorState | null = null;
let resizeObserverCallbacks: ResizeObserverCallback[] = [];

class TriggerableResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

const TestComponent: React.FC<{
  isStreaming: boolean;
  dep: unknown;
  messages: string[];
}> = ({ isStreaming, dep, messages }) => {
  const { scrollContainerRef, separatorState } = useScrollMagnet(isStreaming, [dep]);
  React.useEffect(() => {
    latestState = separatorState;
  }, [separatorState]);
  return (
    <div ref={scrollContainerRef} data-testid="scroll-container">
      {messages.map((message) => (
        <div key={message} data-scroll-magnet-anchor={message}>
          {message}
        </div>
      ))}
    </div>
  );
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flushRaf = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

const triggerResizeObservers = () => {
  for (const callback of resizeObserverCallbacks) {
    callback([], {} as ResizeObserver);
  }
};

const makeRect = (top: number, height: number): DOMRect => ({
  x: 0,
  y: top,
  top,
  bottom: top + height,
  left: 0,
  right: 500,
  width: 500,
  height,
  toJSON: () => ({}),
} as DOMRect);

const setScrollMetrics = (
  el: HTMLDivElement,
  metrics: { clientHeight: number; scrollHeight: number; scrollTop?: number },
) => {
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value: metrics.scrollHeight,
  });
  if (typeof metrics.scrollTop === 'number') {
    el.scrollTop = metrics.scrollTop;
  }
  el.getBoundingClientRect = () => makeRect(0, metrics.clientHeight);
  el.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === 'number') {
      el.scrollTop = options;
      return;
    }
    if (typeof options?.top === 'number') {
      el.scrollTop = options.top;
    }
  };
};

const setAnchorRects = (
  el: HTMLDivElement,
  positions: Record<string, { top: number; height: number }>,
) => {
  for (const anchor of Array.from(el.querySelectorAll<HTMLElement>('[data-scroll-magnet-anchor]'))) {
    const anchorId = anchor.dataset.scrollMagnetAnchor;
    if (!anchorId || !positions[anchorId]) continue;
    anchor.getBoundingClientRect = () => {
      const position = positions[anchorId]!;
      return makeRect(position.top - el.scrollTop, position.height);
    };
  }
};

const renderHookHarness = async (params: {
  isStreaming: boolean;
  dep: unknown;
  messages?: string[];
}) => {
  await act(async () => {
    root?.render(
      <TestComponent
        isStreaming={params.isStreaming}
        dep={params.dep}
        messages={params.messages ?? ['message-1', 'message-2']}
      />,
    );
  });

  scrollContainer = host?.querySelector('[data-testid="scroll-container"]') as HTMLDivElement | null;
  if (!scrollContainer) {
    throw new Error('Expected scroll container to render');
  }
  return scrollContainer;
};

const detachFromLockedState = async () => {
  if (!scrollContainer) {
    throw new Error('Expected scroll container to exist');
  }

  await act(async () => {
    const event = new window.WheelEvent('wheel', { deltaY: -32, cancelable: true });
    scrollContainer?.dispatchEvent(event);
  });
  expect(latestState).toBe('detaching');

  await act(async () => {
    await wait(430);
  });
  expect(latestState).toBe('detached');

  await act(async () => {
    await flushRaf();
  });
};

describe('useScrollMagnet', () => {
  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    host?.remove();
    root = null;
    host = null;
    scrollContainer = null;
    latestState = null;
    resizeObserverCallbacks = [];
  });

  const mount = async (params: {
    isStreaming: boolean;
    dep: unknown;
    messages?: string[];
  }) => {
    globalThis.ResizeObserver = TriggerableResizeObserver as unknown as typeof ResizeObserver;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    return renderHookHarness(params);
  };

  it('keeps the transcript pinned to the bottom while locked', async () => {
    const el = await mount({ isStreaming: false, dep: 0 });
    setScrollMetrics(el, { clientHeight: 200, scrollHeight: 1000, scrollTop: 0 });

    await renderHookHarness({ isStreaming: true, dep: 0 });
    await act(async () => {
      await flushRaf();
    });

    expect(latestState).toBe('locked');
    expect(el.scrollTop).toBe(1000);

    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    await renderHookHarness({ isStreaming: true, dep: 1 });
    await act(async () => {
      await flushRaf();
    });

    expect(el.scrollTop).toBe(1200);
  });

  it('keeps the transcript pinned when locked content expands without message deps changing', async () => {
    const el = await mount({ isStreaming: false, dep: 0 });
    setScrollMetrics(el, { clientHeight: 200, scrollHeight: 1000, scrollTop: 0 });

    await renderHookHarness({ isStreaming: true, dep: 0 });
    await act(async () => {
      await flushRaf();
    });

    expect(latestState).toBe('locked');
    expect(el.scrollTop).toBe(1000);

    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      value: 1350,
    });

    await act(async () => {
      triggerResizeObservers();
      await flushRaf();
    });

    expect(el.scrollTop).toBe(1350);
  });

  it('preserves the visible anchor when detached content updates move scrollTop', async () => {
    const el = await mount({ isStreaming: false, dep: 0 });
    setScrollMetrics(el, { clientHeight: 200, scrollHeight: 1000, scrollTop: 100 });
    setAnchorRects(el, {
      'message-1': { top: 100, height: 80 },
      'message-2': { top: 220, height: 80 },
    });

    await renderHookHarness({ isStreaming: true, dep: 0 });
    await act(async () => {
      await flushRaf();
    });
    el.scrollTop = 100;
    setAnchorRects(el, {
      'message-1': { top: 100, height: 80 },
      'message-2': { top: 220, height: 80 },
    });
    await detachFromLockedState();

    el.scrollTop = 100;
    el.dispatchEvent(new Event('scroll'));
    await act(async () => {
      await flushRaf();
    });

    el.scrollTop = 130;
    await renderHookHarness({ isStreaming: true, dep: 1 });

    expect(el.scrollTop).toBe(100);
  });

  it('updates the detached anchor after user scrolling', async () => {
    const el = await mount({ isStreaming: false, dep: 0 });
    setScrollMetrics(el, { clientHeight: 200, scrollHeight: 1000, scrollTop: 100 });
    setAnchorRects(el, {
      'message-1': { top: 100, height: 80 },
      'message-2': { top: 220, height: 80 },
    });

    await renderHookHarness({ isStreaming: true, dep: 0 });
    await act(async () => {
      await flushRaf();
    });
    el.scrollTop = 100;
    setAnchorRects(el, {
      'message-1': { top: 100, height: 80 },
      'message-2': { top: 220, height: 80 },
    });
    await detachFromLockedState();

    el.scrollTop = 170;
    el.dispatchEvent(new Event('scroll'));
    await act(async () => {
      await flushRaf();
    });

    el.scrollTop = 210;
    await renderHookHarness({ isStreaming: true, dep: 1 });

    expect(el.scrollTop).toBe(170);
  });

  it('reattaches when the user scrolls down near the bottom while streaming', async () => {
    const el = await mount({ isStreaming: false, dep: 0 });
    setScrollMetrics(el, { clientHeight: 200, scrollHeight: 1000, scrollTop: 100 });
    setAnchorRects(el, {
      'message-1': { top: 100, height: 80 },
      'message-2': { top: 220, height: 80 },
    });

    await renderHookHarness({ isStreaming: true, dep: 0 });
    await act(async () => {
      await flushRaf();
    });
    el.scrollTop = 100;
    setAnchorRects(el, {
      'message-1': { top: 100, height: 80 },
      'message-2': { top: 220, height: 80 },
    });
    await detachFromLockedState();

    el.scrollTop = 760;
    await act(async () => {
      const event = new window.WheelEvent('wheel', { deltaY: 36, cancelable: true });
      el.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
    expect(latestState).toBe('reattaching');

    await act(async () => {
      await wait(330);
    });

    expect(latestState).toBe('locked');
  });
});
