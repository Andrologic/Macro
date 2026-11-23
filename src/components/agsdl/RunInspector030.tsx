import { useMemo, type ReactNode } from 'react';
import type { RunRead030, RunOccurrence030 } from '../../types/agsdlRunUi030';
import type { RunInspection030 } from '../../services/agsdl/runtimeProjection030';
import { retainedRunValue030 } from '../../services/agsdl/runtimeProjection030';
import { projectStaticSemantics030 } from '../../services/agsdl/staticSemantics030';
import { runEffectFacts030, runGraphReadState030, runStepLabels030, normalRunOutcome030, commandResult030, callFailure030, occurrenceOutput030, runCaptureKey030, projectRunGraph030, type RunGraphOccurrence030 } from '../../services/agsdl/runGraphProjection030';
import { useAgsdlTranslation } from './useAgsdlTranslation';

/** The shell canvas consumes this bridge without replacing static or native ids. */
export interface RunGraphBridge030 {
  readonly inspect?: () => void;
  readonly capture: RunInspection030['capture'];
  readonly occurrences: readonly RunGraphOccurrence030[];
  readonly occurrenceRead: ReturnType<typeof runGraphReadState030> & { readonly projectionAvailable: boolean };
  readonly selectedStepId?: string;
  readonly selectedOccurrenceKey?: string;
  selectStep(id: string | undefined): void;
  selectOccurrence(key: string): void;
}
export function RunInspector030({ inspection, selectedStepId, selectedOccurrenceKey, selectStep, selectOccurrence, renderGraph, graphOnly = false, stale = false, refreshing = false }: {
  inspection: RunInspection030; stale?: boolean; refreshing?: boolean; selectedStepId?: string; selectedOccurrenceKey?: string;
  selectStep: (id: string | undefined) => void; selectOccurrence: (key: string) => void;
  graphOnly?: boolean;
  renderGraph?: (bridge: RunGraphBridge030) => ReactNode;
}) {
  const { t } = useAgsdlTranslation();
  const tr = (key: string) => t(`agsdl.run030.${key}`);
  const { capture, state } = inspection;
  const semantics = useMemo(() => {
    try { return projectStaticSemantics030(capture.authoredSource); } catch { return null; }
  }, [capture.authoredSource]);
  const stepLabels = useMemo(() => semantics ? runStepLabels030(capture.authoredSource, semantics) : new Map<string, string>(), [semantics, capture.authoredSource]);
  const raw = retainedRunValue030(state.occurrences);
  const graph = useMemo(() => semantics ? projectRunGraph030(state.scope, semantics, raw ?? []) : [], [semantics, state.scope, raw]);
  const selectVisit = (key: string) => {
    const item = graph.find(occurrence => occurrence.key === key);
    if (!item) return;
    selectStep(item.staticOccurrenceId ?? undefined);
    selectOccurrence(key);
  };
  const visitLabel = (item: RunGraphOccurrence030) => (item.staticOccurrenceId && stepLabels.get(item.staticOccurrenceId)) || item.occurrence.activation.step?.join(' / ') || item.occurrence.activation.agent || tr('externalWork');
  const stepLabel = (address: readonly string[]) => {
    const step = semantics?.occurrences.find(item => item.address !== null && JSON.stringify(item.address) === JSON.stringify(address));
    return (step && stepLabels.get(step.occurrenceId)) || address.join(' / ');
  };
  const selected = graph.find(item => item.key === selectedOccurrenceKey);
  const visible = selectedStepId ? graph.filter(item => item.staticOccurrenceId === selectedStepId) : graph;
  const steps = semantics?.occurrences.filter(item => item.address !== null) ?? [];
  const button = 'w-full rounded border border-border px-2 py-1 text-left hover:bg-accent aria-pressed:bg-accent';
  const status = <T,>(read: RunRead030<T>) => read.kind !== 'ready' && <p role="status">{tr(read.kind === 'stale' ? 'stale' : read.kind === 'loading' ? 'incomplete' : 'unavailable')}</p>;
  const details = selected?.occurrence.details;
  const activation = selected?.occurrence.activation;
  const normalOutcome = selected ? normalRunOutcome030(selected.occurrence) : null;
  const callFailure = selected ? callFailure030(selected.occurrence) : null;
  const callOutput = selected?.occurrence.activation.callResultJson ? occurrenceOutput030(selected.occurrence) : null;
  const command = selected ? commandResult030(selected.occurrence) : null;
  const diagnostics = retainedRunValue030(state.diagnostics);
  const visibleDiagnostics = diagnostics?.filter(diagnostic => !selected || diagnostic.activationId === selected.activationId || !graph.some(item => item.activationId === diagnostic.activationId));
  const humans = retainedRunValue030(state.humans);
  const openHumans = humans?.filter(request => request.state.kind === 'open') ?? [];
  const canvas = renderGraph?.({ capture, occurrences: graph, occurrenceRead: { ...runGraphReadState030(state.occurrences, stale, refreshing), projectionAvailable: semantics !== null }, selectedStepId, selectedOccurrenceKey, selectStep, selectOccurrence: selectVisit });
  if (graphOnly) return <div className="agsdl-run-canvas">{canvas}</div>;
  return <section aria-label={tr('inspector')} className="min-w-0 space-y-3">
    {canvas}
    {(state.humans.kind !== 'ready' || openHumans.length > 0) && <section><h3 className="font-medium">{tr('humanWaits')}</h3>{status(state.humans)}
      {openHumans.map(request => <div key={request.id}>
        {request.occurrences.map(mapping => {
          const fact = mapping.activation;
          const occurrence = fact.kind === 'available' && runCaptureKey030(fact.scope) === runCaptureKey030(state.scope)
            ? graph.find(item => item.activationId === fact.activationId) : undefined;
          return <div key={mapping.workId}>{occurrence ? <button type="button" className={button} onClick={() => selectVisit(occurrence.key)}>
            {tr('waitingHuman')} · {visitLabel(occurrence)}
          </button> : <p>{tr('mappingUnavailable')}</p>}</div>;
        })}
      </div>)}
    </section>}
    <section><h3 className="font-medium">{tr('steps')}</h3>
      {!semantics && <p>{tr('unavailable')}</p>}
      <div className="grid gap-1">{steps.map(step => <button type="button" className={button} key={step.occurrenceId}
        aria-pressed={selectedStepId === step.occurrenceId} onClick={() => selectStep(step.occurrenceId)}>
        {stepLabels.get(step.occurrenceId)} · {state.occurrences.kind === 'ready' ? t('agsdl.run030.occurrenceCount', { count: graph.filter(item => item.staticOccurrenceId === step.occurrenceId).length }) : tr(state.occurrences.kind === 'stale' ? 'staleShort' : 'loading')}
      </button>)}</div>
    </section>
    <section><h3 className="font-medium" title={tr('occurrenceHelp')}>{tr('occurrences')}</h3>{status(state.occurrences)}
      <ol className="space-y-1">{visible.map(item => <li key={item.key}><button type="button" className={button} aria-pressed={selectedOccurrenceKey === item.key} onClick={() => selectVisit(item.key)}>
        {visitLabel(item)}
        {' · '}{tr(`phase.${knownPhase(item.occurrence.activation.phase)}`)}
        {item.occurrence.details.kind === 'available' && item.occurrence.details.value.visit !== null && <span> · {tr('visit')} {item.occurrence.details.value.visit}</span>}
        {item.occurrence.activation.nearestFanoutIndex !== null && <span> · {tr('item')} {item.occurrence.activation.nearestFanoutIndex}</span>}
      </button></li>)}</ol>
      {state.occurrences.kind === 'ready' && visible.length === 0 && <p>{tr('noOccurrences')}</p>}
    </section>
    {activation && <section className="space-y-2 rounded border border-border p-2">
      <h3 className="font-medium">{selected ? visitLabel(selected) : tr('externalWork')}</h3>
      <p>{tr(`phase.${knownPhase(activation.phase)}`)}</p>
      {normalOutcome && <p>{tr(`outcome.${normalOutcome}`)}</p>}
      {command && <div className="space-y-1">
        <p>{tr('commandExitCode')}: {command.exitCode}</p>
        <p>{tr('commandOutput')}</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{command.output || tr('noContent')}</pre>
      </div>}
      {callFailure && <p role="status">{tr(`diagnosticCode.${['CALL_FAILED', 'TIMEOUT', 'OUTPUT_INVALID'].includes(callFailure.code) ? callFailure.code : 'other'}`)} · {callFailure.code}: {callFailure.message}</p>}
      {callOutput !== null && !command && <ExactContent label={tr('result')} value={callOutput} />}
      {activation.physical && <p>{tr('physicalActive')}</p>}
      {details?.kind === 'available' ? <>
        {!details.value.countsForFlow && <p>{tr('notCounting')}</p>}
        <ExactContent label={tr('receivedMessage')} value={details.value.receivedMessageJson} />
        <ExactContent label={tr('sender')} value={details.value.senderJson} />
        <ExactContent label={tr('result')} value={details.value.outputJson} />
      </> : !activation.callResultJson && <p>{tr('detailsUnavailable')}</p>}
      <details><summary>{tr('technicalDetails')}</summary>
        <pre className="whitespace-pre-wrap break-all">{JSON.stringify({ activation, details }, null, 2)}</pre>
      </details>
    </section>}
    <section><h3 className="font-medium">{tr('diagnostics')}</h3>{status(state.diagnostics)}
      {selected && <p>{tr('selectedDiagnostics')}</p>}
      {visibleDiagnostics?.map(diagnostic => {
        const attached = diagnostic.activationId === null ? undefined : graph.find(item => item.activationId === diagnostic.activationId);
        const cause = diagnostic.causeId === null ? undefined : diagnostics?.find(item => item.id === diagnostic.causeId);
        const causeOccurrence = cause?.activationId ? graph.find(item => item.activationId === cause.activationId) : undefined;
        const effects = diagnostic.effectsJson.kind === 'available' ? runEffectFacts030(diagnostic.effectsJson.value) : null;
        return <article key={diagnostic.id} data-diagnostic-id={diagnostic.id} className="my-1 space-y-1 rounded border border-border p-2">
          {attached ? <>
            <button type="button" className={button} onClick={() => selectVisit(attached.key)}>
              {tr('inspectOccurrence')} · {visitLabel(attached)} · {tr('visit')} {attached.occurrence.details.kind === 'available' ? attached.occurrence.details.value.visit ?? tr('unknown') : tr('unknown')}
            </button>
            <p className="break-all">{tr('activation')}: {attached.activationId}</p>
          </> : <p>{tr('runLevelDiagnostic')}</p>}
          {diagnostic.step && <p>{tr('diagnosticStep')}: {diagnostic.step.join(' / ')}</p>}
          <p>{tr(`disposition.${diagnostic.disposition}`)}</p>
          <p>{tr(`diagnosticCode.${['CALL_FAILED', 'TIMEOUT', 'BRANCH_FAILED', 'OUTPUT_INVALID'].includes(diagnostic.code) ? diagnostic.code : 'other'}`)}</p>
          <p className="break-words">{diagnostic.message}</p>
          <div><span>{tr('cause')}: </span>{diagnostic.causeId === null ? tr('notReported') : <>
            <span className="break-words">{cause ? cause.message : diagnostic.causeId}</span>
            {causeOccurrence && <button type="button" className={button} onClick={() => selectVisit(causeOccurrence.key)}>{tr('inspectCause')} · {visitLabel(causeOccurrence)}</button>}
          </>}</div>
          <p>{tr('handler')}: {diagnostic.handlerStep ? stepLabel(diagnostic.handlerStep) : tr('notReported')}</p>
          <div><h4>{tr('effects')}</h4>{effects === null ? <p>{tr('unavailable')}</p> : effects.length === 0 ? <p>{tr('noKnownEffects')}</p> :
            <dl>{effects.map(fact => <div key={fact.kind} className="break-words">
              <dt>{tr(`effectLabel.${fact.kind}`)}</dt>
              <dd>{fact.kind === 'filesWritten' ? fact.files.length === 0 ? tr('noReportedItems') : <ul>{fact.files.map((file, index) => <li key={index}>{file}</li>)}</ul>
                : tr(fact.value ? 'effectWorkContinues' : 'effectWorkDoesNotContinue')}</dd>
            </div>)}</dl>}</div>
          <details><summary>{tr('technicalDetails')}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(diagnostic, null, 2)}</pre></details>
        </article>;
      })}
      {state.diagnostics.kind === 'ready' && visibleDiagnostics?.length === 0 && <p>{tr('noDiagnostics')}</p>}
    </section>
  </section>;
}

export function ExactContent({ label, value }: { label: string; value: string | null }) {
  const { t } = useAgsdlTranslation();
  return <details><summary>{label}</summary>{value === null ? <p>{t('agsdl.run030.noContent')}</p> : <pre className="whitespace-pre-wrap break-all">{value}</pre>}</details>;
}

/** Unknown native phases stay exact in advanced data; never imply success. */
export function knownPhase(value: RunOccurrence030['activation']['phase']): string {
  return ['ready', 'stopping', 'done', 'pending', 'preparing', 'steering', 'withdrawingSteer', 'barrier', 'body', 'group', 'escaped', 'excluded', 'withdrawn', 'queued', 'running', 'completed', 'succeeded', 'failed', 'cancelled', 'waiting', 'live', 'ended', 'idle', 'absorbed'].includes(value) ? value : 'unknown';
}
