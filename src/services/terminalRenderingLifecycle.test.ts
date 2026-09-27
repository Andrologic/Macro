import { expect, it, mock } from 'bun:test';
import { createTerminalRenderingLifecycle } from './terminalRenderingLifecycle';

it('routes cleanup only to the renderer acquired by the current application', () => {
  const rendering = createTerminalRenderingLifecycle();
  const previous = rendering.install();
  previous.disposeTab('unrendered');
  previous.disposeAll();
  const renderer = { disposeTab: mock(() => undefined), disposeAll: mock(() => undefined) };
  expect(rendering.acquire(renderer)).toBe(true);
  previous.disposeTab('closed');
  expect(renderer.disposeTab).toHaveBeenCalledWith('closed');
  const next = rendering.install();
  expect(renderer.disposeAll).toHaveBeenCalledTimes(1);
  expect(rendering.acquire(renderer)).toBe(true);
  previous.disposeTab('stale');
  previous.stop();
  expect(renderer.disposeTab).toHaveBeenCalledTimes(1);
  expect(renderer.disposeAll).toHaveBeenCalledTimes(1);
  next.stop();
  next.stop();
  expect(renderer.disposeAll).toHaveBeenCalledTimes(2);
});
