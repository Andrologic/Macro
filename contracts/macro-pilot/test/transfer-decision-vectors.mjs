// Synthetic trusted-channel facts for conformance, never native proof or auth.
import assert from 'node:assert/strict';
import { fingerprint, planDecision } from '../v2/transfer-decision-validate.mjs';

export function scenario(maximal = false) {
  const clone = structuredClone;
  let sequence = 1;
  const uuid = () => `00000000-0000-0000-0000-${String(sequence++).padStart(12, '0')}`;
  const opaque = prefix => maximal ? prefix.padEnd(128, 'x') : `${prefix}-synthetic`;
  const hash = character => character.repeat(64);
  const counter = maximal ? '9223372036854775790' : '9007199254740993';
  const origin = maximal ? `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(55)}` : 'https://relay.example.test';
  const generation = uuid();
  const source = { relay_origin: origin, account_id: opaque('account'), source_instance_id: opaque('source'), source_conversation_id: opaque('chat') };
  const provenance = { source, lineage_id: uuid(), installation_id: uuid(), birth_generation: generation };
  const actor = { account_id: source.account_id, session_id: opaque('initiator-session'), device_id: opaque('initiator-device'), session_revision: counter, account_epoch: counter, source_access_revision: counter, target_access_revision: counter };
  const binding = { transfer_id: uuid(), provenance, epoch: counter, target_instance_id: opaque('target'), relay_recovery_generation: generation, initiator: actor, source_producer_generation: opaque('producer-source'), target_producer_generation: opaque('producer-target') };
  const context = {
    authority_origin: origin, recovery_generation: generation, history: 'intact', actor: { identity: actor, state: 'active' },
    accesses: [source.source_instance_id, binding.target_instance_id].map(instance_id => ({ account_id: actor.account_id, session_id: actor.session_id, instance_id, revision: counter, permissions: ['supervise', 'respond'] })),
    producers: [source.source_instance_id, binding.target_instance_id].map((instance_id, i) => ({ account_id: source.account_id, instance_id, generation: i ? binding.target_producer_generation : binding.source_producer_generation, connection_id: uuid(), state: 'active' })),
    proofs: [], supported_context_contracts: maximal ? '0123456789abcdef'.split('').map(hash) : [hash('e')], recovery_access: null,
    capacity: { used_bytes: '0', reserved_bytes: '0', limit_bytes: '33554432' }, receipt_id: uuid(), loopback_test_origin: null,
  };
  const frozen = { format_version: '1', binding_digest: fingerprint('transfer-binding', binding), ownership_revision: counter, content_incarnation: uuid(), content_revision: counter, sha256: hash('f') };
  const manifest = { format_version: '1', binding_digest: frozen.binding_digest, frozen_digest: fingerprint('frozen', frozen), content_contract_sha256: hash('e'), manifest_sha256: hash('a'), source_revision: counter };
  const prepared = { format_version: '1', binding_digest: frozen.binding_digest, manifest_digest: fingerprint('manifest', manifest), import_id: uuid(), target_conversation_id: opaque('new-chat'), lineage_id: uuid(), mapping_sha256: hash('b'), preparation_sha256: hash('c') };
  const request = (operation, revision, body, transfer = true) => ({ decision_contract: 'transfer-decision-1', type: 'decision_request', operation, operation_id: uuid(), expected_revision: revision, body, ...(transfer ? { transfer_id: binding.transfer_id } : {}) });
  const attest = (req, kind, subject, prior = null, target = false, override = context) => {
    const p = override.producers[target ? 1 : 0];
    const b = req.operation === 'lineage.create' ? fingerprint('provenance', req.body.provenance) : frozen.binding_digest;
    const exchange = { kind, binding_digest: b, subject_digest: subject, instance_id: p.instance_id, producer_generation: p.generation, connection_id: p.connection_id, delivery_id: uuid(), challenge_id: uuid(), request_digest: fingerprint('retry-body', req), prior_receipt_digest: prior };
    const attestation = { decision_contract: 'transfer-decision-1', type: 'producer_attestation', kind, format_version: '1', binding_digest: b, subject_digest: subject, producer_instance_id: p.instance_id, producer_generation: p.generation, delivery_id: exchange.delivery_id, challenge_id: exchange.challenge_id, request_digest: exchange.request_digest, prior_receipt_digest: prior };
    return { attestation, exchange, authenticated_connection_id: p.connection_id };
  };
  const call = (req, ledger, record, proofs, override = context) => {
    const current = { ...override, receipt_id: uuid(), proofs };
    const result = planDecision(req, ledger, record, current);
    assert.equal(result.valid, true, `${req.operation}: ${JSON.stringify(result)}`);
    return { request: req, context: current, result };
  };
  const birthBody = { provenance, mode: 'created', creation_digest: hash('d') };
  const birthRequest = request('lineage.create', '0', birthBody, false);
  const birth = call(birthRequest, null, null, [attest(birthRequest, 'lineage_created', fingerprint('birth', birthBody))]);
  const reserveRequest = request('reserve', '0', { binding, frozen, expected_ledger_revision: birth.result.ledger.revision });
  const reserve = call(reserveRequest, birth.result.ledger, null, [attest(reserveRequest, 'source_frozen', fingerprint('frozen', frozen))]);
  const sealRequest = request('seal', reserve.result.record.revision, { manifest });
  const seal = call(sealRequest, reserve.result.ledger, reserve.result.record, [attest(sealRequest, 'source_sealed', fingerprint('manifest', manifest), fingerprint('frozen', frozen))]);
  const readyRequest = request('ready', seal.result.record.revision, { prepared });
  const ready = call(readyRequest, seal.result.ledger, seal.result.record, [attest(readyRequest, 'target_pinned', fingerprint('prepared', prepared), fingerprint('manifest', manifest), true)]);
  const commitRequest = request('commit', ready.result.record.revision, {});
  const commit = call(commitRequest, ready.result.ledger, ready.result.record, [attest(commitRequest, 'source_maintained', fingerprint('frozen', frozen), fingerprint('manifest', manifest)), attest(commitRequest, 'target_maintained', fingerprint('prepared', prepared), fingerprint('prepared', prepared), true)]);
  // Independent journal oracle: native facts and the allocated decision receipt
  // ID, without reading any field of the response under validation.
  const knownTerminal = { decision_contract: 'transfer-decision-1', type: 'terminal_receipt', receipt_id: commit.context.receipt_id, transfer_id: binding.transfer_id, source: clone(source), epoch: binding.epoch, target_instance_id: binding.target_instance_id, binding_digest: fingerprint('transfer-binding', binding), frozen_digest: fingerprint('frozen', frozen), decision_revision: '4', outcome: 'committed', reason: null, manifest_digest: fingerprint('manifest', manifest), prepared: clone(prepared) };
  assert.deepEqual(commit.result.receipt, knownTerminal);
  const activation = { decision_contract: 'transfer-decision-1', type: 'activation_receipt', receipt_id: uuid(), transfer_id: binding.transfer_id, terminal_digest: fingerprint('terminal', knownTerminal), target_instance_id: binding.target_instance_id, target_conversation_id: prepared.target_conversation_id, prepared_digest: fingerprint('prepared', prepared), revision: '1' };
  const activationRequest = request('activation.record', commit.result.record.revision, { activation });
  const activationContext = { ...context, receipt_id: activation.receipt_id, proofs: [attest(activationRequest, 'target_activated', fingerprint('activation', activation), fingerprint('terminal', commit.result.receipt), true)] };
  const activationResult = planDecision(activationRequest, commit.result.ledger, commit.result.record, activationContext);
  assert.equal(activationResult.valid, true, JSON.stringify(activationResult));
  const activate = { request: activationRequest, context: activationContext, result: activationResult };
  // Stand-in for independently retained local native journal facts, not fields
  // extracted from the response passed to validateExchange.
  const expectation = operation => ({ binding: clone(binding), frozen: clone(frozen), manifest: ['seal', 'ready', 'commit', 'abort', 'activation.record'].includes(operation) ? clone(manifest) : null, prepared: ['ready', 'commit', 'abort', 'activation.record'].includes(operation) ? clone(prepared) : null, terminal: operation === 'activation.record' ? clone(knownTerminal) : null });
  return { uuid, opaque, hash, source, provenance, binding, context, frozen, manifest, prepared, knownTerminal, request, attest, call, expectation, birth, reserve, seal, ready, commit, activate };
}
