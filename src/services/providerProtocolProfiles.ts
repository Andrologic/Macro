import type { ReasoningEffort, ReasoningTransportMode } from '../types';

export type ChatCompletionRequestReasoning =
  | 'none'
  | 'openai_reasoning_effort'
  | 'openrouter_reasoning'
  | 'kimi_thinking_keep_all'
  | 'deepseek_thinking';

export type ChatCompletionReasoningReplay =
  | 'none'
  | 'reasoning_content_all'
  | 'reasoning_content_tool_chain'
  | 'reasoning_details';

export type ChatCompletionToolCallIdPolicy = 'none' | 'claude' | 'mistral';

export interface ChatCompletionProviderProtocolProfile {
  requestReasoning: ChatCompletionRequestReasoning;
  reasoningReplay: ChatCompletionReasoningReplay;
  requiresGenericStreaming: boolean;
  toolMessageName: boolean;
  toolCallIdPolicy: ChatCompletionToolCallIdPolicy;
  insertAssistantAfterToolBeforeUser: boolean;
  injectNoopToolWhenHistoryHasTools: boolean;
}

export interface ChatCompletionProviderProtocolParams {
  providerType: string;
  providerId?: string;
  baseUrl?: string;
  modelId: string;
  forceReasoningContentReplay?: boolean;
  reasoningTransportMode?: ReasoningTransportMode;
}

interface ProviderProtocolFamilies {
  isOpenRouter: boolean;
  isKimiFamily: boolean;
  isDeepSeekFamily: boolean;
  isClaudeFamily: boolean;
  isMistralFamily: boolean;
  isLiteLlmProxy: boolean;
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hasModelToken = (modelId: string, token: string): boolean =>
  new RegExp(`(^|[/:_.-])${escapeRegExp(token)}([/:_.-]|$)`, 'i').test(modelId);

const isKimiModelId = (modelId: string): boolean => {
  const normalized = modelId.toLowerCase();
  return (
    hasModelToken(normalized, 'kimi') ||
    normalized.includes('moonshotai/kimi') ||
    normalized.includes('k2p5') ||
    normalized.includes('k2.5') ||
    normalized.includes('k2-5') ||
    normalized.includes('k2.6') ||
    normalized.includes('k2-6')
  );
};

const detectProviderProtocolFamilies = (
  params: ChatCompletionProviderProtocolParams
): ProviderProtocolFamilies => {
  const providerType = params.providerType.trim().toLowerCase();
  const providerId = params.providerId?.trim().toLowerCase() || '';
  const baseUrl = params.baseUrl?.trim().toLowerCase() || '';
  const modelId = params.modelId.trim().toLowerCase();
  const providerFingerprint = `${providerId} ${providerType} ${baseUrl} ${modelId}`;
  const isOpenRouter = providerType === 'openrouter';
  const isOpenCodeGo =
    providerId === 'opencode-go' ||
    baseUrl.includes('opencode.ai/zen/go') ||
    baseUrl.includes('opencode.ai/zen/v1');
  const isKimiFamily = isOpenCodeGo
    ? isKimiModelId(modelId)
    : isKimiModelId(modelId) ||
      providerId.includes('kimi') ||
      providerId.includes('moonshot') ||
      baseUrl.includes('moonshot.ai') ||
      baseUrl.includes('platform.kimi');

  return {
    isOpenRouter,
    isKimiFamily,
    isDeepSeekFamily:
      providerType.includes('deepseek') ||
      providerId.includes('deepseek') ||
      baseUrl.includes('api.deepseek.com') ||
      hasModelToken(modelId, 'deepseek') ||
      /(^|[/:_.-])deepseek-/i.test(modelId),
    isClaudeFamily:
      providerType.includes('anthropic') ||
      hasModelToken(modelId, 'anthropic') ||
      hasModelToken(modelId, 'claude'),
    isMistralFamily:
      providerType.includes('mistral') ||
      hasModelToken(modelId, 'mistral') ||
      hasModelToken(modelId, 'devstral'),
    isLiteLlmProxy: providerFingerprint.includes('litellm'),
  };
};

const resolveRequestReasoning = (
  providerType: string,
  families: ProviderProtocolFamilies,
  transportMode?: ReasoningTransportMode
): ChatCompletionRequestReasoning => {
  if (transportMode === 'none') return 'none';
  if (transportMode === 'openai_effort') return 'openai_reasoning_effort';
  if (transportMode === 'openrouter_reasoning') return 'openrouter_reasoning';
  if (transportMode === 'deepseek_thinking') return 'deepseek_thinking';
  if (transportMode === 'kimi_fixed') return 'kimi_thinking_keep_all';
  if (families.isOpenRouter) return 'openrouter_reasoning';
  if (families.isKimiFamily) return 'kimi_thinking_keep_all';
  if (families.isDeepSeekFamily) return 'deepseek_thinking';
  if (providerType === 'openai' || providerType === 'ollama' || providerType === 'lmstudio') {
    return 'openai_reasoning_effort';
  }
  return 'none';
};

const resolveToolCallIdPolicy = (
  families: ProviderProtocolFamilies
): ChatCompletionToolCallIdPolicy => {
  if (families.isMistralFamily) return 'mistral';
  if (families.isClaudeFamily) return 'claude';
  return 'none';
};

const resolveReasoningReplay = (
  families: ProviderProtocolFamilies,
  forceReasoningContentReplay?: boolean,
  requestReasoning?: ChatCompletionRequestReasoning
): ChatCompletionReasoningReplay => {
  if (forceReasoningContentReplay) return 'reasoning_content_all';
  if (requestReasoning === 'openrouter_reasoning') return 'reasoning_details';
  if (requestReasoning === 'kimi_thinking_keep_all') return 'reasoning_content_all';
  if (requestReasoning === 'deepseek_thinking') return 'reasoning_content_tool_chain';
  if (requestReasoning === 'openai_reasoning_effort' || requestReasoning === 'none') return 'none';
  if (families.isOpenRouter) return 'reasoning_details';
  if (families.isKimiFamily) return 'reasoning_content_all';
  if (families.isDeepSeekFamily) return 'reasoning_content_tool_chain';
  return 'none';
};

export const resolveChatCompletionProviderProtocolProfile = (
  params: ChatCompletionProviderProtocolParams
): ChatCompletionProviderProtocolProfile => {
  const providerType = params.providerType.trim().toLowerCase();
  const families = detectProviderProtocolFamilies(params);
  const requestReasoning = resolveRequestReasoning(
    providerType,
    families,
    params.reasoningTransportMode
  );
  const reasoningReplay = resolveReasoningReplay(
    families,
    params.forceReasoningContentReplay,
    params.reasoningTransportMode === undefined ? undefined : requestReasoning
  );

  return {
    requestReasoning,
    reasoningReplay,
    requiresGenericStreaming: reasoningReplay !== 'none',
    toolMessageName:
      params.reasoningTransportMode === undefined
        ? families.isKimiFamily
        : requestReasoning === 'kimi_thinking_keep_all',
    toolCallIdPolicy: resolveToolCallIdPolicy(families),
    insertAssistantAfterToolBeforeUser: families.isMistralFamily,
    injectNoopToolWhenHistoryHasTools: families.isLiteLlmProxy,
  };
};

export const applyReasoningToChatCompletionsRequest = (
  requestBody: Record<string, unknown>,
  profile: ChatCompletionProviderProtocolProfile,
  reasoningEffort?: ReasoningEffort | null,
  options?: { enabled?: boolean }
) => {
  delete requestBody.reasoning_effort;
  delete requestBody.reasoning;
  delete requestBody.include_reasoning;
  delete requestBody.thinking;

  if (options?.enabled === false) {
    return;
  }

  if (profile.requestReasoning === 'kimi_thinking_keep_all') {
    requestBody.thinking = { type: 'enabled', keep: 'all' };
    return;
  }

  if (profile.requestReasoning === 'deepseek_thinking') {
    requestBody.thinking = { type: 'enabled' };
    if (reasoningEffort) {
      requestBody.reasoning_effort = reasoningEffort;
    }
    return;
  }

  if (!reasoningEffort) {
    return;
  }

  if (profile.requestReasoning === 'openrouter_reasoning') {
    requestBody.reasoning = { effort: reasoningEffort };
    requestBody.include_reasoning = true;
    return;
  }

  if (profile.requestReasoning === 'openai_reasoning_effort') {
    requestBody.reasoning_effort = reasoningEffort;
  }
};

export const shouldRequestProviderReasoning = (
  profile: ChatCompletionProviderProtocolProfile,
  reasoningEffort?: ReasoningEffort | null,
  options?: { enabled?: boolean }
): boolean => {
  if (options?.enabled === false) {
    return false;
  }

  if (
    profile.requestReasoning === 'kimi_thinking_keep_all' ||
    profile.requestReasoning === 'deepseek_thinking'
  ) {
    return true;
  }

  return Boolean(
    reasoningEffort &&
      (profile.requestReasoning === 'openai_reasoning_effort' ||
        profile.requestReasoning === 'openrouter_reasoning')
  );
};
