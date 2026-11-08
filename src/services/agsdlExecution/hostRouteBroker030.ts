import type { HostRouteJob030, HostRouteOutput030 } from '../../types/generated/ipc';
import { executionHostCompleteRoute030, executionHostFailed, executionHostNextRoute030 } from '../ipc/agsdlExecution';
import { capturedContent030, type CapturedContentReceipt030, type ContentCaptureIdentity030 } from './contentResolution030';
import { ConformanceError } from './exact';
import { prepareFlowRoute030, type PrepareFlowRouteInput030 } from './prepareFlowRoute030';
import type { HostWorkPumpPort030 } from './hostWorkPump030';

type NativeRouteInput030 = Omit<PrepareFlowRouteInput030, 'content'> & {
  readonly contentReceipts: { readonly identity: ContentCaptureIdentity030; readonly receipts: readonly CapturedContentReceipt030[] };
};

/** The resident mailbox transports data only; native code revalidates and commits it. */
export function createHostRoutePort030(generation: string): HostWorkPumpPort030<HostRouteJob030, HostRouteOutput030> {
  return {
    next: executionHostNextRoute030,
    async evaluate(job) {
      if (job.generation !== generation) throw new Error('Route mailbox generation changed.');
      try {
        const { contentReceipts, ...input } = JSON.parse(job.inputJson) as NativeRouteInput030;
        const content = capturedContent030(contentReceipts.identity, contentReceipts.receipts);
        return { kind: 'ready', resultJson: JSON.stringify(prepareFlowRoute030({ ...input, content })) };
      } catch (error) {
        return error instanceof ConformanceError
          ? { kind: 'failed', code: error.code, pointer: error.pointer }
          : { kind: 'failed', code: 'ROUTE_PREPARATION_FAILED', pointer: '' };
      }
    },
    complete(job, output) {
      return executionHostCompleteRoute030({ ticket: job.ticket, generation: job.generation, inputDigest: job.inputDigest, output });
    },
    isStaleCompletion(error) {
      return typeof error === 'object' && error !== null && 'code' in error && error.code === 'STALE_TICKET';
    },
    async fail() { await executionHostFailed(); },
  };
}
