import { getProviderConfig } from '../aiConfig';
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

  const response = await fetch(`${baseUrl}/chat/completions`, {
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
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
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
