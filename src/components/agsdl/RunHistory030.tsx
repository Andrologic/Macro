import type { NativeFact030, RunRead030 } from '../../types/agsdlRunUi030';
import { retainedRunValue030, type RunHistoryEntry030, type RunMonitorSnapshot030, type RunReadFailure030 } from '../../services/agsdl/runtimeProjection030';
import { useAgsdlTranslation } from './useAgsdlTranslation';

export function RunHistory030({ history, historyOrder, runFailures, selected, comparison, select, compare }: {
  history: RunRead030<readonly RunHistoryEntry030[]>; historyOrder: RunMonitorSnapshot030['historyOrder']; runFailures: RunMonitorSnapshot030['runFailures']; selected?: string; comparison?: string;
  select: (id: string) => void; compare: (id: string | undefined) => void;
}) {
  const { t } = useAgsdlTranslation();
  const tr = (key: string) => t(`agsdl.run030.${key}`);
  const captured = retainedRunValue030(history) ?? [];
  const byId = new Map(captured.map(run => [run.scope.systemStartId, run]));
  const runs = captured.filter(run => !Object.hasOwn(runFailures, run.scope.systemStartId));
  const failures = Object.entries(runFailures);
  const rows = [...new Set([...historyOrder, ...byId.keys(), ...Object.keys(runFailures)])]
    .filter(id => byId.has(id) || Object.hasOwn(runFailures, id));
  const failureReason = (failure: RunReadFailure030) => failure.code === 'STORAGE_UNCERTAIN' ? 'storageUncertain'
    : failure.kind === 'notFound' ? 'notFound' : failure.kind === 'uncertain' ? 'uncertain'
    : failure.kind === 'scope' ? 'scope' : failure.kind === 'conflict' ? 'conflict' : 'unavailable';
  const date = (fact: RunHistoryEntry030['chronology']) => fact.kind === 'available' ? fact.value.startedAt : tr('unknownDate');
  return <section aria-label={tr('history')} className="min-w-0 space-y-2">
    <h3 className="font-medium">{tr('history')}</h3>
    {history.kind === 'error' && <p role="alert">{tr('readFailed')}</p>}
    {history.kind !== 'ready' && history.kind !== 'error' && <p role="status">{tr(history.kind === 'stale' ? 'stale' : history.kind === 'loading' ? 'loading' : 'unavailable')}</p>}
    {history.kind === 'ready' && runs.length === 0 && failures.length === 0 && <p>{tr('noRuns')}</p>}
    <ul className="space-y-1">{rows.map(id => {
      const failure = Object.hasOwn(runFailures, id) ? runFailures[id] : undefined;
      if (failure) return <li key={id} data-run-id={id} data-run-read-state="failed" className="rounded border border-border px-2 py-1">
        <span className="block break-words">{id}</span>
        <p role="status" className="text-muted-foreground">{tr(`readFailure.${failureReason(failure)}`)}</p>
      </li>;
      const run = byId.get(id)!;
      return <li key={id} data-run-id={id}>
      <button type="button" aria-pressed={selected === run.scope.systemStartId} onClick={() => select(run.scope.systemStartId)}
        className="w-full rounded border border-border px-2 py-1 text-left hover:bg-accent aria-pressed:bg-accent">
        <span className="block break-words">{run.capture.systemStartId} · {tr(`verdict.${run.verdict ?? 'pending'}`)}</span>
        <span className="block text-muted-foreground">{date(run.chronology)} · {tr('physicalPending')}: {run.physicalPending}</span>
        {run.humans.kind === 'ready' ? run.humans.value.some(request => request.state.kind === 'open') && <span className="block">{tr('waitingHuman')}</span> : <span className="block">{tr('humanUnknown')}</span>}
      </button>
    </li>; })}</ul>
    {selected && !runs.some(run => run.scope.systemStartId === selected) && <p>{tr('retainedSelection')} · {selected}</p>}
    <label className="flex min-w-0 flex-col gap-1">{tr('compare')}
      <select className="min-w-0 max-w-full rounded border border-border bg-card p-1" value={comparison ?? ''} onChange={event => compare(event.target.value || undefined)}>
        <option value="">{tr('noComparison')}</option>
        {runs.filter(run => run.scope.systemStartId !== selected).map(run => <option key={run.scope.systemStartId} value={run.scope.systemStartId}>{run.scope.systemStartId}</option>)}
      </select>
    </label>
  </section>;
}

/** Compare immutable captures, never the document currently being edited. */
export function RunCaptureComparison030({ left, right }: { left: RunHistoryEntry030; right: RunHistoryEntry030 }) {
  const { t } = useAgsdlTranslation();
  const tr = (key: string) => t(`agsdl.run030.${key}`);
  const provenance = (fact: NativeFact030<{ startedAt: string; endedAt: string | null; provenanceJson: string }>) =>
    fact.kind === 'available' ? fact.value.provenanceJson : tr('unavailable');
  const rows = [
    [tr('sourceHash'), left.capture.source.sourceSha256, right.capture.source.sourceSha256],
    [tr('sourceRevision'), left.capture.source.revision, right.capture.source.revision],
    [tr('versions'), JSON.stringify(left.capture.versions), JSON.stringify(right.capture.versions)],
    [tr('provenance'), provenance(left.chronology), provenance(right.chronology)],
    [tr('date'), left.chronology.kind === 'available' ? left.chronology.value.startedAt : tr('unknownDate'), right.chronology.kind === 'available' ? right.chronology.value.startedAt : tr('unknownDate')],
  ];
  return <section aria-label={tr('comparison')} className="min-w-0 space-y-2 rounded border border-border p-2">
    <h3>{tr('comparison')} · {left.capture.systemStartId} / {right.capture.systemStartId}</h3>
    <p>{tr(left.capture.authoredSource === right.capture.authoredSource ? 'sameSource' : 'differentSource')}</p>
    <details><summary>{tr('captureDetails')}</summary>
      <dl>{rows.map(([label, a, b]) => <div key={label} className="my-2 break-words"><dt className="font-medium">{label}</dt><dd><pre className="whitespace-pre-wrap break-all">{a}</pre><pre className="whitespace-pre-wrap break-all">{b}</pre></dd></div>)}</dl>
      {[left, right].map(run => <details key={run.scope.systemStartId}><summary>{tr('capturedSource')} · {run.scope.systemStartId}</summary><pre className="whitespace-pre-wrap break-all">{run.capture.authoredSource}</pre></details>)}
    </details>
  </section>;
}
