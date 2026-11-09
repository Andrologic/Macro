import { Database } from 'bun:sqlite';
import { SchemaChecker } from '../../src/vendor/agsdl/v0.3/schemacheck.mjs';
import schema030 from '../../src/vendor/agsdl/v0.3/schema/agsdl.schema.json';
import { NumberToken, parse, stringify, type ExactValue } from '../../src/vendor/agsdl/v0.3/json.mjs';

// The caller closes the native application and its pool before opening this reader.
// This observer accepts durable rows only and never controls the run.
type Obj = Record<string, ExactValue>;
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

export function observeRun030(databasePath: string, systemId: string, invocationId: string): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    db.exec('BEGIN');
    const run = db.query('SELECT state_json,plan_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?').get(systemId, invocationId) as { state_json: string; plan_json: string } | null;
    if (!run) throw new Error('Run is absent');
    const plan = record(raw(run.plan_json));
    if (!Array.isArray(plan.steps) || !Array.isArray(plan.agents)) throw new Error('Invalid durable plan');
    if (plan.steps.map(record).some((step) => step.type === 'approval' || step.type === 'call')
      || plan.agents.map(record).some((agent) => Object.hasOwn(record(raw(string(agent.agentDeclarationJson))), 'answerTimeoutMs'))) {
      throw new Error('Answers are not projectable');
    }
    const diagnostic = db.query('SELECT 1 FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND diagnostic_json IS NOT NULL LIMIT 1').get(systemId, invocationId);
    if (diagnostic) throw new Error('Flow diagnostic remains');
    const state = record(raw(run.state_json));
    if (state.verdict !== 'succeeded' && state.verdict !== 'failed') throw new Error('Run is not terminal');
    if (!Array.isArray(state.activations) || !Array.isArray(state.groups)) throw new Error('Invalid durable state');
    const activations = state.activations.map(record);
    if (activations.some((a) => a.physical !== false)) throw new Error('Physical work remains');
    const byId = new Map(activations.map((a) => [string(a.id), a]));
    const rows = db.query('SELECT effect_id,event_id,effect_json,status FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? ORDER BY rowid').all(systemId, invocationId) as Array<{ effect_id: string; event_id: string; effect_json: string; status: string }>;
    const starts: Record<string, number> = Object.create(null);
    const messages: Obj[] = [], failures: Obj[] = [], cancelled: Obj[] = [];
    for (const row of rows) {
      if (row.status !== 'settled') throw new Error('Pending or uncertain effect remains');
      const effect = record(raw(row.effect_json)), kind = record(effect.kind);
      if (kind.kind === 'start' || kind.kind === 'steer') {
        const work = record(kind.work), activation = byId.get(string(work.activationId));
        if (!activation) throw new Error('Delivery activation is absent');
        const target = kind.kind === 'start' ? address(kind.step) : address(activation.step);
        if (kind.kind === 'start') {
          const handoff = db.query('SELECT receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=?').get(systemId, invocationId, row.effect_id) as { receipt_json: string } | null;
          if (!handoff) throw new Error('Start handoff is absent');
          const receipt = record(raw(handoff.receipt_json));
          if (receipt.kind !== 'nativeOwnedHandoff030' || receipt.effectId !== row.effect_id) throw new Error('Start handoff differs');
          starts[target] = (starts[target] ?? 0) + 1;
        }
        const message = kind.messageJson === null ? {} : record(raw(string(kind.messageJson)));
        if (message.prompt !== undefined && message.prompt !== null && typeof message.prompt !== 'string') throw new Error('Prompt is unresolved');
        const rowItem = optionalItem(activation);
        const out: Obj = { to: target, prompt: message.prompt ?? null, ...rowItem };
        const delivered = resources(message.resources);
        if (delivered !== undefined) out.resources = delivered;
        messages.push(out);
      } else if (kind.kind === 'failure') {
        const activation = byId.get(string(kind.activationId));
        if (!activation) throw new Error('Failed activation is absent');
        const item = optionalItem(activation);
        failures.push({ step: address(kind.step), ...(item.item === undefined ? {} : { item: item.item }), code: string(record(kind.error).code) });
      } else if (kind.kind === 'stopWork') {
        const event = db.query('SELECT event_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?').get(systemId, invocationId, row.event_id) as { event_json: string } | null;
        if (!event) throw new Error('Stop event is absent');
        const source = record(raw(event.event_json)).kind;
        if (source === 'Stop') throw new Error('Stop effect in a non-cancelled run');
        record(source);
        const activation = byId.get(string(record(kind.work).activationId));
        if (!activation) throw new Error('Stopped activation is absent');
        const item = optionalItem(activation);
        cancelled.push({ step: address(activation.step), ...(item.item === undefined ? {} : { item: item.item }) });
      } else if (kind.kind !== 'prepareRoute' && kind.kind !== 'return' && kind.kind !== 'runEnded') {
        throw new Error('Unprojectable effect kind');
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
    const counts: Obj = Object.fromEntries(Object.entries(starts).map(([key, value]) => [key, new NumberToken(String(value))]));
    return stringify({ run: state.verdict, starts: counts, messages, joins, failures, cancelled, answers: [] });
  } finally { db.close(); }
}
