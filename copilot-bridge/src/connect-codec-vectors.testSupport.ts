import { createHash } from 'node:crypto';
import vectors from '../../contracts/macro-pilot/v2/transfer-transit/vectors.json';
// @ts-expect-error The existing canonical JS conformance fixture has no declarations.
import { scenario } from '../../contracts/macro-pilot/test/transfer-decision-vectors.mjs';
import * as transit from '../../contracts/macro-pilot/v2/transfer-transit/validate.mjs';
import type { Opcode } from './connect-codec-operations';

export type CodecVector = { name: string; op: Opcode; facts: Record<string, any>; body: any };
export function codecVectors(maximal = false): CodecVector[] {
  const s = scenario(maximal), context = s.context;
  const rid = maximal ? 'r'.repeat(128) : 'synthetic-request';
  const now = Date.parse('2026-10-24T00:00:00.000Z');
  const request = { authority_contract: 'transfer-authority-1', type: 'preflight', request_id: s.uuid(),
    scope: { kind: 'controller', source_instance_id: s.source.source_instance_id, target_instance_id: s.binding.target_instance_id } };
  const expected = { request_id_header: request.request_id, response_request_id_header: request.request_id,
    account_id: s.source.account_id, expected_origin: s.source.relay_origin, connection_origin: s.source.relay_origin };
  const snapshot = { authority_contract: 'transfer-authority-1', type: 'authority_snapshot', request_id: request.request_id,
    scope: structuredClone(request.scope), authority_origin: s.source.relay_origin,
    issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 29000).toISOString(),
    actor: context.actor.identity, source_producer: context.producers[0], target_producer: context.producers[1],
    recovery_generation: context.recovery_generation, history: 'intact' };
  const sent = { transit_contract: transit.VERSION, type: 'decision.request', request_id: rid, request: s.reserve.request };
  const retry = s.call(s.reserve.request, s.reserve.result.ledger, s.reserve.result.record, s.reserve.context.proofs).result;
  const data = maximal ? 'x'.repeat(65536) : vectors.context.first.data_utf8;
  const length = new TextEncoder().encode(data).byteLength;
  const session = { ...vectors.context.session, ...(maximal ? { portable_records: '9223372036854775790', portable_fragments: '9223372036854775790', portable_payload_bytes: '9223372036854775790', stream_bytes: '9223372036854775790' } : {}) };
  const chunk: transit.TransitChunk = { ...vectors.context.first, transit_contract: transit.VERSION, type: 'transit.chunk', request_id: rid, length: String(length), sha256: createHash('sha256').update(data).digest('hex'), data_utf8: data, eof: false };
  const plan = transit.inspectChunk(chunk, session, vectors.context.empty);
  if (!plan.valid) throw Error('invalid_synthetic_vector');
  const ack = { transit_contract: transit.VERSION, type: 'transit.ack', request_id: rid,
    transfer_id: session.transfer_id, transit_id: session.transit_id, sequence: chunk.sequence, offset: chunk.offset,
    length: chunk.length, sha256: chunk.sha256, eof: chunk.eof, next_offset: chunk.length };
  const producer = context.producers[0];
  const pollContext = { offered: transit.VERSION, confirmed: transit.VERSION, poll_request_id: rid,
    response_request_id: rid, response_status: 200, instance_id: producer.instance_id,
    producer_generation: producer.generation, connection_id: producer.connection_id };
  return [
    { name: 'authority.request', op: 1, facts: { request_id_header: request.request_id }, body: request },
    { name: 'authority.response', op: 2, facts: { request, expected, time: { now_ms: now, dispatch_age_ms: 1000 } }, body: snapshot },
    { name: 'transit.request', op: 3, facts: { path: `/pilot/v2/transfers/sources/${s.source.source_instance_id}/${s.source.source_conversation_id}/targets/${s.binding.target_instance_id}/reservations/${s.binding.transfer_id}/decisions`, request_id: rid, proof: null }, body: sent },
    { name: 'transit.metadata_reply', op: 4, facts: { kind: 'decision', sent, expectation: s.expectation('reserve') }, body: { transit_contract: transit.VERSION, type: 'decision.reply', request_id: rid, result: { kind: retry.kind, receipt: retry.receipt, status: retry.status } } },
    { name: 'transit.poll', op: 5, facts: { context: pollContext }, body: { transit_contract: transit.VERSION, type: 'producer.delivery', request_id: rid, delivery_id: s.uuid(), instance_id: producer.instance_id, producer_generation: producer.generation, connection_id: producer.connection_id, body: { kind: 'transit.chunk', message: chunk } } },
    { name: 'transit.chunk', op: 6, facts: { session, cursor: vectors.context.empty }, body: chunk },
    { name: 'transit.ack', op: 7, facts: { session, chunk, request_id: rid }, body: ack },
    { name: 'transit.progress', op: 8, facts: { session, request_id: rid }, body: { transit_contract: transit.VERSION, type: 'transit.progress', request_id: rid, transfer_id: session.transfer_id, transit_id: session.transit_id, cursor: plan.cursor } },
    { name: 'transit.session', op: 9, facts: { session, request_id: rid }, body: { transit_contract: transit.VERSION, type: 'transit.opened', request_id: rid, session, cursor: plan.cursor } },
  ];
}
export function metadataVectors(): CodecVector[] {
  const s = scenario(true), contract = transit.VERSION, proof = s.seal.context.proofs[0], producer = s.context.producers[0];
  const received = { transit_contract: contract, type: 'proof.received', request_id: proof.exchange.delivery_id, exchange: proof.exchange };
  const attestation = { transit_contract: contract, type: 'proof.result', request_id: proof.exchange.delivery_id, attestation: proof.attestation };
  const receivedFacts = { kind: 'received', exchange: proof.exchange };
  const attestationFacts = { kind: 'attestation', exchange: proof.exchange, producer, connection: proof.authenticated_connection_id };
  const challenge = { transit_contract: contract, type: 'decision.challenge', request_id: s.uuid(), request: s.seal.request, kind: 'source_sealed' };
  const { delivery_id: _delivery, challenge_id: _challenge, ...independentExchange } = proof.exchange;
  const result: CodecVector[] = [
    { name: 'request.received', op: 3, facts: { path: `/pilot/v2/transfers/instances/${producer.instance_id}/received`, request_id: received.request_id, proof: receivedFacts }, body: received },
    { name: 'request.attestation', op: 3, facts: { path: `/pilot/v2/transfers/instances/${producer.instance_id}/attestations`, request_id: attestation.request_id, proof: attestationFacts }, body: attestation },
    { name: 'reply.challenge', op: 4, facts: { kind: 'challenge', sent: challenge, exchange: independentExchange }, body: { transit_contract: contract, type: 'decision.exchange', request_id: challenge.request_id, exchange: proof.exchange } },
    { name: 'reply.received', op: 4, facts: { ...receivedFacts, sent: received }, body: { transit_contract: contract, type: 'accepted', request_id: received.request_id } },
    { name: 'reply.attestation', op: 4, facts: { ...attestationFacts, sent: attestation }, body: { transit_contract: contract, type: 'accepted', request_id: attestation.request_id } },
  ];
  for (const step of [s.birth, s.reserve, s.seal, s.ready, s.commit, s.activate]) {
    const request = step.request, sent = { transit_contract: contract, type: 'decision.request', request_id: s.uuid(), request };
    const retry = s.call(request, step.result.ledger, step.result.record, step.context.proofs).result;
    result.push({ name: `reply.${request.operation}`, op: 4,
      facts: { kind: 'decision', sent, expectation: request.operation === 'lineage.create' ? null : s.expectation(request.operation) },
      body: { transit_contract: contract, type: 'decision.reply', request_id: sent.request_id, result: { kind: retry.kind, receipt: retry.receipt, status: retry.status } } });
  }
  const sourceRequest = s.request('reconcile', '0', { action: 'source_status', provenance: s.provenance }, false);
  const source = s.call(sourceRequest, s.commit.result.ledger, null, []).result;
  result.push({ name: 'reply.source-status', op: 4,
    facts: { kind: 'decision', sent: { transit_contract: contract, type: 'decision.request', request_id: 'source-status', request: sourceRequest }, expectation: null },
    body: { transit_contract: contract, type: 'decision.reply', request_id: 'source-status', result: { kind: source.kind, status: source.status } } });
  const statusRequest = s.request('reconcile', s.commit.result.record.revision, { action: 'status', binding: s.binding, frozen: s.frozen, expected_ledger_revision: s.commit.result.ledger.revision });
  const status = s.call(statusRequest, s.commit.result.ledger, s.commit.result.record, []).result;
  result.push({ name: 'reply.status', op: 4,
    facts: { kind: 'decision', sent: { transit_contract: contract, type: 'decision.request', request_id: 'status', request: statusRequest }, expectation: s.expectation('commit') },
    body: { transit_contract: contract, type: 'decision.reply', request_id: 'status', result: { kind: status.kind, status: status.status } } });
  return result;
}
