import { Messages030 } from './Messages030';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { RunHumanOccurrence030 } from '../../types/agsdlRunUi030';
import type { RunInspection030, RunInspectionAccess030 } from '../../services/agsdl/runtimeProjection030';
import { initialRunSelection030, retainedRunValue030 } from '../../services/agsdl/runtimeProjection030';
import { runOccurrenceKey030, runCaptureKey030 } from '../../services/agsdl/runGraphProjection030';
import { RunHistory030, RunCaptureComparison030 } from './RunHistory030';
import { RunInspector030, ExactContent, knownPhase, type RunGraphBridge030 } from './RunInspector030';
import { RuntimeProjectionView030, type RuntimeSelection030 } from './RuntimeProjectionView030';
import { useAgsdlTranslation } from './useAgsdlTranslation';

export interface ExecutionMonitorProps030 {
  readonly canvas?: ReactNode;
  readonly controls?: ReactNode;
  readonly capturedControls?: ReactNode;
  readonly projectPicker?: ReactNode;
  readonly access: RunInspectionAccess030;
  readonly initialRunId?: string;
  /** Keep the requested run selected even when it is absent from history. */
  readonly exactInitialRun?: boolean;
  readonly initialInstanceId?: string;
  readonly taskStale?: boolean;
  readonly onSelection?: (id: string | undefined, active: boolean, viewingRun: boolean) => void;
  readonly currentSource?: string;
  readonly renderGraph?: (bridge: RunGraphBridge030) => ReactNode;
  /** Observation only, never a scheduler. Zero disables periodic readback. */
  readonly refreshIntervalMs?: number;
  readonly renderHumans?: (inspection: RunInspection030, pendingOnly: boolean, readOnly: boolean, openOccurrence: (activation: Extract<RunHumanOccurrence030['activation'], { kind: 'available' }>) => void, instanceActivationIds?: ReadonlySet<string>) => ReactNode;
  readonly openRun?: () => void;
}
function retainedInspection(read: ReturnType<RunInspectionAccess030['getSnapshot']>['runs'][string]) { return retainedRunValue030(read); }

/** Scope changes detach all local selections. Opening only performs readback. */
export function ExecutionMonitor030(props: ExecutionMonitorProps030) {
  return <ScopedMonitor030 key={props.access.scopeKey} {...props} />;
}
function ScopedMonitor030({ canvas, controls, capturedControls, projectPicker, access, initialRunId, exactInitialRun, initialInstanceId, taskStale, onSelection, currentSource, renderGraph, refreshIntervalMs = 5000, renderHumans, openRun }: ExecutionMonitorProps030) {
  const { t } = useAgsdlTranslation();
  const tr = (key: string) => t(`agsdl.run030.${key}`);
  const subscribe = useCallback((listener: () => void) => access.subscribe(listener), [access]);
  const getSnapshot = useCallback(() => access.getSnapshot(), [access]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [design, setDesign] = useState(!initialRunId);
  const [explicit, setExplicit] = useState(initialRunId);
  const [automatic, setAutomatic] = useState<string>();
  const preferred = explicit ?? automatic;
  const selected = initialInstanceId || (exactInitialRun && preferred === initialRunId) ? initialRunId : snapshot.history.kind === 'ready' ? initialRunSelection030(snapshot, preferred)
    : preferred ?? initialRunSelection030(snapshot);
  useEffect(() => { if (initialRunId) { setExplicit(initialRunId); setDesign(false); } }, [initialRunId]);
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
  const initialInstance = selected === initialRunId ? inspection?.state.instances.find(item => item.id === initialInstanceId) : undefined;
  const selection = selections[identity] ?? { runtime: initialInstance ? { kind: 'instance' as const, id: initialInstance.id } : undefined };
  const choose = (value: Partial<typeof selection>) => setSelections(previous => ({ ...previous, [identity]: { ...previous[identity], ...value } }));
  const left = history.find(run => run.scope.systemStartId === selected);
  const right = history.find(run => run.scope.systemStartId === comparison);
  // An intent read can fail after a fresh inspection or history is published.
  // Action availability follows the published facts, independently of that alert.
  const stale = !!taskStale || readState?.kind === 'stale' || readState?.kind === 'loading' ||
    snapshot.history.kind === 'stale' || snapshot.history.kind === 'loading';
  const state = inspection?.state;
  const interrupted = !!left?.interruptedAt || state?.verdict === 'interrupted';
  const active = !!state && (state.verdict === null || state.physicalPending !== '0');
  useEffect(() => { onSelection?.(selected, active, !design); }, [onSelection, selected, active, design]);
  const occurrences = state ? retainedRunValue030(state.occurrences) : null;
  const instanceOccurrences = initialInstance && state?.occurrences.kind === 'ready' && state.occurrences.revision === state.revision
    ? state.occurrences.value.filter(item => item.activation.instanceId === initialInstance.id && runCaptureKey030(item.scope) === identity)
    : undefined;
  const [instanceDetailsOpen, setInstanceDetailsOpen] = useState(true);
  const openOccurrence = (activation: Extract<RunHumanOccurrence030['activation'], { kind: 'available' }>) => {
    if (!inspection || runCaptureKey030(activation.scope) !== identity) return;
    const candidates = initialInstanceId ? instanceOccurrences : occurrences;
    const occurrence = candidates?.find(item => item.activation.id === activation.activationId && runCaptureKey030(item.scope) === identity);
    if (!occurrence) return;
    if (initialInstanceId) {
      if (stale) return;
      choose({ runtime: { kind: 'activation', id: occurrence.activation.id } });
      setInstanceDetailsOpen(true);
      return;
    }
    choose({ occurrence: runOccurrenceKey030(occurrence), step: undefined });
    setDesign(false);
    setDrawerOpen(true);
  };
  const runtimeLabels = { instances: tr('instances'), activations: tr('occurrences'), groups: tr('groups'), paths: tr('paths'), queue: tr('queue'),
    physicalWait: tr('physicalWait'), branchPaths: tr('branchPaths'), physicalEvidenceRequired: tr('physicalActive'), unnamed: tr('unknown'),
    phase: (value: string) => tr(`phase.${knownPhase(value)}`), selector: (value: string) => tr(`selector.${['shared', 'named', 'new'].includes(value) ? value : 'unknown'}`) };
  const inspectorProps = inspection ? { inspection, stale, refreshing: readState?.kind === 'loading', selectedStepId: selection.step, selectedOccurrenceKey: selection.occurrence,
    selectStep: (step: string | undefined) => { choose({ step, occurrence: undefined }); }, selectOccurrence: (occurrence: string) => choose({ occurrence }) } : undefined;
  const canvasMode = canvas !== undefined;
  if (initialInstanceId) return <section aria-label={tr('instance')} className="min-h-0 min-w-0 flex-1 space-y-3 overflow-auto p-3 text-xs text-foreground">
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className="break-words font-medium">{initialInstance?.agent ?? tr('instance')}</h2>
        {initialInstance && <p className="break-all text-muted-foreground">{initialInstance.selectorName ?? initialInstance.id}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={refresh}>{tr('refresh')}</button>
        {openRun && <button type="button" className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={openRun}>{tr('openRunInspector')}</button>}
      </div>
    </header>
    {readFailed && <p role="alert">{tr('readFailed')}</p>}
    {stale && <p role="status">{tr('stale')}</p>}
    {inspection && state && initialInstance ? <>
      <Messages030 key={JSON.stringify([identity, initialInstanceId])} instanceId={initialInstanceId} run={inspection} stale={stale} refresh={refresh} />
      {renderHumans?.(inspection, false, stale, openOccurrence, instanceOccurrences && new Set(instanceOccurrences.map(item => item.activation.id)))}
      <details open={instanceDetailsOpen} onToggle={event => {
        if (event.target === event.currentTarget) setInstanceDetailsOpen(event.currentTarget.open);
      }}><summary>{tr('instanceActivity')}</summary>
        {instanceOccurrences ? <RuntimeProjectionView030
          page={{ scope: state.scope, revision: state.revision, flowInvocationId: state.flowInvocationId, stopping: state.stopping, verdict: state.verdict,
            total: String(1 + instanceOccurrences.length), nextPage: null,
            items: [{ kind: 'instance', value: initialInstance }, ...instanceOccurrences.map(item => ({ kind: 'activation' as const, value: item.activation }))] }}
          labels={runtimeLabels} selected={selection.runtime} select={runtime => choose({ runtime })} /> : <p>{tr('incomplete')}</p>}
      </details>
    </> : <p role="status">{tr(readState?.kind === 'loading' ? 'loading' : 'unavailable')}</p>}
  </section>;
  return <section aria-label={tr('monitor')} className={canvasMode ? 'agsdl-canvas-shell' : 'min-h-0 min-w-0 flex-1 overflow-auto text-xs text-foreground'}>
    {canvasMode && <>
      {design || !inspectorProps ? canvas : <RunInspector030 {...inspectorProps} graphOnly renderGraph={value => <div className="agsdl-captured-graph" onDoubleClick={() => setDrawerOpen(true)}>{renderGraph?.({ ...value, inspect: () => setDrawerOpen(true) })}</div>} />}
      <div className="agsdl-launch-tools">{controls}{!design && capturedControls}{!design && <button className="agsdl-icon-button" title={t('agsdl.shell030.design')} aria-label={t('agsdl.shell030.design')} onClick={() => setDesign(true)}>↩</button>}</div>
      {inspection && <div className="agsdl-human-overlay">{renderHumans?.(inspection, true, stale, openOccurrence)}</div>}
      <button className="agsdl-runs-toggle" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(open => !open)}>{t('agsdl.canvas030.runs', { count: history.length })}</button>
    </>}
    <div hidden={canvasMode && !drawerOpen} className={canvasMode ? 'agsdl-runs-drawer' : 'space-y-3 p-3'}>
    {projectPicker}
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">{tr('monitor')}</h2>
      <button type="button" className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={refresh}>{tr('refresh')}</button></div>
    {readFailed && <p role="alert">{tr('readFailed')}</p>}
    <RunHistory030 history={snapshot.history} historyOrder={snapshot.historyOrder} runFailures={snapshot.runFailures} selected={selected} comparison={comparison} select={id => { setExplicit(id); setDesign(false); if (comparison === id) setComparison(undefined); }} compare={setComparison} />
    {!selected && history.length > 0 && <p role="status">{tr('selectionPending')}</p>}
    {left && right && <RunCaptureComparison030 left={left} right={right} />}
    {selected && !inspection && <p role="status">{tr(readState?.kind === 'error' ? 'readFailed' : readState?.kind === 'unavailable' ? 'unavailable' : 'loading')}</p>}
    {inspection && state && <>
      {stale && <p role="status" className="rounded border border-border p-2">{tr('stale')}</p>}
      <section className="space-y-1 rounded border border-border p-2" aria-label={tr('summary')}>
        <h3 className="font-medium">{interrupted ? t('agsdl.execution.interrupted030') : tr(`verdict.${state.verdict ?? 'pending'}`)}</h3>
        <p>{interrupted ? t('agsdl.execution.interrupted030') : [tr(`summarySentence.${state.verdict ?? 'pending'}`),
          ...(/^[1-9][0-9]*$/.test(state.physicalPending) ? [tr(state.stopping ? 'summarySentence.stopping' : 'summarySentence.active')] : []),
          ...(state.stop.kind === 'available' && state.stop.value.kind === 'uncertain' ? [tr('summarySentence.uncertain')] : []),
          ...(state.humans.kind === 'ready' && state.humans.value.some(request => request.state.kind === 'open') ? [tr('summarySentence.human')] : []),
        ].join(' ')}</p>
        {state.terminationUncertain && <p role="status">{tr('terminationUncertain')}</p>}
        <p>{tr('stopLabel')}: {state.stop.kind === 'available' ? tr(`stop.${state.stop.value.kind}`) : tr('unavailable')}</p>
        <p title={tr('physicalHelp')}>{tr('physicalPending')}: {state.physicalPending}</p>
        {state.modelOverrides && Object.entries(state.modelOverrides).map(([agent, model]) =>
          <p key={agent}>{t('agsdl.launch.replacementModel', { agent })} · {model.name}{model.effort && ' · ' + model.effort}</p>)}
        <p title={tr('ownerHelp')}>{tr('owner')}: {tr(`ownerState.${state.ownerStatus}`)}</p>
        <details><summary>{tr('termsHelp')}</summary><p>{tr('physicalHelp')}</p><p>{tr('ownerHelp')}</p><p>{tr('occurrenceHelp')}</p></details>
        {state.humans.kind === 'ready' ? state.humans.value.some(request => request.state.kind === 'open') && <p>{tr('waitingHuman')}</p> : <p>{tr('humanUnknown')}</p>}
        {renderHumans?.(inspection, false, stale, openOccurrence)}
        {state.uncertainties.kind === 'available' ? state.uncertainties.value.map(item => <details key={item.id}><summary>{tr(`uncertainty.${item.state}`)}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(item, null, 2)}</pre></details>) : <p>{tr('uncertaintyUnavailable')}</p>}
        <details><summary>{tr('captureDetails')}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ systemStartId: state.scope.systemStartId, snapshotId: state.scope.snapshotId, source: inspection.capture.source, versions: inspection.capture.versions, chronology: state.chronology, stop: state.stop }, null, 2)}</pre></details>
        <ExactContent label={tr('capturedSource')} value={inspection.capture.authoredSource} />
        {currentSource !== undefined && <ExactContent label={tr('currentDocument')} value={currentSource} />}
      </section>
      <Messages030 key={identity} run={inspection} stale={stale} refresh={refresh} />
      {inspectorProps && <RunInspector030 {...inspectorProps} renderGraph={canvasMode ? undefined : renderGraph} />}
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
    </div>
  </section>;
}
