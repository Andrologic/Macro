import { describe, expect, it } from 'bun:test';
import {
  applyReasoningToChatCompletionsRequest,
  resolveChatCompletionProviderProtocolProfile,
  shouldRequestProviderReasoning,
} from './providerProtocolProfiles';

describe('provider protocol profiles', () => {
  it('enables Kimi preserved thinking for OpenCode Go Kimi models only', () => {
    const kimiProfile = resolveChatCompletionProviderProtocolProfile({
      providerId: 'opencode-go',
      providerType: 'openai',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'kimi-k2.6',
    });
    expect(kimiProfile).toMatchObject({
      requestReasoning: 'kimi_thinking_keep_all',
      reasoningReplay: 'reasoning_content_all',
      toolMessageName: true,
    });

    const body: Record<string, unknown> = {};
    applyReasoningToChatCompletionsRequest(body, kimiProfile, 'high');
    expect(body).toEqual({
      thinking: { type: 'enabled', keep: 'all' },
    });
    expect(shouldRequestProviderReasoning(kimiProfile, null)).toBe(true);

    applyReasoningToChatCompletionsRequest(body, kimiProfile, 'high', { enabled: false });
    expect(body).toEqual({});
    expect(shouldRequestProviderReasoning(kimiProfile, 'high', { enabled: false })).toBe(false);

    const glmProfile = resolveChatCompletionProviderProtocolProfile({
      providerId: 'opencode-go',
      providerType: 'openai',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'glm-5',
    });
    expect(glmProfile.requestReasoning).toBe('openai_reasoning_effort');
    expect(glmProfile.reasoningReplay).toBe('none');
    expect(glmProfile.requiresGenericStreaming).toBe(false);
    expect(glmProfile.toolMessageName).toBe(false);
  });

  it('uses provider-specific reasoning contracts for DeepSeek and OpenRouter', () => {
    const deepSeekProfile = resolveChatCompletionProviderProtocolProfile({
      providerId: 'deepseek',
      providerType: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-v4-pro',
    });
    expect(deepSeekProfile.requestReasoning).toBe('deepseek_thinking');
    expect(deepSeekProfile.reasoningReplay).toBe('reasoning_content_tool_chain');

    const deepSeekBody: Record<string, unknown> = {};
    applyReasoningToChatCompletionsRequest(deepSeekBody, deepSeekProfile, 'medium');
    expect(deepSeekBody).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'medium',
    });

    const openRouterProfile = resolveChatCompletionProviderProtocolProfile({
      providerId: 'openrouter',
      providerType: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.5',
    });
    expect(openRouterProfile.requestReasoning).toBe('openrouter_reasoning');
    expect(openRouterProfile.reasoningReplay).toBe('reasoning_details');
    expect(openRouterProfile.requiresGenericStreaming).toBe(true);

    const openRouterKimiProfile = resolveChatCompletionProviderProtocolProfile({
      providerId: 'openrouter',
      providerType: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
    });
    expect(openRouterKimiProfile.requestReasoning).toBe('openrouter_reasoning');
    expect(openRouterKimiProfile.reasoningReplay).toBe('reasoning_details');

    const openRouterKimiBody: Record<string, unknown> = {};
    applyReasoningToChatCompletionsRequest(openRouterKimiBody, openRouterKimiProfile, 'medium');
    expect(openRouterKimiBody).toEqual({
      reasoning: { effort: 'medium' },
      include_reasoning: true,
    });
  });

  it('passes max and provider-defined efforts through without normalization', () => {
    const openAiProfile = resolveChatCompletionProviderProtocolProfile({
      providerType: 'openai',
      modelId: 'gpt-5.6',
    });
    const openAiBody: Record<string, unknown> = {};
    applyReasoningToChatCompletionsRequest(openAiBody, openAiProfile, 'max');
    expect(openAiBody).toEqual({ reasoning_effort: 'max' });

    const openRouterProfile = resolveChatCompletionProviderProtocolProfile({
      providerType: 'openrouter',
      modelId: 'qwen/qwen3.5',
    });
    const openRouterBody: Record<string, unknown> = {};
    applyReasoningToChatCompletionsRequest(
      openRouterBody,
      openRouterProfile,
      'provider-future-level'
    );
    expect(openRouterBody).toEqual({
      reasoning: { effort: 'provider-future-level' },
      include_reasoning: true,
    });
  });

  it('lets resolved capability transport override provider and model heuristics', () => {
    const deepSeekProfile = resolveChatCompletionProviderProtocolProfile({
      providerType: 'openai',
      modelId: 'custom-model',
      reasoningTransportMode: 'deepseek_thinking',
    });
    expect(deepSeekProfile.requestReasoning).toBe('deepseek_thinking');
    expect(deepSeekProfile.reasoningReplay).toBe('reasoning_content_tool_chain');
    expect(deepSeekProfile.requiresGenericStreaming).toBe(true);

    const disabledOpenRouterProfile = resolveChatCompletionProviderProtocolProfile({
      providerType: 'openrouter',
      modelId: 'openai/gpt-5.6',
      reasoningTransportMode: 'none',
    });
    expect(disabledOpenRouterProfile.requestReasoning).toBe('none');
    expect(disabledOpenRouterProfile.reasoningReplay).toBe('none');
    expect(disabledOpenRouterProfile.requiresGenericStreaming).toBe(false);
  });
});
