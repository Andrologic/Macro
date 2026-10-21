const MAX_PROVIDER_ERROR_BYTES = 16 * 1024;

export const assertSecureProviderEndpoint = (input: string): void => {
  const url = new URL(input);
  if (url.username || url.password) {
    throw new Error('Provider URLs must not contain credentials.');
  }
  if (url.protocol === 'https:') return;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== 'http:' || !loopback) {
    throw new Error('Provider HTTP URLs must use a loopback host.');
  }
};

export const isSecureProviderEndpoint = (input: string): boolean => {
  try {
    assertSecureProviderEndpoint(input);
    return true;
  } catch {
    return false;
  }
};

export const readBoundedProviderError = async (response: Response, timeoutMs = 10_000): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Provider error response timed out.'));
      void reader.cancel().catch(() => undefined);
    }, timeoutMs);
  });
  try {
    while (size < MAX_PROVIDER_ERROR_BYTES) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      const remaining = MAX_PROVIDER_ERROR_BYTES - size;
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength >= remaining) {
        truncated = true;
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output) + (truncated ? ' [truncated]' : '');
};
