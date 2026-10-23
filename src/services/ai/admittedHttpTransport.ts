import type { StreamingChatOptions } from './contracts';
import type { ChatWorkPhase } from '../ipc/chatAdmission';
import { chatAdmissionHttpStart, chatAdmissionHttpRead, chatAdmissionHttpFinish, chatAdmissionCompleteSteerHandoff } from '../tauriIpc';
import { MacroServiceError } from '../contracts/errors';
import { fetchWithTimeout } from './httpTransport';

export interface ProviderHttpResponse {
  response: Response;
  finish(outcome: 'completed' | 'uncertain'): Promise<ChatWorkPhase | undefined>;
}

export async function fetchProviderWithTimeout(
  options: Pick<StreamingChatOptions, 'providerAdmission' | 'providerId' | 'conversationId' | 'providerSteerReceipts'>,
  url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal,
): Promise<ProviderHttpResponse> {
  if (options.providerAdmission.kind !== 'globalChat') {
    return { response: await fetchWithTimeout(url, init, timeoutMs, signal), finish: async () => undefined };
  }
  const { context } = options.providerAdmission;
  const conversation = options.conversationId;
  if (!conversation || typeof init.body !== 'string' || init.method !== 'POST') {
    throw new MacroServiceError('CHAT_ADMISSION_REFUSED', 'The provider request has no admitted conversation.');
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const requestId = crypto.randomUUID();
  const steerReceipts = options.providerSteerReceipts?.() ?? [];
  // Normalize the actual destination before native comparison with provider configuration.
  const destination = new URL(url).href;
  const headers = Array.from(new Headers(init.headers).entries());
  try {
    await chatAdmissionHttpStart(context, conversation, {
      requestId, providerId: options.providerId, url: destination, headers, body: init.body,
    });
  } catch {
    // The command may have dispatched before its acknowledgement was lost.
    // Attempt the exact request's cleanup; failure leaves the durable parent held.
    await chatAdmissionHttpFinish(context, conversation, requestId, 'uncertain').catch(() => undefined);
    throw new MacroServiceError('CHAT_ADMISSION_UNAVAILABLE', 'The provider admission acknowledgement was lost.');
  }
  let finishing: Promise<ChatWorkPhase> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const finish = (outcome: 'completed' | 'uncertain'): Promise<ChatWorkPhase> => {
    if (!finishing) {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      finishing = chatAdmissionHttpFinish(context, conversation, requestId, outcome).then(async receipt => {
        if (receipt.phase === 'completed' && !receipt.taskError && steerReceipts.length) {
          await chatAdmissionCompleteSteerHandoff(context, conversation, requestId, steerReceipts);
        }
        return receipt.phase;
      });
    }
    return finishing;
  };
  let interruptRead!: (error: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { interruptRead = reject; });
  // A failed cleanup IPC cannot resolve an outstanding native read. Surface
  // that failure while its durable operation remains unresolved.
  void interrupted.catch(() => undefined);
  const abort = () => {
    void finish('uncertain').then(
      () => interruptRead(signal?.aborted
        ? new DOMException('Aborted', 'AbortError')
        : new MacroServiceError('CHAT_ADMISSION_UNCERTAIN', 'The provider response timed out.')),
      () => interruptRead(new MacroServiceError('CHAT_ADMISSION_UNAVAILABLE', 'The provider cleanup could not be confirmed.')),
    );
  };
  const read = () => Promise.race([chatAdmissionHttpRead(requestId), interrupted]);
  signal?.addEventListener('abort', abort, { once: true });
  timeout = setTimeout(abort, timeoutMs);
  try {
    if (signal?.aborted) {
      await finish('uncertain');
      throw new DOMException('Aborted', 'AbortError');
    }
    const header = await read();
    if (header.kind !== 'headers') throw new Error('HTTP headers missing');
    clearTimeout(timeout);
    timeout = undefined;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await read();
          if (part.kind === 'end') controller.close();
          else if (part.kind === 'bytes') controller.enqueue(new Uint8Array(part.data));
          else throw new Error('Unexpected HTTP headers');
        } catch (error) { controller.error(error); }
      },
      // The codec may cancel after its terminal SSE marker. finish() below is
      // the physical join and is always awaited by the transport owner.
      cancel() {},
    });
    const response = new Response([204, 205, 304].includes(header.status) ? null : body, {
      status: header.status, headers: header.headers,
    });
    Object.defineProperty(response, 'url', { value: header.url });
    return { response, finish };
  } catch (error) {
    let phase: ChatWorkPhase;
    try { phase = await finish('uncertain'); }
    catch {
      throw new MacroServiceError('CHAT_ADMISSION_UNAVAILABLE', 'The provider outcome could not be recorded.');
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (phase !== 'no_effect') {
      throw new MacroServiceError('CHAT_ADMISSION_UNCERTAIN', 'The provider may have accepted this request.');
    }
    throw error;
  }
}
