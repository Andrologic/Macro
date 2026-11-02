import { beforeEach, describe, expect, it, mock } from 'bun:test';

import {
  __testables,
  lookupModelContextCatalogLimit,
  lookupModelReasoningCatalogCapability,
  getModelContextCatalogStatus,
  refreshModelContextCatalog,
  lookupModelCatalogMetadata,
  listProviderCatalogModels,
} from './modelContextCatalog';

describe('modelContextCatalog', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __testables.reset();
  });

  it('exposes scoped model names and capabilities without enabling models', () => {
    const models = listProviderCatalogModels({ providerType: 'openai' });
    expect(models.map((model) => model.id)).toEqual(['gpt-4o', 'gpt-4.1', 'gpt-5']);
    expect(models[0]).toMatchObject({ name: 'GPT-4o', images: true, toolCall: true });
    expect(models[0]).not.toHaveProperty('isEnabled');
    expect(lookupModelCatalogMetadata({ providerType: 'openai', modelId: 'openai/gpt-5' })?.id).toBe('gpt-5');
  });

  it('preserves unknown capability metadata and explicit false independently', () => {
    __testables.writeCachedCatalog({ fetchedAt: '2026-10-14', providers: {
      custom: { models: {
        unknown: { id: 'unknown' },
        text: { id: 'text', name: 'Text', modalities: { input: ['text'] }, tool_call: false },
      } },
    } });
    const models = listProviderCatalogModels({ providerId: 'custom' });
    expect(models[0]).not.toHaveProperty('images');
    expect(models[0]).not.toHaveProperty('toolCall');
    expect(models[1]).toMatchObject({ images: false, toolCall: false });
  });

  it('combines cache entries with scoped snapshot fallbacks, with cache precedence', () => {
    __testables.writeCachedCatalog({ fetchedAt: '2026-10-13', providers: {
      openai: { models: {
        'gpt-4o': { id: 'gpt-4o', name: 'Provider label', tool_call: false },
        custom: { id: 'custom', name: 'Custom' },
      } },
    } });
    const models = listProviderCatalogModels({ providerType: 'openai' });
    expect(models.map((model) => model.id)).toEqual(['gpt-4o', 'custom', 'gpt-4.1', 'gpt-5']);
    expect(models[0]).toMatchObject({ name: 'Provider label', toolCall: false, updatedAt: '2026-10-13' });
    expect(models[0]).not.toHaveProperty('images');
    expect(models[2]?.images).toBe(true);
    expect(listProviderCatalogModels({ providerType: 'openai', baseUrl: 'https://custom.invalid/v1' })).toEqual([]);
  });

  it('does not list a second offer or ambiguous identities', () => {
    __testables.writeCachedCatalog({ fetchedAt: '2026-10-14', providers: {
      custom: { models: { private: { id: 'private' } } },
      ambiguous1: { id: 'ambiguous', models: { one: {} } },
      ambiguous2: { id: 'ambiguous', models: { two: {} } },
      duplicate: { models: { one: { id: 'same' }, two: { id: 'same' } } },
    } });
    expect(listProviderCatalogModels({ providerType: 'openai', providerId: 'custom' }).map((model) => model.id)).toEqual(['private']);
    expect(listProviderCatalogModels({ providerId: 'ambiguous' })).toEqual([]);
    expect(listProviderCatalogModels({ providerId: 'duplicate' })).toEqual([]);
  });

  it('lists a canonical cache match only once when it shadows a snapshot identifier', () => {
    __testables.writeCachedCatalog({ fetchedAt: '2026-10-14', providers: {
      openai: { models: { renamed: { id: 'renamed', canonical_model_id: 'openai/gpt-5' } } },
    } });
    expect(listProviderCatalogModels({ providerType: 'openai' }).map((model) => model.id))
      .toEqual(['renamed', 'gpt-4o', 'gpt-4.1']);
  });

  it('uses the local snapshot for OpenCode Go Kimi limits offline', () => {
    const limit = lookupModelContextCatalogLimit({
      providerType: 'openai',
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'kimi-k2.6',
    });

    expect(limit).toMatchObject({
      contextTokens: 262_144,
      outputTokens: 65_536,
      source: 'models_dev',
    });
  });

  it('uses the local snapshot for OpenCode Go Qwen 3.6 Plus limits offline', () => {
    const limit = lookupModelContextCatalogLimit({
      providerType: 'openai',
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'qwen3.6-plus',
    });

    expect(limit).toMatchObject({
      contextTokens: 1_000_000,
      outputTokens: 65_536,
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

  it('reads reasoning metadata from the same Models.dev cache', () => {
    __testables.writeCachedCatalog({
      fetchedAt: new Date().toISOString(),
      providers: {
        openai: {
          id: 'openai',
          models: {
            'future-model': {
              id: 'future-model',
              reasoning: true,
              reasoning_options: [{ type: 'effort', values: ['low', 'max', 'future'] }],
            },
          },
        },
      },
    });

    expect(lookupModelReasoningCatalogCapability({
      providerType: 'openai',
      modelId: 'future-model',
    })).toEqual({
      reasoningEfforts: ['low', 'max'],
      defaultReasoningEffort: null,
      configurable: true,
    });
  });

  it('uses a fresh cache without a network request', async () => {
    __testables.writeCachedCatalog({
      fetchedAt: new Date().toISOString(),
      providers: { openai: { models: { test: { limit: { context: 100 } } } } },
    });
    const fetchImpl = mock(async () => new Response('{}', { status: 200 }));

    const status = await refreshModelContextCatalog({
      fetchImpl: fetchImpl as never,
    });

    expect(status.source).toBe('cache');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the latest forced refresh error when a fresh cache is reused', async () => {
    const fetchedAt = new Date().toISOString();
    __testables.writeCachedCatalog({ fetchedAt, providers: { openai: { models: { test: { limit: { context: 100 } } } } } });
    const failedStatus = await refreshModelContextCatalog({
      force: true,
      fetchImpl: mock(async () => new Response('{}', { status: 503 })) as never,
    });
    expect(failedStatus.error).toBe('Models.dev returned 503');

    const cachedStatus = await refreshModelContextCatalog({
      fetchImpl: mock(async () => new Response('{}', { status: 200 })) as never,
    });
    expect(cachedStatus).toMatchObject({
      lastFetchedAt: fetchedAt,
      source: 'cache',
      stale: false,
      error: 'Models.dev returned 503',
    });
  });

  it('distinguishes a missing synchronization from a stale cached catalog', () => {
    expect(getModelContextCatalogStatus()).toMatchObject({
      lastFetchedAt: null,
      source: 'snapshot',
      stale: true,
    });

    __testables.writeCachedCatalog({
      fetchedAt: '2020-01-01T00:00:00.000Z',
      providers: { openai: { models: { test: { limit: { context: 100 } } } } },
    });
    expect(getModelContextCatalogStatus()).toMatchObject({
      lastFetchedAt: '2020-01-01T00:00:00.000Z',
      source: 'cache',
      stale: true,
    });
  });
  it('keeps reporting the snapshot after a network fallback without cache', async () => {
    const fetchImpl = mock(async () => new Response('', { status: 503 }));

    const firstStatus = await refreshModelContextCatalog({
      force: true,
      fetchImpl: fetchImpl as never,
    });
    const secondStatus = await refreshModelContextCatalog({
      force: true,
      fetchImpl: fetchImpl as never,
    });

    expect(firstStatus.source).toBe('snapshot');
    expect(secondStatus).toMatchObject({
      lastFetchedAt: null,
      source: 'snapshot',
      stale: true,
      error: 'Models.dev returned 503',
    });
    expect(getModelContextCatalogStatus()).toMatchObject({
      lastFetchedAt: null,
      source: 'snapshot',
      stale: true,
      error: 'Models.dev returned 503',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('keeps historical fallback dates for models absent from the current source', () => {
    expect(lookupModelContextCatalogLimit({ providerType: 'copilot', modelId: 'gpt-4o' }))
      .toMatchObject({ contextTokens: 128_000, updatedAt: '2026-05-11T00:00:00.000Z' });
    expect(lookupModelContextCatalogLimit({ providerType: 'openai', modelId: 'gpt-5' }))
      .toMatchObject({ inputTokens: 272_000, updatedAt: '2026-10-14' });
  });

  it('selects exact offers before unambiguous canonical identities within one provider', () => {
    __testables.writeCachedCatalog({ fetchedAt: new Date().toISOString(), providers: {
      reseller: { models: {
        'vendor/model': { id: 'vendor/model', canonical_model_id: 'vendor/model', limit: { context: 100 } },
        'vendor/model:large': { id: 'vendor/model:large', canonical_model_id: 'vendor/model', limit: { context: 200 } },
        deployment: { id: 'deployment', canonical_model_id: 'vendor/unique', limit: { context: 300 } },
      } },
      other: { models: { deployment: { canonical_model_id: 'vendor/unique', limit: { context: 900 } } } },
    } });
    const lookup = (modelId: string) => lookupModelContextCatalogLimit({ providerType: 'openai', providerId: 'reseller', modelId });
    expect(lookup('vendor/model')?.contextTokens).toBe(100);
    expect(lookup('vendor/model:large')?.contextTokens).toBe(200);
    expect(lookup('vendor/model:free')).toBeNull();
    expect(lookup('vendor/unique')?.contextTokens).toBe(300);
    expect(lookup('model')).toBeNull();
    expect(lookup('reseller/deployment')?.contextTokens).toBe(300);
    expect(lookup('gpt-5')).toBeNull();
  });

  it('rejects ambiguous canonical identities even if the snapshot contains that identity', () => {
    __testables.writeCachedCatalog({ fetchedAt: new Date().toISOString(), providers: {
      openai: { models: {
        small: { canonical_model_id: 'openai/gpt-5', limit: { context: 100 } },
        large: { canonical_model_id: 'openai/gpt-5', limit: { context: 200 } },
      } },
    } });
    expect(lookupModelContextCatalogLimit({ providerType: 'openai', modelId: 'openai/gpt-5' })).toBeNull();
  });

  it('keeps provider identity ambiguity from falling through to a different offer', () => {
    __testables.writeCachedCatalog({ fetchedAt: new Date().toISOString(), providers: {
      first: { id: 'shared', models: { 'gpt-5': { limit: { context: 100 } } } },
      second: { id: 'shared', models: { 'gpt-5': { limit: { context: 200 } } } },
    } });
    expect(lookupModelContextCatalogLimit({ providerType: 'openai', providerId: 'shared', modelId: 'gpt-5' })).toBeNull();
  });

  it('never infers official OpenAI from a compatible or misleading endpoint', () => {
    for (const baseUrl of ['https://gateway.invalid/v1', 'https://api.openai.com.invalid/v1',
      'https://gateway.invalid/api.openai.com', 'invalid-url']) {
      expect(lookupModelContextCatalogLimit({ providerType: 'openai', providerId: 'openai', baseUrl, modelId: 'gpt-5' })).toBeNull();
    }
    expect(lookupModelContextCatalogLimit({ providerType: 'openai', baseUrl: 'https://api.openai.com/v1', modelId: 'openai/gpt-5' })?.contextTokens).toBe(400_000);
    expect(lookupModelContextCatalogLimit({ providerType: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1', modelId: 'gpt-5' })).toBeNull();
  });

  it('does not translate boolean, toggle, or budget reasoning into efforts', () => {
    expect(lookupModelReasoningCatalogCapability({ providerType: 'anthropic', modelId: 'claude-sonnet-4-5' })).toBeNull();
    expect(lookupModelReasoningCatalogCapability({ providerId: 'opencode-go', modelId: 'qwen3.6-plus' })).toBeNull();
    expect(lookupModelReasoningCatalogCapability({ providerType: 'openai', modelId: 'gpt-5' })).toMatchObject({
      reasoningEfforts: ['minimal', 'low', 'medium', 'high'], defaultReasoningEffort: null,
    });
  });

  it.each([null, [], {}, { openai: null }, { openai: { models: [] } },
    { openai: { models: { bad: null } } },
    { openai: { models: { bad: { limit: { context: '100' } } } } },
    { openai: { models: { bad: { limit: { context: 100 }, reasoning_options: [{ type: 'effort', values: 'low' }] } } } },
  ])('preserves the last valid cache after invalid network payload %j', async (payload) => {
    const fetchedAt = '2020-01-01T00:00:00.000Z';
    __testables.writeCachedCatalog({ fetchedAt, providers: { openai: { models: { safe: { limit: { context: 123 } } } } } });
    const before = window.localStorage.getItem(__testables.STORAGE_KEY);
    const status = await refreshModelContextCatalog({ force: true,
      fetchImpl: mock(async () => new Response(JSON.stringify(payload))) as never });
    expect(status).toMatchObject({ source: 'cache', stale: true, lastFetchedAt: fetchedAt });
    expect(status.error).toBeTruthy();
    expect(window.localStorage.getItem(__testables.STORAGE_KEY)).toBe(before);
    expect(lookupModelContextCatalogLimit({ providerType: 'openai', modelId: 'safe' })?.contextTokens).toBe(123);
  });

  it.each(['{broken', JSON.stringify({ fetchedAt: 'bad-date', providers: {} }),
    JSON.stringify({ fetchedAt: new Date().toISOString(), providers: { openai: { models: { bad: null } } } })])('ignores a corrupt persisted cache %s', async (raw) => {
      window.localStorage.setItem(__testables.STORAGE_KEY, raw);
      expect(() => lookupModelContextCatalogLimit({ providerType: 'openai', modelId: 'gpt-5' })).not.toThrow();
      const status = await refreshModelContextCatalog({ force: true, fetchImpl: mock(async () => { throw new Error('offline'); }) as never });
      expect(status).toMatchObject({ source: 'snapshot', error: 'offline', lastFetchedAt: null });
    });

  it('survives unavailable localStorage and keeps successful data in memory', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('denied'); } });
    try {
      expect(lookupModelContextCatalogLimit({ providerType: 'openai', modelId: 'gpt-5' })?.contextTokens).toBe(400_000);
      const status = await refreshModelContextCatalog({ force: true, fetchImpl: mock(async () => new Response(JSON.stringify({
        openai: { models: { safe: { limit: { context: 123 } } } },
      }))) as never });
      expect(status.source).toBe('network');
      expect(lookupModelContextCatalogLimit({ providerType: 'openai', modelId: 'safe' })?.contextTokens).toBe(123);
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      else delete (window as unknown as Record<string, unknown>).localStorage;
    }
  });

  it('deduplicates concurrent refreshes and retries after synchronous fetch failure', async () => {
    let release!: (response: Response) => void;
    const fetchImpl = mock(() => new Promise<Response>((resolve) => { release = resolve; }));
    const first = refreshModelContextCatalog({ force: true, fetchImpl: fetchImpl as never });
    const second = refreshModelContextCatalog({ force: true, fetchImpl: fetchImpl as never });
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(new Response(JSON.stringify({ openai: { models: { safe: { limit: { context: 123 } } } } })));
    expect(await first).toEqual(await second);
    const broken = mock(() => { throw new Error('sync failure'); });
    await refreshModelContextCatalog({ force: true, fetchImpl: broken as never });
    await refreshModelContextCatalog({ force: true, fetchImpl: broken as never });
    expect(broken).toHaveBeenCalledTimes(2);
  });

});
