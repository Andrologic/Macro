import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { CopilotStatusDto } from '../services/tauriIpc';
import { __testables as catalogTestables } from '../services/modelContextCatalog';

let importCounter = 0;

type TauriEventHandler = (event: { payload: unknown }) => void;

const tauriEventHandlers = new Map<string, TauriEventHandler[]>();
const listenMock = mock(async (eventName: string, handler: TauriEventHandler) => {
  const handlers = tauriEventHandlers.get(eventName) ?? [];
  handlers.push(handler);
  tauriEventHandlers.set(eventName, handlers);

  return () => {
    const currentHandlers = tauriEventHandlers.get(eventName) ?? [];
    tauriEventHandlers.set(
      eventName,
      currentHandlers.filter((entry) => entry !== handler)
    );
  };
});

const emitTauriEvent = (eventName: string, payload: unknown) => {
  for (const handler of tauriEventHandlers.get(eventName) ?? []) {
    handler({ payload });
  }
};

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
  copilot_send_timeout_ms: 1_800_000,
}));
const updateProviderSettingsMock = mock(async () => undefined);
const listProviderModelsMock = mock(async () => []);
const upsertProviderModelsMock = mock(async () => []);
const aiDownloadCopilotRuntimeMock = mock(
  async (_params: { requestId: string; providerId?: string }) => undefined
);
const aiCancelCopilotRuntimeDownloadMock = mock(async () => undefined);
const aiGetCopilotStatusMock = mock(async (): Promise<CopilotStatusDto> => ({
  ok: false,
  runtime_source: 'none',
  runtime_status: 'missing',
  runtime_version: null,
  min_cli_version: '1.0.12',
  auth_status: 'error',
  auth_source: null,
  account_label: null,
  status_message: null,
  error_code: 'runtime_missing',
  error_message: 'GitHub Copilot runtime is not installed.',
}));
const aiSyncProviderModelsMock = mock(async () => []);
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

const copilotProviderConfig = {
  id: 'copilot',
  name: 'GitHub Copilot',
  providerType: 'copilot',
  baseUrl: 'copilot://cli',
  hasStoredApiKey: false,
  apiKeyLoaded: false,
  isEnabled: true,
  isLocal: false,
  authStatus: 'login_required' as const,
  nativeToolCalling: true,
};

const copilotProvider = {
  id: 'copilot',
  name: 'GitHub Copilot',
  status: 'offline' as const,
  baseUrl: 'copilot://cli',
  isLocal: false,
  isEnabled: true,
  nativeToolCalling: true,
};

const makeCopilotStatus = (overrides: Partial<CopilotStatusDto> = {}): CopilotStatusDto => ({
  ok: false,
  runtime_source: 'none',
  runtime_status: 'missing',
  runtime_version: null,
  min_cli_version: '1.0.12',
  auth_status: 'error',
  auth_source: null,
  account_label: null,
  status_message: null,
  error_code: 'runtime_missing',
  error_message: 'GitHub Copilot runtime is not installed.',
  ...overrides,
});

const loadProviderStore = async () => {
  const actualPreferences = await import(
    `../services/preferences.ts?provider-store-preferences-test=${importCounter + 1}`
  );

  mock.module('@tauri-apps/api/event', () => ({
    listen: listenMock,
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
    updateProviderSettings: updateProviderSettingsMock,
    listProviderModels: listProviderModelsMock,
    upsertProviderModels: upsertProviderModelsMock,
    aiDownloadCopilotRuntime: aiDownloadCopilotRuntimeMock,
    aiCancelCopilotRuntimeDownload: aiCancelCopilotRuntimeDownloadMock,
    aiGetCopilotStatus: aiGetCopilotStatusMock,
    aiSyncProviderModels: aiSyncProviderModelsMock,
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
    updateProviderSettingsMock.mockClear();
    listProviderModelsMock.mockClear();
    upsertProviderModelsMock.mockClear();
    listenMock.mockClear();
    aiDownloadCopilotRuntimeMock.mockClear();
    aiCancelCopilotRuntimeDownloadMock.mockClear();
    aiGetCopilotStatusMock.mockClear();
    aiSyncProviderModelsMock.mockClear();
    aiDownloadCopilotRuntimeMock.mockImplementation(
      async (_params: { requestId: string; providerId?: string }) => undefined
    );
    aiCancelCopilotRuntimeDownloadMock.mockImplementation(async () => undefined);
    aiGetCopilotStatusMock.mockImplementation(async () => makeCopilotStatus());
    aiSyncProviderModelsMock.mockImplementation(async () => []);
    upsertProviderModelsMock.mockImplementation(async () => []);
    fetchModelsFromProviderMock.mockClear();
    probeModelsEndpointMock.mockClear();
    probeProviderReachabilityMock.mockClear();
    catalogTestables.reset();
    tauriEventHandlers.clear();
  });

  afterEach(() => {
    useAppStoreMock.setState({ mode: 'Chat' });
    mock.restore();
  });

  it('loads provider configs without revealing stored secrets', async () => {
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

    expect(loadPreferenceMock).not.toHaveBeenCalled();
    expect(revealProviderApiKeyMock).not.toHaveBeenCalled();
    expect(probeProviderReachabilityMock).not.toHaveBeenCalled();
    expect(providerStore.useProviderStore.getState().selectedProviderId).toBeNull();
    expect(providerStore.useProviderStore.getState().selectedModelId).toBeNull();
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

  it('persists provider settings partially', async () => {
    const providerStore = await loadProviderStore();
    await providerStore.useProviderStore.getState().loadProviderConfigs();

    await providerStore.useProviderStore.getState().updateProviderSettings('provider-openai', {
      copilotSendTimeoutMs: 2_400_000,
    });

    expect(updateProviderSettingsMock).toHaveBeenCalledWith({
      providerId: 'provider-openai',
      copilotSendTimeoutMs: 2_400_000,
    });
    expect(providerStore.useProviderStore.getState().providerSettingsById['provider-openai'])
      .toMatchObject({
        filterFreeModels: false,
        copilotSendTimeoutMs: 2_400_000,
      });
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

  it('commits a restored selection atomically and normalizes the reasoning effort', async () => {
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
            id: 'gpt-5-pro',
            name: 'GPT-5 Pro',
            provider_id: 'provider-openai',
            isEnabled: true,
            reasoningEfforts: ['high'],
            defaultReasoningEffort: 'high',
          },
        ],
      },
      selectedProviderId: null,
      selectedModelId: null,
      selectedReasoningEffort: null,
    });

    const committed = await providerStore.useProviderStore.getState().commitRestoredSelection({
      providerId: 'provider-openai',
      modelId: 'gpt-5-pro',
      reasoningEffort: 'xhigh',
    });

    expect(committed).toEqual({
      providerId: 'provider-openai',
      modelId: 'gpt-5-pro',
      reasoningEffort: 'high',
    });
    expect(providerStore.useProviderStore.getState().selectedProviderId).toBe('provider-openai');
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

  it('records provider overflow limits when the observed limit lowers catalog metadata', async () => {
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
      modelsByProvider: {
        'provider-openai': [
          {
            id: 'gpt-catalog',
            name: 'GPT Catalog',
            provider_id: 'provider-openai',
            isEnabled: true,
            contextWindowTokens: 128_000,
            contextWindowSource: 'models_dev',
          },
        ],
      },
    });

    await providerStore.useProviderStore
      .getState()
      .recordProviderModelContextOverflowLimit(
        'provider-openai',
        'gpt-catalog',
        64_000
      );

    expect(upsertProviderModelsMock).toHaveBeenCalledWith({
      providerId: 'provider-openai',
      models: [
        expect.objectContaining({
          model_id: 'gpt-catalog',
          context_window_tokens: 64_000,
          context_window_source: 'provider_overflow_error',
        }),
      ],
    });
    expect(
      providerStore.useProviderStore.getState().modelsByProvider[
        'provider-openai'
      ][0]
    ).toMatchObject({
      contextWindowTokens: 64_000,
      contextWindowSource: 'provider_overflow_error',
    });
  });

  it('does not replace user overrides or increase known provider limits from overflow hints', async () => {
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
      modelsByProvider: {
        'provider-openai': [
          {
            id: 'manual-model',
            name: 'Manual Model',
            provider_id: 'provider-openai',
            isEnabled: true,
            contextWindowTokens: 16_000,
            contextWindowSource: 'user_override',
          },
          {
            id: 'provider-model',
            name: 'Provider Model',
            provider_id: 'provider-openai',
            isEnabled: true,
            contextWindowTokens: 64_000,
            contextWindowSource: 'provider_metadata',
          },
        ],
      },
    });

    await providerStore.useProviderStore
      .getState()
      .recordProviderModelContextOverflowLimit(
        'provider-openai',
        'manual-model',
        8_000
      );
    await providerStore.useProviderStore
      .getState()
      .recordProviderModelContextOverflowLimit(
        'provider-openai',
        'provider-model',
        128_000
      );

    expect(upsertProviderModelsMock).not.toHaveBeenCalled();
    expect(
      providerStore.useProviderStore.getState().modelsByProvider[
        'provider-openai'
      ]
    ).toMatchObject([
      {
        id: 'manual-model',
        contextWindowTokens: 16_000,
        contextWindowSource: 'user_override',
      },
      {
        id: 'provider-model',
        contextWindowTokens: 64_000,
        contextWindowSource: 'provider_metadata',
      },
    ]);
  });

  it('refreshes loaded models from the context catalog and persists reliable enrichments', async () => {
    const providerStore = await loadProviderStore();
    catalogTestables.writeCachedCatalog({
      fetchedAt: new Date().toISOString(),
      providers: {
        openai: {
          id: 'openai',
          models: {
            'gpt-catalog': {
              id: 'gpt-catalog',
              limit: { context: 222_000, input: 200_000, output: 16_000 },
            },
          },
        },
      },
    });

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
      modelsByProvider: {
        'provider-openai': [
          {
            id: 'gpt-catalog',
            name: 'GPT Catalog',
            provider_id: 'provider-openai',
            isEnabled: true,
          },
        ],
      },
    });

    await providerStore.useProviderStore
      .getState()
      .refreshLoadedModelContextCatalog('provider-openai');

    expect(
      providerStore.useProviderStore.getState().modelsByProvider[
        'provider-openai'
      ][0]
    ).toMatchObject({
      contextWindowTokens: 222_000,
      inputLimitTokens: 200_000,
      outputLimitTokens: 16_000,
      contextWindowSource: 'models_dev',
    });
    expect(upsertProviderModelsMock).toHaveBeenCalledWith({
      providerId: 'provider-openai',
      models: [
        expect.objectContaining({
          model_id: 'gpt-catalog',
          context_window_tokens: 222_000,
          context_window_source: 'models_dev',
        }),
      ],
    });
  });

  it('preserves user context overrides when provider scans return metadata', async () => {
    const providerStore = await loadProviderStore();
    (probeModelsEndpointMock as unknown as {
      mockImplementationOnce: (implementation: () => Promise<unknown>) => void;
    }).mockImplementationOnce(async () => ({
      success: true,
      status: 'reachable',
      source: 'models_endpoint',
      message: 'Connected! Found 1 model.',
      models: [
        {
          id: 'manual-model',
          name: 'Manual Model',
          context_length: 200_000,
          max_input_tokens: 180_000,
        },
      ],
    }));

    providerStore.useProviderStore.setState({
      providerConfigs: [
        {
          id: 'provider-openai',
          name: 'OpenAI',
          providerType: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          hasStoredApiKey: true,
          apiKeyLoaded: true,
          apiKey: 'test-api-key',
          isEnabled: true,
          isLocal: false,
        },
      ],
      modelsByProvider: {
        'provider-openai': [
          {
            id: 'manual-model',
            name: 'Manual Model',
            provider_id: 'provider-openai',
            isEnabled: true,
            contextWindowTokens: 16_000,
            contextWindowSource: 'user_override',
            contextLimitsUpdatedAt: '2026-05-10T00:00:00.000Z',
          },
        ],
      },
    });

    await providerStore.useProviderStore
      .getState()
      .scanModelsForProvider('provider-openai');

    expect(upsertProviderModelsMock).toHaveBeenCalledWith({
      providerId: 'provider-openai',
      models: [
        expect.objectContaining({
          model_id: 'manual-model',
          context_window_tokens: 16_000,
          input_limit_tokens: 180_000,
          context_window_source: 'user_override',
        }),
      ],
    });
  });

  it('applies fresh Copilot runtime status when download completes', async () => {
    const providerStore = await loadProviderStore();
    const completionStatus = makeCopilotStatus({
      ok: false,
      runtime_source: 'managed',
      runtime_status: 'ready',
      runtime_version: '1.0.12',
      auth_status: 'login_required',
      status_message: 'Connect GitHub Copilot to finish setup.',
      error_code: null,
      error_message: null,
    });

    aiDownloadCopilotRuntimeMock.mockImplementation(
      async ({ requestId, providerId }: { requestId: string; providerId?: string }) => {
        emitTauriEvent('ai:copilot-download-complete', {
          request_id: requestId,
          provider_id: providerId ?? 'copilot',
          runtime_version: '1.0.12',
          runtime_source: 'managed',
          status: completionStatus,
        });
      }
    );

    providerStore.useProviderStore.setState({
      providerConfigs: [copilotProviderConfig],
      providers: [copilotProvider],
      copilotStatusByProvider: {
        copilot: makeCopilotStatus(),
      },
      copilotDownloadStateByProvider: {},
      providerReachabilityById: {},
      authErrorsByProvider: {},
      connectionStatus: {},
    });

    await providerStore.useProviderStore.getState().startCopilotRuntimeDownload('copilot');

    const state = providerStore.useProviderStore.getState();
    expect(state.copilotDownloadStateByProvider.copilot).toBeUndefined();
    expect(state.copilotStatusByProvider.copilot).toMatchObject({
      runtime_status: 'ready',
      auth_status: 'login_required',
      runtime_source: 'managed',
    });
    expect(state.providerConfigs[0]).toMatchObject({
      id: 'copilot',
      authStatus: 'login_required',
    });
    expect(state.connectionStatus.copilot).toBe('offline');
    expect(aiGetCopilotStatusMock).not.toHaveBeenCalled();
    expect(listProviderModelsMock).not.toHaveBeenCalled();
    expect(aiSyncProviderModelsMock).not.toHaveBeenCalled();
  });

  it('uses completion status instead of a stale Copilot status check and syncs models when connected', async () => {
    const providerStore = await loadProviderStore();
    const completionStatus = makeCopilotStatus({
      ok: true,
      runtime_source: 'managed',
      runtime_status: 'ready',
      runtime_version: '1.0.12',
      auth_status: 'connected',
      auth_source: 'oauth',
      account_label: 'octo@example.com',
      status_message: 'GitHub Copilot connected.',
      error_code: null,
      error_message: null,
    });

    aiGetCopilotStatusMock.mockImplementation(async () =>
      makeCopilotStatus({
        runtime_status: 'missing',
        auth_status: 'error',
        error_code: 'runtime_missing',
      })
    );
    aiDownloadCopilotRuntimeMock.mockImplementation(
      async ({ requestId, providerId }: { requestId: string; providerId?: string }) => {
        emitTauriEvent('ai:copilot-download-complete', {
          request_id: requestId,
          provider_id: providerId ?? 'copilot',
          runtime_version: '1.0.12',
          runtime_source: 'managed',
          status: completionStatus,
        });
      }
    );

    providerStore.useProviderStore.setState({
      providerConfigs: [copilotProviderConfig],
      providers: [copilotProvider],
      copilotStatusByProvider: {
        copilot: makeCopilotStatus(),
      },
      copilotDownloadStateByProvider: {},
      providerReachabilityById: {},
      authErrorsByProvider: {},
      connectionStatus: {},
      modelsByProvider: {},
    });

    await providerStore.useProviderStore.getState().startCopilotRuntimeDownload('copilot');

    const state = providerStore.useProviderStore.getState();
    expect(aiGetCopilotStatusMock).not.toHaveBeenCalled();
    expect(listProviderModelsMock).toHaveBeenCalledWith('copilot');
    expect(aiSyncProviderModelsMock).toHaveBeenCalledWith('copilot');
    expect(state.copilotDownloadStateByProvider.copilot).toBeUndefined();
    expect(state.copilotStatusByProvider.copilot).toMatchObject({
      runtime_status: 'ready',
      auth_status: 'connected',
      account_label: 'octo@example.com',
    });
    expect(state.providerConfigs[0]).toMatchObject({
      id: 'copilot',
      authStatus: 'connected',
      authSource: 'oauth',
      accountLabel: 'octo@example.com',
    });
    expect(state.connectionStatus.copilot).toBe('online');
  });
});
