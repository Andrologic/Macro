// Deterministic vectors, separate from the unmodified live scenario captures.
import { evaluateHostHumanClock030 } from '../../src/services/agsdlExecution/hostHumanClock030';
import type { ClockRequest030 } from './clock-oracle030';
type Input = Record<string, unknown>;
const owner = { systemStartId: 'run', ownerEpoch: 'epoch' };
const options = { maxSliceMs: 1000 };
export const CLOCK_SEED030 = 'clock-030-20261113-v1';
export const CLOCK_MINIMUMS030 = { host: 130, journal: 200, validation: 360, clock: 60, registry: 85, association: 20, native: 35, generated: 128, 'association-method': 88 };
export function buildClockCorpus030() {
  const cases: { id: string; family: string; request: ClockRequest030 }[] = [];
  const seen = new Set<string>();
  const add = (family: string, op: string, input: unknown, raw?: readonly [string, string]) => {
    let json = JSON.stringify(input);
    if (raw) json = json.replaceAll(JSON.stringify(raw[0]), raw[1]);
    const request = { op, json };
    const signature = JSON.stringify(request);
    if (seen.has(signature)) return;
    seen.add(signature); cases.push({ id: `clock-${cases.length}`, family, request });
  };
  const input = (body: Input, nowMs = '0', eventId = 'e', extra: Input = {}) => ({ owner, eventId, expectedRevision: '0', stateJson: '', eventJson: JSON.stringify({ owner, eventId, nowMs, event: body }), options, ...extra });
  const admit = (workId = 'w', timeoutMs: unknown = null, answerTimeoutMs: unknown = null) => ({ kind: 'admit', workId, timeoutMs, answerTimeoutMs });
  const open = (requestId = 'r', workIds = ['w'], requestKind: unknown = 'ask', reviewer: unknown = 'person') => ({ kind: 'open', requestId, workIds, requestKind, reviewer });
  const answer = (requestId = 'r', nativeReceiptId = 'receipt', value: unknown = { decision: 'yes' }) => ({ kind: 'answer', requestId, nativeReceiptId, answer: value });
  const seq = (family: string, events: [string, Input, string?][], slice = 1000) => {
    let stateJson = '', revision = 0;
    const captured: { request: ReturnType<typeof input>; result: ReturnType<typeof evaluateHostHumanClock030> }[] = [];
    for (const [now, body, id] of events) {
      const request = input(body, now, id ?? `e${captured.length}`, { stateJson, expectedRevision: String(revision), options: { maxSliceMs: slice } });
      add(family, 'host', request);
      const result = evaluateHostHumanClock030(request.owner, request.eventId, request.expectedRevision, request.stateJson, request.eventJson, request.options);
      if (result.stateJson !== stateJson) revision++;
      stateJson = result.stateJson; captured.push({ request, result });
    }
    for (const entry of captured) add('journal', 'host', { ...entry.request, stateJson, expectedRevision: String(revision) });
    return { stateJson, expectedRevision: String(revision), captured };
  };
  seq('host', [['0', admit('a', '60000', '100')], ['0', admit('b', null, '50')], ['30000', open('shared', ['a', 'b'], 'plan')], ['30020', open('other', ['a'])], ['30100', { kind: 'tick' }], ['30120', { kind: 'tick' }], ['30121', { kind: 'ack', requestId: 'shared' }]]);
  for (const kind of ['ask', 'plan', 'question']) for (const reviewer of ['person', 'model']) {
    const value = kind === 'question' ? null : { decision: 'no', comment: '\ufeffRéviser.\u0085' };
    seq('host', [['0', admit('w', '60000', '10')], ['1', open('r', ['w'], kind, reviewer)], ['3', answer('r', 'first', value)], ['4', answer('r', 'second', value)], ['5', { kind: 'ack', requestId: 'r' }], ['6', { kind: 'retire', workId: 'w' }]]);
  }
  for (const at of ['9', '10', '11', '9007199254740993123456']) seq('host', [['0', admit('w', '100', '10')], ['0', open('r', ['w'], 'question')], [at, answer('r', 'native', null)], [at, { kind: 'ack', requestId: 'r' }]]);
  seq('host', [['0', admit('a', '10', '5')], ['0', admit('b', '1000', '100')], ['0', open('r', ['a', 'b'])], ['2', { kind: 'retire', workId: 'a' }], ['3', { kind: 'associate', requestId: 'r', workIds: [] }], ['20', { kind: 'tick' }], ['20', { kind: 'associate', requestId: 'r', workIds: ['b'] }], ['30', { kind: 'associate', requestId: 'r', workIds: ['b'] }], ['200', { kind: 'tick' }]]);
  seq('host', [['0', admit('a', null, '10')], ['0', admit('b', null, '1000')], ['0', open('r', ['b'])], ['50', { kind: 'associate', requestId: 'r', workIds: ['a'] }]]);
  seq('host', [['0', admit('w', '60000')], ['30000', open('a')], ['30000', open('b')], ['3630000', answer('a', 'one')], ['3630000', answer('b', 'two')], ['3659999', { kind: 'tick' }], ['3660000', { kind: 'tick' }]]);
  const noops = seq('host', [['0', admit('w', '100'), 'first'], ['30', { kind: 'tick' }], ['0', admit('w', '100')], ['0', admit('w', '100')], ['100', { kind: 'tick' }]]);
  add('journal', 'host', { ...input(admit('w', '101'), '0', 'new'), stateJson: noops.stateJson, expectedRevision: noops.expectedRevision });
  for (const at of ['9', '10', '11']) {
    seq('host', [['0', { kind: 'approval', requestId: 'a', workId: 'host', choices: ['publish', 'revise'], timeoutMs: '10' }], [at, { kind: 'approvalAnswer', requestId: 'a', nativeReceiptId: 'native', choice: 'revise', comment: 'Corriger le titre.' }], [at, { kind: 'ack', requestId: 'a' }]]);
  }
  for (const slice of [1, 2, 999, 2147483647]) {
    seq('host', [['9007199254740993123456', admit('w', '100', '1e999999999999999999999')], ['9007199254740993123506', { kind: 'tick' }], ['9007199254740993123506', open()], ['9007199254740993999999', { kind: 'tick' }]], slice);
    seq('host', [['5000', { kind: 'admit', workId: 'w', timeoutMs: '60000', answerTimeoutMs: null, startedAtMs: '0' }], ['60000', { kind: 'tick' }]], slice);
    seq('host', [['5000', { kind: 'approval', requestId: 'a', workId: 'w', choices: ['x'], timeoutMs: '1000', startedAtMs: '0' }]], slice);
  }
  for (const requestKind of [['ask'], ['plan'], ['question']]) for (const reviewer of ['person', ['person'], ['model']]) seq('host', [['0', admit('w', '100', '10')], ['0', open('r', ['w'], requestKind, reviewer)], ['11', { kind: 'tick' }]]);
  const answered = seq('host', [['0', admit('w', '1000')], ['10', open('r', ['w'], 'question')], ['20', answer('r', 'native', null)], ['30', { kind: 'ack', requestId: 'r' }], ['10', open('r', ['w'], 'question')], ['50', { kind: 'tick' }]]);
  const active = seq('host', [['0', admit('w', '1000', '10')], ['0', open()]]);
  const waitingApproval = seq('host', [['0', { kind: 'approval', requestId: 'a', workId: 'host', choices: ['publish', 'revise'], timeoutMs: '100' }]]);
  for (const [state, bodies] of [
    [answered, [answer('r', 'native', { decision: 'yes' }), answer('other', 'native', null), open('r', ['w'], 'ask'), { kind: 'tick' }, { kind: 'approval', requestId: 'r', workId: 'host', choices: ['x'], timeoutMs: null }]],
    [active, [answer('r', 'n', null), { kind: 'ack', requestId: 'r' }, { kind: 'associate', requestId: 'r', workIds: ['unknown'] }, { kind: 'associate', requestId: 'r', workIds: ['w', 'w'] }, { kind: 'retire', workId: 'unknown' }]],
    [waitingApproval, [{ kind: 'approvalAnswer', requestId: 'a', nativeReceiptId: 'n', choice: 'wrong', comment: '' }, { kind: 'ack', requestId: 'a' }, open('a', []), { kind: 'approval', requestId: 'a', workId: 'host', choices: ['x'], timeoutMs: null }]],
  ] as const) for (const body of bodies) for (const now of ['0', '1', '100']) add('journal', 'host', { ...input(body, now), stateJson: state.stateJson, expectedRevision: state.expectedRevision });
  seq('host', [['0', admit('w', null, '10')], ['0', open()], ['0', { kind: 'approval', requestId: 'a', workId: 'host', choices: ['x'], timeoutMs: '10' }], ['20', { kind: 'tick' }]]);
  const base = input({ kind: 'tick' });
  for (const bad of [undefined, null, false, 0, '', [], {}, { systemStartId: 'run' }, { systemStartId: 'run', ownerEpoch: ' ' }, { ...owner, extra: 1 }]) add('validation', 'host', { ...base, owner: bad });
  for (const field of ['eventId', 'expectedRevision', 'stateJson', 'eventJson', 'options']) for (const value of [undefined, null, false, 0, 1, '', '01', [], ['0'], {}, { toString: 0 }, '\ud800']) add('validation', 'host', { ...base, [field]: value });
  for (const slice of [undefined, null, false, '1', 0, -1, 0.5, 2147483648, 9007199254740992, Number.POSITIVE_INFINITY, {}, []]) add('validation', 'host', { ...base, options: { maxSliceMs: slice } });
  for (const bad of ['', '{', '[', 'null', '[]', '1', '{"x":1,"x":2}', '1.1.', '"\ud800"', '"\\ud800"', '\ufeff{}']) for (const field of ['stateJson', 'eventJson']) add('validation', 'host', { ...base, [field]: bad });
  for (const body of [admit(), open(), answer(), { kind: 'associate', requestId: 'r', workIds: [] }, { kind: 'approval', requestId: 'a', workId: 'w', choices: ['x'], timeoutMs: null }, { kind: 'approvalAnswer', requestId: 'a', nativeReceiptId: 'n', choice: 'x', comment: '' }, { kind: 'retire', workId: 'w' }, { kind: 'ack', requestId: 'r' }, { kind: 'tick' }]) {
    for (const key of Object.keys(body)) {
      for (const value of [undefined, null, false, 0, '', [], {}, '\ud800']) add('validation', 'host', input({ ...body, [key]: value }));
    }
    add('validation', 'host', input({ ...body, extra: true }));
  }
  for (const [key, value] of [['owner', null], ['owner', { ...owner, ownerEpoch: 'foreign' }], ['eventId', 'different'], ['nowMs', '01'], ['nowMs', '-1'], ['nowMs', '1e3'], ['extra', true]]) add('validation', 'host', { ...base, eventJson: JSON.stringify({ ...JSON.parse(base.eventJson), [key as string]: value }) });
  for (const mutate of ['receipt', 'repeat', 'entry', 'owner', 'options', 'format', 'reverse', 'syntax']) {
    const journal = JSON.parse(noops.stateJson);
    if (mutate === 'receipt') journal.entries[0].receiptJson = '{}';
    if (mutate === 'repeat') journal.entries[1] = journal.entries[0];
    if (mutate === 'entry') journal.entries[0].extra = 1;
    if (mutate === 'owner') journal.owner.ownerEpoch = 'foreign';
    if (mutate === 'options') journal.options.maxSliceMs = 1;
    if (mutate === 'format') journal.format = 'bad';
    if (mutate === 'reverse') journal.entries.reverse();
    if (mutate === 'syntax') journal.entries[0].eventJson = '1.1.';
    add('journal', 'host', { ...base, stateJson: JSON.stringify(journal), expectedRevision: String(journal.entries.length) });
  }
  const clocks = (family: string, timeoutMs: unknown, nowMs: unknown, steps: unknown[]) => add(family, 'clock', { timeoutMs, nowMs, steps });
  const validSteps = [{ op: 'advance', nowMs: '30' }, { op: 'open', requestId: 'a', nowMs: '30' }, { op: 'open', requestId: 'b', nowMs: '40' }, { op: 'close', requestId: 'a', nowMs: '90' }, { op: 'wake', maxSliceMs: 0 }, { op: 'advance', nowMs: '150' }, { op: 'detach', requestId: 'b', nowMs: '150' }, { op: 'open', requestId: 'b', nowMs: '160' }, { op: 'close', requestId: 'b', nowMs: '170' }, { op: 'advance', nowMs: '240' }, { op: 'open', requestId: 'a', nowMs: '240' }, { op: 'advance', nowMs: '239' }, { op: 'snapshot', mutate: { elapsedMachineMs: 'fake' } }];
  for (const limit of [null, '100', '1e999999999999999999999', ' 1.0e2 ', '0', '-1', '01', '1.5', undefined, false]) clocks('clock', limit, '0', validSteps);
  for (const now of [null, undefined, false, 0, '', '00', '-1', '1\n', '\ud800', '9007199254740993123456']) clocks('clock', null, now, []);
  for (const op of ['open', 'close', 'detach']) for (const requestId of [undefined, null, 0, false, {}, [], '', '\ufeff', '\u0085', '\ud800']) clocks('clock', '100', '0', [{ op, requestId, nowMs: '10' }, { op: 'advance', nowMs: '20' }]);
  for (const maxSliceMs of [undefined, null, false, '1', 0, -1, 0.1, 1, 10, 2147483647, 2147483648, Number.POSITIVE_INFINITY]) clocks('clock', '1e999', '0', [{ op: 'wake', maxSliceMs }]);
  const create = (label = 'w', timeoutMs: unknown = '1000', nowMs = '0') => ({ op: 'create', label, timeoutMs, nowMs });
  const register = (workId = 'w', answerTimeoutMs: unknown = '10', label = workId) => ({ op: 'register', label, workId, answerTimeoutMs });
  const regOpen = (requestId = 'r', workIds = ['w'], kind = 'plan', reviewer = 'person', openedAtMs = '0') => ({ op: 'open', input: { requestId, kind, reviewer, workIds, openedAtMs } });
  for (const operation of ['wake', 'open', 'associate', 'resolve', 'retire', 'tick']) {
    const trigger = operation === 'open' ? regOpen('c', [], 'ask', 'person', '20') : { op: operation, requestId: 'a', workId: 'w', workIds: [], answer: { decision: 'yes' }, nowMs: '20' };
    add('registry', 'registry', { steps: [create(), register(), regOpen('a'), regOpen('b'), trigger, { op: 'pending' }, { op: 'ack', requestId: 'a' }, { op: 'ack', requestId: 'a' }, { op: 'request', requestId: 'b' }] });
  }
  for (const comment of [undefined, '', '\ufeff', '\u0085', '\u200b', 'Réviser.', null, 0]) for (const kind of ['ask', 'plan', 'question']) add('registry', 'registry', { steps: [create(), register(), regOpen('r', ['w'], kind), { op: 'resolve', requestId: 'r', answer: { decision: 'no', comment }, nowMs: '1' }, { op: 'tick', nowMs: '2' }, { op: 'request', requestId: 'r' }] });
  for (const bad of [null, undefined, false, 0, [], {}, { requestId: null }, { requestId: '' }, { requestId: 'r', workIds: ['unknown'] }, { requestId: 'r', workIds: ['w', 'w'] }]) add('registry', 'registry', { steps: [create(), register(), { op: 'open', input: bad }, { op: 'tick', nowMs: '20' }] });
  for (const workIds of [undefined, null, false, 0, {}, '', 'w', 'ww', ['w'], ['w', 'w']]) for (const op of ['open', 'associate']) add('registry', 'registry', { steps: [create(), register(), { op: 'open', input: { requestId: 'r', kind: 'ask', reviewer: 'person', workIds: ['w'], openedAtMs: '0' } }, op === 'open' ? { op, input: { requestId: 'other', kind: 'ask', reviewer: 'person', workIds, openedAtMs: '5' } } : { op, requestId: 'r', workIds, nowMs: '5' }, { op: 'tick', nowMs: '10' }] });
  for (const answer of [undefined, null, false, 0, {}, { decision: 'bad' }, { decision: 'yes', extra: 1 }]) add('registry', 'registry', { steps: [create(), register(), regOpen(), { op: 'resolve', requestId: 'r', answer, nowMs: '1' }, { op: 'tick', nowMs: '10' }] });
  for (const requestId of [undefined, null, 0, false, {}, [], 'unknown']) for (const op of ['request', 'ack', 'resolve']) add('registry', 'registry', { steps: [create(), register(), regOpen(), { op, requestId, answer: { decision: 'yes' }, nowMs: '10' }] });
  for (const requestKind of [{ toString: 0 }, [{ toString: 0 }], ['ask']]) add('validation', 'host', input(open('r', [], requestKind)));
  for (const raw of ['{"maxSliceMs":1.1.}', '{"maxSliceMs":1,}', '{"maxSliceMs":1,"maxSliceMs":1000}']) add('native', 'broker', { job: { generation: 'generation', inputJson: JSON.stringify({ operation: 'humanClock', input: { owner, eventId: 'e', expectedRevision: '0', stateJson: '', eventJson: JSON.stringify({ owner, eventId: 'e', nowMs: '0', event: { kind: 'tick' } }), optionsJson: raw }, contentReceipts: false }) } });
  for (const invalid of ['0', '01', 'bad', false, undefined]) add('registry', 'registry', { steps: [create(), register('w', invalid), register('w', '10'), { op: 'tick', nowMs: '10' }] });
  add('registry', 'registry', { steps: [create('a'), create('b'), register('a', '5'), register('b', '100'), regOpen('r', ['a', 'b']), { op: 'retire', workId: 'a', nowMs: '2' }, { op: 'associate', requestId: 'r', workIds: [], nowMs: '3' }, { op: 'tick', nowMs: '20' }, { op: 'associate', requestId: 'r', workIds: ['b'], nowMs: '20' }, { op: 'tick', nowMs: '200' }, { op: 'retire', workId: 'b', nowMs: '200' }, regOpen('r', ['a', 'b'])] });
  add('registry', 'registry', { steps: [create(), register(), regOpen(), { op: 'associate', requestId: 'unknown', workIds: [], nowMs: '20' }, { op: 'tick', nowMs: '19' }, { op: 'request', requestId: 'r' }] });
  for (const callsObservable of [true, false, 0, 'yes']) for (const serverId of ['s', 'other', '\ud800']) add('association', 'associate', { serverId, callsObservable, works: [{ workId: 'b', servers: ['s'], callsInProgress: [] }, { workId: 'a', servers: ['s'], callsInProgress: ['s'] }, { workId: 'b', servers: ['s'], callsInProgress: ['s'] }] });
  for (const inputJson of ['null', '{}', '{', JSON.stringify({ operation: 'humanClock' }), JSON.stringify({ operation: 'humanClock', input: null }), JSON.stringify({ operation: 'humanClock', input: { ...base, optionsJson: '{' } })]) add('native', 'broker', { job: { generation: 'generation', inputJson } });
  for (const raw of ['{', '1.1.', '[1.1.]', '{"x":1.1.}', '"\ud800"', '"\\ud800"', '{"maxSliceMs":1,"maxSliceMs":1000}', 'null', '{}']) {
    for (const contentReceipts of [undefined, false, { format: 'wrong' }]) add('native', 'broker', { job: { generation: 'generation', inputJson: JSON.stringify({ operation: 'humanClock', input: { ...base, optionsJson: raw }, contentReceipts }) } });
  }
  for (const works of [null, false, {}, 0, [], [null], [{ workId: 'w', servers: null }], [{ workId: 'w', servers: 0 }], [{ workId: 'w', servers: 'server' }]]) add('association', 'associate', { serverId: 's', callsObservable: false, works });
  const job = { ticket: 'ticket', generation: 'generation', inputDigest: 'digest', input: { ...base, optionsJson: JSON.stringify(options), identity: { systemStartId: 'run', flowInvocationId: 'flow', snapshotId: 'snapshot', epoch: 'capture' } } };
  add('native', 'job', job);
  for (const field of ['ticket', 'generation', 'inputDigest']) add('native', 'job', { ...job, [field]: '' });
  for (const value of [undefined, null, false, 0, [], {}, { owner: {} }, { owner: { ownerEpoch: 'e' }, identity: null }]) {
    add('native', 'job', { ...job, input: value });
    add('native', 'job', { ...job, ticket: '', input: value });
  }
  for (const identity of [null, undefined, false, 0, [], {}, { systemStartId: 'run', extra: '' }, { systemStartId: 'foreign' }]) add('native', 'job', { ...job, input: { ...job.input, identity } });
  for (const bad of [undefined, null, false, 0, [], {}, '1.1.', '[1.1.]', '{"x":1.1.}', '"\ud800"', '"\\ud800"']) add('native', 'job', { ...job, input: { ...job.input, optionsJson: bad } });
  let random = 0x030c10c;
  for (let n = 0; n < 128; n++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const start = String(9007199254740993123456n + BigInt(random));
    const end = String(BigInt(start) + BigInt(n + 1));
    clocks('generated', `${1 + random % 10000}e${n % 7}`, start, [{ op: 'advance', nowMs: end }, { op: 'wake', maxSliceMs: 1 + random % 2147483647 }]);
  }
  // Non-callable own method values retain their category and raw UTF-16 text.
  const methodValues: unknown[] = [null, false, true, 0, 1, -1, 1.5, '', 's', 'x', '\n\r\t\u0000\u0001\u001b\u007f"\\', '\ud800', '\udc00', '𝄞\u2028\u2029', [], [null], {}, { toString: 0 }, { constructor: { name: 'Different' } }];
  const methodInput = (target: string, value: unknown) => ({ serverId: 's', callsObservable: target === 'callsInProgress', works: target === 'filter' ? { filter: value } : [{ workId: 'w', [target]: { includes: value } }] });
  for (const target of ['filter', 'servers', 'callsInProgress']) {
    for (const value of methodValues) add('association-method', 'associate', methodInput(target, value));
    for (const token of ['-0', '1e400', '-1e400', '1e21', '1e-7', '1e-400', '9007199254740993']) add('association-method', 'associate', methodInput(target, '$nativeMethod'), ['$nativeMethod', token]);
    add('association-method', 'associate', { serverId: { toString: 0 }, callsObservable: target === 'callsInProgress', works: target === 'filter' ? {} : [{ workId: 'w', [target]: {} }] });
  }
  for (const text of ['a'.repeat(250), 'x'.repeat(1000), 'quote"line\nend', '\u2028\u2029\ufeff']) add('association-method', 'associate', methodInput('servers', text));
  for (const input of [
    { serverId: 's', callsObservable: false, works: [] },
    { serverId: 's', callsObservable: false, works: [{ workId: 'w', servers: ['s'] }, { workId: 'w', servers: ['s'] }] },
    { serverId: 's', callsObservable: false, works: [{ workId: 'w', servers: 'server' }] },
    { serverId: 's', callsObservable: true, works: [{ workId: 'w', callsInProgress: ['s'], servers: { includes: null } }] },
    { serverId: 's', callsObservable: false, works: [{ workId: 'w', callsInProgress: { includes: null }, servers: ['s'] }] },
  ]) add('association-method', 'associate', input);
  return { seed: CLOCK_SEED030, minimums: CLOCK_MINIMUMS030, cases };
}
