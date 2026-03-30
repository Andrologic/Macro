import { describe, expect, it } from 'bun:test';
import {
  isStoredWindowStateCompatible,
  sanitizeWindowBounds,
  WINDOW_STATE_SCHEMA_VERSION,
  type MonitorBounds,
} from './windowBounds';

const primaryMonitor: MonitorBounds = {
  position: { x: 0, y: 0 },
  size: { width: 1728, height: 1117 },
  workArea: {
    position: { x: 0, y: 40 },
    size: { width: 1728, height: 1077 },
  },
};

const secondaryMonitor: MonitorBounds = {
  position: { x: 1728, y: 0 },
  size: { width: 1920, height: 1080 },
  workArea: {
    position: { x: 1728, y: 24 },
    size: { width: 1920, height: 1056 },
  },
};

describe('sanitizeWindowBounds', () => {
  it('keeps a valid window state within the chosen monitor bounds', () => {
    const bounds = sanitizeWindowBounds({
      requestedBounds: { x: 60, y: 72, width: 1200, height: 800 },
      monitors: [primaryMonitor, secondaryMonitor],
      fallbackMonitor: primaryMonitor,
      defaultSize: { width: 1200, height: 800 },
      platform: 'windows',
      chromeMode: 'frameless',
    });

    expect(bounds).toEqual({ x: 60, y: 72, width: 1200, height: 800 });
  });

  it('recenters an off-screen state onto the fallback monitor', () => {
    const bounds = sanitizeWindowBounds({
      requestedBounds: { x: 9000, y: 9000, width: 1200, height: 800 },
      monitors: [primaryMonitor],
      fallbackMonitor: primaryMonitor,
      defaultSize: { width: 1200, height: 800 },
      platform: 'windows',
      chromeMode: 'frameless',
    });

    expect(bounds).toEqual({ x: 528, y: 317, width: 1200, height: 800 });
  });

  it('clamps windows that are larger than the target monitor', () => {
    const bounds = sanitizeWindowBounds({
      requestedBounds: { x: 1728, y: 24, width: 3000, height: 2000 },
      monitors: [primaryMonitor, secondaryMonitor],
      fallbackMonitor: primaryMonitor,
      defaultSize: { width: 1200, height: 800 },
      platform: 'windows',
      chromeMode: 'frameless',
    });

    expect(bounds).toEqual({ x: 1728, y: 24, width: 1920, height: 1056 });
  });

  it('uses the full monitor area for frameless macOS windows', () => {
    const bounds = sanitizeWindowBounds({
      requestedBounds: { x: 0, y: 0, width: 1728, height: 1117 },
      monitors: [primaryMonitor],
      fallbackMonitor: primaryMonitor,
      defaultSize: { width: 1200, height: 800 },
      platform: 'macos',
      chromeMode: 'frameless',
    });

    expect(bounds).toEqual({ x: 0, y: 0, width: 1728, height: 1117 });
  });

  it('uses the work area for overlay macOS windows with a native title bar', () => {
    const bounds = sanitizeWindowBounds({
      requestedBounds: { x: 0, y: 0, width: 1728, height: 1117 },
      monitors: [primaryMonitor],
      fallbackMonitor: primaryMonitor,
      defaultSize: { width: 1200, height: 800 },
      platform: 'macos',
      chromeMode: 'overlay',
    });

    expect(bounds).toEqual({ x: 0, y: 40, width: 1728, height: 1077 });
  });

  it('uses the work area for decorated non-mac windows', () => {
    const bounds = sanitizeWindowBounds({
      requestedBounds: { x: 0, y: 0, width: 1728, height: 1117 },
      monitors: [primaryMonitor],
      fallbackMonitor: primaryMonitor,
      defaultSize: { width: 1200, height: 800 },
      platform: 'windows',
      chromeMode: 'decorated',
    });

    expect(bounds).toEqual({ x: 0, y: 40, width: 1728, height: 1077 });
  });
});

describe('isStoredWindowStateCompatible', () => {
  it('accepts a matching version, platform, and chrome mode', () => {
    expect(
      isStoredWindowStateCompatible(
        {
          version: WINDOW_STATE_SCHEMA_VERSION,
          platform: 'windows',
          chromeMode: 'frameless',
          isMaximized: false,
        },
        { platform: 'windows', chromeMode: 'frameless' }
      )
    ).toBe(true);
  });

  it('rejects unversioned and decorated-era macOS state', () => {
    expect(
      isStoredWindowStateCompatible(
        {
          version: null,
          platform: null,
          chromeMode: null,
          isMaximized: true,
        },
        { platform: 'macos', chromeMode: 'overlay' }
      )
    ).toBe(false);

    expect(
      isStoredWindowStateCompatible(
        {
          version: WINDOW_STATE_SCHEMA_VERSION,
          platform: 'macos',
          chromeMode: 'decorated',
          isMaximized: false,
        },
        { platform: 'macos', chromeMode: 'overlay' }
      )
    ).toBe(false);
  });

  it('rejects stale frameless macOS state after switching to overlay native title bar', () => {
    expect(
      isStoredWindowStateCompatible(
        {
          version: 2,
          platform: 'macos',
          chromeMode: 'frameless',
          isMaximized: false,
        },
        { platform: 'macos', chromeMode: 'overlay' }
      )
    ).toBe(false);
  });

  it('accepts the current overlay macOS schema', () => {
    expect(
      isStoredWindowStateCompatible(
        {
          version: WINDOW_STATE_SCHEMA_VERSION,
          platform: 'macos',
          chromeMode: 'overlay',
          isMaximized: false,
        },
        { platform: 'macos', chromeMode: 'overlay' }
      )
    ).toBe(true);
  });
});
