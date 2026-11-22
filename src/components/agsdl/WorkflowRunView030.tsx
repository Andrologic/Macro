import { Maximize2, X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { CapturedRunGraph030 } from "./CapturedRunGraph030";
import { ExecutionMonitor030, type ExecutionMonitorProps030 } from "./ExecutionMonitor030";
import { HumanRequests030 } from "./HumanRequests030";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030, openWorkflowRun030,
  type WorkflowRunAccess030, type WorkflowRunTarget030 } from "../../services/workflowAgentTasks";
import { retainedRunValue030 } from "../../services/agsdl/runtimeProjection030";
import { runCaptureKey030 } from "../../services/agsdl/runGraphProjection030";
import { sameHumanScope030 } from "../../services/agsdl/humanRequests030";
import type { RunHumanOccurrence030, RunHumanRequest030 } from "../../types/agsdlRunUi030";

/** Shared dedicated view. An exact notification target never falls back to another run. */
export function WorkflowRunView030({ bundle, currentSource, target, initialInstanceId, initialRunId, taskStale, onSelection, canvas, controls, projectPicker, onExpand, expanded }: {
  expanded?: boolean; canvas?: ReactNode; controls?: ReactNode; projectPicker?: ReactNode; onExpand?: () => void;
  bundle: WorkflowRunAccess030; currentSource?: string; target?: WorkflowRunTarget030; initialInstanceId?: string; initialRunId?: string; taskStale?: boolean; onSelection?: (id: string | undefined, active: boolean, viewingRun: boolean) => void;
}) {
  const { t } = useAgsdlTranslation();
  const host = useRef<HTMLDivElement>(null);
  const { access } = bundle;
  const registry = useSyncExternalStore(subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030, workflowRunAccessSnapshot030);
  const focusedTarget = useRef<string>(undefined);
  const snapshot = useSyncExternalStore(access.subscribe.bind(access), access.getSnapshot.bind(access), access.getSnapshot.bind(access));
  const targetRunId = target?.scope.systemStartId;
  useEffect(() => {
    if (targetRunId) { void access.refreshHistory().catch(() => {}); void access.refreshRun(targetRunId).catch(() => {}); }
  }, [access, targetRunId]);
  const read = target && snapshot.runs[target.scope.systemStartId];
  const inspection = read ? retainedRunValue030(read) : null;
  const exact = !target || (inspection && sameHumanScope030(inspection.capture, target.scope) &&
    sameHumanScope030(inspection.state.scope, target.scope) &&
    (!initialInstanceId || inspection.state.instances.some(instance => instance.id === initialInstanceId)));
  const focusKey = target?.requestId ? JSON.stringify([target.scope, target.requestId]) : undefined;
  const requestVisible = !!target && !!inspection && retainedRunValue030(inspection.state.humans)?.some(request =>
    request.id === target.requestId && sameHumanScope030(request.scope, target.scope));
  useEffect(() => {
    if (!exact || !focusKey || !requestVisible || focusedTarget.current === focusKey) return;
    const card = [...(host.current?.querySelectorAll<HTMLElement>('[data-human-request]') ?? [])].find(item => item.dataset.humanRequest === target?.requestId);
    if (!card) return;
    const frame = window.requestAnimationFrame(() => { focusedTarget.current = focusKey; card.focus(); card?.scrollIntoView?.({ block: 'nearest' }); });
    return () => window.cancelAnimationFrame(frame);
  }, [exact, focusKey, requestVisible, target?.requestId]);
  const registration = registry.find(item => item.access === access);
  const humans: NonNullable<ExecutionMonitorProps030["renderHumans"]> = (run, pendingOnly, readOnly, openOccurrence, instanceActivationIds) => {
    const humanClient = bundle.humanClient ?? bundle.humanClientForRun?.(run);
    const requests = run.state.humans;
    const items = retainedRunValue030(requests) ?? [];
    const runScope = run.state.scope;
    const captureKey = runCaptureKey030(runScope);
    const belongsToInstance = ({ activation }: RunHumanOccurrence030) => activation.kind === 'available' &&
      runCaptureKey030(activation.scope) === captureKey && !!instanceActivationIds?.has(activation.activationId);
    const showRequest = (request: RunHumanRequest030) => sameHumanScope030(request.scope, runScope) &&
      (!initialInstanceId || request.occurrences.some(belongsToInstance));
    const occurrenceRead = run.state.occurrences;
    const knownActivations = initialInstanceId && occurrenceRead.kind === 'ready' && occurrenceRead.revision === run.state.revision
      ? new Set(occurrenceRead.value.filter(item => runCaptureKey030(item.scope) === captureKey).map(item => item.activation.id)) : undefined;
    const missingLinks = initialInstanceId && (!instanceActivationIds || items.some(request =>
      sameHumanScope030(request.scope, runScope) &&
      request.occurrences.some(({ activation }) => activation.kind !== 'available' ||
        runCaptureKey030(activation.scope) !== captureKey || !knownActivations?.has(activation.activationId))));
    return humanClient
      ? <>
        {missingLinks && <p role="status">{t('agsdl.run030.instanceRequestLinksUnavailable')}</p>}
        <HumanRequests030 key={captureKey} requests={requests} client={humanClient} captureKey={captureKey} readOnly={readOnly} pendingOnly={pendingOnly}
          onOpenRequest={request => openWorkflowRun030({ ...request, conversationId: registration?.scope.conversationId })}
          onOpenOccurrence={activation => openOccurrence?.(activation)} showRequest={showRequest} showOccurrence={initialInstanceId ? belongsToInstance : undefined} />
      </>
      : !pendingOnly && <p role="status">{t('agsdl.shell030.humanUnavailable')}</p>;
  };
  return <div ref={host} className="flex h-full min-h-0 min-w-0 flex-col">
    {bundle.catalogError && <div role="alert" className="border-b border-border p-3 text-xs">
      <p>{t('agsdl.run030.readFailed')}</p><details><summary>{t('agsdl.run030.captureDetails')}</summary>
        <p>{bundle.catalogError.code}: {bundle.catalogError.message}</p></details>
    </div>}
    {exact ? <ExecutionMonitor030 key={target ? JSON.stringify(target) : `${access.scopeKey}:${initialRunId ?? ""}`} access={access}
      taskStale={taskStale}
      onSelection={onSelection} initialInstanceId={initialInstanceId} initialRunId={targetRunId ?? initialRunId} exactInitialRun={!!target} currentSource={currentSource} canvas={canvas} controls={controls} capturedControls={onExpand && <button className="agsdl-icon-button" aria-label={t(expanded ? "agsdl.shrink" : "agsdl.expand")} title={t(expanded ? "agsdl.shrink" : "agsdl.expand")} onClick={onExpand}>{expanded ? <X size={14} /> : <Maximize2 size={14} />}</button>} projectPicker={projectPicker} renderHumans={humans} renderGraph={value => <CapturedRunGraph030 bridge={value} currentSource={currentSource} onInspect={value.inspect} />}
      openRun={initialInstanceId && target ? () => openWorkflowRun030(target) : undefined} />
      : <p role="status" className="p-3 text-xs">{t('agsdl.shell030.exactUnavailable')}</p>}
    {target?.requestId && exact && !requestVisible &&
      <p role="status" className="p-3 text-xs">{t('agsdl.shell030.requestUnavailable')}</p>}
  </div>;
}
