import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let importCounter = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let capturedVirtualizerOptions: Array<{
  getItemKey?: (index: number) => string | number;
  estimateSize: (index: number) => number;
}> = [];
let capturedVirtualizers: Array<{
  shouldAdjustScrollPositionOnItemSizeChange?: (...args: unknown[]) => boolean;
}> = [];

const loadUseVirtualListModule = async () => {
  importCounter += 1;
  capturedVirtualizerOptions = [];
  capturedVirtualizers = [];
  mock.restore();

  mock.module('@tanstack/react-virtual', () => ({
    useVirtualizer: (options: {
      count?: number;
      getItemKey?: (index: number) => string | number;
      estimateSize: (index: number) => number;
    }) => {
      capturedVirtualizerOptions.push(options);
      const itemCount = options.count ?? 0;
      const virtualizer = {
        shouldAdjustScrollPositionOnItemSizeChange: undefined,
        getVirtualItems: () =>
          Array.from({ length: itemCount }, (_, index) => ({
            index,
            key: options.getItemKey ? options.getItemKey(index) : index,
            size: options.estimateSize(index),
            start: index * options.estimateSize(index),
          })),
        getTotalSize: () =>
          Array.from({ length: itemCount }, (_, index) => options.estimateSize(index)).reduce(
            (total, size) => total + size,
            0
          ),
        scrollToIndex: () => undefined,
        measureElement: () => undefined,
      };
      capturedVirtualizers.push(virtualizer);
      return virtualizer;
    },
  }));

  return import(`./useVirtualList.ts?use-virtual-list-test=${importCounter}`);
};

describe('useVirtualList', () => {
  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    mock.restore();
  });

  it('forwards stable item keys to TanStack Virtual when provided', async () => {
    const { useVirtualList } = await loadUseVirtualListModule();
    let hookResult: unknown = null;

    const TestComponent = () => {
      const result = useVirtualList({
        items: [{ id: 'section:drafts' }, { id: 'task:ready-1' }],
        getItemKey: (item: { id: string }) => item.id,
        estimateSize: 112,
      });
      useEffect(() => {
        hookResult = result;
      }, [result]);
      return null;
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<TestComponent />);
    });

    const options = capturedVirtualizerOptions[capturedVirtualizerOptions.length - 1];
    const result = hookResult as { virtualItems: Array<{ key: string | number }> } | null;

    expect(options).toBeDefined();
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('Expected hook result to be available');
    }
    expect(options?.getItemKey?.(0)).toBe('section:drafts');
    expect(options?.getItemKey?.(1)).toBe('task:ready-1');
    expect(result.virtualItems[0]?.key).toBe('section:drafts');
  });

  it('keeps the existing index-based fallback when no item key extractor is provided', async () => {
    const { useVirtualList } = await loadUseVirtualListModule();
    let hookResult: unknown = null;

    const TestComponent = () => {
      const result = useVirtualList({
        items: [{ id: 'row-a' }, { id: 'row-b' }],
        estimateSize: 96,
      });
      useEffect(() => {
        hookResult = result;
      }, [result]);
      return null;
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<TestComponent />);
    });

    const options = capturedVirtualizerOptions[capturedVirtualizerOptions.length - 1];
    const result = hookResult as { virtualItems: Array<{ key: string | number }> } | null;

    expect(options).toBeDefined();
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('Expected hook result to be available');
    }
    expect(options?.getItemKey).toBeUndefined();
    expect(result.virtualItems[0]?.key).toBe(0);
  });

  it('applies item resize scroll correction control to the TanStack Virtual instance', async () => {
    const { useVirtualList } = await loadUseVirtualListModule();
    const shouldAdjustScrollPositionOnItemSizeChange = () => false;

    const TestComponent = () => {
      useVirtualList({
        items: [{ id: 'row-a' }],
        estimateSize: 96,
        shouldAdjustScrollPositionOnItemSizeChange,
      });
      return null;
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<TestComponent />);
    });

    const virtualizer = capturedVirtualizers[capturedVirtualizers.length - 1];

    expect(virtualizer).toBeDefined();
    expect(virtualizer?.shouldAdjustScrollPositionOnItemSizeChange).toBe(
      shouldAdjustScrollPositionOnItemSizeChange
    );
  });
});
