import { isContextOverflowMessage } from '../contextOverflow';

export type ProviderRuntimeErrorKind =
  | 'reasoning_replay_required'
  | 'unsupported_reasoning'
  | 'rate_limited'
  | 'provider_overloaded'
  | 'network'
  | 'stream_idle_timeout'
  | 'context_overflow'
  | 'auth'
  | 'invalid_tool_protocol'
  | 'unknown';

export class ProviderRuntimeError extends Error {
  readonly kind: ProviderRuntimeErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly providerError = true;
  readonly providerMessage?: string;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly providerRawBodyExcerpt?: string;

  constructor(
    message: string,
    options: {
      kind?: ProviderRuntimeErrorKind;
      status?: number;
      retryAfterMs?: number;
      retryable?: boolean;
      providerMessage?: string;
      providerCode?: string;
      providerType?: string;
      providerRawBodyExcerpt?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = 'ProviderRuntimeError';
    this.kind = options.kind ?? 'unknown';
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.providerMessage = options.providerMessage;
    this.providerCode = options.providerCode;
    this.providerType = options.providerType;
    this.providerRawBodyExcerpt = options.providerRawBodyExcerpt;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export type ReasoningRejectionKind = 'parameter' | 'value';

export const classifyReasoningRejection = (message: string): ReasoningRejectionKind | null => {
  const normalized = message.toLowerCase();
  if (!normalized.includes('reasoning') && !normalized.includes('thinking')) {
    return null;
  }

  if (
    normalized.includes('unsupported parameter: reasoning') ||
    normalized.includes('unknown parameter: reasoning') ||
    normalized.includes('unknown parameter: reasoning_effort') ||
    normalized.includes('unsupported parameter: thinking') ||
    normalized.includes('unknown parameter: thinking') ||
    /(?:unknown|unsupported|unrecognized) (?:parameter|field)[^\n]*(?:reasoning|thinking)/.test(
      normalized
    ) ||
    /(?:reasoning|thinking)[^\n]*(?:parameter|field) (?:is )?(?:unknown|unsupported|unrecognized)/.test(
      normalized
    ) ||
    /(?:reasoning_effort|reasoning\.effort|thinking) is not supported/.test(normalized) ||
    normalized.includes('does not support thinking') ||
    normalized.includes('does not support reasoning')
  ) {
    return 'parameter';
  }

  if (
    normalized.includes('unsupported value') ||
    normalized.includes('invalid value') ||
    normalized.includes('invalid enum') ||
    normalized.includes('allowed values') ||
    normalized.includes('supported values') ||
    normalized.includes('must be one of')
  ) {
    return 'value';
  }

  return null;
};

export const isReasoningUnsupportedError = (message: string): boolean =>
  classifyReasoningRejection(message) !== null;

export const isReasoningReplayRequiredError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('reasoning_content') &&
    (normalized.includes('must be passed back') ||
      normalized.includes('must be passed') ||
      normalized.includes('thinking mode'))
  );
};

export const isContextOverflowError = (message: string, status?: number): boolean => {
  return isContextOverflowMessage(message, status);
};

export const getHeaderValue = (headers: Headers | undefined, name: string): string | null => {
  if (!headers || typeof headers.get !== 'function') {
    return null;
  }

  return headers.get(name);
};

export const parseRetryAfterMs = (headers: Headers | undefined): number | undefined => {
  const retryAfterMs = getHeaderValue(headers, 'retry-after-ms');
  if (retryAfterMs) {
    const parsed = Number(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  const retryAfter = getHeaderValue(headers, 'retry-after');
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
};

export const classifyProviderError = (
  message: string,
  status?: number,
  retryAfterMs?: number,
  details?: {
    providerMessage?: string;
    providerCode?: string;
    providerType?: string;
    providerRawBodyExcerpt?: string;
  }
): ProviderRuntimeError => {
  const normalized = message.toLowerCase();
  let kind: ProviderRuntimeErrorKind = 'unknown';
  if (isReasoningReplayRequiredError(message)) {
    kind = 'reasoning_replay_required';
  } else if (isReasoningUnsupportedError(message)) {
    kind = 'unsupported_reasoning';
  } else if (status === 401 || status === 403) {
    kind = 'auth';
  } else if (isContextOverflowError(message, status)) {
    kind = 'context_overflow';
  } else if (status === 429) {
    kind = 'rate_limited';
  } else if (status === 408 || status === 502 || status === 503 || status === 504) {
    kind = 'provider_overloaded';
  } else if (
    normalized.includes('tool_call') ||
    normalized.includes('tool call') ||
    normalized.includes('tool_calls')
  ) {
    kind = 'invalid_tool_protocol';
  }

  const retryable =
    kind !== 'context_overflow' &&
    (status === 408 ||
      status === 429 ||
      status === 502 ||
      status === 503 ||
      status === 504);

  return new ProviderRuntimeError(message, {
    kind,
    status,
    retryAfterMs,
    retryable,
    ...details,
  });
};

export const extractProviderErrorMessage = async (response: Response): Promise<ProviderRuntimeError> => {
  const errorText = await response.text().catch(() => 'Unknown error');
  let errorMessage = `Request failed: ${response.status}`;
  let providerMessage: string | undefined;
  let providerCode: string | undefined;
  let providerType: string | undefined;

  try {
    const errorJson = JSON.parse(errorText) as {
      error?: { message?: unknown; code?: unknown; type?: unknown };
      message?: unknown;
      code?: unknown;
      type?: unknown;
    };
    const parsedMessage = errorJson.error?.message ?? errorJson.message;
    providerMessage = typeof parsedMessage === 'string' ? parsedMessage : undefined;
    providerCode =
      typeof errorJson.error?.code === 'string'
        ? errorJson.error.code
        : typeof errorJson.code === 'string'
          ? errorJson.code
          : undefined;
    providerType =
      typeof errorJson.error?.type === 'string'
        ? errorJson.error.type
        : typeof errorJson.type === 'string'
          ? errorJson.type
          : undefined;
    const contextParts = [
      providerMessage,
      providerCode,
      providerType,
    ].filter((part): part is string => Boolean(part));
    errorMessage = contextParts.length > 0 ? contextParts.join(' ') : errorMessage;
  } catch {
    if (errorText) {
      errorMessage = errorText;
      providerMessage = errorText;
    }
  }

  return classifyProviderError(
    errorMessage,
    response.status,
    parseRetryAfterMs(response.headers),
    {
      providerMessage,
      providerCode,
      providerType,
      providerRawBodyExcerpt: errorText.slice(0, 1200),
    }
  );
};

export const getProviderErrorString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

export const getProviderErrorStatus = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const extractSseProviderError = (
  payload: unknown,
  rawData: string,
): ProviderRuntimeError | null => {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) {
    return null;
  }

  const envelope = payload as {
    error?: unknown;
    status?: unknown;
    status_code?: unknown;
  };
  const error = envelope.error;
  if (error == null) return null;
  const details = error && typeof error === 'object'
    ? error as {
      message?: unknown;
      code?: unknown;
      type?: unknown;
      status?: unknown;
      status_code?: unknown;
    }
    : {};
  const providerMessage = getProviderErrorString(details.message) ?? getProviderErrorString(error);
  const providerCode = getProviderErrorString(details.code);
  const providerType = getProviderErrorString(details.type);
  const status =
    getProviderErrorStatus(details.status) ??
    getProviderErrorStatus(details.status_code) ??
    getProviderErrorStatus(envelope.status) ??
    getProviderErrorStatus(envelope.status_code);
  const message = [providerMessage, providerCode, providerType]
    .filter((part): part is string => Boolean(part))
    .join(' ') || 'Provider sent an error event in the stream';

  return classifyProviderError(message, status, undefined, {
    providerMessage,
    providerCode,
    providerType,
    providerRawBodyExcerpt: rawData.slice(0, 1200),
  });
};
