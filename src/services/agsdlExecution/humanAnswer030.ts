import { evaluateHostHumanClock030 } from './hostHumanClock030';

/** Separate flow-owned native mailbox job. There is deliberately no Agent
 * instance or product-supplied timestamp in the transport context. */
export interface HostClockInput030 {
  readonly identity: { readonly systemStartId: string; readonly flowInvocationId: string; readonly snapshotId: string; readonly epoch: string };
  readonly owner: { readonly systemStartId: string; readonly ownerEpoch: string };
  readonly eventId: string;
  readonly expectedRevision: string;
  readonly stateJson: string;
  readonly eventJson: string;
  readonly optionsJson: string;
}
export interface HostClockJob030 {
  readonly ticket: string;
  readonly generation: string;
  readonly inputDigest: string;
  readonly input: HostClockInput030;
}
/** Runs only in the authenticated resident host pump. Rust authenticates ticket,
 * generation, digest, journal revision and the appended event before commit. */
export function evaluateHumanClockJob030(job: HostClockJob030): { readonly stateJson: string; readonly receiptJson: string } {
  const input = job.input;
  if (!job.ticket || !job.generation || !job.inputDigest || !input.owner.ownerEpoch
    || Object.values(input.identity).some(value => !value)
    || input.identity.systemStartId !== input.owner.systemStartId) throw new Error('CORRELATION: invalid flow clock job.');
  return evaluateHostHumanClock030(input.owner, input.eventId, input.expectedRevision,
    input.stateJson, input.eventJson, JSON.parse(input.optionsJson));
}
