import { StreamStopUnconfirmedError } from '../ai/streamCancellation';
import type { HostToolInvocation, HostToolReceipt } from '../../types/generated/ipc';
import type { ToolCallResolution } from '../ai/contracts';
import { executionHostInvokeTool } from '../ipc/agsdlExecution';
import type { ResidentAgentRequest, ResidentToolDispatch } from './residentAgent';
import { decode, encode, fail, record, text } from './exact';

export interface NativeInvocationPorts {
  invoke(request: HostToolInvocation): Promise<HostToolReceipt>;
  wait(): Promise<void>;
  identity(): string;
}
const nativePorts: NativeInvocationPorts = {
  invoke: executionHostInvokeTool,
  wait: () => new Promise(resolve => setTimeout(resolve, 150)),
  identity: () => crypto.randomUUID(),
};
/** Polling reads the same native invocation. It never grants approval, creates a
 * replacement effect, or interprets a cancellation request as physical completion. */
export async function awaitNativeTool(request: HostToolInvocation, ports: NativeInvocationPorts = nativePorts): Promise<{ readonly resultJson: string; readonly failed: boolean }> {
  for (;;) {
    let receipt: HostToolReceipt;
    try { receipt = await ports.invoke(request); }
    catch { throw new StreamStopUnconfirmedError('Native tool acknowledgement is ambiguous.'); }
    switch (receipt.kind) {
      case 'ended': return { resultJson: receipt.resultJson, failed: receipt.failed };
      case 'rejected': return fail(receipt.code === 'STOP_CANCELLED' ? 'STOP_CANCELLED' : 'APPROVAL', '', `Native tool admission refused: ${receipt.code}`);
      case 'uncertain': throw new StreamStopUnconfirmedError('Native tool termination is unconfirmed.');
      case 'pending':
      case 'awaitingApproval': await ports.wait();
    }
  }
}
/** Internal Agent tools use their exact model-facing alias and actual attempt.
 * Flow Call uses awaitNativeTool directly with its separately evaluated scope. */
export function createResidentToolDispatch(request: ResidentAgentRequest, ports: NativeInvocationPorts = nativePorts): ResidentToolDispatch {
  const capture = record(decode(request.configuration.configurationJson));
  const configured = record(record(capture.configuration).tools ?? {});
  const bindings = record(capture.bindings);
  const retained = new Map<string, { raw: string; result: Promise<ToolCallResolution> }>();
  return (call, attempt) => {
    const key = JSON.stringify([attempt, call.id]);
    const raw = JSON.stringify([call.function.name, call.function.arguments]);
    const previous = retained.get(key);
    if (previous) {
      if (previous.raw !== raw) return Promise.reject(new StreamStopUnconfirmedError('Tool call retransmission changed.'));
      return previous.result;
    }
    const result = (async (): Promise<ToolCallResolution> => {
      const alias = request.toolAliases.find(alias => alias.name === call.function.name);
      if (!alias || typeof configured[alias.name] !== 'string') return fail('CORRELATION', '', 'Tool alias is outside the captured configuration.');
      const bindingJson = encode(bindings[text(configured[alias.name])]);
      const context = { ...request.context, work: { ...request.context.work, step: request.context.work.step === null ? null : [...request.context.work.step] } };
      const completion = await awaitNativeTool({ context, toolInvocationId: ports.identity(), providerAttemptId: attempt,
        bindingJson, argumentsJson: call.function.arguments, callScopeJson: null }, ports);
      // Qualified workspace adapters return an exact JSON string, never a DTO guess.
      return { kind: 'result', result: text(decode(completion.resultJson)), isError: completion.failed };
    })();
    retained.set(key, { raw, result });
    return result;
  };
}
