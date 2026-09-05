import * as ipc from './tauriIpc';

const CLIENT_KEYS = new Set(['macro_chat_message_images', 'macro_chat_composer_drafts_v1', 'macro_chat_questionnaire_drafts']);
const included = (key: string): boolean => CLIENT_KEYS.has(key) || key.startsWith('agentCodeCheckpoints:') || key.startsWith('agentCodeReplayRecovery:');
export const captureBackupBrowserState = (): Record<string, string> => {
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key && included(key)) entries.push([key, localStorage.getItem(key)!]);
  }
  return Object.fromEntries(entries);
};

/** Apply before Chat hydration. A quota failure restores every original browser value. */
export const applyBackupBrowserState = (browser: Record<string, string>): void => {
  if (Object.entries(browser).some(([key, value]) => !included(key) || typeof value !== 'string')) throw new Error('Invalid backup browser state');
  const previous = captureBackupBrowserState();
  const replace = (values: Record<string, string>): void => {
    Object.keys(captureBackupBrowserState()).forEach((key) => localStorage.removeItem(key));
    Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, value));
  };
  try { replace(browser); } catch (error) {
    replace(previous);
    throw error;
  }
};

export const restoreBackupBrowserState = async (): Promise<void> => {
  if (!ipc.isTauriAvailable()) return;
  const status = await ipc.localBackupStatus();
  if (status.browser !== null) {
    applyBackupBrowserState(status.browser);
    await ipc.localBackupAcknowledge();
  }
};
