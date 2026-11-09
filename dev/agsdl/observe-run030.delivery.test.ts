import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareObserved030 } from './compare-observed030';
import { observeRun030 } from './observe-run030';

const referenceDir = process.env.MACRO_AGSDL030_DELIVERY_REFERENCE_DIR;
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// These are snapshots of exited native QA processes, never built from expect.
describe.skipIf(!referenceDir || !process.env.MACRO_AGSDL030_REPLAY_COMMAND)('native delivery evidence', () => {
  test.each(['delivery-queue', 'delivery-steer', 'join-branch-steer'])('%s compares equal after native replay', async (name) => {
    const result = await compareObserved030(join(referenceDir!, `${name}-scenario-native-result.json`), join(referenceDir!, `${name}-scenario-delete.sqlite`));
    expect(result.diagnostics).toEqual([]);
  });

  test.each([
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.kind','nativeSteerSuperseded030') WHERE json_extract(effect_json,'$.kind.kind')='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.consumedEventId','foreign') WHERE json_extract(effect_json,'$.kind.kind')='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.kind','nativeOwnedHandoff030') WHERE json_extract(effect_json,'$.kind.kind')='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.messageJson','{}') WHERE json_extract(effect_json,'$.kind.kind')='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.work.startEffectId','foreign') WHERE json_extract(effect_json,'$.kind.kind')='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.consumedAfterEventId','foreign') WHERE json_extract(effect_json,'$.kind.kind')='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.consumedAfterEventId',(SELECT event_id FROM engine_flow030_events ORDER BY rowid DESC LIMIT 1)) WHERE json_extract(effect_json,'$.kind.kind')='steer'",
    "UPDATE engine_flow030_route_source_attestations SET receipt_kind='agentWork',work_event_id='foreign' WHERE receipt_kind='call'",
    "UPDATE engine_flow030_route_source_attestations SET work_event_id='foreign' WHERE receipt_kind='call'",
    "UPDATE engine_flow030_calls SET receipt_json=json_set(receipt_json,'$.result.outputJson','{}')",
    'DELETE FROM engine_flow030_calls',
  ])('refuses forged delivery or call-source evidence: %s', (sql) => {
    const name = 'join-branch-steer', directory = mkdtempSync(join(tmpdir(), 'agsdl-delivery-evidence-'));
    temporary.push(directory);
    const path = join(directory, 'run.sqlite');
    copyFileSync(join(referenceDir!, `${name}-scenario-delete.sqlite`), path);
    const envelope = JSON.parse(readFileSync(join(referenceDir!, `${name}-scenario-native-result.json`), 'utf8'));
    const { systemStartId, flowInvocationId } = envelope.result.receipt;
    const db = new Database(path);
    db.exec('PRAGMA foreign_keys=OFF');
    for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>) db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    db.exec(sql);
    // Keep the duplicated native receipt consistent, so the observer must also
    // check the consumed message, recipient and checkpoint against the journal.
    db.exec("UPDATE engine_flow030_handoffs SET receipt_json=(SELECT settlement_json FROM engine_flow030_outbox o WHERE o.effect_id=engine_flow030_handoffs.effect_id)");
    db.close();
    expect(() => observeRun030(path, systemStartId, flowInvocationId)).toThrow();
  });
});
