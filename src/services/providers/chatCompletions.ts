import { getProviderConfig } from '../aiConfig';
import { GENERIC_REQUEST_TIMEOUT_MS, GENERIC_STREAM_IDLE_TIMEOUT_MS, readStreamChunkWithIdleTimeout } from '../ai/httpTransport';
import { assertSecureProviderEndpoint, readBoundedProviderError } from '../providerEndpoint';
import { tauriFetch } from '../tauriHttp';
import type {
  ChatCompletionRequestDto,
  ChatCompletionResponseDto,
} from '../contracts/dtos';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getStringProperty = (
  value: unknown,
  key: string
): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const property = value[key];
  return typeof property === 'string' ? property : undefined;
};

const getErrorMessage = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }

  return getStringProperty(payload.error, 'message') ?? getStringProperty(payload, 'message');
};

const getAssistantContent = (payload: unknown): string => {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return '';
  }

  const [firstChoice] = payload.choices;
  if (!isRecord(firstChoice)) {
    return '';
  }

  return getStringProperty(firstChoice.message, 'content') ?? '';
};

const MAX_CHAT_RESPONSE_BYTES = 8 * 1024 * 1024;

const readChatResponse = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CHAT_RESPONSE_BYTES) {
    throw new Error('Chat response exceeded the size limit.');
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readStreamChunkWithIdleTimeout(
        reader, GENERIC_STREAM_IDLE_TIMEOUT_MS, signal
      );
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CHAT_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error('Chat response exceeded the size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
};

export const sendChatCompletion = async (
  request: ChatCompletionRequestDto
): Promise<ChatCompletionResponseDto> => {
  const { providerId, modelId, messages } = request;
  const { apiKey, baseUrl } = await getProviderConfig(providerId);

  if (!apiKey) {
    throw {
      code: 'MISSING_API_KEY',
      message: `Missing API key for provider: ${providerId}`,
    };
  }

  if (!baseUrl) {
    throw {
      code: 'MISSING_BASE_URL',
      message: `Missing base URL for provider: ${providerId}`,
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  if (providerId === 'openrouter') {
    if (typeof window !== 'undefined') {
      headers['HTTP-Referer'] = window.location.origin;
    }
    headers['X-Title'] = 'Macro';
  }

  const url = `${baseUrl}/chat/completions`;
  assertSecureProviderEndpoint(url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GENERIC_REQUEST_TIMEOUT_MS);
  let response: Response;
  let payload: unknown = null;
  try {
    response = await tauriFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        stream: false,
      }),
      signal: controller.signal,
      maxRedirections: 0,
    });

    if (response.ok) {
      try {
        payload = await readChatResponse(response, controller.signal);
      } catch (error) {
        if (error instanceof SyntaxError) payload = null;
        else throw error;
      }
    } else {
      const errorText = await readBoundedProviderError(response);
      try {
        payload = JSON.parse(errorText);
      } catch {
        payload = null;
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorMessage =
      getErrorMessage(payload) ||
      `Chat request failed (${response.status})`;
    throw {
      code: 'CHAT_REQUEST_FAILED',
      message: errorMessage,
      details: payload,
    };
  }

  const content = getAssistantContent(payload);
  return {
    message: {
      role: 'assistant',
      content,
    },
  };
};
