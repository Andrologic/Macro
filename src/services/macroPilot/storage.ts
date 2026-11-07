import { dbCompareAndSwapAppSetting, dbGetAppSetting } from '../tauriIpc';
import type { KernelStorage } from './kernel';

/** Uses Macro's existing local metadata database, with atomic revision fencing. */
export function pilotKernelStorage(configurationId: string, instanceId: string): KernelStorage {
  const key = `macroPilot:supervision:v1:${JSON.stringify([configurationId, instanceId])}`;
  return {
    load: async () => (await dbGetAppSetting(key))?.value_json ?? null,
    compareAndSwap: async (previous, next) => (await dbCompareAndSwapAppSetting({ key, expectedValueJson: previous, valueJson: next })).applied,
  };
}
