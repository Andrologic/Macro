import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let importCounter = 0;

const listProviderConfigsMock = mock(async () => [
  {
    id: 'provider-openai',
    name: 'OpenAI',
    provider_type: 'openai',
    base_url: 'https://api.openai.com/v1',
    api_key: null,
    has_stored_api_key: true,
    is_enabled: true,
    is_local: false,
    auth_status: null,
    auth_source: null,
    plan_type: null,
    account_label: null,
    token_expires_at: null,
    created_at: '2026-04-04T00:00:00.000Z',
    updated_at: '2026-04-04T00:00:00.000Z',
  },
]);

const revealProviderApiKeyMock = mock(async () => 'test-api-key');
const updateProviderConfigMock = mock(async () => undefined);
const createProviderConfigMock = mock(async () => ({
  id: 'provider-created',
  name: 'Created Provider',
  provider_type: 'openai',
  base_url: 'https://api.openai.com/v1',
  api_key: null,
  has_stored_api_key: true,
  is_enabled: true,
  is_local: false,
  auth_status: null,
  auth_source: null,
  plan_type: null,
  account_label: null,
  token_expires_at: null,
  created_at: '2026-04-04T00:00:00.000Z',
  updated_at: '2026-04-04T00:00:00.000Z',
}));
const getProviderSettingsMock = mock(async () => ({
  provider_id: 'provider-openai',
  filter_free_models: false,
}));
const listProviderModelsMock = mock(async () => []);
const fetchModelsFromProviderMock = mock(async () => ({
  success: true,
  models: [],
}));
const probeModelsEndpointMock = mock(async () => ({
  success: true,
  status: 'reachable',
  source: 'models_endpoint',
  message: 'Connected! Found 0 models.',
  models: [],
}));
const probeProviderReachabilityMock = mock(async () => ({
  success: true,
  message: 'Connected',
  status: 'reachable',
  source: 'models_endpoint',
  models: [],
}));
const appStoreState = {
  mode: 'Chat' as const,
};
const useAppStoreMock = Object.assign(
  <TSelected = typeof appStoreState>(
    selector?: (state: typeof appStoreState) => TSelected
  ) => (selector ? selector(appStoreState) : (appStoreState as TSelected)),
  {
    getState: () => appStoreState,
    setState: (
      patch: Partial<typeof appStoreState> | ((state: typeof appStoreState) => Partial<typeof appStoreState>)
    ) => {
      Object.assign(appStoreState, typeof patch === 'function' ? patch(appStoreState) : patch);
    },
    subscribe: () => () => undefined,
  }
);
const actualTauriIpc = await import('../services/tauriIpc');
const { loadPreference: actualLoadPreference } = await import('../services/preferences');
const loadPreferenceMock = mock(
  async (key: string): Promise<unknown> => actualLoadPreference(key as any)
);
const savePreferenceMock = mock(async () => undefined);

const loadProviderStore = async () => {
  const actualPreferences = await import(
    `../services/preferences.ts?provider-store-preferences-test=${importCounter + 1}`
  );

  mock.module('@tauri-apps/api/event', () => ({
    listen: async () => () => undefined,
  }));
  mock.module('../services/tauriIpc', () => ({
    ...actualTauriIpc,
    isTauriAvailable: () => true,
    listProviderConfigs: listProviderConfigsMock,
    revealProviderApiKey: revealProviderApiKeyMock,
    updateProviderConfig: updateProviderConfigMock,
    createProviderConfig: createProviderConfigMock,
    updateConversationDetails: mock(async () => undefined),
    createMessage: mock(async (conversationId: string, role: string, content: string) => ({
      id: `message-${conversationId}-${role}`,
      conversation_id: conversationId,
      role,
      content,
      timestamp: '2026-04-04T00:00:00.000Z',
    })),
    getProviderSettings: getProviderSettingsMock,
    listProviderModels: listProviderModelsMock,
    getChatSnapshot: mock(async () => ({ conversations: [], messages: [] })),
    listConversations: mock(async () => []),
    importMessages: mock(async () => []),
    deleteConversations: mock(async () => undefined),
    gitBranchList: mock(async () => ({ local: [], remote: [], current: null })),
  }));
  mock.module('../services/providerApi', () => ({
    fetchModelsFromProvider: fetchModelsFromProviderMock,
    probeModelsEndpoint: probeModelsEndpointMock,
    probeProviderReachability: probeProviderReachabilityMock,
  }));
  mock.module('../services/aiConfig', () => ({
    loadAIConfigFile: async () => null,
    findProviderConfig: () => undefined,
  }));
  mock.module('../services/preferences', () => ({
    ...actualPreferences,
    loadPreference: loadPreferenceMock,
    savePreference: savePreferenceMock,
  }));
  mock.module('./useAppStore', () => ({
    useAppStore: useAppStoreMock,
  }));

  importCounter += 1;
  return import(`./useProviderStore.ts?provider-store-test=${importCounter}`);
};

describe('useProviderStore secret resolution', () => {
  beforeEach(() => {
    useAppStoreMock.setState({ mode: 'Chat' });
    loadPreferenceMock.mockClear();
    savePreferenceMock.mockClear();
    listProviderConfigsMock.mockClear();
    revealProviderApiKeyMock.mockClear();
    updateProviderConfigMock.mockClear();
    createProviderConfigMock.mockClear();
    getProviderSettingsMock.mockClear();
    listProviderModelsMock.mockClear();
    fetchModelsFromProviderMock.mockClear();
    probeModelsEndpointMock.mockClear();
    probeProviderReachabilityMock.mockClear();
  });

  afterEach(() => {
    useAppStoreMock.setState({ mode: 'Chat' });
    mock.restore();
  });

  it('loads provider configs without touching the keychain', async () => {
    const providerStore = await loadProviderStore();

    providerStore.useProviderStore.setState({
      providerConfigs: [],
      providers: [],
      modelsByProvider: {},
      providerSettingsById: {},
      selectedProviderId: null,
      selectedModelId: null,
      isLoading: false,
      isLoadingModels: false,
      lastError: null,
      connectionStatus: {},
      providerReachabilityById: {},
      authErrorsByProvider: {},
      authRequestIdsByProvider: {},
      copilotStatusByProvider: {},
      copilotDownloadStateByProvider: {},
      copilotAuthStateByProvider: {},
    });

    await providerStore.useProviderStore.getState().loadProviderConfigs();

    expect(revealProviderApiKeyMock).not.toHaveBeenCalled();
    expect(providerStore.useProviderStore.getState().providerConfigs[0]).toMatchObject({
      id: 'provider-openai',
      hasStoredApiKey: true,
      apiKey: undefined,
      apiKeyLoaded: false,
    });
    expect(providerStore.useProviderStore.getState().providerReachabilityById['provider-openai']).toBeUndefined();
    expect(providerStore.useProviderStore.getState().connectionStatus['provider-openai']).toBeUndefined();
  });

  it('reveals a stored key once and caches it for the session', async () => {
    const providerStore = await loadProviderStore();
    await providerStore.useProviderStore.getState().loadProviderConfigs();

    const store = providerStore.useProviderStore.getState();
    await store.testConnection('provider-openai');
    await providerStore.useProviderStore.getState().testConnection('provider-openai');

    expect(revealProviderApiKeyMock).toHaveBeenCalledTimes(1);
    expect(probeProviderReachabilityMock).toHaveBeenCalledTimes(2);
    expect(providerStore.useProviderStore.getState().providerConfigs[0]).toMatchObject({
      hasStoredApiKey: true,
      apiKey: 'test-api-key',
      apiKeyLoaded: true,
    });
  });

  it('initializes without auto-revealing stored API keys', async () => {
    const providerStore = await loadProviderStore();

    await providerStore.useProviderStore.getState().initialize();

    expect(revealProviderApiKeyMock).not.toHaveBeenCalled();
    expect(probeProviderReachabilityMock).not.toHaveBeenCalled();
  });

  it('clears cached secret metadata when the key is removed', async () => {
    const providerStore = await loadProviderStore();
    await providerStore.useProviderStore.getState().loadProviderConfigs();
    await providerStore.useProviderStore.getState().resolveProviderApiKey('provider-openai');

    await providerStore.useProviderStore.getState().updateProviderConfig('provider-openai', {
      apiKey: '',
    });

    expect(updateProviderConfigMock).toHaveBeenCalledTimes(1);
    expect(providerStore.useProviderStore.getState().providerConfigs[0]).toMatchObject({
      hasStoredApiKey: false,
      apiKey: undefined,
      apiKeyLoaded: true,
    });
  });

  it('does not rescan models immediately after updating a provider key', async () => {
    const providerStore = await loadProviderStore();
    await providerStore.useProviderStore.getState().loadProviderConfigs();

    await providerStore.useProviderStore.getState().updateProviderConfig('provider-openai', {
      apiKey: 'test-api-key',
    });

    expect(updateProviderConfigMock).toHaveBeenCalledTimes(1);
    expect(revealProviderApiKeyMock).not.toHaveBeenCalled();
    expect(listProviderModelsMock).not.toHaveBeenCalled();
    expect(fetchModelsFromProviderMock).not.toHaveBeenCalled();
    expect(probeProviderReachabilityMock).not.toHaveBeenCalled();
  });

  it('persists providerType and isLocal when updating an existing provider', async () => {
    const providerStore = await loadProviderStore();
    await providerStore.useProviderStore.getState().loadProviderConfigs();

    await providerStore.useProviderStore.getState().updateProviderConfig('provider-openai', {
      providerType: 'anthropic',
      isLocal: true,
    });

    expect(updateProviderConfigMock).toHaveBeenCalledWith({
      id: 'provider-openai',
      name: undefined,
      providerType: 'anthropic',
      baseUrl: undefined,
      apiKey: undefined,
      isLocal: true,
      isEnabled: undefined,
    });
    expect(providerStore.useProviderStore.getState().providerConfigs[0]).toMatchObject({
      providerType: 'anthropic',
      isLocal: true,
    });
  });

  it('does not scan models immediately after creating a provider with an API key', async () => {
    const providerStore = await loadProviderStore();

    await providerStore.useProviderStore.getState().createProviderConfig({
      name: 'Created Provider',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-api-key',
      isEnabled: true,
      isLocal: false,
    });

    expect(createProviderConfigMock).toHaveBeenCalledTimes(1);
    expect(revealProviderApiKeyMock).not.toHaveBeenCalled();
    expect(fetchModelsFromProviderMock).not.toHaveBeenCalled();
    expect(probeProviderReachabilityMock).not.toHaveBeenCalled();
  });

  it('invalidates previous reachability when the base URL changes', async () => {
    const providerStore = await loadProviderStore();
    await providerStore.useProviderStore.getState().loadProviderConfigs();

    providerStore.useProviderStore.setState({
      providerReachabilityById: {
        'provider-openai': {
          status: 'reachable',
          lastVerifiedAt: '2026-04-04T00:00:00.000Z',
          lastVerifiedBy: 'models_endpoint',
        },
      },
      connectionStatus: {
        'provider-openai': 'online',
      },
    });

    await providerStore.useProviderStore.getState().updateProviderConfig('provider-openai', {
      baseUrl: 'https://proxy.example.com/v1',
    });

    expect(providerStore.useProviderStore.getState().providerReachabilityById['provider-openai']).toBeUndefined();
    expect(providerStore.useProviderStore.getState().connectionStatus['provider-openai']).toBeUndefined();
  });

  it('promotes a provider to reachable after a successful runtime response', async () => {
    const providerStore = await loadProviderStore();
    await providerStore.useProviderStore.getState().loadProviderConfigs();

    providerStore.useProviderStore
      .getState()
      .markProviderReachable('provider-openai', { modelId: 'MiniMax-M2.7' });

    expect(providerStore.useProviderStore.getState().providerReachabilityById['provider-openai']).toMatchObject({
      status: 'reachable',
      lastVerifiedBy: 'chat_completion_runtime',
      modelIdUsed: 'MiniMax-M2.7',
    });
    expect(providerStore.useProviderStore.getState().connectionStatus['provider-openai']).toBe('online');
  });

  it('passes known models to the reachability probe for fallback verification', async () => {
    const providerStore = await loadProviderStore();
    await providerStore.useProviderStore.getState().loadProviderConfigs();

    providerStore.useProviderStore.setState({
      selectedProviderId: 'provider-openai',
      selectedModelId: 'MiniMax-M2.7',
      modelsByProvider: {
        'provider-openai': [
          {
            id: 'MiniMax-M2.7',
            name: 'MiniMax-M2.7',
            provider_id: 'provider-openai',
            isEnabled: true,
          },
        ],
      },
    });

    await providerStore.useProviderStore.getState().testConnection('provider-openai');

    expect(probeProviderReachabilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredModelId: 'MiniMax-M2.7',
        modelIds: [],
      })
    );
  });

  it('falls back to the new model default reasoning effort when the previous effort is invalid', async () => {
    const providerStore = await loadProviderStore();

    providerStore.useProviderStore.setState({
      providerConfigs: [
        {
          id: 'provider-openai',
          name: 'OpenAI',
          providerType: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          hasStoredApiKey: true,
          apiKeyLoaded: false,
          isEnabled: true,
          isLocal: false,
        },
      ],
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI',
          status: 'online',
          baseUrl: 'https://api.openai.com/v1',
          isLocal: false,
          isEnabled: true,
        },
      ],
      modelsByProvider: {
        'provider-openai': [
          {
            id: 'gpt-5.4-pro',
            name: 'GPT-5.4 Pro',
            provider_id: 'provider-openai',
            isEnabled: true,
            reasoningEfforts: ['medium', 'high', 'xhigh'],
            defaultReasoningEffort: 'medium',
          },
          {
            id: 'gpt-5-pro',
            name: 'GPT-5 Pro',
            provider_id: 'provider-openai',
            isEnabled: true,
            reasoningEfforts: ['high'],
            defaultReasoningEffort: 'high',
          },
        ],
      },
      selectedProviderId: 'provider-openai',
      selectedModelId: 'gpt-5.4-pro',
      selectedReasoningEffort: 'xhigh',
    });

    providerStore.useProviderStore.getState().selectModel('gpt-5-pro');

    expect(providerStore.useProviderStore.getState().selectedModelId).toBe('gpt-5-pro');
    expect(providerStore.useProviderStore.getState().selectedReasoningEffort).toBe('high');
  });

  it('hides reasoning efforts for the session after a model is marked unsupported', async () => {
    const providerStore = await loadProviderStore();

    providerStore.useProviderStore.setState({
      providerConfigs: [
        {
          id: 'provider-openai',
          name: 'OpenAI',
          providerType: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          hasStoredApiKey: true,
          apiKeyLoaded: false,
          isEnabled: true,
          isLocal: false,
        },
      ],
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI',
          status: 'online',
          baseUrl: 'https://api.openai.com/v1',
          isLocal: false,
          isEnabled: true,
        },
      ],
      modelsByProvider: {
        'provider-openai': [
          {
            id: 'gpt-5',
            name: 'GPT-5',
            provider_id: 'provider-openai',
            isEnabled: true,
            reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
            defaultReasoningEffort: 'medium',
          },
        ],
      },
      selectedProviderId: 'provider-openai',
      selectedModelId: 'gpt-5',
      selectedReasoningEffort: 'medium',
      reasoningUnsupportedModelKeys: {},
    });

    expect(
      providerStore.useProviderStore
        .getState()
        .getAvailableReasoningEfforts('provider-openai', 'gpt-5')
    ).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);

    providerStore.useProviderStore
      .getState()
      .markReasoningUnsupportedForModel('provider-openai', 'gpt-5');

    expect(providerStore.useProviderStore.getState().selectedReasoningEffort).toBeNull();
    expect(
      providerStore.useProviderStore
        .getState()
        .getAvailableReasoningEfforts('provider-openai', 'gpt-5')
    ).toEqual([]);
  });
});
