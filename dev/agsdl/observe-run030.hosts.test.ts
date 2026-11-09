import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateHostHumanClock030 } from '../../src/services/agsdlExecution/hostHumanClock030';
import { parse } from '../../src/vendor/agsdl/v0.3/json.mjs';
import { observeRun030, verifyNativeCallsAndClock030, type EffectRow030, type EventRow030 } from './observe-run030';

const referenceDir = process.env.MACRO_AGSDL030_R6_REFERENCE_DIR;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v !== null && typeof v === 'object'
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agsdl-host-evidence-')), path = join(directory, 'run.sqlite'), source = join(referenceDir!, 'join-all-scenario-delete.sqlite');
  const originals = ['', '-wal', '-shm'].filter((ext) => existsSync(source + ext)).map((ext) => ({ path: source + ext, digest: sha(readFileSync(source + ext)) }));
  for (const ext of ['', '-wal', '-shm']) if (existsSync(source + ext)) copyFileSync(source + ext, path + ext);
  const db = new Database(path); db.exec('PRAGMA foreign_keys=OFF'); let open = true;
  const close = () => { if (open) { db.close(); open = false; } };
  cleanups.push(() => { close(); for (const original of originals) expect(sha(readFileSync(original.path))).toBe(original.digest); rmSync(directory, { recursive: true, force: true }); });
  const run = db.query('SELECT * FROM engine_flow030_runs').get() as any, state = JSON.parse(run.state_json), plan = JSON.parse(run.plan_json);
  const owner = db.query('SELECT * FROM engine_flow030_owners').get() as any;
  const mutable = () => { for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>) db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`); };
  return { db, state, plan, owner, mutable, observe: () => { close(); return observeRun030(path, run.system_id, run.invocation_id); } };
}
type Fixture = ReturnType<typeof fixture>;
// Isolated 039 adapter unit fixture. This deliberately supplies a counterfactual
// flow result to the host checker, and does not qualify a native call scenario.
function callUnit(n: Fixture, form: 'command' | 'mcp' | 'invalid-json' | 'start-failed') {
  n.db.exec(readFileSync(join(import.meta.dir, '../../src-tauri/src/db/migrations/039_execution_call_protocol030.sql'), 'utf8')); n.mutable();
  const effects = n.db.query('SELECT * FROM engine_flow030_outbox ORDER BY rowid').all() as EffectRow030[], journal = n.db.query('SELECT * FROM engine_flow030_events ORDER BY rowid').all() as EventRow030[];
  const row = effects.find((row) => JSON.parse(row.effect_json).kind.kind === 'start')!, effect = JSON.parse(row.effect_json), a = n.state.activations.find((a: any) => a.id === effect.kind.work.activationId);
  const step = n.plan.steps.find((s: any) => JSON.stringify(s.address) === JSON.stringify(a.step));
  const declaration = form === 'mcp' ? { type: 'call', mcp: { server: 'tools', tool: 'lookup' } } : { type: 'call', command: 'printf value', ...(form === 'invalid-json' ? { parse: 'json' } : {}) };
  step.type = 'call'; step.agent = a.agent = null; step.declarationJson = JSON.stringify(declaration); a.instanceId = effect.kind.work.agentInstanceId = null; effect.kind.agent = null;
  row.effect_json = JSON.stringify(effect);
  const id = 'host-call', eventId = `call:${id}:terminal`, nativeId = 'host-call-joined';
  const prepared = form === 'mcp' ? { kind: 'mcp', server: 'tools', tool: 'lookup', argumentsJson: '{}' } : { kind: 'command', command: 'printf value', parse: form === 'invalid-json' ? 'json' : null };
  const event = form === 'mcp' ? { kind: 'toolReturned', isError: false, text: 'Value.', structuredContentJson: null } : form === 'start-failed' ? { kind: 'startFailed' } : { kind: 'commandReceipt', exitCode: 0, stdout: form === 'invalid-json' ? 'invalid{' : 'Value.', stderr: '' };
  const outputJson = JSON.stringify({ outcome: 'passed', data: form === 'mcp' ? 'Value.' : { exitCode: 0, output: 'Value.' } });
  const result = form === 'invalid-json' || form === 'start-failed' ? { kind: 'failed', code: form === 'invalid-json' ? 'OUTPUT_INVALID' : 'CALL_FAILED' } : { kind: 'completed', outputJson };
  const wire = 'code' in result ? { Failed: { error: { code: result.code, message: result.code, details: [] } } } : { Completed: { output_json: outputJson, route_key: 'passed' } };
  const terminal = journal.find((row) => JSON.parse(row.event_json).kind.WorkResult?.work.activationId === a.id)!;
  terminal.event_id = eventId; terminal.event_json = JSON.stringify({ identity: n.state.identity, kind: { WorkResult: { work: effect.kind.work, physical: { native_receipt_id: nativeId, descendants_joined: true }, result: wire } } });
  a.result = 'code' in result ? { kind: 'failed', error: { code: result.code } } : { kind: 'completed', outputJson, routeKey: 'passed' };
  const attempt = { identity: n.state.identity, ownerEpoch: n.owner.owner_epoch, generation: n.owner.generation, callId: id, captureSha256: n.owner.capture_sha256, effect, declarationJson: step.declarationJson };
  const received = { end: { kind: 'returned', event }, physical: { kind: 'syntheticJoined', receiptId: nativeId } }, receipt = { attempt, received, result, eventId };
  const save = () => n.db.query("INSERT OR REPLACE INTO engine_flow030_calls VALUES (?,?,?,?,?,?,'terminal',?,?,?)").run(n.state.identity.systemStartId, n.state.identity.flowInvocationId, a.id, a.startEffectId, id, JSON.stringify(attempt), JSON.stringify(prepared), JSON.stringify(received), JSON.stringify(receipt));
  save();
  const exact = (value: any) => { const result = parse(new TextEncoder().encode(JSON.stringify(value))); if (result.error) throw Error('Invalid unit value'); return result.tree as Parameters<typeof verifyNativeCallsAndClock030>[1]; };
  return { a, terminal, attempt, received, receipt, prepared, save, verify: () => verifyNativeCallsAndClock030(n.db, exact(n.state), exact(n.plan), effects, journal, n.owner) };
}
function addContent(n: Fixture) {
  const p = n.db.query('SELECT * FROM engine_flow030_preparations ORDER BY rowid LIMIT 1').get() as any;
  const batch = JSON.parse(p.result_json).batches[0], item = batch.items[0], recipient = n.plan.steps.find((s: any) => JSON.stringify(s.address) === JSON.stringify(batch.target.address));
  const a = n.state.activations.find((a: any) => JSON.stringify(a.occurrence) === JSON.stringify(item.occurrence));
  const admission = n.db.query('SELECT policy_evidence_json FROM engine_flow030_work_admissions WHERE activation_id=?').get(a.id) as any;
  const policyJson = JSON.stringify(JSON.parse(admission.policy_evidence_json).effectivePolicy);
  const identity = { captureId: n.state.identity.snapshotId, sourceDigest: sha(n.plan.documentJson), agent: recipient.agent, policyDigest: sha(policyJson) };
  const value = JSON.parse(item.messageJson).resources.text.value;
  const sourceJson = JSON.stringify({ value, mediaType: 'text/plain' }), bytes = Buffer.from(value);
  const payload = { kind: 'text', text: value };
  const provenance = { ...identity, usage: 'resource', pointer: '/message/resources/text', sourceJsonDigest: sha(sourceJson), requestedUri: null, finalUri: null, fileParentIdentity: null, declaredMediaType: 'text/plain', observedMediaType: null, mediaType: 'text/plain', sizeBytes: String(bytes.length), sha256: sha(bytes) };
  const native = { payload, provenance };
  const transported = { sourceJson, payload, provenance: { ...identity, usage: provenance.usage, pointer: provenance.pointer, requestedUri: null, mediaType: provenance.mediaType, sha256: provenance.sha256 } };
  const occurrence = { contextId: 'host-content', targetOrdinal: batch.targetOrdinal, itemIndex: item.occurrence.itemIndex, identity, receipts: [transported] };
  n.mutable();
  n.db.query('UPDATE engine_flow030_preparations SET content_receipts_json=? WHERE prepare_id=?').run(JSON.stringify({ format: 'macro-agsdl-route-content/1', occurrences: [occurrence] }), p.prepare_id);
  n.db.query('INSERT INTO engine_flow030_route_content_contexts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(n.state.identity.systemStartId, n.state.identity.flowInvocationId, p.prepare_id, batch.targetOrdinal, item.occurrence.itemIndex, occurrence.contextId, n.owner.owner_epoch, n.owner.generation, n.owner.capture_sha256, JSON.stringify(batch.target.address), recipient.type, recipient.agent, JSON.stringify(identity), policyJson, 'live');
  n.db.query('INSERT INTO engine_flow030_route_content_receipts VALUES (?,?,?,?,?,?,?)').run(n.state.identity.systemStartId, n.state.identity.flowInvocationId, occurrence.contextId, sha(canonical(transported)), sourceJson, JSON.stringify(native), JSON.stringify(transported));
  const save = () => {
    n.db.query('UPDATE engine_flow030_preparations SET content_receipts_json=? WHERE prepare_id=?').run(JSON.stringify({ format: 'macro-agsdl-route-content/1', occurrences: [occurrence] }), p.prepare_id);
    n.db.query('UPDATE engine_flow030_route_content_contexts SET target_ordinal=?,item_index=?,identity_json=? WHERE context_id=?').run(occurrence.targetOrdinal, occurrence.itemIndex, JSON.stringify(occurrence.identity), occurrence.contextId);
    n.db.query('UPDATE engine_flow030_route_content_receipts SET receipt_sha256=?,native_receipt_json=?,transport_receipt_json=? WHERE context_id=?').run(sha(canonical(transported)), JSON.stringify(native), JSON.stringify(transported), occurrence.contextId);
  };
  return { occurrence, transported, native, save };
}
function addClock(n: Fixture, human = false) {
  n.db.exec(readFileSync(join(import.meta.dir, '../../src-tauri/src/db/migrations/040_execution_flow_human_clock030.sql'), 'utf8'));
  const a = n.state.activations.find((a: any) => a.startEffectId), effect = JSON.parse((n.db.query('SELECT effect_json FROM engine_flow030_outbox WHERE effect_id=?').get(a.startEffectId) as any).effect_json);
  const attempt = JSON.parse((n.db.query('SELECT receipt_json FROM engine_flow030_handoffs WHERE effect_id=?').get(a.startEffectId) as any).receipt_json).workAttempt;
  const owner = { systemStartId: n.state.identity.systemStartId, ownerEpoch: n.owner.owner_epoch }, ids = [owner.systemStartId, n.state.identity.flowInvocationId];
  const binding = { identity: n.state.identity, owner, generation: n.owner.generation, reference: effect.kind.work, kind: 'agent', providerAttemptId: attempt.providerAttemptId };
  n.db.query('INSERT INTO engine_flow030_handoff_clock VALUES (?,?,?,?,?,?)').run(...ids, a.startEffectId, n.owner.owner_epoch, n.owner.generation, '0');
  n.db.query('INSERT INTO engine_flow030_clock_works VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...ids, a.id, a.startEffectId, n.owner.owner_epoch, n.owner.generation, 'agent', JSON.stringify(binding), '0', null, null, '{}', 0);
  let stateJson = '', revision = '0', last: any;
  const events: Array<{ id: string; body: any; output: any }> = [];
  const dispatch = (body: any, nowMs: string) => {
    const id = `host-clock-${events.length}`, eventJson = JSON.stringify({ owner, eventId: id, nowMs, event: body }), optionsJson = '{"maxSliceMs":2147483647}';
    const input = { identity: n.state.identity, owner, eventId: id, expectedRevision: revision, stateJson, eventJson, optionsJson };
    const output = evaluateHostHumanClock030(owner, id, revision, stateJson, eventJson, JSON.parse(optionsJson));
    n.db.query('INSERT INTO engine_flow030_clock_events VALUES (?,?,?,?,?)').run(...ids, id, JSON.stringify(input), JSON.stringify(output));
    stateJson = output.stateJson; revision = String(Number(revision) + 1); last = JSON.parse(output.receiptJson); events.push({ id, body, output });
  };
  dispatch({ kind: 'admit', workId: a.id, timeoutMs: null, answerTimeoutMs: null, startedAtMs: '0' }, '0');
  let resolution: any, proofId: string | undefined;
  if (human) {
    dispatch({ kind: 'open', requestId: 'host-request', requestKind: 'ask', reviewer: 'person', workIds: [a.id] }, '0');
    dispatch({ kind: 'answer', requestId: 'host-request', nativeReceiptId: 'host-submission', answer: { decision: 'no', comment: '' } }, '1');
    resolution = { ...last.pendingResolutions[0], reason: 'answer' }; proofId = events.at(-1)!.id;
    dispatch({ kind: 'ack', requestId: 'host-request' }, '1');
  }
  dispatch({ kind: 'retire', workId: a.id }, '2');
  n.db.query('INSERT INTO engine_flow030_clock VALUES (?,?,?,?,?,?,?,?)').run(...ids, n.owner.owner_epoch, n.owner.generation, revision, stateJson, JSON.stringify(last), '2');
  n.db.query('UPDATE engine_flow030_clock_works SET retired=1,snapshot_json=?').run(JSON.stringify(last.retiredClocks[0].snapshot));
  if (human) {
    const snapshot = last.requests[0];
    n.db.query('INSERT INTO engine_flow030_human_requests VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...ids, 'host-request', 'ask', '1', JSON.stringify(snapshot.workIds), '{}', snapshot.openedAtMs, JSON.stringify({ openedAtMs: snapshot.openedAtMs, timeoutMs: snapshot.answerTimeoutMs }), JSON.stringify(resolution), 'acknowledged');
    n.db.query('INSERT INTO engine_flow030_human_submissions VALUES (?,?,?,?,?,?,?,?)').run(...ids, 'host-submission', 'host-request', '1', 'synthetic-person', '{"kind":"decision","decision":"no","comment":""}', 1);
    n.db.query('INSERT INTO engine_flow030_human_resolution_proofs VALUES (?,?,?,?,?)').run(...ids, 'host-request', proofId, JSON.stringify(resolution));
  }
  n.mutable(); return { a, events, last };
}

describe.skipIf(!referenceDir || !process.env.MACRO_AGSDL030_REPLAY_COMMAND)('host tables after real native replay', () => {
  test('accepts content evidence in the exact native 037 shape, derived from a real R6 run', () => {
    const n = fixture(); addContent(n); expect(n.observe).not.toThrow();
  });
  test.each(['missing-occurrence', 'foreign-capture', 'foreign-source', 'foreign-agent', 'foreign-policy', 'foreign-recipient', 'revoked-context', 'altered-payload', 'rehashed-payload', 'bad-fingerprint'])('refuses forged native content: %s', (mutation) => {
    const n = fixture(), c = addContent(n);
    if (mutation === 'missing-occurrence') { c.occurrence.targetOrdinal = 99; c.occurrence.itemIndex = '99'; }
    if (mutation.startsWith('foreign-') && mutation !== 'foreign-recipient') { const key = { 'foreign-capture': 'captureId', 'foreign-source': 'sourceDigest', 'foreign-agent': 'agent', 'foreign-policy': 'policyDigest' }[mutation]!; (c.occurrence.identity as any)[key] = 'foreign'; }
    if (mutation === 'foreign-recipient') n.db.exec("UPDATE engine_flow030_route_content_contexts SET recipient_agent='foreign'");
    if (mutation === 'revoked-context') n.db.exec("UPDATE engine_flow030_route_content_contexts SET status='revoked'");
    if (mutation === 'altered-payload' || mutation === 'rehashed-payload') c.transported.payload.text = c.native.payload.text = 'Altered.';
    if (mutation === 'rehashed-payload') { c.native.provenance.sha256 = c.transported.provenance.sha256 = sha('Altered.'); c.native.provenance.sizeBytes = String(Buffer.byteLength('Altered.')); }
    c.save(); if (mutation === 'bad-fingerprint') n.db.exec("UPDATE engine_flow030_route_content_receipts SET receipt_sha256='foreign'");
    expect(n.observe).toThrow('Host evidence');
  });
  test.each(['receipt-kind', 'producer-agent', 'instructions', 'work-event'])('refuses forged native source attestation: %s', (mutation) => {
    const n = fixture(); n.mutable();
    if (mutation === 'receipt-kind') n.db.exec("UPDATE engine_flow030_route_source_attestations SET receipt_kind='call' WHERE receipt_kind='agentWork'");
    if (mutation === 'producer-agent' || mutation === 'instructions') {
      const expression = mutation === 'producer-agent' ? "json_set(source_json,'$.producerAgent','foreign')" : "json_set(source_json,'$.provenance.instructions',json('[{}]'))";
      n.db.exec(`UPDATE engine_flow030_route_source_attestations SET source_json=${expression}`);
      n.db.exec('UPDATE engine_flow030_preparations SET source_json=(SELECT source_json FROM engine_flow030_route_source_attestations s WHERE s.prepare_id=engine_flow030_preparations.prepare_id)');
    }
    if (mutation === 'work-event') n.db.exec("UPDATE engine_flow030_route_source_attestations SET work_event_id=(SELECT event_id FROM engine_flow030_work_events e WHERE e.activation_id=json_extract(engine_flow030_route_source_attestations.producer_json,'$.activationId') ORDER BY rowid LIMIT 1) WHERE receipt_kind='agentWork'");
    expect(n.observe).toThrow('Host evidence');
  });
  test('derives 034 prompt provenance from the captured route instead of accepting matching host copies', () => {
    const n = fixture(); n.mutable();
    const row = n.db.query('SELECT prepare_id,native_receipt_id,result_json FROM engine_flow030_preparations ORDER BY rowid LIMIT 1').get() as any;
    const result = JSON.parse(row.result_json), proof = result.provenance[0]; proof.prompt = { kind: 'author', pointer: '/foreign' };
    n.db.query('UPDATE engine_flow030_preparations SET result_json=? WHERE prepare_id=?').run(JSON.stringify(result), row.prepare_id);
    n.db.query('UPDATE engine_flow030_occurrence_provenance SET provenance_json=? WHERE native_receipt_id=? AND target_ordinal=? AND item_index=?').run(JSON.stringify(proof), row.native_receipt_id, proof.occurrence.targetOrdinal, proof.occurrence.itemIndex);
    expect(n.observe).toThrow('prepared message/provenance');
  });
  test('requires the terminal ticket flowRevision to equal its causal flow prefix, even if the forged revision exists', () => {
    const n = fixture(); n.mutable();
    const row = n.db.query("SELECT event_id,ticket_json FROM engine_flow030_work_events WHERE json_extract(ticket_json,'$.input.control')=1 ORDER BY rowid LIMIT 1").get() as any;
    const ticket = JSON.parse(row.ticket_json); ticket.flowRevision = String(BigInt(ticket.flowRevision) + 1n);
    n.db.query('UPDATE engine_flow030_work_events SET ticket_json=? WHERE event_id=?').run(JSON.stringify(ticket), row.event_id);
    expect(n.observe).toThrow('work terminal ticket flow revision');
  });
  test.each([false, true])('accepts native 040 journal and projections, human=%s', (human) => {
    const n = fixture(); addClock(n, human); expect(n.observe).not.toThrow();
  });
  test.each(['clock-ticket', 'clock-snapshot', 'clock-origin', 'clock-binding', 'request-deadline', 'resolution-proof', 'erased-resolution', 'submission-answer', 'submission-arbitration', 'delivery-reservation', 'orphan-control'])('refuses forged 040 evidence: %s', (mutation) => {
    const n = fixture(), c = addClock(n, true);
    const sql: Record<string, string> = {
      'clock-ticket': "UPDATE engine_flow030_clock_events SET ticket_json=json_set(ticket_json,'$.identity.epoch','foreign')",
      'clock-snapshot': "UPDATE engine_flow030_clock_works SET snapshot_json='{}'",
      'clock-origin': "UPDATE engine_flow030_handoff_clock SET started_ms='1'",
      'clock-binding': "UPDATE engine_flow030_clock_works SET work_json=json_set(work_json,'$.reference.activationId','foreign')",
      'request-deadline': "UPDATE engine_flow030_human_requests SET deadline_json='{}'",
      'resolution-proof': 'DELETE FROM engine_flow030_human_resolution_proofs',
      'erased-resolution': "DELETE FROM engine_flow030_human_resolution_proofs; UPDATE engine_flow030_human_requests SET resolution_json=NULL,revision='0',delivery='pending'",
      'submission-answer': "UPDATE engine_flow030_human_submissions SET answer_json='{\"kind\":\"decision\",\"decision\":\"yes\",\"comment\":\"\"}'",
      'submission-arbitration': 'UPDATE engine_flow030_human_submissions SET accepted=0',
      'delivery-reservation': "UPDATE engine_flow030_human_requests SET delivery='reserved'",
    };
    if (mutation === 'orphan-control') n.db.query("INSERT INTO engine_flow030_clock_controls VALUES (?,?,?,?,'TIMEOUT','2',1)").run(n.state.identity.systemStartId, n.state.identity.flowInvocationId, c.a.id, 'forged-timeout');
    else n.db.exec(sql[mutation]);
    expect(n.observe).toThrow('Host evidence');
  });
  test.each(['admission', 'state', 'authorization', 'event', 'check'])('refuses orphan 036 rows: %s', (kind) => {
    const n = fixture(); n.mutable();
    if (kind === 'admission') n.db.exec("INSERT INTO engine_flow030_work_admissions SELECT system_id,invocation_id,'orphan',start_effect_id,owner_epoch,generation,capture_sha256,context_json,contract_json,options_json,policy_evidence_json FROM engine_flow030_work_admissions LIMIT 1");
    if (kind === 'state') n.db.exec("INSERT INTO engine_flow030_work_state SELECT system_id,invocation_id,'orphan',revision,state_json FROM engine_flow030_work_state LIMIT 1");
    if (kind === 'authorization') n.db.exec("INSERT INTO engine_flow030_work_authorizations SELECT system_id,invocation_id,'orphan',activation_id,input_json,NULL,NULL FROM engine_flow030_work_authorizations LIMIT 1");
    if (kind === 'event') n.db.exec("INSERT INTO engine_flow030_work_events SELECT system_id,invocation_id,'orphan',activation_id,ticket_json,decision_json FROM engine_flow030_work_events LIMIT 1");
    if (kind === 'check') n.db.exec("INSERT INTO engine_flow030_work_checks SELECT system_id,invocation_id,'orphan',activation_id,event_id,'{}','ended' FROM engine_flow030_work_events LIMIT 1");
    expect(n.observe).toThrow('Host evidence');
  });
  test.each(['digest', 'material'])('refuses contradictory native 036 policy %s', (kind) => {
    const n = fixture(); n.mutable();
    n.db.exec(kind === 'digest' ? "UPDATE engine_flow030_work_admissions SET policy_evidence_json=json_set(policy_evidence_json,'$.policyDigest','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')"
      : "UPDATE engine_flow030_work_admissions SET policy_evidence_json=json_set(policy_evidence_json,'$.effectivePolicy.current.outside','read')");
    expect(n.observe).toThrow('Host evidence');
  });
  test.each(['call', 'cause', 'diagnostic'])('refuses orphan 039 rows: %s', (kind) => {
    const n = fixture(); n.db.exec(readFileSync(join(import.meta.dir, '../../src-tauri/src/db/migrations/039_execution_call_protocol030.sql'), 'utf8'));
    if (kind === 'call') n.db.query("INSERT INTO engine_flow030_calls VALUES (?,?,?,?,'orphan','{}','reserved',NULL,NULL,NULL)").run(n.state.identity.systemStartId, n.state.identity.flowInvocationId, 'orphan', 'orphan');
    if (kind === 'cause') n.db.exec("INSERT INTO engine_flow030_call_causes VALUES ('orphan','{}')");
    if (kind === 'diagnostic') n.db.query('INSERT INTO engine_flow030_call_diagnostics VALUES (?,?,?,?,?)').run('orphan', n.state.identity.systemStartId, n.state.identity.flowInvocationId, 'orphan', '{}');
    expect(n.observe).toThrow('Host evidence');
  });
  test.each(['command', 'mcp', 'invalid-json', 'start-failed'] as const)('accepts isolated 039 writer shape: %s', (kind) => {
    const n = fixture(), c = callUnit(n, kind); expect(c.verify).not.toThrow();
  });
  test.each(['identity', 'capture', 'declaration', 'prepared', 'raw-return', 'physical', 'event', 'result'])('refuses contradictory isolated 039 evidence: %s', (mutation) => {
    const n = fixture(), c = callUnit(n, 'command');
    if (mutation === 'identity') c.attempt.identity = { ...c.attempt.identity, epoch: 'foreign' };
    if (mutation === 'capture') c.attempt.captureSha256 = 'foreign';
    if (mutation === 'declaration') c.attempt.declarationJson = '{}';
    if (mutation === 'prepared') c.prepared.command = 'foreign';
    if (mutation === 'raw-return') (c.received.end.event as any).stdout = 'Foreign.';
    if (mutation === 'physical') c.received.physical.receiptId = 'foreign';
    if (mutation === 'event') c.receipt.eventId = 'foreign';
    if (mutation === 'result') c.receipt.result = { kind: 'failed', code: 'TIMEOUT' };
    c.save(); expect(c.verify).toThrow();
  });
  test('derives an already prepared call operand from its Start even after a branch stop', () => {
    const n = fixture(), c = callUnit(n, 'command');
    c.a.result = null; c.a.stopEffectId = 'host-stop';
    (c.receipt as any).result = { kind: 'stopped' }; (c.received as any).end = { kind: 'stopped' };
    c.terminal.event_json = JSON.stringify({ identity: n.state.identity, kind: { PhysicalEnded: { work: c.attempt.effect.kind.work, stop_effect_id: c.a.stopEffectId, evidence: { native_receipt_id: c.received.physical.receiptId, descendants_joined: true } } } });
    c.save(); expect(c.verify).not.toThrow();
    c.prepared.command = 'foreign'; c.save(); expect(c.verify).toThrow('call prepared operand');
  });
});
