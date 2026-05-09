import { isTauriEnvironment } from '../utils/isTauriEnvironment';

type WindowSize = { width: number; height: number };
type WindowPosition = { x: number; y: number };
export type WindowWorkArea = WindowSize & WindowPosition;
export type WindowCloseRequestedListener = () => void | Promise<void>;

async function invokeWindow<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

async function getCurrentTauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

async function getLogicalMonitorWorkArea(
  readMonitor: () => Promise<{
    workArea: {
      position: { x: number; y: number };
      size: { width: number; height: number };
    };
    scaleFactor: number;
  } | null>
): Promise<WindowWorkArea | null> {
  const monitor = await readMonitor();
  if (!monitor) {
    return null;
  }

  const scaleFactor = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
  return {
    x: Math.round(monitor.workArea.position.x / scaleFactor),
    y: Math.round(monitor.workArea.position.y / scaleFactor),
    width: Math.round(monitor.workArea.size.width / scaleFactor),
    height: Math.round(monitor.workArea.size.height / scaleFactor),
  };
}

const backgroundColorPermissionFailures = new Set<string>();
const windowThemePermissionFailures = new Set<string>();

const isBackgroundColorPermissionError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('window.set_background_color not allowed');
};

const isWindowThemePermissionError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('window.set_theme not allowed');
};

const logBackgroundColorPermissionOnce = (message: string) => {
  if (backgroundColorPermissionFailures.has(message)) {
    return;
  }
  backgroundColorPermissionFailures.add(message);
  console.warn('[tauriWindow] Background color update skipped:', message);
};

const logWindowThemePermissionOnce = (message: string) => {
  if (windowThemePermissionFailures.has(message)) {
    return;
  }
  windowThemePermissionFailures.add(message);
  console.warn('[tauriWindow] Native window theme update skipped:', message);
};

export { isTauriEnvironment };

export async function showMainWindow(): Promise<void> {
  await invokeWindow<void>('show_main_window');
}

export async function windowClose(): Promise<void> {
  await invokeWindow<void>('window_close');
}

export async function windowMinimize(): Promise<void> {
  await invokeWindow<void>('window_minimize');
}

export async function windowMaximize(): Promise<void> {
  await invokeWindow<void>('window_maximize');
}

export async function windowUnmaximize(): Promise<void> {
  await invokeWindow<void>('window_unmaximize');
}

export async function windowToggleMaximize(): Promise<void> {
  await invokeWindow<void>('window_toggle_maximize');
}

export async function windowIsMaximized(): Promise<boolean> {
  return invokeWindow<boolean>('window_is_maximized');
}

export async function windowIsFullscreen(): Promise<boolean> {
  const window = await getCurrentTauriWindow();
  return window.isFullscreen();
}

export async function windowSetSize(width: number, height: number): Promise<void> {
  await invokeWindow<void>('window_set_size', { width, height });
}

export async function windowSetPosition(x: number, y: number): Promise<void> {
  await invokeWindow<void>('window_set_position', { x, y });
}

export async function windowOuterSize(): Promise<WindowSize> {
  return invokeWindow<WindowSize>('window_outer_size');
}

export async function windowOuterPosition(): Promise<WindowPosition> {
  return invokeWindow<WindowPosition>('window_outer_position');
}

export async function windowScaleFactor(): Promise<number> {
  return invokeWindow<number>('window_scale_factor');
}

export async function windowCurrentMonitorWorkArea(): Promise<WindowWorkArea | null> {
  const { currentMonitor } = await import('@tauri-apps/api/window');
  return getLogicalMonitorWorkArea(() => currentMonitor());
}

export async function windowPrimaryMonitorWorkArea(): Promise<WindowWorkArea | null> {
  const { primaryMonitor } = await import('@tauri-apps/api/window');
  return getLogicalMonitorWorkArea(() => primaryMonitor());
}

export async function windowSetZoom(scale: number): Promise<void> {
  await invokeWindow<void>('window_set_zoom', { scale });
}

export async function windowSetTrafficLightPosition(
  x: number,
  y: number
): Promise<void> {
  await invokeWindow<void>('window_set_traffic_light_position', { x, y });
}

export async function windowSetBackgroundColor(color: string): Promise<void> {
  const window = await getCurrentTauriWindow();
  try {
    await window.setBackgroundColor(color);
  } catch (error) {
    if (isBackgroundColorPermissionError(error)) {
      logBackgroundColorPermissionOnce(error instanceof Error ? error.message : String(error));
      return;
    }
    throw error;
  }
}

export async function windowSetTheme(theme: 'light' | 'dark' | null): Promise<void> {
  const window = await getCurrentTauriWindow();
  try {
    await window.setTheme(theme);
  } catch (error) {
    if (isWindowThemePermissionError(error)) {
      logWindowThemePermissionOnce(error instanceof Error ? error.message : String(error));
      return;
    }
    throw error;
  }
}

export async function windowStartDragging(): Promise<void> {
  const window = await getCurrentTauriWindow();
  await window.startDragging();
}

export async function windowOnResized(listener: () => void): Promise<() => void> {
  const window = await getCurrentTauriWindow();
  return window.onResized(() => listener());
}

export async function windowOnMoved(listener: () => void): Promise<() => void> {
  const window = await getCurrentTauriWindow();
  return window.onMoved(() => listener());
}

export async function windowOnScaleChanged(listener: () => void): Promise<() => void> {
  const window = await getCurrentTauriWindow();
  return window.onScaleChanged(() => listener());
}

export async function windowOnFocusChanged(
  listener: (focused: boolean) => void
): Promise<() => void> {
  const window = await getCurrentTauriWindow();
  return window.onFocusChanged(({ payload }) => listener(payload));
}

export async function windowOnCloseRequested(
  listener: WindowCloseRequestedListener
): Promise<() => void> {
  const window = await getCurrentTauriWindow();
  return window.onCloseRequested(() => listener());
}
