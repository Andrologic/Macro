import { expect, it } from 'bun:test';
import type { ExecutionRunCorrelation030, PublicExecutionIntent, PublicRunSummary030 } from '../../types/generated/ipc';
import { createRunInspectionAccess030 } from './runAccess030';
import { initialRunSelection030, retainedRunValue030 } from './runtimeProjection030';
import { fixture, intentFor, transportFor, type Fixture } from './runAccess030.testSupport';

it('maps only attested facts, keeps exact revisions and exposes missing facts with gaps', async () => {
  const f = await fixture(), { transport, calls, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  const initial = access.getSnapshot();
  expect(access.getSnapshot()).toBe(initial);
  await access.refreshRun('run');
  const read = access.getSnapshot().runs.run;
  expect(read.kind).toBe('ready');
  const inspection = retainedRunValue030(read)!;
  expect(inspection.state).toMatchObject({ revision: f.summary.revision, verdict: null, ownerStatus: 'live',
    stopping: false, physicalPending: '1', stop: { kind: 'unavailable', gap: 'stop-proof' },
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
  expect(calls.filter(call => call === 'correlation:run')).toHaveLength(2);
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

it('publishes typed per-run correlation failures and retries them after a discovery change', async () => {
  for (const [code, kind] of [['NOT_FOUND', 'notFound'], ['STORAGE_UNCERTAIN', 'uncertain']] as const) {
    const f = await fixture(), { transport, scope } = transportFor(f);
    const readCorrelation = transport.readExecutionRunCorrelation030;
    transport.readExecutionRunCorrelation030 = async () => { throw { code, currentIntentKey: null }; };
    const access = createRunInspectionAccess030(scope, transport);
    await access.refreshHistory();
    expect(access.getSnapshot().history).toMatchObject({ kind: 'ready', value: [] });
    expect(access.getSnapshot().runFailures.run).toMatchObject({ code, kind });
    expect(access.getSnapshot().excludedRuns).toEqual({});
    await expect(access.refreshRun('run')).rejects.toMatchObject({ code, kind });
    expect(access.getSnapshot().runs.run?.kind).not.toBe('loading');
    transport.readExecutionRunCorrelation030 = readCorrelation;
    await access.refreshHistory();
    await access.refreshRun('run');
    const oldRun = retainedRunValue030(access.getSnapshot().runs.run);
    f.summary.revision = '9007199254740994';
    transport.readExecutionRunCorrelation030 = async () => { throw { code, currentIntentKey: null }; };
    await access.refreshHistory();
    expect(access.getSnapshot().history).toMatchObject({ kind: 'ready', value: [] });
    expect(access.getSnapshot().runFailures.run).toMatchObject({ code, kind });
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
    await access.refreshHistory();
    expect(access.getSnapshot().history).toMatchObject({ kind: 'ready', value: [] });
    expect(access.getSnapshot().runFailures.run).toMatchObject({ kind: 'scope', code: 'CORRELATION' });
    await expect(access.refreshRun('run')).rejects.toMatchObject({ kind: 'scope', code: 'CORRELATION' });
    expect(access.getSnapshot().runs.run?.kind).not.toBe('ready');
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
    const otherScope = { owner: { ...f.capture.source.owner, [key]: 'other' }, conversationId: 'design-conversation' };
    const other = createRunInspectionAccess030(otherScope, transport);
    await expect(other.refreshHistory()).rejects.toMatchObject({ kind: 'scope', code: 'SCOPE_INVALID' });
    expect(other.getSnapshot().history).not.toMatchObject({ kind: 'unavailable', gap: 'qualification' });
    expect(other.scopeKey).not.toBe(originalKey);
  }
});

it('invalidates retained projections when history advances and isolates a human read failure', async () => {
  const f = await fixture(), { transport, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshHistory();
  await access.refreshRun('run');
  f.summary.revision = '9007199254740994';
  await access.refreshHistory();
  expect(access.getSnapshot().runs.run.kind).toBe('stale');
  transport.readExecutionHumans030 = async () => { throw { code: 'CONFLICT', message: 'Human cursor changed' }; };
  await access.refreshHistory();
  expect(access.getSnapshot().history.kind).toBe('ready');
  expect(access.getSnapshot().runFailures.run).toMatchObject({ kind: 'conflict', code: 'CONFLICT' });
  expect(access.getSnapshot().runs.run.kind).toBe('stale');
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
    expect(access.getSnapshot().runs.run).toBeUndefined();
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
  expect(access.getSnapshot().history.kind).toBe('ready');
  expect(access.getSnapshot().runFailures.run).toMatchObject({ kind: 'conflict', code: 'REVISION_CONFLICT' });
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
  uncorrelated.capture.associations = { conversationId: 'design-conversation' };
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
    if (refresh === 'run') await expect(reading).rejects.toMatchObject({ kind: 'transport', code: 'STORAGE' });
    else {
      await reading;
      expect(access.getSnapshot().history.kind).toBe('ready');
      expect(access.getSnapshot().runFailures.run).toMatchObject({ kind: 'transport', code: 'STORAGE' });
    }
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
    expect(access.getSnapshot().runs.run).toBeUndefined();
    // A rejected operation never poisons the refresh queue.
    transport.listExecutionRuns030 = async () => ({ runs: [f.summary], nextCursor: null });
    await access.refreshHistory();
    expect(access.getSnapshot().history.kind).toBe('ready');
  }
});

it('isolates the first or last failing correlation across three runs and inspects only the requested healthy run', async () => {
  for (const badId of ['first', 'last']) for (const [code, kind] of [['NOT_FOUND', 'notFound'], ['STORAGE_UNCERTAIN', 'uncertain']] as const) {
    const fixtures = await Promise.all(['first', 'middle', 'last'].map(id => fixture(id)));
    const { transport, scope } = transportFor(...fixtures);
    const nativeRead = transport.readExecutionRunCorrelation030, reads: string[] = [];
    let failing = true;
    transport.readExecutionRunCorrelation030 = async (query, id) => {
      reads.push(id);
      if (failing && id === badId) throw { code, currentIntentKey: null };
      return nativeRead(query, id);
    };
    const access = createRunInspectionAccess030(scope, transport);
    await access.refreshHistory();
    expect(reads).toEqual(['first', 'middle', 'last']);
    expect(access.getSnapshot().history.kind).toBe('ready');
    expect(retainedRunValue030(access.getSnapshot().history)?.map(item => item.scope.systemStartId))
      .toEqual(['first', 'middle', 'last'].filter(id => id !== badId));
    expect(access.getSnapshot().runFailures[badId]).toMatchObject({ code, kind, revision: '9007199254740993' });
    expect(access.getSnapshot().excludedRuns).toEqual({});
    await access.refreshRun('middle');
    expect(access.getSnapshot().runs.middle.kind).toBe('ready');
    expect(reads).toHaveLength(3);
    expect(access.getSnapshot().runFailures[badId].kind).toBe(kind);

    // A fresh adapter has no proof cache: direct inspection still reads only
    // middle, so an earlier/later failing run cannot block this operation.
    const direct = createRunInspectionAccess030(scope, transport);
    await direct.refreshRun('middle');
    expect(reads.slice(3)).toEqual(['middle']);
    expect(direct.getSnapshot().runs.middle.kind).toBe('ready');
    await access.refreshHistory();
    expect(reads.slice(4)).toEqual([badId]);
    await expect(access.refreshRun(badId)).rejects.toMatchObject({ code, kind });
    expect(access.getSnapshot().runs[badId]?.kind).not.toBe('loading');
    expect(access.getSnapshot().runFailures[badId].kind).toBe(kind);
    failing = false;
    await access.refreshHistory();
    expect(retainedRunValue030(access.getSnapshot().history)?.map(item => item.scope.systemStartId)).toEqual(['first', 'middle', 'last']);
    expect(access.getSnapshot().runFailures).toEqual({});
  }
});

it('reduces three-run history, selection and comparison cycles to three cold calls, zero warm calls and one changed call', async () => {
  const fixtures = await Promise.all(['first', 'middle', 'last'].map(id => fixture(id)));
  const { transport, scope, calls } = transportFor(...fixtures);
  const access = createRunInspectionAccess030(scope, transport);
  const count = () => calls.filter(call => call.startsWith('correlation:')).length;
  const cycle = async () => {
    const previous = count();
    await access.refreshHistory();
    await access.refreshRun('middle');
    await access.refreshRun('last');
    return count() - previous;
  };
  expect([await cycle(), await cycle(), await cycle()]).toEqual([3, 0, 0]);
  fixtures[1].summary.revision = '9007199254740994';
  fixtures[1].runtime.revision = fixtures[1].summary.revision;
  expect(await cycle()).toBe(1);
  expect(calls.filter(call => call.startsWith('correlation:'))).toEqual(['correlation:first', 'correlation:middle', 'correlation:last', 'correlation:middle']);
  expect(access.getSnapshot().runs.middle).toMatchObject({ kind: 'ready', revision: '9007199254740994' });

  // A different conversation cannot reuse proofs from the original scope.
  const other = createRunInspectionAccess030({ ...scope, conversationId: 'another-conversation' }, transport);
  const before = count();
  await other.refreshHistory();
  expect(count() - before).toBe(3);
  expect(other.getSnapshot().history).toMatchObject({ kind: 'ready', value: [] });
  expect(Object.keys(other.getSnapshot().excludedRuns)).toHaveLength(3);
  expect(await cycle()).toBe(0);
});

it('invalidates only the changed proof for source, capture, flow or version changes and never caches its transient error', async () => {
  const mutations: ((run: PublicRunSummary030) => void)[] = [
    run => { run.source.revision = '99'; },
    run => { run.source.sourceSha256 = 'b'.repeat(64); },
    run => { run.snapshotId = 'another-capture'; },
    run => { run.flowInvocationId = 'another-flow'; },
    run => { run.versions = { ...run.versions, runtime: 'another-runtime' }; },
  ];
  for (const mutate of mutations) {
    const fixtures = await Promise.all(['first', 'middle', 'last'].map(id => fixture(id)));
    const { transport, scope } = transportFor(...fixtures);
    const nativeRead = transport.readExecutionRunCorrelation030, reads: string[] = [];
    let failing = false;
    transport.readExecutionRunCorrelation030 = async (query, id) => {
      reads.push(id);
      if (failing && id === 'middle') throw { code: 'STORAGE_UNCERTAIN', currentIntentKey: null };
      return nativeRead(query, id);
    };
    const access = createRunInspectionAccess030(scope, transport);
    await access.refreshHistory();
    mutate(fixtures[1].summary); failing = true;
    await access.refreshHistory();
    expect(reads.slice(3)).toEqual(['middle']);
    expect(access.getSnapshot().history.kind).toBe('ready');
    expect(retainedRunValue030(access.getSnapshot().history)?.map(item => item.scope.systemStartId)).toEqual(['first', 'last']);
    expect(access.getSnapshot().runFailures.middle).toMatchObject({ kind: 'uncertain', code: 'STORAGE_UNCERTAIN' });
    await access.refreshRun('last');
    expect(access.getSnapshot().runs.last.kind).toBe('ready');
    await access.refreshHistory();
    expect(reads.slice(3)).toEqual(['middle', 'middle']);
  }
});

it('bounds concurrent cold correlation reads to four and keeps native history order', async () => {
  const fixtures = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(id => fixture(id)));
  const { transport, scope } = transportFor(...fixtures);
  const nativeRead = transport.readExecutionRunCorrelation030;
  let active = 0, maximum = 0;
  transport.readExecutionRunCorrelation030 = async (query, id) => {
    active++; maximum = Math.max(maximum, active);
    try { await Promise.resolve(); return await nativeRead(query, id); }
    finally { active--; }
  };
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshHistory();
  expect(maximum).toBe(4);
  expect(active).toBe(0);
  expect(retainedRunValue030(access.getSnapshot().history)?.map(item => item.scope.systemStartId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
});

it('forgets summaries absent from complete discoveries a,b,c then d,e,f then no runs', async () => {
  const fixtures = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(id => fixture(id)));
  const { transport, scope, retainedIntents } = transportFor(...fixtures);
  for (const intent of retainedIntents.values()) if (intent.state.kind === 'admitted')
    intent.state = { kind: 'closed', disposition: 'acknowledged', admission: intent.state.admission };
  let discovered = fixtures.slice(0, 3);
  transport.listExecutionRuns030 = async () => ({ runs: discovered.map(f => f.summary), nextCursor: null });
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshHistory();
  await access.refreshRun('a');
  expect(retainedRunValue030(access.getSnapshot().history)?.map(run => run.scope.systemStartId)).toEqual(['a', 'b', 'c']);
  discovered = fixtures.slice(3);
  await access.refreshHistory();
  expect(retainedRunValue030(access.getSnapshot().history)?.map(run => run.scope.systemStartId)).toEqual(['d', 'e', 'f']);
  expect(access.getSnapshot().runs).toEqual({});
  discovered = [];
  await access.refreshHistory();
  expect(access.getSnapshot().history).toMatchObject({ kind: 'ready', value: [] });
  expect(access.getSnapshot().runFailures).toEqual({});
  // Rediscovery must not compare against obsolete summaries from either set.
  // Without eviction, all six lower revisions trigger REVISION_CONFLICT.
  for (const f of fixtures) { f.summary.revision = '1'; f.runtime.revision = '1'; }
  discovered = fixtures;
  await access.refreshHistory();
  expect(retainedRunValue030(access.getSnapshot().history)).toHaveLength(6);
  expect(access.getSnapshot().runFailures).toEqual({});
});

it('publishes an explicit first-read error outside Tauri and can subsequently recover', async () => {
  const f=await fixture();const {scope,transport}=transportFor(f);
  const {removeTauriRuntimeMock}=await import('../../test-utils/tauriRuntime');removeTauriRuntimeMock();
  const offline=createRunInspectionAccess030(scope);
  await expect(offline.refreshHistory()).rejects.toMatchObject({kind:'transport'});
  expect(offline.getSnapshot().history.kind).toBe('error');
  const history=offline.getSnapshot().history;
  if(history.kind!=='error')throw new Error('Expected an error state');
  expect(history.error.message.length).toBeGreaterThan(0);
  let fail=true;transport.listExecutionRuns030=async()=>{if(fail)throw new Error('Offline');return {runs:[f.summary],nextCursor:null};};
  const access=createRunInspectionAccess030(scope,transport);
  await expect(access.refreshHistory()).rejects.toBeDefined();
  expect(access.getSnapshot().history.kind).toBe('error');
  fail=false;await access.refreshHistory();expect(access.getSnapshot().history.kind).toBe('ready');
});

it('uses reducer-compatible selectors, path ancestry, terminal states and missing true-flow human rows in its shared fixtures', async () => {
  const {nativeAgentRunFixture030}=await import('./runAccess030.testSupport');
  const {validateDocumentBytes}=await import('./document');
  const fixtures=[await fixture(),...await Promise.all(['done','running','stopping','queued','preparing'].map(phase=>nativeAgentRunFixture030(`agent-${phase}`,phase)))];
  for(const f of fixtures){
    const document=JSON.parse(f.capture.authoredSource);
    expect(validateDocumentBytes(new TextEncoder().encode(f.capture.authoredSource)).valid).toBe(true);
    const instances=new Map(f.runtime.items.flatMap(item=>item.kind==='instance'?[[item.value.id,item.value] as const]:[]));
    const activations=f.runtime.items.flatMap(item=>item.kind==='activation'?[item.value]:[]);
    for(const queued of activations.filter(item=>item.phase==='queued')){
      expect(queued.step).not.toBeNull();
      const step=document.flow.steps[queued.step![0]];
      expect(step).toMatchObject({type:'agent',agent:queued.agent,instance:'shared'});
      const owner=instances.get(queued.instanceId!);
      const current=activations.find(item=>item.id===owner?.currentActivationId)!;
      const dispatch=document.flow.steps[document.flow.entry];
      expect(dispatch.next).toContain(current.step![0]);
      expect(dispatch.next).toContain(queued.step![0]);
      expect(activations.some(item=>item.step?.[0]===document.flow.entry&&item.phase==='done')).toBe(true);
    }
    for(const a of activations){
      expect(a.pathIds).toEqual(a.context.flatMap(frame=>frame.kind==='path'?[frame.pathId]:[]));
      expect(a.composeActivationIds).toEqual(a.context.flatMap(frame=>frame.kind==='compose'?[frame.activationId]:[]));
      if(a.context.length===0)expect(a.nearestFanoutIndex).toBeNull();
      const step=a.step?.length===1?document.flow.steps[a.step[0]]:undefined;
      if(a.phase==='body')expect(step?.type).toBe('compose');
      if(a.phase==='group')expect(step?.type).toBe('join');
      if(step?.type==='agent'&&a.instanceId)expect(instances.get(a.instanceId)?.selectorKind).toBe(step.instance??'shared');
    }
    for(const i of instances.values()){
      if(i.discarded){expect(i.selectorKind).toBe('new');expect(i.currentActivationId).toBeNull();expect(i.queueActivationIds).toEqual([]);}
      if(i.queueActivationIds.length)expect(activations.find(a=>a.id===i.currentActivationId)?.physical).toBe(true);
    }
    if(f.summary.verdict!==null)expect(activations.every(a=>a.phase==='done'&&!a.physical)).toBe(true);
    const {transport}=transportFor(f);
    await expect(transport.readExecutionHumans030(f.scope)).rejects.toMatchObject({code:'NOT_FOUND'});
  }
  await expect(nativeAgentRunFixture030('invalid','body')).rejects.toThrow('Agent fixture phase');
  await expect(nativeAgentRunFixture030('invalid','group')).rejects.toThrow('Agent fixture phase');
});

it('retains the native call result while visit details remain unavailable', async () => {
  const f = await fixture();
  const row = f.runtime.items.find(item => item.kind === 'activation');
  if (row?.kind !== 'activation') throw new Error('No activation');
  row.value.callResultJson = JSON.stringify({ kind: 'completed', outputJson: '{"outcome":"failed","data":{"exitCode":7,"output":"native output"}}', routeKey: 'failed' });
  const { transport, scope } = transportFor(f);
  const access = createRunInspectionAccess030(scope, transport);
  await access.refreshRun('run');
  const occurrence = retainedRunValue030(retainedRunValue030(access.getSnapshot().runs.run)!.state.occurrences)![0];
  expect(occurrence.details.kind).toBe('unavailable');
  const { commandResult030, normalRunOutcome030 } = await import('./runGraphProjection030');
  expect(commandResult030(occurrence)).toEqual({ exitCode: '7', output: 'native output' });
  expect(normalRunOutcome030(occurrence)).toBe('failed');
});
