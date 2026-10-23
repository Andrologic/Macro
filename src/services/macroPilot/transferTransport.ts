/** Inactive metadata transport only. No native job, pin, staging or payload owner. */
import type { DecisionExchange, DecisionExpectation, DecisionProducer } from '../../../contracts/macro-pilot/v2/transfer-decision.js';
import type { TransitAttestation, TransitChallenge, TransitDecisionRequest, TransitDecisionReply, TransitDelivery, TransitExchange, TransitMessage, TransitReceived, Reserve } from '../../../contracts/macro-pilot/v2/transfer-transit/validate.mjs';
import { PilotClientError } from './clientError';

// Lightweight negotiation constants; do not import the ~900KiB codec at startup.
export const TRANSFER_HEADER = 'X-Macro-Transfer-Transit';
export const TRANSFER_VERSION = 'transfer-transit-1';
export const TRANSFER_BODY_BYTES = 98304;
export const TRANSFER_ADMISSION = 28311552;
type Codec = typeof import('../../../contracts/macro-pilot/v2/transfer-transit/validate.mjs');
let codec: Promise<Codec> | undefined;
export const loadTransferCodec = (): Promise<Codec> => codec ??= import('../../../contracts/macro-pilot/v2/transfer-transit/validate.mjs');

export interface TransferMetadataOptions {
  /** Two simultaneous conservative 27MiB logical reservations. A 32MiB owner
   * refuses before dispatch. They do not account for native HTTP copies and
   * their release never proves physical completion. The native host must admit
   * and bound construction/validation of the original plain request and
   * independent authority facts before this call. No arbitrary JS/proxy input. */
  reserve: Reserve;
  /** Must revalidate the real owner immediately after credential waits. */
  beforeSend(): Promise<void>;
  onDispatch?(): void;
}
export type MetadataRequest = TransitDecisionRequest | TransitChallenge | TransitReceived | TransitAttestation;
export type TransferReception =
  | { kind: 'decision'; sent: TransitDecisionRequest; expectation: DecisionExpectation | undefined }
  | { kind: 'challenge'; sent: TransitChallenge; exchange: Omit<DecisionExchange, 'delivery_id' | 'challenge_id'> }
  | { kind: 'received'; sent: TransitReceived; exchange: DecisionExchange }
  | { kind: 'attestation'; sent: TransitAttestation; exchange: DecisionExchange; producer: DecisionProducer; connection: string };
function refused(): never { throw new PilotClientError('invalid_response'); }
/** Only adapter wrapper keys are checked here. Canonical owners validate all
 * metadata definitions and limits. Shape validators accept plain data, not a
 * sandbox for hostile getters/proxies; original construction is host-admitted. */
function closed(value: object, keys: string[]): void {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refused();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
  })) refused();
}
export async function validateMetadataRequest(path: string, sent: MetadataRequest, reception: TransferReception): Promise<{
  codec: Codec; saved: { body: MetadataRequest; reception: TransferReception };
}> {
  const c = await loadTransferCodec();
  const decision = await import('../../../contracts/macro-pilot/v2/transfer-transit/decision-browser.generated.mjs');
  const kind = Object.getOwnPropertyDescriptor(reception ?? {}, 'kind')?.value;
  const fields: Record<string, string[]> = { decision: ['expectation'], challenge: ['exchange'], received: ['exchange'], attestation: ['exchange', 'producer', 'connection'] };
  if (typeof kind !== 'string' || !Object.hasOwn(fields, kind)) refused();
  closed(reception, ['kind', 'sent', ...fields[kind]]);
  if (reception.sent !== sent || !c.validateObject(sent).valid || !c.validateRoute(c.parseRoute('POST', path), sent).valid) refused();
  if (({ decision: 'decision.request', challenge: 'decision.challenge', received: 'proof.received', attestation: 'proof.result' }[reception.kind] !== sent.type)) refused();
  if (reception.kind === 'decision' && reception.expectation !== undefined && !decision.validateObject(reception.expectation, 'expectation').valid) refused();
  if (reception.kind === 'decision' && sent.type === 'decision.request' && reception.expectation === undefined && !('binding' in sent.request.body) && sent.request.operation !== 'lineage.create' && !(sent.request.operation === 'reconcile' && sent.request.body.action === 'source_status')) refused();
  if (reception.kind === 'challenge') {
    // These two IDs belong to the later relay reply, not independent facts.
    // A validated request UUID only fills their schema slots for this check.
    closed(reception.exchange, ['kind', 'binding_digest', 'subject_digest', 'instance_id', 'producer_generation', 'connection_id', 'request_digest', 'prior_receipt_digest']);
    if (!decision.validateObject({ ...reception.exchange, delivery_id: sent.request_id, challenge_id: sent.request_id }, 'exchange').valid) refused();
  }
  if (reception.kind === 'received' && (sent.type !== 'proof.received' || !decision.validateObject(reception.exchange, 'exchange').valid || sent.request_id !== reception.exchange.delivery_id || !c.validateReceived(sent, reception.exchange, reception.exchange.delivery_id).valid)) refused();
  if (reception.kind === 'attestation' && (sent.type !== 'proof.result' || !decision.validateObject(reception.exchange, 'exchange').valid || !decision.validateObject(reception.producer, 'producer').valid || !decision.validateObject(reception.connection, 'uuid').valid || sent.request_id !== reception.exchange.delivery_id || !c.validateProofResult(sent, reception.exchange, reception.producer, reception.connection).valid)) refused();
  // Bound the combined retained graph with the existing 96KiB canon ceiling,
  // including wrapper keys and the shared sent value rendered twice. Optional
  // undefined expectation is a single empty slot, represented as null here.
  const retained = { body: sent, reception: reception.kind === 'decision' && reception.expectation === undefined
    ? { kind: reception.kind, sent, expectation: null } : reception };
  if (decision.metadataBytes(retained) > c.LIMITS.body) refused();
  // Validation and clone are synchronous in this continuation. There is no
  // await where the caller could replace facts between those two operations.
  return { codec: c, saved: structuredClone({ body: sent, reception }) };
}
export function checkMetadataReply(c: Codec, sent: MetadataRequest, message: TransitMessage, reception: TransferReception): void {
  if (message.request_id !== sent.request_id) refused();
  if (message.type === 'error') return;
  if (reception.kind === 'decision') {
    if (message.type !== 'decision.reply' || !c.validateDecisionReply(reception.sent, message as TransitDecisionReply, reception.expectation).valid) refused();
  } else if (reception.kind === 'challenge') {
    if (message.type !== 'decision.exchange') refused();
    // Fresh challenge/delivery UUIDs are issued by the relay. All other facts
    // are independently expected; these IDs remain untrusted challenge data,
    // not a receipt of native work or an attestation.
    const expected = { ...reception.exchange, delivery_id: message.exchange.delivery_id, challenge_id: message.exchange.challenge_id };
    if (!c.validateChallengeReply(reception.sent, message as TransitExchange, expected).valid) refused();
  } else if (message.type !== 'accepted') refused();
}
export type ProducerPollReply = { branch: 'content'; data: unknown } | { branch: 'empty'; data: null }
  | { branch: 'transfer' };
/** The existing poll may use this union. Its ordinary caller offers nothing.
 * No response/header creates a job or authenticates a producer. */
export async function readProducerPollReply(response: Response, options: {
  offered: string | null;
  requestId: string;
  instanceId: string;
  producerGeneration: string | null;
  connectionId: string | null;
  reserve: Reserve;
  load: () => Promise<Uint8Array>;
  legacy: () => Promise<unknown>;
  validateContent: (message: unknown) => boolean;
  /** Borrowed view. Retention requires the consumer's own admission. */
  consumeTransfer: (message: TransitDelivery) => void | Promise<void>;
}): Promise<ProducerPollReply> {
  const confirmed = response.headers.get(TRANSFER_HEADER);
  if (confirmed === null) {
    // No codec import or changed legacy parser/admission for silent old peers.
    const data = await options.legacy();
    return { branch: response.status === 204 ? 'empty' : 'content', data } as ProducerPollReply;
  }
  if (options.offered !== TRANSFER_VERSION || confirmed !== TRANSFER_VERSION) refused();
  const c = await loadTransferCodec();
  let reply: ProducerPollReply | undefined;
  const result = await c.withProducerDelivery(options.load, { reserve: options.reserve,
    withContent: async () => { refused(); }, validateContent: options.validateContent,
  }, { offered: options.offered, confirmed, poll_request_id: options.requestId,
    response_request_id: response.headers.get('X-Request-Id') ?? '', response_status: response.status as 200 | 204,
    instance_id: options.instanceId, producer_generation: options.producerGeneration, connection_id: options.connectionId,
  }, async value => {
    if (value.branch !== 'transit') refused();
    // No physical native HTTP/staging owner is available. Do not consume payload.
    if (value.value.body.kind === 'transit.chunk') refused();
    await options.consumeTransfer(value.value);
    reply = { branch: 'transfer' };
  });
  if (!result.valid || !reply) refused();
  return reply;
}
