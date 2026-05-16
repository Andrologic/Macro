import { describe, expect, it } from 'bun:test';

import {
  COMPACTION_BUFFER,
  OUTPUT_TOKEN_MAX,
  contextLimitsToFootprintFields,
  resolveModelContextLimits,
  resolveUsableContextTokens,
} from './modelContextLimits';

describe('modelContextLimits', () => {
  it('marks explicit provider metadata as authoritative', () => {
    const limits = resolveModelContextLimits({
      providerType: 'openai',
      modelId: 'model-with-metadata',
      modelContextWindowTokens: 200_000,
      inputLimitTokens: 180_000,
      outputLimitTokens: 64_000,
      contextWindowSource: 'provider_metadata',
    });

    expect(limits).toEqual({
      contextTokens: 200_000,
      inputTokens: 180_000,
      outputTokens: 64_000,
      source: 'provider_metadata',
      isAuthoritative: true,
      confidence: 'verified',
    });
  });

  it('maps resolved limits to footprint fields without renaming boundary contracts', () => {
    expect(
      contextLimitsToFootprintFields({
        contextTokens: 200_000,
        inputTokens: 180_000,
      outputTokens: 16_000,
      source: 'provider_metadata',
      isAuthoritative: true,
      confidence: 'verified',
    }),
    ).toEqual({
      modelContextWindowTokens: 200_000,
      inputLimitTokens: 180_000,
      outputLimitTokens: 16_000,
      contextLimitSource: 'provider_metadata',
      isContextLimitAuthoritative: true,
      contextLimitConfidence: 'verified',
      contextLimitWarning: undefined,
    });
  });

  it('marks Macro provider fallbacks as non-authoritative', () => {
    const limits = resolveModelContextLimits({
      providerType: 'openai',
      modelId: 'unknown-model',
    });

    expect(limits.contextTokens).toBe(64_000);
    expect(limits.source).toBe('macro_fallback');
    expect(limits.isAuthoritative).toBe(false);
    expect(limits.confidence).toBe('fallback');
    expect(limits.warning).toContain('Limite estimée par Macro');
  });

  it('uses the OpenCode Go Kimi enrichment as an authoritative model source', () => {
    const limits = resolveModelContextLimits({
      providerType: 'openai',
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'kimi-k2.6',
    });

    expect(limits.contextTokens).toBe(128_000);
    expect(limits.source).toBe('models_dev');
    expect(limits.isAuthoritative).toBe(true);
    expect(limits.confidence).toBe('catalog');
  });

  it('uses the OpenCode Go Qwen 3.6 catalog window instead of the generic 128k lane', () => {
    const limits = resolveModelContextLimits({
      providerType: 'openai',
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'qwen3.6-plus',
    });

    expect(limits.contextTokens).toBe(262_144);
    expect(limits.outputTokens).toBe(66_000);
    expect(limits.source).toBe('models_dev');
    expect(limits.isAuthoritative).toBe(true);
  });

  it('marks provider overflow learned limits as temporary diagnostics', () => {
    const limits = resolveModelContextLimits({
      providerType: 'openai',
      modelId: 'model-with-overflow',
      modelContextWindowTokens: 96_000,
      contextWindowSource: 'provider_overflow_error',
      contextLimitsUpdatedAt: '2026-05-11T00:00:00.000Z',
    });

    expect(limits.source).toBe('provider_overflow_error');
    expect(limits.isAuthoritative).toBe(true);
    expect(limits.confidence).toBe('learned');
    expect(limits.warning).toContain('erreur provider');
  });

  it('caps output reservation at the OpenCode maximum', () => {
    const budget = resolveUsableContextTokens({
      contextTokens: 200_000,
      outputTokens: 64_000,
    });

    expect(OUTPUT_TOKEN_MAX).toBe(32_000);
    expect(budget.maxOutputTokens).toBe(32_000);
    expect(budget.outputReserveTokens).toBe(32_000);
    expect(budget.reservedTokens).toBe(COMPACTION_BUFFER);
    expect(budget.usableContextTokens).toBe(168_000);
  });

  it('uses input limit minus the default reserved output budget when available', () => {
    const budget = resolveUsableContextTokens({
      contextTokens: 200_000,
      inputTokens: 120_000,
      outputTokens: 10_000,
    });

    expect(budget.reservedTokens).toBe(10_000);
    expect(budget.outputReserveTokens).toBe(10_000);
    expect(budget.usableContextTokens).toBe(110_000);
  });

  it('lets an explicit reserved token budget win', () => {
    const budget = resolveUsableContextTokens({
      contextTokens: 200_000,
      inputTokens: 120_000,
      outputTokens: 10_000,
      explicitReservedTokens: 4_000,
    });

    expect(budget.reservedTokens).toBe(4_000);
    expect(budget.outputReserveTokens).toBe(4_000);
    expect(budget.usableContextTokens).toBe(116_000);
  });
});
