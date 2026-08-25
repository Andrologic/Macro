import { describe, expect, it } from 'bun:test';
import type { AIModel, ProviderConfig } from '../types';
import {
  normalizeMetadataModelConfig,
  providerCanGenerateMetadata,
} from './metadataModelConfig';

const provider = (id: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id,
  name: id,
  providerType: 'openai',
  baseUrl: 'https://api.example.test/v1',
  hasStoredApiKey: true,
  isEnabled: true,
  isLocal: false,
  ...overrides,
});

const model = (providerId: string, id: string, overrides: Partial<AIModel> = {}): AIModel => ({
  id,
  name: id,
  provider_id: providerId,
  isEnabled: true,
  ...overrides,
});

describe('metadataModelConfig', () => {
  it('keeps conversation and valid dedicated configs unchanged', () => {
    const context = {
      providerConfigs: [provider('provider-a')],
      modelsByProvider: {
        'provider-a': [model('provider-a', 'model-a')],
      },
    };

    expect(normalizeMetadataModelConfig({ mode: 'conversation' }, context)).toEqual({
      mode: 'conversation',
    });
    expect(
      normalizeMetadataModelConfig(
        {
          mode: 'dedicated',
          providerId: 'provider-a',
          modelId: 'model-a',
          reasoningEffort: null,
        },
        context
      )
    ).toEqual({
      mode: 'dedicated',
      providerId: 'provider-a',
      modelId: 'model-a',
      reasoningEffort: null,
    });
  });

  it('keeps a valid dedicated reasoning effort from loaded model metadata', () => {
    expect(
      normalizeMetadataModelConfig(
        {
          mode: 'dedicated',
          providerId: 'provider-a',
          modelId: 'model-a',
          reasoningEffort: 'high',
        },
        {
          providerConfigs: [provider('provider-a')],
          modelsByProvider: {
            'provider-a': [
              model('provider-a', 'model-a', {
                reasoningEfforts: ['low', 'medium', 'high'],
                defaultReasoningEffort: 'medium',
              }),
            ],
          },
          getAvailableReasoningEfforts: () => [],
        }
      )
    ).toEqual({
      mode: 'dedicated',
      providerId: 'provider-a',
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
  });

  it('drops an invalid dedicated reasoning effort', () => {
    expect(
      normalizeMetadataModelConfig(
        {
          mode: 'dedicated',
          providerId: 'provider-a',
          modelId: 'model-a',
          reasoningEffort: 'xhigh',
        },
        {
          providerConfigs: [provider('provider-a')],
          modelsByProvider: {
            'provider-a': [
              model('provider-a', 'model-a', {
                reasoningEfforts: ['low', 'medium', 'high'],
              }),
            ],
          },
          getAvailableReasoningEfforts: () => [],
        }
      )
    ).toEqual({
      mode: 'dedicated',
      providerId: 'provider-a',
      modelId: 'model-a',
      reasoningEffort: null,
    });
  });

  it('repairs a dedicated model that belongs to another provider', () => {
    expect(
      normalizeMetadataModelConfig(
        {
          mode: 'dedicated',
          providerId: 'provider-a',
          modelId: 'model-b',
          reasoningEffort: 'high',
        },
        {
          providerConfigs: [provider('provider-a'), provider('provider-b')],
          modelsByProvider: {
            'provider-a': [model('provider-a', 'model-a')],
            'provider-b': [model('provider-b', 'model-b')],
          },
          getAvailableReasoningEfforts: () => ['low', 'medium'],
        }
      )
    ).toEqual({
      mode: 'dedicated',
      providerId: 'provider-a',
      modelId: 'model-a',
      reasoningEffort: null,
    });
  });

  it('falls back to conversation when no dedicated provider/model is usable', () => {
    const unavailableProvider = provider('disabled', {
      isEnabled: false,
      hasStoredApiKey: false,
    });
    expect(providerCanGenerateMetadata(unavailableProvider)).toBe(false);
    expect(
      normalizeMetadataModelConfig(
        {
          mode: 'dedicated',
          providerId: 'missing-provider',
          modelId: 'missing-model',
          reasoningEffort: null,
        },
        {
          providerConfigs: [unavailableProvider],
          modelsByProvider: {
            disabled: [model('disabled', 'model-disabled')],
          },
        }
      )
    ).toEqual({ mode: 'conversation' });
  });
});
