import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupObservedDatabases030, nativeDatabase } from './observe-run030.testSupport';
import { compareRun030 } from './run-expect030';
import { compareObserved030 } from './compare-observed030';

// Use the corrected upstream runs until their separately owned vendor import.
const correctedRunsDir = process.env.MACRO_AGSDL030_CORRECTED_RUNS_DIR;
afterEach(cleanupObservedDatabases030);

// Native SQL reader contract. This builder does not run a flow or derive rows
// from expect. Each test supplies the durable facts independently.

function composeBodyFailureDatabase() {
  const n = nativeDatabase(); n.start('write');
  n.plan.steps.push({ address: ['review'], type: 'compose' }); n.state.visits['["review"]'] = '1';
  const wrapper = n.internal('wrapper', 'review', 'compose');
  const approval = n.start('review/check', 'approval', { declaration: { timeoutMs: 3600000 } });
  approval.activation.context.push({ kind: 'compose', activationId: wrapper.id });
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
  const wrapper = n.internal('legal-1', 'legal', 'compose');
  const legal1 = n.start('legal/check', 'approval'); n.human(legal1.work, 'approval', 'person', '{"choice":"ok","comment":"Cite the licence."}');
  legal1.activation.context.push({ kind: 'compose', activationId: wrapper.id });
  const editor1 = n.start('editor', 'approval'); n.human(editor1.work, 'approval', 'person', '{"choice":"ok","comment":""}');
  const release1 = n.start('release', 'approval', { message: JSON.stringify({ resources: draft, comments: [legalComment] }) });
  n.human(release1.work, 'approval', 'person', '{"choice":"revise","comment":"Shorter."}');
  n.start('write', 'agent', { message: JSON.stringify({ resources: draft, comments: [legalComment, { step: 'release', comment: 'Shorter.' }] }) });
  for (const target of ['legal/check', 'editor', 'release']) {
    const next = n.start(target, 'approval'); n.human(next.work, 'approval', 'person', JSON.stringify({ choice: target === 'release' ? 'publish' : 'ok', comment: '' }));
    if (target === 'legal/check') next.activation.context.push({ kind: 'compose', activationId: n.internal('legal-2', 'legal', 'compose').id });
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
  const wrapper = n.internal('review-wrapper', 'review', 'compose');
  const spread = n.start('review/spread', 'agent', { message: '{"prompt":"Review the change."}' });
  const first = n.start('review/r1'), stopped = n.start('review/r2', 'agent', { deferTerminal: true }), last = n.start('review/r3');
  for (const a of [spread, first, stopped, last]) a.activation.context.push({ kind: 'compose', activationId: wrapper.id });
  n.terminal(first.work, { kind: 'completed', outputJson: '{"choice":"approve"}', routeKey: 'approve' });
  // r3 reaches the quorum. r2 has no result and is still physical at this event.
  const decision = n.terminal(last.work, { kind: 'completed', outputJson: '{"choice":"approve"}', routeKey: 'approve' });
  stopped.activation.result = null;
  stopped.activation.stopEffectId = 'stop-r2';
  n.effect('stop-r2', { kind: 'stopWork', work: stopped.work }, decision.id);
  n.event('r2-physical-end', { PhysicalEnded: {
    work: stopped.work, stop_effect_id: 'stop-r2', evidence: { native_receipt_id: 'r2-joined', descendants_joined: true },
  } });
  const publish = n.start('publish', 'call', { declaration: { command: 'synthetic-publish' } }); n.call(publish.work);
  n.group('review/vote', [{ name: 'r1', activation: first.activation, accepted: true }, { name: 'r2', activation: stopped.activation, excluded: true }, { name: 'r3', activation: last.activation, accepted: true }], 'reached', { eventId: decision.id });
  return { ...n, stopped, decision };
}

function lateGroupDatabase(remaining: 'finish' | 'wait', failed = false) {
  const n = nativeDatabase(); n.start('spread');
  const early = n.start('r2', 'agent', { deferTerminal: true }), late = n.start('r3', 'agent', { deferTerminal: true });
  const decision = n.terminal(early.work, { kind: 'completed', outputJson: '{"choice":"approve"}', routeKey: 'approve' });
  const group = n.group('vote', [{ name: 'r2', activation: early.activation, accepted: true }, { name: 'r3', activation: late.activation, excluded: true }], 'reached', { eventId: decision.id });
  n.plan.joins[0].remaining = remaining;
  if (failed) n.failure(late.activation, 'AGENT_FAILED', false);
  else n.terminal(late.work, { kind: 'completed', outputJson: '{"choice":"approve","text":"Late."}', routeKey: 'approve' });
  return { ...n, early, late, snapshot: group, decision };
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
    const n = nativeDatabase(); n.start('start');
    const physical = n.start('work', 'agent', { deferTerminal: true }), ping = n.start('ping');
    const messageJson = '{"prompt":"Also update the changelog."}';
    const activation = { id: 'delivery', step: ['nudge'], physical: false, phase: 'done', startEffectId: null, result: null, context: [], instanceId: physical.work.agentInstanceId, agent: 'synthetic-agent', messageJson, itemJson: '1e0', occurrence: { itemIndex: '2' } };
    n.state.activations.push(activation);
    n.plan.steps.push({ address: ['nudge'], type: 'agent', declarationJson: '{"type":"agent","delivery":"steer"}' });
    const kind = { kind: 'steer', work: physical.work, deliveryActivationId: 'delivery', messageJson };
    const receipt = { ...kind, kind: 'nativeSteerConsumed030', effectId: 'steer', consumedAfterEventId: `terminal-${ping.work.activationId}` };
    n.effect('steer', kind, receipt.consumedAfterEventId, receipt);
    n.terminal(physical.work, { kind: 'completed', outputJson: '{"text":"Done."}', routeKey: null });
    return n;
  }
  test('attributes steer to nudge and its occurrence without counting a new work', () => {
    const n = steerDatabase(), observed = n.observe();
    expect(compareRun030('{"run":"succeeded","starts":{"start":1,"work":1,"ping":1},"messages":[{"to":"nudge","item":2,"element":1e0,"prompt":"Also update the changelog."}]}', observed)).toEqual([]);
    expect(observed).not.toContain('"nudge":1'); n.close();
  });
  test('rejects the audit mutation: steer consumed after the target physical terminal', () => {
    const n = steerDatabase(); n.observe();
    const work = n.state.activations.find((a: Record<string, any>) => a.step.join('/') === 'work');
    n.db.query("UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.consumedAfterEventId',?) WHERE effect_id='steer'").run(`terminal-${work.id}`);
    expect(() => n.observe()).toThrow('Steer consumed after target stopped counting or ended'); n.close();
  });
  test('rejects a consumed steer once the target no longer counts for its group', () => {
    const n = steerDatabase();
    const work = n.state.activations.find((a: Record<string, any>) => a.step.join('/') === 'work');
    const ping = n.state.activations.find((a: Record<string, any>) => a.step.join('/') === 'ping');
    n.terminal({ activationId: ping.id, startEffectId: ping.startEffectId, agentInstanceId: ping.instanceId }, { kind: 'completed', outputJson: '{"choice":"approve"}', routeKey: 'approve' });
    n.group('vote', [{ name: 'ping', activation: ping, accepted: true }, { name: 'work', activation: work, excluded: true }], 'reached', { eventId: `terminal-${ping.id}` });
    expect(() => n.observe()).toThrow('Steer consumed after target stopped counting or ended'); n.close();
  });
  test.each([
    'UPDATE engine_flow030_outbox SET settlement_json=NULL WHERE effect_id=\'steer\'',
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.kind','nativeOwnedHandoff030') WHERE effect_id='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.work.startEffectId','foreign') WHERE effect_id='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.deliveryActivationId','foreign') WHERE effect_id='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_set(settlement_json,'$.messageJson','{}') WHERE effect_id='steer'",
    "UPDATE engine_flow030_outbox SET settlement_json=json_remove(settlement_json,'$.consumedAfterEventId') WHERE effect_id='steer'",
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
  test('rejects the audit mutation: accepted WorkResult changed to APPROVAL_TIMEOUT while personal approval remains', () => {
    const n = approvalDecisionDatabase(); n.observe();
    const id = `terminal-${n.approval.activation.id}`, event = JSON.parse(n.state.events[id].eventJson);
    event.kind.WorkResult.result = { Failed: { error: { code: 'APPROVAL_TIMEOUT' } } };
    const changed = JSON.stringify(event);
    n.db.query('UPDATE engine_flow030_events SET event_json=? WHERE event_id=?').run(changed, id);
    expect(() => n.observe()).toThrow('Accepted event differs from retained journal');
    n.state.events[id].eventJson = changed;
    expect(() => n.observe()).toThrow('Accepted WorkResult contradicts activation terminal'); n.close();
  });
  test('rejects the audit mutation: revoked approval with completed output and transmitted comment', () => {
    const n = approvalDecisionDatabase();
    n.start('handler', 'agent', { message: '{"comments":[{"step":"approve","comment":"Checked."}]}' }); n.observe();
    n.db.exec("UPDATE engine_flow030_human_requests SET status='revoked',delivery_status='revoked',resolution_json=NULL");
    expect(() => n.observe()).toThrow('Revoked approval contradicts terminal or cancellation'); n.close();
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
    const n = nativeDatabase(), early = n.start('r2');
    const decided = n.terminal(early.work, { kind: 'completed', outputJson: '{"choice":"approve"}', routeKey: 'approve' });
    const late = n.start('r3', 'agent', { deferTerminal: true });
    n.group('vote', [{ name: 'r2', activation: early.activation, accepted: true }, { name: 'r3', activation: late.activation, excluded: true }], 'reached', { eventId: decided.id });
    n.failure(late.activation, 'AGENT_FAILED', false);
    const observed = n.observe();
    expect(observed).toContain('"counted":false');
    expect(compareRun030('{"run":"succeeded","joins":[{"join":"vote","outcome":"reached","branches":{"r2":{"choice":"approve"}}}],"failures":[{"step":"r3","code":"AGENT_FAILED"}],"cancelled":[]}', observed)).toEqual([]);
    n.close();
  });
  test('distinguishes joined machine timeouts from indexed branch cancellations', () => {
    const n = nativeDatabase(); n.start('origin');
    const expired = n.start('release'), sibling = n.start('fix', 'agent', { index: '1', item: '"a.ts"' });
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
    const n = nativeDatabase(); n.start('origin');
    const first = n.start('fix', 'agent', { index: '0', item: '"a.ts"' }), third = n.start('fix', 'agent', { index: '2', item: '"c.ts"' });
    const join = n.internal('join', 'gather', 'join');
    n.failure(first.activation, 'AGENT_FAILED'); n.failure(third.activation, 'AGENT_FAILED');
    n.failure(join, 'BRANCH_FAILED');
    n.group('gather', [{ name: 'fix', activation: first.activation, fanout: true }, { name: 'fix', activation: third.activation, fanout: true }], 'failed', { owner: join });
    n.group('closed', [], 'closed');
    expect(compareRun030('{"run":"succeeded","joins":[],"failures":[{"step":"fix","item":0,"code":"AGENT_FAILED"},{"step":"fix","item":2,"code":"AGENT_FAILED"},{"step":"gather","code":"BRANCH_FAILED"}]}', n.observe())).toEqual([]); n.close();
  });
  test('sorts arbitrarily large native join ordinals and retains reached/missed snapshots', () => {
    const n = nativeDatabase();
    const accepted = n.start('try', 'agent', { item: '"b"', index: '1' });
    n.terminal(accepted.work, { kind: 'completed', outputJson: '{"choice":"fixed"}', routeKey: 'fixed' });
    n.group('first', [{ name: 'try', activation: accepted.activation, accepted: true, fanout: true }], 'reached', { ordinal: '9007199254740992' });
    const reject = n.start('r1'), failed = n.start('r2');
    n.terminal(reject.work, { kind: 'completed', outputJson: '{"choice":"reject"}', routeKey: 'reject' }); n.failure(failed.activation, 'AGENT_FAILED');
    n.group('later', [{ name: 'r1', activation: reject.activation }, { name: 'r2', activation: failed.activation }], 'missed', { ordinal: '9007199254740993' });
    n.state.groups.reverse();
    const expected = '{"run":"succeeded","joins":[{"join":"first","outcome":"reached","branches":{"try":[{"item":"b","choice":"fixed"}]}},{"join":"later","outcome":"missed","branches":{"r2":{"ended":"failed","error":{"code":"AGENT_FAILED"}}}}]}';
    expect(compareRun030(expected, n.observe())).toEqual([]);
    n.state.groups[1].outputJson = '{"outcome":"reached","branches":{"try":[{"item":"a","choice":"failed"},{"item":"b","choice":"fixed"}]}}';
    expect(() => n.observe()).toThrow('Join snapshot contradicts'); n.close();
  });
  test('counts admitted compose visits alongside body starts without counting refused entries', () => {
    const n = nativeDatabase();
    n.plan.steps.push({ address: ['review'], type: 'compose' }); n.state.visits['["review"]'] = '2';
    const one = n.internal('wrapper-one', 'review', 'compose'), two = n.internal('wrapper-two', 'review', 'compose'), refused = n.internal('wrapper-refused', 'review', 'compose');
    n.start('review/check').activation.context.push({ kind: 'compose', activationId: one.id });
    n.start('review/check').activation.context.push({ kind: 'compose', activationId: two.id }); n.failure(refused, 'VISIT_LIMIT');
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

describe('bidirectional durable evidence', () => {
  test('requires a native decision anchor when quorum contributions cannot establish its instant', () => {
    const n = lateGroupDatabase('wait'); n.observe();
    n.db.exec('DELETE FROM engine_flow030_group_decisions');
    expect(() => n.observe()).toThrow('Join decision time requires native anchor'); n.close();
  });
  test('rejects an unattached native decision anchor', () => {
    const n = lateGroupDatabase('finish'); n.observe();
    n.db.exec("UPDATE engine_flow030_group_decisions SET event_id='unknown'");
    expect(() => n.observe()).toThrow('Unattached group decision anchor'); n.close();
  });
  test.each(['finish', 'wait'] as const)('preserves a frozen %s snapshot when another result arrives later', (remaining) => {
    const n = lateGroupDatabase(remaining);
    expect(compareRun030('{"run":"succeeded","joins":[{"join":"vote","outcome":"reached","branches":{"r2":{"choice":"approve"}}}],"failures":[]}', n.observe())).toEqual([]);
    n.close();
  });
  test('rejects the audit mutation: membership output differs from its producer and group snapshot', () => {
    const n = lateGroupDatabase('finish'); n.observe();
    n.state.paths[0].memberships[0].resultJson = '{"choice":"approve","text":"Forged."}';
    expect(() => n.observe()).toThrow('Membership result contradicts producer'); n.close();
  });
  test('rejects a forged group output even when its join terminal was changed to match', () => {
    const n = lateGroupDatabase('wait'); n.observe();
    n.snapshot.outputJson = '{"outcome":"reached","branches":{"r2":{"choice":"reject"}}}';
    n.state.activations.find((a: Record<string, any>) => a.id === n.snapshot.activationId).result.outputJson = n.snapshot.outputJson;
    expect(() => n.observe()).toThrow('Join snapshot contradicts memberships or terminal'); n.close();
  });
  test('rejects a producer mutation even when membership and group output were changed to match', () => {
    const n = lateGroupDatabase('finish'); n.observe();
    const m = n.state.paths[0].memberships[0]; m.resultJson = '{"choice":"approve","text":"Forged."}'; m.producer.outputJson = m.resultJson;
    n.snapshot.outputJson = JSON.stringify({ outcome: 'reached', branches: { r2: JSON.parse(m.resultJson) } });
    n.state.activations.find((a: Record<string, any>) => a.id === n.snapshot.activationId).result.outputJson = n.snapshot.outputJson;
    expect(() => n.observe()).toThrow('Producer output contradicts accepted result'); n.close();
  });
  test('rejects a late result injected into an otherwise internally matching frozen snapshot', () => {
    const n = lateGroupDatabase('wait'); n.observe();
    const m = n.state.paths[1].memberships[0];
    m.phase = 'ended'; m.accepted = true; m.resultJson = n.late.activation.result.outputJson;
    m.producer = { activationId: n.late.activation.id, step: n.late.activation.step, kind: 'agent', outputJson: m.resultJson };
    n.snapshot.outputJson = JSON.stringify({ outcome: 'reached', branches: { r2: { choice: 'approve' }, r3: JSON.parse(m.resultJson) } });
    n.state.activations.find((a: Record<string, any>) => a.id === n.snapshot.activationId).result.outputJson = n.snapshot.outputJson;
    expect(() => n.observe()).toThrow('Join snapshot includes a late contribution'); n.close();
  });
  test('rejects the audit mutation: counted=false failure with error route preparation', () => {
    const n = lateGroupDatabase('finish', true); n.observe();
    const reference = { identity: n.state.identity, prepareId: 'forged-error', activationId: n.late.activation.id, route: { source: n.late.activation.step, kind: 'error', key: null } };
    n.effect('forged-error-route', { kind: 'prepareRoute', reference, producer: { activationId: n.late.activation.id, step: n.late.activation.step, outputJson: '{"error":{"code":"AGENT_FAILED"}}' } }, `terminal-${n.late.activation.id}`);
    expect(() => n.observe()).toThrow('Non-counting failure has an error continuation'); n.close();
  });
  test('rejects the reverse audit mutation: handler Start from a non-counting failure without its preparation', () => {
    const n = lateGroupDatabase('finish', true); n.observe();
    const handler = n.start('handler');
    const producer = { activationId: n.late.activation.id, step: n.late.activation.step, outputJson: '{"error":{"code":"AGENT_FAILED"}}' };
    handler.activation.producer = producer;
    n.db.query("UPDATE engine_flow030_outbox SET effect_json=json_set(effect_json,'$.kind.sender',json(?)) WHERE effect_id=?").run(JSON.stringify(producer), handler.work.startEffectId);
    expect(() => n.observe()).toThrow('Non-counting failure has an error continuation'); n.close();
  });
  test('rejects changing counted to true to authorize a late error continuation', () => {
    const n = lateGroupDatabase('finish', true); n.observe();
    n.db.exec("UPDATE engine_flow030_outbox SET effect_json=json_set(effect_json,'$.kind.counted',json('true')) WHERE json_extract(effect_json,'$.kind.kind')='failure'");
    expect(() => n.observe()).toThrow('Failure counted flag contradicts context at failure'); n.close();
  });
  test('requires a physical Failure to be emitted by its own accepted terminal event', () => {
    const n = lateGroupDatabase('finish', true); n.observe();
    const id = `failure-${n.late.activation.id}`, source = `terminal-${n.late.activation.id}`, target = n.decision.id;
    n.state.events[source].receipt.effectIds = n.state.events[source].receipt.effectIds.filter((effectId: string) => effectId !== id);
    n.state.events[target].receipt.effectIds.push(id);
    for (const eventId of [source, target]) n.db.query('UPDATE engine_flow030_events SET receipt_json=? WHERE event_id=?').run(JSON.stringify(n.state.events[eventId].receipt), eventId);
    n.db.query("UPDATE engine_flow030_outbox SET event_id=?,effect_json=json_set(effect_json,'$.revision',?) WHERE effect_id=?").run(target, n.state.events[target].receipt.revision, id);
    expect(() => n.observe()).toThrow('Failure contradicts accepted terminal'); n.close();
  });
  test('rejects the audit mutation: RunEnded verdict contradicts the durable state', () => {
    const n = approvalDecisionDatabase(); n.observe();
    n.db.exec("UPDATE engine_flow030_outbox SET effect_json=json_set(effect_json,'$.kind.verdict','failed') WHERE effect_id='run-ended'");
    expect(() => n.observe()).toThrow('RunEnded verdict differs from state'); n.close();
  });
  test('rejects the audit mutation: settled prepareRoute references an unknown activation', () => {
    const n = approvalCommentsDatabase(); n.observe();
    n.db.exec("UPDATE engine_flow030_outbox SET effect_json=json_set(effect_json,'$.kind.reference.activationId','unknown') WHERE json_extract(effect_json,'$.kind.kind')='prepareRoute'");
    expect(() => n.observe()).toThrow('Unattached or contradictory prepareRoute'); n.close();
  });
  test('rejects reassigning a preparation to another activation of the same step', () => {
    const n = nativeDatabase(); n.start('worker'); const other = n.start('worker'); n.observe();
    const p = n.state.preparations[0], eventId = `prepared-${p.reference.prepareId}`;
    p.reference.activationId = other.activation.id;
    const event = JSON.parse(n.state.events[eventId].eventJson); event.kind.Prepared.reference = p.reference;
    n.state.events[eventId].eventJson = JSON.stringify(event);
    n.db.query('UPDATE engine_flow030_events SET event_json=? WHERE event_id=?').run(n.state.events[eventId].eventJson, eventId);
    n.db.query("UPDATE engine_flow030_outbox SET effect_json=json_set(effect_json,'$.kind.reference.activationId',?) WHERE effect_id=?").run(other.activation.id, `effect-${p.reference.prepareId}`);
    expect(() => n.observe()).toThrow('Unattached or contradictory prepareRoute'); n.close();
  });
  test('rejects the audit mutation: activation instance differs from its Start', () => {
    const n = nativeDatabase(), work = n.start('worker'); n.observe();
    work.activation.instanceId = 'different-instance';
    expect(() => n.observe()).toThrow('Activation and Start binding differ'); n.close();
  });
  test('rejects the audit mutation: activation points to a non-existent startEffectId', () => {
    const n = nativeDatabase(), work = n.start('worker'); n.observe(); work.activation.startEffectId = 'missing';
    expect(() => n.observe()).toThrow('Start activation differs'); n.close();
  });
  test('rejects an activation without a Start, group, compose body, failure or absorbed delivery', () => {
    const n = nativeDatabase(); n.start('worker'); n.observe(); n.internal('orphan', 'orphan', 'agent');
    expect(() => n.observe()).toThrow('Unattached activation without Start'); n.close();
  });
  test('rejects an unattached settled Return', () => {
    const n = nativeDatabase(); n.start('worker'); n.observe();
    n.effect('orphan-return', { kind: 'return', activationId: 'unknown', sender: 'unknown', outputJson: '{}' });
    expect(() => n.observe()).toThrow('Unattached or contradictory Return'); n.close();
  });
  test('rejects an unattached accepted WorkResult even when its retained journal copy agrees', () => {
    const n = nativeDatabase(); n.start('worker'); n.observe();
    n.event('orphan-result', { WorkResult: { work: { activationId: 'unknown', startEffectId: 'missing', agentInstanceId: null }, result: { Completed: { output_json: '{}', route_key: null } }, physical: null } });
    expect(() => n.observe()).toThrow('Accepted work event has no matching Start'); n.close();
  });
  test('rejects an unattached handoff', () => {
    const n = nativeDatabase(); n.start('worker'); n.observe();
    n.db.query('INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?)').run('s', 'i', 'missing-effect', '{"kind":"nativeOwnedHandoff030","effectId":"missing-effect"}');
    expect(() => n.observe()).toThrow('Unattached or contradictory handoff'); n.close();
  });
  test('rejects an effect absent from its event receipt in either durable copy', () => {
    const n = nativeDatabase(); n.start('worker'); n.observe();
    const saved = n.state.events.enter;
    saved.receipt.effectIds = [];
    n.db.query('UPDATE engine_flow030_events SET receipt_json=? WHERE event_id=?').run(JSON.stringify(saved.receipt), 'enter');
    expect(() => n.observe()).toThrow('Event effects differ in either direction'); n.close();
  });
  test('preserves refusal of a global Stop as a branch cancellation source', () => {
    const n = compositionDatabase();
    n.db.query("UPDATE engine_flow030_events SET event_json=json_set(event_json,'$.kind','Stop') WHERE event_id=?").run(n.decision.id);
    expect(() => n.observe()).toThrow('Stop effect in a non-cancelled run'); n.close();
  });
  test('rejects duplicated decision ordering', () => {
    const n = lateGroupDatabase('wait');
    n.group('second', [], 'closed', { ordinal: n.snapshot.decidedOrdinal });
    expect(() => n.observe()).toThrow('Join order is unavailable'); n.close();
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
