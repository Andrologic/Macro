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
});
