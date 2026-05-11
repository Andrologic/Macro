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

  it('prefers explicit context window metadata before input limits', () => {
    expect(
      inferProviderContextWindowTokens({
        context_window_tokens: 200_000,
        context_window: 128_000,
        max_input_tokens: 64_000,
      }),
    ).toBe(200_000);
    expect(
      inferProviderContextWindowTokens({
        context_window: 128_000,
        max_input_tokens: 64_000,
      }),
    ).toBe(128_000);
    expect(
      inferProviderContextWindowTokens({
        max_input_tokens: 64_000,
      }),
    ).toBe(64_000);
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
});
