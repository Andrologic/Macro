import { expect, it } from 'bun:test';
import type { PublicExecutionIntent, PublicRunSummary030, RuntimeProjectionPage030 } from '../../types/generated/ipc';
import { sourceDigest } from '../agsdlExecution/compiler';
import { createRunInspectionAccess030 } from './runAccess030';
import type { RunReadTransport030 } from './runAccess030';
import { inspectionFixture030 } from './runInspection030.testSupport';
import { initialRunSelection030, retainedRunValue030 } from './runtimeProjection030';

async function fixture(id = 'run') {
  const inspection = inspectionFixture030(id);
  const capture = { ...structuredClone(inspection.capture) };
  capture.source.sourceSha256 = await sourceDigest(capture.authoredSource);
  const scope = { ...inspection.state.scope, source: capture.source };
  const summary: PublicRunSummary030 = { ...scope, flowInvocationId: 'flow', versions: capture.versions,
    revision: '9007199254740993', stopping: true, verdict: 'succeeded', ownerStatus: 'live', phaseCounts: [], physicalPending: '1' };
  const runtime: RuntimeProjectionPage030 = { scope, flowInvocationId: 'flow', revision: summary.revision,
    stopping: summary.stopping, verdict: summary.verdict, total: '2',
    items: inspection.state.occurrences.kind === 'ready' ? inspection.state.occurrences.value.map(item => ({ kind: 'activation', value: item.activation })) : [], nextPage: null };
  return { capture, scope, summary, runtime };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function transportFor(...fixtures: Fixture[]) {
  const calls: string[] = [];
  const transport: RunReadTransport030 = {
    async listExecutionRuns030() { calls.push('list'); return { runs: fixtures.map(item => item.summary), nextCursor: null }; },
    async readExecutionSnapshot030(id) { calls.push('snapshot'); return fixtures.find(item => item.capture.systemStartId === id)!.capture; },
    async readExecutionRuntimeProjection030(scope) { calls.push('runtime'); return fixtures.find(item => item.scope.systemStartId === scope.systemStartId)!.runtime; },
    async readExecutionHumans030(scope) { calls.push('humans'); return { scope, cursor: 'native-human-cursor', total: '0', requests: [], nextPage: null }; },
    async readExecutionIntentsVersioned() { calls.push('intents'); return []; },
  };
  const scope = { owner: structuredClone(fixtures[0].capture.source.owner), conversationId: 'sample-chat' };
  return { transport, calls, scope };
}

it('maps only attested facts, keeps exact revisions and exposes missing facts with gaps', async () => {
  const f = await fixture(), { transport, calls, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  const initial = access.getSnapshot();
  expect(access.getSnapshot()).toBe(initial);
  await access.refreshRun('run');
  const read = access.getSnapshot().runs.run;
  expect(read.kind).toBe('ready');
  const inspection = retainedRunValue030(read)!;
  expect(inspection.state).toMatchObject({ revision: f.summary.revision, verdict: 'succeeded', ownerStatus: 'live',
    stopping: true, physicalPending: '1', stop: { kind: 'unavailable', gap: 'stop-proof' },
    uncertainties: { kind: 'unavailable', gap: 'uncertainty' }, humans: { kind: 'unavailable', gap: 'human-flow-projection' },
    diagnostics: { kind: 'unavailable', gap: 'diagnostics' }, chronology: { kind: 'unavailable', gap: 'chronology' } });
  expect(retainedRunValue030(inspection.state.occurrences)?.[0].details).toEqual({ kind: 'unavailable', gap: 'occurrence-details' });
  expect(inspection.capture.authoredSource).toBe(f.capture.authoredSource);
  expect(Object.isFrozen(inspection.state.scope.source.owner)).toBe(true);
  expect(calls).toEqual(['list', 'snapshot', 'runtime', 'humans']);
});

it('reads all discovery pages before publishing history and never assumes no human waits', async () => {
  const a = await fixture('a'), b = await fixture('b'), { transport, scope } = transportFor(a, b);
  const afters: (string | null)[] = [];
  transport.listExecutionRuns030 = async request => {
    afters.push(request.after);
    return request.after ? { runs: [b.summary], nextCursor: null } : { runs: [a.summary], nextCursor: 'opaque-next' };
  };
  const access = createRunInspectionAccess030(scope, transport);
  const publications: number[] = [];
  const unsubscribe = access.subscribe(() => {
    const read = access.getSnapshot().history;
    if (read.kind === 'ready') publications.push(read.value.length);
  });
  await access.refreshHistory();
  expect(afters).toEqual([null, 'opaque-next']);
  expect(publications).toEqual([2]);
  expect(retainedRunValue030(access.getSnapshot().history)?.map(item => item.scope.systemStartId)).toEqual(['a', 'b']);
  expect(initialRunSelection030(access.getSnapshot())).toBeUndefined();
  expect(initialRunSelection030(access.getSnapshot(), 'b')).toBe('b');
  unsubscribe();
  await access.refreshHistory();
  expect(publications).toEqual([2]);
});

it('publishes runtime only after a full native revision and retains it after a page conflict', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const instances = Array.from({ length: 100 }, (_, i) => ({ kind: 'instance' as const, value: {
    id: `instance-${String(i).padStart(3, '0')}`, agent: 'worker', selectorKind: 'shared', selectorName: null,
    currentActivationId: null, queueActivationIds: [], discarded: false,
  } }));
  let conflict = false;
  const continuations: unknown[] = [];
  transport.readExecutionRuntimeProjection030 = async (_query, continuation) => {
    continuations.push(continuation);
    if (continuation) {
      if (conflict) throw { code: 'CONFLICT', message: 'Native revision changed' };
      return { ...f.runtime, total: '102' };
    }
    return { ...f.runtime, total: '102', items: instances,
      nextPage: { scope: f.scope, revision: f.summary.revision, offset: 100 } };
  };
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshRun('run');
  const old = retainedRunValue030(access.getSnapshot().runs.run)!;
  expect(old.state.instances.length).toBe(100);
  expect(continuations).toEqual([undefined, { scope: f.scope, revision: f.summary.revision, offset: 100 }]);
  conflict = true;
  await access.refreshRun('run');
  expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'stale', revision: f.summary.revision,
    retained: old, refusal: { code: 'CONFLICT' } });
});

it('rejects discovery/runtime revision mismatch and regressions without replacing retained facts', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshRun('run');
  const old = retainedRunValue030(access.getSnapshot().runs.run);
  f.runtime.revision = '9007199254740994';
  await access.refreshRun('run');
  expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'stale', retained: old, refusal: { code: 'REVISION_CONFLICT' } });
  f.summary.revision = '1';
  f.runtime.revision = '1';
  await access.refreshRun('run');
  expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'stale', retained: old, refusal: { code: 'REVISION_CONFLICT' } });
});

it('keeps history stale on repeated cursors, duplicate runs and foreign owner pages', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshHistory();
  const old = retainedRunValue030(access.getSnapshot().history);
  const invalidPages = [
    { runs: [f.summary, f.summary], nextCursor: null },
    { runs: [{ ...f.summary, source: { ...f.summary.source, owner: { ...scope.owner, branch: 'foreign' } } }], nextCursor: null },
    { runs: [f.summary], nextCursor: 'repeated' },
  ];
  for (const page of invalidPages) {
    transport.listExecutionRuns030 = async () => page;
    await access.refreshHistory();
    expect(access.getSnapshot().history).toMatchObject({ kind: 'stale', retained: old });
  }
});

it('isolates project, plan, branch and conversation, including missing associations', async () => {
  const f = await fixture(), foreign = await fixture('foreign'), missing = await fixture('missing');
  foreign.capture.associations = { conversationId: 'other' };
  missing.capture.associations = {};
  const { transport, scope, calls } = transportFor(f, foreign, missing);
  const access = createRunInspectionAccess030(scope, transport);
  const originalKey = access.scopeKey;
  scope.owner.branch = 'mutated'; scope.conversationId = 'mutated';
  await access.refreshHistory();
  expect(retainedRunValue030(access.getSnapshot().history)?.map(item => item.scope.systemStartId)).toEqual(['run']);
  expect(access.scopeKey).toBe(originalKey);
  const before = calls.filter(call => call === 'runtime').length;
  await access.refreshRun('foreign');
  await access.refreshRun('missing');
  expect(calls.filter(call => call === 'runtime').length).toBe(before);
  expect(access.getSnapshot().runs.foreign.kind).toBe('unavailable');
  for (const key of ['projectId', 'planId', 'branch'] as const) {
    const otherScope = { owner: { ...f.capture.source.owner, [key]: 'other' }, conversationId: 'sample-chat' };
    const other = createRunInspectionAccess030(otherScope, transport);
    await other.refreshHistory();
    expect(other.getSnapshot().history.kind).toBe('unavailable');
    expect(other.scopeKey).not.toBe(originalKey);
  }
});

it('invalidates retained projections when history advances and preserves stale history on read failure', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshHistory();
  await access.refreshRun('run');
  f.summary.revision = '9007199254740994';
  await access.refreshHistory();
  expect(access.getSnapshot().runs.run.kind).toBe('stale');
  transport.readExecutionHumans030 = async () => { throw { code: 'CONFLICT', message: 'Human cursor changed' }; };
  await access.refreshHistory();
  expect(access.getSnapshot().history).toMatchObject({ kind: 'stale', refusal: { code: 'CONFLICT' } });
});

it('accepts only a source-, version-, scope- and flow-bound start030 admission', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const intent: PublicExecutionIntent = { formatVersion: '1', key: { scope, intentId: 'intent' }, revision: '3',
    payload: { kind: 'start', request: { source: f.capture.source, profile: 'macro-agsdl-030-v1', requestId: 'request', associations: {}, entry: null } },
    state: { kind: 'admitted', admission: { kind: 'start030', receipt: { systemStartId: 'run', flowInvocationId: 'flow',
      source: f.capture.source, versions: f.capture.versions, entryDeliveryId: null } } } };
  transport.readExecutionIntentsVersioned = async () => [intent];
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshHistory();
  expect(access.getSnapshot().retainedAdmission).toEqual({ kind: 'available', value: 'run' });
  intent.key.scope = { ...scope, conversationId: 'foreign' };
  await access.refreshHistory();
  expect(access.getSnapshot().retainedAdmission.kind).toBe('unavailable');
  expect(access.getSnapshot().history).toMatchObject({ kind: 'stale', refusal: { code: 'SCOPE_INVALID' } });
});

it('rejects altered source bytes, captures, verdicts and physical counts', async () => {
  const mutations: ((f: Fixture) => void)[] = [
    f => { f.capture.authoredSource += ' '; },
    f => { f.runtime.scope = { ...f.scope, snapshotId: 'foreign' }; },
    f => { f.summary.verdict = 'completed'; },
    f => { f.summary.physicalPending = '0'; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(), { transport, scope } = transportFor(f);
    mutate(f);
    const access = createRunInspectionAccess030(scope, transport);
    await access.refreshRun('run');
    expect(access.getSnapshot().runs.run.kind).toBe('unavailable');
  }
});

it('keeps a true-flow run readable when only the legacy human row is absent', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  transport.readExecutionHumans030 = async () => { throw { code: 'NOT_FOUND', message: 'No legacy Stored row' }; };
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshHistory();
  await access.refreshRun('run');
  expect(access.getSnapshot().history.kind).toBe('ready');
  expect(access.getSnapshot().runs.run.kind).toBe('ready');
  expect(retainedRunValue030(access.getSnapshot().runs.run)?.state.humans).toEqual({ kind: 'unavailable', gap: 'human-flow-projection' });
});

it('serializes overlapping refreshes and never publishes an older read after the newer one', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let lists = 0;
  transport.listExecutionRuns030 = async () => {
    const number = ++lists;
    if (number === 1) await blocked;
    return { runs: [{ ...f.summary, revision: number.toString() }], nextCursor: null };
  };
  transport.readExecutionRuntimeProjection030 = async () => ({ ...f.runtime, revision: lists.toString() });
  const access = createRunInspectionAccess030(scope, transport);
  const first = access.refreshRun('run');
  const second = access.refreshRun('run');
  await Promise.resolve();
  expect(lists).toBe(1);
  expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'loading', retained: null });
  release();
  await Promise.all([first, second]);
  expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'ready', revision: '2' });
});

it('rejects a history revision regression and marks owner revocation stale even without a flow revision change', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshHistory();
  f.summary.revision = '1';
  await access.refreshHistory();
  expect(access.getSnapshot().history).toMatchObject({ kind: 'stale', refusal: { code: 'REVISION_CONFLICT' } });
  f.summary.revision = f.runtime.revision;
  await access.refreshRun('run');
  f.summary.ownerStatus = 'revoked';
  await access.refreshHistory();
  expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'stale' });
  await access.refreshRun('run');
  expect(retainedRunValue030(access.getSnapshot().runs.run)?.state.ownerStatus).toBe('revoked');
});
