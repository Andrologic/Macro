import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { observeRun030 } from './observe-run030';
import { cleanupObservedDatabases030, nativeDatabase } from './observe-run030.testSupport';
import { compareRun030 } from './run-expect030';
import { compareObserved030 } from './compare-observed030';

afterEach(cleanupObservedDatabases030);
function database(messageJson: string | null = '{"prompt":"go","resources":{"x":{"value":{"n":1e0}}}}'): string {
  const n = nativeDatabase();
  n.start('worker', 'agent', { message: messageJson ?? undefined, item: '1e0', index: '0' });
  n.persist(); n.close();
  return n.path;
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
      const path = database(messageJson);
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
  test('refuses unsupported effects, diagnostics, and contradictory captured plans', () => {
    const path = database();
    let db = new Database(path);
    db.query('INSERT INTO engine_flow030_outbox(system_id,invocation_id,effect_id,event_id,effect_json,status) VALUES (?,?,?,?,?,?)').run('s', 'i', 'unknown', 'other', '{"kind":{"kind":"futureEffect"}}', 'settled');
    db.close();
    expect(() => observeRun030(path, 's', 'i')).toThrow('Unprojectable effect kind');
    db = new Database(path);
    db.exec("DELETE FROM engine_flow030_outbox WHERE effect_id='unknown'");
    db.query('INSERT INTO engine_flow030_events(system_id,invocation_id,event_id,event_json,diagnostic_json) VALUES (?,?,?,?,?)').run('s', 'i', 'diagnostic', '{}', '{}');
    db.close();
    expect(() => observeRun030(path, 's', 'i')).toThrow('Flow diagnostic remains');
    db = new Database(path); db.exec("DELETE FROM engine_flow030_events WHERE event_id='diagnostic'"); db.close();
    db = new Database(path); db.exec('DROP TABLE engine_flow030_human_requests'); db.close();
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
      expect(() => observeRun030(path, 's', 'i')).toThrow();
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

});
