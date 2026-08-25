import { describe, expect, it } from 'bun:test';
import { getReasoningCapabilityForModel, getValidReasoningEffort } from './reasoningCatalog';

describe('reasoningCatalog', () => {
  it('resolves GPT-5.4 pro capabilities conservatively', () => {
    expect(
      getReasoningCapabilityForModel({
        providerType: 'openai',
        modelId: 'gpt-5.4-pro',
      })
    ).toMatchObject({
      reasoningEfforts: ['medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'high',
      transportMode: 'openai_effort',
      source: 'embedded_catalog',
    });
  });

  it('resolves cached ChatGPT GPT-5 families with visible reasoning choices', () => {
    expect(
      getReasoningCapabilityForModel({
        providerType: 'chatgpt',
        modelId: 'gpt-5.4-mini',
      })
    ).toMatchObject({
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium',
    });

    expect(
      getReasoningCapabilityForModel({
        providerType: 'chatgpt',
        modelId: 'gpt-5.3-codex',
      })
    ).toMatchObject({
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium',
    });
  });

  it('requires explicit OpenRouter reasoning support in supported_parameters', () => {
    expect(
      getReasoningCapabilityForModel({
        providerType: 'openrouter',
        modelId: 'openai/gpt-5',
        supportedParameters: ['tools', 'response_format'],
      }).reasoningEfforts
    ).toEqual([]);

    expect(
      getReasoningCapabilityForModel({
        providerType: 'openrouter',
        modelId: 'openai/gpt-5',
        supportedParameters: ['reasoning', 'tools'],
      }).reasoningEfforts
    ).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('preserves provider-defined effort values', () => {
    const capability = getReasoningCapabilityForModel({
      providerType: 'copilot',
      modelId: 'gpt-5',
      supportedReasoningEfforts: ['low', 'medium', 'bogus'],
      defaultReasoningEffort: 'medium',
    });

    expect(capability.reasoningEfforts).toEqual(['low', 'medium', 'bogus']);
    expect(getValidReasoningEffort(capability, 'bogus')).toBe('bogus');
    expect(capability.source).toBe('provider_metadata');
  });

  it('orders canonical efforts before custom values without dropping either', () => {
    const capability = getReasoningCapabilityForModel({
      providerType: 'copilot',
      modelId: 'future-model',
      supportedReasoningEfforts: ['turbo', 'max', 'low', 'turbo', 'xhigh'],
      defaultReasoningEffort: 'turbo',
    });

    expect(capability.reasoningEfforts).toEqual(['low', 'xhigh', 'max', 'turbo']);
    expect(capability.defaultReasoningEffort).toBe('turbo');
  });

  it('gives a manual override priority over provider and catalog metadata', () => {
    const capability = getReasoningCapabilityForModel({
      providerType: 'openai',
      modelId: 'gpt-5',
      manualReasoningEfforts: ['high', 'custom'],
      manualDefaultReasoningEffort: 'custom',
      supportedReasoningEfforts: ['low', 'medium'],
      defaultReasoningEffort: 'medium',
    });

    expect(capability).toMatchObject({
      reasoningEfforts: ['high', 'custom'],
      defaultReasoningEffort: 'custom',
      configurable: true,
      source: 'manual_override',
    });
  });

  it('keeps a single manually configured effort selectable', () => {
    expect(
      getReasoningCapabilityForModel({
        providerType: 'openai',
        modelId: 'private-reasoner',
        manualReasoningEfforts: ['high'],
        manualDefaultReasoningEffort: 'high',
      }),
    ).toMatchObject({
      reasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      configurable: true,
      source: 'manual_override',
    });
  });

  it('supports current GPT-5.6 max reasoning', () => {
    expect(
      getReasoningCapabilityForModel({
        providerType: 'openai',
        modelId: 'gpt-5.6',
      }),
    ).toMatchObject({
      reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'medium',
    });
  });
});
