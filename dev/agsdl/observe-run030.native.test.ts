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
// Use the corrected upstream runs until their separately owned vendor import.
const correctedRunsDir = process.env.MACRO_AGSDL030_CORRECTED_RUNS_DIR;
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
      messageJson: options.message ?? null,
      itemJson: options.item ?? null, occurrence: options.index === undefined ? null : { itemIndex: options.index },
      result: { kind: 'completed', outputJson: '{"text":"Done."}', routeKey: null } };
    state.activations.push(activation);
    if (!plan.steps.some((s: ObjectRow) => s.address.join('/') === target)) {
      plan.steps.push({ address: step, type, declarationJson: JSON.stringify({ type,
        ...(type === 'approval' ? { next: { ok: [], revise: [], publish: [] } } : {}), ...options.declaration }) });
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
    const resolution: ObjectRow = { reason, answerJson };
    if (kind === 'approval') {
      const activation = state.activations.find((a: ObjectRow) => a.id === work.activationId);
      const declaration = JSON.parse(plan.steps.find((s: ObjectRow) => s.address.join('/') === activation.step.join('/')).declarationJson);
      const timeout = declaration.timeoutMs === undefined ? null : String(declaration.timeoutMs);
      resolution.approvalTiming = { openedAtMs: '0', resolvedAtMs: reason === 'approvalTimeout' ? timeout : '0', timeoutMs: timeout };
      if (reason === 'person') {
        const answer = JSON.parse(answerJson!);
        terminal(work, { kind: 'completed', outputJson: JSON.stringify({ ...answer, message: JSON.parse(activation.messageJson ?? '{}') }), routeKey: answer.choice });
      } else if (reason === 'approvalTimeout') terminal(work, { kind: 'failed', error: { code: 'APPROVAL_TIMEOUT' } });
    }
    db.query('INSERT INTO engine_flow030_human_requests VALUES (?,?,?,?,?,?,?,?)').run('s', 'i', `request-${work.activationId}`, kind, JSON.stringify([work]), 'resolved', JSON.stringify(resolution), 'delivered');
  };
  const observe = () => {
    db.exec('DELETE FROM engine_flow030_runs');
    db.query('INSERT INTO engine_flow030_runs VALUES (?,?,?,?)').run('s', 'i', JSON.stringify(state), JSON.stringify(plan));
    return observeRun030(path, 's', 'i');
  };
  return { path, db, state, plan, start, effect, terminal, call, failure, human, observe, close: () => db.close() };
}

function composeBodyFailureDatabase() {
  const n = nativeDatabase(); n.start('write');
  n.plan.steps.push({ address: ['review'], type: 'compose' }); n.state.visits['["review"]'] = '1';
  const wrapper = { id: 'wrapper', step: ['review'], physical: false, phase: 'done' };
  n.state.activations.push(wrapper);
  const approval = n.start('review/check', 'approval', { declaration: { timeoutMs: 3600000 } });
  n.human(approval.work, 'approval', 'approvalTimeout', null);
  n.failure(approval.activation, 'APPROVAL_TIMEOUT'); n.failure(wrapper, 'APPROVAL_TIMEOUT');
  n.start('triage', 'agent', { message: '{"resources":{"error":{"value":{"code":"APPROVAL_TIMEOUT"}}}}' });
  return n;
}

function approvalCommentsDatabase() {
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
  return n;
}

function approvalDecisionDatabase() {
  const n = nativeDatabase(), approval = n.start('approve', 'approval', {
    message: '{"prompt":"Approve this.","resources":{"text":{"value":"Draft."}}}',
    declaration: { timeoutMs: 10 },
  });
  n.human(approval.work, 'approval', 'person', '{"choice":"ok","comment":"Checked."}');
  return { ...n, approval };
}

function compositionDatabase() {
  const n = nativeDatabase(); n.start('write');
  n.plan.steps.push({ address: ['review'], type: 'compose' }); n.state.visits['["review"]'] = '1';
  n.start('review/spread', 'agent', { message: '{"prompt":"Review the change."}' });
  const first = n.start('review/r1'), stopped = n.start('review/r2'), last = n.start('review/r3');
  n.terminal(first.work, { kind: 'completed', outputJson: '{"choice":"approve"}', routeKey: 'approve' });
  // r3 reaches the quorum. r2 has no result and is still physical at this event.
  const decision = n.terminal(last.work, { kind: 'completed', outputJson: '{"choice":"approve"}', routeKey: 'approve' });
  stopped.activation.result = null;
  stopped.activation.stopEffectId = 'stop-r2';
  n.effect('stop-r2', { kind: 'stopWork', work: stopped.work }, decision.id);
  n.db.query('INSERT INTO engine_flow030_events VALUES (?,?,?,?,?)').run('s', 'i', 'r2-physical-end', JSON.stringify({ kind: { PhysicalEnded: {
    work: stopped.work, stop_effect_id: 'stop-r2', evidence: { native_receipt_id: 'r2-joined', descendants_joined: true },
  } } }), null);
  const publish = n.start('publish', 'call', { declaration: { command: 'synthetic-publish' } }); n.call(publish.work);
  n.state.groups = [{ join: ['review', 'vote'], decision: 'reached', decidedOrdinal: '1', released: true,
    outputJson: '{"outcome":"reached","branches":{"r1":{"choice":"approve"},"r3":{"choice":"approve"}}}' }];
  return { ...n, stopped, decision };
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
  test('counts a failed compose visit without a wrapper handoff or an automatic answer', () => {
    const n = composeBodyFailureDatabase();
    const observed = n.observe();
    expect(compareRun030('{"run":"succeeded","starts":{"write":1,"review":1,"review/check":1,"triage":1},"failures":[{"step":"review/check","code":"APPROVAL_TIMEOUT"},{"step":"review","code":"APPROVAL_TIMEOUT"}]}', observed)).toEqual([]);
    expect(JSON.parse(observed).composeVisits).toEqual({ review: 1 });
    expect(JSON.parse(observed).answers).toEqual([]); n.close();
  });
  test('rejects a personal approval decision contradicting its APPROVAL_TIMEOUT terminal', () => {
    const n = composeBodyFailureDatabase();
    n.db.query('UPDATE engine_flow030_human_requests SET resolution_json=?').run(JSON.stringify({ reason: 'person', answerJson: '{"choice":"ok","comment":""}' }));
    expect(() => n.observe()).toThrow('Approval resolution contradicts terminal result');
    n.close();
  });
  test.each([
    ['choice', '{"choice":"revise","comment":"Checked."}'],
    ['comment', '{"choice":"ok","comment":"Forged."}'],
  ])('rejects an approval %s differing from the terminal output', (_field, answerJson) => {
    const n = approvalDecisionDatabase();
    n.db.query("UPDATE engine_flow030_human_requests SET resolution_json=json_set(resolution_json,'$.answerJson',?)").run(answerJson);
    expect(() => n.observe()).toThrow('Approval decision differs from terminal output'); n.close();
  });
  test.each([
    ["json_remove(resolution_json,'$.approvalTiming')", 'Approval timing is absent'],
    ["json_set(resolution_json,'$.approvalTiming.timeoutMs','11')", 'Approval deadline differs from captured timeout'],
    ["json_set(resolution_json,'$.approvalTiming.resolvedAtMs','10')", 'Approval resolution contradicts deadline'],
    ["json_set(resolution_json,'$.approvalTiming.openedAtMs','1')", 'Approval resolution precedes request'],
  ])('rejects inconsistent approval timing: %s', (expression, diagnostic) => {
    const n = approvalDecisionDatabase();
    n.db.exec(`UPDATE engine_flow030_human_requests SET resolution_json=${expression}`);
    expect(() => n.observe()).toThrow(diagnostic); n.close();
  });
  test('rejects an approval timeout before its captured deadline', () => {
    const n = composeBodyFailureDatabase();
    n.db.exec("UPDATE engine_flow030_human_requests SET resolution_json=json_set(resolution_json,'$.approvalTiming.resolvedAtMs','3599999')");
    expect(() => n.observe()).toThrow('Approval resolution contradicts deadline'); n.close();
  });
  test('rejects approval expiry without a captured timeout', () => {
    const n = composeBodyFailureDatabase();
    const step = n.plan.steps.find((s: Record<string, any>) => s.type === 'approval');
    step.declarationJson = '{"type":"approval","next":{"ok":[]}}';
    n.db.exec("UPDATE engine_flow030_human_requests SET resolution_json=json_set(resolution_json,'$.approvalTiming.timeoutMs',NULL)");
    expect(() => n.observe()).toThrow('Approval resolution contradicts deadline'); n.close();
  });
  test('rejects a terminal approval message substituted for the delivered message', () => {
    const n = approvalDecisionDatabase(), output = JSON.parse(n.approval.activation.result.outputJson);
    output.message.prompt = 'Substituted.';
    n.approval.activation.result.outputJson = JSON.stringify(output);
    expect(() => n.observe()).toThrow('Approval terminal message differs'); n.close();
  });
  test('checks an exact approval deadline beyond Number.MAX_SAFE_INTEGER', () => {
    const n = approvalDecisionDatabase();
    n.db.exec("UPDATE engine_flow030_human_requests SET resolution_json=json_set(resolution_json,'$.approvalTiming.openedAtMs','9007199254740992','$.approvalTiming.resolvedAtMs','9007199254741001')");
    expect(compareRun030('{"run":"succeeded","starts":{"approve":1}}', n.observe())).toEqual([]);
    n.db.exec("UPDATE engine_flow030_human_requests SET resolution_json=json_set(resolution_json,'$.approvalTiming.resolvedAtMs','9007199254741002')");
    expect(() => n.observe()).toThrow('Approval resolution contradicts deadline'); n.close();
  });
  test('counts repeated compose visits alongside their approval body works', () => {
    const n = approvalCommentsDatabase();
    const observed = n.observe();
    expect(compareRun030('{"run":"succeeded","starts":{"write":2,"legal":2,"legal/check":2,"editor":2,"release":2}}', observed)).toEqual([]);
    expect(JSON.parse(observed).composeVisits).toEqual({ legal: 2 }); n.close();
  });
  test.skipIf(!correctedRunsDir).each([
    ['compose-body-failure', composeBodyFailureDatabase],
    ['approval-comments', approvalCommentsDatabase],
  ] as const)('matches the corrected upstream %s fixture read directly from its worktree', (name, database) => {
    const n = database();
    const fixture = JSON.parse(readFileSync(join(correctedRunsDir!, `${name}.json`), 'utf8'));
    expect(compareRun030(JSON.stringify(fixture.expect), n.observe())).toEqual([]);
    n.close();
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
    sibling.activation.stopEffectId = 'stop-branch';
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
  test('counts admitted compose visits alongside body starts without counting refused entries', () => {
    const n = nativeDatabase();
    n.plan.steps.push({ address: ['review'], type: 'compose' }); n.state.visits['["review"]'] = '2';
    n.state.activations.push({ id: 'wrapper', step: ['review'], phase: 'done', physical: false });
    n.start('review/check'); n.start('review/check'); n.failure(n.state.activations[0], 'VISIT_LIMIT');
    const observed = n.observe();
    expect(JSON.parse(observed).composeVisits).toEqual({ review: 2 });
    expect(compareRun030('{"run":"succeeded","starts":{"review":2,"review/check":2},"failures":[{"step":"review","code":"VISIT_LIMIT"}]}', observed)).toEqual([]);
    expect(compareRun030('{"run":"succeeded","starts":{"review":3,"review/check":2}}', observed).length).toBeGreaterThan(0);
    n.state.visits['["review"]'] = '02'; expect(() => n.observe()).toThrow('Invalid compose visit count'); n.close();
  });
  test('matches the composition fixture including its review wrapper work', () => {
    const n = compositionDatabase();
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/v0.3/conformance/runs/composition.json'), 'utf8'));
    const diagnostics = compareRun030(JSON.stringify(fixture.expect), n.observe());
    expect(diagnostics).toEqual([]); n.close();
  });
  test.each(['WorkResult', 'PhysicalEnded'])('rejects a %s physical end as the cause of its own cancellation', (cause) => {
    const n = nativeDatabase(), stopped = n.start('review/r2');
    const end = n.terminal(stopped.work, { kind: 'completed', outputJson: '{}', routeKey: null });
    stopped.activation.stopEffectId = 'stop-r2';
    if (cause === 'PhysicalEnded') n.db.query('UPDATE engine_flow030_events SET event_json=?').run(JSON.stringify({ kind: { PhysicalEnded: {
      work: stopped.work, stop_effect_id: 'stop-r2', evidence: { native_receipt_id: end.physicalId, descendants_joined: true },
    } } }));
    n.effect('stop-r2', { kind: 'stopWork', work: stopped.work }, end.id);
    expect(() => n.observe()).toThrow('Physical end precedes work cancellation');
    n.close();
  });
  test.each([null, 'foreign-stop'])('rejects a cancellation with stopEffectId=%s', (stopEffectId) => {
    const n = compositionDatabase(); n.stopped.activation.stopEffectId = stopEffectId;
    expect(() => n.observe()).toThrow('Stopped activation stopEffectId differs'); n.close();
  });
  test('rejects a work already physically ended before another work decides its group', () => {
    const n = compositionDatabase();
    n.db.exec("UPDATE engine_flow030_events SET rowid=0 WHERE event_id='r2-physical-end'");
    expect(() => n.observe()).toThrow('Physical end precedes work cancellation'); n.close();
  });
  test.each([
    "json_remove(event_json,'$.kind.WorkResult.physical')",
    "json_set(event_json,'$.kind.WorkResult.physical.descendants_joined',json('false'))",
  ])('rejects an incomplete physical cause for a sibling cancellation: %s', (expression) => {
    const n = compositionDatabase();
    n.db.query(`UPDATE engine_flow030_events SET event_json=${expression} WHERE event_id=?`).run(n.decision.id);
    expect(() => n.observe()).toThrow('Invalid physical stop cause'); n.close();
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
