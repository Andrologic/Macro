import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { useAppStore } from "../../stores/useAppStore";
import {
  getGitFlowBaseBranch,
  resolveTargetBranch,
} from "../../services/architectPlanService";
import { AgsdlEditor } from "../agsdl/AgsdlEditor";
import { Dialog } from "../ui/Dialog";
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from "../../stores/useAgsdlStore";
import { ExecutionMonitor030 } from "../agsdl/ExecutionMonitor030";
import { HumanRequests030 } from "../agsdl/HumanRequests030";
import { getWorkflowRunAccess030, subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030, openWorkflowRun030,
  type WorkflowRunAccess030, type WorkflowRunTarget030 } from "../../services/workflowAgentTasks";
import { retainedRunValue030 } from "../../services/agsdl/runtimeProjection030";
import { sameWorkflowSource030 as sameSource } from "../../services/workflowAgentTasks";
import type { RunGraphBridge030 } from "../agsdl/RunInspector030";
import { runCaptureKey030 } from "../../services/agsdl/runGraphProjection030";
import { useAgsdlExecutionStore } from "../../stores/useAgsdlExecutionStore";
import { readDocument } from "../../services/agsdl/document";
import { useChatStore } from "../../stores/useChatStore";
import type { RunInspection030 } from "../../services/agsdl/runtimeProjection030";

/** Shared dedicated view. An exact notification target never falls back to another run. */
export function WorkflowRunView030({ bundle, currentSource, target, initialRunId, onSelection }: {
  bundle: WorkflowRunAccess030; currentSource?: string; target?: WorkflowRunTarget030; initialRunId?: string; onSelection?: (id: string | undefined) => void;
}) {
  const { t } = useAgsdlTranslation();
  const host = useRef<HTMLDivElement>(null);
  const { access } = bundle;
  const registry = useSyncExternalStore(subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030, workflowRunAccessSnapshot030);
  const focusedTarget = useRef<string>(undefined);
  const bridge = useRef<RunGraphBridge030>(undefined);
  const snapshot = useSyncExternalStore(access.subscribe.bind(access), access.getSnapshot.bind(access), access.getSnapshot.bind(access));
  useEffect(() => {
    if (target) { void access.refreshHistory().catch(() => {}); void access.refreshRun(target.scope.systemStartId).catch(() => {}); }
  }, [access, target]);
  const read = target && snapshot.runs[target.scope.systemStartId];
  const inspection = read ? retainedRunValue030(read) : null;
  const history = retainedRunValue030(snapshot.history);
  const exact = !target || (inspection && inspection.capture.systemStartId === target.scope.systemStartId && sameSource(inspection.capture.source, target.scope.source) &&
    history?.some(item => item.scope.systemStartId === target.scope.systemStartId && sameSource(item.capture.source, target.scope.source)));
  const focusKey = target?.requestId ? JSON.stringify([target.scope, target.requestId]) : undefined;
  const requestVisible = !!target && !!inspection && retainedRunValue030(inspection.state.humans)?.some(request => request.id === target.requestId);
  useEffect(() => {
    if (!exact || !focusKey || !requestVisible || focusedTarget.current === focusKey) return;
    const card = [...(host.current?.querySelectorAll<HTMLElement>('[data-human-request]') ?? [])].find(item => item.dataset.humanRequest === target?.requestId);
    if (!card) return;
    const frame = window.requestAnimationFrame(() => { focusedTarget.current = focusKey; card.focus(); card?.scrollIntoView?.({ block: 'nearest' }); });
    return () => window.cancelAnimationFrame(frame);
  }, [exact, focusKey, requestVisible, target?.requestId]);
  const humans = (run: RunInspection030) => {
    const humanClient = bundle.humanClient ?? bundle.humanClientForRun?.(run);
    const enclosing = snapshot.runs[run.capture.systemStartId];
    const stale = enclosing?.kind === 'stale' ? enclosing : snapshot.history.kind === 'stale' ? snapshot.history : undefined;
    const pending = enclosing?.kind === 'loading' || snapshot.history.kind === 'loading';
    const requests = stale ? { kind: 'stale' as const, revision: run.state.revision,
      retained: retainedRunValue030(run.state.humans) ?? [], refusal: stale.refusal }
      : pending ? { kind: 'loading' as const, retained: retainedRunValue030(run.state.humans) } : run.state.humans;
    const registration = registry.find(item => item.access === access);
    return humanClient
      ? <HumanRequests030 requests={requests} client={humanClient} onOpenRequest={request => openWorkflowRun030({ ...request, conversationId: registration?.scope.conversationId })}
          onOpenOccurrence={activation => {
            const current = bridge.current;
            const occurrence = current?.occurrences.find(item => item.activationId === activation.activationId && runCaptureKey030(item.occurrence.scope) === runCaptureKey030(activation.scope));
            if (occurrence) current?.selectOccurrence(occurrence.key);
          }} />
      : <p role="status">{t('agsdl.shell030.humanUnavailable')}</p>;
  };
  return <div ref={host} className="flex h-full min-h-0 min-w-0 flex-col">
    {bundle.catalogError && <div role="alert" className="border-b border-border p-3 text-xs">
      <p>{t('agsdl.run030.readFailed')}</p><details><summary>{t('agsdl.run030.captureDetails')}</summary>
        <p>{bundle.catalogError.code}: {bundle.catalogError.message}</p></details>
    </div>}
    {exact ? <ExecutionMonitor030 key={target ? JSON.stringify(target) : `${access.scopeKey}:${initialRunId ?? ""}`} access={access}
      onSelection={onSelection} initialRunId={target?.scope.systemStartId ?? initialRunId} currentSource={currentSource} renderHumans={humans} renderGraph={value => { bridge.current = value; return null; }} />
      : <p role="status" className="p-3 text-xs">{t('agsdl.shell030.exactUnavailable')}</p>}
    {target?.requestId && exact && inspection && !retainedRunValue030(inspection.state.humans)?.some(request => request.id === target.requestId && sameSource(request.scope.source, target.scope.source)) &&
      <p role="status" className="p-3 text-xs">{t('agsdl.shell030.requestUnavailable')}</p>}
  </div>;
}

export default function ArchitectStrategyPanel() {
  const projectId = useAppStore(state => state.selectedProjectId);
  const planId = useAppStore((state) => state.activeArchitectPlanId);
  const targetBranch = useAppStore(
    (state) => state.activePlanContext?.targetBranch,
  );
  const planStatus = useAppStore((state) => state.activePlanContext?.status);
  const target = useMemo(
    () => ({
      branchName: resolveTargetBranch(targetBranch || getGitFlowBaseBranch()),
      planId: planId || "",
    }),
    [planId, targetBranch],
  );
  return <ArchitectViewer key={JSON.stringify([target, projectId])} target={target} planStatus={planStatus} />;
}

function ArchitectViewer({ target, planStatus }: { target: AgsdlTarget; planStatus?: string }) {
  const { t } = useAgsdlTranslation();
  const [expanded, setExpanded] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const selectedProjectId = useAppStore(state => state.selectedProjectId);
  const standaloneProjects = useAppStore(state => state.standaloneProjects);
  const projectGroups = useAppStore(state => state.projectGroups);
  const projectBranches = useAppStore(state => state.activePlanContext?.targetBranchesByProjectId);
  const projectIds = Object.keys(projectBranches ?? {});
  const [chosenProject, setChosenProject] = useState('');
  const projectId = selectedProjectId ?? (projectIds.includes(chosenProject) ? chosenProject : projectIds.length === 1 ? projectIds[0] : undefined);
  // The selected project's document is loaded from target.branchName. A plan's
  // per-project execution branch can differ from that metadata owner.
  const runBranch = selectedProjectId ? target.branchName : projectBranches?.[projectId ?? ''] ?? target.branchName;
  const conversationId = useChatStore(state => state.conversations.find(item => item.id === state.selectedConversationId && item.scope_mode === "Architect")?.id);
  const source = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]?.source);
  const registrations = useSyncExternalStore(subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030, workflowRunAccessSnapshot030);
  const [bundle, setBundle] = useState<WorkflowRunAccess030>();
  const [prompt, setPrompt] = useState('');
  const [selectedRun, setSelectedRun] = useState<string>();
  useEffect(() => { setSelectedRun(undefined); }, [runsOpen, projectId, target, conversationId]);
  const selectRun = useCallback((id: string | undefined) => setSelectedRun(id), []);
  const execution = useAgsdlExecutionStore();
  const hasFlow = useMemo(() => { try { return !!source && !!readDocument(source).flow; } catch { return false; } }, [source]);
  const is030 = useMemo(() => { try { return !!source && readDocument(source).contract === 'agsdl-0.3.0'; } catch { return false; } }, [source]);
  useEffect(() => { if (target.planId && conversationId) void useAgsdlExecutionStore.getState().open030(target, conversationId); }, [target, conversationId]);
  useEffect(() => { if (execution.launched030) setRunsOpen(true); }, [execution.launched030]);
  useEffect(() => {
    if (!runsOpen || !projectId || !target.planId) { setBundle(undefined); return; }
    try { setBundle(getWorkflowRunAccess030({ owner: { projectId, planId: target.planId, branch: runBranch }, conversationId: conversationId ?? undefined })); }
    catch { setBundle(undefined); }
  }, [runsOpen, projectId, runBranch, target, conversationId, registrations]);
  return (
    <aside
      className="h-full min-h-0 min-w-0 flex flex-col bg-card border-l border-border"
      data-tour-id="architect-strategy-panel"
    >
      {target.planId && <nav aria-label={t('agsdl.shell030.views')} className="flex shrink-0 gap-1 border-b border-border p-2 text-xs">
        <button type="button" aria-pressed={!runsOpen} className="rounded px-2 py-1 hover:bg-accent" onClick={() => setRunsOpen(false)}>{t('agsdl.shell030.design')}</button>
        <button type="button" aria-pressed={runsOpen} className="rounded px-2 py-1 hover:bg-accent" onClick={() => { setExpanded(false); setRunsOpen(true); }}>{t('agsdl.shell030.executions')}</button>
        {!selectedProjectId && projectIds.length > 1 && <select aria-label={t('agsdl.shell030.project')} value={projectId ?? ''} onChange={event => { setBundle(undefined); setChosenProject(event.target.value); }} className="min-w-0 flex-1 rounded border border-border bg-card px-1 text-xs">
          <option value="">{t('agsdl.shell030.chooseProject')}</option>{projectIds.map(id => <option key={id} value={id}>{[...standaloneProjects, ...projectGroups.flatMap(group => group.projects)].find(project => project.id === id)?.name ?? id}</option>)}
        </select>}
      </nav>}
      {target.planId && is030 && <section className="space-y-2 border-b border-border p-2 text-xs">
        {hasFlow && <label className="flex flex-col gap-1">{t('agsdl.execution.input030')}
          <textarea className="min-h-16 rounded border border-border bg-card p-1" value={prompt} onChange={event => setPrompt(event.target.value)} />
        </label>}
        <div className="flex gap-2">
          <button type="button" className="rounded border border-border px-2 py-1 hover:bg-accent" disabled={!conversationId || execution.intentBusy} onClick={() => void execution.start030(prompt)}>{t('agsdl.execution.start030')}</button>
          <button type="button" className="rounded border border-border px-2 py-1 hover:bg-accent" disabled={!runsOpen || !selectedRun || execution.stopping || execution.owner?.projectId !== projectId || execution.owner?.branch !== runBranch} onClick={() => { if (selectedRun) void execution.stop030(selectedRun); }}>{t('agsdl.execution.stop030')}</button>
        </div>
        {execution.error && <p role="alert">{t(execution.error)}</p>}
        {execution.notice030 && <p role="status">{t(execution.notice030)}</p>}
        {execution.intent030 && execution.intent030.state.kind !== 'closed' && <div className="flex gap-2">
          <button type="button" disabled={execution.intentBusy} onClick={() => void execution.resume()}>{t('agsdl.execution.resume')}</button>
          {['prepared', 'submissionPending', 'refused'].includes(execution.intent030.state.kind) && <button type="button" disabled={execution.intentBusy} onClick={() => void execution.discard()}>{t('agsdl.execution.discard')}</button>}
        </div>}
      </section>}
      <div className="flex-1 min-h-0">
        {runsOpen ? bundle ? <WorkflowRunView030 bundle={bundle} currentSource={source} initialRunId={execution.launched030} onSelection={selectRun} /> : <p role="status" className="p-3 text-xs">{t('agsdl.shell030.unavailable')}</p> : <>
        {target.planId ? (
          <AgsdlEditor
            target={target}
            planStatus={planStatus}
            onExpand={() => setExpanded(true)}
          />
        ) : (
          <div className="agsdl-empty">{t("agsdl.choosePlan")}</div>
        )}
        </>}
      </div>
      {target.planId && expanded && (
        <Dialog
          title={t("agsdl.editor")}
          onClose={() => setExpanded(false)}
          closeOnBackdropClick
          panelClassName="flex h-[min(90vh,960px)] w-[min(94vw,1440px)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        >
          <AgsdlEditor
            target={target}
            planStatus={planStatus}
            expanded
            onExpand={() => setExpanded(false)}
          />
        </Dialog>
      )}
    </aside>
  );
}
