import type { fetch as nativeTauriFetch } from '@tauri-apps/plugin-http';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { invokeWithReceipt } from './tauriRuntimeBridge';
import { httpReleaseWebviewResource } from './ipc/httpResources';
import { RuntimeCommandError } from './runtimeCommandError';
import { StreamStopUnconfirmedError, preserveStreamStopError, withStreamCleanup } from './ai/streamCancellation';

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

const missingReceipt = (operation: string, error: unknown): StreamStopUnconfirmedError => {
  if (error instanceof StreamStopUnconfirmedError) return error;
  const failure = new StreamStopUnconfirmedError(`HTTP ${operation} end was not confirmed: ${error instanceof Error ? error.message : String(error)}`);
  return preserveStreamStopError(failure, error);
};

// Both runtimes use the plugin commands through Macro's existing invoke port.
// Their scope checks and client options remain enforced by the plugin backend.
export const createBrowserRuntimeFetch = (
  bridgeInvoke: RuntimeInvoke,
): typeof nativeTauriFetch => async (input, init) => {
  const receivedInvoke: RuntimeInvoke = async <T>(command: string, args?: InvokeArgs): Promise<T> => {
    try { return await bridgeInvoke<T>(command, args); }
    catch (error) {
      if (error instanceof RuntimeCommandError && error.payload instanceof StreamStopUnconfirmedError) throw error.payload;
      throw error;
    }
  };
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

  let rid: number;
  try {
    rid = await receivedInvoke<number>('plugin:http|fetch', {
      clientConfig: {
        method: request.method,
        url: request.url,
        headers: Array.from(headers.entries()),
        data,
        maxRedirections: 0,
        connectTimeout: options?.connectTimeout,
        proxy: options?.proxy,
        danger: options?.danger,
      },
    });
  } catch (error) { throw error instanceof RuntimeCommandError ? error : missingReceipt('admission', error); }

  let cancellation: Promise<unknown> | undefined;
  const cancelRequest = () => {
    cancellation ??= Promise.resolve().then(() => receivedInvoke('plugin:http|fetch_cancel', { rid }));
    void cancellation.catch(() => undefined);
  };
  signal?.addEventListener('abort', cancelRequest, { once: true });
  if (signal?.aborted) cancelRequest();
  // Even pre-send cancellation needs fetch_send to consume the aborted request.
  // Join its response; cancel merely requests interruption of that command.
  const response = await withStreamCleanup(async () => {
    let outcome: ClientResponse | undefined;
    let failure: Error | undefined;
    try { outcome = await receivedInvoke<ClientResponse>('plugin:http|fetch_send', { rid }); }
    catch (error) {
      failure = error instanceof RuntimeCommandError ? error : missingReceipt('request', error);
      cancelRequest();
    }
    signal?.removeEventListener('abort', cancelRequest);
    try { await cancellation; }
    catch (error) {
      if (failure instanceof StreamStopUnconfirmedError) failure = preserveStreamStopError(failure, error);
      else if (!(error instanceof RuntimeCommandError)) failure = missingReceipt('request cancellation', error);
      // A fulfilled send is the request's receipt, even if its cancel failed.
    }
    // fetch_send may fail before consuming its request, or leave its completed
    // future in the table. A received error alone cannot discharge that resource.
    try { await httpReleaseWebviewResource(rid, receivedInvoke); }
    catch (error) {
      const owner = missingReceipt('request cleanup', error);
      failure = failure instanceof StreamStopUnconfirmedError ? preserveStreamStopError(failure, owner) : failure ? preserveStreamStopError(owner, failure) : owner;
    }
    if (failure && outcome) {
      // Cancellation can fail while send succeeds and creates a body resource.
      // Its cleanup belongs to this invocation even though no Response escapes.
      try { await receivedInvoke('plugin:http|fetch_cancel_body', { rid: outcome.rid }); }
      catch (error) {
        const owner = missingReceipt('body cleanup', error);
        failure = failure instanceof StreamStopUnconfirmedError ? preserveStreamStopError(failure, owner) : failure ? preserveStreamStopError(owner, failure) : owner;
      }
    }
    if (failure) throw failure;
    return outcome!;
  }, () => signal?.removeEventListener('abort', cancelRequest));

  let bodyFinished = false;
  let eof = false;
  let activeRead: Promise<number[]> | undefined;
  let closing: Promise<void> | undefined;
  let cleanupBodyAbort = (): void => undefined;
  const finishBody = () => {
    bodyFinished = true;
    cleanupBodyAbort();
  };
  const stopBody = (): Promise<void> => {
    if (closing) return closing;
    if (eof) return Promise.resolve();
    finishBody();
    // Keep the IPC promise, not the ReadableStream read promise: cancel closes
    // the JS reader before the backend read holding its response Arc has ended.
    const read = activeRead;
    closing = (async () => {
      const outcomes = await Promise.allSettled([
        read,
        Promise.resolve().then(() => receivedInvoke('plugin:http|fetch_cancel_body', { rid: response.rid })),
      ]);
      let failure: StreamStopUnconfirmedError | undefined;
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status !== 'rejected') continue;
        // A read error response proves the read future ended. Cleanup must
        // still succeed; a cleanup error response does not prove resource closure.
        if (index === 0 && outcome.reason instanceof RuntimeCommandError) continue;
        // A received EOF proves that the backend also removed the body resource.
        // A typed rejection can still own separate work and must be conserved.
        if (eof && !(outcome.reason instanceof StreamStopUnconfirmedError)) continue;
        const owner = missingReceipt(index === 0 ? 'body read' : 'body cleanup', outcome.reason);
        failure = failure ? preserveStreamStopError(failure, owner) : owner;
      }
      if (failure) throw failure;
    })();
    void closing.catch(() => undefined);
    return closing;
  };

  if (signal?.aborted || [101, 103, 204, 205, 304].includes(response.status)) {
    await stopBody();
    if (signal?.aborted) throw new Error(ERROR_REQUEST_CANCELLED);
  }
  const body = bodyFinished ? null : new ReadableStream<Uint8Array>({
    start(controller) {
      const handleAbort = () => {
        if (bodyFinished) return;
        // Publish only after all dispatched local work is joined, including
        // cleanup failure. A concurrent reader.cancel joins this same promise.
        void stopBody().then(
          () => controller.error(new Error(ERROR_REQUEST_CANCELLED)),
          error => controller.error(error),
        );
      };
      signal?.addEventListener('abort', handleAbort, { once: true });
      cleanupBodyAbort = () => signal?.removeEventListener('abort', handleAbort);
      if (signal?.aborted) handleAbort();
    },
    async pull(controller) {
      if (bodyFinished) return;
      const read = Promise.resolve().then(() => receivedInvoke<number[]>('plugin:http|fetch_read_body', { rid: response.rid }));
      activeRead = read;
      try {
        const bytes = await read;
        const chunk = new Uint8Array(bytes);
        const isLastChunk = chunk[chunk.byteLength - 1] === 1;
        if (isLastChunk) eof = true;
        if (bodyFinished) return;
        const payload = chunk.slice(0, -1);
        if (payload.byteLength > 0) controller.enqueue(payload);
        if (isLastChunk) {
          finishBody();
          controller.close();
        }
      } catch (error) {
        // Do not join pull itself: only its underlying IPC belongs to stopBody.
        try { await stopBody(); }
        catch (failure) { controller.error(failure); return; }
        controller.error(error instanceof RuntimeCommandError ? error : missingReceipt('body read', error));
      } finally {
        if (activeRead === read) activeRead = undefined;
      }
    },
    cancel: () => stopBody(),
  });

  const result = new Response(body, { status: response.status, statusText: response.statusText });
  const decorate = (value: Response): Response => {
    Object.defineProperty(value, 'url', { value: response.url });
    Object.defineProperty(value, 'headers', { value: new Headers(response.headers) });
    const clone = value.clone.bind(value);
    Object.defineProperty(value, 'clone', { value: () => decorate(clone()) });
    return value;
  };
  return decorate(result);
};

// The plugin's JS fetch wrapper does not join its body read/cancel IPCs. Use
// the same Macro owner for native Tauri and its browser bridge, without forking
// the plugin or bypassing its command permissions.
export const tauriFetch: typeof nativeTauriFetch = createBrowserRuntimeFetch(invokeWithReceipt);
