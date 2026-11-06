import { clone, encode, fail, type ExactObject } from './exact';
import { boundedInteger030, compareIntegers030, integer030, monotoneMs030, timerDelay030, type Integer030 } from './workIntegers030';

export interface WorkClockSnapshot030 {
  readonly elapsedMachineMs: string;
  readonly openHumanRequests: readonly string[];
  readonly expired: boolean;
}
/** Construct only at real admission, never when enqueuing. Inject a process-monotone
 * clock, not Date.now(). No recovery of lost monotone time is inferred after crash. */
export class WorkClock030 {
  private last: bigint;
  private elapsed = 0n;
  private expired = false;
  private readonly requests = new Set<string>();
  private readonly closed = new Set<string>();
  readonly timeoutMs: Integer030 | null;
  constructor(timeoutMs: Integer030 | null, nowMs: string) {
    this.timeoutMs = timeoutMs === null ? null : integer030(timeoutMs, true);
    this.last = monotoneMs030(nowMs);
  }
  advance(nowMs: string): WorkClockSnapshot030 {
    const now = monotoneMs030(nowMs);
    if (now < this.last) fail('CORRELATION', '', 'Monotone work time moved backwards.');
    if (this.requests.size === 0) this.elapsed += now - this.last;
    this.last = now;
    if (this.timeoutMs !== null && compareIntegers030(this.elapsed.toString(), this.timeoutMs) >= 0) this.expired = true;
    return this.snapshot();
  }
  openHuman(requestId: string, nowMs: string): void {
    if (!requestId.trim() || this.closed.has(requestId)) fail('CORRELATION', '', 'A closed human wait cannot be reopened.');
    this.advance(nowMs);
    this.requests.add(requestId);
  }
  closeHuman(requestId: string, nowMs: string): void {
    if (!this.requests.has(requestId)) fail('CORRELATION', '', 'No matching human wait is open.');
    this.advance(nowMs);
    this.requests.delete(requestId);
    this.closed.add(requestId);
  }
  /** Association changes may reattach an open request. A closed request stays closed. */
  detachHuman(requestId: string, nowMs: string): void {
    if (!this.requests.has(requestId)) fail('CORRELATION', '', 'No matching human wait is attached.');
    this.advance(nowMs);
    this.requests.delete(requestId);
  }
  snapshot(): WorkClockSnapshot030 {
    return { elapsedMachineMs: this.elapsed.toString(), openHumanRequests: [...this.requests], expired: this.expired };
  }
  nextWakeMs(maxSliceMs?: number): number | null {
    return this.requests.size ? null : timerDelay030(this.timeoutMs, this.elapsed, maxSliceMs);
  }
}

export type HumanRequestKind030 = 'ask' | 'plan' | 'question';
export interface HumanRequestInput030 {
  readonly requestId: string;
  readonly kind: HumanRequestKind030;
  readonly reviewer: 'person' | 'model';
  readonly workIds: readonly string[];
  readonly openedAtMs: string;
}
export interface HumanAnswer030 { readonly decision: 'yes' | 'no'; readonly comment?: string }
export interface HumanResolution030 {
  readonly requestId: string;
  readonly answer: HumanAnswer030;
  readonly expired: boolean;
  readonly resolvedAtMs: string;
  readonly workActions: readonly { readonly workId: string; readonly action: 'continue' | 'PLAN_REJECTED' }[];
}
export interface HumanRequestSnapshot030 extends HumanRequestInput030 {
  readonly answerTimeoutMs: Integer030 | null;
  readonly resolution: HumanResolution030 | null;
}
interface RegisteredWork030 { clock: WorkClock030; answerTimeoutMs: Integer030 | null }
interface Request030 {
  input: HumanRequestInput030;
  signature: string;
  attached: string[];
  timeout: Integer030 | null;
  resolution: HumanResolution030 | null;
}
/** Host adapter persists requests and resolutions. This registry decides expiration
 * atomically with late answers and resumes clocks at the actual deadline on late ticks. */
export class HumanWaitRegistry030 {
  private readonly works = new Map<string, RegisteredWork030>();
  private readonly requests = new Map<string, Request030>();
  private last: bigint | null = null;
  registerWork(workId: string, clock: WorkClock030, answerTimeoutMs: Integer030 | null): void {
    if (!workId.trim() || this.works.has(workId)) fail('CORRELATION', '', 'Work must be registered exactly once.');
    this.works.set(workId, { clock, answerTimeoutMs: answerTimeoutMs === null ? null : integer030(answerTimeoutMs, true) });
  }
  open(input: HumanRequestInput030): HumanRequestSnapshot030 {
    if (!input.requestId.trim()) fail('CORRELATION', '', 'A human request needs an identity.');
    this.workIds(input.workIds);
    const signature = encode(input as unknown as ExactObject);
    const prior = this.requests.get(input.requestId);
    if (prior) {
      if (prior.signature !== signature) fail('CORRELATION', '', 'Human request identity has conflicting content.');
      return this.snapshot(prior);
    }
    this.tick(input.openedAtMs);
    const request: Request030 = { input: clone(input), signature, attached: [...input.workIds], timeout: this.limit(input.reviewer, input.workIds), resolution: null };
    this.requests.set(input.requestId, request);
    if (input.reviewer === 'person') for (const workId of request.attached) this.works.get(workId)!.clock.openHuman(input.requestId, input.openedAtMs);
    return this.snapshot(request);
  }
  /** Recompute ambiguous MCP associations as visible calls start/end. The original
   * opening time stays fixed. A newly shortened, past deadline resolves now. */
  setRequestWorks(requestId: string, workIds: readonly string[], nowMs: string): HumanRequestSnapshot030 {
    this.workIds(workIds);
    this.tick(nowMs);
    const request = this.get(requestId);
    if (request.resolution) return this.snapshot(request);
    if (request.input.reviewer === 'person') {
      for (const workId of request.attached) if (!workIds.includes(workId)) this.works.get(workId)!.clock.detachHuman(requestId, nowMs);
      for (const workId of workIds) if (!request.attached.includes(workId)) this.works.get(workId)!.clock.openHuman(requestId, nowMs);
    }
    request.attached = [...workIds];
    request.timeout = this.limit(request.input.reviewer, workIds);
    this.tick(nowMs);
    return this.snapshot(request);
  }
  resolve(requestId: string, answer: HumanAnswer030, nowMs: string): HumanResolution030 {
    if (!['yes', 'no'].includes(answer.decision) || answer.comment !== undefined && typeof answer.comment !== 'string') fail('CORRELATION', '', 'Invalid human answer.');
    this.tick(nowMs);
    const request = this.get(requestId);
    if (request.resolution) return clone(request.resolution);
    return this.close(request, clone(answer), false, nowMs);
  }
  tick(nowMs: string): readonly HumanResolution030[] {
    const now = monotoneMs030(nowMs);
    if (this.last !== null && now < this.last) fail('CORRELATION', '', 'Human registry time moved backwards.');
    const due: { request: Request030; at: bigint }[] = [];
    for (const request of this.requests.values()) {
      if (request.resolution || request.timeout === null) continue;
      const opened = monotoneMs030(request.input.openedAtMs), elapsed = now - opened;
      if (elapsed >= 0n && compareIntegers030(elapsed.toString(), request.timeout) >= 0) {
        const deadline = opened + boundedInteger030(request.timeout, elapsed);
        due.push({ request, at: this.last !== null && deadline < this.last ? this.last : deadline });
      }
    }
    due.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    const resolved = due.map(({ request, at }) => this.close(request, { decision: 'no' }, true, at.toString()));
    for (const { clock } of this.works.values()) clock.advance(nowMs);
    this.last = now;
    return resolved;
  }
  nextWakeMs(nowMs: string, maxSliceMs?: number): number | null {
    this.tick(nowMs);
    const now = monotoneMs030(nowMs);
    const delays: number[] = [];
    for (const request of this.requests.values()) {
      if (request.resolution || request.timeout === null) continue;
      delays.push(timerDelay030(request.timeout, now - monotoneMs030(request.input.openedAtMs), maxSliceMs)!);
    }
    for (const { clock } of this.works.values()) {
      const delay = clock.nextWakeMs(maxSliceMs);
      if (delay !== null) delays.push(delay);
    }
    return delays.length ? Math.min(...delays) : null;
  }
  request(requestId: string): HumanRequestSnapshot030 { return this.snapshot(this.get(requestId)); }
  private close(request: Request030, answer: HumanAnswer030, expired: boolean, atMs: string): HumanResolution030 {
    if (request.input.reviewer === 'person') for (const workId of request.attached) this.works.get(workId)!.clock.closeHuman(request.input.requestId, atMs);
    request.resolution = { requestId: request.input.requestId, answer, expired, resolvedAtMs: atMs,
      workActions: request.attached.map(workId => ({ workId, action: request.input.kind === 'plan' && answer.decision === 'no' && !answer.comment?.trim() ? 'PLAN_REJECTED' : 'continue' })) };
    return clone(request.resolution);
  }
  private snapshot(request: Request030): HumanRequestSnapshot030 {
    return clone({ ...request.input, workIds: request.attached, answerTimeoutMs: request.timeout, resolution: request.resolution });
  }
  private get(requestId: string): Request030 {
    const request = this.requests.get(requestId);
    if (!request) fail('CORRELATION', '', 'Unknown human request.');
    return request;
  }
  private workIds(workIds: readonly string[]): void {
    if (new Set(workIds).size !== workIds.length || workIds.some(id => !this.works.has(id))) fail('CORRELATION', '', 'Unknown or duplicate work in human request.');
  }
  private limit(reviewer: 'person' | 'model', workIds: readonly string[]): Integer030 | null {
    if (reviewer !== 'person') return null;
    let limit: Integer030 | null = null;
    for (const workId of workIds) {
      const candidate = this.works.get(workId)!.answerTimeoutMs;
      if (candidate !== null && (limit === null || compareIntegers030(candidate, limit) < 0)) limit = candidate;
    }
    return limit;
  }
}
export function associateMcpRequest030(serverId: string, callsObservable: boolean,
  works: readonly { readonly workId: string; readonly servers: readonly string[]; readonly callsInProgress: readonly string[] }[]): readonly string[] {
  return [...new Set(works.filter(work => callsObservable ? work.callsInProgress.includes(serverId) : work.servers.includes(serverId)).map(work => work.workId))];
}
