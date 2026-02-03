/**
 * Virtual List Hook
 *
 * Wrapper around @tanstack/react-virtual for common virtualization patterns.
 * Provides simplified API for virtualizing lists with variable or fixed heights.
 */

import { useRef, useCallback } from "react";
import { useVirtualizer, VirtualizerOptions } from "@tanstack/react-virtual";

export interface UseVirtualListOptions<T> {
  /** Items to virtualize */
  items: T[];
  /** Estimated height of each item in pixels */
  estimateSize: number;
  /** Number of items to render outside of visible area */
  overscan?: number;
  /** Whether items have variable heights */
  dynamicHeight?: boolean;
  /** Gap between items in pixels */
  gap?: number;
}

export interface UseVirtualListResult<T> {
  /** Ref to attach to the scrollable container */
  parentRef: React.RefObject<HTMLDivElement>;
  /** Virtual items to render */
  virtualItems: Array<{
    index: number;
    key: React.Key;
    size: number;
    start: number;
    item: T;
  }>;
  /** Total height of all items */
  totalSize: number;
  /** Scroll to a specific index */
  scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void;
  /** Scroll to the end of the list */
  scrollToEnd: () => void;
  /** Measure element for dynamic heights */
  measureElement: (el: HTMLElement | null) => void;
}

/**
 * Hook for virtualizing a list of items
 */
export function useVirtualList<T>({
  items,
  estimateSize,
  overscan = 5,
  dynamicHeight = false,
  gap = 0,
}: UseVirtualListOptions<T>): UseVirtualListResult<T> {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizerOptions: Partial<VirtualizerOptions<HTMLDivElement, Element>> = {
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
    gap,
  };

  const virtualizer = useVirtualizer(virtualizerOptions as VirtualizerOptions<HTMLDivElement, Element>);

  const virtualItems = virtualizer.getVirtualItems().map((virtualItem) => ({
    index: virtualItem.index,
    key: virtualItem.key,
    size: virtualItem.size,
    start: virtualItem.start,
    item: items[virtualItem.index],
  }));

  const scrollToIndex = useCallback(
    (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => {
      virtualizer.scrollToIndex(index, options);
    },
    [virtualizer]
  );

  const scrollToEnd = useCallback(() => {
    virtualizer.scrollToIndex(items.length - 1, { align: "end" });
  }, [virtualizer, items.length]);

  const measureElement = useCallback(
    (el: HTMLElement | null) => {
      if (dynamicHeight && el) {
        virtualizer.measureElement(el);
      }
    },
    [virtualizer, dynamicHeight]
  );

  return {
    parentRef: parentRef as React.RefObject<HTMLDivElement>,
    virtualItems,
    totalSize: virtualizer.getTotalSize(),
    scrollToIndex,
    scrollToEnd,
    measureElement,
  };
}

/**
 * Hook specifically for chat messages with auto-scroll to bottom
 */
export function useVirtualMessages<T>(
  messages: T[],
  options: Omit<UseVirtualListOptions<T>, "items"> = { estimateSize: 100 }
) {
  const result = useVirtualList({
    items: messages,
    estimateSize: options.estimateSize ?? 100,
    overscan: options.overscan ?? 5,
    dynamicHeight: options.dynamicHeight ?? true,
    gap: options.gap ?? 16,
  });

  return result;
}
