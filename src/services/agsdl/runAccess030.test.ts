import { expect, it } from 'bun:test';
import type { ExecutionRunCorrelation030, PublicExecutionIntent, PublicRunSummary030, RuntimeProjectionPage030 } from '../../types/generated/ipc';
import { sourceDigest } from '../agsdlExecution/compiler';
import { createRunInspectionAccess030 } from './runAccess030';
import type { RunReadTransport030 } from './runAccess030';
import { inspectionFixture030 } from './runInspection030.testSupport';
import { initialRunSelection030, retainedRunValue030 } from './runtimeProjection030';

async function fixture(id = 'run') {
  const inspection = inspectionFixture030(id);
  const capture = { ...structuredClone(inspection.capture), associations: {} };
  capture.source.sourceSha256 = await sourceDigest(capture.authoredSource);
  const scope = { ...inspection.state.scope, source: capture.source };
  const summary: PublicRunSummary030 = { ...scope, flowInvocationId: 'flow', versions: capture.versions,
    revision: '9007199254740993', stopping: true, verdict: 'succeeded', ownerStatus: 'live',
    phaseCounts: [{ phase: 'done', count: '1' }, { phase: 'running', count: '1' }], physicalPending: '1' };
  const runtime: RuntimeProjectionPage030 = { scope, flowInvocationId: 'flow', revision: summary.revision,
    stopping: summary.stopping, verdict: summary.verdict, total: '2',
    items: inspection.state.occurrences.kind === 'ready' ? inspection.state.occurrences.value.map(item => ({ kind: 'activation',
      value: { ...item.activation, phase: item.activation.phase === 'completed' ? 'done' : item.activation.phase } })) : [], nextPage: null };
  return { capture, scope, summary, runtime };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function intentFor(f: Fixture, scope = { owner: f.capture.source.owner, conversationId: 'sample-chat' }): PublicExecutionIntent {
  const id = f.summary.systemStartId;
  const entry = { deliveryId: `entry-${id}`, messageJson: '{"text":"Start the synthetic sample"}' };
  return { formatVersion: '1', key: { scope: structuredClone(scope), intentId: `intent-${f.summary.systemStartId}` }, revision: '3',
    payload: { kind: 'start', request: { source: f.capture.source, profile: 'macro-agsdl-030-v1', requestId: `request-${id}`, associations: {}, entry } },
    state: { kind: 'admitted', admission: { kind: 'start030', receipt: { systemStartId: f.summary.systemStartId, flowInvocationId: f.summary.flowInvocationId,
      source: f.capture.source, versions: f.capture.versions, entryDeliveryId: entry.deliveryId } } } };
}
function transportFor(...fixtures: Fixture[]) {
  const calls: string[] = [];
  const nativeScope = { owner: structuredClone(fixtures[0].capture.source.owner), conversationId: 'sample-chat' };
  const retainedIntents = new Map(fixtures.map((f, index) => {
    const intent = intentFor(f, nativeScope);
    if (index > 0 && intent.state.kind === 'admitted')
      intent.state = { kind: 'closed', disposition: 'acknowledged', admission: intent.state.admission };
    return [f.summary.systemStartId, intent] as const;
  }));
  const sameScope = (scope: typeof nativeScope, other: typeof nativeScope) =>
    scope.conversationId === other.conversationId && scope.owner.projectId === other.owner.projectId &&
    scope.owner.planId === other.owner.planId && scope.owner.branch === other.owner.branch;
  const transport: RunReadTransport030 = {
    async listExecutionRuns030() { calls.push('list'); return { runs: fixtures.map(item => item.summary), nextCursor: null }; },
    async readExecutionSnapshot030(id) { calls.push('snapshot'); return fixtures.find(item => item.capture.systemStartId === id)!.capture; },
    async readExecutionRuntimeProjection030(scope) { calls.push('runtime'); return fixtures.find(item => item.scope.systemStartId === scope.systemStartId)!.runtime; },
    async readExecutionHumans030(scope) { calls.push('humans'); return { scope, cursor: 'native-human-cursor', total: '0', requests: [], nextPage: null }; },
    async readExecutionIntentsVersioned({ scope }) {
      calls.push('intents');
      return structuredClone([...retainedIntents.values()].filter(intent => intent.state.kind !== 'closed' && sameScope(intent.key.scope, scope)));
    },
    async readExecutionRunCorrelation030(scope, id) {
      calls.push(`correlation:${id}`);
      const intent = retainedIntents.get(id);
      if (!fixtures.some(f => f.summary.systemStartId === id)) throw { code: 'NOT_FOUND', currentIntentKey: null };
      if (!intent || !sameScope(intent.key.scope, scope)) throw { code: 'SCOPE_INVALID', currentIntentKey: null };
      const state = intent.state;
      const admission = state.kind === 'admitted' || (state.kind === 'closed' && state.disposition === 'acknowledged') ? state.admission : null;
      if (admission?.kind !== 'start030') throw { code: 'STORAGE_UNCERTAIN', currentIntentKey: null };
      return structuredClone({ key: intent.key, receipt: admission.receipt });
    },
  };
  return { transport, calls, scope: structuredClone(nativeScope), retainedIntents };
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
  expect(calls).toEqual(['list', 'intents', 'correlation:run', 'snapshot', 'runtime', 'humans']);
});

it('reads all discovery pages before publishing history and never assumes no human waits', async () => {
  const a = await fixture('a'), b = await fixture('b'), { transport, scope, calls } = transportFor(a, b);
  const access = createRunInspectionAccess030(scope, transport);
  const afters: (string | null)[] = [];
  transport.listExecutionRuns030 = async request => {
    afters.push(request.after);
    return request.after ? { runs: [b.summary], nextCursor: null } : { runs: [a.summary], nextCursor: 'opaque-next' };
  };
  const publications: number[] = [];
  const unsubscribe = access.subscribe(() => {
    const read = access.getSnapshot().history;
    if (read.kind === 'ready') publications.push(read.value.length);
  });
  await access.refreshHistory();
  expect(afters).toEqual([null, 'opaque-next']);
  expect(publications).toEqual([2]);
  expect(calls.filter(call => call.startsWith('correlation:'))).toEqual(['correlation:a', 'correlation:b']);
  expect(retainedRunValue030(access.getSnapshot().history)?.map(item => item.scope.systemStartId)).toEqual(['a', 'b']);
  expect(initialRunSelection030(access.getSnapshot())).toBeUndefined();
  expect(initialRunSelection030(access.getSnapshot(), 'b')).toBe('b');
  unsubscribe();
  await access.refreshHistory();
  expect(publications).toEqual([2]);
});

it('reads an acknowledged closed intent after restart without any in-memory attestation', async () => {
  const f = await fixture(), { transport, scope, retainedIntents, calls } = transportFor(f);
  const beforeRestart = createRunInspectionAccess030(scope, transport);
  await beforeRestart.refreshHistory();
  expect(beforeRestart.getSnapshot().retainedAdmission).toEqual({ kind: 'available', value: 'run' });
  const intent = retainedIntents.get('run')!;
  if (intent.state.kind !== 'admitted') throw new Error('Expected an open admitted intent');
  intent.state = { kind: 'closed', disposition: 'acknowledged', admission: intent.state.admission };
  // The database retains the attachment; the restarted adapter owns no cache.
  const retainedRow = structuredClone(intent);
  const afterRestart = createRunInspectionAccess030(scope, transport);
  expect(afterRestart.getSnapshot().runs).toEqual({});
  expect(await transport.readExecutionIntentsVersioned({ scope })).toEqual([]);
  await afterRestart.refreshHistory();
  expect(afterRestart.getSnapshot().history.kind).toBe('ready');
  expect(retainedRunValue030(afterRestart.getSnapshot().history)?.map(item => item.scope.systemStartId)).toEqual(['run']);
  expect(afterRestart.getSnapshot().retainedAdmission).toEqual({ kind: 'available', value: null });
  await afterRestart.refreshRun('run');
  expect(afterRestart.getSnapshot().runs.run.kind).toBe('ready');
  expect(calls.filter(call => call === 'correlation:run')).toHaveLength(3);
  expect(retainedIntents.get('run')).toEqual(retainedRow);
});

it('excludes a run from another conversation with SCOPE_INVALID and performs no capture or runtime read', async () => {
  const f = await fixture(), { transport, scope, calls } = transportFor(f);
  const foreignScope = { ...scope, conversationId: 'another-conversation' };
  const access = createRunInspectionAccess030(foreignScope, transport);
  await access.refreshHistory();
  expect(access.getSnapshot().history).toMatchObject({ kind: 'ready', value: [] });
  expect(access.getSnapshot().excludedRuns.run.code).toBe('SCOPE_INVALID');
  expect(access.getSnapshot().retainedAdmission).toEqual({ kind: 'available', value: null });
  await expect(access.refreshRun('run')).rejects.toMatchObject({ kind: 'scope', code: 'SCOPE_INVALID' });
  expect(calls).not.toContain('snapshot');
  expect(calls).not.toContain('runtime');
  expect(calls).not.toContain('humans');
});

it('propagates NOT_FOUND and STORAGE_UNCERTAIN correlation failures without silently excluding or trusting cached runs', async () => {
  for (const [code, kind] of [['NOT_FOUND', 'notFound'], ['STORAGE_UNCERTAIN', 'uncertain']] as const) {
    const f = await fixture(), { transport, scope } = transportFor(f);
    const readCorrelation = transport.readExecutionRunCorrelation030;
    transport.readExecutionRunCorrelation030 = async () => { throw { code, currentIntentKey: null }; };
    const access = createRunInspectionAccess030(scope, transport);
    await expect(access.refreshHistory()).rejects.toMatchObject({ code, kind });
    expect(access.getSnapshot().history.kind).not.toBe('ready');
    expect(access.getSnapshot().excludedRuns).toEqual({});
    await expect(access.refreshRun('run')).rejects.toMatchObject({ code, kind });
    expect(access.getSnapshot().runs.run.kind).not.toBe('ready');
    transport.readExecutionRunCorrelation030 = readCorrelation;
    await access.refreshHistory();
    await access.refreshRun('run');
    const oldHistory = retainedRunValue030(access.getSnapshot().history);
    const oldRun = retainedRunValue030(access.getSnapshot().runs.run);
    transport.readExecutionRunCorrelation030 = async () => { throw { code, currentIntentKey: null }; };
    await expect(access.refreshHistory()).rejects.toMatchObject({ code, kind });
    expect(access.getSnapshot().history).toMatchObject({ kind: 'stale', retained: oldHistory });
    await expect(access.refreshRun('run')).rejects.toMatchObject({ code, kind });
    expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'stale', retained: oldRun });
    expect(access.getSnapshot().excludedRuns).toEqual({});
  }
});

it('refuses foreign correlation keys or receipts even when the open intent remains valid', async () => {
  const mutations: ((correlation: ExecutionRunCorrelation030) => void)[] = [
    value => { value.key.scope.conversationId = 'foreign'; },
    value => { value.key.scope.owner.branch = 'foreign'; },
    value => { value.receipt.systemStartId = 'foreign'; },
    value => { value.receipt.flowInvocationId = 'foreign'; },
    value => { value.receipt.source.revision = '999'; },
    value => { value.receipt.versions.runtime = 'foreign'; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(), { transport, scope } = transportFor(f);
    const correlation = await transport.readExecutionRunCorrelation030(scope, 'run');
    mutate(correlation);
    transport.readExecutionRunCorrelation030 = async () => correlation;
    const access = createRunInspectionAccess030(scope, transport);
    await expect(access.refreshHistory()).rejects.toMatchObject({ kind: 'scope', code: 'CORRELATION' });
    expect(access.getSnapshot().history.kind).not.toBe('ready');
    await expect(access.refreshRun('run')).rejects.toMatchObject({ kind: 'scope', code: 'CORRELATION' });
    expect(access.getSnapshot().runs.run.kind).not.toBe('ready');
  }
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
  await expect(access.refreshRun('run')).rejects.toMatchObject({ kind: 'conflict', code: 'CONFLICT' });
  expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'stale', revision: f.summary.revision,
    retained: old, refusal: { code: 'CONFLICT' } });
});

it('rejects discovery/runtime revision mismatch and regressions without replacing retained facts', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshRun('run');
  const old = retainedRunValue030(access.getSnapshot().runs.run);
  f.runtime.revision = '9007199254740994';
  await expect(access.refreshRun('run')).rejects.toMatchObject({ kind: 'conflict', code: 'REVISION_CONFLICT' });
  expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'stale', retained: old, refusal: { code: 'REVISION_CONFLICT' } });
  f.summary.revision = '1';
  f.runtime.revision = '1';
  await expect(access.refreshRun('run')).rejects.toMatchObject({ kind: 'conflict', code: 'REVISION_CONFLICT' });
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
    await expect(access.refreshHistory()).rejects.toBeDefined();
    expect(access.getSnapshot().history).toMatchObject({ kind: 'stale', retained: old });
  }
});

it('isolates project, plan, branch and conversation using native intent receipts', async () => {
  const f = await fixture(), foreign = await fixture('foreign'), missing = await fixture('missing');
  const { transport, scope, calls, retainedIntents } = transportFor(f, foreign, missing);
  retainedIntents.get('foreign')!.key.scope.conversationId = 'other-chat';
  retainedIntents.delete('missing');
  const access = createRunInspectionAccess030(scope, transport);
  const originalKey = access.scopeKey;
  scope.owner.branch = 'mutated'; scope.conversationId = 'mutated';
  await access.refreshHistory();
  expect(retainedRunValue030(access.getSnapshot().history)?.map(item => item.scope.systemStartId)).toEqual(['run']);
  expect(access.scopeKey).toBe(originalKey);
  const before = calls.filter(call => call === 'runtime').length;
  await expect(access.refreshRun('foreign')).rejects.toMatchObject({ kind: 'scope', code: 'SCOPE_INVALID' });
  await expect(access.refreshRun('missing')).rejects.toMatchObject({ kind: 'scope', code: 'SCOPE_INVALID' });
  expect(calls.filter(call => call === 'runtime').length).toBe(before);
  expect(access.getSnapshot().excludedRuns.foreign.code).toBe('SCOPE_INVALID');
  for (const key of ['projectId', 'planId', 'branch'] as const) {
    const otherScope = { owner: { ...f.capture.source.owner, [key]: 'other' }, conversationId: 'sample-chat' };
    const other = createRunInspectionAccess030(otherScope, transport);
    await expect(other.refreshHistory()).rejects.toMatchObject({ kind: 'scope', code: 'SCOPE_INVALID' });
    expect(other.getSnapshot().history).not.toMatchObject({ kind: 'unavailable', gap: 'qualification' });
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
  await expect(access.refreshHistory()).rejects.toMatchObject({ kind: 'conflict', code: 'CONFLICT' });
  expect(access.getSnapshot().history).toMatchObject({ kind: 'stale', refusal: { code: 'CONFLICT' } });
});

it('accepts only a source-, version-, scope- and flow-bound start030 admission', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const intent = intentFor(f, scope);
  transport.readExecutionIntentsVersioned = async () => [intent];
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshHistory();
  expect(access.getSnapshot().retainedAdmission).toEqual({ kind: 'available', value: 'run' });
  intent.key.scope = { ...scope, conversationId: 'foreign' };
  await expect(access.refreshHistory()).rejects.toMatchObject({ kind: 'scope', code: 'SCOPE_INVALID' });
  expect(access.getSnapshot().retainedAdmission.kind).toBe('unavailable');
  expect(access.getSnapshot().history.kind).toBe('ready');
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
    await expect(access.refreshRun('run')).rejects.toBeDefined();
    expect(access.getSnapshot().runs.run).not.toMatchObject({ kind: 'unavailable', gap: 'qualification' });
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
  await expect(access.refreshHistory()).rejects.toMatchObject({ kind: 'conflict', code: 'REVISION_CONFLICT' });
  expect(access.getSnapshot().history).toMatchObject({ kind: 'stale', refusal: { code: 'REVISION_CONFLICT' } });
  f.summary.revision = f.runtime.revision;
  await access.refreshRun('run');
  f.summary.ownerStatus = 'revoked';
  await access.refreshHistory();
  expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'stale' });
  await access.refreshRun('run');
  expect(retainedRunValue030(access.getSnapshot().runs.run)?.state.ownerStatus).toBe('revoked');
});

it('admits native captures only through a durable correlation and excludes unattached runs', async () => {
  const native = await fixture(), uncorrelated = await fixture('uncorrelated');
  // Even a synthetic conversation association cannot replace a native receipt.
  uncorrelated.capture.associations = { conversationId: 'sample-chat' };
  const { transport, scope, retainedIntents } = transportFor(native, uncorrelated);
  retainedIntents.delete('uncorrelated');
  const access = createRunInspectionAccess030(scope, transport);
  expect(native.capture.associations).toEqual({});
  await access.refreshHistory();
  expect(retainedRunValue030(access.getSnapshot().history)?.map(item => item.scope.systemStartId)).toEqual(['run']);
  expect(access.getSnapshot().retainedAdmission).toEqual({ kind: 'available', value: 'run' });
  expect(access.getSnapshot().excludedRuns.uncorrelated.code).toBe('SCOPE_INVALID');
  await access.refreshRun('run');
  expect(access.getSnapshot().runs.run.kind).toBe('ready');
  await expect(access.refreshRun('uncorrelated')).rejects.toMatchObject({ kind: 'scope', code: 'SCOPE_INVALID' });
  // The open slot may disappear without losing the durable attachment.
  transport.readExecutionIntentsVersioned = async () => [];
  await access.refreshHistory();
  expect(retainedRunValue030(access.getSnapshot().history)).toHaveLength(1);
  await access.refreshRun('run');
  expect(access.getSnapshot().runs.run.kind).toBe('ready');
});

it('rejects invalid open admissions without discarding independently correlated runs', async () => {
  const mutations: ((intent: PublicExecutionIntent) => void)[] = [
    intent => { intent.key.scope.conversationId = 'other-chat'; },
    intent => { intent.key.scope.owner.branch = 'other-branch'; },
    intent => { if (intent.state.kind === 'admitted' && intent.state.admission.kind === 'start030') intent.state.admission.receipt.flowInvocationId = 'foreign'; },
    intent => { if (intent.state.kind === 'admitted' && intent.state.admission.kind === 'start030') intent.state.admission.receipt.source = { ...intent.state.admission.receipt.source, revision: '999' }; },
    intent => { if (intent.state.kind === 'admitted' && intent.state.admission.kind === 'start030') intent.state.admission.receipt.versions = { ...intent.state.admission.receipt.versions, runtime: 'foreign' }; },
    intent => { if (intent.state.kind === 'admitted' && intent.state.admission.kind === 'start030') intent.state.admission.receipt.entryDeliveryId = 'foreign'; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(), { transport, scope } = transportFor(f);
    const intent = intentFor(f, scope);
    mutate(intent);
    transport.readExecutionIntentsVersioned = async () => [intent];
    const access = createRunInspectionAccess030(scope, transport);
    await expect(access.refreshHistory()).rejects.toMatchObject({ kind: 'scope' });
    expect(access.getSnapshot().history.kind).toBe('ready');
    expect(retainedRunValue030(access.getSnapshot().history)).toHaveLength(1);
    expect(access.getSnapshot().excludedRuns).toEqual({});
    await expect(access.refreshRun('run')).rejects.toMatchObject({ kind: 'scope' });
    expect(access.getSnapshot().runs.run.kind).toBe('ready');
  }
});

it('keeps fully read history ready on STORAGE_UNCERTAIN and permits manual inspection of an attested run', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshHistory();
  const history = retainedRunValue030(access.getSnapshot().history);
  transport.readExecutionIntentsVersioned = async () => { throw { code: 'STORAGE_UNCERTAIN', currentIntentKey: null }; };
  await expect(access.refreshHistory()).rejects.toMatchObject({ kind: 'uncertain', code: 'STORAGE_UNCERTAIN' });
  expect(access.getSnapshot().history).toMatchObject({ kind: 'ready', value: history });
  expect(access.getSnapshot().retainedAdmission.kind).toBe('unavailable');
  expect(initialRunSelection030(access.getSnapshot())).toBeUndefined();
  expect(initialRunSelection030(access.getSnapshot(), 'run')).toBe('run');
  await expect(access.refreshRun('run')).rejects.toMatchObject({ kind: 'uncertain', code: 'STORAGE_UNCERTAIN' });
  expect(access.getSnapshot().runs.run.kind).toBe('ready');
});

it('invalidates retained admission and reports intent failure during run-only refresh without losing inspection', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshRun('run');
  expect(access.getSnapshot().retainedAdmission).toEqual({ kind: 'available', value: 'run' });
  const old = retainedRunValue030(access.getSnapshot().runs.run);
  transport.readExecutionIntentsVersioned = async () => { throw { code: 'STORAGE_UNCERTAIN', currentIntentKey: null }; };
  await expect(access.refreshRun('run')).rejects.toMatchObject({ kind: 'uncertain', code: 'STORAGE_UNCERTAIN' });
  expect(access.getSnapshot().retainedAdmission.kind).toBe('unavailable');
  expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'ready', value: old });
  // No history refresh is needed to recover the independently read admission.
  transport.readExecutionIntentsVersioned = async () => [intentFor(f)];
  await access.refreshRun('run');
  expect(access.getSnapshot().retainedAdmission).toEqual({ kind: 'available', value: 'run' });
});

it('marks retained projections stale immediately after newer discovery even when capture read then fails', async () => {
  for (const refresh of ['history', 'run'] as const) {
    const f = await fixture(), { transport, scope } = transportFor(f);
    const access = createRunInspectionAccess030(scope, transport);
    await access.refreshRun('run');
    const retained = retainedRunValue030(access.getSnapshot().runs.run);
    f.summary.revision = '9007199254740994';
    transport.readExecutionSnapshot030 = async () => {
      // Invalidation precedes this awaited read, not merely its failure.
      expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'stale', revision: '9007199254740993', retained });
      throw { code: 'STORAGE', message: 'Capture unavailable' };
    };
    const reading = refresh === 'history' ? access.refreshHistory() : access.refreshRun('run');
    await expect(reading).rejects.toMatchObject({ kind: 'transport', code: 'STORAGE' });
    expect(access.getSnapshot().runs.run).toMatchObject({ kind: 'stale', revision: '9007199254740993', retained });
  }
});

it('uses native-compatible entries, phases, phase counts and distinct request ids for fixture admissions', async () => {
  const requests = new Set<string>();
  const phases = new Set(['ready', 'queued', 'running', 'body', 'group', 'done', 'preparing', 'barrier', 'stopping']);
  for (const id of ['first', 'second']) {
    const f = await fixture(id), intent = intentFor(f);
    if (intent.payload.kind !== 'start' || intent.state.kind !== 'admitted' || intent.state.admission.kind !== 'start030')
      throw new Error('Expected a start030 fixture admission');
    const request = intent.payload.request;
    const document = JSON.parse(f.capture.authoredSource);
    expect(request.entry !== null).toBe(document.flow?.entry !== undefined);
    expect(intent.state.admission.receipt.entryDeliveryId).toBe(request.entry?.deliveryId ?? null);
    expect(JSON.parse(request.entry!.messageJson)).toEqual({ text: 'Start the synthetic sample' });
    expect(requests.has(request.requestId)).toBe(false);
    requests.add(request.requestId);
    const counts = new Map<string, number>();
    for (const item of f.runtime.items) if (item.kind === 'activation') {
      expect(phases.has(item.value.phase)).toBe(true);
      counts.set(item.value.phase, (counts.get(item.value.phase) ?? 0) + 1);
    }
    expect(f.summary.phaseCounts).toEqual([...counts].sort(([a], [b]) => a.localeCompare(b)).map(([phase, count]) => ({ phase, count: String(count) })));
  }
});

it('reads a fresh history through durable correlations when the open intent store is unavailable', async () => {
  const f = await fixture(), { transport, scope, calls } = transportFor(f);
  transport.readExecutionIntentsVersioned = async () => { throw { code: 'STORAGE_UNCERTAIN', currentIntentKey: null }; };
  const access = createRunInspectionAccess030(scope, transport);
  await expect(access.refreshHistory()).rejects.toMatchObject({ kind: 'uncertain' });
  expect(access.getSnapshot().history.kind).toBe('ready');
  expect(retainedRunValue030(access.getSnapshot().history)).toHaveLength(1);
  expect(access.getSnapshot().excludedRuns).toEqual({});
  await expect(access.refreshRun('run')).rejects.toMatchObject({ kind: 'uncertain' });
  expect(access.getSnapshot().runs.run.kind).toBe('ready');
  expect(calls).toContain('runtime');
});

it('rejects first read failures with distinct conflict, scope, transport and uncertainty categories', async () => {
  for (const [code, kind] of [['CONFLICT', 'conflict'], ['SCOPE_INVALID', 'scope'],
    ['STORAGE', 'transport'], ['STORAGE_UNCERTAIN', 'uncertain']] as const) {
    const f = await fixture(), { transport, scope } = transportFor(f);
    transport.listExecutionRuns030 = async () => { throw { code, message: `Native ${code}` }; };
    const access = createRunInspectionAccess030(scope, transport);
    await expect(access.refreshHistory()).rejects.toMatchObject({ code, kind, message: `Native ${code}` });
    expect(access.getSnapshot().history).not.toMatchObject({ kind: 'unavailable', gap: 'qualification' });
    await expect(access.refreshRun('run')).rejects.toMatchObject({ code, kind });
    expect(access.getSnapshot().runs.run).not.toMatchObject({ kind: 'unavailable', gap: 'qualification' });
    // A rejected operation never poisons the refresh queue.
    transport.listExecutionRuns030 = async () => ({ runs: [f.summary], nextCursor: null });
    await access.refreshHistory();
    expect(access.getSnapshot().history.kind).toBe('ready');
  }
});
