import { beforeEach, describe, expect, it } from 'bun:test';

import { __testables as catalogTestables } from './modelContextCatalog';
import {
  buildCatalogModelContextLimitOverlay,
  buildProviderModelContextLimitOverlay,
  enrichModelWithCatalogContextLimits,
  inferProviderContextWindowTokens,
  inferProviderInputLimitTokens,
  inferProviderOutputLimitTokens,
  mergeProviderModelContextLimitOverlays,
} from './providerModelContextLimits';

describe('providerModelContextLimits', () => {
  beforeEach(() => {
    window.localStorage.clear();
    catalogTestables.reset();
  });

  it('prefers explicit context window metadata and never treats max_input_tokens as a context window', () => {
    expect(
      inferProviderContextWindowTokens({
        context_window_tokens: 200_000,
        context_window: 128_000,
        context_length: 100_000,
        max_input_tokens: 64_000,
      }),
    ).toBe(200_000);
    expect(
      inferProviderContextWindowTokens({
        context_window: 128_000,
        context_length: 100_000,
        max_input_tokens: 64_000,
      }),
    ).toBe(128_000);
    expect(
      inferProviderContextWindowTokens({
        context_length: 256_000,
        max_input_tokens: 64_000,
      }),
    ).toBe(256_000);
    expect(
      inferProviderContextWindowTokens({
        top_provider: { context_length: 300_000 },
        max_input_tokens: 64_000,
      }),
    ).toBe(300_000);
    expect(
      inferProviderContextWindowTokens({
        max_input_tokens: 64_000,
      }),
    ).toBeNull();
  });

  it('reads input and output limit aliases from provider models', () => {
    expect(inferProviderInputLimitTokens({ max_input_tokens: 120_000 })).toBe(
      120_000,
    );
    expect(
      inferProviderOutputLimitTokens({
        max_output_tokens: 16_000,
        output_tokens: 8_000,
        max_completion_tokens: 4_000,
      }),
    ).toBe(16_000);
    expect(inferProviderOutputLimitTokens({ output_tokens: 8_000 })).toBe(
      8_000,
    );
    expect(
      inferProviderOutputLimitTokens({ max_completion_tokens: 4_000 }),
    ).toBe(4_000);
    expect(
      inferProviderOutputLimitTokens({
        top_provider: { max_completion_tokens: 6_000 },
      }),
    ).toBe(6_000);
  });

  it('does not treat LM Studio max context length as the active budget', () => {
    expect(
      inferProviderContextWindowTokens({
        context_length: 32_768,
        max_context_length: 131_072,
      } as Parameters<typeof inferProviderContextWindowTokens>[0] & { max_context_length: number }),
    ).toBe(32_768);
    expect(
      inferProviderContextWindowTokens({
        max_context_length: 131_072,
      } as Parameters<typeof inferProviderContextWindowTokens>[0] & { max_context_length: number }),
    ).toBeNull();
  });

  it('builds and merges AI model overlays without changing unrelated models', () => {
    const overlay = buildProviderModelContextLimitOverlay({
      id: 'model-a',
      context_window_tokens: 200_000,
      max_input_tokens: 180_000,
      max_output_tokens: 16_000,
    });

    expect(overlay).toEqual({
      contextWindowTokens: 200_000,
      inputLimitTokens: 180_000,
      outputLimitTokens: 16_000,
      contextWindowSource: 'provider_metadata',
    });

    const merged = mergeProviderModelContextLimitOverlays(
      [
        { id: 'model-a', name: 'Model A', provider_id: 'provider-1' },
        { id: 'model-b', name: 'Model B', provider_id: 'provider-1' },
      ],
      [
        {
          id: 'model-a',
          context_window_tokens: 200_000,
          max_input_tokens: 180_000,
          max_output_tokens: 16_000,
        },
      ],
    );

    expect(merged[0]).toMatchObject(overlay);
    expect(merged[1]).toEqual({
      id: 'model-b',
      name: 'Model B',
      provider_id: 'provider-1',
    });
  });

  it('preserves user context overrides while merging provider metadata', () => {
    const merged = mergeProviderModelContextLimitOverlays(
      [
        {
          id: 'model-a',
          name: 'Model A',
          provider_id: 'provider-1',
          contextWindowTokens: 16_000,
          contextWindowSource: 'user_override',
          inputLimitTokens: 12_000,
        },
      ],
      [
        {
          id: 'model-a',
          context_length: 200_000,
          max_input_tokens: 180_000,
          max_output_tokens: 16_000,
        },
      ],
    );

    expect(merged[0]).toMatchObject({
      contextWindowTokens: 16_000,
      contextWindowSource: 'user_override',
      inputLimitTokens: 180_000,
      outputLimitTokens: 16_000,
    });
  });

  it('enriches models from the catalog only when provider metadata is missing', () => {
    catalogTestables.writeCachedCatalog({
      fetchedAt: '2026-05-11T00:00:00.000Z',
      providers: {
        openai: {
          id: 'openai',
          models: {
            'gpt-test': {
              id: 'gpt-test',
              limit: { context: 111_000, output: 12_000 },
            },
          },
        },
      },
    });

    expect(
      buildCatalogModelContextLimitOverlay({
        providerType: 'openai',
        modelId: 'gpt-test',
      }),
    ).toEqual({
      contextWindowTokens: 111_000,
      outputLimitTokens: 12_000,
      contextWindowSource: 'models_dev',
      contextLimitsUpdatedAt: '2026-05-11T00:00:00.000Z',
    });

    expect(
      enrichModelWithCatalogContextLimits(
        {
          id: 'gpt-test',
          name: 'GPT Test',
          provider_id: 'provider-1',
          contextWindowTokens: 64_000,
          contextWindowSource: 'provider_metadata',
        },
        { providerType: 'openai' },
      ).contextWindowTokens,
    ).toBe(64_000);
  });

  it('lets fresh catalog metadata replace stale provider overflow limits', () => {
    catalogTestables.writeCachedCatalog({
      fetchedAt: '2026-05-11T00:00:00.000Z',
      providers: {
        openai: {
          id: 'openai',
          models: {
            'gpt-test': {
              id: 'gpt-test',
              limit: { context: 111_000, output: 12_000 },
            },
          },
        },
      },
    });

    const staleOverflow = enrichModelWithCatalogContextLimits(
      {
        id: 'gpt-test',
        name: 'GPT Test',
        provider_id: 'provider-1',
        contextWindowTokens: 64_000,
        contextWindowSource: 'provider_overflow_error',
        contextLimitsUpdatedAt: '2020-01-01T00:00:00.000Z',
      },
      { providerType: 'openai' },
    );
    const freshOverflow = enrichModelWithCatalogContextLimits(
      {
        id: 'gpt-test',
        name: 'GPT Test',
        provider_id: 'provider-1',
        contextWindowTokens: 64_000,
        contextWindowSource: 'provider_overflow_error',
        contextLimitsUpdatedAt: new Date().toISOString(),
      },
      { providerType: 'openai' },
    );

    expect(staleOverflow).toMatchObject({
      contextWindowTokens: 111_000,
      contextWindowSource: 'models_dev',
    });
    expect(freshOverflow).toMatchObject({
      contextWindowTokens: 64_000,
      contextWindowSource: 'provider_overflow_error',
    });
  });
});
