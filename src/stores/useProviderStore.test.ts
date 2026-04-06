import { beforeEach, describe, expect, it, mock } from 'bun:test';

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
const testProviderConnectionMock = mock(async () => ({
  success: true,
  message: 'Connected',
}));

const loadProviderStore = async () => {
  mock.module('@tauri-apps/api/event', () => ({
    listen: async () => () => undefined,
  }));
  mock.module('../services/tauriIpc', () => ({
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
    testProviderConnection: testProviderConnectionMock,
  }));
  mock.module('../services/aiConfig', () => ({
    loadAIConfigFile: async () => null,
    findProviderConfig: () => undefined,
  }));
  mock.module('../services/preferences', () => ({
    PREF_KEYS: {
      AI_CONTEXT_SELECTIONS: 'ai_context_selections',
    },
    PREF_DEFAULTS: {},
    loadPreference: async () => null,
    savePreference: async () => undefined,
  }));
  mock.module('./useAppStore', () => ({
    useAppStore: {
      getState: () => ({
        mode: 'Chat',
      }),
    },
  }));

  importCounter += 1;
  return import(`./useProviderStore.ts?provider-store-test=${importCounter}`);
};

describe('useProviderStore secret resolution', () => {
  beforeEach(() => {
    mock.restore();
    listProviderConfigsMock.mockClear();
    revealProviderApiKeyMock.mockClear();
    updateProviderConfigMock.mockClear();
    createProviderConfigMock.mockClear();
    getProviderSettingsMock.mockClear();
    listProviderModelsMock.mockClear();
    fetchModelsFromProviderMock.mockClear();
    testProviderConnectionMock.mockClear();
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
  });

  it('reveals a stored key once and caches it for the session', async () => {
    const providerStore = await loadProviderStore();
    await providerStore.useProviderStore.getState().loadProviderConfigs();

    const store = providerStore.useProviderStore.getState();
    await store.testConnection('provider-openai');
    await providerStore.useProviderStore.getState().testConnection('provider-openai');

    expect(revealProviderApiKeyMock).toHaveBeenCalledTimes(1);
    expect(testProviderConnectionMock).toHaveBeenCalledTimes(2);
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
    expect(testProviderConnectionMock).not.toHaveBeenCalled();
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
    expect(testProviderConnectionMock).not.toHaveBeenCalled();
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
    expect(testProviderConnectionMock).not.toHaveBeenCalled();
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
