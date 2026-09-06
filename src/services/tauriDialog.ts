import {
  open as nativeOpen,
  save as nativeSave,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from '@tauri-apps/plugin-dialog';
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

export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
  if (!isBrowserRuntimeBridgeEnabled()) return nativeSave(options);
  return invoke<string | null>('plugin:dialog|save', { options });
}
