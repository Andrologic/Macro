import type {
  AcceptedDelivery, DeliveryRequest, ExactValuePort, FrozenAgentConfiguration,
  RuntimeOwner, Sequence, SourceRevision, TerminalOutcome, WorkIdentity, WorkState,
} from './contracts';

export class ExecutionInvariantError extends Error {
  readonly code = 'CORRELATION';
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionInvariantError';
  }
}
const requireMatch = (matches: boolean, message: string): void => {
  if (!matches) throw new ExecutionInvariantError(message);
};
export function sameWork(left: WorkIdentity, right: WorkIdentity): boolean {
  return left.systemStartId === right.systemStartId &&
    left.flowInvocationId === right.flowInvocationId &&
    left.activationId === right.activationId &&
    left.agentInstanceId === right.agentInstanceId &&
    (left.step === null ? right.step === null : right.step !== null &&
      left.step.length === right.step.length && left.step.every((part, i) => part === right.step?.[i]));
}
/** This compares correlation only. Native caller authentication is still required. */
export function assertOwner(current: RuntimeOwner, supplied: RuntimeOwner, work: WorkIdentity): void {
  requireMatch(current.systemStartId === supplied.systemStartId &&
    current.systemStartId === work.systemStartId && current.ownerEpoch === supplied.ownerEpoch,
  'Runtime owner or epoch does not match.');
}
export function assertSourceRevision(expected: SourceRevision, captured: SourceRevision): void {
  requireMatch(expected.owner.projectId === captured.owner.projectId &&
    expected.owner.planId === captured.owner.planId && expected.owner.branch === captured.owner.branch &&
    expected.revision === captured.revision && expected.sourceSha256 === captured.sourceSha256,
  'Source owner or revision changed.');
}
/** Canonical string representation makes large queue positions safe on the wire. */
export function compareSequence(left: Sequence, right: Sequence): -1 | 0 | 1 {
  requireMatch(typeof left === 'string' && typeof right === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(left) && /^(0|[1-9][0-9]*)$/.test(right),
    'Invalid queue sequence.');
  if (left === right) return 0;
  return left.length < right.length || (left.length === right.length && left < right) ? -1 : 1;
}
/** A transport retry retains the receipt. A new work occurrence needs a new id. */
export function assertRetransmission(existing: AcceptedDelivery, incoming: DeliveryRequest, exact: ExactValuePort): void {
  requireMatch(existing.deliveryId === incoming.deliveryId && sameWork(existing.work, incoming.work) &&
    existing.input.origin === incoming.input.origin && exact.equal(existing.input.valueJson, incoming.input.valueJson),
  'Conflicting delivery retransmission.');
}
export function assertFrozenConfiguration(retained: FrozenAgentConfiguration, proposed: FrozenAgentConfiguration): void {
  requireMatch(retained.agentName === proposed.agentName &&
    retained.configurationName === proposed.configurationName && retained.providerId === proposed.providerId &&
    retained.modelId === proposed.modelId && retained.configurationJson === proposed.configurationJson &&
    retained.settingsJson === proposed.settingsJson && retained.permissionsJson === proposed.permissionsJson &&
    retained.scopeJson === proposed.scopeJson, 'Retained configuration cannot change.');
}
/** Revocation is a separate live check, never an edit to this frozen ceiling. */
export function permissionWithinSnapshot(captured: readonly string[], currentlyAllowed: readonly string[], requested: readonly string[]): boolean {
  return requested.every(permission => captured.includes(permission) && currentlyAllowed.includes(permission));
}
export function holdsAgentLock(state: WorkState): boolean {
  return state === 'active' || state === 'uncertain';
}
/** Validate supplied admission evidence; this helper does not dequeue or schedule. */
export function assertOldest(candidate: AcceptedDelivery, queuedForAgent: readonly AcceptedDelivery[]): void {
  requireMatch(queuedForAgent.some(item => item.deliveryId === candidate.deliveryId &&
    sameWork(item.work, candidate.work) && item.queueSequence === candidate.queueSequence),
  'Candidate is absent from the queue.');
  compareSequence(candidate.queueSequence, candidate.queueSequence);
  const seen = new Set<string>();
  for (const item of queuedForAgent) {
    requireMatch(!seen.has(item.deliveryId), 'Queue repeats a delivery id.');
    seen.add(item.deliveryId);
    requireMatch(item.work.systemStartId === candidate.work.systemStartId &&
      item.work.agentInstanceId === candidate.work.agentInstanceId, 'Queue contains another owner.');
    const order = compareSequence(candidate.queueSequence, item.queueSequence);
    requireMatch(order <= 0 && (order !== 0 || item.deliveryId === candidate.deliveryId),
      'Admission must use the unique oldest queue position.');
  }
}
export function assertTerminalDuplicate(retained: TerminalOutcome, incoming: TerminalOutcome, exact: ExactValuePort): void {
  let equal = false;
  if (retained.kind === 'completed' && incoming.kind === 'completed') {
    equal = retained.output.origin === incoming.output.origin && exact.equal(retained.output.valueJson, incoming.output.valueJson);
  } else if (retained.kind === 'failed' && incoming.kind === 'failed') {
    equal = retained.code === incoming.code && exact.equal(retained.errorJson, incoming.errorJson);
  } else if (retained.kind === 'stopped' && incoming.kind === 'stopped') {
    equal = exact.equal(retained.evidenceJson, incoming.evidenceJson);
  }
  requireMatch(equal, 'Conflicting terminal duplicate; continuation remains resolved.');
}
/** Requires already filtered, attributed, ordered complete response Messages. */
export function assembleVisibleText(messages: readonly (readonly string[])[]): string {
  return messages.map(parts => parts.join('')).filter(text => text !== '').join('\n');
}
