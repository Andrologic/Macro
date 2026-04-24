import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let isolatedImportCounter = 0;

const storeDeleteMock = mock(async (_key: string) => undefined);
const storeSaveMock = mock(async () => undefined);
const storeSetMock = mock(async (_key: string, _value: unknown) => undefined);
const storeGetMock = mock(async (_key: string) => null);
const storeClearMock = mock(async () => undefined);
const loadStoreMock = mock(async (_path: string) => ({
  delete: storeDeleteMock,
  save: storeSaveMock,
  set: storeSetMock,
  get: storeGetMock,
  clear: storeClearMock,
}));

mock.module('@tauri-apps/plugin-store', () => ({
  load: (path: string) => loadStoreMock(path),
  Store: class Store {},
}));

const loadPreferencesModule = async () => {
  isolatedImportCounter += 1;
  return import(`./preferences.ts?legacy=${isolatedImportCounter}`);
};

const setTauriAvailability = (enabled: boolean) => {
  if (enabled) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    return;
  }

  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
};

describe('preferences legacy cleanup', () => {
  beforeEach(() => {
    storeDeleteMock.mockClear();
    storeSaveMock.mockClear();
    storeSetMock.mockClear();
    storeGetMock.mockClear();
    storeClearMock.mockClear();
    loadStoreMock.mockClear();
    setTauriAvailability(true);
  });

  afterEach(() => {
    setTauriAvailability(false);
  });

  it('purges the legacy implement execution mode preference from localStorage and the Tauri store', async () => {
    localStorage.setItem('macro_implementExecutionMode', JSON.stringify('full_auto'));

    const { purgeLegacyImplementExecutionModePreference } = await loadPreferencesModule();

    await purgeLegacyImplementExecutionModePreference();

    expect(localStorage.getItem('macro_implementExecutionMode')).toBeNull();
    expect(loadStoreMock).toHaveBeenCalledWith('preferences.json');
    expect(storeDeleteMock).toHaveBeenCalledWith('implementExecutionMode');
    expect(storeSaveMock).toHaveBeenCalledTimes(1);
  });

  it('migrates the legacy architect autonomy preference to the new tool risk level', async () => {
    localStorage.setItem('macro_architectToolAutonomyProfile', JSON.stringify('full'));

    const { loadPreference, PREF_KEYS } = await loadPreferencesModule();

    const value = await loadPreference(PREF_KEYS.TOOL_RISK_LEVEL);

    expect(value).toBe('balanced');
    expect(localStorage.getItem('macro_toolRiskLevel')).toBe(JSON.stringify('balanced'));
    expect(localStorage.getItem('macro_architectToolAutonomyProfile')).toBeNull();
  });
});
