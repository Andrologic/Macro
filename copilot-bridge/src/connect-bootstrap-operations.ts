import { validateA1 } from '../../src/services/macroPilot/protocol';
import { clearErrors as clearA1, diagnosticsEmpty } from '../../src/services/macroPilot/schemaValidators';
import * as decision from '../../contracts/macro-pilot/v2/transfer-transit/decision-browser.generated.mjs';
import { parseStoredJsonStrict } from '../../contracts/macro-pilot/v2/strict-json.mjs';
import { RAW_UNITS, BODY_BYTES, Reject, requireCodec } from './connect-codec-framing';
import { ControlBank, canonical, closedKeys, copyClosed, measureClosed } from './connect-codec-values';
import { reserveAdapter, type Opcode, type BodyResult } from './connect-codec-operations';
export { reserveAdapter };
type Facts = Record<string, any>;
const id = (value: unknown, kind: 'id' | 'uuid' | 'origin' = 'id') => canonical(decision.validateObject(value, kind));
export const cleanDiagnostics = () => { clearA1(); requireCodec(diagnosticsEmpty(), Reject.state); };
export const bodyDescriptor = () => ({ units: RAW_UNITS, limit: BODY_BYTES });
export function prepareFacts(op: Opcode, bytes: Uint8Array, bank: ControlBank) {
  requireCodec(op === 10, Reject.state);
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const facts = parseStoredJsonStrict(raw) as Facts;
  measureClosed(facts);
      closedKeys(facts, ['method', 'path', 'request_id_header', 'response_request_id_header', 'expected_origin', 'connection_origin', 'session_id', 'account_id', 'device_id', 'now_ms']);
      requireCodec(facts.method === 'GET' && facts.path === '/pilot/v1/me');
      for (const key of ['request_id_header', 'response_request_id_header']) id(facts[key], 'uuid');
      for (const key of ['expected_origin', 'connection_origin']) { id(facts[key], 'origin'); requireCodec(new URL(facts[key]).protocol === 'https:'); }
      requireCodec(facts.expected_origin === facts.connection_origin && facts.request_id_header === facts.response_request_id_header);
      id(facts.session_id);
      for (const key of ['account_id', 'device_id']) if (facts[key] !== null) id(facts[key]);
      requireCodec(Number.isSafeInteger(facts.now_ms));
  return copyClosed(facts, bank, 'expectation');
}
export async function validateBody(op: Opcode, bytes: Uint8Array, facts: Facts, contextStarted: number, bank: ControlBank): Promise<BodyResult> {
  requireCodec(op === 10, Reject.state);
  const adapter = reserveAdapter(RAW_UNITS);
  let closed: ReturnType<typeof copyClosed> | undefined;
  const capture = (value: unknown) => { closed = copyClosed(value, bank, 'result'); };
  let success = false;
  try {
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
    if (!success && closed) { closed.release(); closed = undefined; }
    return success && closed ? { status: 0, closed } : { status: 1 };
  } finally { adapter.done(true); cleanDiagnostics(); }
}
