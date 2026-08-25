import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { DevProviderOverridesFile } from './tauriIpc';

let devOverrides: DevProviderOverridesFile | null = null;
let shouldReject = false;
let tauriAvailable = false;

const aiGetDevProviderOverridesMock = mock(async () => {
  if (shouldReject) {
    throw new Error('boom');
  }

  return devOverrides;
});

const registerAiConfigMocks = () => {
  mock.restore();
  mock.module('./aiConfigRuntime', () => ({
    aiGetDevProviderOverrides: aiGetDevProviderOverridesMock,
    isTauriAvailable: () => tauriAvailable,
  }));
};

let aiConfigImportCounter = 0;

const loadAiConfigModule = async () => {
  registerAiConfigMocks();
  aiConfigImportCounter += 1;
  return import(`./aiConfig.ts?test=${aiConfigImportCounter}`);
};

describe('aiConfig loadAIConfigFile', () => {
  beforeEach(() => {
    tauriAvailable = false;
    devOverrides = null;
    shouldReject = false;
    aiGetDevProviderOverridesMock.mockClear();
  });

  it('returns null outside Tauri', async () => {
    const aiConfig = await loadAiConfigModule();

    await expect(aiConfig.loadAIConfigFile()).resolves.toBeNull();
    expect(aiGetDevProviderOverridesMock).not.toHaveBeenCalled();
  });

  it('returns null when the Tauri command returns null', async () => {
    tauriAvailable = true;
    const aiConfig = await loadAiConfigModule();

    await expect(aiConfig.loadAIConfigFile()).resolves.toBeNull();
    expect(aiGetDevProviderOverridesMock).toHaveBeenCalledTimes(1);
  });

  it('loads and resolves provider overrides from Tauri dev', async () => {
    tauriAvailable = true;
    devOverrides = {
      providers: {
        openrouter: {
          name: 'OpenRouter',
          providerType: 'openrouter',
          apiKey: 'test-api-key',
          baseUrl: 'https://openrouter.ai/api/v1/',
          isLocal: false,
        },
      },
    };
    const aiConfig = await loadAiConfigModule();

    await expect(aiConfig.loadAIConfigFile()).resolves.toEqual(devOverrides);
    await expect(aiConfig.getProviderConfig('openrouter')).resolves.toEqual({
      apiKey: 'test-api-key',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });
});

afterAll(() => {
  mock.restore();
});
