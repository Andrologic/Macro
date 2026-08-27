import { open as nativeOpen, type OpenDialogOptions } from '@tauri-apps/plugin-dialog';
import { invoke, isBrowserRuntimeBridgeEnabled } from './tauriRuntimeBridge';

export async function open(
  options: OpenDialogOptions & { multiple: true },
): Promise<string[] | null>;
export async function open(
  options?: OpenDialogOptions,
): Promise<string | null>;
export async function open(
  options: OpenDialogOptions = {},
): Promise<string | string[] | null> {
  if (!isBrowserRuntimeBridgeEnabled()) return nativeOpen(options);
  return invoke('plugin:dialog|open', { options });
}
