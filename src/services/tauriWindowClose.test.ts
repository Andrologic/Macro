import { afterEach, expect, it, mock } from 'bun:test';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { emit, TauriEvent } from '@tauri-apps/api/event';
import { windowOnCloseRequested } from './tauriWindow';

afterEach(() => clearMocks());
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

it('uses the real Tauri SDK to await the handler and honor preventDefault across cleanup', async () => {
  const invoke = mock(() => undefined);
  mockIPC(invoke, { shouldMockEvents: true });
  mockWindows('main');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const handler = mock(async (event: { preventDefault(): void }) => {
    event.preventDefault();
    await pending;
  });
  const unlisten = await windowOnCloseRequested(handler);
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  await tick();
  expect(handler).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
  release();
  await tick();
  expect(invoke).not.toHaveBeenCalled();
  unlisten();
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  expect(handler).toHaveBeenCalledTimes(1);
  const unlistenNext = await windowOnCloseRequested(async () => undefined);
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  await tick();
  expect(invoke).toHaveBeenCalledWith('plugin:window|destroy', { label: 'main' });
  unlistenNext();
});
