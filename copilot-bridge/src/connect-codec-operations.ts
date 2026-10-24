import { validateA1 } from '../../src/services/macroPilot/protocol';
import { clearErrors as clearA1, diagnosticsEmpty as a1DiagnosticsEmpty } from '../../src/services/macroPilot/schemaValidators';
import * as authority from '../../contracts/macro-pilot/v2/transfer-authority/validate.mjs';
import * as transit from '../../contracts/macro-pilot/v2/transfer-transit/validate.mjs';
import * as decision from '../../contracts/macro-pilot/v2/transfer-transit/decision-browser.generated.mjs';
import { parseStoredJsonStrict } from '../../contracts/macro-pilot/v2/strict-json.mjs';
import { RAW_UNITS, BODY_BYTES, GRAPH_SLOT, Reject, requireCodec } from './connect-codec-framing';
import { ControlBank, canonical, CanonicalFailure, closedKeys, copyClosed, measureClosed } from './connect-codec-values';

export type Opcode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
type Facts = Record<string, any>;
const UUID = '00000000-0000-0000-0000-000000000000';
const id = (value: unknown, kind: 'id' | 'uuid' | 'origin' = 'id') => canonical(decision.validateObject(value, kind));
const session = (value: any) => canonical(transit.validateSession({ transit_contract: transit.VERSION,
  type: 'transit.open', request_id: 'codec', session: value }, value));
const exchange = (value: unknown) => canonical(decision.validateObject(value, 'exchange'));

/** Fixed closed private expectations. No dispatched/authenticated fact comes from the body. */
function validateFacts(op: Opcode, facts: Facts): void {
  switch (op) {
    case 10:
      closedKeys(facts, ['method', 'path', 'request_id_header', 'response_request_id_header', 'expected_origin', 'connection_origin', 'session_id', 'account_id', 'device_id', 'now_ms']);
      requireCodec(facts.method === 'GET' && facts.path === '/pilot/v1/me');
      for (const key of ['request_id_header', 'response_request_id_header']) id(facts[key], 'uuid');
      for (const key of ['expected_origin', 'connection_origin']) { id(facts[key], 'origin'); requireCodec(new URL(facts[key]).protocol === 'https:'); }
      requireCodec(facts.expected_origin === facts.connection_origin && facts.request_id_header === facts.response_request_id_header);
      id(facts.session_id);
      for (const key of ['account_id', 'device_id']) if (facts[key] !== null) id(facts[key]);
      requireCodec(Number.isSafeInteger(facts.now_ms));
      return;
    case 1:
      closedKeys(facts, ['request_id_header']); id(facts.request_id_header, 'uuid'); return;
    case 2:
      closedKeys(facts, ['request', 'expected', 'time']);
      closedKeys(facts.expected, ['request_id_header', 'response_request_id_header', 'expected_origin', 'connection_origin', 'account_id']);
      for (const field of ['request_id_header', 'response_request_id_header']) id(facts.expected[field], 'uuid');
      id(facts.expected.account_id); id(facts.expected.expected_origin, 'origin'); id(facts.expected.connection_origin, 'origin');
      canonical(authority.validateRequest(facts.request, facts.expected.request_id_header));
      closedKeys(facts.time, ['now_ms', 'dispatch_age_ms']);
      requireCodec(Number.isSafeInteger(facts.time.now_ms) && Number.isFinite(facts.time.dispatch_age_ms) && facts.time.dispatch_age_ms >= 0);
      return;
    case 3:
      closedKeys(facts, ['path', 'request_id', 'proof']);
      id(facts.request_id); requireCodec(transit.parseRoute('POST', facts.path) !== null);
      if (facts.proof !== null) {
        if (facts.proof.kind === 'received') closedKeys(facts.proof, ['kind', 'exchange']);
        else { closedKeys(facts.proof, ['kind', 'exchange', 'producer', 'connection']); requireCodec(facts.proof.kind === 'attestation');
          canonical(decision.validateObject(facts.proof.producer, 'producer')); id(facts.proof.connection, 'uuid'); }
        exchange(facts.proof.exchange);
      }
      return;
    case 4: {
      requireCodec(facts && typeof facts === 'object');
      const fields = { decision: ['expectation'], challenge: ['exchange'], received: ['exchange'], attestation: ['exchange', 'producer', 'connection'] };
      requireCodec(Object.hasOwn(fields, facts.kind));
      closedKeys(facts, ['kind', 'sent', ...fields[facts.kind as keyof typeof fields]]);
      canonical(transit.validateObject(facts.sent));
      requireCodec(({ decision: 'decision.request', challenge: 'decision.challenge', received: 'proof.received', attestation: 'proof.result' } as Facts)[facts.kind] === facts.sent.type);
      if (facts.kind === 'decision') {
        if (facts.expectation !== null) canonical(decision.validateObject(facts.expectation, 'expectation'));
        else requireCodec('binding' in facts.sent.request.body || facts.sent.request.operation === 'lineage.create' || facts.sent.request.operation === 'reconcile' && facts.sent.request.body.action === 'source_status');
      } else if (facts.kind === 'challenge') {
        closedKeys(facts.exchange, ['kind', 'binding_digest', 'subject_digest', 'instance_id', 'producer_generation', 'connection_id', 'request_digest', 'prior_receipt_digest']);
        exchange({ ...facts.exchange, delivery_id: UUID, challenge_id: UUID });
      } else {
        exchange(facts.exchange);
        if (facts.kind === 'received') canonical(transit.validateReceived(facts.sent, facts.exchange, facts.sent.request_id));
        else {
          canonical(decision.validateObject(facts.producer, 'producer')); id(facts.connection, 'uuid');
          canonical(transit.validateProofResult(facts.sent, facts.exchange, facts.producer, facts.connection));
        }
      }
      return;
    }
    case 5: {
      closedKeys(facts, ['context']); const c = facts.context;
      closedKeys(c, ['offered', 'confirmed', 'poll_request_id', 'response_request_id', 'response_status', 'instance_id', 'producer_generation', 'connection_id']);
      requireCodec((c.offered === null || c.offered === transit.VERSION) && (c.confirmed === null || c.confirmed === transit.VERSION));
      requireCodec(c.response_status === 200 || c.response_status === 204);
      for (const field of ['poll_request_id', 'response_request_id', 'instance_id', 'producer_generation']) id(c[field]);
      id(c.connection_id, 'uuid'); // This private native adapter never accepts unknown selection facts.
      if (c.response_status === 204) requireCodec(c.confirmed === null && c.response_request_id === c.poll_request_id);
      else if (c.confirmed !== null) requireCodec(transit.acceptedOffer(c.offered, c.confirmed));
      return;
    }
    case 6:
      closedKeys(facts, ['session', 'cursor']);
      canonical(transit.validateObject({ transit_contract: transit.VERSION, type: 'transit.opened', request_id: 'codec', session: facts.session, cursor: facts.cursor })); return;
    case 7:
      closedKeys(facts, ['session', 'chunk', 'request_id']); session(facts.session); id(facts.request_id);
      canonical(transit.validateObject(facts.chunk)); requireCodec(facts.chunk.type === 'transit.chunk'); return;
    case 8: case 9:
      closedKeys(facts, ['session', 'request_id']); session(facts.session); id(facts.request_id); return;
  }
}

export function bodyDescriptor(op: Opcode, facts?: Facts): { units: number; limit: number } {
  if (op === 1 || op === 2) {
    const kind = op === 1 ? 'request' : 'response';
    return { units: authority.admissionUnits(kind, { working: 0, copies: 0 }), limit: authority.LIMITS[kind] };
  }
  const noBody = op === 5 && facts && (facts.context.response_status === 204 || facts.context.confirmed === null);
  return { units: RAW_UNITS, limit: noBody ? 0 : BODY_BYTES };
}

export function prepareFacts(op: Opcode, bytes: Uint8Array, bank: ControlBank) {
  // The caller holds the full raw lease before UTF-8 decoding, JSON and validation.
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = parseStoredJsonStrict(raw) as Facts;
  measureClosed(value); validateFacts(op, value);
  return copyClosed(value, bank, 'expectation');
}

/** Extra independent-input transients, apart from the canon's own raw/working/copy tariff.
 * Each call acquires the actual maximum simultaneous closed slots before canonical code.
 * See connect-codec.md for path-by-path lifetimes and the maximum-vector checks. */
export function validatorSlots(op: Opcode, facts: Facts): number {
  if (op === 1 || op === 5 || op === 10) return 0;
  if (op === 2 || op === 3 || op === 6 || op === 8 || op === 9) return 3;
  if (op === 4) return 5;
  const chunk = measureClosed(facts.chunk);
  // canonicalJson's disjoint live render parts + joins + return string, plus 256/node.
  const render = Math.ceil((8 * chunk.jsonUnits + 256 * chunk.nodes) / GRAPH_SLOT);
  requireCodec(render <= 5, Reject.limit);
  return render + 2; // full retained JSON comparison + structuredClone(empty chunk)
}

export function reserveAdapter(units: number): { reserve(n: number): () => void; done(required: boolean): void } {
  let consumed = false, requestedRelease = false;
  return {
    reserve(n) {
      requireCodec(!consumed && n === units, Reject.credit); consumed = true;
      return () => { requireCodec(!requestedRelease, Reject.credit); requestedRelease = true; };
    },
    done(required) { requireCodec(required ? consumed && requestedRelease : !consumed && !requestedRelease, Reject.credit); },
  };
}
export const refuseLegacyContent = (): never => { throw new CanonicalFailure(); };
export const cleanDiagnostics = (): void => { clearA1(); requireCodec(a1DiagnosticsEmpty() && transit.diagnosticsEmpty() && authority.diagnosticsEmpty(), Reject.state); };
export type BodyResult = { status: 0 | 1 | 3; closed?: ReturnType<typeof copyClosed> };

export async function validateBody(op: Opcode, bytes: Uint8Array, facts: Facts, contextStarted: number, bank: ControlBank): Promise<BodyResult> {
  const descriptor = bodyDescriptor(op, facts);
  const adapter = reserveAdapter(descriptor.units);
  const releasePlan = op === 6 ? bank.graphs('cursor-borrow', 1) : undefined;
  const releaseTemps = bank.graphs('validator', validatorSlots(op, facts) - (op === 6 ? 1 : 0));
  const releaseBytes = [2, 3, 4, 7].includes(op) ? bank.bytes('validator-bytes', BODY_BYTES) : undefined;
  const releasePage = op === 7 ? bank.pages('hash-input', 1) : undefined;
  let tempsLive = true;
  const endTemps = () => { if (tempsLive) { releaseTemps(); releaseBytes?.(); releasePage?.(); tempsLive = false; } };
  let closed: ReturnType<typeof copyClosed> | undefined;
  const capture = (value: unknown) => { endTemps(); closed = copyClosed(value, bank, 'result'); };
  const load = async () => bytes;
  const ports = { reserve: adapter.reserve, charges: { working: 0, copies: 0 } };
  let success = false, usesRaw = true;
  try {
    if (op === 10) {
      const release = adapter.reserve(RAW_UNITS);
      try {
        // The native owner granted the full graph before this first decode.
        const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const value = parseStoredJsonStrict(raw) as Facts;
        closedKeys(value, ['transport_version', 'account', 'device_session']);
        requireCodec(value.transport_version === '1.0');
        const account = value.account, session = value.device_session;
        requireCodec(validateA1(account) && validateA1(session));
        requireCodec(account.type === 'account' && session.type === 'device_session' && session.state === 'active');
        requireCodec(session.ref.account_id === account.account_id && session.ref.session_id === facts.session_id);
        requireCodec(facts.account_id === null || account.account_id === facts.account_id);
        requireCodec(facts.device_id === null || session.device_id === facts.device_id);
        const now = facts.now_ms + Math.floor(performance.now() - contextStarted);
        const expiry = session.expires_at === undefined ? null : Date.parse(session.expires_at);
        requireCodec(expiry === null || Number.isFinite(expiry) && expiry > now);
        capture({ account_id: account.account_id, session_id: session.ref.session_id,
          device_id: session.device_id, session_revision: session.revision, expires_at_ms: expiry });
        success = true;
      } catch { success = false; }
      finally { clearA1(); release(); }
    } else if (op === 1) success = (await authority.withRequest(load, ports, facts.request_id_header, capture)).valid;
    else if (op === 2) success = (await authority.withResponse(load, ports, facts.request, facts.expected, () => {
      const elapsed = performance.now() - contextStarted;
      requireCodec(Number.isFinite(elapsed) && elapsed >= 0);
      return { now_ms: facts.time.now_ms + Math.floor(elapsed), dispatch_age_ms: facts.time.dispatch_age_ms + elapsed };
    }, capture)).valid;
    else if (op === 5) {
      const c = facts.context;
      if (c.response_status === 200 && c.confirmed === null) {
        usesRaw = false;
        return { status: 3 }; // No content parser, loader or validation claim.
      }
      usesRaw = c.response_status !== 204;
      success = (await transit.withProducerDelivery(load, { reserve: adapter.reserve,
        withContent: async () => refuseLegacyContent(),
        validateContent: refuseLegacyContent,
      }, c, capture)).valid;
    } else if (op === 6) success = (await transit.withChunk(load, ports, facts.session, facts.cursor,
      (message, plan) => capture({ message, kind: plan.kind, cursor: plan.cursor }))).valid;
    else success = (await transit.withDecoded(load, ports, message => {
      if (op === 3) {
        requireCodec(message.request_id === facts.request_id);
        canonical(transit.validateRoute(transit.parseRoute('POST', facts.path), message));
        if (message.type === 'proof.received') {
          requireCodec(facts.proof?.kind === 'received'); canonical(transit.validateReceived(message, facts.proof.exchange, facts.request_id));
        } else if (message.type === 'proof.result') {
          requireCodec(facts.proof?.kind === 'attestation'); canonical(transit.validateProofResult(message, facts.proof.exchange, facts.proof.producer, facts.proof.connection));
        } else requireCodec(facts.proof === null);
      } else if (op === 4) {
        requireCodec(message.request_id === facts.sent.request_id);
        if (message.type !== 'error') {
          if (facts.kind === 'decision') {
            requireCodec(message.type === 'decision.reply');
            canonical(transit.validateDecisionReply(facts.sent, message, facts.expectation === null ? undefined : facts.expectation));
          } else if (facts.kind === 'challenge') {
            requireCodec(message.type === 'decision.exchange');
            canonical(transit.validateChallengeReply(facts.sent, message, { ...facts.exchange,
              delivery_id: message.exchange.delivery_id, challenge_id: message.exchange.challenge_id }));
          } else requireCodec(message.type === 'accepted');
        }
      } else if (op === 7) {
        requireCodec(message.type === 'transit.ack'); canonical(transit.validateAck(message, facts.chunk, facts.session, facts.request_id));
      } else if (op === 8) {
        requireCodec(message.type === 'transit.progress'); canonical(transit.validateProgress(message, facts.session, facts.request_id));
      } else {
        requireCodec((message.type === 'transit.open' || message.type === 'transit.opened') && message.request_id === facts.request_id);
        canonical(transit.validateSession(message, facts.session));
      }
      capture(message);
    })).valid;
    if (!success && closed) { closed.release(); closed = undefined; }
    return success && closed ? { status: 0, closed } : { status: 1 };
  } finally {
    endTemps(); releasePlan?.(); adapter.done(usesRaw); cleanDiagnostics();
  }
}
