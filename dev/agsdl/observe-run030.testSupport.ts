import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeRun030 } from './observe-run030';

const directories: string[] = [];
export function cleanupObservedDatabases030() { for (const dir of directories.splice(0)) rmSync(dir, { force: true, recursive: true }); }

export function nativeDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'agsdl-native-observe-'));
  directories.push(dir);
  const path = join(dir, 'run.sqlite'), db = new Database(path);
  db.exec(`CREATE TABLE engine_flow030_runs(system_id TEXT,invocation_id TEXT,state_json TEXT,plan_json TEXT);
    CREATE TABLE engine_flow030_outbox(system_id TEXT,invocation_id TEXT,effect_id TEXT,event_id TEXT,effect_json TEXT,status TEXT,settlement_json TEXT);
    CREATE TABLE engine_flow030_handoffs(system_id TEXT,invocation_id TEXT,effect_id TEXT,receipt_json TEXT);
    CREATE TABLE engine_flow030_events(system_id TEXT,invocation_id TEXT,event_id TEXT,event_json TEXT,diagnostic_json TEXT,receipt_json TEXT);
    CREATE TABLE engine_flow030_call_receipts(system_id TEXT,invocation_id TEXT,activation_id TEXT,start_effect_id TEXT,call_kind TEXT,status TEXT,terminal_event_id TEXT,result_json TEXT,physical_receipt_id TEXT);
    CREATE TABLE engine_flow030_human_requests(system_id TEXT,invocation_id TEXT,request_id TEXT,request_kind TEXT,work_refs_json TEXT,status TEXT,resolution_json TEXT,delivery_status TEXT);
    CREATE TABLE engine_flow030_work_timeouts(system_id TEXT,invocation_id TEXT,activation_id TEXT,start_effect_id TEXT,status TEXT,terminal_event_id TEXT,physical_receipt_id TEXT);
    CREATE TABLE engine_flow030_group_decisions(system_id TEXT,invocation_id TEXT,group_id TEXT,event_id TEXT);`);
  type ObjectRow = Record<string, any>;
  const identity = { systemStartId: 's', flowInvocationId: 'i', snapshotId: 'snapshot', epoch: 'epoch' };
  const state: ObjectRow = { identity, revision: '0', verdict: 'succeeded', entered: true, activations: [], instances: [], groups: [], paths: [], preparations: [], preparationReceipts: {}, events: {}, visits: {} };
  const plan: ObjectRow = { steps: [], agents: [], joins: [], routes: [] };
  let lastEventId = 'enter', autoEnd = false;
  const removeEnd = () => {
    if (!autoEnd) return;
    db.exec("DELETE FROM engine_flow030_outbox WHERE effect_id='run-ended'");
    for (const entry of Object.values(state.events) as ObjectRow[]) entry.receipt.effectIds = entry.receipt.effectIds.filter((id: string) => id !== 'run-ended');
    for (const [id, entry] of Object.entries(state.events) as Array<[string, ObjectRow]>) db.query('UPDATE engine_flow030_events SET receipt_json=? WHERE event_id=?').run(JSON.stringify(entry.receipt), id);
    autoEnd = false;
  };
  const event = (id: string, kind: ObjectRow) => {
    removeEnd();
    const receipt = state.events[id]?.receipt ?? { eventId: id, revision: String(Object.keys(state.events).length + 1), effectIds: [] };
    const eventJson = JSON.stringify({ identity, eventId: id, expectedRevision: String(Number(receipt.revision) - 1), kind });
    if (state.events[id]) db.query('UPDATE engine_flow030_events SET event_json=? WHERE event_id=?').run(eventJson, id);
    else db.query('INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,?)').run('s', 'i', id, eventJson, null, JSON.stringify(receipt));
    state.events[id] = { eventJson, receipt }; state.revision = String(Object.keys(state.events).length); lastEventId = id;
  };
  event('enter', { Enter: { message_json: '{}' } });
  const effect = (id: string, kind: ObjectRow, eventId = 'enter', settlement: ObjectRow | null = null) => {
    removeEnd();
    if (!state.events[eventId]) throw new Error(`Test effect has no event: ${eventId}`);
    const receipt = state.events[eventId].receipt;
    receipt.effectIds.push(id);
    db.query('UPDATE engine_flow030_events SET receipt_json=? WHERE event_id=?').run(JSON.stringify(receipt), eventId);
    db.query('INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?)').run('s', 'i', id, eventId, JSON.stringify({ id, identity, revision: receipt.revision, kind }), 'settled', JSON.stringify(settlement ?? { kind: 'nativeOwnedHandoff030', effectId: id }));
  };
  const start = (target: string, type = 'agent', options: { message?: string; item?: string; index?: string; declaration?: ObjectRow; deferTerminal?: boolean } = {}) => {
    const origin = state.activations.find((a: ObjectRow) => a.startEffectId);
    const id = `a${state.activations.length}`, startEffectId = `start-${id}`;
    const step = target.split('/'), work = { activationId: id, startEffectId, agentInstanceId: type === 'agent' ? `instance-${id}` : null };
    const activation: ObjectRow = { id, step, physical: false, phase: 'done', startEffectId, instanceId: work.agentInstanceId, agent: type === 'agent' ? 'synthetic-agent' : null, context: [], stopEffectId: null,
      messageJson: options.message ?? null,
      itemJson: options.item ?? null, occurrence: options.index === undefined ? null : { itemIndex: options.index },
      result: { kind: 'completed', outputJson: '{"text":"Done."}', routeKey: null } };
    state.activations.push(activation);
    if (type === 'agent') state.instances.push({ id: work.agentInstanceId, agent: activation.agent, current: null, queue: [], discarded: false });
    if (!plan.steps.some((s: ObjectRow) => s.address.join('/') === target)) {
      plan.steps.push({ address: step, type, declarationJson: JSON.stringify({ type,
        ...(type === 'approval' ? { next: { ok: [], revise: [], publish: [] } } : {}), ...options.declaration }) });
    }
    let cause = 'enter', sender: ObjectRow | null = null;
    if (!origin) plan.entry = step;
    else {
      if (!origin.result) throw new Error('Synthetic route origin needs a terminal');
      const routeKind = origin.result.kind === 'failed' ? 'error' : 'normal';
      sender = { activationId: origin.id, step: origin.step, kind: plan.steps.find((s: ObjectRow) => s.address.join('/') === origin.step.join('/')).type,
        inputJson: origin.inputJson ?? 'null', messageJson: origin.messageJson, itemJson: origin.itemJson,
        outputJson: origin.result.kind === 'failed' ? JSON.stringify({ error: origin.result.error }) : origin.result.outputJson };
      const prepareId = `prepare-${origin.id}-${routeKind}`, nativeReceiptId = `receipt-${prepareId}`;
      let p = state.preparations.find((p: ObjectRow) => p.reference.prepareId === prepareId);
      if (!p) {
        const reference = { identity, activationId: origin.id, prepareId, revision: state.events[`terminal-${origin.id}`].receipt.revision, route: { source: origin.step, kind: routeKind, key: origin.result.routeKey ?? null }, context: JSON.parse(JSON.stringify(origin.context)) };
        p = { reference, producer: sender, status: 'consumed' }; state.preparations.push(p);
        plan.routes.push({ source: origin.step, kind: routeKind, key: origin.result.routeKey ?? null });
        state.preparationReceipts[nativeReceiptId] = prepareId;
        effect(`effect-${prepareId}`, { kind: 'prepareRoute', reference, producer: sender }, `terminal-${origin.id}`, { kind: 'nativeRoutePrepared030', nativeReceiptId });
      }
      cause = `prepared-${prepareId}`;
      const batches = state.events[cause] ? JSON.parse(state.events[cause].eventJson).kind.Prepared.result.Ready.batches : [];
      const occurrence = { nativeReceiptId, targetOrdinal: batches.length, itemIndex: options.index ?? '0' };
      activation.occurrence = occurrence;
      batches.push({ targetOrdinal: batches.length, target: { kind: 'step', address: step }, items: [{ messageJson: activation.messageJson, itemJson: activation.itemJson, occurrence }] });
      event(cause, { Prepared: { reference: p.reference, native_receipt_id: nativeReceiptId, result: { Ready: { batches } } } });
    }
    activation.producer = sender; activation.inputJson = sender?.outputJson ?? 'null';
    effect(startEffectId, { kind: 'start', work, step, agent: activation.agent, messageJson: options.message ?? null, itemJson: activation.itemJson, occurrence: activation.occurrence, sender }, cause);
    db.query('INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?)').run('s', 'i', startEffectId, JSON.stringify({ kind: 'nativeOwnedHandoff030', effectId: startEffectId }));
    if (!options.deferTerminal) terminal(work, activation.result);
    else activation.result = null;
    return { activation, work };
  };
  const terminal = (work: ObjectRow, result: ObjectRow) => {
    const id = `terminal-${work.activationId}`, physicalId = `physical-${work.activationId}`;
    state.activations.find((a: ObjectRow) => a.id === work.activationId).result = result;
    const wireResult = result.kind === 'completed'
      ? { Completed: { output_json: result.outputJson, route_key: result.routeKey } }
      : { Failed: { error: result.error } };
    event(id, { WorkResult: { work, result: wireResult, physical: { native_receipt_id: physicalId, descendants_joined: true } } });
    return { id, physicalId };
  };
  const call = (work: ObjectRow, result = { kind: 'completed', outputJson: '{"outcome":"passed","data":{"exitCode":0,"output":""}}', routeKey: null }, kind = 'command') => {
    const end = terminal(work, result);
    db.query('INSERT INTO engine_flow030_call_receipts VALUES (?,?,?,?,?,?,?,?,?)').run('s', 'i', work.activationId, work.startEffectId, kind, 'ended', end.id, JSON.stringify(result), end.physicalId);
  };
  const failure = (activation: ObjectRow, code: string, counted = true) => {
    if (activation.startEffectId) terminal({ activationId: activation.id, startEffectId: activation.startEffectId, agentInstanceId: activation.instanceId }, { kind: 'failed', error: { code } });
    effect(`failure-${activation.id}`, { kind: 'failure', activationId: activation.id, step: activation.step, error: { code }, counted }, lastEventId);
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
  const internal = (id: string, target: string, type: string) => {
    const a: ObjectRow = { id, step: target.split('/'), startEffectId: null, stopEffectId: null, instanceId: null, agent: null, context: [], phase: 'done', physical: false, result: null };
    state.activations.push(a);
    if (!plan.steps.some((s: ObjectRow) => s.address.join('/') === target)) plan.steps.push({ address: a.step, type, declarationJson: JSON.stringify({ type }) });
    return a;
  };
  const group = (name: string, members: Array<{ name: string; activation: ObjectRow; accepted?: boolean; excluded?: boolean; fanout?: boolean }>, outcome = 'done', options: { ordinal?: string; owner?: ObjectRow; eventId?: string } = {}) => {
    const id = `group-${state.groups.length}`, owner = options.owner ?? internal(`join-${id}`, name, 'join');
    plan.joins.push({ address: name.split('/'), mode: ['reached', 'missed'].includes(outcome) ? 'quorum' : 'all', accept: members.filter((m) => m.accepted).map((m) => JSON.parse(m.activation.result.outputJson).choice) });
    const branches: ObjectRow[] = [], outputs: ObjectRow = {};
    const grouped = new Map<string, typeof members>();
    for (const member of members) grouped.set(member.name, [...(grouped.get(member.name) ?? []), member]);
    for (const [branch, values] of grouped) {
      const pathIds: string[] = [], valuesOut: ObjectRow[] = [];
      for (const [index, member] of values.entries()) {
        const pathId = `${id}-${branch}-${index}`, a = member.activation;
        const result = a.result?.kind === 'completed' ? a.result.outputJson : a.result?.kind === 'failed' ? JSON.stringify({ ended: 'failed', error: a.result.error }) : null;
        const p = a.result?.kind === 'completed' ? { activationId: a.id, step: a.step, kind: 'agent', outputJson: result } : null;
        const m = { groupId: id, branch, phase: member.excluded ? 'excluded' : 'ended', resultJson: member.excluded ? null : result, producer: member.excluded ? null : p, accepted: member.accepted ?? false, failed: !member.excluded && a.result?.kind === 'failed' };
        a.context.push({ kind: 'path', pathId, departedGroups: [] });
        state.paths.push({ id: pathId, itemJson: a.itemJson ?? null, context: a.context, memberships: [m], phase: 'ended' }); pathIds.push(pathId);
        if (m.resultJson !== null && (outcome !== 'reached' || m.accepted)) valuesOut.push({ ...JSON.parse(m.resultJson), ...(member.fanout ? { item: JSON.parse(a.itemJson) } : {}) });
      }
      const fanout = values.some((m) => m.fanout);
      branches.push({ name: branch, fanout, pathIds });
      if (fanout) outputs[branch] = valuesOut; else if (valuesOut.length) outputs[branch] = valuesOut[0];
    }
    const outputJson = ['done', 'incomplete', 'reached', 'missed'].includes(outcome) ? JSON.stringify({ outcome, branches: outputs }) : null;
    owner.result = outputJson === null ? null : { kind: 'completed', outputJson, routeKey: outcome };
    state.groups.push({ id, join: name.split('/'), activationId: owner.id, originActivationId: state.activations.find((a: ObjectRow) => a.startEffectId)?.id ?? owner.id, branches, decision: outcome, decidedOrdinal: options.ordinal ?? String(state.groups.length + 1), outputJson, released: true });
    db.query('INSERT INTO engine_flow030_group_decisions VALUES (?,?,?,?)').run('s', 'i', id, options.eventId ?? lastEventId);
    return state.groups.at(-1);
  };
  const persist = () => {
    if (!autoEnd) { effect('run-ended', { kind: 'runEnded', verdict: state.verdict }, lastEventId); autoEnd = true; }
    db.exec('DELETE FROM engine_flow030_runs');
    db.query('INSERT INTO engine_flow030_runs VALUES (?,?,?,?)').run('s', 'i', JSON.stringify(state), JSON.stringify(plan));
  };
  const observe = () => { persist(); return observeRun030(path, 's', 'i'); };
  return { path, db, state, plan, start, effect, event, terminal, call, failure, human, internal, group, persist, observe, close: () => db.close() };
}
