import { describe, expect, it } from 'bun:test';
import { getReasoningCapabilityForModel, getValidReasoningEffort } from './reasoningCatalog';

describe('reasoningCatalog', () => {
  it('resolves GPT-5.4 pro capabilities conservatively', () => {
    expect(
      getReasoningCapabilityForModel({
        providerType: 'openai',
        modelId: 'gpt-5.4-pro',
      })
    ).toEqual({
      reasoningEfforts: ['medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'high',
    });
  });

  it('resolves cached ChatGPT GPT-5 families with visible reasoning choices', () => {
    expect(
      getReasoningCapabilityForModel({
        providerType: 'chatgpt',
        modelId: 'gpt-5.4-mini',
      })
    ).toEqual({
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium',
    });

    expect(
      getReasoningCapabilityForModel({
        providerType: 'chatgpt',
        modelId: 'gpt-5.3-codex',
      })
    ).toEqual({
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

  it('keeps only valid direct provider effort metadata', () => {
    const capability = getReasoningCapabilityForModel({
      providerType: 'copilot',
      modelId: 'gpt-5',
      supportedReasoningEfforts: ['low', 'medium', 'bogus'],
      defaultReasoningEffort: 'medium',
    });

    expect(capability.reasoningEfforts).toEqual(['low', 'medium']);
    expect(getValidReasoningEffort(capability, 'bogus')).toBe('medium');
  });
});
