import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeRun030 } from './observe-run030';
import { compareObserved030 } from './compare-observed030';

// Native evidence stays outside the public repository. Every mutation edits a
// disposable copy; the source files and their reference projections are hashed.
const referenceDir = process.env.MACRO_AGSDL030_R6_REFERENCE_DIR;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function copyRun(name = 'join-all') {
  const directory = mkdtempSync(join(tmpdir(), 'agsdl-r6-observer-')); directories.push(directory);
  const source = join(referenceDir!, `${name}-scenario-delete.sqlite`), path = join(directory, 'run.sqlite'), before = hash(source);
  copyFileSync(source, path);
  const db = new Database(path);
  // The immutable triggers protect the writer. Audit mutations deliberately
  // bypass them on this copy to test the independent durable reader.
  for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>) db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  const run = db.query('SELECT system_id,invocation_id,state_json,plan_json FROM engine_flow030_runs').get() as Record<string, string>;
  const state = JSON.parse(run.state_json), plan = JSON.parse(run.plan_json);
  const events = db.query('SELECT event_id,event_json FROM engine_flow030_events ORDER BY rowid').all() as Array<{ event_id: string; event_json: string }>;
  const saveEvent = (id: string, event: any) => {
    const wire = JSON.stringify(event); state.events[id].eventJson = wire;
    db.query('UPDATE engine_flow030_events SET event_json=? WHERE event_id=?').run(wire, id);
  };
  const observe = () => {
    db.query('UPDATE engine_flow030_runs SET state_json=?,plan_json=?').run(JSON.stringify(state), JSON.stringify(plan)); db.close();
    try { return observeRun030(path, run.system_id, run.invocation_id); }
    finally { expect(hash(source)).toBe(before); }
  };
  return { db, state, plan, events, saveEvent, observe };
}

describe.skipIf(!referenceDir || !process.env.MACRO_AGSDL030_REPLAY_COMMAND)('real R6 native evidence', () => {
  test('compares all fifteen native runs on copies with zero diagnostics', async () => {
    const names = readdirSync(referenceDir!).filter((n) => n.endsWith('-scenario-delete.sqlite')).sort(); expect(names).toHaveLength(15);
    for (const file of names) {
      const directory = mkdtempSync(join(tmpdir(), 'agsdl-r6-baseline-')); directories.push(directory);
      const source = join(referenceDir!, file), copy = join(directory, file), before = hash(source); copyFileSync(source, copy);
      const name = file.slice(0, -'-delete.sqlite'.length), reference = join(referenceDir!, `${name}-observed.json`), referenceHash = hash(reference);
      const compared = await compareObserved030(join(referenceDir!, `${name}-native-result.json`), copy);
      expect(compared.diagnostics).toEqual([]);
      expect(Buffer.from(compared.observedJson)).toEqual(readFileSync(reference));
      expect(hash(source)).toBe(before); expect(hash(copy)).toBe(before); expect(hash(reference)).toBe(referenceHash);
    }
  });
  test.each(['detached-producer-path', 'physical-not-joined', 'missing-native-preparations', 'premature-run-ended', 'failed-flag', 'group-origin'])('rejects the independent audit mutation: %s', (mutation) => {
    const n = copyRun(), security = n.state.activations.find((a: any) => a.step.join('/') === 'security'), performance = n.state.activations.find((a: any) => a.step.join('/') === 'performance');
    if (mutation === 'detached-producer-path') security.context = performance.context;
    if (mutation === 'physical-not-joined') for (const row of n.events) {
      const event = JSON.parse(row.event_json); if (event.kind.WorkResult?.work.activationId === security.id) { event.kind.WorkResult.physical.descendants_joined = false; n.saveEvent(row.event_id, event); }
    }
    if (mutation === 'missing-native-preparations') n.db.exec('DELETE FROM engine_flow030_occurrence_provenance; DELETE FROM engine_flow030_preparations');
    if (mutation === 'failed-flag') n.state.paths[0].memberships[0].failed = true;
    if (mutation === 'group-origin') n.state.groups[0].originActivationId = performance.id;
    if (mutation === 'premature-run-ended') {
      const row = n.db.query("SELECT effect_id,event_id,effect_json FROM engine_flow030_outbox WHERE json_extract(effect_json,'$.kind.kind')='runEnded'").get() as Record<string, string>;
      const first = n.events[0].event_id, effect = JSON.parse(row.effect_json);
      n.state.events[row.event_id].receipt.effectIds = n.state.events[row.event_id].receipt.effectIds.filter((id: string) => id !== row.effect_id);
      n.state.events[first].receipt.effectIds.push(row.effect_id);
      for (const id of [row.event_id, first]) n.db.query('UPDATE engine_flow030_events SET receipt_json=? WHERE event_id=?').run(JSON.stringify(n.state.events[id].receipt), id);
      effect.revision = n.state.events[first].receipt.revision;
      n.db.query('UPDATE engine_flow030_outbox SET event_id=?,effect_json=? WHERE effect_id=?').run(first, JSON.stringify(effect), row.effect_id);
    }
    expect(n.observe).toThrow();
  });
  test.each(['membership-result', 'producer-result', 'join-result', 'instance', 'missing-start', 'orphan-activation', 'run-verdict', 'unknown-preparation-owner', 'event-copy', 'accepted-terminal', 'producer-input'])('rejects previous audit contradictions on a real run: %s', (mutation) => {
    const n = copyRun(), a = n.state.activations.find((a: any) => a.step.join('/') === 'security'), group = n.state.groups[0], membership = n.state.paths[0].memberships[0];
    if (mutation === 'membership-result') membership.resultJson = '{"text":"Forged."}';
    if (mutation === 'producer-result') membership.producer.outputJson = membership.resultJson = '{"text":"Forged."}';
    if (mutation === 'producer-input') membership.producer.inputJson = '{"text":"Forged."}';
    if (mutation === 'join-result') { group.outputJson = '{"outcome":"done","branches":{}}'; n.state.activations.find((a: any) => a.id === group.activationId).result.outputJson = group.outputJson; }
    if (mutation === 'instance') a.instanceId = 'unknown';
    if (mutation === 'missing-start') a.startEffectId = 'unknown';
    if (mutation === 'orphan-activation') n.state.activations.push({ ...a, id: 'orphan', startEffectId: null, result: null });
    if (mutation === 'run-verdict') n.db.exec("UPDATE engine_flow030_outbox SET effect_json=json_set(effect_json,'$.kind.verdict','failed') WHERE json_extract(effect_json,'$.kind.kind')='runEnded'");
    if (mutation === 'unknown-preparation-owner') n.db.exec("UPDATE engine_flow030_outbox SET effect_json=json_set(effect_json,'$.kind.reference.activationId','unknown') WHERE json_extract(effect_json,'$.kind.kind')='prepareRoute'");
    if (mutation === 'event-copy') n.db.exec("UPDATE engine_flow030_events SET event_json=json_set(event_json,'$.kind.WorkResult.result.Failed',json('{\"error\":{\"code\":\"APPROVAL_TIMEOUT\"}}')) WHERE json_type(event_json,'$.kind.WorkResult')='object'");
    if (mutation === 'accepted-terminal') for (const row of n.events) { const e = JSON.parse(row.event_json); if (e.kind.WorkResult?.work.activationId === a.id) { e.kind.WorkResult.result = { Failed: { error: { code: 'APPROVAL_TIMEOUT' } } }; n.saveEvent(row.event_id, e); } }
    expect(n.observe).toThrow();
  });
  test.each(['physical-end-proof', 'stop-binding', 'stop-receipt-work', 'stop-receipt-event', 'stop-receipt-owner', 'false-error-route'])('rejects contradictory real branch-stop evidence: %s', (mutation) => {
    const n = copyRun('join-branch-failed');
    const stopped = n.state.activations.find((a: any) => a.stopEffectId);
    if (mutation === 'physical-end-proof') for (const row of n.events) { const e = JSON.parse(row.event_json); if (e.kind.PhysicalEnded) { e.kind.PhysicalEnded.evidence.descendants_joined = false; n.saveEvent(row.event_id, e); } }
    if (mutation === 'stop-binding') stopped.stopEffectId = 'unknown';
    const receiptField = { 'stop-receipt-work': 'startEffectId', 'stop-receipt-event': 'eventId', 'stop-receipt-owner': 'ownerEpoch' }[mutation];
    if (receiptField) n.db.query(`UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.${receiptField}','unknown') WHERE json_extract(effect_json,'$.kind.kind')='stopWork'`).run();
    if (mutation === 'false-error-route') n.db.exec("UPDATE engine_flow030_outbox SET effect_json=json_set(effect_json,'$.kind.counted',json('false')) WHERE json_extract(effect_json,'$.kind.activationId')=(SELECT json_extract(state_json,'$.groups[0].activationId') FROM engine_flow030_runs) AND json_extract(effect_json,'$.kind.kind')='failure'");
    expect(n.observe).toThrow();
  });
  test.each(['prepare_id', 'owner_epoch', 'generation', 'native_receipt_id', 'reference_json', 'producer_json', 'source_json', 'content_receipts_json', 'result_json'])('cross-checks native preparation column %s', (column) => {
    const n = copyRun(), value = column.endsWith('_json') ? '{}' : 'unknown';
    n.db.query(`UPDATE engine_flow030_preparations SET ${column}=? WHERE rowid=(SELECT min(rowid) FROM engine_flow030_preparations)`).run(value); expect(n.observe).toThrow();
  });
  test.each(['native_receipt_id', 'target_ordinal', 'item_index', 'provenance_json'])('cross-checks native occurrence column %s', (column) => {
    const n = copyRun(); n.db.query(`UPDATE engine_flow030_occurrence_provenance SET ${column}=? WHERE rowid=(SELECT min(rowid) FROM engine_flow030_occurrence_provenance)`).run(column === 'target_ordinal' ? 99 : column === 'item_index' ? '99' : column === 'provenance_json' ? '{}' : 'unknown'); expect(n.observe).toThrow();
  });
  test('requires the physical slot to be free before a deferred fanout Start', () => {
    const n = copyRun('fanout-one-at-a-time');
    const first = n.state.activations.find((a: any) => a.step.join('/') === 'try');
    const row = n.events.find((row) => JSON.parse(row.event_json).kind.WorkResult?.work.activationId === first.id)!;
    const e = JSON.parse(row.event_json); e.kind.WorkResult.physical = null; n.saveEvent(row.event_id, e);
    expect(n.observe).toThrow();
  });
  test.each(['outbox-owner', 'handoff-owner', 'handoff-generation', 'foreign-physical-receipt', 'failed-flag-reverse', 'content-without-context', 'unhandled-verdict', 'start-input'])('rejects contradictory native metadata: %s', (mutation) => {
    const n = copyRun(mutation === 'failed-flag-reverse' ? 'join-branch-failed' : 'join-all');
    if (mutation === 'outbox-owner') n.db.exec("UPDATE engine_flow030_outbox SET owner_epoch='unknown'");
    if (mutation === 'handoff-owner') n.db.exec("UPDATE engine_flow030_handoffs SET owner_epoch='unknown'");
    if (mutation === 'handoff-generation') n.db.exec("UPDATE engine_flow030_handoffs SET generation='unknown'");
    if (mutation === 'foreign-physical-receipt') for (const row of n.events) { const e = JSON.parse(row.event_json); if (e.kind.WorkResult?.physical) { e.kind.WorkResult.physical.native_receipt_id = 'physical:foreign'; n.saveEvent(row.event_id, e); break; } }
    if (mutation === 'failed-flag-reverse') n.state.paths.find((p: any) => p.memberships.some((m: any) => m.failed)).memberships[0].failed = false;
    if (mutation === 'content-without-context') n.db.exec("UPDATE engine_flow030_preparations SET content_receipts_json=json_set(content_receipts_json,'$.occurrences',json('[{}]'))");
    if (mutation === 'unhandled-verdict') n.state.unhandledFailure = true;
    if (mutation === 'start-input') n.db.exec("UPDATE engine_flow030_outbox SET effect_json=json_set(effect_json,'$.kind.inputJson','{}') WHERE json_extract(effect_json,'$.kind.kind')='start'");
    expect(n.observe).toThrow();
  });
  test.each(['ended', 'excluded'])('rejects an injected consumed steer to a real %s target', (condition) => {
    const n = copyRun(condition === 'ended' ? 'join-all' : 'wait-group-closes');
    const target = n.state.activations.find((a: any) => a.step.join('/') === (condition === 'ended' ? 'security' : 'performance'));
    const checkpoint = n.events.find((row) => JSON.parse(row.event_json).kind.WorkResult?.work.activationId === (condition === 'ended' ? target.id : n.state.activations.find((a: any) => a.step.join('/') === 'security').id))!.event_id;
    const work = { activationId: target.id, startEffectId: target.startEffectId, agentInstanceId: target.instanceId };
    n.state.activations.push({ ...target, id: 'forged-delivery', startEffectId: null, stopEffectId: null, result: null, context: [], itemJson: null, occurrence: null, messageJson: '{}' });
    const effect = { id: 'forged-steer', identity: n.state.identity, revision: n.state.events[checkpoint].receipt.revision, kind: { kind: 'steer', work, deliveryActivationId: 'forged-delivery', messageJson: '{}' } };
    const settlement = { kind: 'nativeSteerConsumed030', effectId: effect.id, deliveryActivationId: 'forged-delivery', work, messageJson: '{}', consumedAfterEventId: checkpoint };
    n.state.events[checkpoint].receipt.effectIds.push(effect.id);
    n.db.query('UPDATE engine_flow030_events SET receipt_json=? WHERE event_id=?').run(JSON.stringify(n.state.events[checkpoint].receipt), checkpoint);
    const last = n.db.query('SELECT max(rowid) AS n FROM engine_flow030_outbox').get() as { n: number };
    n.db.query("UPDATE engine_flow030_outbox SET rowid=? WHERE json_extract(effect_json,'$.kind.kind')='runEnded'").run(last.n + 2);
    n.db.query('INSERT INTO engine_flow030_outbox(rowid,system_id,invocation_id,effect_id,event_id,effect_json,owner_epoch,status,settlement_json) VALUES (?,?,?,?,?,?,?,?,?)').run(last.n + 1, n.state.identity.systemStartId, n.state.identity.flowInvocationId, effect.id, checkpoint, JSON.stringify(effect), '0', 'settled', JSON.stringify(settlement));
    expect(n.observe).toThrow();
  });
  test('rejects a group StopWork caused by the physical end of its own target', () => {
    const n = copyRun('join-branch-failed');
    const row = n.db.query("SELECT effect_id,event_id,effect_json FROM engine_flow030_outbox WHERE json_extract(effect_json,'$.kind.kind')='stopWork'").get() as Record<string, string>;
    const target = n.events.find((row) => JSON.parse(row.event_json).kind.PhysicalEnded)!.event_id;
    n.state.events[row.event_id].receipt.effectIds = n.state.events[row.event_id].receipt.effectIds.filter((id: string) => id !== row.effect_id);
    n.state.events[target].receipt.effectIds.unshift(row.effect_id);
    for (const id of [row.event_id, target]) n.db.query('UPDATE engine_flow030_events SET receipt_json=? WHERE event_id=?').run(JSON.stringify(n.state.events[id].receipt), id);
    const effect = JSON.parse(row.effect_json); effect.revision = n.state.events[target].receipt.revision;
    n.db.query('UPDATE engine_flow030_outbox SET event_id=?,effect_json=? WHERE effect_id=?').run(target, JSON.stringify(effect), row.effect_id);
    expect(n.observe).toThrow();
  });
  test('rejects an accepted result after a real group cancellation, with a consistent appended journal', () => {
    const n = copyRun('join-branch-failed'), a = n.state.activations.find((a: any) => a.stopEffectId);
    const id = 'forged-late-result', revision = (BigInt(n.state.revision) + 1n).toString();
    const result = { kind: 'completed', outputJson: '{"text":"Too late."}', routeKey: null }; a.result = result;
    const event = { identity: n.state.identity, eventId: id, expectedRevision: n.state.revision, kind: { WorkResult: { work: { activationId: a.id, startEffectId: a.startEffectId, agentInstanceId: a.instanceId }, result: { Completed: { output_json: result.outputJson, route_key: null } }, physical: null } } };
    const end = n.db.query("SELECT effect_id,event_id,effect_json FROM engine_flow030_outbox WHERE json_extract(effect_json,'$.kind.kind')='runEnded'").get() as Record<string, string>;
    n.state.events[end.event_id].receipt.effectIds = n.state.events[end.event_id].receipt.effectIds.filter((effectId: string) => effectId !== end.effect_id);
    n.db.query('UPDATE engine_flow030_events SET receipt_json=? WHERE event_id=?').run(JSON.stringify(n.state.events[end.event_id].receipt), end.event_id);
    const receipt = { eventId: id, revision, effectIds: [end.effect_id] }, wire = JSON.stringify(event);
    n.state.events[id] = { eventJson: wire, receipt }; n.state.revision = revision;
    n.db.query('INSERT INTO engine_flow030_events(system_id,invocation_id,event_id,event_json,receipt_json,diagnostic_json) VALUES (?,?,?,?,?,NULL)').run(n.state.identity.systemStartId, n.state.identity.flowInvocationId, id, wire, JSON.stringify(receipt));
    const effect = JSON.parse(end.effect_json); effect.revision = revision;
    n.db.query('UPDATE engine_flow030_outbox SET event_id=?,effect_json=? WHERE effect_id=?').run(id, JSON.stringify(effect), end.effect_id);
    expect(n.observe).toThrow();
  });
  // R6 has no admitted approvals. Inject forged broker evidence on a real copy
  // as an additional negative test; this does not qualify a native human run.
  test.each(['personal-terminal', 'revoked-terminal'])('rejects injected approval evidence on a real copy: %s', (mutation) => {
    const n = copyRun(), a = n.state.activations.find((a: any) => a.step.join('/') === 'security');
    const step = n.plan.steps.find((s: any) => s.address.join('/') === 'security');
    step.type = 'approval'; step.declarationJson = '{"type":"approval","next":{"ok":[]}}';
    const work = { activationId: a.id, startEffectId: a.startEffectId, agentInstanceId: a.instanceId };
    // Replace the empty native schema only in this deliberately forged copy.
    n.db.exec('DROP TABLE IF EXISTS engine_flow030_human_requests');
    n.db.exec('CREATE TABLE engine_flow030_human_requests(system_id TEXT,invocation_id TEXT,request_id TEXT,request_kind TEXT,work_refs_json TEXT,status TEXT,resolution_json TEXT,delivery_status TEXT)');
    const answer = { choice: 'ok', comment: 'Checked.' };
    a.result = { kind: 'completed', outputJson: JSON.stringify({ ...answer, message: JSON.parse(a.messageJson) }), routeKey: 'ok' };
    const resolution = { reason: 'person', answerJson: JSON.stringify(answer), approvalTiming: { openedAtMs: '0', resolvedAtMs: '0', timeoutMs: null } };
    n.db.query('INSERT INTO engine_flow030_human_requests VALUES (?,?,?,?,?,?,?,?)').run(n.state.identity.systemStartId, n.state.identity.flowInvocationId, 'forged-request', 'approval', JSON.stringify([work]), mutation === 'revoked-terminal' ? 'revoked' : 'resolved', mutation === 'revoked-terminal' ? null : JSON.stringify(resolution), mutation === 'revoked-terminal' ? 'revoked' : 'delivered');
    if (mutation === 'personal-terminal') for (const row of n.events) { const e = JSON.parse(row.event_json); if (e.kind.WorkResult?.work.activationId === a.id) { e.kind.WorkResult.result = { Failed: { error: { code: 'APPROVAL_TIMEOUT' } } }; n.saveEvent(row.event_id, e); } }
    expect(n.observe).toThrow();
  });
});
