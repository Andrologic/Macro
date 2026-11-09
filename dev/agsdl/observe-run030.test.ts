import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeRun030 } from './observe-run030';
import { compareRun030 } from './run-expect030';
import { compareObserved030 } from './compare-observed030';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function database(messageJson = '{"prompt":"go","resources":{"x":{"value":{"n":1e0}}}}'): string {
  const dir = mkdtempSync(join(tmpdir(), 'agsdl-observe-'));
  directories.push(dir);
  const path = join(dir, 'run.sqlite');
  const db = new Database(path);
  db.exec(`CREATE TABLE engine_flow030_runs(system_id TEXT,invocation_id TEXT,state_json TEXT,plan_json TEXT);
    CREATE TABLE engine_flow030_outbox(system_id TEXT,invocation_id TEXT,effect_id TEXT,event_id TEXT,effect_json TEXT,status TEXT);
    CREATE TABLE engine_flow030_handoffs(system_id TEXT,invocation_id TEXT,effect_id TEXT,receipt_json TEXT);
    CREATE TABLE engine_flow030_events(system_id TEXT,invocation_id TEXT,event_id TEXT,event_json TEXT,diagnostic_json TEXT);`);
  const state = { verdict: 'succeeded', activations: [{ id: 'a', step: ['worker'], itemJson: '1e0', occurrence: { itemIndex: '0' }, physical: false }], groups: [] };
  db.query('INSERT INTO engine_flow030_runs VALUES (?,?,?,?)').run('s', 'i', JSON.stringify(state), '{"steps":[],"agents":[]}');
  const effect = { kind: { kind: 'start', work: { activationId: 'a', startEffectId: 'e', agentInstanceId: 'instance' }, step: ['worker'], messageJson } };
  db.query('INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?)').run('s', 'i', 'e', 'ev', JSON.stringify(effect), 'settled');
  db.query('INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?)').run('s', 'i', 'e', '{"kind":"nativeOwnedHandoff030","effectId":"e"}');
  db.close();
  return path;
}
describe('durable scenario observation', () => {
  test('retains exact item and resource tokens, and observes only settled handoffs', () => {
    const observed = observeRun030(database(), 's', 'i');
    expect(compareRun030('{"run":"succeeded","starts":{"worker":1},"messages":[{"to":"worker","item":0,"element":1e0,"resources":{"x":{"n":1e0}}}]}', observed)).toEqual([]);
  });
  test('unwraps inline media metadata without changing values or URI references', () => {
    const path = database('{"resources":{"text":{"value":"Review this.","mediaType":"text/plain"},"object":{"value":{"n":1e0},"mediaType":"application/json"},"nil":{"value":null,"mediaType":"application/json"},"uri":{"uri":"https://example.test/source","mediaType":"text/plain"}}}');
    const observed = observeRun030(path, 's', 'i');
    expect(compareRun030('{"run":"succeeded","messages":[{"to":"worker","resources":{"text":"Review this.","object":{"n":1e0},"nil":null,"uri":{"uri":"https://example.test/source","mediaType":"text/plain"}}}]}', observed)).toEqual([]);
    expect(observed).toContain('"n":1e0');
  });
  test('refuses malformed or unresolved delivered sources', () => {
    for (const source of [
      '{"value":1,"unexpected":true}',
      '{"value":1,"uri":"https://example.test/source"}',
      '{"value":1,"mediaType":12}',
      '{"value":1,"mediaType":"plain"}',
      '{"ref":"not-delivered"}',
    ]) {
      const path = database(`{"resources":{"x":${source}}}`);
      expect(() => observeRun030(path, 's', 'i')).toThrow('Unresolved resource source');
    }
  });
  test('observes an absent prompt as null, including an absent message', () => {
    for (const messageJson of ['{}', null]) {
      const path = database();
      const db = new Database(path);
      const row = db.query('SELECT effect_json FROM engine_flow030_outbox').get() as { effect_json: string };
      const effect = JSON.parse(row.effect_json);
      effect.kind.messageJson = messageJson;
      db.query('UPDATE engine_flow030_outbox SET effect_json=?').run(JSON.stringify(effect));
      db.close();
      const observed = observeRun030(path, 's', 'i');
      expect(compareRun030('{"run":"succeeded","messages":[{"to":"worker","prompt":null}]}', observed)).toEqual([]);
    }
  });
  test('refuses an unresolved outbox and a physical terminal activation', () => {
    const path = database();
    let db = new Database(path); db.exec("UPDATE engine_flow030_outbox SET status='uncertain'"); db.close();
    expect(() => observeRun030(path, 's', 'i')).toThrow('Pending or uncertain');
    db = new Database(path); db.exec("UPDATE engine_flow030_outbox SET status='settled'; UPDATE engine_flow030_runs SET state_json=json_set(state_json,'$.activations[0].physical',json('true'))"); db.close();
    expect(() => observeRun030(path, 's', 'i')).toThrow('Physical work remains');
  });
  test('rejects incoherent Stop sources and preserves branch cancellations', () => {
    const path = database();
    const db = new Database(path);
    db.query('INSERT INTO engine_flow030_events VALUES (?,?,?,?,?)')
      .run('s', 'i', 'stop-event', JSON.stringify({ kind: 'Stop' }), null);
    db.query('INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?)')
      .run('s', 'i', 'stop-effect', 'stop-event', JSON.stringify({ kind: { kind: 'stopWork', work: { activationId: 'a', startEffectId: 'e', agentInstanceId: 'instance' } } }), 'settled');
    db.close();
    expect(() => observeRun030(path, 's', 'i')).toThrow('Stop effect in a non-cancelled run');
    const edit = new Database(path);
    edit.query('UPDATE engine_flow030_events SET event_json=?').run(JSON.stringify({ kind: { WorkResult: {} } }));
    edit.close();
    expect(compareRun030('{"run":"succeeded","cancelled":[{"step":"worker","item":0}]}', observeRun030(path, 's', 'i'))).toEqual([]);
    const malformed = new Database(path);
    malformed.exec(`UPDATE engine_flow030_events SET event_json='{"kind":"unknown"}'`);
    malformed.close();
    expect(() => observeRun030(path, 's', 'i')).toThrow('Expected durable object');
  });
  test('refuses unsupported effects, diagnostics, and human plans without native evidence', () => {
    const path = database();
    let db = new Database(path);
    db.query('INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?)').run('s', 'i', 'unknown', 'other', '{"kind":{"kind":"futureEffect"}}', 'settled');
    db.close();
    expect(() => observeRun030(path, 's', 'i')).toThrow('Unprojectable effect kind');
    db = new Database(path);
    db.exec("DELETE FROM engine_flow030_outbox WHERE effect_id='unknown'");
    db.query('INSERT INTO engine_flow030_events VALUES (?,?,?,?,?)').run('s', 'i', 'diagnostic', '{}', '{}');
    db.close();
    expect(() => observeRun030(path, 's', 'i')).toThrow('Flow diagnostic remains');
    db = new Database(path); db.exec('DELETE FROM engine_flow030_events'); db.close();
    for (const plan of [
      { steps: [{ address: ['approve'], type: 'approval' }], agents: [] },
      { steps: [{ address: ['tool'], type: 'call', declarationJson: '{"mcp":{"server":"example","tool":"ask"}}' }], agents: [] },
      { steps: [], agents: [{ agentDeclarationJson: '{"harness":"example","answerTimeoutMs":100}' }] },
      { steps: [], agents: [{ agentDeclarationJson: '{"harness":"example","permissions":{"reviewer":"person"}}' }] },
      { steps: [], agents: [{ agentDeclarationJson: '{"harness":"example","planFirst":"ask"}' }] },
    ]) {
      const edit = new Database(path);
      edit.query('UPDATE engine_flow030_runs SET plan_json=?').run(JSON.stringify(plan));
      edit.close();
      expect(() => observeRun030(path, 's', 'i')).toThrow('Answers are not projectable');
    }
  });
  test('refuses cancelled runs rather than treating them as succeeded', () => {
    const path = database();
    const db = new Database(path);
    db.exec("UPDATE engine_flow030_runs SET state_json=json_set(state_json,'$.verdict','cancelled')");
    db.close();
    expect(() => observeRun030(path, 's', 'i')).toThrow('Run is not terminal');
  });
  test('binds comparison to the native scenario pin and receipt', async () => {
    const path = database(), resultPath = `${path}.result.json`;
    const bytes = readFileSync(join(import.meta.dir, 'fixtures/v0.3/conformance/runs/error-route.json'));
    const fixtureSha256 = createHash('sha256').update(bytes).digest('hex');
    const result = { ok: true, result: { scenario: { name: 'error-route', fixtureSha256 }, receipt: { systemStartId: 's', flowInvocationId: 'i' } } };
    writeFileSync(resultPath, JSON.stringify(result));
    const compared = await compareObserved030(resultPath, path);
    expect(compared.fixtureSha256).toBe(fixtureSha256);
    expect(compared.observedJson).toContain('"worker":1');
    result.result.scenario.fixtureSha256 = '0'.repeat(64);
    writeFileSync(resultPath, JSON.stringify(result));
    await expect(compareObserved030(resultPath, `${path}.absent`)).rejects.toThrow('Scenario fixture differs');
    result.result.scenario.fixtureSha256 = fixtureSha256;
    result.result.receipt.systemStartId = 'foreign';
    writeFileSync(resultPath, JSON.stringify(result));
    await expect(compareObserved030(resultPath, path)).rejects.toThrow('Run is absent');
  });
  test('uses decision ordinals and rejects missing or duplicated ordering', () => {
    const path = database(); const db = new Database(path);
    const state = { verdict: 'succeeded', activations: [], groups: [
      { join: ['later'], decision: 'done', decidedOrdinal: '2', outputJson: '{"outcome":"done","branches":{}}' },
      { join: ['earlier'], decision: 'done', decidedOrdinal: '1', outputJson: '{"outcome":"done","branches":{}}' },
    ] };
    db.query('UPDATE engine_flow030_runs SET state_json=?').run(JSON.stringify(state)); db.exec('DELETE FROM engine_flow030_outbox'); db.close();
    const observed = observeRun030(path, 's', 'i');
    expect(compareRun030('{"run":"succeeded","joins":[{"join":"earlier","outcome":"done"},{"join":"later","outcome":"done"}]}', observed)).toEqual([]);
    const edit = new Database(path); state.groups[0].decidedOrdinal = '1'; edit.query('UPDATE engine_flow030_runs SET state_json=?').run(JSON.stringify(state)); edit.close();
    expect(() => observeRun030(path, 's', 'i')).toThrow('Join order is unavailable');
  });
});
