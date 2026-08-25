import { openUrl as tauriOpenUrl } from '@tauri-apps/plugin-opener';
import { isTauriAvailable } from './tauriIpc';

export const openExternalUrl = async (url: string): Promise<void> => {
  if (isTauriAvailable()) {
    await tauriOpenUrl(url);
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
};
