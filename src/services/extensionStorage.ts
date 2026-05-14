import { PREF_KEYS, loadPreference, savePreference, type PrefKey } from './preferences';

type ExtensionPreferenceKey =
  | typeof PREF_KEYS.EXTENSION_INSTALLS
  | typeof PREF_KEYS.EXTENSION_TRUST_GRANTS
  | typeof PREF_KEYS.EXTENSION_TRUST_DECISIONS;

const localStorageKey = (key: PrefKey): string => `macro_${key}`;

export const hasBrowserExtensionStorage = (): boolean =>
  typeof globalThis.localStorage !== 'undefined';

export const readBrowserExtensionPreference = <TValue>(
  key: ExtensionPreferenceKey,
): TValue | null => {
  if (!hasBrowserExtensionStorage()) return null;

  try {
    const raw = globalThis.localStorage.getItem(localStorageKey(key));
    return raw ? (JSON.parse(raw) as TValue) : null;
  } catch {
    return null;
  }
};

export const loadExtensionPreference = async <TValue>(
  key: ExtensionPreferenceKey,
): Promise<TValue | null> => {
  const browserValue = readBrowserExtensionPreference<TValue>(key);
  if (browserValue !== null) return browserValue;
  if (!hasBrowserExtensionStorage()) return null;
  return await loadPreference<TValue>(key);
};

export const saveExtensionPreference = <TValue>(
  key: ExtensionPreferenceKey,
  value: TValue,
): void => {
  if (!hasBrowserExtensionStorage()) return;

  try {
    globalThis.localStorage.setItem(localStorageKey(key), JSON.stringify(value));
  } catch {
    // Store plugin persistence below is best effort as well.
  }
  void savePreference(key, value);
};

export const cloneExtensionJson = <TValue>(value: TValue): TValue =>
  JSON.parse(JSON.stringify(value)) as TValue;
