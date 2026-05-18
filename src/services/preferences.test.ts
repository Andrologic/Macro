import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';

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
    installTauriRuntimeMock();
    return;
  }

  removeTauriRuntimeMock();
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

  it('falls back to the default chat max turns when the stored value is invalid', async () => {
    localStorage.setItem('macro_chatMaxTurns', JSON.stringify(99));

    const { loadPreference, PREF_KEYS } = await loadPreferencesModule();

    const value = await loadPreference(PREF_KEYS.CHAT_MAX_TURNS);

    expect(value).toBe(50);
  });

  it('preserves null chat max turns as the disabled limit preference', async () => {
    localStorage.setItem('macro_chatMaxTurns', JSON.stringify(null));

    const { loadPreference, PREF_KEYS } = await loadPreferencesModule();

    const value = await loadPreference(PREF_KEYS.CHAT_MAX_TURNS);

    expect(value).toBeNull();
  });

  it('keeps Architect action plans concise by default', async () => {
    const { getDefaultPromptForPreferenceKey, PREF_KEYS } = await loadPreferencesModule();

    const prompt = getDefaultPromptForPreferenceKey(PREF_KEYS.PROMPT_ARCHITECT);

    expect(prompt).toContain('When the user asks for an action plan');
    expect(prompt).toContain('Prefer 3-5 short sections or bullets');
    expect(prompt).toContain('Do not create a "Finalize plan" strategy node yourself');
  });

  it('notifies same-window subscribers once for an immediate preference save', async () => {
    const { PREF_KEYS, savePreference, subscribePreference } = await loadPreferencesModule();
    const listener = mock((_value: unknown) => undefined);
    const unsubscribe = subscribePreference(PREF_KEYS.METADATA_MODEL_CONFIG, listener);

    await savePreference(PREF_KEYS.METADATA_MODEL_CONFIG, { mode: 'conversation' });

    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ mode: 'conversation' }, PREF_KEYS.METADATA_MODEL_CONFIG);
  });

  it('does not emit a second same-window notification when a debounced save flushes to the store', async () => {
    const {
      PREF_KEYS,
      savePreferenceDebounced,
      subscribePreference,
    } = await loadPreferencesModule();
    const listener = mock((_value: unknown) => undefined);
    const unsubscribe = subscribePreference(PREF_KEYS.METADATA_MODEL_CONFIG, listener);

    savePreferenceDebounced(
      PREF_KEYS.METADATA_MODEL_CONFIG,
      { mode: 'conversation' },
      1
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storeSetMock).toHaveBeenCalledWith(
      PREF_KEYS.METADATA_MODEL_CONFIG,
      { mode: 'conversation' }
    );
  });
});
