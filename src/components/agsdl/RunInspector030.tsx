import { useMemo, type ReactNode } from 'react';
import type { RunRead030, RunOccurrence030 } from '../../types/agsdlRunUi030';
import type { RunInspection030 } from '../../services/agsdl/runtimeProjection030';
import { retainedRunValue030 } from '../../services/agsdl/runtimeProjection030';
import { projectStaticSemantics030 } from '../../services/agsdl/staticSemantics030';
import { runStepLabels030, normalRunOutcome030, runCaptureKey030, projectRunGraph030, type RunGraphOccurrence030 } from '../../services/agsdl/runGraphProjection030';
import { useAgsdlTranslation } from './useAgsdlTranslation';

/** The shell canvas consumes this bridge without replacing static or native ids. */
export interface RunGraphBridge030 {
  readonly capture: RunInspection030['capture'];
  readonly occurrences: readonly RunGraphOccurrence030[];
  readonly selectedStepId?: string;
  readonly selectedOccurrenceKey?: string;
  selectStep(id: string): void;
  selectOccurrence(key: string): void;
}
export function RunInspector030({ inspection, selectedStepId, selectedOccurrenceKey, selectStep, selectOccurrence, renderGraph }: {
  inspection: RunInspection030; selectedStepId?: string; selectedOccurrenceKey?: string;
  selectStep: (id: string) => void; selectOccurrence: (key: string) => void;
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
    if (item?.staticOccurrenceId) selectStep(item.staticOccurrenceId);
    selectOccurrence(key);
  };
  const visitLabel = (item: RunGraphOccurrence030) => (item.staticOccurrenceId && stepLabels.get(item.staticOccurrenceId)) || item.occurrence.activation.step?.join(' / ') || item.occurrence.activation.agent || tr('externalWork');
  const selected = graph.find(item => item.key === selectedOccurrenceKey);
  const visible = selectedStepId ? graph.filter(item => item.staticOccurrenceId === selectedStepId) : graph;
  const steps = semantics?.occurrences.filter(item => item.address !== null) ?? [];
  const button = 'w-full rounded border border-border px-2 py-1 text-left hover:bg-accent aria-pressed:bg-accent';
  const status = <T,>(read: RunRead030<T>) => read.kind !== 'ready' && <p role="status">{tr(read.kind === 'stale' ? 'stale' : read.kind === 'loading' ? 'incomplete' : 'unavailable')}</p>;
  const details = selected?.occurrence.details;
  const activation = selected?.occurrence.activation;
  const normalOutcome = selected ? normalRunOutcome030(selected.occurrence) : null;
  const diagnostics = retainedRunValue030(state.diagnostics);
  const humans = retainedRunValue030(state.humans);
  const openHumans = humans?.filter(request => request.state.kind === 'open') ?? [];
  return <section aria-label={tr('inspector')} className="min-w-0 space-y-3">
    {renderGraph?.({ capture, occurrences: graph, selectedStepId, selectedOccurrenceKey, selectStep, selectOccurrence: selectVisit })}
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
    <section><h3 className="font-medium">{tr('occurrences')}</h3>{status(state.occurrences)}
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
      {activation.physical && <p>{tr('physicalActive')}</p>}
      {details?.kind === 'available' ? <>
        {!details.value.countsForFlow && <p>{tr('notCounting')}</p>}
        <ExactContent label={tr('receivedMessage')} value={details.value.receivedMessageJson} />
        <ExactContent label={tr('sender')} value={details.value.senderJson} />
        <ExactContent label={tr('result')} value={details.value.outputJson} />
      </> : <p>{tr('detailsUnavailable')}</p>}
      <details><summary>{tr('technicalDetails')}</summary>
        <pre className="whitespace-pre-wrap break-all">{JSON.stringify({ activation, details }, null, 2)}</pre>
      </details>
    </section>}
    <section><h3 className="font-medium">{tr('diagnostics')}</h3>{status(state.diagnostics)}
      {diagnostics?.map(diagnostic => <article key={diagnostic.id} className="my-1 rounded border border-border p-2">
        <p>{tr(`disposition.${diagnostic.disposition}`)}</p>
        <p>{tr(`diagnosticCode.${['CALL_FAILED', 'TIMEOUT', 'BRANCH_FAILED', 'OUTPUT_INVALID'].includes(diagnostic.code) ? diagnostic.code : 'other'}`)}</p>
        <p className="break-words">{diagnostic.message}</p>
        <details><summary>{tr('technicalDetails')}</summary>
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(diagnostic, null, 2)}</pre>
        </details>
        {diagnostic.effectsJson.kind === 'available' && <ExactContent label={tr('effects')} value={diagnostic.effectsJson.value} />}
      </article>)}
      {state.diagnostics.kind === 'ready' && diagnostics?.length === 0 && <p>{tr('noDiagnostics')}</p>}
    </section>
  </section>;
}

export function ExactContent({ label, value }: { label: string; value: string | null }) {
  const { t } = useAgsdlTranslation();
  return <details><summary>{label}</summary>{value === null ? <p>{t('agsdl.run030.noContent')}</p> : <pre className="whitespace-pre-wrap break-all">{value}</pre>}</details>;
}

/** Unknown native phases stay exact in advanced data; never imply success. */
export function knownPhase(value: RunOccurrence030['activation']['phase']): string {
  return ['ready', 'stopping', 'done', 'pending', 'preparing', 'barrier', 'body', 'group', 'escaped', 'excluded', 'withdrawn', 'queued', 'running', 'completed', 'succeeded', 'failed', 'cancelled', 'waiting', 'live', 'ended', 'idle', 'absorbed'].includes(value) ? value : 'unknown';
}
