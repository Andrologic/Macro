import type { DesktopPlatform } from '../utils/desktopPlatform';

export const WINDOW_STATE_SCHEMA_VERSION = 3;
export type WindowChromeMode = 'frameless' | 'decorated' | 'overlay';

export interface WindowBounds {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface MonitorBounds {
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea: {
    position: { x: number; y: number };
    size: { width: number; height: number };
  };
}

export interface StoredWindowState extends Partial<WindowBounds> {
  isMaximized: boolean;
  version: number | null;
  chromeMode: WindowChromeMode | null;
  platform: DesktopPlatform | null;
}

interface WindowArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SanitizeWindowBoundsParams {
  requestedBounds: Partial<WindowBounds> | null;
  monitors: MonitorBounds[];
  fallbackMonitor: MonitorBounds | null;
  defaultSize: { width: number; height: number };
  platform: DesktopPlatform;
  chromeMode: WindowChromeMode;
}

const MIN_WINDOW_WIDTH = 640;
const MIN_WINDOW_HEIGHT = 480;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const getAllowedMonitorArea = (
  monitor: MonitorBounds,
  platform: DesktopPlatform,
  chromeMode: WindowChromeMode
): WindowArea =>
  platform === 'macos' && chromeMode === 'frameless'
    ? {
        x: monitor.position.x,
        y: monitor.position.y,
        width: monitor.size.width,
        height: monitor.size.height,
      }
    : {
        x: monitor.workArea.position.x,
        y: monitor.workArea.position.y,
        width: monitor.workArea.size.width,
        height: monitor.workArea.size.height,
      };

const containsPoint = (area: WindowArea, x: number, y: number): boolean =>
  x >= area.x &&
  y >= area.y &&
  x < area.x + area.width &&
  y < area.y + area.height;

const pickMonitorArea = (
  requestedBounds: Partial<WindowBounds> | null,
  monitors: MonitorBounds[],
  fallbackMonitor: MonitorBounds | null,
  platform: DesktopPlatform,
  chromeMode: WindowChromeMode
): WindowArea => {
  const availableAreas = monitors.map((monitor) =>
    getAllowedMonitorArea(monitor, platform, chromeMode)
  );

  const requestedX = requestedBounds?.x;
  const requestedY = requestedBounds?.y;
  if (isFiniteNumber(requestedX) && isFiniteNumber(requestedY)) {
    const directMatch = availableAreas.find((area) =>
      containsPoint(area, requestedX, requestedY)
    );
    if (directMatch) {
      return directMatch;
    }
  }

  if (fallbackMonitor) {
    return getAllowedMonitorArea(fallbackMonitor, platform, chromeMode);
  }

  if (availableAreas.length > 0) {
    return availableAreas[0];
  }

  return {
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
  };
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function sanitizeWindowBounds({
  requestedBounds,
  monitors,
  fallbackMonitor,
  defaultSize,
  platform,
  chromeMode,
}: SanitizeWindowBoundsParams): WindowBounds {
  const targetArea = pickMonitorArea(
    requestedBounds,
    monitors,
    fallbackMonitor,
    platform,
    chromeMode
  );

  const maxWidth = Math.max(targetArea.width, MIN_WINDOW_WIDTH);
  const maxHeight = Math.max(targetArea.height, MIN_WINDOW_HEIGHT);
  const preferredWidth =
    requestedBounds && isFiniteNumber(requestedBounds.width)
      ? requestedBounds.width
      : defaultSize.width;
  const preferredHeight =
    requestedBounds && isFiniteNumber(requestedBounds.height)
      ? requestedBounds.height
      : defaultSize.height;

  const width = clamp(preferredWidth, Math.min(MIN_WINDOW_WIDTH, maxWidth), maxWidth);
  const height = clamp(preferredHeight, Math.min(MIN_WINDOW_HEIGHT, maxHeight), maxHeight);
  const maxX = targetArea.x + Math.max(targetArea.width - width, 0);
  const maxY = targetArea.y + Math.max(targetArea.height - height, 0);

  const requestedX =
    requestedBounds && isFiniteNumber(requestedBounds.x)
      ? requestedBounds.x
      : Math.round(targetArea.x + (targetArea.width - width) / 2);
  const requestedY =
    requestedBounds && isFiniteNumber(requestedBounds.y)
      ? requestedBounds.y
      : Math.round(targetArea.y + (targetArea.height - height) / 2);

  return {
    width,
    height,
    x: clamp(requestedX, targetArea.x, maxX),
    y: clamp(requestedY, targetArea.y, maxY),
  };
}

export function isStoredWindowStateCompatible(
  state: StoredWindowState,
  runtime: { platform: DesktopPlatform; chromeMode: WindowChromeMode }
): boolean {
  return (
    state.version === WINDOW_STATE_SCHEMA_VERSION &&
    state.platform === runtime.platform &&
    state.chromeMode === runtime.chromeMode
  );
}
