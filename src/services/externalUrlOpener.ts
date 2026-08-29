import { openUrl as nativeOpenUrl } from '@tauri-apps/plugin-opener';
import { isTauriAvailable } from './tauriIpc';
import { invoke, isBrowserRuntimeBridgeEnabled } from './tauriRuntimeBridge';

export const openExternalUrl = async (url: string): Promise<void> => {
  if (isTauriAvailable()) {
    if (isBrowserRuntimeBridgeEnabled()) {
      await invoke('plugin:opener|open_url', { url });
    } else {
      await nativeOpenUrl(url);
    }
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
};
