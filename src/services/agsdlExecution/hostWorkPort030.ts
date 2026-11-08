import type { HostWorkJob030, HostWorkOutput030 } from '../../types/generated/ipc';
import { executionHostCompleteWork030, executionHostFailed, executionHostNextWork030 } from '../ipc/agsdlExecution';
import type { ValueSchemaValidator030 } from './agentWorkContracts030';
import type { HostWorkPumpPort030 } from './hostWorkPump030';
import { evaluateHostWork030 } from './hostWorkTransition030';

/** Connect the resident host to its authenticated native work mailbox. The
 * supplied validator must be the 0.3 reader bound by native capture. */
export function createHostWorkPort030(
  generation: string,
  validateValueSchema: ValueSchemaValidator030,
): HostWorkPumpPort030<HostWorkJob030, HostWorkOutput030> {
  return {
    next: executionHostNextWork030,
    async evaluate(job) {
      if (job.generation !== generation) throw new Error('Work mailbox generation changed.');
      const input = job.input;
      return evaluateHostWork030(input.context, input.eventId, input.expectedRevision,
        input.contractJson, input.stateJson, input.eventJson, input.optionsJson, validateValueSchema);
    },
    complete(job, output) {
      return executionHostCompleteWork030({ ticket: job.ticket, generation: job.generation, inputDigest: job.inputDigest, output });
    },
    isStaleCompletion(error) {
      return typeof error === 'object' && error !== null && 'code' in error && error.code === 'STALE_TICKET';
    },
    async fail() { await executionHostFailed(); },
  };
}
