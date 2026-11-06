import { assembleVisibleText } from './invariants';
import type { ExactJsonText } from './contracts';
import { clone, encode, fail, type ExactObject } from './exact';
import { copyContract030, type AgentWorkContract030, type SubmissionCandidate030, type SubmissionDiagnostic030, type ValueSchemaValidator030 } from './agentWorkContracts030';
import { requiresSubmission030, validateAgentSubmission030 } from './agentSubmission030';
import { compareIntegers030, integer030, type Integer030 } from './workIntegers030';

export interface WorkOwner030 {
  readonly systemStartId: string;
  readonly activationId: string;
  readonly agentInstanceId: string;
  readonly ownerEpoch: string;
}
export type WorkFailureCode030 = 'OUTPUT_INVALID' | 'CHECK_FAILED' | 'PLAN_REJECTED' | 'TIMEOUT' | 'STOPPED' | 'REVOKED' | 'AGENT_FAILED' | 'HARNESS_REFUSED' | 'INTERRUPTED';
export type WorkEventBody030 =
  | { readonly kind: 'visibleText'; readonly messageId: string; readonly textParts: readonly string[] }
  | { readonly kind: 'submit'; readonly callId: string; readonly argumentsJson: string }
  | { readonly kind: 'turnEnded'; readonly turnId: string }
  | { readonly kind: 'planPresented'; readonly planId: string; readonly text: string }
  | { readonly kind: 'planResolved'; readonly planId: string; readonly decision: 'accept' | 'reject'; readonly comment?: string }
  | { readonly kind: 'checkEnded'; readonly checkId: string; readonly physicalState: 'ended' | 'uncertain'; readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'stop'; readonly reason: WorkFailureCode030 | 'JOIN_CANCELLED' }
  | { readonly kind: 'physicalEnded'; readonly providerEnded: boolean; readonly effectsEnded: boolean };
export interface WorkEvent030 {
  readonly owner: WorkOwner030;
  readonly eventId: string;
  readonly event: WorkEventBody030;
}
export interface WorkOutput030 {
  readonly text: string;
  readonly resultsJson: ExactJsonText;
  readonly choice: string | null;
  readonly instructions: string | readonly string[] | null;
}
export interface CheckRequest030 {
  readonly checkId: string;
  readonly owner: WorkOwner030;
  readonly candidate: SubmissionCandidate030;
  readonly command: string;
  readonly timeoutMs: Integer030;
  readonly maxOutputBytes: number;
}
export type WorkDecision030 =
  | { readonly kind: 'correction'; readonly category: 'submission'; readonly diagnostics: readonly SubmissionDiagnostic030[] }
  | { readonly kind: 'correction'; readonly category: 'check'; readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly truncated: boolean }
  | { readonly kind: 'checkRequested'; readonly check: CheckRequest030 }
  | { readonly kind: 'accepted'; readonly output: WorkOutput030 }
  | { readonly kind: 'submissionNotAdmitted'; readonly reason: 'CHECK_IN_PROGRESS'; readonly checkId: string }
  | { readonly kind: 'planRequired' }
  | { readonly kind: 'planWaiting'; readonly planId: string; readonly text: string }
  | { readonly kind: 'planAccepted'; readonly planId: string }
  | { readonly kind: 'planRevision'; readonly planId: string; readonly comment: string }
  | { readonly kind: 'stopping'; readonly code: WorkFailureCode030 | 'JOIN_CANCELLED' }
  | { readonly kind: 'uncertain'; readonly checkId: string }
  | { readonly kind: 'waiting'; readonly for: 'check' | 'physicalEnd' }
  | { readonly kind: 'finished'; readonly outcome: 'success'; readonly output: WorkOutput030 }
  | { readonly kind: 'finished'; readonly outcome: 'failure' | 'cancelled'; readonly code: WorkFailureCode030 | 'JOIN_CANCELLED' };
export interface WorkReceipt030 {
  readonly receiptId: string;
  readonly owner: WorkOwner030;
  readonly revision: string;
  readonly decision: WorkDecision030;
}
export interface WorkControllerOptions030 {
  readonly checkTimeoutMs: Integer030;
  readonly maxCheckOutputBytes: number;
  /** Required only for planFirst=ask. This is trusted admission evidence from09, not authored input. */
  readonly enforcedPlanLock: boolean;
}
export interface WorkSnapshot030 {
  readonly state: 'working' | 'checking' | 'accepted' | 'stopping' | 'uncertain' | 'finished';
  readonly submissionCorrections: string;
  readonly checkFailures: string;
  readonly planLock: 'unlocked' | 'awaitingPlan' | 'awaitingApproval';
  readonly accepted: WorkOutput030 | null;
}
function identity030(value: string): void {
  if (typeof value !== 'string' || !value.trim()) fail('CORRELATION', '', 'Work identity must be a nonempty string.');
}
function eventKey030(event: WorkEventBody030): string | null {
  switch (event.kind) {
    case 'visibleText': identity030(event.messageId); return `message:${event.messageId}`;
    case 'submit': identity030(event.callId); return `submit:${event.callId}`;
    case 'turnEnded': identity030(event.turnId); return `turn:${event.turnId}`;
    case 'planPresented': identity030(event.planId); return `plan:${event.planId}`;
    case 'planResolved': identity030(event.planId); return `planDecision:${event.planId}`;
    case 'checkEnded': identity030(event.checkId); return `check:${event.checkId}`;
    default: return null;
  }
}

/** Pure in-process reducer. The native owner must journal each event/receipt atomically
 * before acting. No method executes a check, authenticates IPC or proves confinement. */
export class AgentWorkController030 {
  private readonly owner: WorkOwner030;
  private readonly contract: AgentWorkContract030;
  private readonly options: WorkControllerOptions030;
  private state: WorkSnapshot030['state'] = 'working';
  private planLock: WorkSnapshot030['planLock'];
  private submissionCorrections = 0n;
  private checkFailures = 0n;
  private revision = 0n;
  private readonly visible: string[][] = [];
  private accepted: WorkOutput030 | null = null;
  private pendingCheck: CheckRequest030 | null = null;
  private pendingPlan: string | null = null;
  private stopCode: WorkFailureCode030 | 'JOIN_CANCELLED' | null = null;
  private terminal: WorkDecision030 | null = null;
  private readonly events = new Map<string, { signature: string; receipt: WorkReceipt030 }>();
  private readonly operations = new Map<string, { signature: string; receipt: WorkReceipt030 }>();

  constructor(owner: WorkOwner030, contract: AgentWorkContract030,
    private readonly validateValueSchema: ValueSchemaValidator030, options: WorkControllerOptions030) {
    Object.values(owner).forEach(identity030);
    this.owner = clone(owner);
    this.contract = copyContract030(contract);
    this.options = clone(options);
    integer030(options.checkTimeoutMs, true);
    if (!Number.isSafeInteger(options.maxCheckOutputBytes) || options.maxCheckOutputBytes < 0) fail('CORRELATION', '', 'Invalid check output bound.');
    if (contract.planFirst === 'ask' && options.enforcedPlanLock !== true) fail('HARNESS_REFUSED', '/planFirst', 'planFirst=ask requires an enforced native lock.');
    this.planLock = contract.planFirst === null ? 'unlocked' : 'awaitingPlan';
  }
  snapshot(): WorkSnapshot030 {
    return clone({ state: this.state, submissionCorrections: this.submissionCorrections.toString(), checkFailures: this.checkFailures.toString(), planLock: this.planLock, accepted: this.accepted });
  }
  /** Unknown effects are changes. Native must classify shell/MCP/delegation transitively. */
  allowsEffect(effect: 'read' | 'change' | 'unknown'): boolean {
    return this.state === 'working' && (this.planLock === 'unlocked' || effect === 'read');
  }
  dispatch(input: WorkEvent030): WorkReceipt030 {
    identity030(input.eventId);
    if (Object.keys(this.owner).some(key => this.owner[key as keyof WorkOwner030] !== input.owner[key as keyof WorkOwner030])) fail('CORRELATION', '', 'Foreign or revoked work owner.');
    const event = clone(input.event), key = eventKey030(event);
    const signature = encode(event as unknown as ExactObject);
    const prior = this.events.get(input.eventId) ?? (key === null ? undefined : this.operations.get(key));
    if (prior && prior.signature !== signature) fail('CORRELATION', '', 'Event or provider operation identity has conflicting bytes.');
    // Revocation/stop wins even over a previously accepted receipt replay.
    if (this.stopCode !== null && event.kind !== 'physicalEnded' && event.kind !== 'stop') {
      if (prior) {
        if (prior.receipt.decision.kind !== 'stopping') prior.receipt = this.receipt({ kind: 'stopping', code: this.stopCode });
        this.events.set(input.eventId, prior);
        return clone(prior.receipt);
      }
      const receipt = this.receipt({ kind: 'stopping', code: this.stopCode });
      const entry = { signature, receipt: clone(receipt) };
      this.events.set(input.eventId, entry);
      if (key !== null) this.operations.set(key, entry);
      return receipt;
    }
    if (prior) {
      this.events.set(input.eventId, prior);
      return clone(prior.receipt);
    }
    const decision = this.apply(event);
    const receipt = this.receipt(decision);
    const entry = { signature, receipt: clone(receipt) };
    this.events.set(input.eventId, entry);
    if (key !== null) this.operations.set(key, entry);
    return receipt;
  }
  private receipt(decision: WorkDecision030): WorkReceipt030 {
    this.revision++;
    return clone({ receiptId: `${this.owner.activationId}:${this.revision}`, owner: this.owner, revision: this.revision.toString(), decision });
  }
  private correction(diagnostics: readonly SubmissionDiagnostic030[]): WorkDecision030 {
    if (compareIntegers030(this.submissionCorrections.toString(), this.contract.maxCorrections) >= 0) return this.stop('OUTPUT_INVALID');
    this.submissionCorrections++;
    return { kind: 'correction', category: 'submission', diagnostics };
  }
  private stop(code: WorkFailureCode030 | 'JOIN_CANCELLED'): WorkDecision030 {
    this.state = 'stopping';
    this.stopCode = code;
    return { kind: 'stopping', code };
  }
  private accept(candidate: Omit<WorkOutput030, 'text'>): WorkDecision030 {
    this.accepted = { text: assembleVisibleText(this.visible), resultsJson: candidate.resultsJson, choice: candidate.choice, instructions: clone(candidate.instructions) };
    this.state = 'accepted';
    return { kind: 'accepted', output: clone(this.accepted) };
  }
  private apply(event: WorkEventBody030): WorkDecision030 {
    if (this.terminal) return clone(this.terminal);
    if (event.kind === 'stop') return this.stopCode === null ? this.stop(event.reason) : { kind: 'stopping', code: this.stopCode };
    if (event.kind === 'physicalEnded') {
      if (!event.providerEnded || !event.effectsEnded) return { kind: 'waiting', for: 'physicalEnd' };
      if (this.stopCode !== null) this.terminal = { kind: 'finished', outcome: this.stopCode === 'JOIN_CANCELLED' ? 'cancelled' : 'failure', code: this.stopCode };
      else if (this.accepted !== null && this.state === 'accepted') this.terminal = { kind: 'finished', outcome: 'success', output: clone(this.accepted) };
      else return { kind: 'waiting', for: this.pendingCheck ? 'check' : 'physicalEnd' };
      this.state = 'finished';
      return this.terminal;
    }
    if (event.kind === 'visibleText') {
      if (!Array.isArray(event.textParts) || event.textParts.some(part => typeof part !== 'string')) fail('CORRELATION', '', 'Visible text must contain attributed string parts.');
      this.visible.push([...event.textParts]);
      if (this.accepted) this.accepted = { ...this.accepted, text: assembleVisibleText(this.visible) };
      return { kind: 'waiting', for: this.pendingCheck ? 'check' : 'physicalEnd' };
    }
    if (this.state === 'uncertain') return { kind: 'uncertain', checkId: this.pendingCheck!.checkId };
    if (event.kind === 'checkEnded') {
      if (this.state !== 'checking' || this.pendingCheck?.checkId !== event.checkId) fail('CORRELATION', '', 'No matching active check reservation.');
      if (event.physicalState === 'uncertain') {
        this.state = 'uncertain';
        return { kind: 'uncertain', checkId: event.checkId };
      }
      if (event.exitCode !== null && !Number.isSafeInteger(event.exitCode)) fail('CORRELATION', '', 'Invalid check exit status.');
      const candidate = this.pendingCheck.candidate;
      this.pendingCheck = null;
      if (event.exitCode === 0) return this.accept(candidate);
      this.state = 'working';
      if (compareIntegers030(this.checkFailures.toString(), this.contract.completionCheck!.maxFailures) >= 0) return this.stop('CHECK_FAILED');
      this.checkFailures++;
      return { kind: 'correction', category: 'check', exitCode: event.exitCode, ...boundedOutput030(event.stdout, event.stderr, this.options.maxCheckOutputBytes) };
    }
    if (this.state === 'checking') {
      if (event.kind === 'submit') {
        const validation = validateAgentSubmission030(this.contract, event.argumentsJson, this.validateValueSchema);
        if (validation.kind === 'invalid') return this.correction(validation.diagnostics);
        // Definitive receipt for this call, not a promise that is never resumed.
        // A new call may be admitted after the reserved check ends.
        return { kind: 'submissionNotAdmitted', reason: 'CHECK_IN_PROGRESS', checkId: this.pendingCheck!.checkId };
      }
      return { kind: 'waiting', for: 'check' };
    }
    if (this.state === 'accepted') return { kind: 'waiting', for: 'physicalEnd' };
    if (event.kind === 'planPresented') {
      if (!event.text.trim()) fail('CORRELATION', '/plan', 'A presented plan must contain text.');
      if (this.planLock === 'awaitingApproval') fail('CORRELATION', '/plan', 'A plan already awaits a decision.');
      if (this.contract.planFirst !== 'ask' || this.planLock === 'unlocked') {
        this.planLock = 'unlocked';
        return { kind: 'planAccepted', planId: event.planId };
      }
      this.pendingPlan = event.planId;
      this.planLock = 'awaitingApproval';
      return { kind: 'planWaiting', planId: event.planId, text: event.text };
    }
    if (event.kind === 'planResolved') {
      if (this.planLock !== 'awaitingApproval' || this.pendingPlan !== event.planId) fail('CORRELATION', '/plan', 'No matching plan awaits approval.');
      this.pendingPlan = null;
      if (event.decision === 'accept') {
        this.planLock = 'unlocked';
        return { kind: 'planAccepted', planId: event.planId };
      }
      if (!event.comment?.trim()) return this.stop('PLAN_REJECTED');
      this.planLock = 'awaitingPlan';
      return { kind: 'planRevision', planId: event.planId, comment: event.comment };
    }
    if (event.kind === 'turnEnded') {
      if (requiresSubmission030(this.contract)) return this.correction([{ pointer: '', rule: 'SUBMISSION_REQUIRED', message: 'Submit the required result before completing this work.' }]);
      return this.accept({ resultsJson: '{}' as ExactJsonText, choice: null, instructions: null });
    }
    const validation = validateAgentSubmission030(this.contract, event.argumentsJson, this.validateValueSchema);
    if (validation.kind === 'invalid') return this.correction(validation.diagnostics);
    if (!validation.candidate.checkRequired) return this.accept(validation.candidate);
    if (this.planLock !== 'unlocked') return { kind: 'planRequired' };
    const checkId = `${this.owner.activationId}:check:${this.revision + 1n}`;
    this.pendingCheck = { checkId, owner: clone(this.owner), candidate: clone(validation.candidate),
      command: this.contract.completionCheck!.command, timeoutMs: this.options.checkTimeoutMs, maxOutputBytes: this.options.maxCheckOutputBytes };
    this.state = 'checking';
    return { kind: 'checkRequested', check: clone(this.pendingCheck) };
  }
}
function boundedOutput030(stdout: string, stderr: string, limit: number): { stdout: string; stderr: string; truncated: boolean } {
  let remaining = limit, truncated = false;
  const take = (source: string): string => {
    const parts: string[] = [];
    for (const part of source) {
      const bytes = new TextEncoder().encode(part).length;
      if (bytes > remaining) { truncated = true; break; }
      remaining -= bytes;
      parts.push(part);
    }
    return parts.join('');
  };
  return { stdout: take(stdout), stderr: take(stderr), truncated };
}
