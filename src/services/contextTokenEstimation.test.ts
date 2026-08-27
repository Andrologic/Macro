import { describe, expect, it } from 'bun:test';

import {
  estimateImageContextTokens,
  estimateStructuredContext,
  estimateStructuredContextTokens,
} from './contextTokenEstimation';

describe('estimateImageContextTokens', () => {
  it('uses the GPT-5.6 patch formula with actual image dimensions', () => {
    expect(
      estimateImageContextTokens({
        metadata: { width: 1024, height: 1024 },
        context: { providerType: 'openai', modelId: 'gpt-5.6' },
      })
    ).toMatchObject({
      tokens: 1229,
      source: 'openai_patch',
      confidence: 'model_formula',
      hasKnownDimensions: true,
    });
  });

  it('uses the GPT-4.1 tiled formula and honors low detail', () => {
    const context = { providerType: 'openai', modelId: 'gpt-4.1' };

    expect(
      estimateImageContextTokens({
        metadata: { width: 1024, height: 1024 },
        context,
      }).tokens
    ).toBe(765);
    expect(
      estimateImageContextTokens({
        metadata: { width: 1024, height: 1024, detail: 'low' },
        context,
      }).tokens
    ).toBe(85);
  });

  it('uses provider formulas for Anthropic and Gemini', () => {
    expect(
      estimateImageContextTokens({
        metadata: { width: 1000, height: 1000 },
        context: { providerType: 'anthropic', modelId: 'claude-sonnet-4-5' },
      }).tokens
    ).toBe(1296);
    expect(
      estimateImageContextTokens({
        metadata: { width: 1920, height: 1080 },
        context: { providerType: 'anthropic', modelId: 'claude-opus-4-6' },
      }).tokens
    ).toBe(1560);
    expect(
      estimateImageContextTokens({
        metadata: { width: 1920, height: 1080 },
        context: { providerType: 'anthropic', modelId: 'claude-opus-4-7' },
      }).tokens
    ).toBe(2691);
    expect(
      estimateImageContextTokens({
        metadata: { width: 320, height: 180 },
        context: { providerType: 'google', modelId: 'gemini-2.5-pro' },
      }).tokens
    ).toBe(258);
  });

  it('reports unknown dimensions instead of inventing a fixed image cost', () => {
    expect(
      estimateImageContextTokens({
        context: { providerType: 'openai', modelId: 'gpt-5.6' },
      })
    ).toMatchObject({
      tokens: 0,
      source: 'unknown_dimensions',
      confidence: 'unknown',
      hasKnownDimensions: false,
    });
  });
});

describe('estimateStructuredContext', () => {
  it('separates decoded image context from Base64 transport size', () => {
    const estimate = estimateStructuredContext(
      {
        type: 'image',
        url: `data:image/png;base64,${'a'.repeat(900_000)}`,
      },
      {
        imageMetadata: [{ width: 1227, height: 433 }],
        context: { providerType: 'openai', modelId: 'gpt-5.6' },
      }
    );

    expect(estimate.imageTokens).toBe(656);
    expect(estimate.imageTransportBytes).toBe(675_000);
    expect(estimate.totalTokens).toBeLessThan(700);
    expect(estimate.imagesWithKnownDimensions).toBe(1);
  });

  it('does not fail on cyclic provider data', () => {
    const value: Record<string, unknown> = {
      image_url: 'data:image/png;base64,abc',
    };
    value.self = value;

    expect(estimateStructuredContextTokens(value)).toBeGreaterThan(0);
    expect(estimateStructuredContextTokens(value)).toBeLessThan(100);
  });

  it('sanitizes native Anthropic and Gemini image payloads', () => {
    const encoded = 'a'.repeat(900_000);
    const options = {
      imageMetadata: [{ width: 1000, height: 1000 }],
      context: { providerType: 'anthropic', modelId: 'claude-sonnet-4-5' },
    };
    const anthropic = estimateStructuredContext(
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: encoded },
      },
      options
    );
    const gemini = estimateStructuredContext(
      {
        inlineData: { mimeType: 'image/png', data: encoded },
      },
      {
        imageMetadata: options.imageMetadata,
        context: { providerType: 'google', modelId: 'gemini-2.5-pro' },
      }
    );

    expect(anthropic.imageTokens).toBe(1296);
    expect(anthropic.imageTransportBytes).toBe(675_000);
    expect(anthropic.totalTokens).toBeLessThan(1350);
    expect(gemini.imageTokens).toBe(1032);
    expect(gemini.imageTransportBytes).toBe(675_000);
    expect(gemini.totalTokens).toBeLessThan(1100);
  });
});
