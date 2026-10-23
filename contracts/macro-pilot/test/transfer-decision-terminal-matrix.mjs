import assert from 'node:assert/strict';
import { fingerprint, planDecision, planMaintenance, validateExchange, validateObject } from '../v2/transfer-decision-validate.mjs';
import { scenario } from './transfer-decision-vectors.mjs';

// These reachability and CAS expectations are fixed from the native graph,
// independently of the replies under validation.
export function verifyTerminalMatrix() {
  const s = scenario(), clone = structuredClone;
  const env = (type, fields) => ({ decision_contract: 'transfer-decision-1', type, ...fields });
  const terminal = (outcome, reason, revision, id) => env('terminal_receipt', {
    receipt_id: id, transfer_id: s.binding.transfer_id, source: clone(s.source), epoch: s.binding.epoch,
    target_instance_id: s.binding.target_instance_id, binding_digest: fingerprint('transfer-binding', s.binding),
    frozen_digest: fingerprint('frozen', s.frozen), decision_revision: revision, outcome, reason,
    manifest_digest: outcome === 'committed' ? fingerprint('manifest', s.manifest) : null,
    prepared: outcome === 'committed' ? clone(s.prepared) : null,
  });
  const current = (receipt, activation = null) => env('reconciliation_status', {
    status: 'terminal', transfer_id: s.binding.transfer_id, source: clone(s.source), epoch: s.binding.epoch,
    revision: activation ? String(BigInt(receipt.decision_revision) + 1n) : receipt.decision_revision,
    phase: receipt.outcome, terminal: clone(receipt), activation: clone(activation),
    recovery_generation: s.context.recovery_generation, source_recovery: 'intact',
  });
  const reconcile = action => s.request('reconcile', '0', { binding: s.binding, frozen: s.frozen, expected_ledger_revision: '1', action });
  const read = reconcile('status'), base = s.expectation('reserve');
  const reasons = ['user_cancelled', 'session_invalidated', 'access_changed', 'producer_changed', 'account_revoked', 'operator_cancelled'];
  const profiles = [['committed', null], ['aborted', 'missing_reservation'], ...reasons.map(reason => ['aborted', reason])];
  let terminalCases = 0, validTerminals = 0, realAbortPaths = 0, additionalAbortCAS = 0;
  for (const [outcome, reason] of profiles) {
    for (const revision of ['0', '1', '2', '3', '4', '5', '6', '9223372036854775807']) {
      const expected = outcome === 'committed' ? revision === '4'
        : reason === 'missing_reservation' ? revision === '1' : ['2', '3', '4'].includes(revision);
      const value = terminal(outcome, reason, revision, s.uuid()), status = current(value);
      const label = JSON.stringify({ outcome, reason, revision });
      assert.equal(validateObject(value, 'terminal').valid, expected, label);
      assert.equal(validateObject(status, 'status').valid, expected, label);
      assert.equal(validateExchange(read, { valid: true, kind: 'status', errors: [], status }, base).valid, expected, label);
      terminalCases++; if (expected) validTerminals++;
    }
  }
  assert.equal(terminalCases, 64); assert.equal(validTerminals, 20);
  const restored = { ...clone(s.context), history: 'restored', recovery_generation: s.uuid() };
  for (const [stage, revision, decision] of [['reserve', '1', '2'], ['seal', '2', '3'], ['ready', '3', '4']]) {
    const input = s[stage].result;
    for (const reason of reasons) {
      const q = s.request('abort', revision, { reason: 'user_cancelled' });
      const context = { ...clone(s.context), receipt_id: s.uuid() };
      const expected = terminal('aborted', reason, decision, context.receipt_id);
      const result = reason === 'user_cancelled' ? planDecision(q, input.ledger, input.record, context)
        : planMaintenance(input.ledger, input.record, context, reason);
      assert.equal(result.kind, 'mutation'); assert.deepEqual(result.receipt, expected);
      assert.equal(validateObject(result.record, 'record').valid, true);
      if (reason === 'user_cancelled') {
        assert.equal(validateExchange(q, result, base).valid, true);
        if (stage !== 'reserve') for (const cas of ['0', '1', '2', '3', '4', '5', '9223372036854775806']) {
          const replayQ = { ...clone(q), expected_revision: cas };
          const response = { valid: true, kind: 'retry', errors: [], receipt: expected, status: current(expected) };
          assert.equal(validateExchange(replayQ, response, base).valid, cas === revision);
          const actual = planDecision(replayQ, result.ledger, result.record, context);
          assert.equal(cas === revision ? actual.kind : actual.code, cas === revision ? 'retry' : 'conflict');
          additionalAbortCAS++;
        }
      }
      realAbortPaths++;
    }
    const hold = planMaintenance(input.ledger, input.record, restored, 'restore_uncertain');
    assert.equal(hold.record.phase, 'recovery_hold');
    for (const snapshot of [input, hold]) {
      const actual = planDecision(s[stage].request, snapshot.ledger, snapshot.record, restored);
      assert.equal(actual.kind, 'retry');
      assert.equal(validateExchange(s[stage].request, actual, s.expectation(s[stage].request.operation)).valid, true);
    }
    for (const reason of reasons.slice(1)) {
      const again = planMaintenance(hold.ledger, hold.record, s.context, reason);
      assert.equal(again.receipt, null); assert.deepEqual(again.record, hold.record); assert.deepEqual(again.ledger, hold.ledger);
    }
    for (const q of [s.request('abort', hold.record.revision, { reason: 'user_cancelled' }), s.request('commit', hold.record.revision, {})]) {
      assert.equal(planDecision(q, hold.ledger, hold.record, s.context).code, 'recovery_hold');
    }
  }
  assert.equal(realAbortPaths, 18); assert.equal(additionalAbortCAS, 14);

  const abortQ = s.request('abort', '1', { reason: 'user_cancelled' });
  const abortContext = { ...clone(s.context), receipt_id: s.uuid() };
  const abortFact = terminal('aborted', 'user_cancelled', '2', abortContext.receipt_id);
  const aborted = planDecision(abortQ, s.reserve.result.ledger, s.reserve.result.record, abortContext);
  assert.deepEqual(aborted.receipt, abortFact);
  const missing = reconcile('abort_missing');
  const missingContext = { ...clone(s.context), receipt_id: s.uuid(), proofs: [s.attest(missing, 'source_frozen', fingerprint('frozen', s.frozen))] };
  const tombFact = terminal('aborted', 'missing_reservation', '1', missingContext.receipt_id);
  const tomb = planDecision(missing, s.birth.result.ledger, null, missingContext);
  assert.deepEqual(tomb.receipt, tombFact);
  const commitFact = terminal('committed', null, '4', s.commit.context.receipt_id);
  assert.deepEqual(s.commit.result.receipt, commitFact);
  const activationFact = clone(s.activate.request.body.activation);
  const rows = [
    { operation: 'abort', q: abortQ, cas: '1', fact: abortFact, mutation: aborted, context: abortContext, expected: base },
    { operation: 'commit', q: s.commit.request, cas: '3', fact: commitFact, mutation: s.commit.result, context: s.commit.context, expected: s.expectation('commit') },
    { operation: 'abort_missing', q: missing, cas: '0', fact: tombFact, mutation: tomb, context: missingContext, expected: base },
    { operation: 'activation.record', q: s.activate.request, cas: '4', fact: activationFact, mutation: s.activate.result, context: s.activate.context, expected: { ...s.expectation('commit'), terminal: commitFact } },
  ];
  let casCases = 0, validCAS = 0, terminalWinners = 0;
  for (const row of rows) {
    for (const cas of ['0', '1', '2', '3', '4', '5', '9223372036854775806']) {
      const q = { ...clone(row.q), expected_revision: cas }, expected = cas === row.cas;
      const status = row.operation === 'activation.record' ? current(commitFact, activationFact) : current(row.fact);
      const retry = { valid: true, kind: 'retry', errors: [], receipt: clone(row.fact), status };
      assert.equal(validateExchange(q, retry, row.expected).valid, expected, row.operation + '/' + cas);
      assert.equal(validateExchange(q, row.mutation, row.expected).valid, expected, 'mutation ' + row.operation + '/' + cas);
      const actual = planDecision(q, row.mutation.ledger, row.mutation.record, row.context);
      if (expected) {
        assert.equal(actual.kind, 'retry'); assert.equal(validateExchange(q, actual, row.expected).valid, true);
      } else assert.equal(actual.code, 'conflict');
      casCases++; if (expected) validCAS++;
      // A terminal winner reveals another operation's decision, independent of
      // the losing CAS. Do not apply the retry relation to this result kind.
      if (row.operation !== 'activation.record') {
        const winnerQ = row.operation === 'abort' ? s.request('commit', cas, {})
          : row.operation === 'commit' ? s.request('abort', cas, { reason: 'user_cancelled' }) : { ...clone(missing), expected_revision: cas };
        const won = row.operation === 'abort' ? aborted : s.commit.result;
        const winner = planDecision(winnerQ, won.ledger, won.record, s.context);
        const expectation = row.operation === 'abort' ? s.expectation('commit') : base;
        assert.equal(winner.kind, 'terminal'); assert.equal(validateExchange(winnerQ, winner, expectation).valid, true);
        terminalWinners++;
      }
    }
  }
  assert.equal(casCases, 28); assert.equal(validCAS, 4); assert.equal(terminalWinners, 21);
  let stepTerminalCases = 0, validStepTerminals = 0, heldStepCases = 0, stepCASCases = 0;
  for (const [stage, operation, previous, revision, phase] of [['reserve', 'reserve', '0', '1', 'reserved'], ['seal', 'seal', '1', '2', 'sealed'], ['ready', 'ready', '2', '3', 'target_ready']]) {
    const fact = env('step_receipt', { receipt_id: s[stage].context.receipt_id, operation, transfer_id: s.binding.transfer_id,
      binding_digest: fingerprint('transfer-binding', s.binding), subject_digest: fingerprint(stage === 'reserve' ? 'frozen' : stage === 'seal' ? 'manifest' : 'prepared', stage === 'reserve' ? s.frozen : stage === 'seal' ? s.manifest : s.prepared),
      previous_revision: previous, revision, phase });
    assert.deepEqual(s[stage].result.receipt, fact);
    for (const cas of ['0', '1', '2', '3', '4', '5', '9223372036854775806']) {
      const q = { ...clone(s[stage].request), expected_revision: cas };
      const forged = { ...clone(fact), previous_revision: cas, revision: String(BigInt(cas) + 1n) };
      const status = env('reconciliation_status', { status: 'in_progress', transfer_id: s.binding.transfer_id, source: clone(s.source), epoch: s.binding.epoch,
        revision: '3', phase: 'target_ready', terminal: null, activation: null, recovery_generation: s.context.recovery_generation, source_recovery: 'intact' });
      assert.equal(validateObject(forged, 'stepReceipt').valid, cas === previous);
      assert.equal(validateExchange(q, { valid: true, kind: 'retry', errors: [], receipt: forged, status }, s.expectation(operation)).valid, cas === previous);
      const actual = planDecision(q, s.ready.result.ledger, s.ready.result.record, s.context);
      assert.equal(cas === previous ? actual.kind : actual.code, cas === previous ? 'retry' : 'conflict');
      stepCASCases++;
    }
    for (const decision of ['1', '2', '3', '4']) {
      const value = terminal('aborted', decision === '1' ? 'missing_reservation' : 'user_cancelled', decision, s.uuid());
      const expected = BigInt(decision) > BigInt(revision);
      const response = { valid: true, kind: 'retry', errors: [], receipt: fact, status: current(value) };
      assert.equal(validateObject(response.status, 'status').valid, true);
      assert.equal(validateExchange(s[stage].request, response, s.expectation(operation)).valid, expected, operation + '/' + decision);
      stepTerminalCases++; if (expected) validStepTerminals++;
    }
    const inherited = env('reconciliation_status', { status: 'recovery_hold', transfer_id: s.binding.transfer_id, source: clone(s.source), epoch: s.binding.epoch,
      revision, phase, terminal: null, activation: null, recovery_generation: restored.recovery_generation, source_recovery: 'recovery_hold' });
    assert.equal(validateExchange(s[stage].request, { valid: true, kind: 'retry', errors: [], receipt: fact, status: inherited }, s.expectation(operation)).valid, true);
    for (const heldRevision of ['2', '3', '4']) {
      const status = { ...clone(inherited), phase: 'recovery_hold', revision: heldRevision };
      assert.equal(validateObject(status, 'status').valid, true);
      assert.equal(validateExchange(s[stage].request, { valid: true, kind: 'retry', errors: [], receipt: fact, status }, s.expectation(operation)).valid, BigInt(heldRevision) > BigInt(revision));
      heldStepCases++;
    }
    for (const later of ['commit', 'activate']) {
      const actual = planDecision(s[stage].request, s[later].result.ledger, s[later].result.record, s.context);
      assert.equal(actual.kind, 'retry'); assert.equal(validateExchange(s[stage].request, actual, s.expectation(operation)).valid, true);
    }
  }
  assert.equal(stepTerminalCases, 12); assert.equal(validStepTerminals, 6); assert.equal(heldStepCases, 9); assert.equal(stepCASCases, 21);
  let birthCASCases = 0, reserveTerminalWinners = 0;
  for (const cas of ['0', '1', '2', '3', '4', '5', '9223372036854775806']) {
    const q = { ...clone(s.birth.request), expected_revision: cas };
    const mutation = clone(s.birth.result);
    mutation.receipt.request_digest = fingerprint('retry-body', q);
    mutation.ledger.birth = clone(mutation.receipt);
    const retry = { valid: true, kind: 'retry', errors: [], receipt: mutation.receipt, status: null };
    assert.equal(validateObject(mutation.ledger, 'ledger').valid, true);
    assert.equal(validateObject(q, 'request').valid, cas === '0');
    assert.equal(validateExchange(q, mutation).valid, cas === '0');
    assert.equal(validateExchange(q, retry).valid, cas === '0');
    assert.equal(planDecision(q, s.birth.result.ledger, null, s.context).valid, cas === '0');
    birthCASCases++;
    // Reserve's accepted step has CAS 0, but an existing tombstone winner still
    // answers a losing reserve regardless of its proposed CAS.
    const losingReserve = { ...clone(s.reserve.request), expected_revision: cas };
    const winner = planDecision(losingReserve, tomb.ledger, tomb.record, s.context);
    assert.equal(winner.kind, 'terminal'); assert.equal(validateExchange(losingReserve, winner).valid, true);
    reserveTerminalWinners++;
  }
  assert.equal(birthCASCases, 7); assert.equal(reserveTerminalWinners, 7);
  const maintenanceFact = terminal('aborted', 'access_changed', '2', s.uuid());
  assert.equal(validateExchange(abortQ, { valid: true, kind: 'retry', errors: [], receipt: maintenanceFact, status: current(maintenanceFact) }, base).valid, false);
  return { terminalCases, validTerminals, realAbortPaths, casCases, validCAS, additionalAbortCAS, terminalWinners, stepTerminalCases, validStepTerminals, heldStepCases, stepCASCases, birthCASCases, reserveTerminalWinners };
}
