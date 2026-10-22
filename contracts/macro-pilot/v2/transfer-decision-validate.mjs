import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseStoredJsonStrict } from './strict-json.mjs';

export const LIMITS = Object.freeze({ envelope: 16384, terminal: 8192, ledger: 8192, record: 131072 });
const MAX = 9223372036854775807n;
const CONTRACT = 'transfer-decision-1';
const domains = new Set(['source-key', 'provenance', 'transfer-binding', 'retry-body', 'step-body', 'birth', 'frozen', 'manifest', 'prepared', 'attestation', 'terminal', 'activation']);
const decimalKeys = new Set(['epoch', 'high_epoch', 'revision', 'previous_revision', 'decision_revision', 'expected_revision', 'expected_ledger_revision', 'ownership_revision', 'content_revision', 'source_revision', 'session_revision', 'account_epoch', 'source_access_revision', 'target_access_revision', 'used_bytes', 'reserved_bytes', 'limit_bytes']);
const invalid = code => ({ valid: false, code, errors: ['Invalid transfer decision'] });
const ok = () => ({ valid: true, errors: [] });
const requireThat = (condition, code = 'validation_failed') => { if (!condition) throw code; };
const codes = new Set(['validation_failed', 'unsupported_version', 'unsupported_context', 'unauthorized', 'session_revoked', 'forbidden', 'not_found', 'conflict', 'stale_revision', 'stale_epoch', 'authority_changed', 'producer_changed', 'instance_offline', 'recovery_hold', 'resource_limit', 'unavailable']);
const caught = error => invalid(codes.has(error) ? error : 'validation_failed');
export function exactInteger(value) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value));
  const result = BigInt(value); requireThat(String(result) === value); requireThat(result <= MAX, 'resource_limit'); return result;
}
export function increment(value) { const next = exactInteger(value) + 1n; requireThat(next <= MAX, 'resource_limit'); return String(next); }
export function addBytes(...values) {
  let total = 0n;
  for (const value of values) { total += exactInteger(value); requireThat(total <= MAX, 'resource_limit'); }
  return String(total);
}
export function fromSafeInteger(value) {
  requireThat(Number.isSafeInteger(value) && value >= 0); return String(value);
}
function validUnicode(value) { return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
/** Metadata only. Reject non-JSON values instead of silently changing identity. */
export function canonicalJson(value) {
  const seen = new Set();
  function render(item, depth) {
    requireThat(depth <= 32);
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') { requireThat(validUnicode(item)); return JSON.stringify(item); }
    if (typeof item === 'number') { requireThat(Number.isSafeInteger(item) && !Object.is(item, -0)); return String(item); }
    requireThat(item && typeof item === 'object' && !seen.has(item));
    const array = Array.isArray(item);
    requireThat(array ? Object.getPrototypeOf(item) === Array.prototype : Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null);
    const keys = Reflect.ownKeys(item);
    requireThat(keys.every(key => typeof key === 'string'));
    seen.add(item);
    const parts = [];
    if (array) {
      requireThat(keys.length === item.length + 1 && keys.at(-1) === 'length');
      for (let index = 0; index < item.length; index++) {
        requireThat(keys[index] === String(index));
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        requireThat(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
        parts.push(render(descriptor.value, depth + 1));
      }
    } else for (const key of keys.sort()) {
      requireThat(validUnicode(key));
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      requireThat(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
      parts.push(`${JSON.stringify(key)}:${render(descriptor.value, depth + 1)}`);
    }
    const result = array ? `[${parts.join(',')}]` : `{${parts.join(',')}}`;
    seen.delete(item); return result;
  }
  return render(value, 0);
}
export const canonicalBytes = value => new TextEncoder().encode(canonicalJson(value));
export const metadataBytes = value => canonicalBytes(value).byteLength;
export function fingerprint(domain, value) {
  requireThat(domains.has(domain));
  return createHash('sha256').update(`macro-connect-${domain}-1\0`, 'utf8').update(canonicalBytes(value)).digest('hex');
}
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
function origin(value) {
  const parsed = new URL(value);
  requireThat(parsed.origin === value && !parsed.username && !parsed.password && !parsed.search && !parsed.hash);
  requireThat(parsed.protocol === 'https:' || parsed.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname));
}
const bindingDigest = binding => fingerprint('transfer-binding', binding);
const bodyDigest = request => { const { operation_id: _id, ...body } = request; return fingerprint('step-body', body); };
const sourceOf = binding => binding.provenance.source;
const envelope = (type, fields) => ({ decision_contract: CONTRACT, type, ...fields });
const progressRevisions = Object.freeze({ reserved: '1', sealed: '2', target_ready: '3' });
function progressRevision(phase, held = false) {
  requireThat(Object.hasOwn(progressRevisions, phase));
  return held ? increment(progressRevisions[phase]) : progressRevisions[phase];
}
const postProgressRevisions = Object.freeze(Object.keys(progressRevisions).map(phase => progressRevision(phase, true)));
const stepPhases = Object.freeze({ reserve: 'reserved', seal: 'sealed', ready: 'target_ready' });
const consumerKinds = Object.freeze({
  'lineage.create': ['mutation', 'retry'],
  reserve: ['mutation', 'retry', 'terminal'],
  seal: ['mutation', 'retry'], ready: ['mutation', 'retry'],
  commit: ['mutation', 'retry', 'terminal'], abort: ['mutation', 'retry', 'terminal'],
  status: ['status'], abort_missing: ['mutation', 'retry', 'terminal', 'status'],
  source_status: ['source_status'], 'activation.record': ['mutation', 'retry'],
});

/** Synchronous comparisons only. All context facts must come from the adapter's
 * authenticated current snapshots INSIDE its transaction, never request JSON.
 * A successful plan has not persisted anything and authenticates nobody. */
export function createTransferDecisionValidator(shape) {
  if (typeof shape !== 'function') throw new TypeError('Compiled decision schema required');
  function assertObject(value, definition) {
    definition ??= ({ decision_request: 'request', producer_attestation: 'attestation', source_ledger: 'ledger', transfer_record: 'record', step_receipt: 'stepReceipt', terminal_receipt: 'terminal', activation_receipt: 'activation', birth_receipt: 'birthReceipt', reconciliation_status: 'status', source_reconciliation_status: 'sourceStatus', decision_error: 'error' })[value?.type];
    requireThat(shape(value, definition) === true);
    // A closed schema bounds depth/cardinality. Canonicalization also refuses
    // unsafe JS values and invalid Unicode before any fingerprint is accepted.
    const size = metadataBytes(value);
    const limit = definition === 'record' ? LIMITS.record : definition === 'ledger' ? LIMITS.ledger : definition === 'terminal' ? LIMITS.terminal : LIMITS.envelope;
    requireThat(size <= limit, 'resource_limit');
    function visit(item) {
      if (!item || typeof item !== 'object') return;
      for (const [key, child] of Object.entries(item)) {
        if (decimalKeys.has(key)) exactInteger(child);
        if (key === 'relay_origin' || key === 'authority_origin' || key === 'loopback_test_origin' && child !== null) origin(child);
        visit(child);
      }
    }
    visit(value);
    if (definition === 'binding') bindingRules(value);
    if (definition === 'expectation') expectationRules(value);
    if (definition === 'terminal') terminalRules(value);
    if (definition === 'ledger') ledgerRules(value);
    if (definition === 'record') recordRules(value);
    if (definition === 'sourceStatus') {
      if (value.ledger) { ledgerRules(value.ledger); requireThat(same(value.provenance, value.ledger.provenance)); }
      requireThat(value.status === 'not_found' ? value.ledger === null : value.status === 'known' ? value.ledger !== null && value.ledger.state !== 'recovery_hold' : value.ledger?.state !== 'ceded');
    }
    if (definition === 'request' && value.body.binding) {
      bindingRules(value.body.binding);
      requireThat(value.transfer_id === value.body.binding.transfer_id && value.body.frozen.binding_digest === bindingDigest(value.body.binding));
    }
    if (definition === 'stepReceipt') stepReceiptRules(value);
    if (definition === 'status') {
      requireThat((value.status === 'terminal') === (value.terminal !== null));
      if (value.terminal) {
        terminalRules(value.terminal);
        requireThat(value.transfer_id === value.terminal.transfer_id && same(value.source, value.terminal.source) && value.epoch === value.terminal.epoch && value.phase === value.terminal.outcome);
        requireThat(value.revision === (value.activation ? increment(value.terminal.decision_revision) : value.terminal.decision_revision));
      }
      if (value.status === 'not_found') requireThat(value.revision === '0' && value.phase === null && value.activation === null && value.source_recovery === 'intact');
      if (value.status === 'in_progress') requireThat(value.revision === progressRevision(value.phase) && value.activation === null && value.source_recovery === 'intact');
      if (value.status === 'recovery_hold') {
        requireThat(value.source_recovery === 'recovery_hold' && value.activation === null);
        requireThat(value.phase === null ? value.revision === '0' : value.phase === 'recovery_hold'
          ? postProgressRevisions.includes(value.revision)
          : value.revision === progressRevision(value.phase));
      }
      if (value.activation) activationRules(value.activation, value.terminal);
    }
    if (definition === 'error') requireThat(value.retryable === ['unavailable', 'instance_offline'].includes(value.code));
  }
  function bindingRules(binding) {
    const s = sourceOf(binding);
    requireThat(binding.initiator.account_id === s.account_id && binding.target_instance_id !== s.source_instance_id);
    requireThat(binding.provenance.lineage_id !== binding.provenance.installation_id);
  }
  function terminalRules(terminal) {
    requireThat(terminal.target_instance_id !== terminal.source.source_instance_id);
    requireThat(terminal.outcome === 'committed' ? terminal.reason === null && terminal.manifest_digest !== null && terminal.prepared !== null : terminal.reason !== null && terminal.prepared === null && terminal.manifest_digest === null);
    requireThat(terminal.outcome === 'committed' ? terminal.decision_revision === progressRevision('target_ready', true)
      : terminal.reason === 'missing_reservation' ? terminal.decision_revision === '1'
      : postProgressRevisions.includes(terminal.decision_revision));
    if (terminal.prepared) requireThat(terminal.prepared.binding_digest === terminal.binding_digest && terminal.prepared.manifest_digest === terminal.manifest_digest && terminal.prepared.target_conversation_id !== terminal.source.source_conversation_id);
  }
  function stepReceiptRules(receipt) {
    requireThat(Object.hasOwn(stepPhases, receipt.operation) && receipt.phase === stepPhases[receipt.operation]);
    requireThat(receipt.revision === progressRevision(receipt.phase) && receipt.revision === increment(receipt.previous_revision));
  }
  function activationRules(activation, terminal) {
    requireThat(terminal?.outcome === 'committed' && activation.transfer_id === terminal.transfer_id && activation.terminal_digest === fingerprint('terminal', terminal) && activation.target_instance_id === terminal.target_instance_id && activation.target_conversation_id === terminal.prepared.target_conversation_id && activation.prepared_digest === fingerprint('prepared', terminal.prepared), 'conflict');
  }
  function ledgerRules(ledger) {
    requireThat(ledger.birth.provenance_digest === fingerprint('provenance', ledger.provenance));
    if (ledger.state === 'reserved') requireThat(ledger.active_transfer_id !== null && ledger.terminal === null && ledger.hold_reason === null);
    if (ledger.state === 'available') requireThat(ledger.active_transfer_id === null && ledger.terminal === null && ledger.hold_reason === null);
    if (ledger.state === 'recovery_hold') requireThat(ledger.terminal === null && ledger.hold_reason === 'relay_restore');
    if (ledger.state === 'ceded') {
      requireThat(ledger.active_transfer_id === null && ledger.hold_reason === null && ledger.terminal !== null);
      terminalRules(ledger.terminal);
      requireThat(ledger.terminal.outcome === 'committed' && same(ledger.terminal.source, ledger.provenance.source) && exactInteger(ledger.high_epoch) >= exactInteger(ledger.terminal.epoch));
    }
  }
  function recordRules(record) {
    const b = record.binding, digest = bindingDigest(b);
    bindingRules(b);
    requireThat(record.frozen.binding_digest === digest);
    if (record.manifest) requireThat(record.manifest.binding_digest === digest && record.manifest.frozen_digest === fingerprint('frozen', record.frozen) && record.manifest.source_revision === record.frozen.content_revision);
    if (record.prepared) requireThat(record.manifest !== null && record.prepared.binding_digest === digest && record.prepared.manifest_digest === fingerprint('manifest', record.manifest) && record.prepared.lineage_id !== b.provenance.lineage_id && record.prepared.target_conversation_id !== sourceOf(b).source_conversation_id);
    const phase = record.phase === 'recovery_hold' ? record.hold_phase : record.phase;
    requireThat(record.phase === 'recovery_hold' ? record.hold_phase !== null : record.hold_phase === null);
    if (phase === 'reserved') requireThat(record.manifest === null && record.prepared === null && record.seal_receipt === null && record.ready_receipt === null);
    if (phase === 'sealed') requireThat(record.manifest !== null && record.prepared === null && record.ready_receipt === null);
    if (['target_ready', 'committed'].includes(phase)) requireThat(record.manifest !== null && record.prepared !== null && record.ready_receipt !== null);
    if (!['committed', 'aborted'].includes(phase)) requireThat(record.terminal === null && record.activation === null && record.reserve_receipt !== null);
    requireThat((record.manifest !== null) === (record.seal_receipt !== null) && (record.prepared !== null) === (record.ready_receipt !== null));
    if (record.reserve_receipt === null) requireThat(phase === 'aborted' && record.manifest === null && record.prepared === null);
    if (['committed', 'aborted'].includes(phase)) {
      requireThat(record.terminal !== null); terminalRules(record.terminal);
      const t = record.terminal;
      requireThat(t.outcome === phase && t.binding_digest === digest && t.frozen_digest === fingerprint('frozen', record.frozen) && t.transfer_id === b.transfer_id && same(t.source, sourceOf(b)) && t.epoch === b.epoch && t.target_instance_id === b.target_instance_id);
      requireThat(exactInteger(t.decision_revision) <= exactInteger(record.revision));
      if (phase === 'committed') requireThat(same(t.prepared, record.prepared) && t.manifest_digest === fingerprint('manifest', record.manifest));
    }
    if (record.activation !== null) {
      requireThat(phase === 'committed'); activationRules(record.activation, record.terminal);
    }
    for (const [operation, receipt] of [['reserve', record.reserve_receipt], ['seal', record.seal_receipt], ['ready', record.ready_receipt]]) {
      if (receipt) {
        stepReceiptRules(receipt);
        requireThat(receipt.operation === operation && receipt.transfer_id === b.transfer_id && receipt.binding_digest === digest && exactInteger(receipt.revision) <= exactInteger(record.revision));
        requireThat(receipt.subject_digest === (operation === 'reserve' ? fingerprint('frozen', record.frozen) : operation === 'seal' ? fingerprint('manifest', record.manifest) : fingerprint('prepared', record.prepared)));
      }
    }
    requireThat(new Set(record.retries.map(r => r.operation)).size === record.retries.length && new Set(record.retries.map(r => r.operation_id)).size === record.retries.length);
    const receiptIds = [record.reserve_receipt, record.seal_receipt, record.ready_receipt, record.terminal, record.activation].filter(Boolean).map(r => r.receipt_id);
    requireThat(new Set(receiptIds).size === receiptIds.length);
    const expected = [record.reserve_receipt && 'reserve', record.seal_receipt && 'seal', record.ready_receipt && 'ready', record.terminal && (record.terminal.outcome === 'committed' ? 'commit' : record.reserve_receipt ? 'abort' : 'reconcile'), record.activation && 'activation.record'].filter(Boolean);
    requireThat(same([...expected].sort(), record.retries.map(r => r.operation).sort()));
    const stageRevision = record.ready_receipt ? '3' : record.seal_receipt ? '2' : record.reserve_receipt ? '1' : '0';
    if (record.terminal) requireThat(record.terminal.decision_revision === increment(stageRevision) && record.revision === (record.activation ? increment(record.terminal.decision_revision) : record.terminal.decision_revision));
    else requireThat(stageRevision === progressRevision(phase) && record.revision === progressRevision(phase, record.phase === 'recovery_hold'));
  }
  function validateObject(value, definition) {
    try { assertObject(value, definition); return ok(); } catch (error) { return caught(error); }
  }
  function contextRules(context) {
    assertObject(context, 'context');
    origin(context.authority_origin);
    if (context.authority_origin.startsWith('http:')) requireThat(context.loopback_test_origin === context.authority_origin);
    requireThat(new Set(context.producers.map(p => p.instance_id)).size === context.producers.length);
    requireThat(new Set(context.accesses.map(a => a.instance_id)).size === context.accesses.length);
  }
  function authorityOrigin(provenance, context) {
    requireThat(provenance.source.relay_origin === context.authority_origin, 'authority_changed');
    if (provenance.source.relay_origin.startsWith('http:')) requireThat(provenance.source.relay_origin === context.loopback_test_origin);
  }
  function currentActor(account, context) {
    const actor = context.actor;
    requireThat(actor !== null && actor.state === 'active', 'unauthorized');
    requireThat(actor.identity.account_id === account, 'forbidden'); return actor.identity;
  }
  function rights(binding, context, strict = true) {
    const s = sourceOf(binding), actor = currentActor(s.account_id, context);
    if (strict) requireThat(same(actor, binding.initiator), 'authority_changed');
    for (const [instance, revision] of [[s.source_instance_id, actor.source_access_revision], [binding.target_instance_id, actor.target_access_revision]]) {
      const access = context.accesses.find(a => a.instance_id === instance);
      requireThat(access && access.account_id === s.account_id && access.session_id === actor.session_id && access.revision === revision && ['supervise', 'respond'].every(p => access.permissions.includes(p)), 'forbidden');
    }
  }
  function reader(binding, context) {
    const s = sourceOf(binding), actor = currentActor(s.account_id, context);
    const instances = [s.source_instance_id, binding.target_instance_id];
    const access = context.accesses.some(a => a.account_id === s.account_id && a.session_id === actor.session_id && instances.includes(a.instance_id) && a.permissions.includes('supervise'));
    const grant = context.recovery_access;
    requireThat(access || grant !== null && grant.account_id === s.account_id && grant.session_id === actor.session_id && instances.includes(grant.instance_id), 'forbidden');
  }
  function sourceReader(provenance, context) {
    const s = provenance.source, actor = currentActor(s.account_id, context);
    const access = context.accesses.some(a => a.account_id === s.account_id && a.session_id === actor.session_id && a.instance_id === s.source_instance_id && a.permissions.includes('supervise'));
    const grant = context.recovery_access;
    requireThat(access || grant !== null && grant.account_id === s.account_id && grant.session_id === actor.session_id && grant.instance_id === s.source_instance_id, 'forbidden');
  }
  function producer(binding, context, target = false, current = false) {
    const s = sourceOf(binding), instance = target ? binding.target_instance_id : s.source_instance_id;
    const p = context.producers.find(row => row.instance_id === instance);
    requireThat(p && p.state === 'active' && p.account_id === s.account_id, 'instance_offline');
    if (!current) requireThat(p.generation === (target ? binding.target_producer_generation : binding.source_producer_generation), 'producer_changed');
    return p;
  }
  function assertAttestation(attestation, exchange, selected, connection) {
    assertObject(attestation, 'attestation'); assertObject(exchange, 'exchange'); assertObject(selected, 'producer');
    requireThat(selected.state === 'active', 'instance_offline');
    requireThat(selected.connection_id === connection && exchange.connection_id === connection && selected.instance_id === exchange.instance_id && selected.generation === exchange.producer_generation, 'producer_changed');
    for (const field of ['kind', 'binding_digest', 'subject_digest', 'delivery_id', 'challenge_id', 'request_digest', 'prior_receipt_digest']) requireThat(attestation[field] === exchange[field], 'conflict');
    requireThat(attestation.producer_instance_id === selected.instance_id && attestation.producer_generation === selected.generation, 'producer_changed');
  }
  function validateProducerAttestation(attestation, exchange, selected, connection) {
    try { assertAttestation(attestation, exchange, selected, connection); return ok(); } catch (error) { return caught(error); }
  }
  function proof(request, context, selected, kind, binding, subject, previous = null) {
    const matches = context.proofs.filter(p => p.attestation.kind === kind);
    requireThat(matches.length === 1, 'forbidden');
    const p = matches[0]; assertAttestation(p.attestation, p.exchange, selected, p.authenticated_connection_id);
    requireThat(p.attestation.binding_digest === binding && p.attestation.subject_digest === subject && p.attestation.request_digest === fingerprint('retry-body', request) && p.attestation.prior_receipt_digest === previous, 'conflict');
    return p.attestation;
  }
  function sameLedger(binding, ledger) {
    requireThat(ledger !== null && same(binding.provenance, ledger.provenance), 'recovery_hold');
    requireThat(exactInteger(ledger.high_epoch) >= exactInteger(binding.epoch), 'stale_epoch');
  }
  function uncertain(provenance, context, ledger) {
    return ledger?.state === 'recovery_hold' || context.history === 'restored' && (ledger === null || provenance.birth_generation !== context.recovery_generation);
  }
  function status(request, record, context, ledger, retainedTerminal = null) {
    const b = record?.binding ?? request.body.binding;
    const terminal = record?.terminal ?? retainedTerminal;
    const hold = uncertain(b.provenance, context, ledger) || record?.phase === 'recovery_hold' || ledger?.state === 'ceded' && ledger.terminal.transfer_id !== b.transfer_id;
    return envelope('reconciliation_status', { status: terminal ? 'terminal' : hold ? 'recovery_hold' : record ? 'in_progress' : 'not_found', transfer_id: b.transfer_id, source: sourceOf(b), epoch: b.epoch, revision: record?.revision ?? terminal?.decision_revision ?? '0', phase: record?.phase ?? terminal?.outcome ?? null, terminal, activation: record?.activation ?? null, recovery_generation: context.recovery_generation, source_recovery: hold ? 'recovery_hold' : 'intact' });
  }
  function receiptFor(record, operation) {
    return operation === 'reserve' ? record.reserve_receipt : operation === 'seal' ? record.seal_receipt : operation === 'ready' ? record.ready_receipt : operation === 'activation.record' ? record.activation : record.terminal;
  }
  function reserveCapacity(context, amount) {
    requireThat(exactInteger(addBytes(context.capacity.used_bytes, context.capacity.reserved_bytes, String(amount))) <= exactInteger(context.capacity.limit_bytes), 'resource_limit');
  }
  function mutation(ledger, record, receipt, reserved = 0) {
    assertObject(ledger, 'ledger'); if (record) assertObject(record, 'record');
    return { valid: true, kind: 'mutation', errors: [], ledger, record, receipt, reservation_bytes: String(reserved) };
  }
  function stepReceipt(request, record, context, phase) {
    const subject = request.operation === 'seal' ? fingerprint('manifest', request.body.manifest) : fingerprint('prepared', request.body.prepared);
    return envelope('step_receipt', { receipt_id: context.receipt_id, operation: request.operation, transfer_id: request.transfer_id, binding_digest: bindingDigest(record.binding), subject_digest: subject, previous_revision: record.revision, revision: increment(record.revision), phase });
  }
  function newRecord(binding, frozen) {
    return envelope('transfer_record', { binding: structuredClone(binding), revision: '1', phase: 'reserved', frozen: structuredClone(frozen), manifest: null, prepared: null, reserve_receipt: null, seal_receipt: null, ready_receipt: null, terminal: null, activation: null, retries: [], hold_phase: null });
  }
  function retryEntry(request) { return { operation: request.operation, operation_id: request.operation_id, request_digest: fingerprint('retry-body', request), body_digest: bodyDigest(request) }; }
  function terminalize(request, ledger, record, context, outcome, reason) {
    const b = record.binding;
    record.revision = record.reserve_receipt === null ? '1' : increment(record.revision);
    record.phase = outcome; record.hold_phase = null;
    const receipt = envelope('terminal_receipt', { receipt_id: context.receipt_id, transfer_id: b.transfer_id, source: structuredClone(sourceOf(b)), epoch: b.epoch, target_instance_id: b.target_instance_id, binding_digest: bindingDigest(b), frozen_digest: fingerprint('frozen', record.frozen), decision_revision: record.revision, outcome, reason, manifest_digest: outcome === 'committed' ? fingerprint('manifest', record.manifest) : null, prepared: outcome === 'committed' ? structuredClone(record.prepared) : null });
    record.terminal = receipt; record.retries.push(retryEntry(request));
    ledger.revision = increment(ledger.revision); ledger.active_transfer_id = null;
    ledger.high_epoch = String(exactInteger(ledger.high_epoch) > exactInteger(b.epoch) ? exactInteger(ledger.high_epoch) : exactInteger(b.epoch));
    ledger.state = outcome === 'committed' ? 'ceded' : 'available'; ledger.terminal = outcome === 'committed' ? receipt : null;
    return mutation(ledger, record, receipt);
  }
  /** Produce a write plan or a read/retry result. The caller owns one atomic,
   * durable CAS plus challenge consumption and capacity accounting. */
  function planDecision(request, ledger, record, context) {
    try {
      assertObject(request, 'request'); contextRules(context);
      if (ledger !== null) assertObject(ledger, 'ledger');
      if (record !== null) assertObject(record, 'record');
      ledger = structuredClone(ledger); record = structuredClone(record);
      const op = request.operation;
      if (op === 'reconcile' && request.body.action === 'source_status') {
        requireThat(record === null);
        const provenance = request.body.provenance; authorityOrigin(provenance, context); sourceReader(provenance, context);
        if (ledger) requireThat(same(provenance, ledger.provenance), 'conflict');
        const held = ledger?.state !== 'ceded' && uncertain(provenance, context, ledger);
        const result = envelope('source_reconciliation_status', { status: held ? 'recovery_hold' : ledger ? 'known' : 'not_found', provenance: structuredClone(provenance), ledger, recovery_generation: context.recovery_generation });
        assertObject(result, 'sourceStatus');
        return { valid: true, kind: 'source_status', errors: [], status: result };
      }
      if (op === 'lineage.create') {
        requireThat(record === null && request.expected_revision === '0');
        const { provenance, mode } = request.body; authorityOrigin(provenance, context);
        currentActor(provenance.source.account_id, context);
        if (ledger) {
          sourceReader(provenance, context);
          requireThat(same(ledger.provenance, provenance) && ledger.birth.operation_id === request.operation_id && ledger.birth.request_digest === fingerprint('retry-body', request), 'conflict');
          requireThat(!uncertain(provenance, context, ledger), 'recovery_hold');
          return { valid: true, kind: 'retry', errors: [], receipt: ledger.birth, status: null };
        }
        requireThat(provenance.birth_generation === context.recovery_generation && (mode === 'created' || context.history === 'intact'), 'recovery_hold');
        const p = context.producers.find(p => p.instance_id === provenance.source.source_instance_id);
        requireThat(p && p.state === 'active' && p.account_id === provenance.source.account_id, 'instance_offline');
        const a = context.accesses.find(a => a.instance_id === p.instance_id), actor = context.actor.identity;
        requireThat(a && a.account_id === actor.account_id && a.session_id === actor.session_id && ['supervise', 'respond'].every(right => a.permissions.includes(right)) && a.revision === actor.source_access_revision, 'forbidden');
        const attestation = proof(request, context, p, mode === 'created' ? 'lineage_created' : 'lineage_enrolled', fingerprint('provenance', provenance), fingerprint('birth', request.body));
        reserveCapacity(context, LIMITS.ledger);
        const receipt = envelope('birth_receipt', { receipt_id: context.receipt_id, operation_id: request.operation_id, request_digest: fingerprint('retry-body', request), mode, provenance_digest: fingerprint('provenance', provenance), producer_generation: p.generation, attestation_digest: fingerprint('attestation', attestation), revision: '1' });
        ledger = envelope('source_ledger', { provenance: structuredClone(provenance), revision: '1', high_epoch: '0', birth: receipt, state: 'available', active_transfer_id: null, terminal: null, hold_reason: null });
        return mutation(ledger, null, receipt, LIMITS.ledger);
      }
      const binding = record?.binding ?? request.body.binding;
      requireThat(binding !== undefined, 'not_found'); assertObject(binding, 'binding');
      requireThat(request.transfer_id === binding.transfer_id, 'conflict'); authorityOrigin(binding.provenance, context);
      if (request.body.binding) requireThat(same(request.body.binding, binding), 'conflict');
      if (record && request.body.frozen) requireThat(same(request.body.frozen, record.frozen), 'conflict');
      if (record) {
        sameLedger(binding, ledger);
        if (record.terminal?.outcome === 'committed') requireThat(ledger.state === 'ceded' && same(ledger.terminal, record.terminal), 'conflict');
        if (!record.terminal) requireThat(ledger.active_transfer_id === binding.transfer_id && ledger.high_epoch === binding.epoch && ['reserved', 'recovery_hold'].includes(ledger.state), 'conflict');
      } else if (ledger) requireThat(same(ledger.provenance, binding.provenance), 'conflict');
      if (op === 'reconcile') {
        reader(binding, context);
        const reused = record?.retries.find(r => r.operation_id === request.operation_id);
        if (reused) requireThat(reused.operation === op && reused.request_digest === fingerprint('retry-body', request), 'conflict');
        if (record === null && ledger?.state === 'ceded') {
          matchTerminal(ledger.terminal, { binding, frozen: request.body.frozen, manifest: null, prepared: null, terminal: null });
          const current = status(request, null, context, ledger, ledger.terminal);
          return request.body.action === 'status' ? { valid: true, kind: 'status', errors: [], status: current } : { valid: true, kind: 'terminal', errors: [], receipt: ledger.terminal, status: current };
        }
        if (request.body.action === 'status') return { valid: true, kind: 'status', errors: [], status: status(request, record, context, ledger) };
        if (record) {
          const earlier = record.retries.find(r => r.operation === op);
          if (earlier) {
            requireThat(earlier.body_digest === bodyDigest(request), 'conflict');
            return { valid: true, kind: 'retry', errors: [], receipt: record.terminal, status: status(request, record, context, ledger) };
          }
          return record.terminal ? { valid: true, kind: 'terminal', errors: [], receipt: record.terminal, status: status(request, record, context, ledger) } : { valid: true, kind: 'status', errors: [], status: status(request, record, context, ledger) };
        }
        requireThat(!uncertain(binding.provenance, context, ledger), 'recovery_hold');
        rights(binding, context, false);
        requireThat(ledger !== null && ledger.state === 'available', ledger?.state === 'ceded' ? 'conflict' : 'recovery_hold');
        requireThat(request.expected_revision === '0' && request.body.expected_ledger_revision === ledger.revision, 'stale_revision');
        requireThat(exactInteger(binding.epoch) > exactInteger(ledger.high_epoch), 'stale_epoch');
        requireThat(request.body.frozen.binding_digest === bindingDigest(binding), 'conflict');
        proof(request, context, producer(binding, context, false, true), 'source_frozen', bindingDigest(binding), fingerprint('frozen', request.body.frozen));
        record = newRecord(binding, request.body.frozen);
        reserveCapacity(context, LIMITS.record);
        const result = terminalize(request, ledger, record, context, 'aborted', 'missing_reservation');
        result.reservation_bytes = String(LIMITS.record); return result;
      }
      if (record) {
        const reusedId = record.retries.find(r => r.operation_id === request.operation_id);
        if (reusedId) requireThat(reusedId.operation === op && reusedId.request_digest === fingerprint('retry-body', request), 'conflict');
        const earlier = record.retries.find(r => r.operation === op);
        if (earlier) {
          if (op === 'activation.record') reader(binding, context); else rights(binding, context);
          requireThat(earlier.body_digest === bodyDigest(request), 'conflict');
          return { valid: true, kind: 'retry', errors: [], receipt: receiptFor(record, op), status: status(request, record, context, ledger) };
        }
        if (record.terminal) {
          if (op === 'activation.record') { /* Application has its own revision after an immutable decision. */ }
          else { rights(binding, context); requireThat(['commit', 'abort', 'reserve'].includes(op), 'conflict'); return { valid: true, kind: 'terminal', errors: [], receipt: record.terminal, status: status(request, record, context, ledger) }; }
        }
      }
      if (op !== 'activation.record') requireThat(!uncertain(binding.provenance, context, ledger), 'recovery_hold');
      if (op !== 'activation.record') {
        requireThat(binding.relay_recovery_generation === context.recovery_generation, 'recovery_hold');
        rights(binding, context);
      }
      if (op === 'reserve') {
        requireThat(record === null, 'conflict');
        requireThat(ledger !== null && ledger.state === 'available', ledger?.state === 'reserved' || ledger?.state === 'ceded' ? 'conflict' : 'recovery_hold');
        requireThat(request.expected_revision === '0' && request.body.expected_ledger_revision === ledger.revision, 'stale_revision');
        requireThat(exactInteger(binding.epoch) > exactInteger(ledger.high_epoch), 'stale_epoch');
        const p = producer(binding, context); producer(binding, context, true);
        requireThat(request.body.frozen.binding_digest === bindingDigest(binding), 'conflict');
        proof(request, context, p, 'source_frozen', bindingDigest(binding), fingerprint('frozen', request.body.frozen));
        reserveCapacity(context, LIMITS.record);
        record = newRecord(binding, request.body.frozen);
        record.reserve_receipt = envelope('step_receipt', { receipt_id: context.receipt_id, operation: 'reserve', transfer_id: binding.transfer_id, binding_digest: bindingDigest(binding), subject_digest: fingerprint('frozen', record.frozen), previous_revision: '0', revision: '1', phase: 'reserved' });
        record.retries.push(retryEntry(request));
        ledger.revision = increment(ledger.revision); ledger.high_epoch = binding.epoch; ledger.state = 'reserved'; ledger.active_transfer_id = binding.transfer_id;
        return mutation(ledger, record, record.reserve_receipt, LIMITS.record);
      }
      requireThat(record !== null, 'not_found');
      requireThat(request.expected_revision === record.revision, 'stale_revision');
      if (op === 'abort') return terminalize(request, ledger, record, context, 'aborted', request.body.reason);
      if (op === 'activation.record') {
        requireThat(record.phase === 'committed' && record.terminal !== null, 'conflict');
        const actor = currentActor(sourceOf(binding).account_id, context);
        const access = context.accesses.find(a => a.instance_id === binding.target_instance_id);
        requireThat(access && access.account_id === actor.account_id && access.session_id === actor.session_id && access.revision === actor.target_access_revision && ['supervise', 'respond'].every(p => access.permissions.includes(p)), 'forbidden');
        requireThat(context.supported_context_contracts.includes(record.manifest.content_contract_sha256), 'unsupported_context');
        const activation = request.body.activation;
        requireThat(activation.receipt_id === context.receipt_id && activation.transfer_id === binding.transfer_id && activation.terminal_digest === fingerprint('terminal', record.terminal) && activation.target_instance_id === binding.target_instance_id && activation.target_conversation_id === record.prepared.target_conversation_id && activation.prepared_digest === fingerprint('prepared', record.prepared), 'conflict');
        proof(request, context, producer(binding, context, true, true), 'target_activated', bindingDigest(binding), fingerprint('activation', activation), fingerprint('terminal', record.terminal));
        record.activation = structuredClone(activation); record.revision = increment(record.revision); record.retries.push(retryEntry(request));
        return mutation(ledger, record, activation);
      }
      producer(binding, context); producer(binding, context, true);
      if (op === 'seal') {
        requireThat(record.phase === 'reserved', 'conflict');
        requireThat(context.supported_context_contracts.includes(request.body.manifest.content_contract_sha256), 'unsupported_context');
        proof(request, context, producer(binding, context), 'source_sealed', bindingDigest(binding), fingerprint('manifest', request.body.manifest), fingerprint('frozen', record.frozen));
        const receipt = stepReceipt(request, record, context, 'sealed');
        record.manifest = structuredClone(request.body.manifest); record.seal_receipt = receipt; record.phase = 'sealed'; record.revision = receipt.revision; record.retries.push(retryEntry(request));
        return mutation(ledger, record, receipt);
      }
      if (op === 'ready') {
        requireThat(record.phase === 'sealed' && context.supported_context_contracts.includes(record.manifest.content_contract_sha256), 'unsupported_context');
        proof(request, context, producer(binding, context, true), 'target_pinned', bindingDigest(binding), fingerprint('prepared', request.body.prepared), fingerprint('manifest', record.manifest));
        const receipt = stepReceipt(request, record, context, 'target_ready');
        record.prepared = structuredClone(request.body.prepared); record.ready_receipt = receipt; record.phase = 'target_ready'; record.revision = receipt.revision; record.retries.push(retryEntry(request));
        return mutation(ledger, record, receipt);
      }
      requireThat(op === 'commit' && record.phase === 'target_ready', 'conflict');
      requireThat(context.supported_context_contracts.includes(record.manifest.content_contract_sha256), 'unsupported_context');
      proof(request, context, producer(binding, context), 'source_maintained', bindingDigest(binding), fingerprint('frozen', record.frozen), fingerprint('manifest', record.manifest));
      proof(request, context, producer(binding, context, true), 'target_maintained', bindingDigest(binding), fingerprint('prepared', record.prepared), fingerprint('prepared', record.prepared));
      return terminalize(request, ledger, record, context, 'committed', null);
    } catch (error) { return caught(error); }
  }
  /** Adapter-only maintenance. It grants no consumer authority. Apply all affected
   * plans and the revocation/restore marker in ONE transaction before emission. */
  function planMaintenance(ledger, record, context, reason) {
    try {
      contextRules(context); assertObject(ledger, 'ledger'); assertObject(record, 'record');
      authorityOrigin(record.binding.provenance, context); sameLedger(record.binding, ledger);
      requireThat(['session_invalidated', 'access_changed', 'producer_changed', 'account_revoked', 'operator_cancelled', 'restore_uncertain'].includes(reason));
      if (record.terminal) return { valid: true, kind: 'terminal', errors: [], receipt: record.terminal, status: status({ body: { binding: record.binding } }, record, context, ledger) };
      ledger = structuredClone(ledger); record = structuredClone(record);
      requireThat(ledger.active_transfer_id === record.binding.transfer_id, 'conflict');
      if (reason === 'restore_uncertain' || uncertain(record.binding.provenance, context, ledger)) {
        if (record.phase !== 'recovery_hold') { record.hold_phase = record.phase; record.phase = 'recovery_hold'; record.revision = increment(record.revision); }
        if (ledger.state !== 'recovery_hold') { ledger.state = 'recovery_hold'; ledger.hold_reason = 'relay_restore'; ledger.revision = increment(ledger.revision); }
        return mutation(ledger, record, null);
      }
      const request = { operation: 'abort', operation_id: context.receipt_id, expected_revision: record.revision, transfer_id: record.binding.transfer_id, body: { reason } };
      return terminalize(request, ledger, record, context, 'aborted', reason);
    } catch (error) { return caught(error); }
  }
  function expectationRules(expected) {
    bindingRules(expected.binding);
    const digest = bindingDigest(expected.binding);
    requireThat(expected.frozen.binding_digest === digest, 'conflict');
    if (expected.manifest) requireThat(expected.manifest.binding_digest === digest && expected.manifest.frozen_digest === fingerprint('frozen', expected.frozen) && expected.manifest.source_revision === expected.frozen.content_revision, 'conflict');
    if (expected.prepared) requireThat(expected.manifest !== null && expected.prepared.binding_digest === digest && expected.prepared.manifest_digest === fingerprint('manifest', expected.manifest) && expected.prepared.lineage_id !== expected.binding.provenance.lineage_id && expected.prepared.target_conversation_id !== sourceOf(expected.binding).source_conversation_id, 'conflict');
    if (expected.terminal) matchTerminal(expected.terminal, expected);
  }
  function matchTerminal(terminal, expected) {
    assertObject(terminal, 'terminal');
    const b = expected.binding;
    requireThat(terminal.transfer_id === b.transfer_id && same(terminal.source, sourceOf(b)) && terminal.epoch === b.epoch && terminal.target_instance_id === b.target_instance_id && terminal.binding_digest === bindingDigest(b) && terminal.frozen_digest === fingerprint('frozen', expected.frozen), 'conflict');
    if (terminal.outcome === 'committed') {
      requireThat(terminal.prepared.lineage_id !== b.provenance.lineage_id, 'conflict');
      if (expected.manifest) requireThat(terminal.manifest_digest === fingerprint('manifest', expected.manifest), 'conflict');
      if (expected.prepared) requireThat(same(terminal.prepared, expected.prepared), 'conflict');
    }
    if (expected.terminal) requireThat(same(terminal, expected.terminal), 'conflict');
  }
  function receptionExpectation(request, independent) {
    let expected = independent;
    if (request.body.binding) {
      if (expected !== undefined) {
        assertObject(expected, 'expectation');
        requireThat(same(expected.binding, request.body.binding) && same(expected.frozen, request.body.frozen), 'conflict');
      } else expected = { binding: request.body.binding, frozen: request.body.frozen, manifest: null, prepared: null, terminal: null };
    }
    requireThat(expected !== undefined);
    assertObject(expected, 'expectation'); expected = structuredClone(expected);
    requireThat(request.transfer_id === expected.binding.transfer_id, 'conflict');
    if (request.operation === 'seal') {
      if (expected.manifest) requireThat(same(expected.manifest, request.body.manifest), 'conflict');
      expected.manifest = request.body.manifest;
    }
    if (request.operation === 'ready') {
      requireThat(expected.manifest !== null);
      if (expected.prepared) requireThat(same(expected.prepared, request.body.prepared), 'conflict');
      expected.prepared = request.body.prepared;
    }
    if (['commit', 'activation.record'].includes(request.operation)) requireThat(expected.manifest !== null && expected.prepared !== null);
    if (request.operation === 'activation.record') {
      requireThat(expected.terminal?.outcome === 'committed');
      activationRules(request.body.activation, expected.terminal);
    }
    expectationRules(expected); return expected;
  }
  function matchStatus(current, expected) {
    assertObject(current, 'status');
    const b = expected.binding;
    requireThat(current.transfer_id === b.transfer_id && same(current.source, sourceOf(b)) && current.epoch === b.epoch, 'conflict');
    if (current.terminal) matchTerminal(current.terminal, expected);
    if (expected.terminal) requireThat(current.terminal !== null && same(current.terminal, expected.terminal), 'conflict');
  }
  /** Receive-time correlation uses independent native journal facts for requests
   * without a full binding. Never derive that expectation from this response. */
  function validateExchange(request, result, independentExpectation) {
    try {
      assertObject(request, 'request');
      requireThat(result?.valid === true && ['mutation', 'retry', 'terminal', 'status', 'source_status'].includes(result.kind));
      const operation = request.operation === 'reconcile' ? request.body.action : request.operation;
      requireThat(Object.hasOwn(consumerKinds, operation) && consumerKinds[operation].includes(result.kind), 'conflict');
      const fields = result.kind === 'mutation' ? ['valid', 'kind', 'errors', 'ledger', 'record', 'receipt', 'reservation_bytes'] : ['retry', 'terminal'].includes(result.kind) ? ['valid', 'kind', 'errors', 'receipt', 'status'] : ['valid', 'kind', 'errors', 'status'];
      requireThat(Reflect.ownKeys(result).length === fields.length && fields.every(key => Object.hasOwn(result, key)) && Array.isArray(result.errors) && result.errors.length === 0);
      if (request.operation === 'reconcile' && request.body.action === 'source_status') {
        requireThat(result.kind === 'source_status'); assertObject(result.status, 'sourceStatus');
        requireThat(same(request.body.provenance, result.status.provenance), 'conflict'); return ok();
      }
      if (request.operation === 'lineage.create') {
        requireThat(['mutation', 'retry'].includes(result.kind)); assertObject(result.receipt, 'birthReceipt');
        if (result.kind === 'retry') requireThat(result.status === null);
        const r = result.receipt;
        requireThat(r.operation_id === request.operation_id && r.request_digest === fingerprint('retry-body', request) && r.mode === request.body.mode && r.provenance_digest === fingerprint('provenance', request.body.provenance), 'conflict');
        if (result.kind === 'mutation') {
          assertObject(result.ledger, 'ledger');
          requireThat(result.record === null && same(result.ledger.provenance, request.body.provenance) && same(result.ledger.birth, r) && result.ledger.state === 'available' && result.ledger.high_epoch === '0' && result.ledger.revision === '1' && result.reservation_bytes === String(LIMITS.ledger), 'conflict');
        }
        return ok();
      }
      const expected = receptionExpectation(request, independentExpectation), b = expected.binding;
      if (result.kind === 'status') {
        requireThat(request.operation === 'reconcile'); matchStatus(result.status, expected); return ok();
      }
      requireThat(result.kind !== 'source_status');
      const r = result.receipt; requireThat(r !== null);
      const receiptType = result.kind === 'terminal' ? 'terminal_receipt'
        : { reserve: 'step_receipt', seal: 'step_receipt', ready: 'step_receipt', commit: 'terminal_receipt', abort: 'terminal_receipt', reconcile: 'terminal_receipt', 'activation.record': 'activation_receipt' }[request.operation];
      requireThat(r.type === receiptType, 'conflict');
      if (r.type === 'terminal_receipt' && result.kind !== 'terminal') requireThat(r.outcome === (request.operation === 'commit' ? 'committed' : 'aborted'), 'conflict');
      if (r.type === 'step_receipt') {
        assertObject(r, 'stepReceipt');
        requireThat(['reserve', 'seal', 'ready'].includes(request.operation) && r.operation === request.operation && r.transfer_id === b.transfer_id && r.binding_digest === bindingDigest(b) && r.previous_revision === request.expected_revision && r.revision === increment(request.expected_revision), 'conflict');
        const subject = request.operation === 'reserve' ? fingerprint('frozen', expected.frozen) : request.operation === 'seal' ? fingerprint('manifest', expected.manifest) : fingerprint('prepared', expected.prepared);
        requireThat(r.subject_digest === subject, 'conflict');
      } else if (r.type === 'terminal_receipt') {
        requireThat(['reserve', 'commit', 'abort', 'reconcile'].includes(request.operation)); matchTerminal(r, expected);
        if (result.kind !== 'terminal') {
          requireThat(r.decision_revision === increment(request.expected_revision), 'conflict');
          if (request.operation === 'abort') requireThat(r.reason === request.body.reason, 'conflict');
          if (request.operation === 'reconcile') requireThat(r.reason === 'missing_reservation', 'conflict');
        }
      } else {
        requireThat(r.type === 'activation_receipt' && request.operation === 'activation.record'); assertObject(r, 'activation');
        requireThat(same(r, request.body.activation), 'conflict'); activationRules(r, expected.terminal);
        requireThat(request.expected_revision === expected.terminal.decision_revision, 'conflict');
      }
      if (['retry', 'terminal'].includes(result.kind)) {
        matchStatus(result.status, expected);
        if (r.type === 'terminal_receipt') requireThat(same(r, result.status.terminal), 'conflict');
        if (r.type === 'activation_receipt') requireThat(same(r, result.status.activation), 'conflict');
        if (r.type === 'step_receipt') {
          const revision = exactInteger(result.status.terminal?.decision_revision ?? result.status.revision);
          const followsStep = result.status.terminal !== null || result.status.phase === 'recovery_hold';
          requireThat(followsStep ? revision > exactInteger(r.revision) : revision >= exactInteger(r.revision), 'conflict');
        }
      }
      if (result.kind === 'mutation') {
        assertObject(result.ledger, 'ledger'); assertObject(result.record, 'record');
        const ledger = result.ledger, record = result.record;
        requireThat(same(ledger.provenance, b.provenance) && same(record.binding, b) && same(record.frozen, expected.frozen) && ledger.high_epoch === b.epoch, 'conflict');
        requireThat(record.revision === increment(request.expected_revision), 'conflict');
        const accepted = record.retries.find(entry => entry.operation === request.operation);
        requireThat(accepted && accepted.operation_id === request.operation_id && accepted.request_digest === fingerprint('retry-body', request) && accepted.body_digest === bodyDigest(request), 'conflict');
        if (expected.manifest) requireThat(same(record.manifest, expected.manifest), 'conflict');
        if (expected.prepared) requireThat(same(record.prepared, expected.prepared), 'conflict');
        if (record.terminal) matchTerminal(record.terminal, expected);
        if (expected.terminal) requireThat(same(record.terminal, expected.terminal), 'conflict');
        requireThat(same(r, receiptFor(record, request.operation)), 'conflict');
        const phase = { reserve: 'reserved', seal: 'sealed', ready: 'target_ready', commit: 'committed', abort: 'aborted', reconcile: 'aborted', 'activation.record': 'committed' }[request.operation];
        requireThat(record.phase === phase, 'conflict');
        if (phase === 'committed') requireThat(ledger.state === 'ceded' && same(ledger.terminal, record.terminal), 'conflict');
        else if (phase === 'aborted') requireThat(ledger.state === 'available', 'conflict');
        else requireThat(ledger.state === 'reserved' && ledger.active_transfer_id === b.transfer_id, 'conflict');
        requireThat(result.reservation_bytes === String(['reserve', 'reconcile'].includes(request.operation) ? LIMITS.record : 0), 'conflict');
      }
      return ok();
    } catch (error) { return caught(error); }
  }
  function decodeDecision(raw, definition) {
    try {
      requireThat(typeof raw === 'string');
      const limit = definition === 'record' ? LIMITS.record : definition === 'ledger' ? LIMITS.ledger : definition === 'terminal' ? LIMITS.terminal : LIMITS.envelope;
      requireThat(raw.length <= limit && new TextEncoder().encode(raw).byteLength <= limit, 'resource_limit');
      const value = parseStoredJsonStrict(raw); assertObject(value, definition);
      return { valid: true, errors: [], value };
    } catch (error) { return caught(error); }
  }
  return { validateObject, decodeDecision, validateExchange, validateProducerAttestation, planDecision, planMaintenance };
}

const directory = new URL('./', import.meta.url);
const registry = parseStoredJsonStrict(readFileSync(new URL('transfer-decision-schema-set.json', directory), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: false });
for (const resource of registry.resources) {
  const schema = parseStoredJsonStrict(readFileSync(new URL(resource.path, directory), 'utf8'));
  if (schema.$id !== resource.id) throw new Error('Decision schema identity mismatch');
  ajv.addSchema(schema);
}
export const { validateObject, decodeDecision, validateExchange, validateProducerAttestation, planDecision, planMaintenance } = createTransferDecisionValidator((value, definition) => {
  const schema = ajv.getSchema(definition ? `${registry.root}#/$defs/${definition}` : registry.root);
  return typeof schema === 'function' && schema(value);
});
