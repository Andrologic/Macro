export const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /too many tokens/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /maximum context length is \d+ tokens/i,
  /reduce the length of the messages/i,
  /exceeds the context window/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /context_length_exceeded/i,
  /model_context_window_exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /requested tokens.*exceed.*context window/i,
  /context window.*(?:is|of|:)\s*\d+/i,
  /n_ctx.*\d+/i,
  /^4(00|13)\s*(status code)?\s*\(no body\)/i,
];

export const isContextOverflowMessage = (
  message: string,
  status?: number,
): boolean => {
  if (status === 413) {
    return true;
  }
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
};

export const isContextOverflowErrorLike = (error: unknown): boolean => {
  const candidate = error as {
    kind?: unknown;
    status?: unknown;
    message?: unknown;
    providerMessage?: unknown;
    providerCode?: unknown;
    providerType?: unknown;
  };
  if (candidate?.kind === 'context_overflow' || candidate?.status === 413) {
    return true;
  }

  const status =
    typeof candidate?.status === 'number' && Number.isFinite(candidate.status)
      ? candidate.status
      : undefined;
  const parts = [
    typeof candidate?.message === 'string' ? candidate.message : null,
    typeof candidate?.providerMessage === 'string'
      ? candidate.providerMessage
      : null,
    typeof candidate?.providerCode === 'string' ? candidate.providerCode : null,
    typeof candidate?.providerType === 'string' ? candidate.providerType : null,
    error instanceof Error ? error.message : null,
    typeof error === 'string' ? error : null,
  ].filter((part): part is string => Boolean(part));

  return parts.some((part) => isContextOverflowMessage(part, status));
};

export const extractContextLimitTokensFromMessage = (
  message: string,
): number | null => {
  const patterns = [
    /maximum (?:context|prompt) length is ([\d,._\s]+) tokens/i,
    /exceeds (?:the )?(?:maximum|limit)(?: of)? ([\d,._\s]+)\b/i,
    /context length is only ([\d,._\s]+) tokens/i,
    /model with ([\d,._\s]+) maximum context length/i,
    /context[_ ]window[_ ]tokens["':\s]+([\d,._\s]+)/i,
    /context window (?:is|of|:)\s*([\d,._\s]+)(?: tokens)?/i,
    /n_ctx["':=\s]+([\d,._\s]+)/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    const raw = match?.[1]?.replace(/[,_\s.]/g, '');
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }

  return null;
};

export const extractContextLimitTokensFromErrorLike = (
  error: unknown,
): number | null => {
  const candidate = error as {
    message?: unknown;
    providerMessage?: unknown;
    providerRawBodyExcerpt?: unknown;
  };
  const parts = [
    typeof candidate?.message === 'string' ? candidate.message : null,
    typeof candidate?.providerMessage === 'string'
      ? candidate.providerMessage
      : null,
    typeof candidate?.providerRawBodyExcerpt === 'string'
      ? candidate.providerRawBodyExcerpt
      : null,
    error instanceof Error ? error.message : null,
    typeof error === 'string' ? error : null,
  ].filter((part): part is string => Boolean(part));

  for (const part of parts) {
    const limit = extractContextLimitTokensFromMessage(part);
    if (limit) return limit;
  }

  return null;
};
