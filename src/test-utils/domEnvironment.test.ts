import { expect, it } from 'bun:test';

it('keeps an observed mutation callback alive after garbage collection', async () => {
  const node = document.createElement('div');
  document.body.appendChild(node);
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((mutations) => records.push(...mutations));
  observer.observe(node, { childList: true });
  try {
    // WeakRef targets are retained within the current job, so yield before GC.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
    node.appendChild(document.createElement('span'));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('childList');
  } finally {
    observer.disconnect();
    node.remove();
  }
});
