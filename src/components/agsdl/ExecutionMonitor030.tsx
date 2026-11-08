import { useState } from 'react';
import type { AgsdlTarget } from '../../stores/useAgsdlStore';
import { useAgsdlExecutionStore } from '../../stores/useAgsdlExecutionStore';
import { useChatStore } from '../../stores/useChatStore';
import { humanRequestView030 } from '../../services/agsdl/humanRequests030';
import { ExecutionHumanRequest } from './ExecutionHumanRequest';
import { RuntimeProjectionView030, type RuntimeSelection030 } from './RuntimeProjectionView030';
import { useAgsdlTranslation } from './useAgsdlTranslation';

/** Read-only until native admission and human decisions are connected. */
export function ExecutionMonitor030({ target }: { target: AgsdlTarget }) {
  const { t } = useAgsdlTranslation();
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<{ capture: string; value: RuntimeSelection030 }>();
  const conversation = useChatStore(state => state.selectedConversationId);
  const view = useAgsdlExecutionStore();
  const inScope = view.owner?.planId === target.planId && view.owner.branch === target.branchName && view.conversationId === conversation;
  const runs = inScope ? view.runs030 : [];
  const labels = { choice: t('agsdl.execution.humanChoice'), comment: t('agsdl.execution.humanComment'), answer: t('agsdl.execution.humanAnswer'),
    submit: t('agsdl.execution.humanSend'), approve: t('agsdl.execution.approve'), reject: t('agsdl.execution.reject'), failed: t('agsdl.execution.error') };
  const runtime = inScope ? view.runtime030 : undefined;
  const capture = runtime ? JSON.stringify([runtime.scope.systemStartId, runtime.scope.snapshotId, runtime.revision]) : '';
  const runtimeLabels = { instances: t('agsdl.execution.runtimeInstances'), activations: t('agsdl.execution.runtimeActivations'),
    groups: t('agsdl.execution.runtimeGroups'), paths: t('agsdl.execution.runtimePaths'), physicalEvidenceRequired: t('agsdl.execution.runtimePhysical'),
    queue: t('agsdl.execution.runtimeQueue'), physicalWait: t('agsdl.execution.runtimePhysicalWait'), branchPaths: t('agsdl.execution.runtimeBranchPaths'),
    unnamed: t('agsdl.execution.runtimeUnnamed'), phase: (value: string) => t(`agsdl.execution.runtimePhase.${value}`, { defaultValue: t('agsdl.execution.runtimeUnknown') }),
    selector: (value: string) => t(value === 'shared' ? 'agsdl.execution.runtimeShared' : value === 'named' ? 'agsdl.execution.runtimeNamed' : value === 'new' ? 'agsdl.execution.runtimeNew' : 'agsdl.execution.runtimeUnknown') };
  return <section className="shrink-0 border-t border-border px-3 py-2 text-xs">
    <button type="button" aria-expanded={expanded} onClick={() => { const next = !expanded; setExpanded(next); if (next && conversation) void view.open030(target, conversation); }}>
      {t('agsdl.execution.monitor')}
    </button>
    {expanded && <div className="mt-2 max-h-64 overflow-auto">
      {!conversation ? <p>{t('agsdl.execution.firstMessageRequired')}</p> : <>
        {view.error && inScope && <p role="alert">{t(view.error)}</p>}
        {inScope && view.runs030Error && <p role="alert">{t('agsdl.execution.runsStale')}</p>}
        {inScope && view.intent030 && <p>{t('agsdl.execution.unavailable')}</p>}
        <label className="flex flex-col gap-1">{t('agsdl.execution.chooseRun')}
          <select className="rounded border border-border bg-card px-2 py-1 text-foreground" value={inScope ? view.snapshot030?.systemStartId ?? '' : ''} disabled={!inScope || view.busy} onChange={event => { if (event.target.value) void view.select030(event.target.value); }}>
            <option value="">{t('agsdl.execution.chooseRun')}</option>
            {inScope && view.snapshot030 && !runs.some(run => run.systemStartId === view.snapshot030!.systemStartId) && <option value={view.snapshot030.systemStartId}>{t('agsdl.journey.captured')}</option>}
            {runs.map((run, index) => <option value={run.systemStartId} key={run.systemStartId}>{t('agsdl.execution.runNumber', { number: index + 1 })}</option>)}
          </select>
        </label>
        {inScope && <button type="button" onClick={() => void view.refreshRuns030()} disabled={view.busy}>{t('agsdl.execution.runtimeRefresh')}</button>}
        {inScope && view.nextRuns030 && <button type="button" onClick={() => void view.moreRuns030()} disabled={view.busy}>{t('agsdl.execution.moreRuns')}</button>}
        {inScope && view.snapshot030 && <section>
          <button type="button" onClick={() => void view.refreshRuntime030()} disabled={view.busy}>{t('agsdl.execution.runtimeRefresh')}</button>
          {view.runtime030Stale && <p role="alert">{t('agsdl.execution.runtimeStale')}</p>}
          {runtime && <RuntimeProjectionView030 page={runtime} labels={runtimeLabels} selected={selection?.capture === capture ? selection.value : undefined}
            select={value => setSelection({ capture, value })} />}
          <h3>{t('agsdl.execution.humanRequests')}</h3>
          <p>{t('agsdl.execution.humanIncomplete')}</p>
          <p>{t('agsdl.execution.humanUnavailable')}</p>
          {view.humans030Stale && <p role="alert">{t('agsdl.execution.humanStale')}</p>}
          <button type="button" onClick={() => void view.refreshHumans030()} disabled={view.busy}>{t('agsdl.execution.refreshHumans')}</button>
          {view.humans030?.requests.map(request => <div key={`${view.snapshot030!.systemStartId}:${request.id}`}>
            {['open', 'submitted', 'resolved'].includes(request.status) && <p className="text-muted-foreground">{t(request.status === 'open' ? 'agsdl.execution.humanOpen' : request.status === 'submitted' ? 'agsdl.execution.humanSubmitted' : 'agsdl.execution.humanResolved')}</p>}
            {request.content.kind === 'question' ? <div className="my-2 rounded border border-border p-2">
              <h3 className="font-medium">{t('agsdl.execution.humanQuestion')}</h3>
              <p className="whitespace-pre-wrap break-words">{request.content.question}</p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">{request.content.expectedResponse}</p>
            </div> : <ExecutionHumanRequest request={humanRequestView030(request, { plan: t('agsdl.execution.humanPlan'), question: t('agsdl.execution.humanQuestion') })}
              labels={labels} open={false} onAnswer={async () => { throw new Error('Decision unavailable'); }} />}
          </div>)}
        </section>}
      </>}
    </div>}
  </section>;
}
