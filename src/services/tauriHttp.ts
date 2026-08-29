import { fetch as nativeTauriFetch } from '@tauri-apps/plugin-http';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { invoke, isBrowserRuntimeBridgeEnabled } from './tauriRuntimeBridge';

const ERROR_REQUEST_CANCELLED = 'Request cancelled';

type TauriRequestInit = NonNullable<Parameters<typeof nativeTauriFetch>[1]>;
type ClientResponse = {
  status: number;
  statusText: string;
  url: string;
  headers: [string, string][];
  rid: number;
};

export type RuntimeInvoke = <T>(command: string, args?: InvokeArgs) => Promise<T>;

export const createBrowserRuntimeFetch = (
  bridgeInvoke: RuntimeInvoke,
): typeof nativeTauriFetch => async (input, init) => {
  const options = init as TauriRequestInit | undefined;
  const signal = options?.signal;
  if (signal?.aborted) throw new Error(ERROR_REQUEST_CANCELLED);

  const headers = new Headers(options?.headers);
  const request = new Request(input, options);
  const buffer = await request.arrayBuffer();
  if (signal?.aborted) throw new Error(ERROR_REQUEST_CANCELLED);
  const data = buffer.byteLength > 0 ? Array.from(new Uint8Array(buffer)) : null;
  for (const [key, value] of request.headers) {
    if (!headers.has(key)) headers.set(key, value);
  }

  const rid = await bridgeInvoke<number>('plugin:http|fetch', {
    clientConfig: {
      method: request.method,
      url: request.url,
      headers: Array.from(headers.entries()),
      data,
      maxRedirections: options?.maxRedirections,
      connectTimeout: options?.connectTimeout,
      proxy: options?.proxy,
      danger: options?.danger,
    },
  });
  const cancel = () => bridgeInvoke('plugin:http|fetch_cancel', { rid });
  if (signal?.aborted) {
    void cancel().catch(() => undefined);
    throw new Error(ERROR_REQUEST_CANCELLED);
  }
  const cancelRequest = () => void cancel().catch(() => undefined);
  signal?.addEventListener('abort', cancelRequest, { once: true });

  let response: ClientResponse;
  try {
    response = await bridgeInvoke<ClientResponse>('plugin:http|fetch_send', { rid });
  } finally {
    signal?.removeEventListener('abort', cancelRequest);
  }
  const dropBody = () => bridgeInvoke('plugin:http|fetch_cancel_body', { rid: response.rid });
  if (signal?.aborted) {
    void dropBody().catch(() => undefined);
    throw new Error(ERROR_REQUEST_CANCELLED);
  }
  let bodyFinished = false;
  let cleanupBodyAbort = (): void => undefined;
  const finishBody = () => {
    if (bodyFinished) return;
    bodyFinished = true;
    cleanupBodyAbort();
  };
  const body = [101, 103, 204, 205, 304].includes(response.status)
    ? null
    : new ReadableStream<Uint8Array>({
        start(controller) {
          const handleAbort = () => {
            if (bodyFinished) return;
            finishBody();
            void dropBody().catch(() => undefined);
            controller.error(new Error(ERROR_REQUEST_CANCELLED));
          };
          if (signal?.aborted) {
            handleAbort();
            return;
          }
          signal?.addEventListener('abort', handleAbort, { once: true });
          cleanupBodyAbort = () => signal?.removeEventListener('abort', handleAbort);
        },
        async pull(controller) {
          try {
            const chunk = new Uint8Array(
              await bridgeInvoke<number[]>('plugin:http|fetch_read_body', { rid: response.rid }),
            );
            const isLastChunk = chunk[chunk.byteLength - 1] === 1;
            const payload = chunk.slice(0, -1);
            if (payload.byteLength > 0) controller.enqueue(payload);
            if (isLastChunk) {
              finishBody();
              controller.close();
            }
          } catch (error) {
            finishBody();
            controller.error(error);
            void dropBody().catch(() => undefined);
          }
        },
        cancel() {
          finishBody();
          void dropBody().catch(() => undefined);
        },
      });

  const result = new Response(body, {
    status: response.status,
    statusText: response.statusText,
  });
  Object.defineProperty(result, 'url', { value: response.url });
  Object.defineProperty(result, 'headers', { value: new Headers(response.headers) });
  return result;
};

const browserRuntimeFetch = createBrowserRuntimeFetch(invoke);

export const tauriFetch: typeof nativeTauriFetch = (input, init) =>
  isBrowserRuntimeBridgeEnabled()
    ? browserRuntimeFetch(input, init)
    : nativeTauriFetch(input, init);
