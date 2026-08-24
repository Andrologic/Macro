import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { useConfigStore } from '../stores/useConfigStore';
import type { ConfigSnapshot } from '../types/generated/config';

type StoreListener<T> = (state: T, previousState: T) => void;

const createMockStore = <T extends object>(initialState: T) => {
  let state = initialState;
  const listeners = new Set<StoreListener<T>>();
  const store = {
    getState: () => state,
    setState: (update: Partial<T>) => {
      const previousState = state;
      state = { ...state, ...update };
      listeners.forEach((listener) => listener(state, previousState));
    },
    subscribe: (listener: StoreListener<T>) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      state = initialState;
      listeners.clear();
    },
    listenerCount: () => listeners.size,
  };
  return store;
};

const loadProviderConfigs = mock(async () => undefined);
const loadToolSettings = mock(async () => undefined);
const refreshSkills = mock(async () => undefined);
const refreshWebSearchSettings = mock(async () => undefined);
const applyConfiguredLanguage = mock(async () => undefined);
const resolveSupportedLanguage = mock((language: string) => language);
const translate = mock(() => 'Could not save configuration');
const notifyError = mock(() => undefined);

const appStore = createMockStore({
  activeThemeId: 'macro-dark',
  uiZoomMode: 'auto',
  uiZoomLevel: 1,
  codeOverflowMode: 'wrap',
  inAppNotificationsEnabled: true,
  notificationChannelModes: { agent: 'both' },
});
const providerStore = createMockStore({ loadProviderConfigs });
const toolsStore = createMockStore({ loadSettings: loadToolSettings });
const skillsStore = createMockStore({ refreshSkills });

type PersistenceErrorListener = (error: unknown, key: string) => void;
const persistenceErrorListeners = new Set<PersistenceErrorListener>();
const persistenceUnsubscribes: Array<ReturnType<typeof mock>> = [];
const subscribePreferencePersistenceErrors = mock((listener: PersistenceErrorListener) => {
  persistenceErrorListeners.add(listener);
  const unsubscribe = mock(() => persistenceErrorListeners.delete(listener));
  persistenceUnsubscribes.push(unsubscribe);
  return unsubscribe;
});

mock.module('../i18n', () => ({
  default: { t: translate },
  applyConfiguredLanguage,
  resolveSupportedLanguage,
}));
mock.module('../components/ui/toastService', () => ({
  notify: { error: notifyError },
}));
mock.module('../stores/useAppStore', () => ({ useAppStore: appStore }));
mock.module('../stores/useProviderStore', () => ({ useProviderStore: providerStore }));
mock.module('../stores/useToolsStore', () => ({ useToolsStore: toolsStore }));
mock.module('../stores/useSkillsStore', () => ({ useSkillsStore: skillsStore }));
mock.module('./preferences', () => ({ subscribePreferencePersistenceErrors }));
mock.module('./webSearchSettings', () => ({ refreshWebSearchSettings }));

const {
  disposeConfigRuntimeEffectsForTests,
  installConfigRuntimeEffects,
} = await import('./configRuntimeEffects');

const originalConfigState = useConfigStore.getState();

const snapshot = (effective: Record<string, unknown>): ConfigSnapshot => ({
  schemaVersion: 1,
  effective,
  projectEffective: {},
  documents: [],
  provenance: [],
  diagnostics: [],
  pendingRestartPaths: [],
});

const initialSnapshot = snapshot({
  settings: { language: 'en', appearance: { theme: 'macro-dark' } },
  providers: { default: 'openai' },
  tools: { riskLevel: 'balanced' },
  skills: { directories: [] },
});

const clearMockCalls = () => {
  loadProviderConfigs.mockClear();
  loadToolSettings.mockClear();
  refreshSkills.mockClear();
  refreshWebSearchSettings.mockClear();
  applyConfiguredLanguage.mockClear();
  resolveSupportedLanguage.mockClear();
  translate.mockClear();
  notifyError.mockClear();
  subscribePreferencePersistenceErrors.mockClear();
};

describe('configRuntimeEffects', () => {
  beforeEach(() => {
    disposeConfigRuntimeEffectsForTests();
    persistenceErrorListeners.clear();
    persistenceUnsubscribes.length = 0;
    appStore.reset();
    useConfigStore.setState({ ...originalConfigState, snapshot: null }, true);
    providerStore.reset();
    toolsStore.reset();
    skillsStore.reset();
    clearMockCalls();
  });

  afterEach(() => {
    disposeConfigRuntimeEffectsForTests();
    expect(persistenceErrorListeners.size).toBe(0);
    useConfigStore.setState(originalConfigState, true);
  });

  afterAll(() => {
    mock.restore();
  });

  it('applies the first hydrated snapshot after installation at cold start', () => {
    installConfigRuntimeEffects();

    useConfigStore.setState({
      snapshot: snapshot({
        settings: { language: 'fr', appearance: { theme: 'light' } },
        providers: { default: 'anthropic' },
        tools: { riskLevel: 'strict' },
        skills: { directories: ['C:/skills'] },
      }),
    });

    expect(appStore.getState()).toMatchObject({
      activeThemeId: 'light',
      uiZoomMode: 'auto',
      uiZoomLevel: 1,
      codeOverflowMode: 'wrap',
      inAppNotificationsEnabled: true,
      notificationChannelModes: { agent: 'both' },
    });
    expect(applyConfiguredLanguage).toHaveBeenCalledWith('fr');
    expect(loadProviderConfigs).toHaveBeenCalledTimes(1);
    expect(loadToolSettings).toHaveBeenCalledTimes(1);
    expect(refreshWebSearchSettings).toHaveBeenCalledTimes(1);
    expect(refreshSkills).toHaveBeenCalledTimes(1);
  });

  it('applies changed settings without reloading unrelated documents', () => {
    useConfigStore.setState({ snapshot: initialSnapshot });
    installConfigRuntimeEffects();

    useConfigStore.setState({
      snapshot: snapshot({
        ...initialSnapshot.effective,
        settings: {
          language: 'fr',
          appearance: { theme: 'light', zoomMode: 'override', zoomLevel: 1.25 },
          code: { overflowMode: 'horizontal_scroll' },
          notifications: {
            inAppEnabled: false,
            channelModes: { agent: 'in_app', system: 'desktop' },
          },
        },
      }),
    });

    expect(appStore.getState()).toMatchObject({
      activeThemeId: 'light',
      uiZoomMode: 'override',
      uiZoomLevel: 1.25,
      codeOverflowMode: 'horizontal_scroll',
      inAppNotificationsEnabled: false,
      notificationChannelModes: { agent: 'in_app', system: 'desktop' },
    });
    expect(resolveSupportedLanguage).toHaveBeenCalledWith('fr');
    expect(applyConfiguredLanguage).toHaveBeenCalledWith('fr');
    expect(loadProviderConfigs).not.toHaveBeenCalled();
    expect(loadToolSettings).not.toHaveBeenCalled();
    expect(refreshWebSearchSettings).not.toHaveBeenCalled();
    expect(refreshSkills).not.toHaveBeenCalled();
  });

  it('refreshes only the consumers of each changed runtime document', () => {
    useConfigStore.setState({ snapshot: initialSnapshot });
    installConfigRuntimeEffects();

    const providersChanged = snapshot({
      ...initialSnapshot.effective,
      providers: { default: 'anthropic' },
    });
    useConfigStore.setState({ snapshot: providersChanged });
    expect(loadProviderConfigs).toHaveBeenCalledTimes(1);
    expect(loadToolSettings).not.toHaveBeenCalled();
    expect(refreshWebSearchSettings).not.toHaveBeenCalled();
    expect(refreshSkills).not.toHaveBeenCalled();

    const toolsChanged = snapshot({
      ...providersChanged.effective,
      tools: { riskLevel: 'strict' },
    });
    useConfigStore.setState({ snapshot: toolsChanged });
    expect(loadProviderConfigs).toHaveBeenCalledTimes(1);
    expect(loadToolSettings).toHaveBeenCalledTimes(1);
    expect(refreshWebSearchSettings).toHaveBeenCalledTimes(1);
    expect(refreshSkills).not.toHaveBeenCalled();

    useConfigStore.setState({
      snapshot: snapshot({
        ...toolsChanged.effective,
        skills: { directories: ['C:/skills'] },
      }),
    });
    expect(loadProviderConfigs).toHaveBeenCalledTimes(1);
    expect(loadToolSettings).toHaveBeenCalledTimes(1);
    expect(refreshWebSearchSettings).toHaveBeenCalledTimes(1);
    expect(refreshSkills).toHaveBeenCalledTimes(1);
    expect(applyConfiguredLanguage).not.toHaveBeenCalled();
  });

  it('does no runtime work for null, identical, or structurally unchanged snapshots', () => {
    useConfigStore.setState({ snapshot: initialSnapshot });
    installConfigRuntimeEffects();
    useConfigStore.setState({ snapshot: null });
    useConfigStore.setState({ snapshot: initialSnapshot });
    useConfigStore.setState({ snapshot: snapshot({ ...initialSnapshot.effective }) });

    expect(applyConfiguredLanguage).not.toHaveBeenCalled();
    expect(loadProviderConfigs).not.toHaveBeenCalled();
    expect(loadToolSettings).not.toHaveBeenCalled();
    expect(refreshWebSearchSettings).not.toHaveBeenCalled();
    expect(refreshSkills).not.toHaveBeenCalled();
  });

  it('installs once, cleans up idempotently, and can be installed again', () => {
    useConfigStore.setState({ snapshot: initialSnapshot });

    const firstCleanup = installConfigRuntimeEffects();
    const secondCleanup = installConfigRuntimeEffects();

    expect(secondCleanup).toBe(firstCleanup);
    expect(persistenceErrorListeners.size).toBe(1);
    expect(subscribePreferencePersistenceErrors).toHaveBeenCalledTimes(1);

    firstCleanup();
    secondCleanup();
    expect(persistenceErrorListeners.size).toBe(0);
    expect(persistenceUnsubscribes[0]).toHaveBeenCalledTimes(1);

    useConfigStore.setState({
      snapshot: snapshot({
        ...initialSnapshot.effective,
        providers: { default: 'anthropic' },
      }),
    });
    expect(loadProviderConfigs).not.toHaveBeenCalled();

    installConfigRuntimeEffects();
    expect(persistenceErrorListeners.size).toBe(1);
    expect(subscribePreferencePersistenceErrors).toHaveBeenCalledTimes(2);
    useConfigStore.setState({
      snapshot: snapshot({
        ...initialSnapshot.effective,
        providers: { default: 'gemini' },
      }),
    });
    expect(loadProviderConfigs).toHaveBeenCalledTimes(1);
  });

  it('reports persistence errors while installed and stops after cleanup', () => {
    const cleanupEffects = installConfigRuntimeEffects();
    const listener = [...persistenceErrorListeners][0];

    listener(new Error('Disk full'), 'theme');

    expect(translate).toHaveBeenCalledWith(
      'settings.configuration.saveFailed',
      'Could not save configuration',
    );
    expect(notifyError).toHaveBeenCalledWith(
      'Could not save configuration',
      { description: 'Disk full' },
    );

    listener('Read only', 'theme');
    listener(503, 'theme');
    expect(notifyError).toHaveBeenNthCalledWith(
      2,
      'Could not save configuration',
      { description: 'Read only' },
    );
    expect(notifyError).toHaveBeenNthCalledWith(
      3,
      'Could not save configuration',
      { description: '503' },
    );

    cleanupEffects();
    expect(persistenceErrorListeners.size).toBe(0);
    expect(persistenceUnsubscribes[0]).toHaveBeenCalledTimes(1);
  });
});
