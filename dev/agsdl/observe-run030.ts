import { Database } from 'bun:sqlite';
import { SchemaChecker } from '../../src/vendor/agsdl/v0.3/schemacheck.mjs';
import schema030 from '../../src/vendor/agsdl/v0.3/schema/agsdl.schema.json';
import { NumberToken, parse, stringify, type ExactValue } from '../../src/vendor/agsdl/v0.3/json.mjs';
import { compareNumbers, isInteger } from '../../src/vendor/agsdl/v0.3/values.mjs';

// The caller closes the native application and its pool before opening this reader.
// This observer accepts durable rows only and never controls the run.
type Obj = Record<string, ExactValue>;

// Provisional adapters for the not-yet-admitted call/human/clock capabilities.
// The native 06c3cfeb + R6 writers do not produce these extension tables. Missing
// evidence refuses only a reached capability that needs it, never an unrelated
// run. Align these adapters with the actual writers when those lots integrate.
// All queries filter system_id AND invocation_id; nothing is inferred from expect.
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
  // Native journal head captured under the admission fence when consumed.
  consumedAfterEventId: string;
}
// Migration 034. These rows commit atomically with the accepted Prepared event.
export interface PreparationRow030 {
  prepare_id: string; native_receipt_id: string; owner_epoch: string; generation: string;
  reference_json: string; producer_json: string; source_json: string;
  content_receipts_json: string; result_json: string;
}
export interface OccurrenceProvenanceRow030 {
  native_receipt_id: string; target_ordinal: number; item_index: string; provenance_json: string;
}
type NativeRoutes030 = {
  preparations: PreparationRow030[]; provenance: OccurrenceProvenanceRow030[];
  owner: { owner_epoch: string; generation: string } | null;
  contentContexts: Array<{ prepare_id: string; target_ordinal: number; item_index: string; context_id: string; owner_epoch: string; generation: string; identity_json: string }>;
  contentReceipts: Array<{ context_id: string; transport_receipt_json: string }>;
};
export type EffectRow030 = { effect_id: string; event_id: string; effect_json: string; owner_epoch: string; status: string; settlement_json: string };
export type EventRow030 = { event_id: string; event_json: string; receipt_json: string };
export type HandoffRow030 = { effect_id: string; owner_epoch: string; generation: string; receipt_json: string };
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

// Validate the complete durable graph before exposing any projection. In
// particular, checking an effect's referenced activation is not sufficient:
// the activation, accepted event, event receipt and retained state must agree.
function verifyDurableGraph(state: Obj, plan: Obj, rows: EffectRow030[], events: EventRow030[], handoffs: HandoffRow030[], native: NativeRoutes030): void {
  const list = (v: ExactValue | undefined): Obj[] => { if (!Array.isArray(v)) throw new Error('Missing durable graph array'); return v.map(record); };
  const unique = (values: Obj[], key: string) => {
    const map = new Map(values.map((v) => [string(v[key]), v]));
    if (map.size !== values.length) throw new Error(`Duplicate durable ${key}`);
    return map;
  };
  const activations = unique(list(state.activations), 'id'), groups = unique(list(state.groups), 'id'), paths = unique(list(state.paths), 'id');
  const instances = unique(list(state.instances), 'id'), batches = unique(list(state.batches), 'id');
  const steps = new Map(list(plan.steps).map((s) => [address(s.address), s]));
  const selectRoute = (source: ExactValue | undefined, kind: string, key: ExactValue | undefined) => list(plan.routes).find((r) => same(r.source, source) && r.kind === kind && r.key === (key ?? null))
    ?? list(plan.routes).find((r) => same(r.source, source) && r.kind === kind && r.key === null);
  const fx = new Map(rows.map((r) => [r.effect_id, { row: r, effect: record(raw(r.effect_json)), kind: record(record(raw(r.effect_json)).kind) }]));
  const ev = new Map(events.map((r, index) => [r.event_id, { row: r, index, event: record(raw(r.event_json)), receipt: record(raw(r.receipt_json)) }]));
  if (fx.size !== rows.length || ev.size !== events.length) throw new Error('Duplicate durable effect or event');
  const retained = record(state.events);
  if (Object.keys(retained).length !== ev.size) throw new Error('Unattached retained event');
  let revision = '0';
  for (const [id, e] of ev) {
    const saved = record(retained[id]);
    if (e.event.eventId !== id || e.receipt.eventId !== id || !same(raw(string(saved.eventJson)), e.event) || !same(saved.receipt, e.receipt)) throw new Error('Accepted event differs from retained journal');
    if (!same(e.event.identity, state.identity)) throw new Error('Event identity differs');
    if (e.event.expectedRevision !== revision || typeof e.receipt.revision !== 'string' || !/^[1-9][0-9]*$/.test(e.receipt.revision) || BigInt(e.receipt.revision) !== BigInt(revision) + 1n) throw new Error('Event revision chain differs');
    revision = e.receipt.revision;
    const effectIds = e.receipt.effectIds;
    if (!Array.isArray(effectIds) || !same(effectIds, rows.filter((r) => r.event_id === id).map((r) => r.effect_id))) throw new Error('Event effects differ in either direction');
  }
  if (state.revision !== revision) throw new Error('Final revision differs from accepted journal');
  const attempts = new Map<string, Obj>();
  for (const [id, f] of fx) {
    const e = ev.get(f.row.event_id);
    if (!e || f.effect.id !== id || !same(f.effect.identity, state.identity) || f.effect.revision !== e.receipt.revision || !native.owner || f.row.owner_epoch !== native.owner.owner_epoch) throw new Error('Unattached effect');
    const settlement = record(raw(f.row.settlement_json));
    if (!['nativeOwnedHandoff030', 'nativeRoutePrepared030', 'nativeSteerConsumed030', 'nativeJoinedGroupStop030'].includes(string(settlement.kind))) throw new Error('Unprojectable settlement');
    if (settlement.effectId !== undefined && settlement.effectId !== id) throw new Error('Settlement effect differs');
    if (settlement.identity !== undefined && !same(settlement.identity, state.identity)
      || settlement.ownerEpoch !== undefined && settlement.ownerEpoch !== native.owner?.owner_epoch
      || settlement.generation !== undefined && settlement.generation !== native.owner?.generation) throw new Error('Settlement owner or identity differs');
    if (f.kind.kind === 'start' && f.kind.agent !== null) {
      const attempt = record(settlement.workAttempt), work = record(f.kind.work), identity = record(state.identity);
      const expectedWork = { systemStartId: identity.systemStartId, flowInvocationId: identity.flowInvocationId, activationId: work.activationId, agentInstanceId: work.agentInstanceId, step: f.kind.step };
      if (!native.owner || !same(attempt.identity, state.identity) || !same(attempt.work, expectedWork) || attempt.startEffectId !== id || attempt.agent !== f.kind.agent
        || attempt.generation !== native.owner.generation || !same(attempt.owner, { systemStartId: identity.systemStartId, ownerEpoch: native.owner.owner_epoch })
        || settlement.requestId !== `flow030:${identity.systemStartId}:${id}` || !string(attempt.providerAttemptId)) throw new Error('Owned Start attempt differs');
      attempts.set(string(work.activationId), attempt);
    }
    if (settlement.kind === 'nativeJoinedGroupStop030') {
      const work = record(f.kind.work), end = ev.get(string(settlement.eventId)), attempt = record(settlement.workAttempt);
      const ended = end && record(end.event.kind).PhysicalEnded;
      if (f.kind.kind !== 'stopWork' || !end || end.index <= e.index || !object(ended) || !same(ended.work, work) || ended.stop_effect_id !== id
        || settlement.startEffectId !== work.startEffectId || settlement.stopEffectId !== id || settlement.requestId !== `flow030:${record(state.identity).systemStartId}:${work.startEffectId}`
        || !native.owner || settlement.ownerEpoch !== native.owner.owner_epoch || settlement.generation !== native.owner.generation
        || !same(attempt.identity, state.identity) || attempt.startEffectId !== work.startEffectId || attempt.generation !== settlement.generation
        || record(attempt.owner).ownerEpoch !== settlement.ownerEpoch || record(attempt.owner).systemStartId !== record(state.identity).systemStartId
        || record(attempt.work).activationId !== work.activationId || record(attempt.work).agentInstanceId !== work.agentInstanceId
        || attempt.agent !== activations.get(string(work.activationId))?.agent
        || !same(attempt, record(raw(fx.get(string(work.startEffectId))!.row.settlement_json)).workAttempt)) throw new Error('Joined group stop receipt differs');
    }
  }
  const starts = new Map<string, { id: string; kind: Obj; at: number }>(), terminals = new Map<string, { result: Obj; at: number; id: string }>();
  const stopped = new Map<string, number>(), deliveries = new Map<string, { kind: Obj; receipt: Obj; at: number }>();
  const failures = rows.map((r) => ({ row: r, kind: fx.get(r.effect_id)!.kind })).filter((f) => f.kind.kind === 'failure');
  for (const [id, f] of fx) {
    if (f.kind.kind === 'start') {
      const work = record(f.kind.work), a = activations.get(string(work.activationId));
      if (!a || a.startEffectId !== id || a.instanceId !== work.agentInstanceId || a.agent !== f.kind.agent || starts.has(string(a.id))) throw new Error('Activation and Start binding differ');
      if (!same(a.inputJson, f.kind.inputJson) || !same(a.messageJson, f.kind.messageJson) || !same(a.itemJson, f.kind.itemJson) || !same(a.occurrence, f.kind.occurrence)) throw new Error('Activation delivery differs from Start');
      starts.set(string(a.id), { id, kind: f.kind, at: ev.get(f.row.event_id)!.index });
    } else if (f.kind.kind === 'stopWork') stopped.set(string(record(f.kind.work).activationId), ev.get(f.row.event_id)!.index);
    else if (f.kind.kind === 'steer') {
      const a = activations.get(string(f.kind.deliveryActivationId));
      if (!a || a.startEffectId !== null || a.result !== null || deliveries.has(string(a.id))) throw new Error('Steer delivery activation differs');
      deliveries.set(string(a.id), { kind: f.kind, receipt: record(raw(f.row.settlement_json)), at: ev.get(f.row.event_id)!.index });
    }
  }
  if (new Set(handoffs.map((h) => h.effect_id)).size !== handoffs.length) throw new Error('Duplicate handoff');
  for (const h of handoffs) {
    const f = fx.get(h.effect_id), receipt = record(raw(h.receipt_json));
    if (!f || receipt.effectId !== h.effect_id || h.owner_epoch !== native.owner?.owner_epoch || h.generation !== native.owner?.generation || !same(receipt, raw(f.row.settlement_json))) throw new Error('Unattached or contradictory handoff');
  }
  for (const [id, a] of activations) {
    if (a.step !== null && !steps.has(address(a.step))) throw new Error('Activation step is not declared');
    if (a.step !== null && a.agent !== (steps.get(address(a.step))!.agent ?? null)) throw new Error('Activation agent contradicts captured step');
    if (a.startEffectId !== null && (!starts.has(id) || starts.get(id)!.id !== a.startEffectId)) throw new Error('Activation has no matching Start');
    if (a.instanceId !== null) { const instance = instances.get(string(a.instanceId)); if (!instance || instance.agent !== a.agent) throw new Error('Activation has no matching instance'); }
    else if (a.agent !== null && a.startEffectId !== null) throw new Error('Agent activation has no instance');
    if (a.stopEffectId !== null && a.stopEffectId !== undefined) {
      const f = fx.get(string(a.stopEffectId));
      if (!f || f.kind.kind !== 'stopWork' || record(f.kind.work).activationId !== id) throw new Error('Activation has no matching StopWork');
    }
  }
  for (const [id, instance] of instances) if (![...activations.values()].some((a) => a.instanceId === id) || instance.current !== null || !Array.isArray(instance.queue) || instance.queue.length) throw new Error('Unattached or busy instance');
  const normalized = (value: ExactValue | undefined): Obj => {
    const r = record(value);
    if (Object.keys(r).length !== 1) throw new Error('Invalid accepted work result');
    if (r.Completed !== undefined) { const c = record(r.Completed); return { kind: 'completed', outputJson: string(c.output_json), routeKey: c.route_key ?? null }; }
    return { kind: 'failed', error: record(record(r.Failed).error) };
  };
  const physicalEnds = new Map<string, number>();
  for (const [id, e] of ev) {
    const k = record(e.event.kind), names = Object.keys(k);
    if (names.length !== 1 || !['Enter', 'Deliver', 'WorkResult', 'Prepared', 'PhysicalEnded'].includes(names[0])) throw new Error('Unattached or unsupported event');
    if (k.Enter !== undefined && (e.index !== 0 || state.entered !== true)) throw new Error('Unattached Enter event');
    if (k.Deliver !== undefined) throw new Error('Graphless Deliver is not projectable');
    if (k.WorkResult !== undefined || k.PhysicalEnded !== undefined) {
      const body = record(k.WorkResult ?? k.PhysicalEnded), work = record(body.work), activationId = string(work.activationId), s = starts.get(activationId);
      if (!s || !same(s.kind.work, work) || e.index <= s.at) throw new Error('Accepted work event has no matching Start');
      if (k.WorkResult !== undefined) {
        const result = normalized(body.result), a = activations.get(activationId)!;
        if ((stopped.get(activationId) ?? Infinity) < e.index) throw new Error('WorkResult follows work cancellation');
        if (terminals.has(activationId) || !same(a.result, result)) throw new Error('Accepted WorkResult contradicts activation terminal');
        terminals.set(activationId, { result, at: e.index, id });
      } else if (body.stop_effect_id !== activations.get(activationId)!.stopEffectId) throw new Error('PhysicalEnded stop binding differs');
      const evidence = k.PhysicalEnded === undefined ? body.physical : body.evidence;
      if (k.PhysicalEnded !== undefined && (!terminals.has(activationId) && (stopped.get(activationId) ?? Infinity) >= e.index)) throw new Error('PhysicalEnded has no preceding result or stop');
      if (evidence !== null && evidence !== undefined) {
        const proof = record(evidence);
        if (proof.descendants_joined !== true || !string(proof.native_receipt_id) || physicalEnds.has(activationId)) throw new Error('Invalid or duplicate physical evidence');
        if (attempts.has(activationId) && proof.native_receipt_id !== `physical:${attempts.get(activationId)!.providerAttemptId}`) throw new Error('Physical evidence belongs to another attempt');
        physicalEnds.set(activationId, e.index);
      } else if (k.PhysicalEnded !== undefined) throw new Error('PhysicalEnded evidence is absent');
    }
  }
  for (const [id] of starts) {
    const a = activations.get(id)!;
    if ((stopped.get(id) ?? Infinity) < starts.get(id)!.at) throw new Error('StopWork precedes Start');
    if (a.result !== null && !terminals.has(id)) throw new Error('Activation terminal has no accepted WorkResult');
    if (a.result === null && !stopped.has(id)) throw new Error('Started activation has neither terminal nor cancellation');
    if (a.physical !== !physicalEnds.has(id)) throw new Error('Activation physical state contradicts accepted evidence');
  }
  const failureFor = (id: string) => failures.filter((f) => f.kind.activationId === id);
  for (const [id, t] of terminals) if (t.result.kind === 'failed' && (failureFor(id).length !== 1 || !same(failureFor(id)[0].kind.error, t.result.error))) throw new Error('Accepted failure has no unique Failure effect');
  for (const f of failures) if (starts.has(string(f.kind.activationId))) {
    const t = terminals.get(string(f.kind.activationId));
    if (!t || t.id !== f.row.event_id || t.result.kind !== 'failed' || !same(t.result.error, f.kind.error)) throw new Error('Failure contradicts accepted terminal');
  }
  for (const failure of failures.filter((f) => f.kind.counted === false)) {
    const id = failure.kind.activationId;
    const errorProducer = (v: ExactValue | undefined) => object(v) && v.activationId === id && Object.hasOwn(record(raw(string(v.outputJson))), 'error');
    if ([...fx.values()].some((f) => f.kind.kind === 'prepareRoute' && record(record(f.kind.reference).route).kind === 'error' && (record(f.kind.reference).activationId === id || errorProducer(f.kind.producer))
      || f.kind.kind === 'start' && (errorProducer(f.kind.sender) || errorProducer(activations.get(string(record(f.kind.work).activationId))!.producer)))) throw new Error('Non-counting failure has an error continuation');
  }
  const producer = (p: Obj): number => {
    const id = string(p.activationId), a = activations.get(id);
    if (!a || !same(p.step, a.step)) throw new Error('Producer activation differs');
    if (p.kind !== steps.get(address(a.step))?.type || p.inputJson !== a.inputJson || p.messageJson !== a.messageJson || p.itemJson !== a.itemJson) throw new Error('Producer input contradicts activation');
    const t = terminals.get(id), g = [...groups.values()].find((g) => g.activationId === id);
    const output = raw(string(p.outputJson));
    if (t?.result.kind === 'completed' && same(raw(string(t.result.outputJson)), output)) return t.at;
    if (object(output) && output.error !== undefined) {
      const f = failureFor(id).find((f) => same(f.kind.error, output.error));
      if (f && f.kind.counted === true) return ev.get(f.row.event_id)!.index;
    }
    if (g && same(raw(string(g.outputJson)), output)) return -1;
    throw new Error('Producer output contradicts accepted result');
  };
  const preparedEvents = [...ev.values()].filter((e) => object(record(e.event.kind).Prepared));
  const preparedFor = (occurrence: ExactValue | undefined) => preparedEvents.filter((e) => record(record(e.event.kind).Prepared).native_receipt_id === record(occurrence).nativeReceiptId);
  const containsPath = (context: ExactValue | undefined, pathId: string) => list(context).some((f) => f.kind === 'path' && f.pathId === pathId);
  const batchOpening = new Map<string, number>(), batchOrigins = new Map<string, string>();
  for (const [id, batch] of batches) {
    const items = list(batch.items), pathIds = batch.pathIds;
    if (!Array.isArray(pathIds) || pathIds.length !== items.length || new Set(pathIds).size !== pathIds.length) throw new Error('Batch paths differ from its items');
    const openings = preparedEvents.flatMap((e) => {
      const body = record(record(e.event.kind).Prepared), ready = record(body.result).Ready;
      if (!list(state.preparations).some((p) => same(p.reference, body.reference) && same(p.producer, batch.producer))) return [];
      return object(ready) ? list(ready.batches).filter((b) => same(record(b.target).address, batch.target) && same(b.items, items)).map((b) => ({ e, body, b })) : [];
    });
    if (openings.length !== 1) throw new Error('Batch has no unique initial Prepared');
    const { e, body, b } = openings[0], reference = record(body.reference);
    const preparation = list(state.preparations).find((p) => same(p.reference, reference));
    if (!preparation || !same(preparation.producer, batch.producer) || !same(reference.context, batch.context) || !same(record(b.target).concurrencyJson, batch.concurrencyJson)) throw new Error('Batch contradicts preparation');
    batchOpening.set(id, e.index);
    batchOrigins.set(id, string(reference.activationId));
    for (const [index, pathId] of pathIds.entries()) {
      const path = paths.get(string(pathId));
      const expectedContext = [...list(batch.context), { kind: 'path', pathId, departedGroups: [] }];
      if (!path || path.batchId !== id || !same(path.itemJson, items[index].itemJson) || !same(path.context, expectedContext)) throw new Error('Path contradicts batch occurrence');
    }
  }
  const startPaths = new Map<string, string>();
  for (const [id, s] of starts) {
    const a = activations.get(id)!, f = fx.get(s.id)!, causal = record(ev.get(f.row.event_id)!.event.kind);
    const targets = [a.step, ...list(a.context).filter((frame) => frame.kind === 'compose').map((frame) => {
      const owner = activations.get(string(frame.activationId));
      if (!owner || steps.get(address(owner.step))?.type !== 'compose') throw new Error('Compose owner is absent');
      return owner.step;
    })];
    if (!same(a.producer, s.kind.sender)) throw new Error('Start sender contradicts activation producer');
    if (causal.Enter !== undefined) {
      if (s.kind.sender !== null || !targets.some((target) => same(target, plan.entry))) throw new Error('Start is not the captured entry');
      continue;
    }
    const origins = preparedFor(a.occurrence).flatMap((e) => {
      const body = record(record(e.event.kind).Prepared), ready = record(body.result).Ready;
      return object(ready) ? list(ready.batches).filter((b) => targets.some((target) => same(record(b.target).address, target))).flatMap((b) => list(b.items)).filter((item) => same(item.occurrence, a.occurrence) && same(item.itemJson, a.itemJson) && same(item.messageJson, a.messageJson)).map(() => ({ e, body })) : [];
    });
    if (origins.length !== 1 || origins[0].e.index > s.at) throw new Error('Start delivery has no unique prepared occurrence');
    const { e: opening, body } = origins[0], preparation = list(state.preparations).find((p) => same(p.reference, body.reference));
    if (!preparation || !same(preparation.producer, s.kind.sender)) throw new Error('Start has no matching prepared producer');
    producer(record(s.kind.sender));
    const pathBindings = [...batches.values()].flatMap((batch) => list(batch.items).flatMap((item, index) => same(item.occurrence, a.occurrence) && targets.some((target) => same(target, batch.target)) ? [{ batch, pathId: string((batch.pathIds as ExactValue[])[index]) }] : []));
    if (pathBindings.length > 1) throw new Error('Start occurrence belongs to multiple batches');
    if (pathBindings.length) {
      const { batch, pathId } = pathBindings[0]; startPaths.set(id, pathId);
      const escaped = [...groups.values()].some((g) => object(g.continuation) && g.continuation.kind === 'route' && g.continuation.activationId === id && same(g.context, a.context));
      if (!same(batch.producer, a.producer) || !containsPath(a.context, pathId) && !escaped) throw new Error('Start activation is detached from its batch path');
    } else if (opening.index !== s.at) {
      const step = steps.get(address(a.step))!, declaration = record(raw(string(step.declarationJson)));
      if ((step.delivery ?? declaration.delivery ?? 'queue') !== 'queue' || ![...starts].some(([otherId, other]) => other.at < s.at && activations.get(otherId)!.instanceId === a.instanceId && physicalEnds.get(otherId) === s.at)) throw new Error('Deferred Start has no native slot release');
    }
  }
  const decisionAt = new Map<string, number>();
  const ordinals = new Set<string>();
  for (const [id, g] of [...groups].sort(([, a], [, b]) => BigInt(string(a.decidedOrdinal)) < BigInt(string(b.decidedOrdinal)) ? -1 : 1)) {
    const ordinal = string(g.decidedOrdinal);
    if (!/^[1-9][0-9]*$/.test(ordinal) || ordinals.has(ordinal)) throw new Error('Join order is unavailable');
    ordinals.add(ordinal);
    const declaration = list(plan.joins).find((j) => same(j.address, g.join));
    if (!declaration) throw new Error('Join is not declared');
    const owner = activations.get(string(g.activationId)), origin = activations.get(string(g.originActivationId));
    if (!owner || !origin || !same(owner.step, g.join) || !same(origin.step, declaration.origin)
      || !object(owner.producer) || !same(owner.context, g.context)) throw new Error('Join origin contradicts declaration or owner');
    producer(owner.producer);
    const declaredBranches = list(declaration.branches);
    const groupBatches = list(g.branches).flatMap((branch) => {
      const declared = declaredBranches.find((b) => b.name === branch.name);
      if (!declared || declared.fanout !== branch.fanout) throw new Error('Join branch is not declared');
      const bindings = [...batches.values()].filter((batch) => same(batch.target, declared.target) && batchOrigins.get(string(batch.id)) === origin.id && same(batch.context, g.context) && same(batch.producer, owner.producer));
      if (!bindings.length || !same(bindings.flatMap((batch) => batch.pathIds as ExactValue[]), branch.pathIds)) throw new Error('Join branch paths contradict origin batches');
      return bindings;
    });
    const openings = new Set(groupBatches.map((batch) => batchOpening.get(string(batch.id))!));
    if (openings.size !== 1) throw new Error('Join has no unique native opening');
    const openedAt = [...openings][0];
    const branches: Obj = {}, contributors: number[] = [], arrivals: Array<{ at: number; accepted: boolean; failed: boolean }> = [];
    for (const b of list(g.branches)) {
      if (!Array.isArray(b.pathIds)) throw new Error('Missing join paths');
      const outputs: ExactValue[] = [];
      for (const pathId of b.pathIds) {
        const path = paths.get(string(pathId));
        if (!path) throw new Error('Join path is absent');
        const ms = list(path.memberships).filter((m) => m.groupId === id && m.branch === b.name);
        if (ms.length !== 1) throw new Error('Join membership differs');
        const m = ms[0];
        if (typeof m.accepted !== 'boolean' || typeof m.failed !== 'boolean') throw new Error('Missing membership flags');
        const declared = declaredBranches.find((branch) => branch.name === b.name)!;
        const batch = batches.get(string(path.batchId));
        if (!batch || !same(batch.target, declared.target) || batchOrigins.get(string(batch.id)) !== origin.id || !same(batch.producer, owner.producer)) throw new Error('Membership path contradicts branch origin');
        let contributionAt: number | undefined;
        const choice = m.producer === null ? undefined : record(raw(string(record(m.producer).outputJson))).choice;
        if (!Array.isArray(declaration.accept) || m.accepted !== (typeof choice === 'string' && declaration.accept.includes(choice))) throw new Error('Membership acceptance contradicts producer');
        if (m.producer !== null) {
          const p = record(m.producer);
          if (!same(raw(string(m.resultJson)), raw(string(p.outputJson)))) throw new Error('Membership result contradicts producer');
          const source = activations.get(string(p.activationId));
          if (!source || !containsPath(source.context, string(pathId)) || !Array.isArray(declared.members) || !declared.members.some((step) => same(step, source.step))) throw new Error('Membership producer is detached from its declared branch path');
          if (m.failed) throw new Error('Membership failed flag has no matching Failure');
          contributionAt = producer(p);
          if (contributionAt < 0) contributionAt = decisionAt.get(string([...groups.values()].find((group) => group.activationId === p.activationId)?.id));
          if (contributionAt === undefined) throw new Error('Membership producer decision time is unavailable');
        } else if (m.resultJson !== null) {
          const output = record(raw(string(m.resultJson)));
          const members = [...activations.values()].filter((a) => list(a.context).some((f) => f.kind === 'path' && f.pathId === pathId));
          if (output.ended === 'failed') {
            const matches = members.flatMap((a) => failureFor(string(a.id))).filter((f) => f.kind.counted === true && same(f.kind.error, output.error));
            if (matches.length !== 1 || !m.failed) throw new Error('Failed membership has no unique contributing failure');
            contributionAt = ev.get(matches[0].row.event_id)!.index;
          } else if (output.ended === 'absorbed') {
            const matches = members.flatMap((a) => deliveries.has(string(a.id)) ? [deliveries.get(string(a.id))!] : []);
            if (matches.length !== 1 || address(activations.get(string(record(matches[0].kind.work).activationId))!.step) !== output.by) throw new Error('Absorbed membership has no matching steer');
            if (m.failed) throw new Error('Membership failed flag has no matching Failure');
            contributionAt = matches[0].at;
          } else throw new Error('Membership end has no verifiable producer provenance');
        } else if (m.failed) throw new Error('Membership failed flag has no matching Failure');
        if (contributionAt !== undefined) { contributors.push(contributionAt); arrivals.push({ at: contributionAt, accepted: m.accepted, failed: m.failed }); }
        if (g.decision === 'reached' && m.accepted !== true) continue;
        if (m.resultJson !== null) {
          let output = raw(string(m.resultJson));
          if (b.fanout === true) output = { ...record(output), item: raw(string(path.itemJson)) };
          outputs.push(output);
        }
      }
      if (b.fanout === true) branches[string(b.name)] = outputs;
      else if (outputs.length) { if (outputs.length !== 1) throw new Error('Non-fanout join has multiple contributions'); branches[string(b.name)] = outputs[0]; }
    }
    if (['done', 'incomplete', 'reached', 'missed'].includes(string(g.decision))) {
      const expected = { outcome: g.decision, branches };
      if (!same(raw(string(g.outputJson)), expected) || !same(record(owner.result), { kind: 'completed', outputJson: g.outputJson, routeKey: g.decision })) throw new Error('Join snapshot contradicts memberships or terminal');
    } else if (!['closed', 'failed'].includes(string(g.decision))) throw new Error('Unsettled join decision');
    let at: number | undefined, computed: string | undefined;
    const pathCount = list(g.branches).reduce((n, branch) => n + (branch.pathIds as ExactValue[]).length, 0);
    if (g.decision === 'closed') {
      if (!object(g.continuation)) throw new Error('Closed join escape time is not uniquely retained');
      const continuation = record(g.continuation), source = activations.get(string(continuation.activationId)), p = record(continuation.producer);
      const pathId = source && startPaths.get(string(source.id)), branch = list(g.branches).find((branch) => (branch.pathIds as ExactValue[]).includes(pathId!));
      const declared = branch && declaredBranches.find((b) => b.name === branch.name);
      const route = list(plan.routes).find((r) => same(r.source, record(continuation.route).source) && r.kind === record(continuation.route).kind && r.key === record(continuation.route).key);
      if (continuation.kind !== 'route' || !source || p.activationId !== source.id || !branch || !declared || !route || !same(source.context, g.context)
        || !Array.isArray(declared.members) || !declared.members.some((step) => same(step, source.step))
        || list(route.targets).every((t) => same(record(t).address, g.join))
        || list(route.targets).every((t) => (declared.members as ExactValue[]).some((member) => same(member, t.address)))
        || g.outputJson !== null || owner.result !== null || g.error !== null) throw new Error('Closed join has no durable escape provenance');
      at = producer(p); computed = 'closed';
    } else {
      const quorum = declaration.mode === 'quorum' ? raw(string(declaration.quorumCountJson)) : null;
      if (quorum !== null && (!(quorum instanceof NumberToken) || !isInteger(quorum))) throw new Error('Invalid quorum threshold');
      let accepted = 0, failed = 0, pending = pathCount;
      const evaluate = () => {
        if (quorum instanceof NumberToken) return compareNumbers(quorum, new NumberToken(String(accepted))) <= 0 ? 'reached' : compareNumbers(quorum, new NumberToken(String(accepted + pending))) > 0 ? 'missed' : undefined;
        const max = declaration.maxFailuresJson === null ? null : raw(string(declaration.maxFailuresJson));
        if (failed && (declaration.failures === 'fail' || max instanceof NumberToken && compareNumbers(max, new NumberToken(String(failed))) < 0)) return 'failed';
        return pending === 0 ? failed ? 'incomplete' : 'done' : undefined;
      };
      computed = evaluate(); if (computed) at = openedAt;
      for (const arrival of arrivals.sort((a, b) => a.at - b.at)) {
        if (computed) break;
        accepted += Number(arrival.accepted); failed += Number(arrival.failed); pending--;
        computed = evaluate(); if (computed) at = arrival.at;
      }
      if (g.decision === 'failed' && (!object(g.error) || !failureFor(string(owner.id)).some((f) => same(f.kind.error, g.error)))) throw new Error('Failed join has no matching Failure');
    }
    if (at === undefined || computed !== g.decision || at < openedAt) throw new Error('Join decision contradicts native contributions');
    if (contributors.some((n) => n > at)) throw new Error('Join snapshot includes a late contribution');
    decisionAt.set(id, at);
  }
  let lastDecision = -1;
  for (const g of [...groups.values()].sort((a, b) => BigInt(string(a.decidedOrdinal)) < BigInt(string(b.decidedOrdinal)) ? -1 : 1)) {
    const at = decisionAt.get(string(g.id))!;
    if (at < lastDecision) throw new Error('Join order contradicts native decision chronology');
    lastDecision = at;
  }
  for (const [id, p] of paths) for (const m of list(p.memberships)) {
    const g = groups.get(string(m.groupId));
    if (!g || !list(g.branches).some((b) => b.name === m.branch && Array.isArray(b.pathIds) && b.pathIds.includes(id))) throw new Error('Unattached membership');
  }
  for (const [id, p] of paths) if (!list(p.memberships).length && ![...activations.values()].some((a) => list(a.context).some((f) => f.kind === 'path' && f.pathId === id))) throw new Error('Unattached path');
  for (const batch of batches.values()) {
    const limit = batch.concurrencyJson === null ? null : raw(string(batch.concurrencyJson));
    if (limit !== null && (!(limit instanceof NumberToken) || !isInteger(limit) || compareNumbers(limit, new NumberToken('0')) <= 0)) throw new Error('Invalid batch concurrency');
    const admitted = (batch.pathIds as ExactValue[]).map((pathId) => {
      const startsOnPath = [...starts].filter(([id]) => startPaths.get(id) === pathId);
      const first = startsOnPath.sort((a, b) => a[1].at - b[1].at || rows.findIndex((r) => r.effect_id === a[1].id) - rows.findIndex((r) => r.effect_id === b[1].id))[0];
      const members = [...activations.values()].filter((a) => containsPath(a.context, string(pathId)) || startPaths.get(string(a.id)) === pathId);
      const ends = members.flatMap((a) => [physicalEnds.get(string(a.id)), terminals.get(string(a.id))?.at]).filter((n): n is number => n !== undefined);
      for (const e of preparedEvents) if (containsPath(record(record(record(e.event.kind).Prepared).reference).context, string(pathId))) ends.push(e.index);
      return { pathId: string(pathId), first, end: Math.max(-1, ...ends) };
    });
    for (const [index, entry] of admitted.entries()) if (entry.first) {
      const [, start] = entry.first, position = rows.findIndex((r) => r.effect_id === start.id);
      const earlier = admitted.filter((p) => p.first && (p.first[1].at < start.at || p.first[1].at === start.at && rows.findIndex((r) => r.effect_id === p.first![1].id) < position));
      if (admitted.slice(0, index).some((p) => !p.first) || earlier.some((p) => admitted.indexOf(p) > index)) throw new Error('Fanout Start bypasses a pending occurrence');
      const active = earlier.filter((p) => p.end > start.at).length;
      if (limit instanceof NumberToken && compareNumbers(new NumberToken(String(active + 1)), limit) > 0) throw new Error('Fanout Start exceeds native concurrency');
      const opened = batchOpening.get(string(batch.id))!;
      if (start.at !== opened && !earlier.some((p) => p.end === start.at)) throw new Error('Deferred fanout Start has no native slot release');
      const memberships = list(paths.get(entry.pathId)!.memberships);
      if (memberships.length && memberships.every((m) => decisionAt.get(string(m.groupId))! <= start.at)) throw new Error('Fanout Start follows closure of its enclosing groups');
    }
  }
  const countedAt = (a: Obj, at: number, afterEvent = false) => list(a.context).every((f) => {
    if (f.kind === 'compose') return activations.has(string(f.activationId));
    if (f.kind !== 'path') throw new Error('Unknown activation context');
    const p = paths.get(string(f.pathId)); if (!p) throw new Error('Activation path is absent');
    const memberships = list(p.memberships), departed = f.departedGroups;
    if (!Array.isArray(departed)) throw new Error('Missing departed groups');
    return !memberships.length || memberships.some((m) => !departed.includes(m.groupId!) && (afterEvent ? (decisionAt.get(string(m.groupId)) ?? -1) > at : (decisionAt.get(string(m.groupId)) ?? -1) >= at));
  });
  for (const [id, d] of deliveries) {
    const target = string(record(d.kind.work).activationId), s = starts.get(target), checkpoint = ev.get(string(d.receipt.consumedAfterEventId));
    if (!s || !checkpoint || checkpoint.index < d.at || checkpoint.index < s.at || (terminals.get(target)?.at ?? Infinity) <= checkpoint.index
      || (stopped.get(target) ?? Infinity) <= checkpoint.index || !countedAt(activations.get(target)!, checkpoint.index, true)) throw new Error('Steer consumed after target stopped counting or ended');
    for (const e of ev.values()) { const k = record(e.event.kind); if (e.index <= checkpoint.index && object(k.PhysicalEnded) && record(record(k.PhysicalEnded).work).activationId === target) throw new Error('Steer consumed after physical end'); }
    if (!same(activations.get(id)!.messageJson, d.kind.messageJson)) throw new Error('Steer message contradicts delivery activation');
    if (activations.get(id)!.instanceId !== activations.get(target)!.instanceId || activations.get(id)!.agent !== activations.get(target)!.agent) throw new Error('Steer delivery instance differs from target');
  }
  const preparations = unique(list(state.preparations).map((p) => ({ ...p, id: record(p.reference).prepareId })), 'id');
  const nativePreparations = new Map(native.preparations.map((p) => [p.prepare_id, p]));
  if (nativePreparations.size !== native.preparations.length) throw new Error('Duplicate native preparation');
  const expectedProvenance = new Map<string, Obj>();
  const seenContentContexts = new Set<string>();
  for (const e of preparedEvents) {
    const body = record(record(e.event.kind).Prepared), reference = record(body.reference), saved = preparations.get(string(reference.prepareId));
    const row = nativePreparations.get(string(reference.prepareId));
    if (!saved || !row || row.native_receipt_id !== body.native_receipt_id || !same(raw(row.reference_json), reference) || !same(raw(row.producer_json), saved.producer)
      || !native.owner || row.owner_epoch !== native.owner.owner_epoch || row.generation !== native.owner.generation) throw new Error('Native preparation contradicts accepted state');
    const output = record(raw(row.result_json)), source = record(raw(row.source_json)), p = record(saved.producer);
    if (source.terminalId !== p.activationId || !same(source.producerStep, p.step) || source.outputJson !== p.outputJson) throw new Error('Native preparation source contradicts producer');
    if (source.kind !== (record(reference.route).kind === 'error' ? 'error' : p.kind)
      || source.producerAgent !== (source.kind === 'agent' ? activations.get(string(p.activationId))!.agent : null)
      || !Array.isArray(record(source.provenance).instructions)) throw new Error('Native source authority contradicts producer');
    const content = record(raw(row.content_receipts_json));
    if (content.format !== 'macro-agsdl-route-content/1' || !Array.isArray(content.occurrences) || Object.keys(content).length !== 2) throw new Error('Invalid native content receipts');
    const contexts = native.contentContexts.filter((context) => context.prepare_id === row.prepare_id);
    if (contexts.length !== content.occurrences.length) throw new Error('Native content occurrences contradict retained contexts');
    for (const item of content.occurrences.map(record)) {
      const context = contexts.find((c) => c.context_id === item.contextId);
      if (!context || seenContentContexts.has(context.context_id) || !same(new NumberToken(String(context.target_ordinal)), item.targetOrdinal) || context.item_index !== item.itemIndex
        || context.owner_epoch !== row.owner_epoch || context.generation !== row.generation || !same(raw(context.identity_json), item.identity)) throw new Error('Native content context differs');
      const receipts = native.contentReceipts.filter((r) => r.context_id === context.context_id).map((r) => raw(r.transport_receipt_json));
      const delivered = item.receipts;
      if (!Array.isArray(delivered) || receipts.length !== delivered.length) throw new Error('Native transported content receipts differ');
      const remaining = [...delivered];
      for (const receipt of receipts) { const at = remaining.findIndex((r) => same(r, receipt)); if (at < 0) throw new Error('Native transported content receipts differ'); remaining.splice(at, 1); }
      seenContentContexts.add(context.context_id);
    }
    const ready = record(body.result).Ready;
    if (object(ready)) {
      if (output.kind !== 'ready' || !same(output.batches, ready.batches)) throw new Error('Native preparation result contradicts accepted batches');
      const route = list(plan.routes).find((r) => same(r.source, record(reference.route).source) && r.kind === record(reference.route).kind && r.key === record(reference.route).key);
      if (!route || !same(list(ready.batches).map((batch) => batch.target!), route.targets)) throw new Error('Prepared batch targets contradict captured route');
      const proofs = list(output.provenance), items = list(ready.batches).flatMap((b) => list(b.items));
      if (proofs.length !== items.length) throw new Error('Native occurrence provenance is incomplete');
      for (const proof of proofs) {
        const occurrence = record(proof.occurrence), key = JSON.stringify([occurrence.nativeReceiptId, stringify(occurrence.targetOrdinal!), occurrence.itemIndex]);
        const item = items.find((item) => same(item.occurrence, occurrence));
        if (!item || !same(proof.producer, p) || !same(proof.source, source) || !object(proof.prompt) || expectedProvenance.has(key)) throw new Error('Native occurrence provenance contradicts preparation');
        const prompt = proof.prompt, message = item.messageJson === null ? {} : record(raw(string(item.messageJson)));
        if (!['none', 'host', 'author', 'agent'].includes(string(prompt.kind)) || (prompt.kind === 'none') !== (message.prompt === undefined || message.prompt === null)
          || prompt.kind === 'author' && !string(prompt.pointer)
          || prompt.kind === 'agent' && !same(record(source.provenance).prompt, prompt) && !(record(source.provenance).instructions as ExactValue[]).some((authority) => same(authority, prompt.authority))) throw new Error('Prompt provenance contradicts delivery or authority');
        expectedProvenance.set(key, proof);
      }
    } else {
      const failed = record(record(body.result).Failed);
      if (output.kind !== 'failed' || !same(output.targetOrdinal, failed.target_ordinal) || !same(output.error, failed.error)) throw new Error('Native failed preparation contradicts accepted event');
    }
  }
  if (nativePreparations.size !== preparedEvents.length) throw new Error('Unattached native preparation');
  if (seenContentContexts.size !== native.contentContexts.length || native.contentReceipts.some((r) => !seenContentContexts.has(r.context_id))) throw new Error('Unattached native content proof');
  const seenProvenance = new Set<string>();
  for (const row of native.provenance) {
    const key = JSON.stringify([row.native_receipt_id, String(row.target_ordinal), row.item_index]);
    if (!expectedProvenance.has(key) || seenProvenance.has(key) || !same(raw(row.provenance_json), expectedProvenance.get(key))) throw new Error('Unattached or contradictory occurrence provenance');
    seenProvenance.add(key);
  }
  if (seenProvenance.size !== expectedProvenance.size) throw new Error('Native occurrence provenance is incomplete');
  for (const [id, f] of fx) {
    if (f.kind.kind === 'prepareRoute') {
      const reference = record(f.kind.reference), a = activations.get(string(reference.activationId)), p = preparations.get(string(reference.prepareId));
      const source = activations.get(string(record(f.kind.producer).activationId));
      const forwardedCompose = a && steps.get(address(a.step))?.type === 'compose' && source && list(source.context).some((frame) => frame.kind === 'compose' && frame.activationId === a.id);
      if (!a || record(f.kind.producer).activationId !== a.id && !forwardedCompose || !same(a.step, record(reference.route).source) || !p || !same(p.reference, reference) || !same(p.producer, f.kind.producer)) throw new Error('Unattached or contradictory prepareRoute');
      if (!list(plan.routes).some((route) => same(route.source, record(reference.route).source) && route.kind === record(reference.route).kind && route.key === record(reference.route).key)) throw new Error('Prepared route is not declared');
      if (record(reference.route).kind === 'normal') {
        let key = object(a.result) ? a.result.routeKey : undefined;
        if (forwardedCompose) {
          const bodyRoute = selectRoute(source!.step, 'normal', record(source!.result).routeKey), outputs = bodyRoute && list(bodyRoute.targets);
          if (!outputs || outputs.length !== 1 || outputs[0].kind !== 'output' || !same(outputs[0].scope, a.step)) throw new Error('Compose route has no matching body output');
          key = outputs[0].name;
        }
        const selected = selectRoute(a.step, 'normal', key);
        if (!selected || selected.key !== record(reference.route).key) throw new Error('Prepared route contradicts terminal selection');
      }
      if (record(reference.route).kind === 'error' && !failureFor(string(a.id)).some((failure) => failure.kind.counted === true && same(record(raw(string(record(f.kind.producer).outputJson))).error, failure.kind.error))) throw new Error('Error route has no contributing Failure');
      producer(record(f.kind.producer));
      const completed = [...ev.values()].filter((e) => { const k = record(e.event.kind); return object(k.Prepared) && same(record(k.Prepared).reference, reference); });
      if (p.status !== 'consumed' || completed.length !== 1) throw new Error('Preparation has no unique accepted event');
      const body = record(record(completed[0].event.kind).Prepared), receiptId = string(body.native_receipt_id);
      if (record(state.preparationReceipts)[receiptId] !== reference.prepareId || record(raw(f.row.settlement_json)).nativeReceiptId !== receiptId) throw new Error('Preparation receipt differs');
    } else if (f.kind.kind === 'return') {
      const a = activations.get(string(f.kind.activationId)), t = terminals.get(string(f.kind.activationId));
      if (!a || a.step !== null || a.sender !== f.kind.sender || !t || t.id !== f.row.event_id || t.result.outputJson !== f.kind.outputJson) throw new Error('Unattached or contradictory Return');
    } else if (f.kind.kind === 'runEnded' && f.kind.verdict !== state.verdict) throw new Error('RunEnded verdict differs from state');
    else if (f.kind.kind === 'failure') {
      const a = activations.get(string(f.kind.activationId))!, at = ev.get(f.row.event_id)!.index;
      if (f.kind.counted !== countedAt(a, at)) throw new Error('Failure counted flag contradicts context at failure');
    }
  }
  for (const p of preparations.values()) if (![...fx.values()].some((f) => f.kind.kind === 'prepareRoute' && record(f.kind.reference).prepareId === p.id)) throw new Error('Unattached retained preparation');
  for (const [receiptId, prepareId] of Object.entries(record(state.preparationReceipts))) if (![...ev.values()].some((e) => { const k = record(e.event.kind); return object(k.Prepared) && record(k.Prepared).native_receipt_id === receiptId && record(record(k.Prepared).reference).prepareId === prepareId; })) throw new Error('Unattached preparation receipt');
  for (const e of ev.values()) { const k = record(e.event.kind); if (k.Prepared !== undefined && !preparations.has(string(record(record(k.Prepared).reference).prepareId))) throw new Error('Unattached accepted preparation'); }
  const ends = [...fx.values()].filter((f) => f.kind.kind === 'runEnded');
  if (ends.length !== 1 || rows.at(-1)?.effect_id !== ends[0].row.effect_id || ends[0].row.event_id !== events.at(-1)?.event_id) throw new Error('Missing, duplicate or premature RunEnded');
  for (const [id, a] of activations) if (a.startEffectId === null) {
    const type = steps.get(address(a.step))?.type;
    if (!deliveries.has(id) && !failureFor(id).length && !(type === 'join' && [...groups.values()].some((g) => g.activationId === id))
      && !(type === 'compose' && [...activations.values()].some((child) => list(child.context).some((f) => f.kind === 'compose' && f.activationId === id)))) throw new Error('Unattached activation without Start');
  }
}

export function observeRun030(databasePath: string, systemId: string, invocationId: string): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    db.exec('BEGIN');
    const run = db.query('SELECT state_json,plan_json,snapshot_id,epoch FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?').get(systemId, invocationId) as { state_json: string; plan_json: string; snapshot_id: string; epoch: string } | null;
    if (!run) throw new Error('Run is absent');
    const plan = record(raw(run.plan_json));
    if (!Array.isArray(plan.steps) || !Array.isArray(plan.agents)) throw new Error('Invalid durable plan');
    const steps = new Map(plan.steps.map(record).map((step) => [address(step.address), step]));
    const diagnostic = db.query('SELECT 1 FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND diagnostic_json IS NOT NULL LIMIT 1').get(systemId, invocationId);
    if (diagnostic) throw new Error('Flow diagnostic remains');
    const state = record(raw(run.state_json));
    if (!same(state.identity, { systemStartId: systemId, flowInvocationId: invocationId, snapshotId: run.snapshot_id, epoch: run.epoch })) throw new Error('Run identity differs from capture');
    if (state.verdict !== 'succeeded' && state.verdict !== 'failed') throw new Error('Run is not terminal');
    if (typeof state.unhandledFailure !== 'boolean' || typeof state.stopping !== 'boolean' || state.stopping || state.verdict !== (state.unhandledFailure ? 'failed' : 'succeeded')) throw new Error('Run verdict contradicts native failure or stop state');
    if (!Array.isArray(state.activations) || !Array.isArray(state.groups)) throw new Error('Invalid durable state');
    const activations = state.activations.map(record);
    if (activations.some((a) => a.physical !== false)) throw new Error('Physical work remains');
    if (activations.some((a) => a.phase !== undefined && a.phase !== 'done')
      || (Array.isArray(state.preparations) && state.preparations.map(record).some((p) => p.status === 'pending'))
      || (Array.isArray(state.paths) && state.paths.map(record).some((p) => p.phase === 'pending'))
      || (Array.isArray(state.routeBarriers) && state.routeBarriers.length !== 0)
      || state.groups.map(record).some((g) => g.released === false)) throw new Error('Pending native activity remains');
    const byId = new Map(activations.map((a) => [string(a.id), a]));
    if (byId.size !== activations.length) throw new Error('Duplicate activation');
    const rows = db.query('SELECT effect_id,event_id,effect_json,owner_epoch,status,settlement_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? ORDER BY rowid').all(systemId, invocationId) as EffectRow030[];
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
    const startedSteps = [...startsByActivation.keys()].map((id) => steps.get(address(byId.get(id)!.step))).filter((step): step is Obj => step !== undefined);
    const startedAgents = new Set([...startsByActivation.keys()].map((id) => byId.get(id)!.agent));
    const needsHumans = startedSteps.some((s) => s.type === 'approval' || (s.type === 'call' && record(raw(string(s.declarationJson))).mcp !== undefined))
      || plan.agents.map(record).filter((a) => startedAgents.has(a.agentName)).some((a) => {
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
      if (row.status === 'revoked' && row.delivery_status === 'revoked' && row.resolution_json === null) {
        if (row.request_kind === 'approval') {
          const a = byId.get([...attributed][0])!;
          if (a.result !== null || typeof a.stopEffectId !== 'string') throw new Error('Revoked approval contradicts terminal or cancellation');
        }
        continue;
      }
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
    const journal = db.query('SELECT event_id,event_json,receipt_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? ORDER BY rowid').all(systemId, invocationId) as EventRow030[];
    const allHandoffs = db.query('SELECT effect_id,owner_epoch,generation,receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as HandoffRow030[];
    const native: NativeRoutes030 = {
      preparations: hasTable('engine_flow030_preparations') ? db.query('SELECT prepare_id,native_receipt_id,owner_epoch,generation,reference_json,producer_json,source_json,content_receipts_json,result_json FROM engine_flow030_preparations WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as PreparationRow030[] : [],
      provenance: hasTable('engine_flow030_occurrence_provenance') ? db.query('SELECT native_receipt_id,target_ordinal,item_index,provenance_json FROM engine_flow030_occurrence_provenance WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as OccurrenceProvenanceRow030[] : [],
      owner: hasTable('engine_flow030_owners') ? db.query('SELECT owner_epoch,generation FROM engine_flow030_owners WHERE system_id=? AND invocation_id=?').get(systemId, invocationId) as NativeRoutes030['owner'] : null,
      contentContexts: hasTable('engine_flow030_route_content_contexts') ? db.query('SELECT prepare_id,target_ordinal,item_index,context_id,owner_epoch,generation,identity_json FROM engine_flow030_route_content_contexts WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as NativeRoutes030['contentContexts'] : [],
      contentReceipts: hasTable('engine_flow030_route_content_receipts') ? db.query('SELECT context_id,transport_receipt_json FROM engine_flow030_route_content_receipts WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as NativeRoutes030['contentReceipts'] : [],
    };
    verifyDurableGraph(state, plan, rows, journal, allHandoffs, native);
    db.exec('COMMIT');
    const counts: Obj = { ...Object.fromEntries(Object.entries(starts).map(([key, value]) => [key, new NumberToken(String(value))])), ...composeVisits };
    return stringify({ run: state.verdict, starts: counts, messages, joins, failures, cancelled, answers, ...(Object.keys(composeVisits).length ? { composeVisits } : {}) });
  } finally { db.close(); }
}
