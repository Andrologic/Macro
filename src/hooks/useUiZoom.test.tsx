import { afterEach, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

let mode: 'auto' | 'override' = 'override';
let level = 1.5;
const setZoom = mock(async (_scale: number) => {});
mock.module('../stores/useAppStore', () => ({
  useAppStore: (select: (state: { uiZoomMode: string; uiZoomLevel: number }) => unknown) => select({ uiZoomMode: mode, uiZoomLevel: level }),
}));
mock.module('../services/tauriWindow', () => ({ isTauriEnvironment: () => true, windowSetZoom: setZoom }));
mock.module('../utils/pageLifecycle', () => ({ isPageShuttingDown: () => false }));
let counter = 0;
afterEach(() => { document.documentElement.style.fontSize = ''; });

it('clears CSS fallback after native recovery, return to a cached scale, and automatic mode', async () => {
  const { useUiZoom } = await import(`./useUiZoom.ts?test=${++counter}`);
  const container = document.createElement('div');
  const root = createRoot(container);
  function Probe() { useUiZoom(); return null; }
  document.documentElement.style.fontSize = '18px';
  setZoom.mockRejectedValueOnce(new Error('synthetic IPC failure'));
  await act(async () => root.render(<Probe />));
  expect(document.documentElement.style.fontSize).toBe('24px');
  level = 2;
  await act(async () => root.render(<Probe />));
  expect(setZoom).toHaveBeenLastCalledWith(2);
  expect(document.documentElement.style.fontSize).toBe('18px');
  level = 1.5;
  setZoom.mockRejectedValueOnce(new Error('synthetic IPC failure'));
  await act(async () => root.render(<Probe />));
  expect(document.documentElement.style.fontSize).toBe('12px');
  level = 2;
  await act(async () => root.render(<Probe />));
  expect(document.documentElement.style.fontSize).toBe('18px');
  mode = 'auto';
  await act(async () => root.render(<Probe />));
  expect(setZoom).toHaveBeenLastCalledWith(1);
  expect(document.documentElement.style.fontSize).toBe('18px');
  await act(async () => root.unmount());
});
