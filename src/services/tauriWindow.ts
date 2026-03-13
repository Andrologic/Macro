import { isTauriEnvironment } from '../utils/isTauriEnvironment';

type WindowSize = { width: number; height: number };
type WindowPosition = { x: number; y: number };

async function invokeWindow<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
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
