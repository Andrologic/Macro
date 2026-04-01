import { isTauriEnvironment } from '../utils/isTauriEnvironment';
import type { MacosDynamicAppIconThemeSpec } from '../hooks/dynamicAppIconRenderer';

type WindowSize = { width: number; height: number };
type WindowPosition = { x: number; y: number };

async function invokeWindow<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

async function getCurrentTauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

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
  await window.setBackgroundColor(color);
}

export async function windowSetMacosAppIconTheme(
  spec: MacosDynamicAppIconThemeSpec
): Promise<void> {
  await invokeWindow<void>('set_macos_app_icon_theme', { spec });
}

export async function windowSetTheme(theme: 'light' | 'dark' | null): Promise<void> {
  const window = await getCurrentTauriWindow();
  await window.setTheme(theme);
}

export async function windowStartDragging(): Promise<void> {
  const window = await getCurrentTauriWindow();
  await window.startDragging();
}
