import { beforeEach, describe, expect, it, mock } from 'bun:test';

let importCounter = 0;

const tauriFetchMock = mock(
  async (_input: string, _init?: RequestInit) => new Response()
);
let pageLifecycleController = new AbortController();
let pageShuttingDown = false;

const loadProviderApi = async () => {
  mock.module('@tauri-apps/plugin-http', () => ({
    fetch: tauriFetchMock,
  }));

  mock.module('../utils/pageLifecycle', () => ({
    getPageLifecycleSignal: () => pageLifecycleController.signal,
    isPageShuttingDown: () => pageShuttingDown,
  }));

  importCounter += 1;
  return import(`./providerApi.ts?provider-api-test=${importCounter}`);
};

describe('providerApi fetchModelsFromProvider', () => {
  beforeEach(() => {
    mock.restore();
    tauriFetchMock.mockClear();
    pageLifecycleController = new AbortController();
    pageShuttingDown = false;
  });

  it('returns normalized models on success', async () => {
    tauriFetchMock.mockImplementation(async () => new Response(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'model-a', name: 'Model A', owned_by: 'team-a' },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    ));

    const { fetchModelsFromProvider } = await loadProviderApi();
    const result = await fetchModelsFromProvider({
      baseUrl: 'https://example.com/v1',
      providerId: 'custom',
    });

    expect(result).toEqual({
      success: true,
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          created: undefined,
          owned_by: 'team-a',
          description: undefined,
          pricing: undefined,
        },
      ],
    });
  });

  it('returns a timeout message when the request is aborted by the local timeout', async () => {
    tauriFetchMock.mockImplementation(
      async (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            'abort',
            () => reject(new Error('Request cancelled')),
            { once: true }
          );
        })
    );

    const { fetchModelsFromProvider } = await loadProviderApi();
    const result = await fetchModelsFromProvider({
      baseUrl: 'https://example.com/v1',
      providerId: 'custom',
      timeout: 1,
    });

    expect(result.success).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toContain('Connection timeout');
  });

  it('returns request cancelled when the page lifecycle aborts the request', async () => {
    tauriFetchMock.mockImplementation(
      async (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            'abort',
            () => reject(new Error('Request cancelled')),
            { once: true }
          );
        })
    );

    const { fetchModelsFromProvider } = await loadProviderApi();
    setTimeout(() => {
      pageShuttingDown = true;
      pageLifecycleController.abort('hmr-dispose');
    }, 0);

    const result = await fetchModelsFromProvider({
      baseUrl: 'https://example.com/v1',
      providerId: 'custom',
      timeout: 100,
    });

    expect(result).toEqual({
      success: false,
      models: [],
      error: 'Request cancelled.',
    });
  });

  it('keeps supported_parameters from provider model payloads', async () => {
    tauriFetchMock.mockImplementation(async () => new Response(
      JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'openai/gpt-5',
            name: 'GPT-5',
            supported_parameters: ['reasoning', 'tools'],
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    ));

    const { fetchModelsFromProvider } = await loadProviderApi();
    const result = await fetchModelsFromProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      providerId: 'openrouter',
    });

    expect(result.success).toBe(true);
    expect(result.models[0]?.supported_parameters).toEqual(['reasoning', 'tools']);
  });

  it('falls back to chat completions when the models endpoint is unsupported', async () => {
    tauriFetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith('/models')) {
        return new Response('missing', { status: 404 });
      }

      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({
          id: 'resp_123',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });

    const { probeProviderReachability } = await loadProviderApi();
    const result = await probeProviderReachability({
      baseUrl: 'https://api.minimax.io/v1',
      providerId: 'custom',
      preferredModelId: 'MiniMax-M2.7',
    });

    expect(result).toMatchObject({
      success: true,
      status: 'reachable',
      source: 'chat_completions_probe',
      modelIdUsed: 'MiniMax-M2.7',
    });
  });

  it('returns probe_unsupported when verification needs a model and none is known', async () => {
    tauriFetchMock.mockImplementation(async (input: string) => {
      if (String(input).endsWith('/models')) {
        return new Response('missing', { status: 404 });
      }

      throw new Error('unexpected request');
    });

    const { probeProviderReachability } = await loadProviderApi();
    const result = await probeProviderReachability({
      baseUrl: 'https://api.minimax.io/v1',
      providerId: 'custom',
    });

    expect(result).toMatchObject({
      success: false,
      status: 'probe_unsupported',
      source: 'chat_completions_probe',
    });
    expect(result.message).toContain('requires a known model');
  });
});
