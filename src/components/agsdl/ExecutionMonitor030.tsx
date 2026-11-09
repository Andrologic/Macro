import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { RunInspection030, RunInspectionAccess030 } from '../../services/agsdl/runtimeProjection030';
import { initialRunSelection030, retainedRunValue030 } from '../../services/agsdl/runtimeProjection030';
import { runOccurrenceKey030, runCaptureKey030 } from '../../services/agsdl/runGraphProjection030';
import { RunHistory030, RunCaptureComparison030 } from './RunHistory030';
import { RunInspector030, ExactContent, knownPhase, type RunGraphBridge030 } from './RunInspector030';
import { RuntimeProjectionView030, type RuntimeSelection030 } from './RuntimeProjectionView030';
import { useAgsdlTranslation } from './useAgsdlTranslation';

export interface ExecutionMonitorProps030 {
  readonly access: RunInspectionAccess030;
  readonly initialRunId?: string;
  readonly currentSource?: string;
  readonly renderGraph?: (bridge: RunGraphBridge030) => ReactNode;
  /** Observation only, never a scheduler. Zero disables periodic readback. */
  readonly refreshIntervalMs?: number;
  readonly renderHumans?: (inspection: RunInspection030) => ReactNode;
}
function retainedInspection(read: ReturnType<RunInspectionAccess030['getSnapshot']>['runs'][string]) { return retainedRunValue030(read); }

/** Scope changes detach all local selections. Opening only performs readback. */
export function ExecutionMonitor030(props: ExecutionMonitorProps030) {
  return <ScopedMonitor030 key={props.access.scopeKey} {...props} />;
}
function ScopedMonitor030({ access, initialRunId, currentSource, renderGraph, refreshIntervalMs = 5000, renderHumans }: ExecutionMonitorProps030) {
  const { t } = useAgsdlTranslation();
  const tr = (key: string) => t(`agsdl.run030.${key}`);
  const subscribe = useCallback((listener: () => void) => access.subscribe(listener), [access]);
  const getSnapshot = useCallback(() => access.getSnapshot(), [access]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [explicit, setExplicit] = useState(initialRunId);
  const [automatic, setAutomatic] = useState<string>();
  const preferred = explicit ?? automatic;
  const selected = snapshot.history.kind === 'ready' ? initialRunSelection030(snapshot, preferred)
    : preferred ?? initialRunSelection030(snapshot);
  const [comparison, setComparison] = useState<string>();
  const [selections, setSelections] = useState<Record<string, { step?: string; occurrence?: string; runtime?: RuntimeSelection030 }>>({});
  const [readErrors, setReadErrors] = useState<ReadonlySet<string>>(new Set());
  const readFailed = readErrors.has('history') || (selected !== undefined && readErrors.has(selected));
  const pending = useRef(new Set<string>());
  const mounted = useRef(false);
  const read = useCallback(async (key: string, operation: () => Promise<void>) => {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    try { await operation(); if (mounted.current) setReadErrors(previous => { const next = new Set(previous); next.delete(key); return next; }); }
    catch { if (mounted.current) setReadErrors(previous => new Set(previous).add(key)); }
    finally { pending.current.delete(key); }
  }, []);
  const refresh = useCallback(() => {
    void read('history', () => access.refreshHistory());
    if (selected) void read(selected, () => access.refreshRun(selected));
    if (comparison && comparison !== selected) void read(comparison, () => access.refreshRun(comparison));
  }, [access, read, selected, comparison]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { void read('history', () => access.refreshHistory()); }, [access, read]);
  useEffect(() => {
    if (selected) { setAutomatic(selected); void read(selected, () => access.refreshRun(selected)); }
  }, [selected, access, read]);
  useEffect(() => {
    if (comparison) void read(comparison, () => access.refreshRun(comparison));
  }, [comparison, access, read]);
  useEffect(() => {
    const interval = refreshIntervalMs > 0 ? window.setInterval(refresh, refreshIntervalMs) : undefined;
    window.addEventListener('focus', refresh);
    return () => { if (interval !== undefined) window.clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, [refresh, refreshIntervalMs]);
  const history = retainedRunValue030(snapshot.history) ?? [];
  const readState = selected ? snapshot.runs[selected] : undefined;
  const inspection = readState ? retainedInspection(readState) : null;
  const identity = inspection ? runCaptureKey030(inspection.state.scope) : '';
  const selection = selections[identity] ?? {};
  const choose = (value: Partial<typeof selection>) => setSelections(previous => ({ ...previous, [identity]: { ...previous[identity], ...value } }));
  const left = history.find(run => run.scope.systemStartId === selected);
  const right = history.find(run => run.scope.systemStartId === comparison);
  const stale = readFailed || readState?.kind === 'stale' || (readState?.kind === 'loading' && readState.retained !== null);
  const state = inspection?.state;
  const occurrences = state ? retainedRunValue030(state.occurrences) : null;
  const runtimeLabels = { instances: tr('instances'), activations: tr('occurrences'), groups: tr('groups'), paths: tr('paths'), queue: tr('queue'),
    physicalWait: tr('physicalWait'), branchPaths: tr('branchPaths'), physicalEvidenceRequired: tr('physicalActive'), unnamed: tr('unknown'),
    phase: (value: string) => tr(`phase.${knownPhase(value)}`), selector: (value: string) => tr(`selector.${['shared', 'named', 'new'].includes(value) ? value : 'unknown'}`) };
  return <section aria-label={tr('monitor')} className="min-h-0 min-w-0 flex-1 space-y-3 overflow-auto p-3 text-xs text-foreground">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">{tr('monitor')}</h2>
      <button type="button" className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={refresh}>{tr('refresh')}</button></div>
    {readFailed && <p role="alert">{tr('readFailed')}</p>}
    <RunHistory030 history={snapshot.history} selected={selected} comparison={comparison} select={id => { setExplicit(id); if (comparison === id) setComparison(undefined); }} compare={setComparison} />
    {!selected && history.length > 0 && <p role="status">{tr('selectionPending')}</p>}
    {left && right && <RunCaptureComparison030 left={left} right={right} />}
    {selected && !inspection && <p role="status">{tr(readState?.kind === 'unavailable' ? 'unavailable' : 'loading')}</p>}
    {inspection && state && <>
      {stale && <p role="status" className="rounded border border-border p-2">{tr('stale')}</p>}
      <section className="space-y-1 rounded border border-border p-2" aria-label={tr('summary')}>
        <h3 className="font-medium">{tr(`verdict.${state.verdict ?? 'pending'}`)}</h3>
        <p>{tr('stopLabel')}: {state.stop.kind === 'available' ? tr(`stop.${state.stop.value.kind}`) : tr('unavailable')}</p>
        <p>{tr('physicalPending')}: {state.physicalPending}</p>
        <p>{tr('owner')}: {tr(`ownerState.${state.ownerStatus}`)}</p>
        {state.humans.kind === 'ready' ? state.humans.value.some(request => request.state.kind === 'open') && <p>{tr('waitingHuman')}</p> : <p>{tr('humanUnknown')}</p>}
        {renderHumans?.(inspection)}
        {state.uncertainties.kind === 'available' ? state.uncertainties.value.map(item => <details key={item.id}><summary>{tr(`uncertainty.${item.state}`)}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(item, null, 2)}</pre></details>) : <p>{tr('uncertaintyUnavailable')}</p>}
        <details><summary>{tr('captureDetails')}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ source: inspection.capture.source, versions: inspection.capture.versions, chronology: state.chronology, stop: state.stop }, null, 2)}</pre></details>
        <ExactContent label={tr('capturedSource')} value={inspection.capture.authoredSource} />
        {currentSource !== undefined && <ExactContent label={tr('currentDocument')} value={currentSource} />}
      </section>
      <RunInspector030 inspection={inspection} selectedStepId={selection.step} selectedOccurrenceKey={selection.occurrence}
        selectStep={step => choose({ step, occurrence: undefined })} selectOccurrence={occurrence => choose({ occurrence })} renderGraph={renderGraph} />
      <details><summary>{tr('runtimeDetails')}</summary>
        {occurrences === null || state.occurrences.kind !== 'ready' || state.occurrences.revision !== state.revision ? <p>{tr('incomplete')}</p> : <RuntimeProjectionView030
          page={{ scope: state.scope, revision: state.revision, flowInvocationId: state.flowInvocationId, stopping: state.stopping, verdict: state.verdict,
            total: String(state.instances.length + occurrences.length + state.groups.length + state.paths.length), nextPage: null,
            items: [...state.instances.map(value => ({ kind: 'instance' as const, value })), ...occurrences.map(item => ({ kind: 'activation' as const, value: item.activation })),
              ...state.groups.map(value => ({ kind: 'group' as const, value })), ...state.paths.map(value => ({ kind: 'path' as const, value }))] }}
          labels={runtimeLabels} selected={selection.runtime} select={runtime => {
            const occurrence = runtime.kind === 'activation' ? occurrences.find(item => item.activation.id === runtime.id) : undefined;
            choose({ runtime, ...(occurrence ? { occurrence: runOccurrenceKey030(occurrence), step: undefined } : {}) });
          }} />}
      </details>
    </>}
  </section>;
}
