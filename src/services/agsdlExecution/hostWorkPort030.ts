import type { ValueSchemaValidator030 } from './agentWorkContracts030';
import { evaluateHostWork030 } from './hostWorkTransition030';

/** Captured native input used by the differential oracle, without IPC. */
export interface HostWorkJob030 {
  ticket: string; generation: string; inputDigest: string;
  input: { context: Parameters<typeof evaluateHostWork030>[0]; eventId: string; expectedRevision: string;
    contractJson: string; stateJson: string; eventJson: string; optionsJson: string };
}
export interface HostWorkOutput030 { stateJson: string; receiptJson: string }

/** Pure reference evaluator for captured work transitions. */
export function createHostWorkPort030(
  generation: string,
  validateValueSchema: ValueSchemaValidator030,
): { evaluate(job: HostWorkJob030): Promise<HostWorkOutput030> } {
  return {
    async evaluate(job) {
      if (job.generation !== generation) throw new Error('Work mailbox generation changed.');
      const input = job.input;
      return evaluateHostWork030(input.context, input.eventId, input.expectedRevision,
        input.contractJson, input.stateJson, input.eventJson, input.optionsJson, validateValueSchema);
    },
  };
}
