import { afterEach, describe, expect, it } from 'bun:test';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useVirtualMessages, type UseVirtualListResult } from './useVirtualList';

type Row = { id: string; height: number };
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let result: UseVirtualListResult<Row>;
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

function Harness({ rows, viewport = 600 }: { rows: Row[]; viewport?: number }) {
  const list = useVirtualMessages(rows, { getItemKey: (row) => row.id, estimateSize: 100, gap: 16 });
  const { parentRef, virtualItems, measureElement } = list;
  useLayoutEffect(() => { result = list; }, [list]);
  useLayoutEffect(() => {
    if (parentRef.current) {
      Object.defineProperty(parentRef.current, 'offsetHeight', { configurable: true, value: viewport });
      Object.defineProperty(parentRef.current, 'scrollHeight', { configurable: true, value: rows.length * 116 });
    }
  }, [parentRef, rows.length, viewport]);
  return <div ref={parentRef}>{virtualItems.map((row) => (
    <div key={row.key} data-index={row.index} data-id={row.item.id}
      data-height={row.item.height} ref={measureElement}>{row.item.id}</div>
  ))}</div>;
}

async function render(rows: Row[], viewport = 600) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true, get() { return Number(this.getAttribute('data-height') ?? 600); },
    });
  }
  await act(async () => { root!.render(<Harness rows={rows} viewport={viewport} />); });
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove(); host = null; root = null;
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
});

describe('useVirtualMessages with the real virtualizer', () => {
  it('keeps measured heights and DOM identity across insertion and removal', async () => {
    const a = { id: 'a', height: 80 };
    const b = { id: 'b', height: 170 };
    await render([a, b]);
    const bNode = host!.querySelector('[data-id="b"]');
    expect(result.virtualItems.map((row) => [row.key, row.size])).toEqual([['a', 80], ['b', 170]]);
    await render([{ id: 'compaction', height: 48 }, a, b]);
    expect(host!.querySelector('[data-id="b"]')).toBe(bNode);
    expect(result.virtualItems.map((row) => [row.key, row.size])).toEqual([
      ['compaction', 48], ['a', 80], ['b', 170],
    ]);
    await render([b]);
    expect(host!.querySelector('[data-id="b"]')).toBe(bNode);
    expect(result.virtualItems.map((row) => [row.key, row.size])).toEqual([['b', 170]]);
  });

  it('mounts a bounded window and reaches old and recent rows by scrolling', async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: `row-${i}`, height: 100 }));
    await render(rows);
    expect(host!.querySelectorAll('[data-index]').length).toBeLessThan(25);
    expect(host!.querySelector('[data-id="row-0"]')).not.toBeNull();
    const parent = result.parentRef.current!;
    parent.scrollTo = (options) => {
      if (typeof options === 'object') parent.scrollTop = options.top ?? 0;
      parent.dispatchEvent(new Event('scroll'));
    };
    await act(async () => { result.scrollToEnd(); });
    expect(host!.querySelectorAll('[data-index]').length).toBeLessThan(25);
    expect(host!.querySelector('[data-id="row-9999"]')).not.toBeNull();
    await act(async () => { result.scrollToIndex(0, { align: 'start' }); });
    expect(host!.querySelector('[data-id="row-0"]')).not.toBeNull();
    expect(rows).toHaveLength(10_000);
  });
});
