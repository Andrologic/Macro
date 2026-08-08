import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

type FetchCall = {
  url: string;
  init?: RequestInit;
};

let importCounter = 0;
let providerConfig: { apiKey?: string; baseUrl?: string } = {
  apiKey: 'test-api-key',
  baseUrl: 'https://api.example.com/v1',
};
let fetchCalls: FetchCall[] = [];

const originalFetch = globalThis.fetch;

const loadModule = async () => {
  const aiConfigMock = () => ({
    getProviderConfig: mock(async () => providerConfig),
  });

  mock.module('../aiConfig', aiConfigMock);
  mock.module('../aiConfig.ts', aiConfigMock);

  importCounter += 1;
  return import(`./chatCompletions.ts?chat-completions-test=${importCounter}`);
};

const buildRequest = (providerId = 'openai') => ({
  providerId,
  modelId: 'model-1',
  messages: [
    {
      role: 'user' as const,
      content: 'Hello',
    },
  ],
});

describe('sendChatCompletion', () => {
  beforeEach(() => {
    mock.restore();
    providerConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.com/v1',
    };
    (globalThis as typeof globalThis & {
      __CHAT_COMPLETIONS_PROVIDER_CONFIG__?: { apiKey?: string; baseUrl?: string };
    }).__CHAT_COMPLETIONS_PROVIDER_CONFIG__ = providerConfig;
    fetchCalls = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Hello from runtime',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & {
      __CHAT_COMPLETIONS_PROVIDER_CONFIG__?: { apiKey?: string; baseUrl?: string };
    }).__CHAT_COMPLETIONS_PROVIDER_CONFIG__;
    globalThis.fetch = originalFetch;
  });

  it('sends a non-streaming chat completion request', async () => {
    const { sendChatCompletion } = await loadModule();

    const result = await sendChatCompletion(buildRequest());

    expect(result).toEqual({
      message: {
        role: 'assistant',
        content: 'Hello from runtime',
      },
    });
    expect(fetchCalls[0]?.url).toBe('https://api.example.com/v1/chat/completions');
    expect(fetchCalls[0]?.init?.body).toBe(
      JSON.stringify({
        model: 'model-1',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      })
    );
  });

  it('adds OpenRouter attribution headers', async () => {
    const { sendChatCompletion } = await loadModule();

    await sendChatCompletion(buildRequest('openrouter'));

    expect(fetchCalls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer test-api-key',
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Macro',
    });
  });

  it('throws when the provider has no API key', async () => {
    providerConfig = { baseUrl: 'https://api.example.com/v1' };
    (globalThis as typeof globalThis & {
      __CHAT_COMPLETIONS_PROVIDER_CONFIG__?: { apiKey?: string; baseUrl?: string };
    }).__CHAT_COMPLETIONS_PROVIDER_CONFIG__ = providerConfig;
    const { sendChatCompletion } = await loadModule();

    await expect(sendChatCompletion(buildRequest())).rejects.toMatchObject({
      code: 'MISSING_API_KEY',
      message: 'Missing API key for provider: openai',
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it('throws when the provider has no base URL', async () => {
    providerConfig = { apiKey: 'test-api-key' };
    (globalThis as typeof globalThis & {
      __CHAT_COMPLETIONS_PROVIDER_CONFIG__?: { apiKey?: string; baseUrl?: string };
    }).__CHAT_COMPLETIONS_PROVIDER_CONFIG__ = providerConfig;
    const { sendChatCompletion } = await loadModule();

    await expect(sendChatCompletion(buildRequest())).rejects.toMatchObject({
      code: 'MISSING_BASE_URL',
      message: 'Missing base URL for provider: openai',
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it('surfaces HTTP error messages from provider payloads', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          error: {
            message: 'Provider rejected the request',
          },
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }
      );
    }) as unknown as typeof fetch;
    const { sendChatCompletion } = await loadModule();

    await expect(sendChatCompletion(buildRequest())).rejects.toMatchObject({
      code: 'CHAT_REQUEST_FAILED',
      message: 'Provider rejected the request',
      details: {
        error: {
          message: 'Provider rejected the request',
        },
      },
    });
  });
});
