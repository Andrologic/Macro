import { expect, it, mock } from 'bun:test';
import { sanitizeWindowBounds } from './windowBounds';
const secondary = {
  position: { x: 1920, y: 0 },
  size: { width: 3840, height: 2160 },
  workArea: { position: { x: 1920, y: 40 }, size: { width: 3840, height: 2120 } },
  scaleFactor: 2,
};
mock.module('@tauri-apps/api/window', () => ({
  availableMonitors: async () => [
    { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } }, scaleFactor: 1 },
    secondary,
  ],
  currentMonitor: async () => secondary,
  primaryMonitor: async () => null,
}));
const { windowAvailableMonitorBounds, windowCurrentMonitorWorkArea } = await import('./tauriWindow');
it('keeps native monitor origins in a shared physical desktop space through sanitization', async () => {
  const monitors = await windowAvailableMonitorBounds();
  expect(monitors[1]).toEqual(secondary);
  expect(sanitizeWindowBounds({
    requestedBounds: { x: 2000, y: 100, width: 1000, height: 700 },
    monitors, fallbackMonitor: monitors[0], defaultSize: { width: 1200, height: 800 },
    platform: 'windows', chromeMode: 'frameless',
  })).toEqual({ x: 2000, y: 100, width: 1000, height: 700 });
});
it('converts fallback dimensions independently from their physical origin', async () => {
  expect(await windowCurrentMonitorWorkArea()).toEqual({ x: 1920, y: 40, width: 1920, height: 1060, scaleFactor: 2 });
});
