import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compareObserved030 } from './compare-observed030';
import { verifyNativeReplay030 } from './observe-run030';

// These tests consume closed native QA snapshots, never fabricated flow events.
const referenceDir = process.env.MACRO_AGSDL030_HUMAN_REFERENCE_DIR;
const scenarios = ['answer-timeout-ask', 'answer-timeout-plan', 'approval', 'approval-comments', 'call-answer-timeout', 'compose-body-failure', 'timeout-pauses-for-person'];
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function mutated(scenario: string, change: (db: Database) => void) {
  const source = join(referenceDir!, `${scenario}-scenario-delete.sqlite`), before = sha(source);
  const directory = mkdtempSync(join(referenceDir!, 'human-readback-')), path = join(directory, 'mutated.sqlite');
  copyFileSync(source, path);
  const db = new Database(path);
  cleanups.push(() => { db.close(); expect(sha(source)).toBe(before); rmSync(directory, { recursive: true, force: true }); });
  const identity = db.query('SELECT system_id, invocation_id FROM engine_flow030_runs').get() as { system_id: string; invocation_id: string };
  db.exec('PRAGMA foreign_keys=OFF');
  for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>) db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  change(db);
  expect(() => verifyNativeReplay030(path, identity.system_id, identity.invocation_id)).toThrow('Native replay refused');
}

describe.skipIf(!referenceDir || !process.env.MACRO_AGSDL030_REPLAY_COMMAND)('native human readback and observer', () => {
  for (const scenario of scenarios) test(`${scenario} compares equal after native replay`, async () => {
    const result = await compareObserved030(join(referenceDir!, `${scenario}-scenario-native-result.json`), join(referenceDir!, `${scenario}-scenario-delete.sqlite`));
    expect(result.diagnostics).toEqual([]);
  });
  test('rejects a changed clock journal revision', () => mutated('answer-timeout-ask', db => db.exec("UPDATE engine_flow030_clock SET revision='0'")));
  test('rejects a changed consumed machine budget', () => mutated('timeout-pauses-for-person', db => db.exec("UPDATE engine_flow030_clock_works SET snapshot_json=json_set(snapshot_json,'$.elapsedMachineMs','0') WHERE retired=1")));
  test('requires the native resolution proof', () => mutated('answer-timeout-plan', db => db.exec('DELETE FROM engine_flow030_human_resolution_proofs')));
  test('rejects a changed approval presentation', () => mutated('approval-comments', db => db.exec("UPDATE engine_flow030_human_requests SET payload_json=json_set(payload_json,'$.message',json('{}')) WHERE kind='approval'")));
  test('requires the joined timeout control', () => mutated('timeout-pauses-for-person', db => db.exec('UPDATE engine_flow030_clock_controls SET joined=0')));
  test('requires the timeout cause to remain present', () => mutated('timeout-pauses-for-person', db => db.exec('DELETE FROM engine_flow030_clock_controls')));
  test('requires the exact native person submission', () => mutated('timeout-pauses-for-person', db => db.exec("UPDATE engine_flow030_human_submissions SET answer_json=json_set(answer_json,'$.decision','no')")));
  test('requires human clock rows for authored limits', () => mutated('answer-timeout-plan', db => db.exec('DELETE FROM engine_flow030_clock_events; DELETE FROM engine_flow030_clock_works; DELETE FROM engine_flow030_human_requests; DELETE FROM engine_flow030_clock')));
});
