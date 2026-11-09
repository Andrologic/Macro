import { Database } from 'bun:sqlite';
import { SchemaChecker } from '../../src/vendor/agsdl/v0.3/schemacheck.mjs';
import schema030 from '../../src/vendor/agsdl/v0.3/schema/agsdl.schema.json';
import { NumberToken, parse, stringify, type ExactValue } from '../../src/vendor/agsdl/v0.3/json.mjs';
import { compareNumbers, isInteger } from '../../src/vendor/agsdl/v0.3/values.mjs';

// The caller closes the native application and its pool before opening this reader.
// This observer accepts durable rows only and never controls the run.
type Obj = Record<string, ExactValue>;

// Native reader contract. These are required tables (or native SQL views), not
// fallback data inferred from the scenario. Writers remain owned by N-CALLS and
// N-HUMAN. All queries additionally filter system_id AND invocation_id.
// engine_flow030_call_receipts:
export type CallReceiptRow030 = {
  activation_id: string;
  start_effect_id: string;
  call_kind: 'command' | 'mcp';
} & ({
  status: 'ended';
  terminal_event_id: string;
  result_json: string; // WorkResultRecord030, including kind: completed | failed
  physical_receipt_id: string;
} | {
  status: 'pending' | 'uncertain';
  terminal_event_id: string | null;
  result_json: string | null;
  physical_receipt_id: string | null;
});
// engine_flow030_human_requests, one row per native request. work_refs_json is
// an array of exact WorkRef030 values, including startEffectId/agentInstanceId.
export interface HumanRequestRow030 {
  request_id: string;
  request_kind: 'ask' | 'plan' | 'question' | 'approval';
  work_refs_json: string;
  status: 'open' | 'resolved' | 'revoked';
  resolution_json: string | null; // HumanResolution030
  delivery_status: 'pending' | 'uncertain' | 'delivered' | 'revoked';
}
export type HumanResolution030 =
  | { reason: 'answerTimeout'; answerJson: '"no"' }
  | { reason: 'person'; answerJson: string; approvalTiming?: ApprovalTiming030 }
  | { reason: 'approvalTimeout'; answerJson: null; approvalTiming: ApprovalTiming030 };
// Required for resolved approvals. Native monotone instants and the captured
// timeout duration are canonical decimal strings, not JavaScript numbers.
export interface ApprovalTiming030 {
  openedAtMs: string;
  resolvedAtMs: string;
  timeoutMs: string | null;
}
// engine_flow030_work_timeouts. A timeout is not a branch cancellation.
export type TimeoutReceiptRow030 = {
  activation_id: string;
  start_effect_id: string;
} & ({
  status: 'joined';
  terminal_event_id: string;
  physical_receipt_id: string;
} | {
  status: 'pending' | 'uncertain';
  terminal_event_id: string | null;
  physical_receipt_id: string | null;
});
// Steer settlement in engine_flow030_outbox.settlement_json. A handoff alone
// does not prove consumption by the physical work.
export interface SteerConsumption030 {
  kind: 'nativeSteerConsumed030';
  effectId: string;
  deliveryActivationId: string;
  work: { activationId: string; startEffectId: string; agentInstanceId: string | null };
  messageJson: string;
}
const object = (v: ExactValue | undefined): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof NumberToken);
const raw = (s: string): ExactValue => {
  const result = parse(new TextEncoder().encode(s));
  if (result.error) throw new Error('Invalid durable JSON');
  return result.tree;
};
const string = (v: ExactValue | undefined): string => {
  if (typeof v !== 'string') throw new Error('Expected durable string');
  return v;
};
const record = (v: ExactValue | undefined): Obj => {
  if (!object(v)) throw new Error('Expected durable object');
  return v;
};
const address = (v: ExactValue | undefined): string => {
  if (!Array.isArray(v) || !v.length || !v.every((p) => typeof p === 'string' && p.length)) throw new Error('Invalid durable address');
  return v.join('/');
};
const optionalItem = (activation: Obj): Obj => {
  if (activation.itemJson === null || activation.itemJson === undefined) return {};
  const occurrence = record(activation.occurrence);
  const item = string(occurrence.itemIndex);
  if (!/^(0|[1-9][0-9]*)$/.test(item)) throw new Error('Invalid item index');
  return { item: new NumberToken(item), element: raw(string(activation.itemJson)) };
};
const sourceShape030 = new SchemaChecker({ $ref: '#/$defs/source', $defs: schema030.$defs });
const resources = (value: ExactValue | undefined): Obj | undefined => {
  if (value === undefined || value === null) return undefined;
  const result: Obj = Object.create(null);
  for (const [name, resource] of Object.entries(record(value))) {
    const source = record(resource);
    if (sourceShape030.check(source).length) throw new Error('Unresolved resource source');
    result[name] = Object.hasOwn(source, 'value') ? source.value : source;
  }
  return result;
};

const same = (a: ExactValue | undefined, b: ExactValue | undefined): boolean => {
  if (a instanceof NumberToken || b instanceof NumberToken) return a instanceof NumberToken && b instanceof NumberToken && a.raw === b.raw;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (object(a)) return object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
  return a === b;
};

function comments(value: ExactValue): ExactValue[] {
  if (!Array.isArray(value)) throw new Error('Unresolved message comments');
  for (const entry of value) {
    const comment = record(entry);
    if (typeof comment.step !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}(\/[A-Za-z][A-Za-z0-9_-]{0,63})*$/.test(comment.step)
      || typeof comment.comment !== 'string' || !comment.comment.length
      || Object.keys(comment).some((k) => k !== 'step' && k !== 'comment')) throw new Error('Unresolved message comments');
  }
  return value;
}

function verifyApprovalResolution(activation: Obj, start: Obj, step: Obj, resolution: Obj): void {
  const result = record(activation.result);
  if (resolution.reason === 'person') {
    if (result.kind !== 'completed') throw new Error('Approval resolution contradicts terminal result');
    const answer = record(raw(string(resolution.answerJson))), output = record(raw(string(result.outputJson)));
    if (output.choice !== answer.choice || output.comment !== answer.comment || result.routeKey !== answer.choice) throw new Error('Approval decision differs from terminal output');
    const message = start.messageJson === null ? {} : record(raw(string(start.messageJson)));
    if (!same(output.message, message)) throw new Error('Approval terminal message differs');
  } else if (resolution.reason !== 'approvalTimeout' || result.kind !== 'failed' || record(result.error).code !== 'APPROVAL_TIMEOUT') {
    throw new Error('Approval resolution contradicts terminal result');
  }
  const declaration = record(raw(string(step.declarationJson)));
  if (resolution.reason === 'person') {
    const answer = record(raw(string(resolution.answerJson)));
    if (!Object.hasOwn(record(declaration.next), string(answer.choice))) throw new Error('Approval choice is not declared');
  }
  if (!object(resolution.approvalTiming)) throw new Error('Approval timing is absent');
  const timing = resolution.approvalTiming;
  const milliseconds = (value: ExactValue | undefined): bigint => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid approval timing');
    return BigInt(value);
  };
  const opened = milliseconds(timing.openedAtMs), resolved = milliseconds(timing.resolvedAtMs);
  if (resolved < opened) throw new Error('Approval resolution precedes request');
  const timeout = timing.timeoutMs === null ? null : milliseconds(timing.timeoutMs);
  if (declaration.timeoutMs === undefined) {
    if (timeout !== null) throw new Error('Approval deadline differs from captured timeout');
  } else if (!(declaration.timeoutMs instanceof NumberToken) || !isInteger(declaration.timeoutMs)
    || timeout === null || timeout === 0n || compareNumbers(declaration.timeoutMs, new NumberToken(timeout.toString())) !== 0) {
    throw new Error('Approval deadline differs from captured timeout');
  }
  const expired = timeout !== null && resolved >= opened + timeout;
  if (resolution.reason === 'approvalTimeout' ? !expired : expired) throw new Error('Approval resolution contradicts deadline');
}

export function observeRun030(databasePath: string, systemId: string, invocationId: string): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    db.exec('BEGIN');
    const run = db.query('SELECT state_json,plan_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?').get(systemId, invocationId) as { state_json: string; plan_json: string } | null;
    if (!run) throw new Error('Run is absent');
    const plan = record(raw(run.plan_json));
    if (!Array.isArray(plan.steps) || !Array.isArray(plan.agents)) throw new Error('Invalid durable plan');
    const steps = new Map(plan.steps.map(record).map((step) => [address(step.address), step]));
    const diagnostic = db.query('SELECT 1 FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND diagnostic_json IS NOT NULL LIMIT 1').get(systemId, invocationId);
    if (diagnostic) throw new Error('Flow diagnostic remains');
    const state = record(raw(run.state_json));
    if (state.verdict !== 'succeeded' && state.verdict !== 'failed') throw new Error('Run is not terminal');
    if (!Array.isArray(state.activations) || !Array.isArray(state.groups)) throw new Error('Invalid durable state');
    const activations = state.activations.map(record);
    if (activations.some((a) => a.physical !== false)) throw new Error('Physical work remains');
    if (activations.some((a) => a.phase !== undefined && a.phase !== 'done')
      || (Array.isArray(state.preparations) && state.preparations.map(record).some((p) => p.status === 'pending'))
      || state.groups.map(record).some((g) => g.released === false)) throw new Error('Pending native activity remains');
    const byId = new Map(activations.map((a) => [string(a.id), a]));
    if (byId.size !== activations.length) throw new Error('Duplicate activation');
    const rows = db.query('SELECT effect_id,event_id,effect_json,status FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? ORDER BY rowid').all(systemId, invocationId) as Array<{ effect_id: string; event_id: string; effect_json: string; status: string }>;
    const starts: Record<string, number> = Object.create(null);
    const messages: Obj[] = [], failures: Obj[] = [], cancelled: Obj[] = [], answers: Obj[] = [];
    const startsByActivation = new Map<string, Obj>();
    const hasTable = (name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE name=? AND type IN ('table','view')").get(name);
    const event = (id: string): Obj => {
      const row = db.query('SELECT event_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?').get(systemId, invocationId, id) as { event_json: string } | null;
      if (!row) throw new Error('Native terminal event is absent');
      return record(raw(row.event_json));
    };
    const terminal = (id: string, start: Obj, physicalId: string): Obj => {
      const workResult = record(record(event(id).kind).WorkResult);
      const physical = record(workResult.physical);
      if (!physicalId || physical.native_receipt_id !== physicalId || physical.descendants_joined !== true || !same(workResult.work, start.work)) throw new Error('Native terminal proof differs');
      const result = record(workResult.result);
      if (Object.keys(result).length !== 1) throw new Error('Invalid native terminal result');
      if (result.Completed !== undefined) {
        const completed = record(result.Completed);
        return { kind: 'completed', outputJson: string(completed.output_json), routeKey: completed.route_key ?? null };
      }
      return { kind: 'failed', error: record(record(result.Failed).error) };
    };
    const timeoutRows = hasTable('engine_flow030_work_timeouts')
      ? db.query('SELECT activation_id,start_effect_id,status,terminal_event_id,physical_receipt_id FROM engine_flow030_work_timeouts WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as TimeoutReceiptRow030[] : [];
    const timeouts = new Map(timeoutRows.map((row) => [row.activation_id, row]));
    if (timeouts.size !== timeoutRows.length) throw new Error('Duplicate timeout receipt');
    for (const row of rows) {
      if (row.status !== 'settled') throw new Error('Pending or uncertain effect remains');
      const effect = record(raw(row.effect_json)), kind = record(effect.kind);
      if (kind.kind === 'start' || kind.kind === 'steer') {
        const work = record(kind.work), physical = byId.get(string(work.activationId));
        const activation = kind.kind === 'start' ? physical : byId.get(string(kind.deliveryActivationId));
        if (!activation || !physical) throw new Error('Delivery activation is absent');
        const target = address(activation.step);
        if (kind.kind === 'start') {
          if (address(kind.step) !== target || startsByActivation.has(string(work.activationId)) || work.startEffectId !== row.effect_id
            || (activation.startEffectId !== undefined && activation.startEffectId !== row.effect_id)
            || ['compose', 'join'].includes(String(steps.get(target)?.type))) throw new Error('Start activation differs');
          const handoff = db.query('SELECT receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=?').get(systemId, invocationId, row.effect_id) as { receipt_json: string } | null;
          if (!handoff) throw new Error('Start handoff is absent');
          const receipt = record(raw(handoff.receipt_json));
          if (receipt.kind !== 'nativeOwnedHandoff030' || receipt.effectId !== row.effect_id) throw new Error('Start handoff differs');
          startsByActivation.set(string(work.activationId), kind);
          starts[target] = (starts[target] ?? 0) + 1;
        } else {
          const settlement = db.query('SELECT settlement_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?').get(systemId, invocationId, row.effect_id) as { settlement_json: string | null };
          if (!settlement.settlement_json) throw new Error('Steer consumption is absent');
          const receipt = record(raw(settlement.settlement_json));
          if (receipt.kind !== 'nativeSteerConsumed030' || receipt.effectId !== row.effect_id
            || receipt.deliveryActivationId !== kind.deliveryActivationId || receipt.messageJson !== kind.messageJson
            || kind.deliveryActivationId === work.activationId || !same(receipt.work, work)
            || !same(startsByActivation.get(string(work.activationId))?.work, work)) throw new Error('Steer consumption differs');
        }
        const message = kind.messageJson === null ? {} : record(raw(string(kind.messageJson)));
        if (message.prompt !== undefined && message.prompt !== null && typeof message.prompt !== 'string') throw new Error('Prompt is unresolved');
        const rowItem = optionalItem(activation);
        const out: Obj = { to: target, prompt: message.prompt ?? null, ...rowItem };
        const delivered = resources(message.resources);
        if (delivered !== undefined) out.resources = delivered;
        if (message.comments !== undefined) out.comments = comments(message.comments);
        messages.push(out);
      } else if (kind.kind === 'failure') {
        const activation = byId.get(string(kind.activationId));
        if (!activation) throw new Error('Failed activation is absent');
        if (address(kind.step) !== address(activation.step)) throw new Error('Failed activation differs');
        const item = optionalItem(activation);
        if (typeof kind.counted !== 'boolean') throw new Error('Failure contribution is absent');
        failures.push({ step: address(kind.step), ...(item.item === undefined ? {} : { item: item.item }), code: string(record(kind.error).code), ...(kind.counted === false ? { counted: false } : {}) });
        if (record(kind.error).code === 'TIMEOUT' && !timeouts.has(string(kind.activationId))) throw new Error('Timeout receipt is absent');
      } else if (kind.kind === 'stopWork') {
        const source = event(row.event_id).kind;
        if (source === 'Stop') throw new Error('Stop effect in a non-cancelled run');
        const cause = record(source);
        if (Object.keys(cause).length !== 1 || !['WorkResult', 'Prepared', 'PhysicalEnded'].some((key) => Object.hasOwn(cause, key))) throw new Error('Unprojectable stop cause');
        const activation = byId.get(string(record(kind.work).activationId));
        if (!activation) throw new Error('Stopped activation is absent');
        if (!same(startsByActivation.get(string(activation.id))?.work, kind.work)) throw new Error('Stopped work binding differs');
        if (activation.stopEffectId !== row.effect_id) throw new Error('Stopped activation stopEffectId differs');
        const body = record(cause.WorkResult ?? cause.PhysicalEnded ?? cause.Prepared);
        if (cause.Prepared !== undefined) {
          if (!byId.has(string(record(body.reference).activationId))) throw new Error('Stop preparation activation is absent');
          if (!string(body.native_receipt_id)) throw new Error('Stop preparation receipt is absent');
          record(body.result);
        } else {
          const sourceWork = record(body.work);
          if (!same(startsByActivation.get(string(sourceWork.activationId))?.work, sourceWork)) throw new Error('Stop cause work binding differs');
          if (cause.WorkResult !== undefined) {
            const result = record(body.result);
            if (Object.keys(result).length !== 1 || (result.Completed === undefined && result.Failed === undefined)) throw new Error('Invalid stop cause result');
            if (result.Completed !== undefined) raw(string(record(result.Completed).output_json));
            else string(record(record(result.Failed).error).code);
          }
          if (cause.PhysicalEnded !== undefined || body.physical !== null) {
            const proof = cause.PhysicalEnded !== undefined ? body.evidence : body.physical;
            if (!object(proof) || proof.descendants_joined !== true || typeof proof.native_receipt_id !== 'string' || !proof.native_receipt_id) throw new Error('Invalid physical stop cause');
          }
        }
        // The causal event precedes the StopWork. A proof in that event, or an
        // earlier event, cannot say that the cancelled work had already ended.
        const preceding = db.query('SELECT event_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND rowid <= (SELECT rowid FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?)').all(systemId, invocationId, systemId, invocationId, row.event_id) as Array<{ event_json: string }>;
        for (const prior of preceding) {
          const priorKind = record(raw(prior.event_json)).kind;
          if (!object(priorKind)) continue;
          const ended = priorKind.WorkResult ?? priorKind.PhysicalEnded;
          if (!object(ended) || !object(ended.work) || ended.work.activationId !== activation.id) continue;
          if (!same(ended.work, kind.work)) throw new Error('Physical cancellation work binding differs');
          const evidence = priorKind.WorkResult !== undefined ? ended.physical : ended.evidence;
          if (evidence !== undefined && evidence !== null) {
            const physical = record(evidence);
            if (physical.descendants_joined !== true || !string(physical.native_receipt_id)) throw new Error('Invalid physical cancellation evidence');
            throw new Error('Physical end precedes work cancellation');
          }
        }
        const item = optionalItem(activation);
        if (!timeouts.has(string(activation.id))) cancelled.push({ step: address(activation.step), ...(item.item === undefined ? {} : { item: item.item }) });
      } else if (kind.kind !== 'prepareRoute' && kind.kind !== 'return' && kind.kind !== 'runEnded') {
        throw new Error('Unprojectable effect kind');
      }
    }
    const callRows = hasTable('engine_flow030_call_receipts')
      ? db.query('SELECT activation_id,start_effect_id,call_kind,status,terminal_event_id,result_json,physical_receipt_id FROM engine_flow030_call_receipts WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as CallReceiptRow030[] : [];
    const calls = new Map(callRows.map((row) => [row.activation_id, row]));
    if (calls.size !== callRows.length) throw new Error('Duplicate call receipt');
    for (const row of callRows) {
      const activation = byId.get(row.activation_id), start = startsByActivation.get(row.activation_id);
      if (!activation || !start || steps.get(address(activation.step))?.type !== 'call'
        || row.start_effect_id !== record(start.work).startEffectId) throw new Error('Call receipt binding differs');
      if (row.status !== 'ended') throw new Error('Pending or uncertain call remains');
      const declaration = record(raw(string(steps.get(address(activation.step))!.declarationJson)));
      if (row.call_kind !== (declaration.command !== undefined ? 'command' : declaration.mcp !== undefined ? 'mcp' : null)) throw new Error('Call receipt kind differs');
      const result = terminal(row.terminal_event_id, start, row.physical_receipt_id);
      if (!same(result, raw(row.result_json)) || !same(result, activation.result)) throw new Error('Call terminal result differs');
    }
    for (const [id] of startsByActivation) {
      if (steps.get(address(byId.get(id)!.step))?.type === 'call' && !calls.has(id)) throw new Error('Call receipt is absent');
    }
    for (const row of timeoutRows) {
      const start = startsByActivation.get(row.activation_id), activation = byId.get(row.activation_id);
      if (!activation || !start || row.start_effect_id !== record(start.work).startEffectId) throw new Error('Timeout receipt binding differs');
      if (row.status !== 'joined') throw new Error('Pending or uncertain timeout remains');
      const result = terminal(row.terminal_event_id, start, row.physical_receipt_id);
      if (result.kind !== 'failed' || record(result.error).code !== 'TIMEOUT' || !same(result, activation.result)
        || !rows.some((r) => { const k = record(record(raw(r.effect_json)).kind); return k.kind === 'failure' && k.activationId === row.activation_id && record(k.error).code === 'TIMEOUT'; })) throw new Error('Timeout terminal result differs');
    }
    const humanSchema = hasTable('engine_flow030_human_requests');
    const needsHumans = [...steps.values()].some((s) => s.type === 'approval' || (s.type === 'call' && record(raw(string(s.declarationJson))).mcp !== undefined))
      || plan.agents.map(record).some((a) => {
        const declaration = record(raw(string(a.agentDeclarationJson)));
        return Object.hasOwn(declaration, 'answerTimeoutMs') || declaration.planFirst === 'ask'
          || (object(declaration.permissions) && declaration.permissions.reviewer === 'person');
      });
    if (needsHumans && !humanSchema) throw new Error('Answers are not projectable: native human schema is absent');
    const humans = humanSchema ? db.query('SELECT request_id,request_kind,work_refs_json,status,resolution_json,delivery_status FROM engine_flow030_human_requests WHERE system_id=? AND invocation_id=? ORDER BY request_id').all(systemId, invocationId) as HumanRequestRow030[] : [];
    const requestIds = new Set<string>(), approvals = new Set<string>();
    for (const row of humans) {
      if (!row.request_id || requestIds.has(row.request_id)) throw new Error('Duplicate human request');
      requestIds.add(row.request_id);
      if (!['ask', 'plan', 'question', 'approval'].includes(row.request_kind)) throw new Error('Unprojectable human request');
      const refs = raw(row.work_refs_json);
      if (!Array.isArray(refs)) throw new Error('Invalid human work references');
      const attributed = new Set<string>();
      for (const ref of refs) {
        const id = string(record(ref).activationId), start = startsByActivation.get(id);
        if (!start || !same(start.work, ref) || attributed.has(id)) throw new Error('Human work binding differs');
        attributed.add(id);
        const type = steps.get(address(byId.get(id)!.step))?.type;
        if ((row.request_kind === 'ask' || row.request_kind === 'plan') && type !== 'agent'
          || row.request_kind === 'question' && type !== 'agent' && type !== 'call') throw new Error('Human request kind differs');
        if (row.request_kind === 'approval') {
          if (steps.get(address(byId.get(id)!.step))?.type !== 'approval' || approvals.has(id)) throw new Error('Approval binding differs');
          approvals.add(id);
        }
      }
      if (row.request_kind === 'approval' && attributed.size !== 1) throw new Error('Approval binding differs');
      if (row.status === 'revoked' && row.delivery_status === 'revoked' && row.resolution_json === null) continue;
      if (row.status !== 'resolved' || row.delivery_status !== 'delivered' || row.resolution_json === null) throw new Error('Pending or uncertain human request remains');
      const resolution = record(raw(row.resolution_json));
      if (!['person', 'answerTimeout', 'approvalTimeout'].includes(string(resolution.reason))) throw new Error('Unprojectable human resolution');
      if (resolution.reason === 'approvalTimeout' && (row.request_kind !== 'approval' || resolution.answerJson !== null)) throw new Error('Approval timeout binding differs');
      if (resolution.reason === 'person') {
        const answer = raw(string(resolution.answerJson));
        if ((row.request_kind === 'ask' || row.request_kind === 'plan') && answer !== 'yes' && answer !== 'no') throw new Error('Unprojectable human answer');
        if (row.request_kind === 'approval' && (typeof record(answer).choice !== 'string' || typeof record(answer).comment !== 'string')) throw new Error('Unprojectable approval answer');
      }
      if (row.request_kind === 'approval') {
        const id = [...attributed][0], activation = byId.get(id)!;
        verifyApprovalResolution(activation, startsByActivation.get(id)!, steps.get(address(activation.step))!, resolution);
      }
      if (resolution.reason === 'answerTimeout') {
        if (row.request_kind === 'approval' || raw(string(resolution.answerJson)) !== 'no' || !attributed.size) throw new Error('Automatic refusal differs');
        for (const id of attributed) {
          const activation = byId.get(id)!, item = optionalItem(activation);
          answers.push({ work: address(activation.step), ...(item.item === undefined ? {} : { item: item.item }), answer: 'no' });
        }
      }
    }
    for (const [id] of startsByActivation) {
      if (steps.get(address(byId.get(id)!.step))?.type === 'approval' && !approvals.has(id)) throw new Error('Approval request is absent');
    }
    // A compose visit starts one work (its body), without a physical Start
    // effect or handoff for the wrapper. Use the native admitted visit count.
    const composeVisits: Obj = {};
    for (const [target, step] of steps) if (step.type === 'compose') {
      const n = record(state.visits)[stringify(step.address)];
      if (n !== undefined) {
        if (typeof n !== 'string' || !/^(0|[1-9][0-9]*)$/.test(n)) throw new Error('Invalid compose visit count');
        if (n !== '0') composeVisits[target] = new NumberToken(n);
      }
    }
    const numbered = state.groups.map(record).filter((g) => ['done', 'incomplete', 'reached', 'missed'].includes(String(g.decision)));
    const ordinals = new Set<string>();
    for (const group of numbered) {
      const n = string(group.decidedOrdinal);
      if (!/^[1-9][0-9]*$/.test(n) || ordinals.has(n)) throw new Error('Join order is unavailable');
      ordinals.add(n);
    }
    numbered.sort((a, b) => { const x = string(a.decidedOrdinal), y = string(b.decidedOrdinal); return x.length - y.length || x.localeCompare(y); });
    const joins: Obj[] = numbered.map((group) => {
      const output = record(raw(string(group.outputJson)));
      if (output.outcome !== group.decision) throw new Error('Join output differs');
      return { join: address(group.join), outcome: string(group.decision), branches: record(output.branches) };
    });
    db.exec('COMMIT');
    const counts: Obj = { ...Object.fromEntries(Object.entries(starts).map(([key, value]) => [key, new NumberToken(String(value))])), ...composeVisits };
    return stringify({ run: state.verdict, starts: counts, messages, joins, failures, cancelled, answers, ...(Object.keys(composeVisits).length ? { composeVisits } : {}) });
  } finally { db.close(); }
}
