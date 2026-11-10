import type { NativeDtoGap030, NativeFact030, RunCapture030, RunRead030, RunRefusal030, RunVerdict030 } from '../../types/agsdlRunUi030';
import type { EngineSourceOwner, ExecutionIntentScope, ExecutionRunCorrelation030, PublicRunSummary030 } from '../../types/generated/ipc';
import { listExecutionRuns030, readExecutionSnapshot030, readExecutionRuntimeProjection030,
  readExecutionHumans030, readExecutionIntentsVersioned, readExecutionRunCorrelation030 } from '../tauriIpc';
import { MacroServiceError, toServiceError } from '../contracts/errors';
import { sourceDigest } from '../agsdlExecution/compiler';
import { readDocument } from './document';
import { readHumanFacts030, sameHumanScope030 } from './humanReadAccess030';
import { loadRuntimeProjection030, retainedRunValue030, runtimeSections030 } from './runtimeProjection030';
import type { RunHistoryEntry030, RunInspection030, RunInspectionAccess030, RunMonitorSnapshot030, RunReadFailure030 } from './runtimeProjection030';
export type { RunReadFailure030 } from './runtimeProjection030';

export interface RunReadTransport030 {
  listExecutionRuns030: typeof listExecutionRuns030;
  readExecutionSnapshot030: typeof readExecutionSnapshot030;
  readExecutionRuntimeProjection030: typeof readExecutionRuntimeProjection030;
  readExecutionHumans030: typeof readExecutionHumans030;
  readExecutionIntentsVersioned: typeof readExecutionIntentsVersioned;
  readExecutionRunCorrelation030: typeof readExecutionRunCorrelation030;
}
const nativeTransport = { listExecutionRuns030, readExecutionSnapshot030, readExecutionRuntimeProjection030,
  readExecutionHumans030, readExecutionIntentsVersioned, readExecutionRunCorrelation030 };
const sameOwner = (a: EngineSourceOwner, b: EngineSourceOwner) =>
  a.projectId === b.projectId && a.planId === b.planId && a.branch === b.branch;
const sameVersions = (a: PublicRunSummary030['versions'], b: PublicRunSummary030['versions']) =>
  (['snapshot', 'contract', 'profile', 'compiler', 'runtime', 'registry'] as const).every(key => a[key] === b[key]);
const unavailable = (gap: NativeDtoGap030) => ({ kind: 'unavailable' as const, gap });
const decimal = (value: string) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);

/** Read failures are separate from missing native facts. Preserve native codes
 * on promise rejection, including uncertainty, which is not a scope refusal. */
export class RunInspectionReadError030 extends MacroServiceError {
  readonly kind: RunReadFailure030['kind'];
  constructor(error: unknown) {
    const decoded = toServiceError(error);
    // ExecutionIntentError has code/currentIntentKey, but no message. The
    // general service decoder would otherwise lose its native refusal code.
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code : decoded.code;
    super(code, decoded.code === 'UNEXPECTED_ERROR' && code !== decoded.code ? code : decoded.message, decoded.details ?? error);
    this.name = 'RunInspectionReadError030';
    this.kind = ['CONFLICT', 'REVISION_CONFLICT'].includes(code) ? 'conflict'
      : code === 'NOT_FOUND' ? 'notFound'
      : ['SCOPE_INVALID', 'SCOPE_UNAVAILABLE', 'CORRELATION'].includes(code) ? 'scope'
      : ['STORAGE_UNCERTAIN', 'RUNTIME_UNAVAILABLE', 'UNCERTAIN', 'STOP_PENDING'].includes(code) ? 'uncertain' : 'transport';
  }
}
export interface RunAccessSnapshot030 extends RunMonitorSnapshot030 {
  /** Discovery is owner-scoped. Omitted runs retain an explicit scope reason. */
  readonly excludedRuns: Readonly<Record<string, RunRefusal030<'consult'>>>;
}
type CorrelationRead030 =
  | { readonly kind: 'attested'; readonly value: ExecutionRunCorrelation030 }
  | { readonly kind: 'excluded'; readonly refusal: RunRefusal030<'consult'> }
  | { readonly kind: 'failed'; readonly error: RunInspectionReadError030 };
export interface RunAccess030 extends RunInspectionAccess030 {
  getSnapshot(): RunAccessSnapshot030;
}
function requireFact(condition: unknown, code = 'CORRELATION', message = 'Native run facts differ'): asserts condition {
  if (!condition) throw new MacroServiceError(code, message);
}
function verdict(value: string | null): RunVerdict030 {
  requireFact(value === null || value === 'succeeded' || value === 'failed' || value === 'cancelled');
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function refusal(error: unknown): RunRefusal030<'consult'> {
  const decoded = new RunInspectionReadError030(error);
  const allowed: readonly string[] = ['SCOPE_INVALID', 'SCOPE_UNAVAILABLE', 'CORRELATION', 'NOT_FOUND',
    'CONTRACT_UNSUPPORTED', 'REVISION_CONFLICT', 'CONFLICT', 'INPUT_LIMIT', 'DTO_UNAVAILABLE'];
  return { code: allowed.includes(decoded.code) ? decoded.code as RunRefusal030<'consult'>['code'] : 'SCOPE_UNAVAILABLE',
    message: decoded.message, currentRevision: null };
}
function failed<T>(previous: RunRead030<T>, error: unknown): RunRead030<T> {
  const retained = retainedRunValue030(previous);
  if (retained !== null && (previous.kind === 'ready' || previous.kind === 'stale'))
    return { kind: 'stale', revision: previous.revision, retained, refusal: refusal(error) };
  const failure = new RunInspectionReadError030(error);
  return { kind: 'error', error: { code: failure.code, message: failure.message } };
}
function readFailure(error: unknown, revision: string | null): RunReadFailure030 {
  const decoded = new RunInspectionReadError030(error);
  return { kind: decoded.kind, code: decoded.code, message: decoded.message, revision };
}
/** Canonical primitive tuple, independent of the DTO's object key ordering. */
function discoveryKey(run: PublicRunSummary030): string {
  const { owner, revision, sourceSha256 } = run.source;
  const versions = run.versions;
  return JSON.stringify([run.systemStartId, run.snapshotId, run.flowInvocationId, run.revision,
    owner.projectId, owner.planId, owner.branch, revision, sourceSha256,
    versions.snapshot, versions.contract, versions.profile, versions.compiler, versions.runtime, versions.registry,
    run.ownerStatus, run.stopping, run.verdict, run.physicalPending, run.phaseCounts.map(item => [item.phase, item.count])]);
}

/** One immutable observation scope per adapter. All refreshes are serialized;
 * no earlier refresh can overwrite a later one. This performs reads only.
 * History revision is an opaque tuple of native per-run revisions, not a claim
 * that discovery and the human/runtime projections share a native revision.
 * Discovery failures reject with RunInspectionReadError030. Per-run failures
 * are published in runFailures without rejecting history. An independent
 * intent failure rejects only after publishing the completed history.
 */
export function createRunInspectionAccess030(scope: ExecutionIntentScope,
  transport: RunReadTransport030 = nativeTransport): RunAccess030 {
  const expected = structuredClone(scope);
  requireFact(Object.values(expected.owner).every(value => typeof value === 'string' && value.length > 0) &&
    typeof expected.conversationId === 'string' && expected.conversationId.length > 0, 'SCOPE_INVALID');
  const scopeKey = JSON.stringify([expected.owner.projectId, expected.owner.planId, expected.owner.branch, expected.conversationId]);
  let snapshot: RunAccessSnapshot030 = freeze({ history: { kind: 'loading', retained: null },
    historyOrder: [], retainedAdmission: unavailable('qualification'), runs: {}, excludedRuns: {}, runFailures: {} });
  const listeners = new Set<() => void>();
  const retainedSummaries = new Map<string, PublicRunSummary030>();
  // This adapter owns exactly one scopeKey. Successful immutable proofs are
  // indexed by run and discovery; failures are deliberately never cached.
  const correlationCache = new Map<string, { discovery: string; value: ExecutionRunCorrelation030 }>();
  const publish = (next: RunAccessSnapshot030) => {
    snapshot = freeze(structuredClone(next));
    listeners.forEach(listener => listener());
  };
  let queue = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const pending = queue.then(operation);
    queue = pending.catch(() => undefined);
    return pending;
  };

  async function summaries(): Promise<PublicRunSummary030[]> {
    const runs: PublicRunSummary030[] = [], ids = new Set<string>(), cursors = new Set<string>();
    let after: string | null = null;
    do {
      const page = await transport.listExecutionRuns030({ owner: structuredClone(expected.owner), after, limit: 100 });
      requireFact(page.runs.length <= 100 && (page.nextCursor === null ||
        (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.runs.length > 0 && !cursors.has(page.nextCursor))));
      for (const run of page.runs) {
        requireFact(sameOwner(run.source.owner, expected.owner), 'SCOPE_INVALID');
        requireFact(run.systemStartId && !ids.has(run.systemStartId) && run.snapshotId && run.flowInvocationId &&
          decimal(run.revision) && decimal(run.physicalPending) &&
          (run.ownerStatus === 'live' || run.ownerStatus === 'revoked') && typeof run.stopping === 'boolean');
        verdict(run.verdict);
        requireFact(run.versions.snapshot === '2' && run.versions.contract === 'agsdl-0.3.0' && run.versions.profile === 'macro-agsdl-030-v1', 'CONTRACT_UNSUPPORTED');
        ids.add(run.systemStartId); runs.push(structuredClone(run));
      }
      after = page.nextCursor;
      if (after !== null) cursors.add(after);
    } while (after !== null);
    const discoveries = new Map(runs.map(run => [run.systemStartId, discoveryKey(run)]));
    for (const [id, cached] of correlationCache)
      if (discoveries.get(id) !== cached.discovery) correlationCache.delete(id);
    for (const id of retainedSummaries.keys())
      if (!discoveries.has(id)) retainedSummaries.delete(id);
    return runs;
  }
  async function captureFor(run: PublicRunSummary030, correlation: ExecutionRunCorrelation030): Promise<RunCapture030> {
    const capture = await transport.readExecutionSnapshot030(run.systemStartId);
    requireFact(sameHumanScope030(capture, run) && sameVersions(capture.versions, run.versions) &&
      sameHumanScope030(capture, correlation.receipt) && sameVersions(capture.versions, correlation.receipt.versions));
    requireFact(await sourceDigest(capture.authoredSource) === capture.source.sourceSha256 &&
      readDocument(capture.authoredSource).contract === 'agsdl-0.3.0');
    return structuredClone(capture);
  }
  function verifyRetained(run: PublicRunSummary030) {
    const summary = retainedSummaries.get(run.systemStartId);
    if (summary) {
      requireFact(sameHumanScope030(summary, run) && summary.snapshotId === run.snapshotId && summary.flowInvocationId === run.flowInvocationId);
      requireFact(BigInt(run.revision) >= BigInt(summary.revision), 'REVISION_CONFLICT');
    }
    const previous = retainedRunValue030(snapshot.runs[run.systemStartId] ?? unavailable('occurrence-details'));
    const history = retainedRunValue030(snapshot.history)?.find(item => item.scope.systemStartId === run.systemStartId);
    for (const retained of [previous && { scope: previous.state.scope, capture: previous.capture }, history]) {
      if (retained) requireFact(sameHumanScope030(retained.scope, run) && retained.scope.snapshotId === run.snapshotId &&
        sameVersions(retained.capture.versions, run.versions));
    }
    if (previous) requireFact(BigInt(run.revision) >= BigInt(previous.state.revision), 'REVISION_CONFLICT');
  }
  async function historyEntry(run: PublicRunSummary030, capture: RunCapture030): Promise<RunHistoryEntry030> {
    verifyRetained(run);
    return { capture, scope: { systemStartId: run.systemStartId, snapshotId: run.snapshotId, source: run.source },
      verdict: verdict(run.verdict), physicalPending: run.physicalPending, interruptedAt: run.interruptedAt,
      humans: await readHumanFacts030({ systemStartId: run.systemStartId, source: run.source }, transport.readExecutionHumans030),
      chronology: unavailable('chronology') };
  }
  async function admission(runs: readonly PublicRunSummary030[]): Promise<NativeFact030<string | null>> {
    const intents = await transport.readExecutionIntentsVersioned({ scope: structuredClone(expected) });
    requireFact(intents.length <= 1);
    const intent = intents[0];
    if (!intent) return { kind: 'available', value: null };
    requireFact(sameOwner(intent.key.scope.owner, expected.owner) && intent.key.scope.conversationId === expected.conversationId, 'SCOPE_INVALID');
    const state = intent.state;
    const admitted = state.kind === 'admitted' ? state.admission : null;
    if (admitted?.kind !== 'start030') return { kind: 'available', value: null };
    const receipt = admitted.receipt;
    requireFact(intent.formatVersion === '1' && intent.payload.kind === 'start' && intent.payload.request.profile === 'macro-agsdl-030-v1');
    const request = intent.payload.request;
    const summary = runs.find(item => item.systemStartId === receipt.systemStartId);
    requireFact(summary && receipt.flowInvocationId === summary.flowInvocationId &&
      sameHumanScope030(receipt, summary) && sameVersions(receipt.versions, summary.versions) &&
      sameHumanScope030({ systemStartId: receipt.systemStartId, source: request.source }, summary) &&
      receipt.entryDeliveryId === (request.entry?.deliveryId ?? null) &&
      request.associations.conversationId === undefined && request.associations.workspaceId === undefined);
    return { kind: 'available', value: receipt.systemStartId };
  }
  async function correlation(run: PublicRunSummary030): Promise<CorrelationRead030> {
    const discovery = discoveryKey(run);
    const cached = correlationCache.get(run.systemStartId);
    if (cached?.discovery === discovery) return { kind: 'attested', value: structuredClone(cached.value) };
    try {
      const value = await transport.readExecutionRunCorrelation030(structuredClone(expected), run.systemStartId);
      const { key, receipt } = value;
      requireFact(typeof key.intentId === 'string' && key.intentId.length > 0 && sameOwner(key.scope.owner, expected.owner) &&
        key.scope.conversationId === expected.conversationId, 'CORRELATION', 'Native run correlation scope differs');
      requireFact(sameHumanScope030(receipt, run) && receipt.flowInvocationId === run.flowInvocationId &&
        sameVersions(receipt.versions, run.versions) && (receipt.entryDeliveryId === null ||
        (typeof receipt.entryDeliveryId === 'string' && receipt.entryDeliveryId.length > 0)),
      'CORRELATION', 'Native run correlation receipt differs');
      correlationCache.set(run.systemStartId, { discovery, value: structuredClone(value) });
      return { kind: 'attested', value };
    } catch (error) {
      const failure = new RunInspectionReadError030(error);
      return failure.code === 'SCOPE_INVALID' ? { kind: 'excluded', refusal: refusal(failure) } : { kind: 'failed', error: failure };
    }
  }
  async function correlations(runs: readonly PublicRunSummary030[]) {
    const results = new Map<string, CorrelationRead030>();
    let next = 0;
    // Bound concurrent native SQL reads; retain discovery order at publication.
    await Promise.all(Array.from({ length: Math.min(4, runs.length) }, async () => {
      while (next < runs.length) {
        const run = runs[next++];
        results.set(run.systemStartId, await correlation(run));
      }
    }));
    return results;
  }
  /** Discovery alone can disprove freshness. Publish that fact before any
   * later capture or intent read can fail, without publishing partial runs. */
  function invalidateRetained(runs: readonly PublicRunSummary030[]) {
    const retainedRuns = { ...snapshot.runs };
    let changed = false;
    for (const run of runs) {
      const read = Object.hasOwn(retainedRuns, run.systemStartId) ? retainedRuns[run.systemStartId] : undefined;
      const retained = read && retainedRunValue030(read);
      if (retained && (run.revision !== retained.state.revision || run.ownerStatus !== retained.state.ownerStatus ||
        run.stopping !== retained.state.stopping || run.physicalPending !== retained.state.physicalPending ||
        run.verdict !== retained.state.verdict || run.snapshotId !== retained.state.scope.snapshotId ||
        run.flowInvocationId !== retained.state.flowInvocationId || !sameHumanScope030(run, retained.state.scope) ||
        !sameVersions(run.versions, retained.capture.versions))) {
        retainedRuns[run.systemStartId] = { kind: 'stale', revision: retained.state.revision, retained,
          refusal: { code: 'REVISION_CONFLICT', message: 'Run changed; refresh its projection', currentRevision: run.revision } };
        changed = true;
      }
    }
    if (changed) publish({ ...snapshot, runs: retainedRuns });
  }
  return {
    scopeKey,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshHistory: () => enqueue(async () => {
      const previous = snapshot.history;
      let admissionError: RunInspectionReadError030 | undefined;
      publish({ ...snapshot, history: { kind: 'loading', retained: retainedRunValue030(previous) } });
      try {
        const runs = await summaries(), history: RunHistoryEntry030[] = [];
        invalidateRetained(runs);
        let retainedAdmission: NativeFact030<string | null>;
        try { retainedAdmission = await admission(runs); }
        catch (error) { retainedAdmission = unavailable('qualification'); admissionError = new RunInspectionReadError030(error); }
        const results = await correlations(runs);
        const excludedRuns: Record<string, RunRefusal030<'consult'>> = Object.create(null);
        const runFailures: Record<string, RunReadFailure030> = Object.create(null);
        for (const run of runs) {
          const result = results.get(run.systemStartId)!;
          if (result.kind === 'excluded') { excludedRuns[run.systemStartId] = result.refusal; continue; }
          try {
            if (result.kind === 'failed') throw result.error;
            const capture = await captureFor(run, result.value);
            history.push(await historyEntry(run, capture));
          } catch (error) { runFailures[run.systemStartId] = readFailure(error, run.revision); }
        }
        const retainedRuns = Object.fromEntries(Object.entries(snapshot.runs).filter(([id]) =>
          history.some(item => item.scope.systemStartId === id) || Object.hasOwn(runFailures, id)));
        for (const [id, error] of Object.entries(runFailures)) {
          const retained = retainedRuns[id] && retainedRunValue030(retainedRuns[id]);
          if (retained) retainedRuns[id] = { kind: 'stale', revision: retained.state.revision, retained, refusal: refusal(error) };
        }
        for (const entry of history) retainedSummaries.set(entry.scope.systemStartId,
          structuredClone(runs.find(run => run.systemStartId === entry.scope.systemStartId)!));
        publish({ history: { kind: 'ready', revision: JSON.stringify(history.map(item => {
          const run = runs.find(run => run.systemStartId === item.scope.systemStartId)!;
          return [run.systemStartId, run.snapshotId, run.revision];
        })), value: history }, historyOrder: runs.filter(run => !Object.hasOwn(excludedRuns, run.systemStartId)).map(run => run.systemStartId),
        retainedAdmission, runs: retainedRuns, excludedRuns, runFailures });
      } catch (error) {
        publish({ ...snapshot, history: failed(previous, error), retainedAdmission: unavailable('qualification') });
        throw new RunInspectionReadError030(error);
      }
      // The history is complete and remains ready even if the independent
      // intent read failed. Notify callers without rolling that history back.
      if (admissionError) throw admissionError;
    }),
    refreshRun: systemStartId => enqueue(async () => {
      const previous = Object.hasOwn(snapshot.runs, systemStartId) ? snapshot.runs[systemStartId] : { kind: 'loading' as const, retained: null };
      let admissionError: RunInspectionReadError030 | undefined;
      let revision: string | null = null;
      publish({ ...snapshot, runs: { ...snapshot.runs, [systemStartId]: { kind: 'loading', retained: retainedRunValue030(previous) } } });
      try {
        const runs = await summaries();
        invalidateRetained(runs);
        // Open intents affect only retainedAdmission. Run membership is read
        // independently from its durable native attachment, including closure.
        try { publish({ ...snapshot, retainedAdmission: await admission(runs) }); }
        catch (error) {
          const failure = new RunInspectionReadError030(error);
          publish({ ...snapshot, retainedAdmission: unavailable('qualification') });
          admissionError = failure;
        }
        const summary = runs.find(run => run.systemStartId === systemStartId);
        requireFact(summary, 'NOT_FOUND');
        revision = summary.revision;
        const result = await correlation(summary);
        const excludedRuns = { ...snapshot.excludedRuns }, runFailures = { ...snapshot.runFailures };
        delete excludedRuns[systemStartId]; delete runFailures[systemStartId];
        if (result.kind === 'excluded') excludedRuns[systemStartId] = result.refusal;
        const known = new Set([...snapshot.historyOrder, systemStartId]);
        const historyOrder = runs.filter(run => known.has(run.systemStartId) && !Object.hasOwn(excludedRuns, run.systemStartId))
          .map(run => run.systemStartId);
        publish({ ...snapshot, historyOrder, excludedRuns, runFailures });
        if (result.kind === 'failed') throw result.error;
        if (result.kind === 'excluded') throw new MacroServiceError(result.refusal.code, result.refusal.message);
        const capture = await captureFor(summary, result.value);
        verifyRetained(summary);
        const scope = { systemStartId, source: summary.source, snapshotId: summary.snapshotId };
        const runtime = await loadRuntimeProjection030(scope, summary.flowInvocationId, transport.readExecutionRuntimeProjection030, () => true);
        requireFact(runtime && runtime.revision === summary.revision && runtime.stopping === summary.stopping &&
          runtime.verdict === summary.verdict, 'REVISION_CONFLICT');
        const sections = runtimeSections030(runtime);
        requireFact(BigInt(sections.activations.filter(activation => activation.physical).length) === BigInt(summary.physicalPending));
        const humans = await readHumanFacts030({ systemStartId, source: summary.source }, transport.readExecutionHumans030);
        const value: RunInspection030 = { capture, state: { scope, flowInvocationId: runtime.flowInvocationId,
          revision: runtime.revision, verdict: verdict(runtime.verdict), ownerStatus: summary.ownerStatus as 'live' | 'revoked',
          stopping: runtime.stopping, physicalPending: summary.physicalPending,
          stop: unavailable('stop-proof'), uncertainties: unavailable('uncertainty'), humans,
          occurrences: { kind: 'ready', revision: runtime.revision, value: sections.activations.map(activation => ({
            scope, activation, details: unavailable('occurrence-details'),
          })) }, instances: sections.instances, groups: sections.groups, paths: sections.paths,
          diagnostics: unavailable('diagnostics'), chronology: unavailable('chronology') } };
        retainedSummaries.set(systemStartId, structuredClone(summary));
        publish({ ...snapshot, runs: { ...snapshot.runs, [systemStartId]: { kind: 'ready', revision: runtime.revision, value } } });
      } catch (error) {
        const failure = new RunInspectionReadError030(error);
        const runFailures = { ...snapshot.runFailures }, excludedRuns = { ...snapshot.excludedRuns };
        if (failure.code !== 'SCOPE_INVALID') {
          runFailures[systemStartId] = readFailure(failure, revision);
          delete excludedRuns[systemStartId];
        }
        const runs = { ...snapshot.runs }, retained = retainedRunValue030(previous);
        if (retained) runs[systemStartId] = { kind: 'stale', revision: retained.state.revision, retained, refusal: refusal(error) };
        else delete runs[systemStartId];
        publish({ ...snapshot, runFailures, excludedRuns, runs });
        throw new RunInspectionReadError030(error);
      }
      // The run remains inspectable through durable native attestation, while
      // the independent intent failure still reaches the caller as typed data.
      if (admissionError) throw admissionError;
    }),
  };
}
