import assert from 'node:assert/strict';
import { decodeDecision, fingerprint, increment, planDecision, planMaintenance, validateExchange, validateObject, validateProducerAttestation } from '../v2/transfer-decision-validate.mjs';
import { scenario } from './transfer-decision-vectors.mjs';

export function verifyInvariantBoundaries() {
  const s = scenario(), clone = structuredClone, rows = [];
  const env = (type, fields) => ({ decision_contract: 'transfer-decision-1', type, ...fields });
  const check = (boundary, good, changed, changedExpected = false) => {
    assert.equal(good().valid, true, boundary + ' control');
    assert.equal(changed().valid, changedExpected, boundary + ' changed');
    rows.push({ boundary, changedExpected });
  };
  const forms = (name, definition, good, changed, changedExpected = false) => {
    check(name, () => validateObject(good, definition), () => validateObject(changed, definition), changedExpected);
    check(name + ' JSON', () => decodeDecision(JSON.stringify(good), definition), () => decodeDecision(JSON.stringify(changed), definition), changedExpected);
  };
  const read = s.request('reconcile', '0', { binding: s.binding, frozen: s.frozen, expected_ledger_revision: '1', action: 'status' });
  const sourceRead = s.request('reconcile', '0', { action: 'source_status', provenance: s.provenance }, false);
  const badTerminal = clone(s.knownTerminal); badTerminal.prepared.lineage_id = s.provenance.lineage_id;
  const goodStatus = env('reconciliation_status', { status: 'terminal', transfer_id: s.binding.transfer_id, source: clone(s.source), epoch: s.binding.epoch,
    revision: '4', phase: 'committed', terminal: clone(s.knownTerminal), activation: null, recovery_generation: s.context.recovery_generation, source_recovery: 'intact' });
  const badStatus = { ...clone(goodStatus), terminal: badTerminal };
  const goodLedger = clone(s.commit.result.ledger), badLedger = { ...clone(goodLedger), terminal: badTerminal };
  const sourceStatus = ledger => env('source_reconciliation_status', { status: 'known', provenance: clone(s.provenance), ledger, recovery_generation: s.context.recovery_generation });
  const badRecord = clone(s.commit.result.record);
  badRecord.prepared = clone(badTerminal.prepared); badRecord.terminal = clone(badTerminal);
  badRecord.ready_receipt.subject_digest = fingerprint('prepared', badRecord.prepared);
  const expected = { ...s.expectation('commit'), terminal: clone(s.knownTerminal) };
  const badExpected = { ...clone(expected), prepared: clone(badTerminal.prepared), terminal: clone(badTerminal) };
  // Isolated terminal/status/preparation do not contain source lineage. They
  // cannot infer it from a hash. A ledger and all its consumers do contain it.
  forms('prepared without provenance', 'prepared', s.prepared, badTerminal.prepared, true);
  forms('terminal without provenance', 'terminal', s.knownTerminal, badTerminal, true);
  forms('transfer status without provenance', 'status', goodStatus, badStatus, true);
  forms('record with provenance', 'record', s.commit.result.record, badRecord);
  forms('expectation with provenance', 'expectation', expected, badExpected);
  forms('retained ledger with provenance', 'ledger', goodLedger, badLedger);
  forms('source status with provenance', 'sourceStatus', sourceStatus(goodLedger), sourceStatus(badLedger));
  check('transfer reception with provenance',
    () => validateExchange(read, { valid: true, kind: 'status', errors: [], status: goodStatus }),
    () => validateExchange(read, { valid: true, kind: 'status', errors: [], status: badStatus }));
  for (const history of ['intact', 'restored']) {
    const context = { ...clone(s.context), history, recovery_generation: history === 'restored' ? s.uuid() : s.context.recovery_generation };
    const good = planDecision(sourceRead, goodLedger, null, context);
    assert.equal(good.kind, 'source_status'); assert.deepEqual(good.status.ledger.terminal, s.knownTerminal);
    const bad = { ...clone(good), status: { ...clone(good.status), ledger: badLedger } };
    check('source reception ' + history, () => validateExchange(sourceRead, good), () => validateExchange(sourceRead, bad));
    check('source plan ' + history, () => planDecision(sourceRead, goodLedger, null, context), () => planDecision(sourceRead, badLedger, null, context));
  }
  const highLedger = { ...clone(goodLedger), high_epoch: increment(goodLedger.high_epoch) };
  check('conservative high epoch', () => validateObject(goodLedger, 'ledger'), () => validateObject(highLedger, 'ledger'), true);
  check('conservative high epoch pair', () => planMaintenance(goodLedger, s.commit.result.record, s.context, 'account_revoked'),
    () => planMaintenance(highLedger, s.commit.result.record, s.context, 'account_revoked'), true);
  const lineageRows = rows.length;

  let birthFlows = 0;
  for (const [mode, history] of [['created', 'intact'], ['initial_existing', 'intact'], ['created', 'restored']]) {
    const context = { ...clone(s.context), history, recovery_generation: history === 'restored' ? s.uuid() : s.context.recovery_generation, receipt_id: s.uuid() };
    const goodProv = { ...clone(s.provenance), birth_generation: context.recovery_generation };
    const badProv = { ...clone(goodProv), installation_id: goodProv.lineage_id };
    const q = s.request('lineage.create', '0', { provenance: goodProv, mode, creation_digest: s.hash('d') }, false);
    const badQ = { ...clone(q), body: { ...clone(q.body), provenance: badProv } };
    const kind = mode === 'created' ? 'lineage_created' : 'lineage_enrolled';
    const goodContext = { ...clone(context), proofs: [s.attest(q, kind, fingerprint('birth', q.body), null, false, context)] };
    const badContext = { ...clone(context), proofs: [s.attest(badQ, kind, fingerprint('birth', badQ.body), null, false, context)] };
    const birth = planDecision(q, null, null, goodContext);
    assert.equal(birth.kind, 'mutation'); assert.equal(validateExchange(q, birth).valid, true);
    const badReceipt = { ...clone(birth.receipt), request_digest: fingerprint('retry-body', badQ), provenance_digest: fingerprint('provenance', badProv), attestation_digest: fingerprint('attestation', badContext.proofs[0].attestation) };
    const badBirthLedger = { ...clone(birth.ledger), provenance: badProv, birth: badReceipt };
    const badMutation = { ...clone(birth), ledger: badBirthLedger, receipt: badReceipt };
    const sourceQ = s.request('reconcile', '0', { action: 'source_status', provenance: goodProv }, false);
    const badSourceQ = { ...clone(sourceQ), body: { ...clone(sourceQ.body), provenance: badProv } };
    const source = planDecision(sourceQ, birth.ledger, null, goodContext);
    assert.equal(source.kind, 'source_status');
    const badSource = { ...clone(source), status: { ...clone(source.status), provenance: badProv, ledger: badBirthLedger } };
    const empty = env('source_reconciliation_status', { status: history === 'restored' ? 'recovery_hold' : 'not_found', provenance: goodProv, ledger: null, recovery_generation: context.recovery_generation });
    const base = mode + '/' + history + '/';
    for (const [definition, good, changed] of [
      ['provenance', goodProv, badProv], ['birthBody', q.body, badQ.body], ['request', q, badQ],
      ['ledger', birth.ledger, badBirthLedger], ['sourceStatus', source.status, badSource.status],
      ['sourceStatus', empty, { ...clone(empty), provenance: badProv }],
    ]) forms(base + definition + (good.ledger === null ? ' empty' : ''), definition, good, changed);
    forms(base + 'birth receipt lacks provenance', 'birthReceipt', birth.receipt, badReceipt, true);
    check(base + 'birth mutation reception', () => validateExchange(q, birth), () => validateExchange(badQ, badMutation));
    const retry = planDecision(q, birth.ledger, null, goodContext);
    const badRetry = { valid: true, kind: 'retry', errors: [], receipt: badReceipt, status: null };
    check(base + 'birth retry reception', () => validateExchange(q, retry), () => validateExchange(badQ, badRetry));
    check(base + 'birth plan', () => planDecision(q, null, null, goodContext), () => planDecision(badQ, null, null, badContext));
    check(base + 'birth retry plan', () => planDecision(q, birth.ledger, null, goodContext), () => planDecision(badQ, badBirthLedger, null, badContext));
    check(base + 'source reception', () => validateExchange(sourceQ, source), () => validateExchange(badSourceQ, badSource));
    check(base + 'source plan', () => planDecision(sourceQ, birth.ledger, null, goodContext), () => planDecision(badSourceQ, badBirthLedger, null, badContext));
    const binding = { ...clone(s.binding), provenance: goodProv, relay_recovery_generation: context.recovery_generation };
    const badBinding = { ...clone(binding), provenance: badProv };
    const frozen = { ...clone(s.frozen), binding_digest: fingerprint('transfer-binding', binding) };
    const badFrozen = { ...clone(frozen), binding_digest: fingerprint('transfer-binding', badBinding) };
    const reserve = s.request('reserve', '0', { binding, frozen, expected_ledger_revision: '1' });
    const badReserve = { ...clone(reserve), body: { ...clone(reserve.body), binding: badBinding, frozen: badFrozen } };
    const reserveContext = req => {
      const p = s.attest(req, 'source_frozen', fingerprint('frozen', req.body.frozen), null, false, context);
      p.attestation.binding_digest = p.exchange.binding_digest = fingerprint('transfer-binding', req.body.binding);
      return { ...clone(context), receipt_id: s.uuid(), proofs: [p] };
    };
    const reserved = planDecision(reserve, birth.ledger, null, reserveContext(reserve));
    assert.equal(reserved.kind, 'mutation'); assert.equal(validateExchange(reserve, reserved).valid, true);
    forms(base + 'binding', 'binding', binding, badBinding);
    forms(base + 'reserve request', 'request', reserve, badReserve);
    const badReservedRecord = { ...clone(reserved.record), binding: badBinding, frozen: badFrozen };
    badReservedRecord.reserve_receipt.binding_digest = fingerprint('transfer-binding', badBinding);
    badReservedRecord.reserve_receipt.subject_digest = fingerprint('frozen', badFrozen);
    const { operation_id: _id, ...semantic } = badReserve;
    badReservedRecord.retries[0].request_digest = fingerprint('retry-body', badReserve);
    badReservedRecord.retries[0].body_digest = fingerprint('step-body', semantic);
    forms(base + 'record', 'record', reserved.record, badReservedRecord);
    forms(base + 'expectation', 'expectation', { binding, frozen, manifest: null, prepared: null, terminal: null }, { binding: badBinding, frozen: badFrozen, manifest: null, prepared: null, terminal: null });
    check(base + 'reserve plan', () => planDecision(reserve, birth.ledger, null, reserveContext(reserve)),
      () => planDecision(badReserve, badBirthLedger, null, reserveContext(badReserve)));
    check(base + 'reserve reception', () => validateExchange(reserve, reserved),
      () => validateExchange(badReserve, { ...clone(reserved), ledger: badBirthLedger, record: badReservedRecord, receipt: badReservedRecord.reserve_receipt }));
    birthFlows++;
  }
  assert.equal(birthFlows, 3);
  const restored = { ...clone(s.birth.context), history: 'restored', recovery_generation: s.provenance.birth_generation };
  const enrollment = { ...clone(s.birth.request), body: { ...clone(s.birth.request.body), mode: 'initial_existing' } };
  restored.proofs = [s.attest(enrollment, 'lineage_enrolled', fingerprint('birth', enrollment.body), null, false, restored)];
  assert.equal(planDecision(enrollment, null, null, restored).code, 'recovery_hold');
  const provenanceRows = rows.length - lineageRows;

  forms('isolated decimal bound', 'decimal', '9223372036854775807', '9223372036854775808');
  forms('isolated positive bound', 'positive', '1', '9223372036854775808');
  forms('isolated canonical origin', 'origin', s.source.relay_origin, s.source.relay_origin + '/');
  const duplicateProducer = clone(s.context); duplicateProducer.producers[1].instance_id = duplicateProducer.producers[0].instance_id;
  const duplicateAccess = clone(s.context); duplicateAccess.accesses[1].instance_id = duplicateAccess.accesses[0].instance_id; duplicateAccess.accesses[1].revision = increment(duplicateAccess.accesses[1].revision);
  forms('context producer uniqueness', 'context', s.context, duplicateProducer);
  forms('context access uniqueness', 'context', s.context, duplicateAccess);
  const loopback = { ...clone(s.context), authority_origin: 'http://127.0.0.1:8024', loopback_test_origin: 'http://127.0.0.1:8024' };
  forms('context explicit loopback', 'context', loopback, { ...clone(loopback), loopback_test_origin: null });
  const proof = s.reserve.context.proofs[0], producer = s.reserve.context.producers[0];
  for (const field of ['kind', 'binding_digest', 'subject_digest', 'delivery_id', 'challenge_id', 'request_digest', 'prior_receipt_digest']) {
    const changed = clone(proof); changed.exchange[field] = field === 'kind' ? 'lineage_created' : field.endsWith('_id') ? s.uuid() : s.hash('0');
    forms('proof ' + field, 'proof', proof, changed);
    forms('context proof ' + field, 'context', s.reserve.context, { ...clone(s.reserve.context), proofs: [changed] });
    check('authenticated proof ' + field, () => validateProducerAttestation(proof.attestation, proof.exchange, producer, proof.authenticated_connection_id),
      () => validateProducerAttestation(changed.attestation, changed.exchange, producer, changed.authenticated_connection_id));
  }
  for (const field of ['producer_instance_id', 'producer_generation', 'authenticated_connection_id']) {
    const changed = clone(proof);
    if (field === 'authenticated_connection_id') changed[field] = s.uuid(); else changed.attestation[field] = 'different-synthetic';
    forms('proof route ' + field, 'proof', proof, changed);
    forms('context proof route ' + field, 'context', s.reserve.context, { ...clone(s.reserve.context), proofs: [changed] });
  }
  // The selected producer is external to an isolated proof; that comparison
  // belongs to validateProducerAttestation, not a claim of self-authentication.
  check('selected producer differs', () => validateProducerAttestation(proof.attestation, proof.exchange, producer, proof.authenticated_connection_id),
    () => validateProducerAttestation(proof.attestation, proof.exchange, { ...producer, generation: 'different-synthetic' }, proof.authenticated_connection_id));
  const otherTerminalLedger = clone(goodLedger); otherTerminalLedger.terminal.transfer_id = s.uuid();
  forms('ledger cannot infer another binding', 'ledger', goodLedger, otherTerminalLedger, true);
  check('record/ledger plan pair', () => planDecision(s.commit.request, goodLedger, s.commit.result.record, s.context),
    () => planDecision(s.commit.request, otherTerminalLedger, s.commit.result.record, s.context));
  check('record/ledger maintenance pair', () => planMaintenance(goodLedger, s.commit.result.record, s.context, 'account_revoked'),
    () => planMaintenance(otherTerminalLedger, s.commit.result.record, s.context, 'account_revoked'));
  check('record/ledger mutation reception', () => validateExchange(s.commit.request, s.commit.result, s.expectation('commit')),
    () => validateExchange(s.commit.request, { ...clone(s.commit.result), ledger: otherTerminalLedger }, s.expectation('commit')));
  const activeHigh = { ...clone(s.ready.result.ledger), high_epoch: increment(s.binding.epoch) };
  forms('active ledger lacks binding epoch', 'ledger', s.ready.result.ledger, activeHigh, true);
  check('active record/ledger maintenance pair', () => planMaintenance(s.ready.result.ledger, s.ready.result.record, s.context, 'operator_cancelled'),
    () => planMaintenance(activeHigh, s.ready.result.record, s.context, 'operator_cancelled'));
  return { lineageRows, provenanceRows, otherOwnerRows: rows.length - lineageRows - provenanceRows, birthFlows, pairedBoundaries: rows.length };
}
