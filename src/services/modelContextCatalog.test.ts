import { beforeEach, describe, expect, it, mock } from 'bun:test';

import {
  __testables,
  lookupModelContextCatalogLimit,
  refreshModelContextCatalog,
} from './modelContextCatalog';

describe('modelContextCatalog', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __testables.reset();
  });

  it('uses the local snapshot for OpenCode Go Kimi limits offline', () => {
    const limit = lookupModelContextCatalogLimit({
      providerType: 'openai',
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'kimi-k2.6',
    });

    expect(limit).toMatchObject({
      contextTokens: 128_000,
      outputTokens: 32_000,
      source: 'models_dev',
    });
  });

  it('matches provider aliases and slash-prefixed model ids', () => {
    __testables.writeCachedCatalog({
      fetchedAt: new Date().toISOString(),
      providers: {
        openrouter: {
          id: 'openrouter',
          models: {
            'anthropic/claude-test': {
              id: 'anthropic/claude-test',
              limit: { context: 200_000, output: 64_000 },
            },
          },
        },
      },
    });

    const limit = lookupModelContextCatalogLimit({
      providerType: 'openrouter',
      modelId: 'anthropic/claude-test',
    });

    expect(limit).toMatchObject({
      contextTokens: 200_000,
      outputTokens: 64_000,
      source: 'models_dev',
    });
  });

  it('refreshes from Models.dev and stores the cache', async () => {
    const fetchImpl = mock(async () =>
      new Response(
        JSON.stringify({
          openai: {
            id: 'openai',
            models: {
              'gpt-test': {
                id: 'gpt-test',
                limit: { context: 111_000, input: 100_000, output: 10_000 },
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const status = await refreshModelContextCatalog({
      force: true,
      fetchImpl: fetchImpl as never,
    });
    const cached = window.localStorage.getItem(__testables.STORAGE_KEY);
    const limit = lookupModelContextCatalogLimit({
      providerType: 'openai',
      modelId: 'gpt-test',
    });

    expect(status.source).toBe('network');
    expect(cached).toContain('gpt-test');
    expect(limit).toMatchObject({
      contextTokens: 111_000,
      inputTokens: 100_000,
      outputTokens: 10_000,
    });
  });

  it('uses a fresh cache without a network request', async () => {
    __testables.writeCachedCatalog({
      fetchedAt: new Date().toISOString(),
      providers: {},
    });
    const fetchImpl = mock(async () => new Response('{}', { status: 200 }));

    const status = await refreshModelContextCatalog({
      fetchImpl: fetchImpl as never,
    });

    expect(status.source).toBe('cache');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
