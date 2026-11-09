import type { NativeDtoGap030, NativeFact030, RunCapture030, RunRead030, RunRefusal030, RunVerdict030 } from '../../types/agsdlRunUi030';
import type { EngineSourceOwner, ExecutionIntentScope, PublicRunSummary030 } from '../../types/generated/ipc';
import { listExecutionRuns030, readExecutionSnapshot030, readExecutionRuntimeProjection030,
  readExecutionHumans030, readExecutionIntentsVersioned } from '../tauriIpc';
import { MacroServiceError, toServiceError } from '../contracts/errors';
import { sourceDigest } from '../agsdlExecution/compiler';
import { readDocument } from './document';
import { readHumanFacts030, sameHumanScope030 } from './humanReadAccess030';
import { loadRuntimeProjection030, retainedRunValue030, runtimeSections030 } from './runtimeProjection030';
import type { RunHistoryEntry030, RunInspection030, RunInspectionAccess030, RunMonitorSnapshot030 } from './runtimeProjection030';

export interface RunReadTransport030 {
  listExecutionRuns030: typeof listExecutionRuns030;
  readExecutionSnapshot030: typeof readExecutionSnapshot030;
  readExecutionRuntimeProjection030: typeof readExecutionRuntimeProjection030;
  readExecutionHumans030: typeof readExecutionHumans030;
  readExecutionIntentsVersioned: typeof readExecutionIntentsVersioned;
}
const nativeTransport = { listExecutionRuns030, readExecutionSnapshot030, readExecutionRuntimeProjection030,
  readExecutionHumans030, readExecutionIntentsVersioned };
const sameOwner = (a: EngineSourceOwner, b: EngineSourceOwner) =>
  a.projectId === b.projectId && a.planId === b.planId && a.branch === b.branch;
const sameVersions = (a: RunCapture030['versions'], b: PublicRunSummary030['versions']) =>
  (['snapshot', 'contract', 'profile', 'compiler', 'runtime', 'registry'] as const).every(key => a[key] === b[key]);
const unavailable = (gap: NativeDtoGap030) => ({ kind: 'unavailable' as const, gap });
const decimal = (value: string) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
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
  const decoded = toServiceError(error);
  const allowed: readonly string[] = ['SCOPE_INVALID', 'SCOPE_UNAVAILABLE', 'CORRELATION', 'NOT_FOUND',
    'CONTRACT_UNSUPPORTED', 'REVISION_CONFLICT', 'CONFLICT', 'INPUT_LIMIT', 'DTO_UNAVAILABLE'];
  return { code: allowed.includes(decoded.code) ? decoded.code as RunRefusal030<'consult'>['code'] : 'SCOPE_UNAVAILABLE',
    message: decoded.message, currentRevision: null };
}
function failed<T>(previous: RunRead030<T>, error: unknown): RunRead030<T> {
  const retained = retainedRunValue030(previous);
  if (retained !== null && (previous.kind === 'ready' || previous.kind === 'stale'))
    return { kind: 'stale', revision: previous.revision, retained, refusal: refusal(error) };
  return { kind: 'unavailable', gap: 'qualification' };
}

/** One immutable observation scope per adapter. All refreshes are serialized;
 * no earlier refresh can overwrite a later one. This performs reads only.
 * History revision is an opaque tuple of native per-run revisions, not a claim
 * that discovery and the human/runtime projections share a native revision.
 */
export function createRunInspectionAccess030(scope: ExecutionIntentScope,
  transport: RunReadTransport030 = nativeTransport): RunInspectionAccess030 {
  const expected = structuredClone(scope);
  requireFact(Object.values(expected.owner).every(value => typeof value === 'string' && value.length > 0) &&
    typeof expected.conversationId === 'string' && expected.conversationId.length > 0, 'SCOPE_INVALID');
  const scopeKey = JSON.stringify([expected.owner.projectId, expected.owner.planId, expected.owner.branch, expected.conversationId]);
  let snapshot: RunMonitorSnapshot030 = freeze({ history: { kind: 'loading', retained: null },
    retainedAdmission: unavailable('qualification'), runs: {} });
  const listeners = new Set<() => void>();
  const retainedSummaries = new Map<string, PublicRunSummary030>();
  const publish = (next: RunMonitorSnapshot030) => {
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
    return runs;
  }
  async function captureFor(run: PublicRunSummary030): Promise<RunCapture030> {
    const capture = await transport.readExecutionSnapshot030(run.systemStartId);
    requireFact(sameHumanScope030(capture, run) && sameVersions(capture.versions, run.versions));
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
      verdict: verdict(run.verdict), physicalPending: run.physicalPending,
      humans: await readHumanFacts030({ systemStartId: run.systemStartId, source: run.source }, transport.readExecutionHumans030),
      chronology: unavailable('chronology') };
  }
  async function admission(history: readonly RunHistoryEntry030[], runs: readonly PublicRunSummary030[]): Promise<NativeFact030<string | null>> {
    const intents = await transport.readExecutionIntentsVersioned({ scope: structuredClone(expected) });
    requireFact(intents.length <= 1);
    const intent = intents[0];
    if (!intent) return { kind: 'available', value: null };
    requireFact(sameOwner(intent.key.scope.owner, expected.owner) && intent.key.scope.conversationId === expected.conversationId, 'SCOPE_INVALID');
    const state = intent.state;
    const admitted = state.kind === 'admitted' || state.kind === 'closed' ? state.admission : null;
    if (admitted?.kind !== 'start030') return { kind: 'available', value: null };
    const receipt = admitted.receipt;
    requireFact(intent.formatVersion === '1' && intent.payload.kind === 'start' && intent.payload.request.profile === 'macro-agsdl-030-v1');
    const request = intent.payload.request;
    const entry = history.find(item => item.scope.systemStartId === receipt.systemStartId);
    const summary = runs.find(item => item.systemStartId === receipt.systemStartId);
    requireFact(entry && summary && receipt.flowInvocationId === summary.flowInvocationId &&
      sameHumanScope030(receipt, entry.scope) && sameVersions(entry.capture.versions, receipt.versions) &&
      sameHumanScope030({ systemStartId: receipt.systemStartId, source: request.source }, entry.scope) &&
      receipt.entryDeliveryId === (request.entry?.deliveryId ?? null));
    return { kind: 'available', value: receipt.systemStartId };
  }
  return {
    scopeKey,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshHistory: () => enqueue(async () => {
      const previous = snapshot.history;
      publish({ ...snapshot, history: { kind: 'loading', retained: retainedRunValue030(previous) } });
      try {
        const runs = await summaries(), history: RunHistoryEntry030[] = [];
        for (const run of runs) {
          const capture = await captureFor(run);
          // Native discovery is owner-scoped. Only an explicit captured
          // conversation association attests membership in this UI scope.
          if (capture.associations.conversationId === expected.conversationId) history.push(await historyEntry(run, capture));
        }
        const retainedAdmission = await admission(history, runs);
        const retainedRuns = Object.fromEntries(Object.entries(snapshot.runs).filter(([id]) => history.some(item => item.scope.systemStartId === id)));
        // A changed summary never leaves the selected runtime looking fresh.
        for (const run of runs) {
          const read = retainedRuns[run.systemStartId];
          const retained = read && retainedRunValue030(read);
          if (retained && (run.revision !== retained.state.revision || run.ownerStatus !== retained.state.ownerStatus ||
            run.stopping !== retained.state.stopping || run.physicalPending !== retained.state.physicalPending ||
            run.verdict !== retained.state.verdict)) retainedRuns[run.systemStartId] = failed(read,
            new MacroServiceError('REVISION_CONFLICT', 'Run changed; refresh its projection'));
        }
        for (const entry of history) retainedSummaries.set(entry.scope.systemStartId,
          structuredClone(runs.find(run => run.systemStartId === entry.scope.systemStartId)!));
        publish({ history: { kind: 'ready', revision: JSON.stringify(history.map(item => {
          const run = runs.find(run => run.systemStartId === item.scope.systemStartId)!;
          return [run.systemStartId, run.snapshotId, run.revision];
        })), value: history }, retainedAdmission, runs: retainedRuns });
      } catch (error) {
        publish({ ...snapshot, history: failed(previous, error), retainedAdmission: unavailable('qualification') });
      }
    }),
    refreshRun: systemStartId => enqueue(async () => {
      const previous = Object.hasOwn(snapshot.runs, systemStartId) ? snapshot.runs[systemStartId] : unavailable('occurrence-details');
      publish({ ...snapshot, runs: { ...snapshot.runs, [systemStartId]: { kind: 'loading', retained: retainedRunValue030(previous) } } });
      try {
        const summary = (await summaries()).find(run => run.systemStartId === systemStartId);
        requireFact(summary, 'NOT_FOUND');
        const capture = await captureFor(summary);
        requireFact(capture.associations.conversationId === expected.conversationId, 'SCOPE_INVALID');
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
        publish({ ...snapshot, runs: { ...snapshot.runs, [systemStartId]: failed(previous, error) } });
      }
    }),
  };
}
