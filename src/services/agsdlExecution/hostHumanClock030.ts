import { decode } from './exact';
import { monotoneMs030 } from './workIntegers030';
import { HumanWaitRegistry030, WorkClock030, type HumanAnswer030, type HumanRequestKind030, type HumanResolution030, type WorkClockSnapshot030 } from './workClock030';

export interface HumanClockOwner030 { readonly systemStartId: string; readonly ownerEpoch: string }
export interface HumanClockOptions030 { readonly maxSliceMs: number }
export type HumanClockEventBody030 =
  | { readonly kind: 'admit'; readonly workId: string; readonly timeoutMs: string | null; readonly answerTimeoutMs: string | null }
  | { readonly kind: 'retire'; readonly workId: string }
  | { readonly kind: 'open'; readonly requestId: string; readonly requestKind: HumanRequestKind030; readonly reviewer: 'person' | 'model'; readonly workIds: readonly string[] }
  | { readonly kind: 'associate'; readonly requestId: string; readonly workIds: readonly string[] }
  | { readonly kind: 'answer'; readonly requestId: string; readonly nativeReceiptId: string; readonly answer: HumanAnswer030 | null }
  | { readonly kind: 'tick' }
  | { readonly kind: 'ack'; readonly requestId: string };
export interface HumanClockEvent030 {
  readonly owner: HumanClockOwner030;
  readonly eventId: string;
  /** Captured monotone milliseconds within the native owner epoch. */
  readonly nowMs: string;
  readonly event: HumanClockEventBody030;
}
export interface NativeAnswerReference030 {
  readonly requestId: string;
  readonly nativeReceiptId: string;
  readonly accepted: boolean;
}
export interface HumanClockResolution030 {
  readonly requestId: string;
  readonly expired: boolean;
  readonly resolvedAtMs: string;
  readonly workActions: HumanResolution030['workActions'];
  readonly answer: { readonly kind: 'decision'; readonly decision: 'yes' | 'no'; readonly comment?: string }
    | { readonly kind: 'native'; readonly nativeReceiptId: string }
    | { readonly kind: 'expired' };
}
export interface HumanClockReceipt030 {
  readonly clocks: readonly { readonly workId: string; readonly snapshot: WorkClockSnapshot030 }[];
  readonly expiredWorkIds: readonly string[];
  readonly pendingResolutions: readonly HumanClockResolution030[];
  /** References are never interpreted as the answer to a free-form question. */
  readonly nativeAnswers: readonly NativeAnswerReference030[];
  readonly nextWakeMs: number | null;
}
interface JournalEntry030 { readonly eventJson: string; readonly receiptJson: string }
interface Journal030 {
  readonly format: 'macro-agsdl-human-clock-journal/1';
  readonly owner: HumanClockOwner030;
  readonly options: HumanClockOptions030;
  readonly entries: readonly JournalEntry030[];
}
export const EMPTY_HUMAN_CLOCK_JOURNAL030 = '';

function object030(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('CORRELATION: expected an object.');
  return value as Record<string, unknown>;
}
function keys030(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('CORRELATION: unexpected field.');
}
function id030(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('CORRELATION: invalid identity.');
  return value;
}
function nullableString030(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') throw new Error('CORRELATION: invalid exact limit.');
  return value;
}
function ids030(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('CORRELATION: invalid work identities.');
  return value.map(id030);
}
function parse030(text: string): unknown {
  if (typeof text !== 'string') throw new Error('CORRELATION: expected JSON text.');
  decode(text); // Reject malformed JSON and duplicate keys before parsing metadata.
  return JSON.parse(text) as unknown;
}
function parseOwner030(value: unknown): HumanClockOwner030 {
  const owner = object030(value); keys030(owner, ['systemStartId', 'ownerEpoch']);
  return { systemStartId: id030(owner.systemStartId), ownerEpoch: id030(owner.ownerEpoch) };
}
function sameOwner030(left: HumanClockOwner030, right: HumanClockOwner030): boolean {
  return left.systemStartId === right.systemStartId && left.ownerEpoch === right.ownerEpoch;
}
function parseEvent030(eventJson: string, owner: HumanClockOwner030): HumanClockEvent030 {
  const envelope = object030(parse030(eventJson));
  keys030(envelope, ['owner', 'eventId', 'nowMs', 'event']);
  const eventOwner = parseOwner030(envelope.owner);
  if (!sameOwner030(eventOwner, owner)) throw new Error('CORRELATION: foreign or revoked owner.');
  const eventId = id030(envelope.eventId), nowMs = id030(envelope.nowMs);
  monotoneMs030(nowMs);
  const body = object030(envelope.event), kind = body.kind;
  let event: HumanClockEventBody030;
  switch (kind) {
    case 'admit':
      keys030(body, ['kind', 'workId', 'timeoutMs', 'answerTimeoutMs']);
      event = { kind, workId: id030(body.workId), timeoutMs: nullableString030(body.timeoutMs), answerTimeoutMs: nullableString030(body.answerTimeoutMs) }; break;
    case 'retire':
      keys030(body, ['kind', 'workId']); event = { kind, workId: id030(body.workId) }; break;
    case 'open': {
      keys030(body, ['kind', 'requestId', 'requestKind', 'reviewer', 'workIds']);
      if (!['ask', 'plan', 'question'].includes(String(body.requestKind)) || !['person', 'model'].includes(String(body.reviewer))) throw new Error('CORRELATION: invalid request type.');
      event = { kind, requestId: id030(body.requestId), requestKind: body.requestKind as HumanRequestKind030, reviewer: body.reviewer as 'person' | 'model', workIds: ids030(body.workIds) }; break;
    }
    case 'associate':
      keys030(body, ['kind', 'requestId', 'workIds']); event = { kind, requestId: id030(body.requestId), workIds: ids030(body.workIds) }; break;
    case 'answer': {
      keys030(body, ['kind', 'requestId', 'nativeReceiptId', 'answer']);
      let answer: HumanAnswer030 | null = null;
      if (body.answer !== null) {
        const parsed = object030(body.answer); keys030(parsed, ['decision', 'comment']);
        if (parsed.decision !== 'yes' && parsed.decision !== 'no' || parsed.comment !== undefined && typeof parsed.comment !== 'string') throw new Error('CORRELATION: invalid answer projection.');
        answer = parsed.comment === undefined ? { decision: parsed.decision } : { decision: parsed.decision, comment: parsed.comment as string };
      }
      event = { kind, requestId: id030(body.requestId), nativeReceiptId: id030(body.nativeReceiptId), answer }; break;
    }
    case 'tick': keys030(body, ['kind']); event = { kind }; break;
    case 'ack': keys030(body, ['kind', 'requestId']); event = { kind, requestId: id030(body.requestId) }; break;
    default: throw new Error('CORRELATION: unknown clock event.');
  }
  return { owner: eventOwner, eventId, nowMs, event };
}

class HumanClockProjection030 {
  private readonly registry = new HumanWaitRegistry030();
  private readonly clocks = new Map<string, WorkClock030>();
  private readonly requests = new Map<string, HumanRequestKind030>();
  private readonly answers = new Map<string, NativeAnswerReference030>();
  private readonly answerSignatures = new Map<string, string>();
  private readonly acceptedAnswers = new Set<string>();
  constructor(private readonly options: HumanClockOptions030) {}
  dispatch(input: HumanClockEvent030): HumanClockReceipt030 {
    const { nowMs, event } = input;
    this.registry.tick(nowMs);
    switch (event.kind) {
      case 'admit': {
        const clock = new WorkClock030(event.timeoutMs, nowMs);
        this.registry.registerWork(event.workId, clock, event.answerTimeoutMs);
        this.clocks.set(event.workId, clock); break;
      }
      case 'retire': this.registry.unregisterWork(event.workId, nowMs); this.clocks.delete(event.workId); break;
      case 'open':
        this.registry.open({ requestId: event.requestId, kind: event.requestKind, reviewer: event.reviewer, workIds: event.workIds, openedAtMs: nowMs });
        this.requests.set(event.requestId, event.requestKind); break;
      case 'associate': this.registry.setRequestWorks(event.requestId, event.workIds, nowMs); break;
      case 'answer': {
        const kind = this.requests.get(event.requestId);
        if (!kind) throw new Error('CORRELATION: unknown request.');
        if (kind === 'question' ? event.answer !== null : event.answer === null) throw new Error('CORRELATION: answer projection does not match request kind.');
        const signature = JSON.stringify({ requestId: event.requestId, answer: event.answer });
        const previous = this.answerSignatures.get(event.nativeReceiptId);
        if (previous !== undefined && previous !== signature) throw new Error('CORRELATION: conflicting native answer receipt.');
        if (previous === undefined) {
          const alreadyResolved = this.registry.request(event.requestId).resolution !== null;
          // For free-form answers, yes is only a local closure marker. The actual
          // answer remains the native receipt referenced below.
          const resolution = this.registry.resolve(event.requestId, event.answer ?? { decision: 'yes' }, nowMs);
          const accepted = !alreadyResolved && !resolution.expired && !this.acceptedAnswers.has(event.requestId);
          if (accepted) this.acceptedAnswers.add(event.requestId);
          this.answerSignatures.set(event.nativeReceiptId, signature);
          this.answers.set(event.nativeReceiptId, { requestId: event.requestId, nativeReceiptId: event.nativeReceiptId, accepted });
        }
        break;
      }
      case 'tick': break;
      case 'ack': this.registry.acknowledgeResolution(event.requestId); break;
    }
    const nextWakeMs = this.registry.nextWakeMs(nowMs, this.options.maxSliceMs);
    const clocks = [...this.clocks].map(([workId, clock]) => ({ workId, snapshot: clock.snapshot() }));
    return { clocks, expiredWorkIds: clocks.filter(item => item.snapshot.expired).map(item => item.workId),
      pendingResolutions: this.registry.pendingResolutions().map(resolution => this.projectResolution(resolution)), nativeAnswers: [...this.answers.values()].map(answer => ({ ...answer })), nextWakeMs };
  }
  private projectResolution(resolution: HumanResolution030): HumanClockResolution030 {
    const { requestId, expired, resolvedAtMs, workActions } = resolution;
    if (this.requests.get(requestId) === 'question') {
      if (expired) return { requestId, expired, resolvedAtMs, workActions, answer: { kind: 'expired' } };
      const reference = [...this.answers.values()].find(item => item.requestId === requestId && item.accepted);
      if (!reference) throw new Error('CORRELATION: question resolution lacks a native receipt.');
      return { requestId, expired, resolvedAtMs, workActions, answer: { kind: 'native', nativeReceiptId: reference.nativeReceiptId } };
    }
    return { requestId, expired, resolvedAtMs, workActions, answer: { kind: 'decision', ...resolution.answer } };
  }
}

/** Native CAS owns the journal and authenticates the epoch, options and timestamps.
 * Replaying this function performs no I/O, timer, provider call or effect. */
export function evaluateHostHumanClock030(
  context: HumanClockOwner030, eventId: string, expectedRevision: string,
  stateJson: string, eventJson: string, options: HumanClockOptions030,
): { readonly stateJson: string; readonly receiptJson: string } {
  const owner = parseOwner030(context);
  id030(eventId);
  if (!/^(0|[1-9][0-9]*)$/.test(expectedRevision)) throw new Error('CORRELATION: invalid journal revision.');
  const config = object030(options); keys030(config, ['maxSliceMs']);
  if (typeof options.maxSliceMs !== 'number' || !Number.isSafeInteger(options.maxSliceMs) || options.maxSliceMs < 1 || options.maxSliceMs > 2147483647) throw new Error('CORRELATION: invalid timer slice.');
  const current: Journal030 = stateJson === EMPTY_HUMAN_CLOCK_JOURNAL030
    ? { format: 'macro-agsdl-human-clock-journal/1', owner, options: { maxSliceMs: options.maxSliceMs }, entries: [] }
    : parse030(stateJson) as Journal030;
  const journal = object030(current); keys030(journal, ['format', 'owner', 'options', 'entries']);
  const journalOptions = object030(current.options); keys030(journalOptions, ['maxSliceMs']);
  if (current.format !== 'macro-agsdl-human-clock-journal/1' || !sameOwner030(parseOwner030(current.owner), owner)
    || journalOptions.maxSliceMs !== options.maxSliceMs || !Array.isArray(current.entries)
    || BigInt(expectedRevision) !== BigInt(current.entries.length)) throw new Error('CORRELATION: journal capture or native revision differs.');
  const projection = new HumanClockProjection030(options);
  const seen = new Map<string, { eventJson: string; receiptJson: string }>();
  const operations = new Map<string, { signature: string }>();
  let latestReceiptJson = ''; // An existing business operation always follows a dispatch.
  const apply = (input: HumanClockEvent030): string => {
    const event = input.event;
    const key = event.kind === 'admit' || event.kind === 'retire' ? JSON.stringify([event.kind, event.workId])
      : event.kind === 'open' ? JSON.stringify([event.kind, event.requestId])
      : event.kind === 'answer' ? JSON.stringify([event.kind, event.nativeReceiptId]) : null;
    const signature = JSON.stringify({ nowMs: input.nowMs, event });
    const prior = key === null ? undefined : operations.get(key);
    if (prior) {
      if (prior.signature !== signature) throw new Error('CORRELATION: operation identity has conflicting content.');
      // A new event for an existing operation must preserve the current aggregate
      // state, including later expirations, answers and acknowledgements.
      return latestReceiptJson;
    }
    const receiptJson = JSON.stringify(projection.dispatch(input));
    if (key !== null) operations.set(key, { signature });
    latestReceiptJson = receiptJson;
    return receiptJson;
  };
  const entries: JournalEntry030[] = [];
  for (const item of current.entries) {
    const entry = object030(item); keys030(entry, ['eventJson', 'receiptJson']);
    if (typeof entry.eventJson !== 'string' || typeof entry.receiptJson !== 'string') throw new Error('CORRELATION: invalid journal entry.');
    const input = parseEvent030(entry.eventJson, owner);
    if (seen.has(input.eventId)) throw new Error('CORRELATION: repeated stored event.');
    const actual = apply(input);
    if (actual !== entry.receiptJson) throw new Error('CORRELATION: journal receipt cannot be reproduced.');
    const captured = { eventJson: entry.eventJson, receiptJson: entry.receiptJson };
    seen.set(input.eventId, captured); entries.push(captured);
  }
  const input = parseEvent030(eventJson, owner);
  if (input.eventId !== eventId) throw new Error('CORRELATION: event identity differs from native job.');
  const previous = seen.get(eventId);
  if (previous) {
    if (previous.eventJson !== eventJson) throw new Error('CORRELATION: event identity has conflicting content.');
    return { stateJson, receiptJson: previous.receiptJson };
  }
  const receiptJson = apply(input);
  const next: Journal030 = { format: 'macro-agsdl-human-clock-journal/1', owner, options: { maxSliceMs: options.maxSliceMs }, entries: [...entries, { eventJson, receiptJson }] };
  return { stateJson: JSON.stringify(next), receiptJson };
}
