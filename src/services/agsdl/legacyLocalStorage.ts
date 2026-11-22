export const LOCAL_INDEX_KEY_PREFIX = 'macro_architect_plan_index';
export const LOCAL_PLAN_KEY_PREFIX = 'macro_architect_plan';
export const LOCAL_PLAN_CHAT_KEY_PREFIX = 'macro_architect_plan_chat';

export type LegacyLocalStorageSnapshot =
  | { state: 'snapshot'; value: Record<string, string> }
  | { state: 'unavailable'; value: string };

const prefixes = [LOCAL_INDEX_KEY_PREFIX, LOCAL_PLAN_KEY_PREFIX, LOCAL_PLAN_CHAT_KEY_PREFIX]
  .map((prefix) => `${prefix}:`);

/** Capture the old origin's plan records without opening the Architect catalog. */
export function snapshotLegacyLocalStorage(
  storage?: Pick<Storage, 'length' | 'key' | 'getItem'>,
): LegacyLocalStorageSnapshot {
  try {
    const source = storage ?? globalThis.localStorage;
    if (!source) throw new Error('Legacy local storage is unavailable.');
    const length = source.length;
    const entries: Array<[string, string]> = [];
    for (let index = 0; index < length; index++) {
      const key = source.key(index);
      if (key === null) throw new Error('Legacy local storage changed during migration.');
      if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
      const value = source.getItem(key);
      if (value === null) throw new Error('Legacy local storage changed during migration.');
      entries.push([key, value]);
    }
    if (source.length !== length) throw new Error('Legacy local storage changed during migration.');
    return { state: 'snapshot', value: Object.fromEntries(entries) };
  } catch (error) {
    return { state: 'unavailable', value: String(error) };
  }
}
