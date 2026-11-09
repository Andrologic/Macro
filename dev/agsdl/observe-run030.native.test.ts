import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeRun030 } from './observe-run030';
import { compareRun030 } from './run-expect030';
import { compareObserved030 } from './compare-observed030';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { force: true, recursive: true }); });

// Native SQL reader contract. This builder does not run a flow or derive rows
// from expect. Each test supplies the durable facts independently.
function nativeDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'agsdl-native-observe-'));
  directories.push(dir);
  const path = join(dir, 'run.sqlite'), db = new Database(path);
  db.exec(`CREATE TABLE engine_flow030_runs(system_id TEXT,invocation_id TEXT,state_json TEXT,plan_json TEXT);
    CREATE TABLE engine_flow030_outbox(system_id TEXT,invocation_id TEXT,effect_id TEXT,event_id TEXT,effect_json TEXT,status TEXT,settlement_json TEXT);
    CREATE TABLE engine_flow030_handoffs(system_id TEXT,invocation_id TEXT,effect_id TEXT,receipt_json TEXT);
    CREATE TABLE engine_flow030_events(system_id TEXT,invocation_id TEXT,event_id TEXT,event_json TEXT,diagnostic_json TEXT);
    CREATE TABLE engine_flow030_call_receipts(system_id TEXT,invocation_id TEXT,activation_id TEXT,start_effect_id TEXT,call_kind TEXT,status TEXT,terminal_event_id TEXT,result_json TEXT,physical_receipt_id TEXT);
    CREATE TABLE engine_flow030_human_requests(system_id TEXT,invocation_id TEXT,request_id TEXT,request_kind TEXT,work_refs_json TEXT,status TEXT,resolution_json TEXT,delivery_status TEXT);
    CREATE TABLE engine_flow030_work_timeouts(system_id TEXT,invocation_id TEXT,activation_id TEXT,start_effect_id TEXT,status TEXT,terminal_event_id TEXT,physical_receipt_id TEXT);`);
  type ObjectRow = Record<string, any>;
  const state: ObjectRow = { verdict: 'succeeded', activations: [], groups: [], visits: {} };
  const plan: ObjectRow = { steps: [], agents: [] };
  const effect = (id: string, kind: ObjectRow, eventId = 'enter', settlement: ObjectRow | null = null) => {
    db.query('INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?)').run('s', 'i', id, eventId, JSON.stringify({ kind }), 'settled', settlement ? JSON.stringify(settlement) : null);
  };
  const start = (target: string, type = 'agent', options: { message?: string; item?: string; index?: string; declaration?: ObjectRow } = {}) => {
    const id = `a${state.activations.length}`, startEffectId = `start-${id}`;
    const step = target.split('/'), work = { activationId: id, startEffectId, agentInstanceId: type === 'agent' ? `instance-${id}` : null };
    const activation: ObjectRow = { id, step, physical: false, phase: 'done', startEffectId,
      itemJson: options.item ?? null, occurrence: options.index === undefined ? null : { itemIndex: options.index },
      result: { kind: 'completed', outputJson: '{"text":"Done."}', routeKey: null } };
    state.activations.push(activation);
    if (!plan.steps.some((s: ObjectRow) => s.address.join('/') === target)) {
      plan.steps.push({ address: step, type, declarationJson: JSON.stringify({ type, ...options.declaration }) });
    }
    effect(startEffectId, { kind: 'start', work, step, messageJson: options.message ?? null });
    db.query('INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?)').run('s', 'i', startEffectId, JSON.stringify({ kind: 'nativeOwnedHandoff030', effectId: startEffectId }));
    return { activation, work };
  };
  const terminal = (work: ObjectRow, result: ObjectRow) => {
    const id = `terminal-${work.activationId}`, physicalId = `physical-${work.activationId}`;
    state.activations.find((a: ObjectRow) => a.id === work.activationId).result = result;
    const wireResult = result.kind === 'completed'
      ? { Completed: { output_json: result.outputJson, route_key: result.routeKey } }
      : { Failed: { error: result.error } };
    db.query('INSERT INTO engine_flow030_events VALUES (?,?,?,?,?)').run('s', 'i', id, JSON.stringify({ kind: { WorkResult: { work, result: wireResult, physical: { native_receipt_id: physicalId, descendants_joined: true } } } }), null);
    return { id, physicalId };
  };
  const call = (work: ObjectRow, result = { kind: 'completed', outputJson: '{"outcome":"passed","data":{"exitCode":0,"output":""}}', routeKey: null }, kind = 'command') => {
    const end = terminal(work, result);
    db.query('INSERT INTO engine_flow030_call_receipts VALUES (?,?,?,?,?,?,?,?,?)').run('s', 'i', work.activationId, work.startEffectId, kind, 'ended', end.id, JSON.stringify(result), end.physicalId);
  };
  const failure = (activation: ObjectRow, code: string, counted = true) => {
    effect(`failure-${activation.id}`, { kind: 'failure', activationId: activation.id, step: activation.step, error: { code }, counted });
  };
  const human = (work: ObjectRow, kind = 'ask', reason = 'answerTimeout', answerJson: string | null = '"no"') => {
    db.query('INSERT INTO engine_flow030_human_requests VALUES (?,?,?,?,?,?,?,?)').run('s', 'i', `request-${work.activationId}`, kind, JSON.stringify([work]), 'resolved', JSON.stringify({ reason, answerJson }), 'delivered');
  };
  const observe = () => {
    db.exec('DELETE FROM engine_flow030_runs');
    db.query('INSERT INTO engine_flow030_runs VALUES (?,?,?,?)').run('s', 'i', JSON.stringify(state), JSON.stringify(plan));
    return observeRun030(path, 's', 'i');
  };
  return { path, db, state, plan, start, effect, terminal, call, failure, human, observe, close: () => db.close() };
}

describe('native call observation contract', () => {
  test('accepts an unreached command without manufacturing a receipt or a start', () => {
    const n = nativeDatabase();
    n.plan.steps.push({ address: ['publish'], type: 'call', declarationJson: '{"type":"call","command":"synthetic-publish"}' });
    n.db.exec('DROP TABLE engine_flow030_call_receipts');
    expect(compareRun030('{"run":"succeeded","starts":{},"answers":[],"failures":[]}', n.observe())).toEqual([]);
    n.close();
  });
  test('requires a handed-off call and an exact accepted native terminal', () => {
    const n = nativeDatabase(), { work } = n.start('tests', 'call', { declaration: { command: 'synthetic-tests' } });
    expect(() => n.observe()).toThrow('Call receipt is absent');
    n.call(work);
    expect(compareRun030('{"run":"succeeded","starts":{"tests":1},"failures":[]}', n.observe())).toEqual([]);
    n.db.exec('DELETE FROM engine_flow030_handoffs');
    expect(() => n.observe()).toThrow('Start handoff is absent');
    n.close();
  });
  test.each(['pending', 'uncertain'])('refuses a %s call receipt even when the outbox is settled', (status) => {
    const n = nativeDatabase(), { work } = n.start('tests', 'call', { declaration: { command: 'synthetic-tests' } });
    n.call(work);
    n.db.query('UPDATE engine_flow030_call_receipts SET status=?').run(status);
    expect(() => n.observe()).toThrow('Pending or uncertain call');
    n.close();
  });
  test.each([
    "UPDATE engine_flow030_call_receipts SET start_effect_id='foreign'",
    "UPDATE engine_flow030_call_receipts SET activation_id='foreign'",
    "UPDATE engine_flow030_call_receipts SET call_kind='mcp'",
    "UPDATE engine_flow030_call_receipts SET terminal_event_id='absent'",
    "UPDATE engine_flow030_call_receipts SET physical_receipt_id='foreign'",
    "UPDATE engine_flow030_call_receipts SET result_json='{}'",
    "UPDATE engine_flow030_events SET event_json=json_set(event_json,'$.kind.WorkResult.physical.descendants_joined',json('false'))",
    "UPDATE engine_flow030_events SET event_json=json_set(event_json,'$.kind.WorkResult.work.startEffectId','foreign')",
    "UPDATE engine_flow030_call_receipts SET invocation_id='foreign'",
    'INSERT INTO engine_flow030_call_receipts SELECT * FROM engine_flow030_call_receipts',
  ])('rejects altered or foreign call evidence: %s', (sql) => {
    const n = nativeDatabase(), { work } = n.start('tests', 'call', { declaration: { command: 'synthetic-tests' } });
    n.call(work); n.db.exec(sql);
    expect(() => n.observe()).toThrow(); n.close();
  });
  test('distinguishes a normal failed outcome, an OUTPUT_INVALID failure, and repeated visits', () => {
    const n = nativeDatabase();
    const first = n.start('tests', 'call', { declaration: { command: 'synthetic-tests', parse: 'json' } });
    n.call(first.work, { kind: 'completed', outputJson: '{"outcome":"failed","data":{"exitCode":1,"value":{"failed":2}}}', routeKey: null });
    n.start('fix', 'agent', { message: '{"resources":{"result":{"value":{"exitCode":1,"value":{"failed":2}}}}}' });
    const second = n.start('tests', 'call'); n.call(second.work);
    expect(compareRun030('{"run":"succeeded","starts":{"tests":2,"fix":1},"messages":[{"to":"fix","resources":{"result":{"exitCode":1,"value":{"failed":2}}}}],"failures":[]}', n.observe())).toEqual([]);
    n.close();

    const invalid = nativeDatabase(), call = invalid.start('tests', 'call', { declaration: { command: 'synthetic-tests', parse: 'json' } });
    const error = { code: 'OUTPUT_INVALID' };
    invalid.call(call.work, { kind: 'failed', error } as any); invalid.failure(call.activation, 'OUTPUT_INVALID');
    invalid.start('fix', 'agent', { message: '{"resources":{"error":{"value":{"code":"OUTPUT_INVALID"}}}}' });
    expect(compareRun030('{"run":"succeeded","starts":{"tests":1,"fix":1},"failures":[{"step":"tests","code":"OUTPUT_INVALID"}]}', invalid.observe())).toEqual([]);
    invalid.close();
  });
  test('projects call-to-fanout deliveries with native occurrence indices and exact tokens', () => {
    const n = nativeDatabase(), call = n.start('changed', 'call', { declaration: { command: 'synthetic-diff', parse: 'lines' } });
    n.call(call.work);
    n.start('review', 'agent', { item: '"src/a.ts"', index: '0', message: '{"prompt":"Review this changed file.","resources":{"file":{"value":"src/a.ts"}}}' });
    n.start('review', 'agent', { item: '"src/b.ts"', index: '1', message: '{"prompt":"Review this changed file.","resources":{"file":{"value":"src/b.ts"}}}' });
    n.start('summary');
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/v0.3/conformance/runs/command-lines.json'), 'utf8'));
    expect(compareRun030(JSON.stringify(fixture.expect), n.observe())).toEqual([]); n.close();
  });
});

describe('steer and human observation contracts', () => {
  function steerDatabase() {
    const n = nativeDatabase(), physical = n.start('work');
    const activation = { id: 'delivery', step: ['nudge'], physical: false, phase: 'done', itemJson: '1e0', occurrence: { itemIndex: '2' } };
    n.state.activations.push(activation);
    const kind = { kind: 'steer', work: physical.work, deliveryActivationId: 'delivery', messageJson: '{"prompt":"Also update the changelog."}' };
    const receipt = { ...kind, kind: 'nativeSteerConsumed030', effectId: 'steer' };
    n.effect('steer', kind, 'route', receipt);
    return n;
  }
  test('attributes steer to nudge and its occurrence without counting a new work', () => {
    const n = steerDatabase(), observed = n.observe();
    expect(compareRun030('{"run":"succeeded","starts":{"work":1},"messages":[{"to":"nudge","item":2,"element":1e0,"prompt":"Also update the changelog."}]}', observed)).toEqual([]);
    expect(observed).not.toContain('"nudge":1'); n.close();
  });
  test.each([
    'UPDATE engine_flow030_outbox SET settlement_json=NULL WHERE effect_id=\'steer\'',
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.kind','nativeOwnedHandoff030') WHERE effect_id='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.work.startEffectId','foreign') WHERE effect_id='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.deliveryActivationId','foreign') WHERE effect_id='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.messageJson','{}') WHERE effect_id='steer'",
  ])('refuses unproved or altered steer consumption: %s', (sql) => {
    const n = steerDatabase(); n.db.exec(sql);
    expect(() => n.observe()).toThrow(); n.close();
  });
  test('projects only automatic refusals, including a native MCP question and item', () => {
    const n = nativeDatabase(), agent = n.start('release'), tool = n.start('open-issue', 'call', { declaration: { mcp: { server: 'example', tool: 'open' } }, item: '"a"', index: '0' });
    n.call(tool.work, { kind: 'completed', outputJson: '{"outcome":"passed","data":{}}', routeKey: null }, 'mcp');
    n.human(agent.work); n.human(tool.work, 'question');
    const person = n.start('other'); n.human(person.work, 'ask', 'person', '"no"');
    expect(compareRun030('{"run":"succeeded","answers":[{"work":"release","answer":"no"},{"work":"open-issue","item":0,"answer":"no"}]}', n.observe())).toEqual([]);
    n.close();
  });
  test('keeps automatic plan rejection separate from its reported failure', () => {
    const n = nativeDatabase(), work = n.start('migrate');
    n.human(work.work, 'plan'); n.failure(work.activation, 'PLAN_REJECTED'); n.state.verdict = 'failed';
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/v0.3/conformance/runs/answer-timeout-plan.json'), 'utf8'));
    expect(compareRun030(JSON.stringify(fixture.expect), n.observe())).toEqual([]); n.close();
  });
  test.each([
    "UPDATE engine_flow030_human_requests SET status='open'",
    "UPDATE engine_flow030_human_requests SET delivery_status='pending'",
    "UPDATE engine_flow030_human_requests SET delivery_status='uncertain'",
    "UPDATE engine_flow030_human_requests SET resolution_json=NULL",
    "UPDATE engine_flow030_human_requests SET resolution_json=json_set(resolution_json,'$.answerJson','\"yes\"')",
    "UPDATE engine_flow030_human_requests SET work_refs_json=json_set(work_refs_json,'$[0].startEffectId','foreign')",
    'INSERT INTO engine_flow030_human_requests SELECT * FROM engine_flow030_human_requests',
  ])('refuses unprojectable human evidence: %s', (sql) => {
    const n = nativeDatabase(), { work } = n.start('release'); n.human(work); n.db.exec(sql);
    expect(() => n.observe()).toThrow(); n.close();
  });
  test('requires native approval requests and preserves ordered comments outside resources', () => {
    const n = nativeDatabase(), legal = n.start('legal/check', 'approval');
    expect(() => n.observe()).toThrow('Approval request is absent');
    n.human(legal.work, 'approval', 'person', '{"choice":"ok","comment":"Cite the licence."}');
    n.start('release', 'agent', { message: '{"resources":{"text":{"value":"Draft 1"},"comment":{"value":"Checked twice."}},"comments":[{"step":"legal/check","comment":"Cite the licence."},{"step":"editor","comment":"Shorter."}]}' });
    expect(compareRun030('{"run":"succeeded","answers":[],"messages":[{"to":"release","resources":{"text":"Draft 1","comment":"Checked twice."},"comments":[{"step":"legal/check","comment":"Cite the licence."},{"step":"editor","comment":"Shorter."}]}]}', n.observe())).toEqual([]);
    n.close();
  });
  test('projects compose-body-failure without inventing a wrapper start or an automatic answer', () => {
    const n = nativeDatabase(); n.start('write');
    n.plan.steps.push({ address: ['review'], type: 'compose' }); n.state.visits['["review"]'] = '1';
    const wrapper = { id: 'wrapper', step: ['review'], physical: false, phase: 'done' };
    n.state.activations.push(wrapper);
    const approval = n.start('review/check', 'approval');
    n.human(approval.work, 'approval', 'approvalTimeout', null);
    n.terminal(approval.work, { kind: 'failed', error: { code: 'APPROVAL_TIMEOUT' } });
    n.failure(approval.activation, 'APPROVAL_TIMEOUT'); n.failure(wrapper, 'APPROVAL_TIMEOUT');
    n.start('triage', 'agent', { message: '{"resources":{"error":{"value":{"code":"APPROVAL_TIMEOUT"}}}}' });
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/v0.3/conformance/runs/compose-body-failure.json'), 'utf8'));
    const observed = n.observe();
    expect(compareRun030(JSON.stringify(fixture.expect), observed)).toEqual([]);
    expect(JSON.parse(observed).composeVisits).toEqual({ review: 1 });
    expect(JSON.parse(observed).answers).toEqual([]); n.close();
  });
  test('projects approval-comments with two compose visits but no legal wrapper start', () => {
    const n = nativeDatabase(); n.plan.steps.push({ address: ['legal'], type: 'compose' }); n.state.visits['["legal"]'] = '2';
    const draft = { text: { value: 'Draft 1' }, comment: { value: 'Checked twice.' } };
    const legalComment = { step: 'legal/check', comment: 'Cite the licence.' };
    n.start('write');
    const legal1 = n.start('legal/check', 'approval'); n.human(legal1.work, 'approval', 'person', '{"choice":"ok","comment":"Cite the licence."}');
    const editor1 = n.start('editor', 'approval'); n.human(editor1.work, 'approval', 'person', '{"choice":"ok","comment":""}');
    const release1 = n.start('release', 'approval', { message: JSON.stringify({ resources: draft, comments: [legalComment] }) });
    n.human(release1.work, 'approval', 'person', '{"choice":"revise","comment":"Shorter."}');
    n.start('write', 'agent', { message: JSON.stringify({ resources: draft, comments: [legalComment, { step: 'release', comment: 'Shorter.' }] }) });
    for (const target of ['legal/check', 'editor', 'release']) {
      const next = n.start(target, 'approval'); n.human(next.work, 'approval', 'person', JSON.stringify({ choice: target === 'release' ? 'publish' : 'ok', comment: '' }));
    }
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/v0.3/conformance/runs/approval-comments.json'), 'utf8'));
    const observed = n.observe();
    expect(compareRun030(JSON.stringify(fixture.expect), observed)).toEqual([]);
    expect(JSON.parse(observed).composeVisits).toEqual({ legal: 2 }); n.close();
  });
  test.each(['null', '{}', '[{"step":"legal/check","comment":""}]', '[{"step":"bad/path/","comment":"text"}]', '[{"step":"approve","comment":3}]'])('refuses unresolved comments: %s', (value) => {
    const n = nativeDatabase(); n.start('write', 'agent', { message: `{"comments":${value}}` });
    expect(() => n.observe()).toThrow(); n.close();
  });
});

describe('failures, cancellation, joins and compose', () => {
  test('retains counted=false late failures without changing the frozen quorum or verdict', () => {
    const n = nativeDatabase(), late = n.start('r3');
    n.state.groups = [{ join: ['vote'], decision: 'reached', decidedOrdinal: '1', released: true, outputJson: '{"outcome":"reached","branches":{"r2":{"choice":"approve"}}}' }];
    n.failure(late.activation, 'AGENT_FAILED', false);
    const observed = n.observe();
    expect(observed).toContain('"counted":false');
    expect(compareRun030('{"run":"succeeded","joins":[{"join":"vote","outcome":"reached","branches":{"r2":{"choice":"approve"}}}],"failures":[{"step":"r3","code":"AGENT_FAILED"}],"cancelled":[]}', observed)).toEqual([]);
    n.close();
  });
  test('distinguishes joined machine timeouts from indexed branch cancellations', () => {
    const n = nativeDatabase(), expired = n.start('release'), sibling = n.start('fix', 'agent', { index: '1', item: '"a.ts"' });
    const end = n.terminal(expired.work, { kind: 'failed', error: { code: 'TIMEOUT' } });
    n.failure(expired.activation, 'TIMEOUT');
    n.effect('stop-timeout', { kind: 'stopWork', work: expired.work }, end.id);
    n.effect('stop-branch', { kind: 'stopWork', work: sibling.work }, end.id);
    expect(() => n.observe()).toThrow('Timeout receipt is absent');
    n.db.query('INSERT INTO engine_flow030_work_timeouts VALUES (?,?,?,?,?,?,?)').run('s', 'i', expired.work.activationId, expired.work.startEffectId, 'joined', end.id, end.physicalId);
    expect(compareRun030('{"run":"succeeded","failures":[{"step":"release","code":"TIMEOUT"}],"cancelled":[{"step":"fix","item":1}]}', n.observe())).toEqual([]);
    n.db.exec("UPDATE engine_flow030_work_timeouts SET status='uncertain'");
    expect(() => n.observe()).toThrow('Pending or uncertain timeout'); n.close();
  });
  test('rejects foreign timeout evidence instead of hiding a cancellation', () => {
    const n = nativeDatabase(), work = n.start('release');
    const end = n.terminal(work.work, { kind: 'failed', error: { code: 'TIMEOUT' } }); n.failure(work.activation, 'TIMEOUT');
    n.db.query('INSERT INTO engine_flow030_work_timeouts VALUES (?,?,?,?,?,?,?)').run('s', 'i', work.work.activationId, 'foreign', 'joined', end.id, end.physicalId);
    expect(() => n.observe()).toThrow('Timeout receipt binding differs'); n.close();
  });
  test('projects branch and join failures with indices, but no output for failed/closed groups', () => {
    const n = nativeDatabase(), first = n.start('fix', 'agent', { index: '0', item: '"a.ts"' }), third = n.start('fix', 'agent', { index: '2', item: '"c.ts"' });
    n.state.activations.push({ id: 'join', step: ['gather'], physical: false, phase: 'done' });
    n.failure(first.activation, 'AGENT_FAILED'); n.failure(third.activation, 'AGENT_FAILED');
    n.failure(n.state.activations[2], 'BRANCH_FAILED');
    n.state.groups = [{ decision: 'failed', released: true }, { decision: 'closed', released: true }];
    expect(compareRun030('{"run":"succeeded","joins":[],"failures":[{"step":"fix","item":0,"code":"AGENT_FAILED"},{"step":"fix","item":2,"code":"AGENT_FAILED"},{"step":"gather","code":"BRANCH_FAILED"}]}', n.observe())).toEqual([]); n.close();
  });
  test('sorts arbitrarily large native join ordinals and retains reached/missed snapshots', () => {
    const n = nativeDatabase();
    n.state.groups = [
      { join: ['later'], decision: 'missed', decidedOrdinal: '9007199254740993', outputJson: '{"outcome":"missed","branches":{"r1":{"choice":"reject"},"r2":{"ended":"failed","error":{"code":"AGENT_FAILED"}}}}' },
      { join: ['first'], decision: 'reached', decidedOrdinal: '9007199254740992', outputJson: '{"outcome":"reached","branches":{"try":[{"item":"b","choice":"fixed"}]}}' },
    ];
    const expected = '{"run":"succeeded","joins":[{"join":"first","outcome":"reached","branches":{"try":[{"item":"b","choice":"fixed"}]}},{"join":"later","outcome":"missed","branches":{"r2":{"ended":"failed","error":{"code":"AGENT_FAILED"}}}}]}';
    expect(compareRun030(expected, n.observe())).toEqual([]);
    n.state.groups[1].outputJson = '{"outcome":"reached","branches":{"try":[{"item":"a","choice":"failed"},{"item":"b","choice":"fixed"}]}}';
    expect(compareRun030(expected, n.observe()).length).toBeGreaterThan(0); n.close();
  });
  test('keeps repeated compose visits separate from physical starts, including refused entries', () => {
    const n = nativeDatabase();
    n.plan.steps.push({ address: ['review'], type: 'compose' }); n.state.visits['["review"]'] = '2';
    n.state.activations.push({ id: 'wrapper', step: ['review'], phase: 'done', physical: false });
    n.start('review/check'); n.start('review/check'); n.failure(n.state.activations[0], 'VISIT_LIMIT');
    const observed = n.observe();
    expect(JSON.parse(observed).composeVisits).toEqual({ review: 2 });
    expect(compareRun030('{"run":"succeeded","starts":{"review/check":2},"failures":[{"step":"review","code":"VISIT_LIMIT"}]}', observed)).toEqual([]);
    expect(compareRun030('{"run":"succeeded","starts":{"review":2,"review/check":2}}', observed).length).toBeGreaterThan(0);
    n.state.visits['["review"]'] = '02'; expect(() => n.observe()).toThrow('Invalid compose visit count'); n.close();
  });
  test('keeps the composition fixture divergence visible to the unchanged comparator', () => {
    const n = nativeDatabase(); n.start('write');
    n.plan.steps.push({ address: ['review'], type: 'compose' }); n.state.visits['["review"]'] = '1';
    n.start('review/spread', 'agent', { message: '{"prompt":"Review the change."}' });
    n.start('review/r1'); const stopped = n.start('review/r2'); n.start('review/r3');
    const end = n.terminal(stopped.work, { kind: 'completed', outputJson: '{}', routeKey: null });
    n.effect('stop-r2', { kind: 'stopWork', work: stopped.work }, end.id);
    const publish = n.start('publish', 'call', { declaration: { command: 'synthetic-publish' } }); n.call(publish.work);
    n.state.groups = [{ join: ['review', 'vote'], decision: 'reached', decidedOrdinal: '1', outputJson: '{"outcome":"reached","branches":{}}' }];
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/v0.3/conformance/runs/composition.json'), 'utf8'));
    const diagnostics = compareRun030(JSON.stringify(fixture.expect), n.observe());
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].path).toBe('/starts/review');
    expect(diagnostics[0].code).toBe('MISSING'); n.close();
  });
  test('preserves physical and pending guards even with a terminal verdict', () => {
    const n = nativeDatabase(), work = n.start('release');
    work.activation.physical = true; expect(() => n.observe()).toThrow('Physical work remains');
    work.activation.physical = false; work.activation.phase = 'queued'; expect(() => n.observe()).toThrow('Pending native activity'); n.close();
  });
});

test('correlates all 37 exact fixture pins while retaining every comparison diagnostic', async () => {
  const n = nativeDatabase(); n.observe();
  const directory = join(import.meta.dir, 'fixtures/v0.3/conformance/runs');
  const names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  expect(names.length).toBe(37);
  for (const name of names) {
    const fixtureSha256 = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
    const resultPath = `${n.path}.result`;
    writeFileSync(resultPath, JSON.stringify({ ok: true, result: { scenario: { name: name.slice(0, -5), fixtureSha256 }, receipt: { systemStartId: 's', flowInvocationId: 'i' } } }));
    const result = await compareObserved030(resultPath, n.path);
    expect(result.fixtureSha256).toBe(fixtureSha256);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  }
  n.close();
});
