import { expect, test } from 'bun:test';
import { createModePanelLoader, type ModePanelComponent } from './panelLoader';

test('an invalidated panel import cannot replace a newer component or reset its request', async () => {
  let resolveOld!: (component: ModePanelComponent) => void;
  let resolveNew!: (component: ModePanelComponent) => void;
  let call = 0;
  const loader = createModePanelLoader({ id: 'test', label: 'test', mode: 'Chat', panel: 'center',
    importComponent: () => new Promise((resolve) => { if (++call === 1) resolveOld = resolve; else resolveNew = resolve; }),
  });
  const old = loader.load();
  loader.reset();
  const next = loader.load();
  const Old = () => null;
  const New = () => null;
  resolveNew(New);
  await next;
  resolveOld(Old);
  await old;
  expect(loader.getCachedComponent()).toBe(New);
});
