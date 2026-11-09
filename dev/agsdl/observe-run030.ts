import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { evaluateHostWork030 } from '../../src/services/agsdlExecution/hostWorkTransition030';
import { evaluateHostHumanClock030 } from '../../src/services/agsdlExecution/hostHumanClock030';
import { connectValueSchemaValidator030 } from '../../src/services/agsdlExecution/valueSchemaPort030';
import { validate as validateValueSchema030 } from '../../src/vendor/agsdl/v0.3/valueschema.mjs';
import { commandOutput030, mcpOutput030, prepareCall030 } from '../../src/services/agsdlExecution/calls030';
import { ConformanceError } from '../../src/services/agsdlExecution/exact';
import { resolveRouteMessage030 } from '../../src/services/agsdlExecution/messages030';
import { preflightExpansion030, type ItemContext030, type RouteSource030, type RouteTarget030 } from '../../src/services/agsdlExecution/routes030';
import type { ExactJsonText, StepAddress } from '../../src/services/agsdlExecution/contracts';
import { SchemaChecker } from '../../src/vendor/agsdl/v0.3/schemacheck.mjs';
import schema030 from '../../src/vendor/agsdl/v0.3/schema/agsdl.schema.json';
import { NumberToken, parse, stringify, type ExactValue } from '../../src/vendor/agsdl/v0.3/json.mjs';
import { compareNumbers, isInteger } from '../../src/vendor/agsdl/v0.3/values.mjs';

export interface ObserveOptions030 {
  /** Executable and optional prefix arguments, never a shell command. */
  replayCommand?: readonly string[];
  replayTimeoutMs?: number;
  /** Only accepted by bun:test for explicitly marked synthetic unit fixtures. */
  syntheticUnitTestOnly?: true;
}
export interface ReplayVerdict030 {
  ok: boolean;
  divergence?: { eventId?: string; field: string; expected: unknown; stored: unknown };
  outsideReplay?: string[];
}
// The synchronous caller starts an asynchronous supervisor. Only spawn(), not
// spawnSync(), creates the detached verifier group on Bun/macOS. The supervisor
// stays outside that group, signals it and proves ESRCH before returning.
const replaySupervisor030 = String.raw`
const { spawn } = await import('node:child_process');
const { argv, deadline, grace, joinLimit } = JSON.parse(process.argv.at(-1));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let stdout = [], stderr = [], size = 0, timedOut = false, failure = null;
let closed = false, status = null, signal = null, cleanup = null;
const child = Date.now() < deadline ? spawn(argv[0], argv.slice(1), {
  detached: true, stdio: ['ignore', 'pipe', 'pipe'],
}) : null;
const groupPid = child?.pid ?? null;
process.stdout.write(JSON.stringify({ phase: 'started', groupPid }) + '\n');
function groupExists() {
  if (!groupPid) return false;
  try { process.kill(-groupPid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
function send(signal) {
  if (!groupPid) return;
  try { process.kill(-groupPid, signal); }
  catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
}
async function finish() {
  clearTimeout(timer);
  let groupJoined = false;
  try {
    send('SIGTERM');
    const until = performance.now() + grace;
    while (groupExists() && performance.now() < until) await sleep(5);
    if (groupExists()) send('SIGKILL');
    const joinedBy = performance.now() + joinLimit;
    while ((groupExists() || !closed) && performance.now() < joinedBy) await sleep(5);
    groupJoined = !groupExists() && closed;
    if (!groupJoined) failure = failure ?? 'Verifier process group did not terminate';
  } catch (error) { failure = String(error); }
  process.stdout.write(JSON.stringify({ phase: 'finished', groupPid, groupJoined,
    timedOut, failure, status, signal, stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8') }) + '\n');
}
function stop(error) {
  if (error) failure = failure ?? error;
  if (!cleanup) cleanup = finish();
}
const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, deadline - Date.now()));
if (!child) { timedOut = true; closed = true; stop(); }
else {
  for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) stop('Verifier output exceeded its limit');
    if (!timedOut && size <= 8 * 1024 * 1024) chunks.push(chunk);
  });
  child.on('error', error => { closed = true; stop(String(error)); });
  child.on('exit', (code, endedBy) => {
    status = code; signal = endedBy;
    if (Date.now() >= deadline) timedOut = true;
    stop();
  });
  child.on('close', () => { closed = true; });
}
`;
function replayGroupExists030(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; throw error; }
}
// This fallback also runs if the supervisor crashes or reaches its hard limit.
function joinReplayGroup030(pid: number, grace: number, joinLimit: number): void {
  const send = (signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch (error) { if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; } };
  const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  send('SIGTERM');
  const until = performance.now() + grace;
  while (replayGroupExists030(pid) && performance.now() < until) sleep();
  if (replayGroupExists030(pid)) send('SIGKILL');
  const joinedBy = performance.now() + joinLimit;
  while (replayGroupExists030(pid) && performance.now() < joinedBy) sleep();
  if (replayGroupExists030(pid)) throw new Error('Verifier process group did not terminate');
}
export function verifyNativeReplay030(database: string, system: string, invocation: string, options: ObserveOptions030 = {}): ReplayVerdict030 {
  let command = options.replayCommand;
  if (!command && process.env.MACRO_AGSDL030_REPLAY_COMMAND) {
    try { command = JSON.parse(process.env.MACRO_AGSDL030_REPLAY_COMMAND); }
    catch { throw new Error('Native replay command is not a JSON argv array'); }
  }
  if (!Array.isArray(command) || !command.length || !command.every((arg) => typeof arg === 'string' && arg.length)) throw new Error('Native replay verifier is required');
  const timeout = options.replayTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('Invalid native replay timeout');
  let result: ReturnType<typeof spawnSync>;
  const grace = 100, joinLimit = 1000;
  try {
    result = spawnSync(process.execPath, ['--eval', replaySupervisor030, '--', JSON.stringify({ argv: [...command, database, system, invocation], deadline: Date.now() + timeout, grace, joinLimit })], {
      stdio: 'pipe', timeout: timeout + grace + joinLimit + 1000, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) { throw new Error(`Native replay execution failed: ${String(error)}`); }
  let started: { phase: string; groupPid: number | null }, ended: Record<string, unknown> | undefined;
  const control = Buffer.from(result.stdout ?? new Uint8Array()).toString('utf8').trim().split(/\r?\n/);
  try {
    started = JSON.parse(control[0]);
    if (started.phase !== 'started' || started.groupPid !== null && (!Number.isSafeInteger(started.groupPid) || started.groupPid <= 0)) throw new Error('Invalid verifier process group');
    // EPERM means present/unverifiable, never absent. Retry within the bounded
    // join and refuse unless ESRCH proves the exact group no longer exists.
    if (started.groupPid !== null) joinReplayGroup030(started.groupPid, grace, joinLimit);
    if (control.length === 2) ended = JSON.parse(control[1]);
  } catch (error) { throw new Error(`Native replay supervision failed: ${String(error)}`); }
  if (result.error || result.signal || result.status !== 0 || !ended || ended.phase !== 'finished' || ended.groupPid !== started.groupPid || ended.groupJoined !== true) throw new Error(`Native replay supervision refused: ${result.error ?? result.signal ?? JSON.stringify(ended)} ${Buffer.from(result.stderr ?? new Uint8Array()).toString('utf8').slice(0, 4096)}`);
  if (ended.timedOut === true) throw new Error('Native replay timeout: deadline exceeded; process group joined');
  if (ended.failure || ended.signal || ended.status !== 0) throw new Error(`Native replay refused: ${ended.failure ?? ended.signal ?? `exit ${ended.status}`} ${String(ended.stdout).slice(0, 8192)} ${String(ended.stderr).slice(0, 4096)}`);
  if (typeof ended.stdout !== 'string') throw new Error('Invalid native replay stdout');
  const output = ended.stdout.trim();
  if (output.split(/\r?\n/).length !== 1) throw new Error('Native replay must return one JSON line');
  let verdict: unknown;
  try { verdict = JSON.parse(output); }
  catch { throw new Error('Native replay returned invalid or missing JSON'); }
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict) || !('ok' in verdict) || typeof verdict.ok !== 'boolean') throw new Error('Invalid native replay verdict');
  if (!verdict.ok) throw new Error(`Native replay refused: ${JSON.stringify(verdict)}`);
  if ('divergence' in verdict && verdict.divergence !== undefined) throw new Error('Native replay reported a divergence with ok:true');
  if ('outsideReplay' in verdict && (!Array.isArray(verdict.outsideReplay) || !verdict.outsideReplay.every((field) => typeof field === 'string'))) throw new Error('Invalid native replay outsideReplay list');
  return verdict as ReplayVerdict030;
}

// The caller closes the native application and its pool before opening this reader.
// This observer accepts durable rows only and never controls the run.
type Obj = Record<string, ExactValue>;

// Legacy adapters retained solely for marked synthetic unit fixtures. Production
// reads native migrations 039/040 below and refuses these obsolete extensions.
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

type HostRow030 = Record<string, string | number | null>;
interface HostProjection030 { answers: Obj[]; timeoutIds: Set<string> }
const sha030 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// EffectivePolicy::fingerprint hashes struct serialization, not serde_json::Value
// key order. Keep the native field order from agsdl_permissions/{mod,paths}.rs.
function nativePolicyDigest030(value: ExactValue): string {
  const ordered = (value: ExactValue | undefined, fields: string[]): Obj => {
    const source = record(value);
    if (Object.keys(source).length !== fields.length || fields.some((field) => !Object.hasOwn(source, field))) throw new Error('Host evidence differs: native policy shape');
    return Object.fromEntries(fields.map((field) => [field, source[field]]));
  };
  const policy = (value: ExactValue): Obj => {
    const p = ordered(value, ['context', 'preset', 'directories', 'outside', 'rules', 'reviewer']);
    p.context = ordered(p.context, ['workspace', 'home']);
    if (!Array.isArray(p.directories) || !Array.isArray(p.rules)) throw new Error('Host evidence differs: native policy lists');
    p.directories = p.directories.map((d) => ordered(d, ['canonical', 'access']));
    p.rules = p.rules.map((r) => ordered(r, ['action', 'effect', 'pattern', 'logical', 'physical']));
    return p;
  };
  const effective = ordered(value, ['ceilings', 'current']);
  if (!Array.isArray(effective.ceilings) || effective.ceilings.length < 3) throw new Error('Host evidence differs: native policy ceilings');
  effective.ceilings = effective.ceilings.map(policy); effective.current = policy(effective.current);
  return sha030(stringify(effective));
}
// serde_json::Value object keys are ordered. Preserve exact numeric tokens.
const canonical030 = (value: ExactValue): string => Array.isArray(value) ? `[${value.map(canonical030).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical030(value[key])}`).join(',')}}` : stringify(value);
function terminalNoAdmission030(journal: EventRow030[], proof: Obj): boolean {
  return journal.some((row) => {
    const kind = record(record(raw(row.event_json)).kind), ended = kind.PhysicalEnded;
    return object(ended) && same(ended.work, proof.work) && object(ended.evidence) && ended.evidence.native_receipt_id === proof.nativeReceiptId && ended.evidence.descendants_joined === true;
  });
}

// Host evidence is outside reduce(). Never infer a missing native receipt from
// expect or reproduce flow scheduling here. The flow state has passed N-REPLAY.
function verifyHostTables030(db: Database, state: Obj, plan: Obj, effects: EffectRow030[], journal: EventRow030[]): HostProjection030 {
  const identity = record(state.identity), system = string(identity.systemStartId), invocation = string(identity.flowInvocationId);
  const require: (ok: unknown, field: string) => asserts ok = (ok, field) => { if (!ok) throw new Error(`Host evidence differs: ${field}`); };
  const list = (value: ExactValue | undefined): Obj[] => { require(Array.isArray(value), 'array'); return value.map(record); };
  const has = (table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE name=? AND type IN ('table','view')").get(table);
  const rows = (table: string): HostRow030[] => has(table) ? db.query(`SELECT * FROM ${table} WHERE system_id=? AND invocation_id=? ORDER BY rowid`).all(system, invocation) as HostRow030[] : [];
  const text = (row: HostRow030, key: string): string => { require(typeof row[key] === 'string', key); return row[key] as string; };
  const json = (row: HostRow030, key: string) => raw(text(row, key));
  const map = (values: HostRow030[], key: string) => { const result = new Map(values.map((r) => [text(r, key), r])); require(result.size === values.length, `duplicate ${key}`); return result; };
  const acts = new Map(list(state.activations).map((a) => [string(a.id), a])), steps = new Map(list(plan.steps).map((s) => [address(s.address), s]));
  const fx = new Map(effects.map((e) => [e.effect_id, { row: e, value: record(raw(e.effect_json)), kind: record(record(raw(e.effect_json)).kind) }]));
  const events = new Map(journal.map((e) => [e.event_id, record(raw(e.event_json))]));
  const starts = new Map(effects.flatMap((e) => { const kind = fx.get(e.effect_id)!.kind; return kind.kind === 'start' ? [[string(record(kind.work).activationId), { row: e, kind }] as const] : []; }));
  const owners = rows('engine_flow030_owners'); require(owners.length === 1, 'owner'); const owner = owners[0];
  const ownerValue = { systemStartId: system, ownerEpoch: text(owner, 'owner_epoch') };
  require(owner.snapshot_id === identity.snapshotId && owner.capture_epoch === identity.epoch, 'owner capture identity');
  const captures = rows('engine_start030_requests'); require(captures.length === 1 && sha030(text(captures[0], 'capture_json')) === owner.capture_sha256, 'owner capture digest');
  const capture = record(json(captures[0], 'capture_json')), privateCapture = record(raw(string(capture.privateCaptureJson)));
  require(owner.status === 'live' && privateCapture.generation === owner.generation, 'owner generation lifecycle');
  for (const obsolete of ['engine_flow030_call_receipts', 'engine_flow030_work_timeouts']) require(rows(obsolete).length === 0, 'unsupported legacy adapter rows');
  const request = record(json(captures[0], 'request_json')), startReceipt = record(json(captures[0], 'receipt_json'));
  require(request.requestId === captures[0].request_id && same(startReceipt.identity, identity), 'Start request/receipt');
  const entries = has('engine_start030_entries') ? db.query('SELECT delivery_id FROM engine_start030_entries WHERE system_id=?').all(system) as Array<{ delivery_id: string }> : [];
  require(request.entry === null ? entries.length === 0 : entries.length === 1 && entries[0].delivery_id === record(request.entry).deliveryId, 'Start delivery registry');
  if (has('engine_ui_intents')) {
    const intents = db.query('SELECT request_id,delivery_id,admission_system030_id,kind,payload_json FROM engine_ui_intents WHERE admission_system030_id=? OR request_id=?').all(system, text(captures[0], 'request_id')) as HostRow030[];
    for (const intent of intents) { require(intent.admission_system030_id === system && intent.request_id === request.requestId && intent.kind === 'start' && intent.delivery_id === (object(request.entry) ? request.entry.deliveryId : null), 'Start UI intent'); json(intent, 'payload_json'); }
  }
  const metadata = (row: HostRow030) => require(row.owner_epoch === owner.owner_epoch && row.generation === owner.generation
    && (row.capture_sha256 === undefined || row.capture_sha256 === owner.capture_sha256), 'owner/generation/capture');
  const binding = (id: string) => { const a = acts.get(id), start = starts.get(id); require(a && start, `activation/Start ${id}`); return { a, start, work: record(start.kind.work), step: steps.get(address(a.step))! }; };
  const handoffs = map(rows('engine_flow030_handoffs'), 'effect_id');
  const unadmitted = map(rows('engine_flow030_no_admissions'), 'start_effect_id');
  for (const [id, row] of unadmitted) {
    metadata(row); const effect = fx.get(id), proof = record(json(row, 'proof_json'));
    require(effect?.kind.kind === 'start' && !handoffs.has(id) && same(proof.identity, identity) && proof.ownerEpoch === owner.owner_epoch && proof.generation === owner.generation
      && same(proof.work, effect.kind.work) && ['unclaimed', 'unreleasedNativeClaim'].includes(string(proof.reason)), 'non-admission proof');
    const a = acts.get(string(record(proof.work).activationId)); require(a && a.stopEffectId !== null && terminalNoAdmission030(journal, proof), 'non-admission terminal');
  }
  for (const [id, row] of handoffs) {
    metadata(row); const effect = fx.get(id), receipt = record(json(row, 'receipt_json'));
    require(effect && same(receipt, raw(effect.row.settlement_json))
      && same(receipt.identity, identity) && receipt.effectId === id && receipt.ownerEpoch === owner.owner_epoch && receipt.generation === owner.generation, 'handoff/effect');
    if (effect.kind.kind === 'steer') {
      require(receipt.kind === 'nativeSteerConsumed030' && same(receipt.work, effect.kind.work)
        && receipt.deliveryActivationId === effect.kind.deliveryActivationId && receipt.messageJson === effect.kind.messageJson
        && typeof receipt.consumedAfterEventId === 'string' && events.has(receipt.consumedAfterEventId)
        && receipt.workAttempt === undefined && receipt.requestId === undefined, 'steer consumption handoff');
      continue;
    }
    require(receipt.kind === 'nativeOwnedHandoff030' && receipt.requestId === `flow030:${system}:${id}`, 'owned handoff');
    if (effect.kind.agent !== null && effect.kind.kind === 'start') {
      const attempt = record(receipt.workAttempt), reference = record(effect.kind.work);
      require(same(attempt.identity, identity) && same(attempt.owner, ownerValue) && attempt.generation === owner.generation && attempt.startEffectId === id && attempt.agent === effect.kind.agent
        && same(attempt.work, { systemStartId: system, flowInvocationId: invocation, activationId: reference.activationId!, step: effect.kind.step!, agentInstanceId: reference.agentInstanceId! }) && typeof attempt.providerAttemptId === 'string' && attempt.providerAttemptId.length > 0, 'handoff work attempt');
    } else if (effect.kind.kind === 'start') require(receipt.workAttempt === undefined, 'unexpected agent attempt');
  }
  for (const { row } of starts.values()) require(handoffs.has(row.effect_id) || unadmitted.has(row.effect_id), 'missing handed-off Start');
  // The observed format counts delivered works. A proven never-delivered work
  // remains explicitly unprojectable, rather than being invented as a start.
  require(unadmitted.size === 0, 'unprojectable never-delivered work');
  for (const row of rows('engine_flow030_system_stop_requests')) {
    metadata(row); const request = record(json(row, 'request_json')), receipt = record(json(row, 'receipt_json'));
    require(request.requestId === row.request_id && request.systemStartId === system && request.activationId === null && receipt.requestId === row.request_id && same(receipt.identity, identity)
      && receipt.ownerEpoch === owner.owner_epoch && receipt.generation === owner.generation && receipt.flowEventId === row.event_id, 'system Stop request');
    if (row.event_id !== null) { const event = events.get(text(row, 'event_id')); require(event && event.kind === 'Stop' && event.expectedRevision === receipt.beforeRevision, 'system Stop event'); }
    else require(receipt.revision === receipt.beforeRevision && receipt.verdict === state.verdict && receipt.stopping === state.stopping, 'terminal Stop alias');
  }
  const terminal = (work: Obj, receiptId?: string) => {
    const matches = journal.flatMap((row) => { const kind = record(events.get(row.event_id)!.kind), body = kind.WorkResult ?? kind.PhysicalEnded;
      if (!object(body) || !same(body.work, work)) return [];
      const proof = body.physical ?? body.evidence;
      return object(proof) && proof.descendants_joined === true && (receiptId === undefined || proof.native_receipt_id === receiptId) ? [{ kind, body, row }] : [];
    });
    require(matches.length === 1, 'native terminal/physical receipt'); return matches[0];
  };
  const producerOutput = (producer: Obj) => {
    const a = acts.get(string(producer.activationId)); require(a && same(a.step, producer.step), 'producer activation');
    const result = a.result;
    const error = record(raw(string(producer.outputJson))).error;
    require(object(result) && result.kind === 'completed' && result.outputJson === producer.outputJson
      || error !== undefined && [...fx.values()].some((f) => f.kind.kind === 'failure' && f.kind.activationId === a.id && f.kind.counted === true && same(f.kind.error, error)), 'producer output');
  };
  // 034: immutable preparation and occurrence copies of the accepted Prepared.
  const preparations = map(rows('engine_flow030_preparations'), 'prepare_id');
  const retained = list(state.preparations), preparedEvents = journal.flatMap((row) => {
    const body = record(events.get(row.event_id)!.kind).Prepared; return object(body) ? [{ row, body }] : [];
  });
  const occurrences = new Map<string, { row: HostRow030; item: Obj; batch: Obj; proof: Obj }>();
  const occurrenceKey = (receipt: string, ordinal: ExactValue, index: string) => JSON.stringify([receipt, stringify(ordinal), index]);
  for (const [id, row] of preparations) {
    metadata(row); const reference = record(json(row, 'reference_json')), producer = record(json(row, 'producer_json'));
    const saved = retained.find((p) => record(p.reference).prepareId === id), accepted = preparedEvents.filter((p) => record(p.body.reference).prepareId === id);
    require(saved && accepted.length === 1 && saved.status === 'consumed' && same(saved.reference, reference) && same(saved.producer, producer), 'preparation/state');
    const body = accepted[0].body;
    require(reference.prepareId === id && same(reference.identity, identity) && same(body.reference, reference) && body.native_receipt_id === row.native_receipt_id, 'preparation/Prepared');
    require(effects.filter((e) => { const k = fx.get(e.effect_id)!.kind; return k.kind === 'prepareRoute' && same(k.reference, reference) && same(k.producer, producer); }).length === 1, 'preparation/effect');
    producerOutput(producer);
    const source = record(json(row, 'source_json'));
    require(source.terminalId === producer.activationId && same(source.producerStep, producer.step) && source.outputJson === producer.outputJson, 'preparation source');
    const output = record(json(row, 'result_json')), ready = record(body.result).Ready;
    if (object(ready)) {
      require(output.kind === 'ready' && same(output.batches, ready.batches), 'preparation result');
      const proofs = list(output.provenance), items = list(ready.batches).flatMap((batch) => list(batch.items));
      require(proofs.length === items.length, 'preparation provenance count');
      for (const proof of proofs) {
        const occurrence = record(proof.occurrence), batches = list(ready.batches).filter((batch) => list(batch.items).some((item) => same(item.occurrence, occurrence)));
        require(batches.length === 1 && same(proof.source, source) && same(proof.producer, producer), 'preparation provenance');
        const item = list(batches[0].items).find((i) => same(i.occurrence, occurrence))!;
        const target = record(batches[0].target);
        if (target.kind === 'step') {
          const step = steps.get(address(target.address)); require(step, 'prepared captured step');
          if (['agent', 'approval', 'compose'].includes(string(step.type))) {
            const capturedRoute = list(plan.routes).find((r) => same(r.source, record(reference.route).source) && r.kind === record(reference.route).kind && r.key === record(reference.route).key);
            require(capturedRoute, 'prepared captured route');
            require(Array.isArray(target.address), 'prepared target address');
            const targetAddress: StepAddress = [string(target.address[0]), ...target.address.slice(1).map(string)];
            const routeTarget: RouteTarget030 = {
              kind: 'step', address: targetAddress, stepJson: string(step.declarationJson) as ExactJsonText,
              declarationJson: string(capturedRoute.declarationJson) as ExactJsonText,
              ...Object.fromEntries(['messageJson', 'eachPathJson', 'concurrencyJson', 'maxJson'].flatMap((key) => target[key] === null || target[key] === undefined ? [] : [[key, string(target[key])]])),
            };
            const routeSource = JSON.parse(stringify(source)) as RouteSource030, expansion = preflightExpansion030([routeTarget], routeSource);
            require(expansion.kind === 'ready', 'prepared operand differs from captured source');
            const batch = expansion.batches[0];
            const itemContext: ItemContext030 = item.itemJson === null ? { kind: 'absent' } : { kind: 'element', index: string(occurrence.itemIndex), valueJson: string(item.itemJson) as ExactJsonText, mission: batch.kind === 'fanout' && batch.mission, ...(batch.kind === 'fanout' && batch.instructionAuthority ? { instructionAuthority: batch.instructionAuthority } : {}) };
            const resolved = resolveRouteMessage030(string(plan.documentJson) as Parameters<typeof resolveRouteMessage030>[0], routeTarget, routeSource, itemContext);
            require(same(raw(resolved.messageJson), raw(string(item.messageJson))) && same(raw(JSON.stringify(resolved.promptProvenance)), proof.prompt), 'prepared message/provenance differs from captured source');
          }
        }
        const key = occurrenceKey(text(row, 'native_receipt_id'), occurrence.targetOrdinal!, string(occurrence.itemIndex));
        require(occurrence.nativeReceiptId === row.native_receipt_id && !occurrences.has(key), 'duplicate/foreign occurrence'); occurrences.set(key, { row, item, batch: batches[0], proof });
      }
    } else {
      const failed = record(record(body.result).Failed);
      require(output.kind === 'failed' && same(output.error, failed.error) && same(output.targetOrdinal, failed.target_ordinal), 'failed preparation');
    }
  }
  require(preparedEvents.length === preparations.size, 'missing native preparation');
  const provenance = rows('engine_flow030_occurrence_provenance'), seenOccurrences = new Set<string>();
  for (const row of provenance) {
    require(typeof row.target_ordinal === 'number', 'occurrence ordinal');
    const key = occurrenceKey(text(row, 'native_receipt_id'), new NumberToken(String(row.target_ordinal)), text(row, 'item_index')), expected = occurrences.get(key);
    require(expected && !seenOccurrences.has(key) && same(json(row, 'provenance_json'), expected.proof), 'occurrence provenance'); seenOccurrences.add(key);
  }
  require(seenOccurrences.size === occurrences.size, 'missing occurrence provenance');
  // 036: use the shipped pure work controller, not another hand-written reducer.
  const admissions = map(rows('engine_flow030_work_admissions'), 'activation_id'), states = map(rows('engine_flow030_work_state'), 'activation_id');
  const authorizations = map(rows('engine_flow030_work_authorizations'), 'event_id'), workEvents = map(rows('engine_flow030_work_events'), 'event_id');
  const checks = map(rows('engine_flow030_work_checks'), 'check_id'), expectedChecks = new Set<string>();
  const nativePlans = rows('engine_flow030_human_requests').filter((r) => r.kind === 'plan');
  const validateSchema = connectValueSchemaValidator030({ NumberToken, parse, validate: validateValueSchema030 });
  const workDecisions = new Map<string, Obj>();
  const ticketIds = new Set<string>();
  const opaque = (value: ExactValue | undefined): value is string => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 512 && !/\p{Cc}/u.test(value);
  const flowRevisions = new Set(journal.map((r) => string(record(raw(r.receipt_json)).revision)));
  const runRevision = BigInt(string(state.revision));
  for (const [id, row] of admissions) {
    metadata(row); const { a, start, work, step } = binding(id); require(step.type === 'agent' && row.start_effect_id === work.startEffectId, 'work admission Start');
    const context = record(json(row, 'context_json'));
    require(same(context.owner, ownerValue) && same(context.work, { systemStartId: system, flowInvocationId: invocation, activationId: id, step: a.step, agentInstanceId: a.instanceId }), 'work admission context');
    const agent = list(plan.agents).find((agent) => agent.agentName === a.agent); require(agent, 'work admission captured agent');
    const policy = record(json(row, 'policy_evidence_json')); require(object(policy.effectivePolicy) && typeof policy.policyDigest === 'string' && /^[a-f0-9]{64}$/.test(policy.policyDigest)
      && typeof policy.hostCeilingDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(policy.hostCeilingDigest), 'work admission policy');
    require(policy.policyDigest === nativePolicyDigest030(policy.effectivePolicy), 'work policy fingerprint');
    require(context.permissionsJson === privateCapture.callPermissionsJson && context.scopeJson === privateCapture.callScopeJson && context.registryVersion === record(capture.versions).registry, 'work admission captured context');
    const contract = record(json(row, 'contract_json'));
    require(row.contract_json === step.submissionContractJson && same(raw(string(contract.agentJson)), raw(string(agent.agentDeclarationJson))), 'work admission captured submission contract');
    let previous = '{"format":"macro-agsdl-work-journal/1","events":[]}', revision = '0';
    let previousFlowRevision = BigInt(string(record(raw(journal.find((r) => r.event_id === start.row.event_id)!.receipt_json)).revision));
    const records = [...workEvents.values()].filter((event) => event.activation_id === id);
    for (const recordRow of records) {
      const eventId = text(recordRow, 'event_id'), ticket = record(json(recordRow, 'ticket_json')), input = record(ticket.input), auth = authorizations.get(eventId);
      require(auth && auth.activation_id === id && same(json(auth, 'input_json'), input), 'work authorization/ticket');
      require(same(ticket.identity, identity) && ticket.generation === owner.generation && same(input.context, context) && input.eventId === eventId
        && input.expectedRevision === revision && ticket.stateJson === previous && ticket.contractJson === row.contract_json && ticket.optionsJson === row.options_json, 'work ticket binding');
      require(opaque(ticket.ticketId) && !ticketIds.has(ticket.ticketId) && opaque(input.eventId), 'work ticket identity'); ticketIds.add(ticket.ticketId);
      require(typeof ticket.flowRevision === 'string' && /^(0|[1-9][0-9]*)$/.test(ticket.flowRevision) && flowRevisions.has(ticket.flowRevision), 'work ticket flow revision');
      const flowRevision = BigInt(ticket.flowRevision);
      require(flowRevision >= previousFlowRevision && flowRevision <= runRevision, 'work ticket flow revision bounds'); previousFlowRevision = flowRevision;
      const event = record(raw(string(input.eventJson))), body = record(event.event);
      const call = input.nativeCall;
      if (body.kind === 'physicalEnded') require(input.control === true && call === null, 'native joined control attribution');
      else require(['visibleText', 'submit', 'turnEnded', 'planPresented', 'planResolved', 'checkEnded', 'stop'].includes(string(body.kind)) && input.control === false && object(call), 'native owned operation attribution');
      if (object(call)) require(Object.keys(call).length === 2 && opaque(call.providerAttemptId) && opaque(call.nativeCallId), 'native operation identity');
      require(object(call) ? auth.provider_attempt_id === call.providerAttemptId && auth.native_call_id === call.nativeCallId : auth.provider_attempt_id === null && auth.native_call_id === null, 'work native call authorization');
      if (object(call)) require(call.providerAttemptId === record(record(raw(start.row.settlement_json)).workAttempt).providerAttemptId, 'work provider attempt');
      const decision = record(json(recordRow, 'decision_json'));
      const evaluated = evaluateHostWork030(JSON.parse(text(row, 'context_json')), eventId, revision, text(row, 'contract_json'), previous, string(input.eventJson), text(row, 'options_json'), validateSchema);
      require(same(raw(evaluated.stateJson), raw(string(decision.stateJson))) && same(raw(evaluated.receiptJson), raw(string(decision.receiptJson))), 'work controller decision');
      const receipt = record(raw(string(decision.receiptJson))), action = record(receipt.decision);
      if (action.kind === 'planWaiting' || body.kind === 'planResolved') {
        const plans = nativePlans.filter((r) => same(json(r, 'work_ids_json'), [id]) && record(json(r, 'payload_json')).planId === body.planId);
        require(plans.length === 1, 'work plan has no unique native human request');
        if (action.kind === 'planWaiting') require(record(json(plans[0], 'payload_json')).text === body.text, 'work plan presented text');
        else {
          const answer = record(record(json(plans[0], 'resolution_json')).answer);
          require(body.decision === (answer.decision === 'yes' ? 'accept' : 'reject') && (body.comment ?? '') === (answer.comment ?? ''), 'work plan decision differs from native human resolution');
        }
      }
      if (action.kind === 'checkRequested') {
        const check = record(action.check), rowCheck = checks.get(string(check.checkId)), reservation = record(decision.check);
        require(rowCheck && rowCheck.activation_id === id && rowCheck.event_id === eventId && rowCheck.status === 'ended' && reservation.checkId === check.checkId
          && same(json(rowCheck, 'request_json'), check) && same(raw(string(reservation.invocationJson)), check), 'work check'); expectedChecks.add(string(check.checkId));
      } else require(decision.check === null, 'unexpected work check');
      if (action.kind === 'finished') {
        const flow = terminal(work, eventId); workDecisions.set(id, action);
        require(ticket.flowRevision === events.get(flow.row.event_id)!.expectedRevision, 'work terminal ticket flow revision');
        if (action.outcome === 'success') {
          const output = record(action.output), expected: Obj = { text: output.text!, results: raw(string(output.resultsJson)) };
          if (output.choice !== null) expected.choice = output.choice!; if (output.instructions !== null) expected.instructions = output.instructions!;
          const completed = record(record(flow.body.result).Completed);
          require(flow.kind.WorkResult !== undefined && same(raw(string(completed.output_json)), expected) && completed.route_key === output.choice, 'work terminal output');
        } else if (action.outcome === 'cancelled' && action.code === 'JOIN_CANCELLED') require(flow.kind.PhysicalEnded !== undefined && a.stopEffectId !== null, 'work cancelled terminal');
        else require(flow.kind.WorkResult !== undefined && same(record(record(flow.body.result).Failed).error, { code: action.code!, message: action.code!, details: [] }), 'work failure terminal');
      }
      // Keep event attribution anchored even for controller events with no flow effect.
      require(event.eventId === eventId, 'work event identity');
      previous = string(decision.stateJson); revision = (BigInt(revision) + 1n).toString();
    }
    const saved = states.get(id);
    if (!records.length) require(!saved && a.result === null && a.stopEffectId !== null && terminal(work, `physical:${record(record(raw(start.row.settlement_json)).workAttempt).providerAttemptId}`).kind.PhysicalEnded !== undefined, 'unobserved stopped work');
    else require(saved && saved.revision === revision && saved.state_json === previous && workDecisions.has(id), 'work final journal');
    require(start.kind.agent === a.agent, 'work agent');
  }
  require([...states.keys()].every((id) => admissions.has(id)) && authorizations.size === workEvents.size && [...authorizations.values()].every((r) => workEvents.has(text(r, 'event_id')) && admissions.has(text(r, 'activation_id')))
    && [...workEvents.values()].every((r) => admissions.has(text(r, 'activation_id'))) && expectedChecks.size === checks.size, 'orphan work protocol row');
  for (const [id] of starts) if (binding(id).step.type === 'agent') require(admissions.has(id), 'missing work admission');
  // 037: attestations, contexts and receipts refer to actual replayed occurrences.
  const sources = map(rows('engine_flow030_route_source_attestations'), 'prepare_id');
  for (const [id, row] of sources) {
    metadata(row); const saved = retained.find((p) => record(p.reference).prepareId === id), effect = fx.get(text(row, 'preparation_effect_id'));
    require(saved && effect?.kind.kind === 'prepareRoute' && same(effect.kind.reference, saved.reference) && same(json(row, 'producer_json'), saved.producer), 'route source/state');
    const producer = record(saved.producer), reference = record(saved.reference); producerOutput(producer);
    const prepared = preparations.get(id);
    if (prepared) require(typeof row.native_receipt_id === 'string' && row.native_receipt_id.length > 0 && same(json(row, 'source_json'), json(prepared, 'source_json')), 'route source/preparation');
    const sourceKind = record(reference.route).kind === 'error' ? 'error' : producer.kind;
    require(['agent', 'join', 'call', 'error'].includes(string(sourceKind)), 'unsupported native source producer kind');
    const kind = sourceKind === 'agent' ? 'agentWork' : sourceKind;
    require(row.receipt_kind === kind, 'source receipt kind');
    let producerAgent: ExactValue = null, instructions: Obj[] = [];
    if (kind === 'agentWork') {
      const eventId = text(row, 'work_event_id'), protocol = workEvents.get(eventId), decision = workDecisions.get(string(producer.activationId));
      require(protocol?.activation_id === producer.activationId && decision?.outcome === 'success', 'source work receipt');
      terminal(binding(string(producer.activationId)).work, eventId);
      producerAgent = acts.get(string(producer.activationId))!.agent!;
      if (record(decision.output).instructions !== null) instructions = [{ pathJson: '["instructions"]', producerAgent, terminalId: producer.activationId! }];
    } else require(row.work_event_id === null, 'unexpected source work event');
    if (producer.kind === 'call') {
      const calls = rows('engine_flow030_calls').filter((r) => r.activation_id === producer.activationId);
      require(calls.length === 1 && calls[0].status === 'terminal', 'source call receipt');
      const call = calls[0], receipt = record(json(call, 'receipt_json')), result = record(receipt.result);
      const end = terminal(binding(string(producer.activationId)).work);
      require(end.row.event_id === receipt.eventId && calls[0].start_effect_id === binding(string(producer.activationId)).work.startEffectId
        && (sourceKind === 'call' ? result.kind === 'completed' && result.outputJson === producer.outputJson
          : result.kind === 'failed' && record(raw(string(producer.outputJson))).error !== undefined), 'source call terminal');
      // The complete 039 attempt, raw receipt and normalization are verified
      // below by verifyNativeCallsAndClock030 against this same journal.
    }
    require(same(json(row, 'source_json'), { terminalId: producer.activationId!, producerStep: producer.step!, producerAgent, kind: sourceKind, outputJson: producer.outputJson!, provenance: { instructions } }), 'source native constructor');
  }
  for (const id of preparations.keys()) require(sources.has(id), 'missing route source attestation');
  const contexts = map(rows('engine_flow030_route_content_contexts'), 'context_id'), contentRows = rows('engine_flow030_route_content_receipts'), usedContexts = new Set<string>(), usedContent = new Set<HostRow030>();
  for (const row of preparations.values()) {
    const content = record(json(row, 'content_receipts_json')); require(content.format === 'macro-agsdl-route-content/1', 'content format');
    for (const occurrence of list(content.occurrences)) {
      const context = contexts.get(string(occurrence.contextId)); require(context, 'content context'); metadata(context);
      const expected = occurrences.get(occurrenceKey(text(row, 'native_receipt_id'), occurrence.targetOrdinal!, string(occurrence.itemIndex)));
      require(expected && expected.row.prepare_id === row.prepare_id && context.prepare_id === row.prepare_id && !usedContexts.has(text(context, 'context_id'))
        && same(new NumberToken(String(context.target_ordinal)), occurrence.targetOrdinal) && context.item_index === occurrence.itemIndex, 'content occurrence does not exist');
      const target = record(expected.batch.target), step = steps.get(address(target.address))!, contentIdentity = record(json(context, 'identity_json'));
      require(context.status === 'live' && ['agent', 'approval', 'compose'].includes(string(step.type)) && same(json(context, 'target_address_json'), target.address) && context.recipient_kind === step.type && context.recipient_agent === (step.agent ?? null), 'content recipient');
      require(Object.keys(contentIdentity).length === 4 && same(contentIdentity, occurrence.identity) && contentIdentity.captureId === identity.snapshotId && contentIdentity.sourceDigest === sha030(string(plan.documentJson))
        && contentIdentity.agent === context.recipient_agent && contentIdentity.policyDigest === sha030(text(context, 'policy_evidence_json')), 'content foreign identity');
      const expectedReceipts = Array.isArray(occurrence.receipts) ? [...occurrence.receipts] : undefined; require(expectedReceipts, 'content receipts');
      for (const receiptRow of contentRows.filter((r) => r.context_id === context.context_id)) {
        const transported = record(json(receiptRow, 'transport_receipt_json')), at = expectedReceipts.findIndex((r) => same(r, transported));
        require(at >= 0 && receiptRow.receipt_sha256 === sha030(canonical030(transported)), 'content receipt fingerprint'); expectedReceipts.splice(at, 1);
        const native = record(json(receiptRow, 'native_receipt_json')), provenance = record(native.provenance), original = record(json(receiptRow, 'source_json'));
        const document = record(raw(string(plan.documentJson))), expanded = original.ref === undefined ? original : record(record(document.content)[string(original.ref)]);
        require(original.ref === undefined || Object.keys(original).length === 1, 'content ref source');
        // A receipt's own copies and hashes cannot authorize a foreign use. Its
        // source is the resource at the attested location in the replayed item.
        const pointer = string(provenance.pointer), message = record(raw(string(expected.item.messageJson)));
        let replayedSource: ExactValue | undefined, usage: string | undefined;
        if (pointer.startsWith('/message/resources/')) {
          const name = pointer.slice('/message/resources/'.length), values = record(message.resources);
          const key = Object.hasOwn(values, name) ? name : name.replaceAll('~1', '/').replaceAll('~0', '~');
          if (Object.hasOwn(values, key)) { replayedSource = values[key]; usage = 'resource'; }
        } else if (/^\/message\/prompt\/(0|[1-9][0-9]*)$/.test(pointer) && Array.isArray(message.prompt)) {
          const index = BigInt(pointer.slice('/message/prompt/'.length));
          if (index < BigInt(message.prompt.length)) { replayedSource = message.prompt[Number(index)]; usage = 'prompt'; }
        }
        require(replayedSource !== undefined && provenance.usage === usage && same(replayedSource, expanded), 'content use differs from replayed message');
        require(Object.hasOwn(expanded, 'value'), 'unprojectable content payload absent from replayed message');
        require(same(raw(string(transported.sourceJson)), expanded) && same(native.payload, transported.payload), 'content payload/source');
        const expectedProvenance: Obj = { captureId: provenance.captureId!, sourceDigest: provenance.sourceDigest!, agent: provenance.agent!, usage: provenance.usage!, pointer: provenance.pointer!, requestedUri: expanded.uri ?? null, mediaType: provenance.mediaType!, sha256: provenance.sha256!, policyDigest: provenance.policyDigest! };
        require(same(transported.provenance, expectedProvenance) && provenance.captureId === contentIdentity.captureId && provenance.sourceDigest === contentIdentity.sourceDigest && provenance.agent === contentIdentity.agent && provenance.policyDigest === contentIdentity.policyDigest
          && provenance.sourceJsonDigest === sha030(text(receiptRow, 'source_json')), 'native content provenance');
        const payload = record(native.payload), bytes = payload.kind === 'text' ? Buffer.from(string(payload.text)) : payload.kind === 'json' ? Buffer.from(string(payload.json)) : payload.kind === 'media' ? Buffer.from(string(payload.base64), 'base64') : undefined;
        require(provenance.requestedUri === (expanded.uri ?? null) && provenance.declaredMediaType === (expanded.mediaType ?? null)
          && ['instructions', 'prompt', 'resource', 'skillDiscovery', 'skillActivation', 'skillResource', 'result'].includes(string(provenance.usage)) && string(provenance.pointer).length > 0, 'native content use/source');
        if (Object.hasOwn(expanded, 'value')) {
          require(provenance.finalUri === null && provenance.fileParentIdentity === null && provenance.observedMediaType === null && provenance.requestedUri === null
            && provenance.mediaType === (expanded.mediaType ?? (typeof expanded.value === 'string' ? 'text/plain' : 'application/json'))
            && (typeof expanded.value === 'string' ? payload.kind === 'text' && payload.text === expanded.value : payload.kind === 'json' && same(raw(string(payload.json)), expanded.value)), 'native inline content');
        } else require(typeof provenance.finalUri === 'string' && provenance.finalUri.length > 0, 'native content final URI');
        if (payload.kind === 'json') raw(string(payload.json));
        if (payload.kind === 'media') require(bytes?.toString('base64') === payload.base64, 'native content base64');
        require(bytes && provenance.sha256 === sha030(bytes) && provenance.sizeBytes === String(bytes.length), 'native content digest'); usedContent.add(receiptRow);
      }
      require(expectedReceipts.length === 0, 'missing native content receipt'); usedContexts.add(text(context, 'context_id'));
    }
  }
  require(usedContexts.size === contexts.size && usedContent.size === contentRows.length, 'orphan content proof');
  // 039/040 are verified below against the same replayed activations and effects.
  return verifyNativeCallsAndClock030(db, state, plan, effects, journal, owner);
}

// Exported for isolated adapter tests; observeRun030 always replays first.
export function verifyNativeCallsAndClock030(db: Database, state: Obj, plan: Obj, effects: EffectRow030[], journal: EventRow030[], owner: HostRow030): HostProjection030 {
  const require: (ok: unknown, field: string) => asserts ok = (ok, field) => { if (!ok) throw new Error(`Host evidence differs: ${field}`); };
  const list = (v: ExactValue | undefined): Obj[] => { require(Array.isArray(v), 'array'); return v.map(record); };
  const identity = record(state.identity), system = string(identity.systemStartId), invocation = string(identity.flowInvocationId), ownerValue = { systemStartId: system, ownerEpoch: string(owner.owner_epoch as string) };
  const has = (name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(name);
  const rows = (name: string): HostRow030[] => has(name) ? db.query(`SELECT * FROM ${name} WHERE system_id=? AND invocation_id=? ORDER BY rowid`).all(system, invocation) as HostRow030[] : [];
  const text = (row: HostRow030, key: string): string => { require(typeof row[key] === 'string', key); return row[key] as string; };
  const json = (row: HostRow030, key: string) => raw(text(row, key));
  const map = (values: HostRow030[], key: string) => { const m = new Map(values.map((r) => [text(r, key), r])); require(m.size === values.length, `duplicate ${key}`); return m; };
  const metadata = (row: HostRow030) => require(row.owner_epoch === owner.owner_epoch && row.generation === owner.generation, 'clock/call owner');
  const acts = new Map(list(state.activations).map((a) => [string(a.id), a])), steps = new Map(list(plan.steps).map((s) => [address(s.address), s]));
  const starts = new Map(effects.flatMap((row) => { const value = record(raw(row.effect_json)), kind = record(value.kind); return kind.kind === 'start' ? [[string(record(kind.work).activationId), { row, value, kind }] as const] : []; }));
  const events = new Map(journal.map((row) => [row.event_id, record(raw(row.event_json))]));
  const work = (id: string) => { const a = acts.get(id), start = starts.get(id); require(a && start, 'host activation/Start'); return { a, start, reference: record(start.kind.work), step: steps.get(address(a.step))! }; };
  const ms = (v: string) => { require(/^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= 18446744073709551615n, 'native milliseconds'); return BigInt(v); };
  const handoffClocks = map(rows('engine_flow030_handoff_clock'), 'start_effect_id');
  for (const [id, row] of handoffClocks) { metadata(row); ms(text(row, 'started_ms')); require([...starts.values()].some((s) => s.row.effect_id === id), 'handoff clock Start'); }
  const clocks = rows('engine_flow030_clock'), clockEvents = map(rows('engine_flow030_clock_events'), 'event_id'), clockWorks = map(rows('engine_flow030_clock_works'), 'activation_id');
  const requests = map(rows('engine_flow030_human_requests'), 'request_id'), submissions = map(rows('engine_flow030_human_submissions'), 'receipt_id'), proofs = map(rows('engine_flow030_human_resolution_proofs'), 'request_id'), controls = map(rows('engine_flow030_clock_controls'), 'activation_id');
  require(clocks.length <= 1 && (clocks.length === 1 || !clockEvents.size && !clockWorks.size && !requests.size && !submissions.size && !proofs.size && !controls.size), 'clock parent');
  const history: Array<{ id: string; event: Obj; receipt: Obj }> = [];
  if (clocks.length) {
    const clock = clocks[0]; metadata(clock); let previous = '', revision = '0', receipt: Obj = {}, observed: string | undefined;
    for (const [id, row] of clockEvents) {
      const input = record(json(row, 'ticket_json'));
      require(same(input.identity, identity) && same(input.owner, ownerValue) && input.eventId === id && input.expectedRevision === revision && input.stateJson === previous, 'clock ticket');
      const event = record(raw(string(input.eventJson))); require(event.eventId === id && same(event.owner, ownerValue), 'clock event identity');
      const now = string(event.nowMs); require(observed === undefined || ms(now) >= ms(observed), 'clock monotonicity');
      const evaluated = evaluateHostHumanClock030(ownerValue, id, revision, previous, string(input.eventJson), JSON.parse(string(input.optionsJson)));
      const output = record(json(row, 'output_json'));
      require(same(raw(evaluated.stateJson), raw(string(output.stateJson))) && same(raw(evaluated.receiptJson), raw(string(output.receiptJson))), 'clock output');
      previous = string(output.stateJson); receipt = record(raw(string(output.receiptJson))); observed = now; revision = (BigInt(revision) + 1n).toString();
      history.push({ id, event, receipt });
    }
    require(clock.revision === revision && clock.state_json === previous && same(json(clock, 'receipt_json'), receipt), 'clock final journal');
    ms(text(clock, 'observed_ms')); if (observed !== undefined) require(clock.observed_ms === observed, 'clock final observation');
  }
  const bodies = history.map((h) => ({ ...h, body: record(h.event.event) }));
  const latest = history.at(-1)?.receipt;
  for (const [id, row] of clockWorks) {
    metadata(row); const bound = work(id), binding = record(json(row, 'work_json')), origin = handoffClocks.get(text(row, 'start_effect_id'));
    require(origin && row.start_effect_id === bound.reference.startEffectId && row.admitted_ms === origin.started_ms && row.kind === bound.step.type, 'clock work admission');
    require(same(binding.identity, identity) && same(binding.owner, ownerValue) && binding.generation === owner.generation && same(binding.reference, bound.reference) && binding.kind === row.kind, 'clock work binding');
    const attempt = record(raw(bound.start.row.settlement_json)).workAttempt;
    require(binding.providerAttemptId === (row.kind === 'agent' ? record(attempt).providerAttemptId : null), 'clock provider attempt');
    const agent = list(plan.agents).find((a) => a.agentName === bound.a.agent), declaration = record(raw(string(bound.step.declarationJson)));
    const answerTimeout = row.kind === 'agent' && agent ? record(raw(string(agent.agentDeclarationJson))).answerTimeoutMs : declaration.answerTimeoutMs;
    require(row.timeout_json === null ? bound.step.timeoutMsJson === null : same(json(row, 'timeout_json'), raw(string(bound.step.timeoutMsJson))), 'clock authored timeout');
    require(row.answer_timeout_json === null ? answerTimeout === undefined : answerTimeout !== undefined && same(json(row, 'answer_timeout_json'), answerTimeout), 'clock authored answer timeout');
    const admission = bodies.filter((h) => (h.body.kind === 'admit' || h.body.kind === 'approval') && h.body.workId === id);
    require(admission.length === 1 && admission[0].body.startedAtMs === row.admitted_ms && admission[0].body.timeoutMs === row.timeout_json, 'clock admit event');
    if (row.kind !== 'approval') require(admission[0].body.answerTimeoutMs === row.answer_timeout_json, 'clock answer duration');
    require(row.retired === Number(bodies.some((h) => h.body.kind === 'retire' && h.body.workId === id)), 'clock retirement');
    if (row.kind !== 'approval' && (bound.a.phase === 'done' || bound.a.physical === false || bound.a.result !== null || bound.a.stopEffectId !== null)) require(row.retired === 1, 'terminal replayed work has a live clock');
    const snapshots = latest ? [...list(latest.clocks), ...list(latest.retiredClocks)].filter((c) => c.workId === id) : [];
    require(row.kind === 'approval' ? same(json(row, 'snapshot_json'), {}) : snapshots.length === 1 && same(json(row, 'snapshot_json'), snapshots[0].snapshot), 'clock work snapshot');
  }
  for (const h of bodies) {
    if (['admit', 'approval', 'retire'].includes(string(h.body.kind))) require(clockWorks.has(string(h.body.workId)), 'orphan clock work event');
    if (h.body.kind === 'open' || h.body.kind === 'approval' || h.body.kind === 'associate' || h.body.kind === 'ack') require(requests.has(string(h.body.requestId)), 'orphan clock request event');
    if (h.body.kind === 'open') {
      require(h.body.reviewer === 'person', 'native human reviewer');
      require(Array.isArray(h.body.workIds) && h.body.workIds.length === 1, 'human request initial work attribution');
    }
    if (h.body.kind === 'associate') require(requests.get(string(h.body.requestId))!.kind === 'question', 'native reassociation requires a question');
    if (h.body.kind === 'open' || h.body.kind === 'associate') for (const id of h.body.workIds as ExactValue[]) require(clockWorks.has(string(id)), 'request work association');
  }
  const answers: Obj[] = [], timeoutIds = new Set<string>();
  for (const [id, row] of requests) {
    const opening = bodies.filter((h) => (h.body.kind === 'open' || h.body.kind === 'approval') && h.body.requestId === id);
    require(opening.length === 1 && (opening[0].body.kind === 'approval' ? row.kind === 'approval' : opening[0].body.requestKind === row.kind), 'human request opening');
    const snapshots = latest ? list(latest.requests).filter((r) => r.requestId === id) : []; require(snapshots.length === 1, 'human request snapshot');
    const snapshot = snapshots[0], ids = json(row, 'work_ids_json');
    require(same(ids, snapshot.workIds) && row.kind === snapshot.kind && row.opened_ms === snapshot.openedAtMs
      && same(json(row, 'deadline_json'), { openedAtMs: snapshot.openedAtMs!, timeoutMs: snapshot.answerTimeoutMs! }), 'human request deadline/works');
    require(Array.isArray(ids) && (row.kind === 'question' || ids.length > 0) && ids.every((workId) => clockWorks.has(string(workId))), 'human request work');
    const payload = record(json(row, 'payload_json'));
    const initialIds = opening[0].body.kind === 'approval' ? [string(opening[0].body.workId)] : (opening[0].body.workIds as ExactValue[]).map(string);
    if (row.kind === 'plan') require(initialIds.length === 1 && work(initialIds[0]).step.type === 'agent' && typeof payload.planId === 'string' && payload.planId.length > 0 && typeof payload.text === 'string' && payload.text.trim().length > 0, 'native plan payload');
    if (row.kind === 'approval') {
      require(initialIds.length === 1, 'approval work'); const bound = work(initialIds[0]), declaration = record(raw(string(bound.step.declarationJson)));
      require(bound.step.type === 'approval' && same(payload.work, bound.reference) && same(payload.step, bound.a.step)
        && same(payload.message, bound.start.kind.messageJson === null ? {} : raw(string(bound.start.kind.messageJson)))
        && same(payload.choices, Object.keys(record(declaration.next)).sort()) && same(payload.choices, opening[0].body.choices), 'approval payload');
    }
    if (row.resolution_json === null) {
      require(row.revision === '0' && !proofs.has(id) && row.delivery === 'pending'
        && !history.some((h) => list(h.receipt.pendingResolutions).some((r) => r.requestId === id)) && !bodies.some((h) => h.body.kind === 'ack' && h.body.requestId === id)
        && initialIds.every((workId) => work(workId).a.result === null && work(workId).a.stopEffectId !== null), 'unresolved human request');
      continue;
    }
    const resolution = record(json(row, 'resolution_json')), proof = proofs.get(id), proofEvent = proof && history.find((h) => h.id === proof.event_id);
    require(proof && proofEvent && row.revision === '1' && same(json(proof, 'resolution_json'), resolution), 'human resolution proof');
    const candidates = list(proofEvent.receipt.pendingResolutions).filter((r) => r.requestId === id);
    require(candidates.length === 1, 'human resolution event'); const candidate = candidates[0];
    const reason = candidate.expired !== true ? 'answer' : candidate.failure === 'APPROVAL_TIMEOUT' ? 'approvalTimeout' : 'answerTimeout';
    require(same(resolution, { ...candidate, reason }) && row.delivery === 'acknowledged' && bodies.some((h) => h.body.kind === 'ack' && h.body.requestId === id), 'human resolution/delivery');
    for (const action of list(resolution.workActions)) {
      require(clockWorks.has(string(action.workId)), 'human work action');
      if (action.action === 'PLAN_REJECTED') {
        const a = work(string(action.workId)).a;
        require(row.kind === 'plan' && (object(a.result) && a.result.kind === 'failed' && record(a.result.error).code === 'PLAN_REJECTED'
          || a.result === null && a.stopEffectId !== null), 'plan resolution contradicts replayed terminal');
      }
    }
    if (row.kind === 'plan') {
      const protocol = rows('engine_flow030_work_events').filter((r) => r.activation_id === initialIds[0]).map((r) => {
        const ticket = record(json(r, 'ticket_json')), input = record(ticket.input);
        return { event: record(record(raw(string(input.eventJson))).event), decision: record(record(raw(string(record(json(r, 'decision_json')).receiptJson))).decision) };
      });
      require(protocol.some((p) => p.event.kind === 'planPresented' && p.event.planId === payload.planId && p.event.text === payload.text && p.decision.kind === 'planWaiting'), 'plan payload differs from native work protocol');
      const answer = record(resolution.answer);
      require(protocol.some((p) => p.event.kind === 'planResolved' && p.event.planId === payload.planId && p.event.decision === (answer.decision === 'yes' ? 'accept' : 'reject') && (p.event.comment ?? '') === (answer.comment ?? '')), 'plan delivery differs from native work protocol');
    }
    if (row.kind === 'approval') {
      const bound = work(initialIds[0]), result = record(bound.a.result);
      if (reason === 'approvalTimeout') require(result.kind === 'failed' && record(result.error).code === 'APPROVAL_TIMEOUT', 'approval timeout terminal');
      else { const answer = record(resolution.answer); require(result.kind === 'completed' && result.routeKey === answer.choice && same(raw(string(result.outputJson)), { choice: answer.choice!, comment: answer.comment!, message: payload.message! }), 'approval answer terminal'); }
    } else if (reason === 'answerTimeout') for (const action of list(resolution.workActions)) { const bound = work(string(action.workId)), item = optionalItem(bound.a); answers.push({ work: address(bound.a.step), ...(item.item === undefined ? {} : { item: item.item }), answer: 'no' }); }
  }
  require([...proofs.keys()].every((id) => requests.has(id)), 'orphan human proof');
  const nativeAnswers = latest ? list(latest.nativeAnswers) : [];
  for (const [id, row] of submissions) {
    const projected = nativeAnswers.filter((a) => a.nativeReceiptId === id && a.requestId === row.request_id), request = requests.get(text(row, 'request_id'));
    const submitted = bodies.filter((h) => (h.body.kind === 'answer' || h.body.kind === 'approvalAnswer') && h.body.nativeReceiptId === id && h.body.requestId === row.request_id);
    require(request && projected.length === 1 && submitted.length === 1 && ['person', 'synthetic-person'].includes(text(row, 'origin')) && row.received_ms === submitted[0].event.nowMs
      && row.accepted === Number(projected[0].accepted), 'human submission arbitration');
    const answer = record(json(row, 'answer_json')), body = submitted[0].body;
    if (request.kind === 'approval') require(answer.kind === 'approval' && answer.choice === body.choice && answer.comment === body.comment, 'approval submission');
    else if (request.kind === 'question') { require(answer.kind === 'question' && body.answer === null, 'question submission'); raw(string(answer.answerJson)); }
    else require(answer.kind === 'decision' && same(body.answer, { decision: answer.decision!, comment: answer.comment! }), 'decision submission');
  }
  require(nativeAnswers.length === submissions.size, 'missing human submission');
  for (const [id, row] of controls) {
    const bound = work(id), clock = clockWorks.get(id); require(clock && row.reason === 'TIMEOUT' && row.joined === 1 && typeof row.receipt_id === 'string' && row.receipt_id.length > 0, 'timeout control');
    require(bodies.some((h) => h.event.nowMs === row.observed_ms && (h.receipt.expiredWorkIds as ExactValue[]).includes(id)), 'timeout clock decision');
    require(object(bound.a.result) && bound.a.result.kind === 'failed' && record(bound.a.result.error).code === 'TIMEOUT', 'timeout terminal'); timeoutIds.add(id);
  }
  // Call rows are retained even when normalization fails or work is cancelled.
  const calls = map(rows('engine_flow030_calls'), 'call_id'), seenCallActivations = new Set<string>();
  const callCauses: HostRow030[] = has('engine_flow030_call_causes') ? db.query('SELECT x.* FROM engine_flow030_call_causes x LEFT JOIN engine_flow030_calls c USING(call_id) WHERE (c.system_id=? AND c.invocation_id=?) OR c.call_id IS NULL').all(system, invocation) as HostRow030[] : [];
  const causes = map(callCauses, 'call_id'); require(rows('engine_flow030_call_diagnostics').length === 0, 'durable call diagnostic');
  for (const [id, row] of calls) {
    const bound = work(text(row, 'activation_id')), attempt = record(json(row, 'attempt_json')), receipt = record(json(row, 'receipt_json')), received = record(json(row, 'received_json'));
    require(bound.step.type === 'call' && !seenCallActivations.has(text(row, 'activation_id')) && row.start_effect_id === bound.reference.startEffectId && row.status === 'terminal', 'call Start/status'); seenCallActivations.add(text(row, 'activation_id'));
    require(same(attempt.identity, identity) && attempt.ownerEpoch === owner.owner_epoch && attempt.generation === owner.generation && attempt.captureSha256 === owner.capture_sha256 && attempt.callId === id
      && same(attempt.effect, bound.start.value) && attempt.declarationJson === bound.step.declarationJson && same(receipt.attempt, attempt) && same(receipt.received, received), 'call attempt/receipt');
    const eventId = string(receipt.eventId), flow = events.get(eventId); require(eventId === `call:${id}:terminal` && flow, 'call flow event');
    const end = record(received.end), physical = record(received.physical), result = record(receipt.result), kind = record(flow.kind), body = record(kind.WorkResult ?? kind.PhysicalEnded);
    require(same(body.work, bound.reference) && ['notStarted', 'syntheticJoined'].includes(string(physical.kind)) && same(body.physical ?? body.evidence, { native_receipt_id: physical.receiptId!, descendants_joined: true }), 'call physical receipt');
    if (result.kind === 'stopped') require(bound.a.stopEffectId !== null && kind.PhysicalEnded !== undefined && body.stop_effect_id === bound.a.stopEffectId, 'call stop receipt');
    else {
      require(kind.WorkResult !== undefined, 'call result event'); const wire = record(body.result);
      if (result.kind === 'completed') require(same(record(wire.Completed), { output_json: result.outputJson!, route_key: record(raw(string(result.outputJson))).outcome! }), 'call completed result');
      else require(result.kind === 'failed' && same(record(wire.Failed).error, { code: result.code!, message: result.code!, details: [] }), 'call failure result');
    }
    let computed: ReturnType<typeof prepareCall030> | undefined, operandFailed = false;
    try { computed = prepareCall030(string(bound.step.declarationJson) as Parameters<typeof prepareCall030>[0], { outputJson: string(bound.start.kind.inputJson) } as Parameters<typeof prepareCall030>[1]); }
    catch (error) { if (error instanceof ConformanceError && error.code === 'OPERAND') operandFailed = true; else throw error; }
    if (row.prepared_json !== null) {
      require(computed, 'call prepared operand');
      const expected = { ...computed, ...(computed.kind === 'command' ? { parse: computed.parse ?? null } : {}) };
      require(same(raw(JSON.stringify(expected)), json(row, 'prepared_json')), 'call prepared operand');
    }
    const controlled = result.kind === 'stopped' || result.kind === 'failed' && result.code === 'TIMEOUT';
    if (end.kind === 'returned' && !controlled) {
      require(row.prepared_json !== null && computed, 'call prepared request'); const prepared = record(json(row, 'prepared_json')), declaration = record(raw(string(bound.step.declarationJson)));
      const event = record(end.event); let normalized: string | undefined, failed = false;
      if (event.kind === 'startFailed') require(result.kind === 'failed' && result.code === 'CALL_FAILED', 'call start failure');
      else {
      try {
        if (prepared.kind === 'command') { require(event.kind === 'commandReceipt', 'call command return'); normalized = commandOutput030(computed as Parameters<typeof commandOutput030>[0], { stdout: string(event.stdout), stderr: string(event.stderr), output: string(event.stdout) + string(event.stderr), exitCodeJson: stringify(event.exitCode!) as Parameters<typeof commandOutput030>[1]['exitCodeJson'], complete: true }); }
        else { require(event.kind === 'toolReturned', 'call MCP return'); normalized = mcpOutput030({ isError: event.isError === true, text: string(event.text), ...(event.structuredContentJson === null ? {} : { structuredContentJson: string(event.structuredContentJson) as Parameters<typeof mcpOutput030>[0]['structuredContentJson'] }) }); }
      } catch (error) { if (error instanceof ConformanceError && error.code === 'OUTPUT_INVALID') failed = true; else throw error; }
      if (result.kind === 'completed') require(normalized !== undefined && same(raw(normalized), raw(string(result.outputJson))), 'call raw normalization');
      else require(result.kind === 'failed' && result.code === 'OUTPUT_INVALID' && failed, 'call normalization failure');
      }
      require(declaration.type === 'call', 'call declaration');
    } else require(['returned', 'stopped', 'timedOut', 'preparationFailed'].includes(string(end.kind)) && (controlled || end.kind === 'preparationFailed'), 'call end kind');
    if (result.kind === 'failed' && result.code === 'TIMEOUT') require(causes.has(id) && timeoutIds.has(text(row, 'activation_id')), 'call timeout cause');
    if (end.kind === 'preparationFailed') require(operandFailed && physical.kind === 'notStarted' && row.prepared_json === null && result.kind === 'failed' && result.code === 'OPERAND', 'call preparation failure');
    const causeRow = causes.get(id);
    if (causeRow) { const cause = record(json(causeRow, 'cause_json')), clockCause = controls.get(text(row, 'activation_id')), budget = clockWorks.get(text(row, 'activation_id')); require(clockCause && budget && same(cause.attempt, attempt) && typeof cause.causeId === 'string' && same(cause.cause, { clockReceiptId: text(clockCause, 'receipt_id'), observedMs: text(clockCause, 'observed_ms'), timeoutJson: text(budget, 'timeout_json') }), 'call clock cause'); }
  }
  require([...causes.keys()].every((id) => calls.has(id)), 'orphan call cause');
  for (const [id] of starts) {
    const bound = work(id); if (bound.step.type === 'call') require(seenCallActivations.has(id), 'missing call receipt');
    const agent = list(plan.agents).find((a) => a.agentName === bound.a.agent), declaration = record(raw(string(bound.step.declarationJson)));
    if (bound.step.type === 'approval' || bound.step.timeoutMsJson !== null && bound.step.timeoutMsJson !== undefined || declaration.answerTimeoutMs !== undefined || agent && record(raw(string(agent.agentDeclarationJson))).answerTimeoutMs !== undefined) require(clockWorks.has(id), 'missing native work clock');
    if (bound.step.type === 'approval') require([...requests.values()].some((r) => r.kind === 'approval' && Array.isArray(json(r, 'work_ids_json')) && (json(r, 'work_ids_json') as ExactValue[]).includes(id)), 'missing approval request');
    if (object(bound.a.result) && bound.a.result.kind === 'failed' && record(bound.a.result.error).code === 'TIMEOUT') require(timeoutIds.has(id), 'missing timeout control');
    if (object(bound.a.result) && bound.a.result.kind === 'failed' && record(bound.a.result.error).code === 'PLAN_REJECTED') require([...requests.values()].some((r) => r.kind === 'plan' && r.resolution_json !== null && list(record(json(r, 'resolution_json')).workActions).some((a) => a.workId === id && a.action === 'PLAN_REJECTED')), 'missing native plan rejection');
  }
  return { answers, timeoutIds };
}

// Historical secondary checks for explicitly synthetic unit fixtures only.
// Production relies on native reduce replay, not on this partial TS model.
function verifySecondaryReducerEvidence030(state: Obj, plan: Obj, rows: EffectRow030[], events: EventRow030[], handoffs: HandoffRow030[], native: NativeRoutes030): void {
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

export function observeRun030(databasePath: string, systemId: string, invocationId: string, options: ObserveOptions030 = {}): string {
  if (!options.syntheticUnitTestOnly) verifyNativeReplay030(databasePath, systemId, invocationId, options);
  const db = new Database(databasePath, { readonly: true });
  try {
    db.exec('BEGIN');
    const run = db.query('SELECT state_json,plan_json,snapshot_id,epoch FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?').get(systemId, invocationId) as { state_json: string; plan_json: string; snapshot_id: string; epoch: string } | null;
    if (!run) throw new Error('Run is absent');
    const plan = record(raw(run.plan_json));
    const synthetic = options.syntheticUnitTestOnly === true;
    if (synthetic) {
      if (process.env.NODE_ENV !== 'test' || plan.format !== 'macro-agsdl-observer-synthetic-unit/1') throw new Error('Replay bypass is restricted to synthetic unit tests');
    }
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
    const journal = db.query('SELECT event_id,event_json,receipt_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? ORDER BY rowid').all(systemId, invocationId) as EventRow030[];
    const host = synthetic ? null : verifyHostTables030(db, state, plan, rows, journal);
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
    const timeoutRows = synthetic && hasTable('engine_flow030_work_timeouts')
      ? db.query('SELECT activation_id,start_effect_id,status,terminal_event_id,physical_receipt_id FROM engine_flow030_work_timeouts WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as TimeoutReceiptRow030[] : [];
    const timeouts = new Map(timeoutRows.map((row) => [row.activation_id, row]));
    const timeoutIds = host?.timeoutIds ?? new Set(timeouts.keys());
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
        if (record(kind.error).code === 'TIMEOUT' && !timeoutIds.has(string(kind.activationId))) throw new Error('Timeout receipt is absent');
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
        if (!timeoutIds.has(string(activation.id))) cancelled.push({ step: address(activation.step), ...(item.item === undefined ? {} : { item: item.item }) });
      } else if (kind.kind !== 'prepareRoute' && kind.kind !== 'return' && kind.kind !== 'runEnded') {
        throw new Error('Unprojectable effect kind');
      }
    }
    if (host) answers.push(...host.answers);
    else {
      // Legacy adapter fixtures are confined to the synthetic unit-test path.
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
    }
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
    const allHandoffs = db.query('SELECT effect_id,owner_epoch,generation,receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as HandoffRow030[];
    const native: NativeRoutes030 = {
      preparations: hasTable('engine_flow030_preparations') ? db.query('SELECT prepare_id,native_receipt_id,owner_epoch,generation,reference_json,producer_json,source_json,content_receipts_json,result_json FROM engine_flow030_preparations WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as PreparationRow030[] : [],
      provenance: hasTable('engine_flow030_occurrence_provenance') ? db.query('SELECT native_receipt_id,target_ordinal,item_index,provenance_json FROM engine_flow030_occurrence_provenance WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as OccurrenceProvenanceRow030[] : [],
      owner: hasTable('engine_flow030_owners') ? db.query('SELECT owner_epoch,generation FROM engine_flow030_owners WHERE system_id=? AND invocation_id=?').get(systemId, invocationId) as NativeRoutes030['owner'] : null,
      contentContexts: hasTable('engine_flow030_route_content_contexts') ? db.query('SELECT prepare_id,target_ordinal,item_index,context_id,owner_epoch,generation,identity_json FROM engine_flow030_route_content_contexts WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as NativeRoutes030['contentContexts'] : [],
      contentReceipts: hasTable('engine_flow030_route_content_receipts') ? db.query('SELECT context_id,transport_receipt_json FROM engine_flow030_route_content_receipts WHERE system_id=? AND invocation_id=?').all(systemId, invocationId) as NativeRoutes030['contentReceipts'] : [],
    };
    if (synthetic) verifySecondaryReducerEvidence030(state, plan, rows, journal, allHandoffs, native);
    db.exec('COMMIT');
    const counts: Obj = { ...Object.fromEntries(Object.entries(starts).map(([key, value]) => [key, new NumberToken(String(value))])), ...composeVisits };
    return stringify({ run: state.verdict, starts: counts, messages, joins, failures, cancelled, answers, ...(Object.keys(composeVisits).length ? { composeVisits } : {}) });
  } finally { db.close(); }
}
