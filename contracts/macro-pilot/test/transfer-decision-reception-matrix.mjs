import assert from 'node:assert/strict';
import { fingerprint, planDecision, planMaintenance, validateExchange, validateObject } from '../v2/transfer-decision-validate.mjs';
import { scenario } from './transfer-decision-vectors.mjs';

// Expected relations are fixed from the native state transitions, independently
// of validateExchange and of any reply being tested.
export function verifyReceptionMatrix() {
  const s = scenario(), clone = structuredClone;
  const request = action => s.request('reconcile', '0', { binding: s.binding, frozen: s.frozen, expected_ledger_revision: '1', action });
  const read = request('status');
  const current = (status, phase, revision, context = s.context, terminal = null) => ({
    decision_contract: 'transfer-decision-1', type: 'reconciliation_status', status,
    transfer_id: s.binding.transfer_id, source: clone(s.source), epoch: s.binding.epoch,
    revision, phase, terminal, activation: null, recovery_generation: context.recovery_generation,
    source_recovery: status === 'recovery_hold' ? 'recovery_hold' : 'intact',
  });
  const reply = status => ({ valid: true, kind: 'status', errors: [], status });
  const progress = { reserved: '1', sealed: '2', target_ready: '3' };
  let statusCases = 0, validStatuses = 0;
  for (const status of ['not_found', 'in_progress', 'recovery_hold']) {
    for (const phase of [null, 'reserved', 'sealed', 'target_ready', 'committed', 'aborted', 'recovery_hold']) {
      for (const revision of ['0', '1', '2', '3', '4', '5', '6', '9223372036854775807']) {
        const expected = status === 'not_found' ? phase === null && revision === '0'
          : status === 'in_progress' ? progress[phase] === revision
          : phase === null ? revision === '0'
          : phase === 'recovery_hold' ? ['2', '3', '4'].includes(revision)
          : progress[phase] === revision;
        const value = current(status, phase, revision), label = JSON.stringify({ status, phase, revision });
        assert.equal(validateObject(value, 'status').valid, expected, label);
        assert.equal(validateExchange(read, reply(value)).valid, expected, label);
        statusCases++; if (expected) validStatuses++;
      }
    }
  }
  assert.equal(statusCases, 168); assert.equal(validStatuses, 11);
  const restored = { ...clone(s.context), history: 'restored', recovery_generation: s.uuid() };
  for (const [stage, phase, revision, heldRevision] of [['reserve', 'reserved', '1', '2'], ['seal', 'sealed', '2', '3'], ['ready', 'target_ready', '3', '4']]) {
    const input = s[stage].result;
    const inherited = planDecision(read, input.ledger, input.record, restored);
    assert.deepEqual(inherited, reply(current('recovery_hold', phase, revision, restored)));
    assert.equal(validateExchange(read, inherited).valid, true);
    const held = planMaintenance(input.ledger, input.record, restored, 'restore_uncertain');
    assert.equal(held.valid, true); assert.equal(held.record.hold_phase, phase);
    assert.equal(held.record.revision, heldRevision); assert.equal(validateObject(held.record, 'record').valid, true);
    const exposed = planDecision(read, held.ledger, held.record, restored);
    assert.deepEqual(exposed, reply(current('recovery_hold', 'recovery_hold', heldRevision, restored)));
    assert.equal(validateExchange(read, exposed).valid, true);
    const repeated = planMaintenance(held.ledger, held.record, restored, 'restore_uncertain');
    assert.deepEqual(repeated.record, held.record); assert.deepEqual(repeated.ledger, held.ledger);
  }

  const missing = request('abort_missing');
  const missingContext = { ...clone(s.context), receipt_id: s.uuid(), proofs: [s.attest(missing, 'source_frozen', fingerprint('frozen', s.frozen))] };
  const tomb = planDecision(missing, s.birth.result.ledger, null, missingContext);
  assert.equal(tomb.kind, 'mutation');
  const tombRetry = planDecision(missing, tomb.ledger, tomb.record, missingContext);
  assert.equal(tombRetry.kind, 'retry');
  const freshRead = request('status');
  const honestRead = planDecision(freshRead, s.birth.result.ledger, null, s.context);
  assert.deepEqual(honestRead, reply(current('not_found', null, '0')));
  const forgedReadMutation = clone(tomb);
  const { operation_id: _id, ...semanticRead } = freshRead;
  forgedReadMutation.record.retries[0] = { operation: 'reconcile', operation_id: freshRead.operation_id,
    request_digest: fingerprint('retry-body', freshRead), body_digest: fingerprint('step-body', semanticRead) };
  assert.equal(validateObject(forgedReadMutation.ledger, 'ledger').valid, true);
  assert.equal(validateObject(forgedReadMutation.record, 'record').valid, true);
  assert.equal(validateExchange(freshRead, forgedReadMutation).valid, false);

  const abortRequest = s.request('abort', '3', { reason: 'user_cancelled' });
  const aborted = planDecision(abortRequest, s.ready.result.ledger, s.ready.result.record, { ...s.context, receipt_id: s.uuid() });
  assert.equal(aborted.kind, 'mutation');
  const sourceRequest = s.request('reconcile', '0', { action: 'source_status', provenance: s.provenance }, false);
  const sourceReply = planDecision(sourceRequest, s.commit.result.ledger, null, s.context);
  const stageStatus = stage => planDecision(read, s[stage].result.ledger, s[stage].result.record, s.context).status;
  const terminalStatus = current('terminal', 'committed', '4', s.context, clone(s.knownTerminal));
  const rows = [
    { name: 'lineage.create', q: s.birth.request, mutation: s.birth.result, status: null, receipt: s.birth.result.receipt, allowed: ['mutation', 'retry'] },
    ...['reserve', 'seal', 'ready', 'commit', 'activate'].map(stage => ({ name: s[stage].request.operation, q: s[stage].request, mutation: s[stage].result, status: stageStatus(stage), receipt: s[stage].result.receipt, expectation: s.expectation(s[stage].request.operation), allowed: ['seal', 'ready', 'activate'].includes(stage) ? ['mutation', 'retry'] : ['mutation', 'retry', 'terminal'] })),
    { name: 'abort', q: abortRequest, mutation: aborted, status: planDecision(read, aborted.ledger, aborted.record, s.context).status, receipt: aborted.receipt, expectation: s.expectation('abort'), allowed: ['mutation', 'retry', 'terminal'] },
    { name: 'reconcile status', q: freshRead, mutation: forgedReadMutation, status: tombRetry.status, receipt: tomb.receipt, allowed: ['status'] },
    { name: 'reconcile abort_missing', q: missing, mutation: tomb, status: tombRetry.status, receipt: tomb.receipt, allowed: ['mutation', 'retry', 'terminal', 'status'] },
    { name: 'reconcile source_status', q: sourceRequest, mutation: s.birth.result, status: sourceReply.status, receipt: s.birth.result.receipt, allowed: ['source_status'] },
  ];
  let kindCases = 0, validKinds = 0, receiptCases = 0;
  for (const row of rows) {
    for (const kind of ['mutation', 'retry', 'terminal', 'status', 'source_status']) {
      const value = kind === 'mutation' ? clone(row.mutation)
        : kind === 'source_status' ? { valid: true, kind, errors: [], status: clone(sourceReply.status) }
        : kind === 'status' ? reply(clone(row.status))
        : { valid: true, kind, errors: [], receipt: clone(row.receipt), status: clone(row.status) };
      const expected = row.allowed.includes(kind);
      if (kind === 'terminal' && expected) { value.receipt = clone(s.knownTerminal); value.status = clone(terminalStatus); }
      assert.equal(validateExchange(row.q, value, row.expectation).valid, expected, row.name + '/' + kind);
      kindCases++; if (expected) validKinds++;
      // Close receipt families inside every allowed receipt-bearing variant.
      if (expected && ['mutation', 'retry', 'terminal'].includes(kind)) {
        for (const receipt of [s.birth.result.receipt, s.reserve.result.receipt, s.knownTerminal, s.activate.result.receipt]) {
          if (receipt.type === value.receipt.type) continue;
          const wrong = { ...clone(value), receipt: clone(receipt) };
          assert.equal(validateExchange(row.q, wrong, row.expectation).valid, false, row.name + '/' + kind + '/' + receipt.type);
          receiptCases++;
        }
      }
    }
  }
  assert.equal(kindCases, 50); assert.equal(validKinds, 23);
  const existing = planDecision(missing, s.ready.result.ledger, s.ready.result.record, missingContext);
  assert.equal(existing.kind, 'status'); assert.equal(validateExchange(missing, existing).valid, true);
  // Kind terminal always carries a terminal receipt, even for reserve.
  const reserveRetry = planDecision(s.reserve.request, s.reserve.result.ledger, s.reserve.result.record, s.context);
  assert.equal(validateExchange(s.reserve.request, { ...reserveRetry, kind: 'terminal' }).valid, false);
  // Committed/aborted are only interchangeable for a terminal winner, not a retry.
  const commitRetry = planDecision(s.commit.request, s.commit.result.ledger, s.commit.result.record, s.context);
  const abortRetry = planDecision(abortRequest, aborted.ledger, aborted.record, s.context);
  assert.equal(validateExchange(s.commit.request, { ...commitRetry, receipt: aborted.receipt, status: abortRetry.status }, s.expectation('commit')).valid, false);
  assert.equal(validateExchange(abortRequest, { ...abortRetry, receipt: s.knownTerminal, status: terminalStatus }, s.expectation('abort')).valid, false);
  return { statusCases, validStatuses, kindCases, validKinds, receiptCases };
}
