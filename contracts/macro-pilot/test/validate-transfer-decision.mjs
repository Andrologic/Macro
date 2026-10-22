import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  LIMITS, canonicalJson, canonicalBytes, fingerprint, exactInteger, increment,
  addBytes, fromSafeInteger, metadataBytes, validateObject, decodeDecision,
  validateExchange, validateProducerAttestation, planDecision, planMaintenance,
  createTransferDecisionValidator,
} from '../v2/transfer-decision-validate.mjs';
import { scenario } from './transfer-decision-vectors.mjs';
import { verifyReceptionMatrix } from './transfer-decision-reception-matrix.mjs';

const root = new URL('../v2/', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('transfer-decision.schema.json', root), 'utf8'));
const clone = structuredClone;
const s = scenario();
const receptionMatrix = verifyReceptionMatrix();
const steps = ['birth', 'reserve', 'seal', 'ready', 'commit', 'activate'];
// C1 uses the current native ConversationContentToken DTO verbatim. The
// desktop-only dev/typecheck-transfer-decision-native.mts imports that generated
// DTO, rather than copying it into the canonical contract.
assert.deepEqual(s.contentToken, { version: 1, incarnation: '0123456789abcdef0123456789abcdef', revision: '9007199254740993' });
assert.equal(s.frozen.content_incarnation, s.contentToken.incarnation);
assert.equal(s.frozen.content_revision, s.contentToken.revision);
for (const incarnation of ['00000000-0000-0000-0000-000000000001', 'A'.repeat(32), '0'.repeat(31), '0'.repeat(33), '0'.repeat(32) + '\n']) {
  assert.equal(validateObject({ ...s.frozen, content_incarnation: incarnation }, 'frozen').valid, false);
}
// PilotStore.lifecycleVersion returns 0 for a fresh account, not revision 1.
const zeroLifecycle = scenario(false, 0);
assert.equal(zeroLifecycle.binding.initiator.account_epoch, '0');
for (const stage of steps) {
  assert.equal(validateObject(zeroLifecycle[stage].context, 'context').valid, true);
  assert.equal(validateExchange(zeroLifecycle[stage].request, zeroLifecycle[stage].result, stage === 'birth' ? undefined : zeroLifecycle.expectation(zeroLifecycle[stage].request.operation)).valid, true);
}
const advancedLifecycle = clone(zeroLifecycle.commit.context);
advancedLifecycle.actor.identity.account_epoch = '1';
assert.equal(planDecision(zeroLifecycle.commit.request, zeroLifecycle.ready.result.ledger, zeroLifecycle.ready.result.record, advancedLifecycle).code, 'authority_changed');
for (const field of ['session_revision', 'source_access_revision', 'target_access_revision']) {
  const actor = clone(zeroLifecycle.binding.initiator); actor[field] = '0';
  assert.equal(validateObject(actor, 'actor').valid, false);
}
for (const step of steps) {
  const value = s[step];
  assert.equal(validateObject(value.request).valid, true, step);
  assert.equal(validateObject(value.context, 'context').valid, true, step);
  assert.equal(validateExchange(value.request, value.result, step === 'birth' ? undefined : s.expectation(value.request.operation)).valid, true, step);
  assert.equal(value.result.kind, 'mutation');
  assert.equal(validateObject(value.result.ledger).valid, true);
  if (value.result.record) assert.equal(validateObject(value.result.record).valid, true);
  assert.ok(!(value.result instanceof Promise));
}
assert.equal(s.reserve.result.record.phase, 'reserved');
assert.equal(s.seal.result.record.phase, 'sealed');
assert.equal(s.ready.result.record.phase, 'target_ready');
assert.equal(s.commit.result.record.phase, 'committed');
assert.equal(s.commit.result.ledger.state, 'ceded');
assert.equal(s.activate.result.record.revision, '5');
assert.deepEqual(s.commit.result.record.terminal, s.activate.result.record.terminal);
assert.equal(s.birth.result.reservation_bytes, '8192');
assert.equal(s.reserve.result.reservation_bytes, '131072');
for (const step of ['seal', 'ready', 'commit', 'activate']) assert.equal(s[step].result.reservation_bytes, '0');

// Exactness, deterministic UTF-8 and domain separation are independent oracles.
assert.equal(exactInteger('9007199254740993'), 9007199254740993n);
assert.equal(increment('9007199254740992'), '9007199254740993');
assert.equal(increment('9223372036854775806'), '9223372036854775807');
assert.equal(addBytes('9007199254740993', '2'), '9007199254740995');
for (const value of ['-1', '+1', '01', '1e3', '1.0', '', '1\n', '1\r', '1\u2028', 1, '9223372036854775808']) assert.throws(() => exactInteger(value));
assert.throws(() => increment('9223372036854775807'));
assert.throws(() => addBytes('9223372036854775807', '1'));
for (const value of [NaN, Infinity, -1, 1.5, 9007199254740992]) assert.throws(() => fromSafeInteger(value));
assert.equal(fromSafeInteger(9007199254740991), '9007199254740991');
assert.equal(canonicalJson({ z: 'é🙂', a: [false, null, 'x'] }), '{"a":[false,null,"x"],"z":"é🙂"}');
const unicode = { z: 'é🙂', a: 'é' };
const expectedHash = createHash('sha256').update('macro-connect-source-key-1\0', 'utf8').update('{"a":"é","z":"é🙂"}', 'utf8').digest('hex');
assert.equal(fingerprint('source-key', unicode), expectedHash);
assert.equal(fingerprint('source-key', unicode), fingerprint('source-key', { a: 'é', z: 'é🙂' }));
assert.notEqual(fingerprint('source-key', unicode), fingerprint('terminal', unicode));
assert.notEqual(fingerprint('source-key', 'é'), fingerprint('source-key', 'e'));
assert.equal(canonicalBytes('é🙂').byteLength, 8);
for (const value of ['\ud800', '\udfff', { '\ud800': 'x' }, undefined, NaN, Infinity, -0, 1.1, new Date(), [, 1]]) assert.throws(() => canonicalJson(value));
const cycle = {}; cycle.self = cycle; assert.throws(() => canonicalJson(cycle));
const hiddenHole = []; hiddenHole.length = 1; hiddenHole.extra = 7;
assert.throws(() => canonicalJson(hiddenHole), 'own array indices must not be replaced by an extra key');
const symbol = { [Symbol('synthetic')]: 1 }; assert.throws(() => canonicalJson(symbol));
let getterCalls = 0;
const accessor = { get value() { getterCalls++; return 1; } };
assert.throws(() => canonicalJson(accessor)); assert.equal(getterCalls, 0);
// F3: neither non-enumerable methods nor substituted prototypes may supply bytes.
let arrayMethodCalls = 0;
const methodArray = [1]; Object.defineProperty(methodArray, 'map', { value: () => { arrayMethodCalls++; return []; } });
const prototypeArray = [1]; Object.setPrototypeOf(prototypeArray, { map: () => { arrayMethodCalls++; return []; } });
const hiddenArray = [1]; Object.defineProperty(hiddenArray, 'private', { value: 7 });
for (const array of [methodArray, prototypeArray, hiddenArray]) assert.throws(() => canonicalJson(array));
assert.equal(arrayMethodCalls, 0); assert.equal(canonicalJson(Object.freeze([1])), '[1]');
assert.equal(canonicalJson(Object.assign(Object.create(null), { a: 1 })), '{"a":1}');

const fail = (result, code) => {
  assert.equal(result.valid, false, JSON.stringify(result));
  if (code) assert.equal(result.code, code);
  assert.deepEqual(result.errors, ['Invalid transfer decision']);
};
const plan = (request, stage, context = s[stage].context) => planDecision(request, s[stage].result.ledger, s[stage].result.record, context);
const withProofs = (request, proofs, context = s.context) => ({ ...clone(context), receipt_id: s.uuid(), proofs });
const reconcile = (action = 'status') => s.request('reconcile', '0', { binding: s.binding, frozen: s.frozen, expected_ledger_revision: s.birth.result.ledger.revision, action });
const statusRequest = reconcile();
const missingStatus = planDecision(statusRequest, s.birth.result.ledger, null, s.context);
assert.equal(missingStatus.status.status, 'not_found');
assert.equal(missingStatus.kind, 'status');
assert.equal(validateExchange(statusRequest, missingStatus).valid, true);
const inProgressStatus = plan(statusRequest, 'ready', s.context);
assert.equal(inProgressStatus.status.status, 'in_progress');
// F1: individually valid objects are insufficient to correlate a reply.
const wrongStatusIdentity = clone(statusRequest);
wrongStatusIdentity.body.binding.provenance.source.source_conversation_id = 'other-chat-synthetic';
wrongStatusIdentity.body.binding.epoch = '1';
wrongStatusIdentity.body.frozen.binding_digest = fingerprint('transfer-binding', wrongStatusIdentity.body.binding);
assert.equal(validateObject(wrongStatusIdentity).valid, true); assert.equal(validateObject(inProgressStatus.status).valid, true);
fail(validateExchange(wrongStatusIdentity, inProgressStatus), 'conflict');
const wrongTerminalIdentity = clone(s.commit.result.receipt);
wrongTerminalIdentity.source.source_conversation_id = 'other-chat-synthetic'; wrongTerminalIdentity.epoch = '1'; wrongTerminalIdentity.target_instance_id = 'other-target-synthetic';
assert.equal(validateObject(wrongTerminalIdentity).valid, true);
fail(validateExchange(s.reserve.request, { valid: true, kind: 'terminal', errors: [], receipt: wrongTerminalIdentity, status: null }), 'conflict');
const foreign = scenario(true);
const mixedMutation = { ...clone(s.reserve.result), record: foreign.reserve.result.record, ledger: foreign.reserve.result.ledger };
assert.equal(validateObject(mixedMutation.record).valid, true); assert.equal(validateObject(mixedMutation.ledger).valid, true);
fail(validateExchange(s.reserve.request, mixedMutation), 'conflict');
for (const stage of ['seal', 'ready', 'commit', 'activate']) {
  fail(validateExchange(s[stage].request, s[stage].result));
  assert.equal(validateExchange(s[stage].request, s[stage].result, s.expectation(s[stage].request.operation)).valid, true);
  const foreignExpected = foreign.expectation(s[stage].request.operation);
  fail(validateExchange(s[stage].request, s[stage].result, foreignExpected), 'conflict');
}
const changedSeal = clone(s.seal.result);
changedSeal.record.manifest.manifest_sha256 = s.hash('0');
changedSeal.record.seal_receipt.subject_digest = fingerprint('manifest', changedSeal.record.manifest);
assert.equal(validateObject(changedSeal.record).valid, true);
fail(validateExchange(s.seal.request, changedSeal, s.expectation('seal')), 'conflict');
for (const stage of ['commit', 'activate']) {
  const changedCAS = clone(s[stage].request); changedCAS.expected_revision = '1';
  fail(validateExchange(changedCAS, s[stage].result, s.expectation(s[stage].request.operation)), 'conflict');
  const changedId = clone(s[stage].request); changedId.operation_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  fail(validateExchange(changedId, s[stage].result, s.expectation(s[stage].request.operation)), 'conflict');
}

// Source exclusivity uses the ledger even if T, destination or initiator differ.
const competing = clone(s.reserve.request);
competing.operation_id = s.uuid(); competing.transfer_id = s.uuid(); competing.body.binding.transfer_id = competing.transfer_id;
competing.body.binding.target_instance_id = s.opaque('another-target');
competing.body.frozen.binding_digest = fingerprint('transfer-binding', competing.body.binding);
fail(planDecision(competing, s.reserve.result.ledger, null, s.reserve.context), 'forbidden');
const anotherT = clone(s.reserve.request); anotherT.operation_id = s.uuid(); anotherT.transfer_id = s.uuid(); anotherT.body.binding.transfer_id = anotherT.transfer_id;
anotherT.body.frozen.binding_digest = fingerprint('transfer-binding', anotherT.body.binding);
fail(planDecision(anotherT, s.reserve.result.ledger, null, s.reserve.context), 'conflict');

// Retry identity, body conflicts and historical receipt after later progression.
for (const stage of ['reserve', 'seal', 'ready', 'commit', 'activate']) {
  const retry = plan(s[stage].request, stage);
  assert.equal(retry.kind, 'retry', stage); assert.deepEqual(retry.receipt, s[stage].result.receipt);
  assert.equal(validateExchange(s[stage].request, retry, s.expectation(s[stage].request.operation)).valid, true);
  fail(validateExchange(s[stage].request, { ...retry, status: null }, s.expectation(s[stage].request.operation)));
  const newId = clone(s[stage].request); newId.operation_id = s.uuid();
  const sameStep = plan(newId, stage);
  assert.equal(sameStep.kind, 'retry'); assert.deepEqual(sameStep.receipt, retry.receipt);
  const changed = clone(s[stage].request); changed.expected_revision = increment(changed.expected_revision);
  fail(plan(changed, stage), 'conflict');
}
const oldReserve = plan(s.reserve.request, 'commit', s.reserve.context);
assert.equal(oldReserve.kind, 'retry'); assert.deepEqual(oldReserve.receipt, s.reserve.result.receipt);
assert.equal(oldReserve.status.status, 'terminal');
// R2: current status is mandatory even for a historical step receipt. The
// expected terminal is independently retained, not extracted from this reply.
const knownCommitExpectation = { ...s.expectation('commit'), terminal: clone(s.knownTerminal) };
assert.equal(validateExchange(s.reserve.request, oldReserve, knownCommitExpectation).valid, true);
fail(validateExchange(s.reserve.request, { ...oldReserve, status: null }, knownCommitExpectation));
const wrongKnownTerminal = clone(knownCommitExpectation); wrongKnownTerminal.terminal.receipt_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
fail(validateExchange(s.reserve.request, oldReserve, wrongKnownTerminal), 'conflict');
const birthRetry = planDecision(s.birth.request, s.birth.result.ledger, null, s.context);
assert.equal(birthRetry.status, null); assert.equal(validateExchange(s.birth.request, birthRetry).valid, true);
fail(validateExchange(s.birth.request, { ...birthRetry, status: oldReserve.status }));
// R3: complete binding facts exclude a target that reuses source lineage.
const selfLineageStatus = plan(statusRequest, 'commit', s.context);
selfLineageStatus.status.terminal.prepared.lineage_id = s.provenance.lineage_id;
assert.equal(validateObject(selfLineageStatus.status, 'status').valid, true);
fail(validateExchange(statusRequest, selfLineageStatus), 'conflict');
const selfLineageExpectation = s.expectation('commit'); selfLineageExpectation.prepared.lineage_id = s.provenance.lineage_id;
fail(validateObject(selfLineageExpectation, 'expectation'), 'conflict');
fail(validateExchange(s.commit.request, s.commit.result, selfLineageExpectation), 'conflict');
// R4: revision counts the decision and, if present, exactly one application.
const terminalStatus = plan(statusRequest, 'commit', s.context);
const activatedStatus = plan(statusRequest, 'activate', s.context);
assert.equal(terminalStatus.status.revision, '4'); assert.equal(activatedStatus.status.revision, '5');
assert.equal(validateExchange(statusRequest, terminalStatus).valid, true);
assert.equal(validateExchange(statusRequest, activatedStatus).valid, true);
for (const [reply, revisions] of [[terminalStatus, ['0', '3', '5']], [activatedStatus, ['0', '4', '6']]]) {
  for (const revision of revisions) {
    const bad = clone(reply); bad.status.revision = revision;
    fail(validateObject(bad.status, 'status')); fail(validateExchange(statusRequest, bad));
  }
}
const wrongApplication = clone(activatedStatus); wrongApplication.status.activation.terminal_digest = s.hash('0');
fail(validateObject(wrongApplication.status, 'status'), 'conflict'); fail(validateExchange(statusRequest, wrongApplication), 'conflict');
const collideId = clone(s.commit.request); collideId.operation_id = s.reserve.request.operation_id;
fail(plan(collideId, 'ready', s.commit.context), 'conflict');
const staleSeal = clone(s.seal.request); staleSeal.expected_revision = '0';
fail(plan(staleSeal, 'reserve', s.seal.context), 'stale_revision');

// Each producer channel fact, challenge and correlated body is necessary.
const proof = s.reserve.context.proofs[0];
const selected = s.reserve.context.producers[0];
assert.equal(validateProducerAttestation(proof.attestation, proof.exchange, selected, selected.connection_id).valid, true);
for (const field of ['binding_digest', 'subject_digest', 'request_digest', 'prior_receipt_digest', 'challenge_id', 'delivery_id', 'producer_generation', 'producer_instance_id']) {
  const wrong = clone(proof.attestation);
  wrong[field] = field.endsWith('digest') ? s.hash('0') : field.endsWith('_id') ? s.uuid() : 'producer-other';
  fail(validateProducerAttestation(wrong, proof.exchange, selected, selected.connection_id));
}
fail(validateProducerAttestation(proof.attestation, proof.exchange, { ...selected, connection_id: s.uuid() }, selected.connection_id), 'producer_changed');
fail(validateProducerAttestation(proof.attestation, proof.exchange, selected, s.uuid()), 'producer_changed');

// Permission changes on either side, account/session/device changes and late producers.
for (const side of [0, 1]) {
  const c = clone(s.commit.context); c.accesses[side].permissions = ['supervise'];
  fail(plan(s.commit.request, 'ready', c), 'forbidden');
  const changedRevision = clone(s.commit.context); changedRevision.accesses[side].revision = increment(changedRevision.accesses[side].revision);
  fail(plan(s.commit.request, 'ready', changedRevision), 'forbidden');
  const changedProducer = clone(s.commit.context); changedProducer.producers[side].generation = s.opaque('later-producer');
  fail(plan(s.commit.request, 'ready', changedProducer), 'producer_changed');
  const offline = clone(s.commit.context); offline.producers[side].state = 'inactive';
  fail(plan(s.commit.request, 'ready', offline), 'instance_offline');
}
for (const field of ['session_id', 'device_id', 'session_revision', 'account_epoch', 'source_access_revision', 'target_access_revision']) {
  const c = clone(s.commit.context); c.actor.identity[field] = field.endsWith('revision') || field === 'account_epoch' ? increment(c.actor.identity[field]) : s.opaque('new-actor');
  fail(plan(s.commit.request, 'ready', c), 'authority_changed');
}
const otherAccount = clone(s.commit.context); otherAccount.actor.identity.account_id = s.opaque('new-account');
fail(plan(s.commit.request, 'ready', otherAccount), 'forbidden');
const revoked = clone(s.commit.context); revoked.actor.state = 'inactive'; fail(plan(s.commit.request, 'ready', revoked), 'unauthorized');
const producerOnly = clone(s.commit.context); producerOnly.actor = null; fail(plan(s.commit.request, 'ready', producerOnly), 'unauthorized');
const noNativeProof = clone(s.commit.context); noNativeProof.proofs = []; fail(plan(s.commit.request, 'ready', noNativeProof), 'forbidden');
const forged = clone(s.commit.context); forged.proofs[0].authenticated = true; fail(plan(s.commit.request, 'ready', forged), 'validation_failed');

// An E format digest is an explicit trusted allow-list entry, not a self-attestation.
const unsupported = clone(s.seal.context); unsupported.supported_context_contracts = [];
fail(plan(s.seal.request, 'reserve', unsupported), 'unsupported_context');
const changedManifest = clone(s.seal.request); changedManifest.body.manifest.frozen_digest = s.hash('0');
const changedManifestContext = withProofs(changedManifest, [s.attest(changedManifest, 'source_sealed', fingerprint('manifest', changedManifest.body.manifest), fingerprint('frozen', s.frozen))]);
fail(plan(changedManifest, 'reserve', changedManifestContext));
const badPrepared = clone(s.ready.request); badPrepared.body.prepared.manifest_digest = s.hash('0');
fail(plan(badPrepared, 'seal', s.ready.context));

// Native freeze already happened, relay reserve ACK was lost and the request delayed.
const abortMissingRequest = reconcile('abort_missing');
const abortMissingContext = withProofs(abortMissingRequest, [s.attest(abortMissingRequest, 'source_frozen', fingerprint('frozen', s.frozen))]);
const tombstone = planDecision(abortMissingRequest, s.birth.result.ledger, null, abortMissingContext);
assert.equal(tombstone.kind, 'mutation'); assert.equal(tombstone.receipt.outcome, 'aborted');
assert.equal(tombstone.receipt.reason, 'missing_reservation');
assert.equal(tombstone.result, undefined); assert.equal(tombstone.ledger.high_epoch, s.binding.epoch);
// F2: accepted abort_missing has a real mutation retry, not the read shortcut.
const exactTombstoneRetry = planDecision(abortMissingRequest, tombstone.ledger, tombstone.record, abortMissingContext);
assert.equal(exactTombstoneRetry.kind, 'retry'); assert.deepEqual(exactTombstoneRetry.receipt, tombstone.receipt);
assert.equal(exactTombstoneRetry.status.status, 'terminal');
assert.equal(validateExchange(abortMissingRequest, exactTombstoneRetry).valid, true);
const changedTombstoneRetry = clone(abortMissingRequest); changedTombstoneRetry.expected_revision = '1';
fail(planDecision(changedTombstoneRetry, tombstone.ledger, tombstone.record, abortMissingContext), 'conflict');
const changedTombstoneBody = clone(abortMissingRequest); changedTombstoneBody.body.expected_ledger_revision = '2';
fail(planDecision(changedTombstoneBody, tombstone.ledger, tombstone.record, abortMissingContext), 'conflict');
// R1: an accepted mutation ID cannot become a read by changing its action.
const tombstoneAsRead = clone(abortMissingRequest); tombstoneAsRead.body.action = 'status';
assert.equal(validateObject(tombstoneAsRead).valid, true);
fail(planDecision(tombstoneAsRead, tombstone.ledger, tombstone.record, abortMissingContext), 'conflict');
const tombstoneAsChangedRead = clone(tombstoneAsRead); tombstoneAsChangedRead.expected_revision = '1'; tombstoneAsChangedRead.body.expected_ledger_revision = '2';
fail(planDecision(tombstoneAsChangedRead, tombstone.ledger, tombstone.record, abortMissingContext), 'conflict');
assert.equal(planDecision(statusRequest, tombstone.ledger, tombstone.record, s.context).kind, 'status');
const delayed = planDecision(s.reserve.request, tombstone.ledger, tombstone.record, s.reserve.context);
assert.equal(delayed.kind, 'terminal'); assert.deepEqual(delayed.receipt, tombstone.receipt);
const oldEpoch = clone(s.reserve.request); oldEpoch.operation_id = s.uuid(); oldEpoch.transfer_id = s.uuid(); oldEpoch.body.binding.transfer_id = oldEpoch.transfer_id;
oldEpoch.body.expected_ledger_revision = tombstone.ledger.revision;
oldEpoch.body.frozen.binding_digest = fingerprint('transfer-binding', oldEpoch.body.binding);
fail(planDecision(oldEpoch, tombstone.ledger, null, s.reserve.context), 'stale_epoch');
const lowerEpoch = clone(oldEpoch); lowerEpoch.body.binding.epoch = '1';
lowerEpoch.body.frozen.binding_digest = fingerprint('transfer-binding', lowerEpoch.body.binding);
fail(planDecision(lowerEpoch, tombstone.ledger, null, s.reserve.context), 'stale_epoch');
fail(planDecision(abortMissingRequest, s.reserve.result.ledger, null, abortMissingContext), 'recovery_hold');
const badReconcile = clone(statusRequest); badReconcile.body.frozen.sha256 = s.hash('0');
fail(plan(badReconcile, 'ready', s.context), 'conflict');

// Commit and abort race through the same state/revision. A loser reads the winner.
const abortRequest = s.request('abort', s.ready.result.record.revision, { reason: 'user_cancelled' });
const abort = plan(abortRequest, 'ready', { ...s.context, receipt_id: s.uuid() });
assert.equal(abort.receipt.outcome, 'aborted'); assert.equal(abort.ledger.state, 'available');
assert.equal(validateExchange(abortRequest, abort, s.expectation('abort')).valid, true);
const commitLoses = planDecision(s.commit.request, abort.ledger, abort.record, s.commit.context);
assert.equal(commitLoses.kind, 'terminal'); assert.deepEqual(commitLoses.receipt, abort.receipt);
assert.equal(validateExchange(s.commit.request, commitLoses, s.expectation('commit')).valid, true);
fail(validateExchange(s.commit.request, { ...commitLoses, status: null }, s.expectation('commit')));
const heldAbortRetry = planDecision(s.reserve.request, abort.ledger, abort.record, { ...s.context, history: 'restored', recovery_generation: s.provenance.installation_id });
assert.equal(heldAbortRetry.status.source_recovery, 'recovery_hold');
assert.equal(validateExchange(s.reserve.request, heldAbortRetry).valid, true);
fail(validateExchange(s.reserve.request, { ...heldAbortRetry, status: null }));
const abortLoses = plan(abortRequest, 'commit', s.context);
assert.equal(abortLoses.kind, 'terminal'); assert.deepEqual(abortLoses.receipt, s.commit.result.receipt);
const pinned = clone(s.ready.result.record);
assert.equal(pinned.terminal, null); assert.deepEqual(pinned.prepared, s.prepared);
assert.deepEqual(s.ready.result.record, pinned, 'pure plans cannot purge the pinned input');
fail(plan(s.activate.request, 'ready', s.activate.context), 'stale_revision');

// Current authority reads a known terminal, without resurrecting the initiator.
const recovery = clone(s.context); recovery.actor.identity.session_id = s.opaque('new-session'); recovery.actor.identity.device_id = s.opaque('new-device'); recovery.accesses = [];
recovery.recovery_access = { account_id: s.source.account_id, session_id: recovery.actor.identity.session_id, instance_id: s.source.source_instance_id, grant_id: s.uuid() };
const recovered = plan(statusRequest, 'commit', recovery);
assert.equal(recovered.status.status, 'terminal'); assert.deepEqual(recovered.status.terminal, s.commit.result.receipt);
const noGrant = clone(recovery); noGrant.recovery_access = null; fail(plan(statusRequest, 'commit', noGrant), 'forbidden');
fail(plan(s.commit.request, 'ready', recovery), 'authority_changed');
const activationRetry = planDecision(s.activate.request, s.activate.result.ledger, s.activate.result.record, recovery);
assert.equal(activationRetry.kind, 'retry'); assert.deepEqual(activationRetry.receipt, s.activate.result.receipt);
const activationReadOnly = { ...clone(recovery), receipt_id: s.activate.context.receipt_id, proofs: s.activate.context.proofs };
fail(planDecision(s.activate.request, s.commit.result.ledger, s.commit.result.record, activationReadOnly), 'forbidden');
const activationAuthority = clone(activationReadOnly);
activationAuthority.accesses = [ { ...s.context.accesses[1], session_id: activationAuthority.actor.identity.session_id } ];
assert.equal(planDecision(s.activate.request, s.commit.result.ledger, s.commit.result.record, activationAuthority).kind, 'mutation');

// Restore is distinct from an intact restart. Absence and inherited nonterminals hold.
const restored = clone(recovery); restored.history = 'restored'; restored.recovery_generation = s.uuid();
const afterRestore = plan(statusRequest, 'commit', restored);
assert.equal(afterRestore.status.status, 'terminal'); assert.deepEqual(afterRestore.status.terminal, recovered.status.terminal);
assert.equal(afterRestore.status.recovery_generation, restored.recovery_generation);
// F5 closes the nullable API without claiming that SQLite lost a real journal.
const ledgerOnlyTerminal = planDecision(statusRequest, s.commit.result.ledger, null, restored);
assert.equal(ledgerOnlyTerminal.status.status, 'terminal'); assert.deepEqual(ledgerOnlyTerminal.status.terminal, s.commit.result.receipt);
assert.equal(validateExchange(statusRequest, ledgerOnlyTerminal).valid, true);
const ledgerOnlyAbort = planDecision(abortMissingRequest, s.commit.result.ledger, null, restored);
assert.equal(ledgerOnlyAbort.kind, 'terminal'); assert.deepEqual(ledgerOnlyAbort.receipt, s.commit.result.receipt);
assert.equal(validateExchange(abortMissingRequest, ledgerOnlyAbort).valid, true);
for (const field of ['epoch', 'target_instance_id', 'transfer_id']) {
  const changed = clone(statusRequest);
  changed.body.binding[field] = field === 'epoch' ? '1' : field === 'transfer_id' ? s.uuid() : 'different-target';
  changed.transfer_id = changed.body.binding.transfer_id;
  changed.body.frozen.binding_digest = fingerprint('transfer-binding', changed.body.binding);
  fail(planDecision(changed, s.commit.result.ledger, null, s.context), 'conflict');
}
const wrongFreeze = clone(statusRequest); wrongFreeze.body.frozen.sha256 = s.hash('0');
fail(planDecision(wrongFreeze, s.commit.result.ledger, null, s.context), 'conflict');
const missingAfterRestore = planDecision(statusRequest, null, null, restored);
assert.equal(missingAfterRestore.status.status, 'recovery_hold');
const sourceStatusRequest = s.request('reconcile', '0', { action: 'source_status', provenance: s.provenance }, false);
const sourceStatus = planDecision(sourceStatusRequest, s.commit.result.ledger, null, restored);
assert.equal(sourceStatus.kind, 'source_status'); assert.equal(sourceStatus.status.status, 'known');
assert.deepEqual(sourceStatus.status.ledger.terminal, s.commit.result.receipt);
assert.equal(validateExchange(sourceStatusRequest, sourceStatus).valid, true);
assert.equal(planDecision(sourceStatusRequest, null, null, restored).status.status, 'recovery_hold');
assert.equal(planDecision(sourceStatusRequest, null, null, s.context).status.status, 'not_found');
fail(planDecision(abortMissingRequest, s.birth.result.ledger, null, { ...s.context, history: 'restored', recovery_generation: s.uuid() }), 'recovery_hold');
const inherited = planMaintenance(s.ready.result.ledger, s.ready.result.record, restored, 'restore_uncertain');
assert.equal(inherited.record.phase, 'recovery_hold'); assert.equal(inherited.record.terminal, null);
assert.equal(inherited.ledger.state, 'recovery_hold'); assert.equal(inherited.record.hold_phase, 'target_ready');
const oldAborted = planDecision(statusRequest, abort.ledger, abort.record, restored);
assert.equal(oldAborted.status.status, 'terminal'); assert.equal(oldAborted.status.terminal.outcome, 'aborted');
assert.equal(oldAborted.status.source_recovery, 'recovery_hold');
// Causal T1 aborted -> backup -> T2 committed -> restore that backup. The known
// T1 terminal survives, but cannot prove that S did not later become ceded.
const nextBinding = clone(s.binding); nextBinding.transfer_id = s.uuid(); nextBinding.epoch = increment(s.binding.epoch);
const nextFrozen = { ...s.frozen, binding_digest: fingerprint('transfer-binding', nextBinding), ownership_revision: increment(s.frozen.ownership_revision) };
const nextManifest = { ...s.manifest, binding_digest: nextFrozen.binding_digest, frozen_digest: fingerprint('frozen', nextFrozen) };
const nextPrepared = { ...s.prepared, binding_digest: nextFrozen.binding_digest, manifest_digest: fingerprint('manifest', nextManifest), import_id: s.uuid(), lineage_id: s.uuid(), target_conversation_id: s.opaque('after-abort-target') };
const nextRequest = (operation, revision, body) => ({ ...s.request(operation, revision, body), transfer_id: nextBinding.transfer_id });
const nextProof = (req, kind, subject, prior = null, target = false) => {
  const result = s.attest(req, kind, subject, prior, target);
  result.attestation.binding_digest = result.exchange.binding_digest = nextFrozen.binding_digest; return result;
};
const nextReserveRequest = nextRequest('reserve', '0', { binding: nextBinding, frozen: nextFrozen, expected_ledger_revision: abort.ledger.revision });
const nextReserve = s.call(nextReserveRequest, abort.ledger, null, [nextProof(nextReserveRequest, 'source_frozen', fingerprint('frozen', nextFrozen))]);
const nextSealRequest = nextRequest('seal', '1', { manifest: nextManifest });
const nextSeal = s.call(nextSealRequest, nextReserve.result.ledger, nextReserve.result.record, [nextProof(nextSealRequest, 'source_sealed', fingerprint('manifest', nextManifest), fingerprint('frozen', nextFrozen))]);
const nextReadyRequest = nextRequest('ready', '2', { prepared: nextPrepared });
const nextReady = s.call(nextReadyRequest, nextSeal.result.ledger, nextSeal.result.record, [nextProof(nextReadyRequest, 'target_pinned', fingerprint('prepared', nextPrepared), fingerprint('manifest', nextManifest), true)]);
const nextCommitRequest = nextRequest('commit', '3', {});
const nextCommit = s.call(nextCommitRequest, nextReady.result.ledger, nextReady.result.record, [nextProof(nextCommitRequest, 'source_maintained', fingerprint('frozen', nextFrozen), fingerprint('manifest', nextManifest)), nextProof(nextCommitRequest, 'target_maintained', fingerprint('prepared', nextPrepared), fingerprint('prepared', nextPrepared), true)]);
assert.equal(nextCommit.result.ledger.state, 'ceded'); assert.equal(nextCommit.result.receipt.transfer_id, nextBinding.transfer_id);
const earlierAbortAgainstLaterCommit = planDecision(statusRequest, nextCommit.result.ledger, abort.record, s.context);
assert.equal(earlierAbortAgainstLaterCommit.status.terminal.outcome, 'aborted');
assert.equal(earlierAbortAgainstLaterCommit.status.source_recovery, 'recovery_hold');
const restoredBeforeT2 = planDecision(sourceStatusRequest, clone(abort.ledger), null, restored);
assert.equal(restoredBeforeT2.status.status, 'recovery_hold');
assert.equal(planDecision(statusRequest, clone(abort.ledger), clone(abort.record), restored).status.source_recovery, 'recovery_hold');
const inheritedAgain = planMaintenance(inherited.ledger, inherited.record, restored, 'producer_changed');
assert.deepEqual(inheritedAgain.record, inherited.record); assert.deepEqual(inheritedAgain.ledger, inherited.ledger);
const restoredStatus = planDecision(statusRequest, inherited.ledger, inherited.record, recovery);
assert.equal(restoredStatus.status.status, 'recovery_hold');
const loginCannotClearHold = planDecision(s.commit.request, inherited.ledger, inherited.record, s.commit.context);
fail(loginCannotClearHold, 'recovery_hold');
const intactRestart = clone(s.context); intactRestart.producers[0].generation = s.opaque('new-generation');
const maintenance = planMaintenance(s.ready.result.ledger, s.ready.result.record, intactRestart, 'producer_changed');
assert.equal(maintenance.receipt.outcome, 'aborted');
for (const reason of ['session_invalidated', 'access_changed', 'producer_changed', 'account_revoked', 'operator_cancelled']) {
  const outcome = planMaintenance(s.ready.result.ledger, s.ready.result.record, s.context, reason);
  assert.equal(outcome.receipt.outcome, 'aborted'); assert.equal(outcome.receipt.reason, reason);
  const terminal = planMaintenance(s.commit.result.ledger, s.commit.result.record, restored, reason);
  assert.equal(terminal.kind, 'terminal'); assert.deepEqual(terminal.receipt, s.commit.result.receipt);
  assert.equal(terminal.status.source_recovery, 'recovery_hold'); assert.equal(validateObject(terminal.status, 'status').valid, true);
}

// Birth proves newness through a correlated native event, including first enrollment.
const enrolledRequest = clone(s.birth.request); enrolledRequest.operation_id = s.uuid(); enrolledRequest.body.mode = 'initial_existing';
const enrolledContext = withProofs(enrolledRequest, [s.attest(enrolledRequest, 'lineage_enrolled', fingerprint('birth', enrolledRequest.body))]);
const enrolled = planDecision(enrolledRequest, null, null, enrolledContext);
assert.equal(enrolled.kind, 'mutation'); assert.equal(enrolled.receipt.mode, 'initial_existing');
fail(planDecision(enrolledRequest, null, null, { ...enrolledContext, history: 'restored' }), 'recovery_hold');
const fresh = scenario(); const freshContext = { ...fresh.birth.context, history: 'restored' };
assert.equal(planDecision(fresh.birth.request, null, null, freshContext).kind, 'mutation');
const relabel = clone(s.birth.request); relabel.operation_id = s.uuid(); relabel.body.provenance.source.source_instance_id = s.opaque('replacement-instance');
fail(planDecision(relabel, null, null, { ...s.birth.context, history: 'restored', recovery_generation: s.uuid() }), 'recovery_hold');
fail(planDecision(s.birth.request, null, null, { ...s.birth.context, proofs: [] }), 'forbidden');
// F4: a historical birth receipt still needs current disclosure authority.
const birthNoAccess = clone(s.context); birthNoAccess.accesses = []; birthNoAccess.recovery_access = null; birthNoAccess.proofs = []; birthNoAccess.producers = [];
fail(planDecision(s.birth.request, s.birth.result.ledger, null, birthNoAccess), 'forbidden');
const birthRead = clone(birthNoAccess); birthRead.accesses = [{ ...s.context.accesses[0], permissions: ['supervise'] }];
assert.deepEqual(planDecision(s.birth.request, s.birth.result.ledger, null, birthRead).receipt, s.birth.result.receipt);
const birthRecovery = clone(birthNoAccess); birthRecovery.recovery_access = { account_id: s.source.account_id, session_id: birthRecovery.actor.identity.session_id, instance_id: s.source.source_instance_id, grant_id: s.uuid() };
assert.deepEqual(planDecision(s.birth.request, s.birth.result.ledger, null, birthRecovery).receipt, s.birth.result.receipt);
fail(planDecision(s.reserve.request, null, null, s.reserve.context), 'recovery_hold');

// Origin comes from verified authority configuration, never a transport alias/body.
const aliasContext = clone(s.reserve.context); aliasContext.authority_origin = 'https://alias.example.test';
fail(planDecision(s.reserve.request, s.birth.result.ledger, null, aliasContext), 'authority_changed');
for (const invalidOrigin of ['https://relay.example.test/', 'https://user@relay.example.test', 'https://relay.example.test?q=x', 'HTTPS://relay.example.test', 'https://relay.example.test:443', 'http://public.example.test']) {
  const bad = clone(s.birth.request); bad.body.provenance.source.relay_origin = invalidOrigin;
  fail(validateObject(bad));
}
const injectedOrigin = clone(s.reserve.request); injectedOrigin.body.origin = 'https://alias.example.test'; fail(validateObject(injectedOrigin));

// Capacity is reserved before admission; no capacity is needed to reach terminal.
const short = clone(s.reserve.context); short.capacity.limit_bytes = String(LIMITS.record - 1);
fail(planDecision(s.reserve.request, s.birth.result.ledger, null, short), 'resource_limit');
short.capacity.limit_bytes = String(LIMITS.record); assert.equal(planDecision(s.reserve.request, s.birth.result.ledger, null, short).kind, 'mutation');
const shortBirth = clone(s.birth.context); shortBirth.capacity.limit_bytes = String(LIMITS.ledger - 1);
fail(planDecision(s.birth.request, null, null, shortBirth), 'resource_limit');
const saturated = clone(s.commit.context); saturated.capacity = { used_bytes: '33554432', reserved_bytes: '0', limit_bytes: '33554432' };
assert.equal(plan(s.commit.request, 'ready', saturated).kind, 'mutation');
const overflow = clone(s.reserve.context); overflow.capacity.used_bytes = '9223372036854775807'; fail(planDecision(s.reserve.request, s.birth.result.ledger, null, overflow), 'resource_limit');

// Closed metadata and fixed diagnostics, including a shape adapter that throws.
const secret = 'synthetic-private-key-name';
for (const value of [null, undefined, [], 1, {}, { decision_contract: 'other' }]) fail(validateObject(value));
const extra = clone(s.reserve.request); extra.body[secret] = { [secret]: secret };
fail(validateObject(extra)); assert.ok(!JSON.stringify(validateObject(extra)).includes(secret));
fail(createTransferDecisionValidator(() => { throw new Error(secret); }).validateObject(s.reserve.request));
fail(createTransferDecisionValidator(async () => true).validateObject(s.reserve.request));
for (const [field, value] of [['expected_revision', 9007199254740992], ['expected_revision', '01'], ['expected_revision', '9223372036854775808']]) {
  const bad = clone(s.reserve.request); bad[field] = value; fail(validateObject(bad));
}
for (const newline of ['\n', '\r', '\u2028', '\u2029']) {
  const bad = clone(s.reserve.request); bad.body.binding.initiator.session_id += newline; fail(validateObject(bad));
}
const duplicateJson = JSON.stringify(s.reserve.request).replace('"expected_revision":"0"', '"expected_revision":"1","expected_revision":"0"');
fail(decodeDecision(duplicateJson, 'request'));
fail(decodeDecision(`{"${secret}":`, 'request')); assert.ok(!JSON.stringify(decodeDecision(`{"${secret}":`, 'request')).includes(secret));
fail(decodeDecision(' '.repeat(LIMITS.envelope + 1), 'request'), 'resource_limit');
assert.deepEqual(decodeDecision(JSON.stringify(s.reserve.request), 'request').value, s.reserve.request);

// Prove a maximum bound for EVERY schema alternative, not a large sample alone.
// The closed string domains are ASCII JSON-safe after origin canonicalization.
function maxBytes(definition) {
  const x = typeof definition === 'string' ? schema.$defs[definition] : definition;
  if (x.$ref) return maxBytes(x.$ref.split('/').at(-1));
  if ('const' in x) return Buffer.byteLength(JSON.stringify(x.const));
  if (x.enum) return Math.max(...x.enum.map(v => Buffer.byteLength(JSON.stringify(v))));
  if (x.oneOf) return Math.max(...x.oneOf.map(maxBytes));
  if (x.type === 'null') return 4;
  if (x.type === 'boolean') return 5;
  if (x.type === 'string') {
    if (x.pattern?.includes('[0-9a-f]{8}')) return 38;
    if (x.pattern === '^[0-9a-f]{64}$') return 66;
    assert.ok(Number.isInteger(x.maxLength), 'every variable string needs an explicit maximum');
    return x.maxLength + 2;
  }
  if (x.type === 'array') { assert.ok(Number.isInteger(x.maxItems)); return 2 + x.maxItems * maxBytes(x.items) + Math.max(0, x.maxItems - 1); }
  if (x.type === 'object') {
    assert.equal(x.additionalProperties, false);
    const entries = Object.entries(x.properties);
    return 2 + Math.max(0, entries.length - 1) + entries.reduce((n, [key, value]) => n + Buffer.byteLength(JSON.stringify(key)) + 1 + maxBytes(value), 0);
  }
  throw new Error('Unbounded decision schema');
}
const bounds = {};
for (const definition of ['request', 'attestation', 'context', 'expectation', 'stepReceipt', 'birthReceipt', 'activation', 'status', 'sourceStatus', 'error', 'terminal', 'ledger', 'record']) {
  const bound = maxBytes(definition), limit = definition === 'terminal' ? LIMITS.terminal : definition === 'ledger' ? LIMITS.ledger : definition === 'record' ? LIMITS.record : LIMITS.envelope;
  assert.ok(bound <= limit, `${definition} schema maximum ${bound} > ${limit}`); bounds[definition] = bound;
}
const large = scenario(true);
assert.equal(large.context.authority_origin.length, 255);
for (const step of steps) {
  assert.equal(validateObject(large[step].context, 'context').valid, true);
  assert.ok(metadataBytes(large[step].request) <= bounds.request);
  assert.ok(metadataBytes(large[step].context) <= bounds.context);
  assert.ok(metadataBytes(large[step].result.ledger) <= bounds.ledger);
  if (large[step].result.record) assert.ok(metadataBytes(large[step].result.record) <= bounds.record);
}

// Types are rendered from the same schema and checked for drift, not a second grammar.
const typeName = key => `Decision${key[0].toUpperCase()}${key.slice(1)}`;
function renderType(x) {
  if (x.$ref) return typeName(x.$ref.split('/').at(-1));
  if ('const' in x) return JSON.stringify(x.const);
  if (x.enum) return x.enum.map(v => JSON.stringify(v)).join(' | ');
  if (x.oneOf) return `(${x.oneOf.map(renderType).join(' | ')})`;
  if (x.type === 'object') return Object.keys(x.properties).length ? `{ ${Object.entries(x.properties).map(([key, value]) => `${JSON.stringify(key)}${x.required.includes(key) ? '' : '?'}: ${renderType(value)}`).join('; ')} }` : 'Record<string, never>';
  if (x.type === 'array') return `Array<${renderType(x.items)}>`;
  assert.ok(['string', 'boolean', 'null'].includes(x.type)); return x.type;
}
const declarations = '// Generated from transfer-decision.schema.json by the conformance type renderer.\n// String counters are canonical checked i64 decimals, never JavaScript numbers.\n'
  + Object.entries(schema.$defs).map(([key, value]) => `export type ${typeName(key)} = ${renderType(value)};\n`).join('')
  + `export interface DecisionDefinitions {\n${Object.keys(schema.$defs).map(key => `  ${key}: ${typeName(key)};\n`).join('')}}\n`
  + `export type DecisionObject = ${renderType(schema)};\n`;

const valid = {};
for (const stage of steps) {
  valid[`request-${s[stage].request.operation}`] = s[stage].request;
  valid[`receipt-${s[stage].request.operation}`] = s[stage].result.receipt;
  valid[`ledger-${stage}`] = s[stage].result.ledger;
  if (s[stage].result.record) valid[`record-${stage}`] = s[stage].result.record;
  for (const item of s[stage].context.proofs) valid[`attestation-${item.attestation.kind}`] = item.attestation;
}
Object.assign(valid, { 'request-initial-existing': enrolledRequest, 'receipt-initial-existing': enrolled.receipt, 'attestation-lineage-enrolled': enrolledContext.proofs[0].attestation, 'request-reconcile-status': statusRequest, 'request-source-status': sourceStatusRequest, 'source-status-terminal': sourceStatus.status, 'request-reconcile-abort-missing': abortMissingRequest, 'request-abort': abortRequest, 'record-aborted': abort.record, 'receipt-aborted': abort.receipt, 'record-tombstone': tombstone.record, 'receipt-tombstone': tombstone.receipt, 'record-recovery-hold': inherited.record, 'ledger-recovery-hold': inherited.ledger, 'status-terminal': recovered.status, 'status-in-progress': inProgressStatus.status, 'status-not-found': missingStatus.status, 'status-recovery-hold': missingAfterRestore.status });
for (const code of schema.$defs.errorCode.enum) valid[`error-${code}`] = { decision_contract: 'transfer-decision-1', type: 'decision_error', operation_id: s.uuid(), code, retryable: ['unavailable', 'instance_offline'].includes(code) };
const malformedPrepared = clone(s.ready.request); malformedPrepared.body.prepared.ready = true;
const invalid = { 'extra-private-metadata': extra, 'forged-ready-boolean': malformedPrepared, 'origin-from-body': injectedOrigin, 'frozen-wrong-binding': { ...s.reserve.request, body: { ...s.reserve.request.body, frozen: { ...s.frozen, binding_digest: s.hash('0') } } }, 'terminal-without-preparation': { ...s.commit.result.receipt, prepared: null }, 'recovery-hold-with-terminal': { ...inherited.record, terminal: s.commit.result.receipt }, 'revision-number': { ...s.reserve.request, expected_revision: 42 }, 'revision-leading-zero': { ...s.reserve.request, expected_revision: '01' }, 'revision-overflow': { ...s.reserve.request, expected_revision: '9223372036854775808' }, 'unknown-contract': { ...s.reserve.request, decision_contract: 'transfer-decision-2' }, 'unknown-operation': { ...s.commit.request, operation: 'content.read' }, 'unknown-format': { ...s.ready.request, body: { prepared: { ...s.prepared, format_version: '2' } } } };

valid['status-activated'] = activatedStatus.status;
valid['request-zero-account-epoch'] = zeroLifecycle.reserve.request;
invalid['request-uuid-content-incarnation'] = { ...s.reserve.request, body: { ...s.reserve.request.body, frozen: { ...s.frozen, content_incarnation: '00000000-0000-0000-0000-000000000001' } } };
invalid['status-terminal-before-decision'] = { ...terminalStatus.status, revision: '0' };
invalid['status-terminal-extra-revision-without-activation'] = { ...terminalStatus.status, revision: '5' };
invalid['status-activated-without-application-revision'] = { ...activatedStatus.status, revision: '4' };

if (process.argv.includes('--write-fixtures')) {
  for (const [kind, fixtures] of Object.entries({ valid, invalid })) {
    mkdirSync(new URL(`fixtures/transfer-decision/${kind}/`, root), { recursive: true });
    for (const [name, value] of Object.entries(fixtures)) writeFileSync(new URL(`fixtures/transfer-decision/${kind}/${name}.json`, root), JSON.stringify(value, null, 2) + '\n');
  }
  writeFileSync(new URL('transfer-decision.d.ts', root), declarations);
}
assert.equal(readFileSync(new URL('transfer-decision.d.ts', root), 'utf8'), declarations);
let fixtures = 0;
for (const kind of ['valid', 'invalid']) {
  const files = readdirSync(new URL(`fixtures/transfer-decision/${kind}/`, root)).sort();
  assert.deepEqual(files, Object.keys(kind === 'valid' ? valid : invalid).map(name => `${name}.json`).sort());
  for (const name of files) {
    const value = JSON.parse(readFileSync(new URL(`fixtures/transfer-decision/${kind}/${name}`, root), 'utf8'));
    assert.deepEqual(value, (kind === 'valid' ? valid : invalid)[name.slice(0, -5)], name);
    assert.equal(validateObject(value).valid, kind === 'valid', `${kind}/${name}`); fixtures++;
  }
}

// Root v1/v2 compatibility uses their exact unchanged registries and fixtures.
for (const version of ['v1', 'v2']) {
  const oldRoot = new URL(`../${version}/`, root);
  const registry = JSON.parse(readFileSync(new URL('schema-set.json', oldRoot), 'utf8'));
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const resource of registry.resources) ajv.addSchema(JSON.parse(readFileSync(new URL(resource.path, oldRoot), 'utf8')));
  const old = ajv.getSchema(registry.root);
  for (const value of Object.values(valid)) assert.equal(old(value), false, `${version} must refuse new metadata`);
  const example = version === 'v1' ? 'review' : 'negotiate';
  assert.equal(old(JSON.parse(readFileSync(new URL(`fixtures/valid/${example}.json`, oldRoot), 'utf8'))), true);
}
console.log(`Decision contract: ${fixtures} fixtures, CAS/retry, auth bindings, terminal races, tombstone, restore, enrollment, capacity, UTF-8 and exact counters passed.`);
console.log(`Reception matrix: ${JSON.stringify(receptionMatrix)}`);
console.log(`Maximum canonical JSON bytes per complete closed schema alternative: ${JSON.stringify(bounds)}`);
