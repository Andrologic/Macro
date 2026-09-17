import { expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
let maximized = false;
const listeners = new Set<() => void>();
let pendingRegistration: ((cleanup: () => void) => void) | undefined;
let deferRegistration = false;
mock.module('../services/tauriWindow', () => ({
  isTauriEnvironment: () => true,
  windowIsMaximized: async () => maximized,
  windowOnResized: async (listener: () => void) => {
    listeners.add(listener);
    const cleanup = () => { listeners.delete(listener); };
    if (deferRegistration) return new Promise<() => void>((resolve) => { pendingRegistration = () => resolve(cleanup); });
    return cleanup;
  },
  windowToggleMaximize: async () => { maximized = !maximized; for (const listener of listeners) listener(); },
  windowMaximize: async () => {}, windowUnmaximize: async () => {},
  windowMinimize: async () => {}, windowClose: async () => {}, windowStartDragging: async () => {},
}));
const { useTauriWindow } = await import('./useTauriWindow');
it('synchronizes separate hook instances after a native maximize and restores in one click', async () => {
  const root = createRoot(document.createElement('div'));
  let first!: ReturnType<typeof useTauriWindow>;
  let second!: ReturnType<typeof useTauriWindow>;
  function Probe() { first = useTauriWindow(); second = useTauriWindow(); return null; }
  await act(async () => root.render(<Probe />));
  await act(async () => { maximized = true; for (const listener of listeners) listener(); });
  expect(first.isMaximized).toBe(true);
  expect(second.isMaximized).toBe(true);
  await act(async () => second.toggleMaximize());
  expect(maximized).toBe(false);
  expect(first.isMaximized).toBe(false);
  await act(async () => root.unmount());
  expect(listeners.size).toBe(0);
});
it('releases a late resize subscription after unmount', async () => {
  deferRegistration = true;
  const root = createRoot(document.createElement('div'));
  function Probe() { useTauriWindow(); return null; }
  await act(async () => root.render(<Probe />));
  await act(async () => root.unmount());
  await act(async () => pendingRegistration?.(() => {}));
  expect(listeners.size).toBe(0);
});
