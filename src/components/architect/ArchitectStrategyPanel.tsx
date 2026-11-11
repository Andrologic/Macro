import { createPortal } from "react-dom";
import { Play, Square, Maximize2, X } from "lucide-react";
import { CapturedRunGraph030 } from "../agsdl/CapturedRunGraph030";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { useAppStore } from "../../stores/useAppStore";
import {
  getGitFlowBaseBranch,
  resolveTargetBranch,
} from "../../services/architectPlanService";
import { AgsdlEditor } from "../agsdl/AgsdlEditor";
import { Dialog } from "../ui/Dialog";
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from "../../stores/useAgsdlStore";
import { ExecutionMonitor030, type ExecutionMonitorProps030 } from "../agsdl/ExecutionMonitor030";
import { HumanRequests030 } from "../agsdl/HumanRequests030";
import { getWorkflowRunAccess030, subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030, openWorkflowRun030,
  type WorkflowRunAccess030, type WorkflowRunTarget030 } from "../../services/workflowAgentTasks";
import { retainedRunValue030 } from "../../services/agsdl/runtimeProjection030";
import { sameWorkflowSource030 as sameSource } from "../../services/workflowAgentTasks";
import { useAgsdlExecutionStore } from "../../stores/useAgsdlExecutionStore";
import { readDocument } from "../../services/agsdl/document";
import { useChatStore } from "../../stores/useChatStore";

/** Shared dedicated view. An exact notification target never falls back to another run. */
export function WorkflowRunView030({ bundle, currentSource, target, initialRunId, onSelection, canvas, controls, projectPicker, onExpand, expanded }: {
  expanded?: boolean; canvas?: ReactNode; controls?: ReactNode; projectPicker?: ReactNode; onExpand?: () => void;
  bundle: WorkflowRunAccess030; currentSource?: string; target?: WorkflowRunTarget030; initialRunId?: string; onSelection?: (id: string | undefined, active: boolean, viewingRun: boolean) => void;
}) {
  const { t } = useAgsdlTranslation();
  const host = useRef<HTMLDivElement>(null);
  const { access } = bundle;
  const registry = useSyncExternalStore(subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030, workflowRunAccessSnapshot030);
  const focusedTarget = useRef<string>(undefined);
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
  const humans: NonNullable<ExecutionMonitorProps030["renderHumans"]> = (run, pendingOnly = false, openOccurrence) => {
    const humanClient = bundle.humanClient ?? bundle.humanClientForRun?.(run);
    const enclosing = snapshot.runs[run.capture.systemStartId];
    const stale = enclosing?.kind === 'stale' ? enclosing : snapshot.history.kind === 'stale' ? snapshot.history : undefined;
    const pending = enclosing?.kind === 'loading' || snapshot.history.kind === 'loading';
    const requests = stale ? { kind: 'stale' as const, revision: run.state.revision,
      retained: retainedRunValue030(run.state.humans) ?? [], refusal: stale.refusal }
      : pending ? { kind: 'loading' as const, retained: retainedRunValue030(run.state.humans) } : run.state.humans;
    const items = retainedRunValue030(requests) ?? [];
    if (pendingOnly && !items.some(request => request.state.kind === "open")) return null;
    const visible = pendingOnly ? items.filter(request => request.state.kind === "open") : items;
    const filtered = requests.kind === "ready" ? { ...requests, value: visible } : requests.kind === "stale" || requests.kind === "loading" ? { ...requests, retained: visible } : requests;
    const registration = registry.find(item => item.access === access);
    return humanClient
      ? <HumanRequests030 requests={filtered} client={humanClient} onOpenRequest={request => openWorkflowRun030({ ...request, conversationId: registration?.scope.conversationId })}
          onOpenOccurrence={activation => openOccurrence?.(activation)} />
      : <p role="status">{t('agsdl.shell030.humanUnavailable')}</p>;
  };
  return <div ref={host} className="flex h-full min-h-0 min-w-0 flex-col">
    {bundle.catalogError && <div role="alert" className="border-b border-border p-3 text-xs">
      <p>{t('agsdl.run030.readFailed')}</p><details><summary>{t('agsdl.run030.captureDetails')}</summary>
        <p>{bundle.catalogError.code}: {bundle.catalogError.message}</p></details>
    </div>}
    {exact ? <ExecutionMonitor030 key={target ? JSON.stringify(target) : `${access.scopeKey}:${initialRunId ?? ""}`} access={access}
      onSelection={onSelection} initialRunId={target?.scope.systemStartId ?? initialRunId} currentSource={currentSource} canvas={canvas} controls={controls} capturedControls={onExpand && <button className="agsdl-icon-button" aria-label={t(expanded ? "agsdl.shrink" : "agsdl.expand")} title={t(expanded ? "agsdl.shrink" : "agsdl.expand")} onClick={onExpand}>{expanded ? <X size={14} /> : <Maximize2 size={14} />}</button>} projectPicker={projectPicker} renderHumans={humans} renderGraph={value => <CapturedRunGraph030 bridge={value} currentSource={currentSource} onInspect={value.inspect} />} />
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
  const [launchOpen, setLaunchOpen] = useState(false);
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
  useEffect(() => { setSelectedRun(undefined); }, [projectId, target, conversationId]);
  const selectRun = useCallback((id: string | undefined, active: boolean) => setSelectedRun(active ? id : undefined), []);
  const execution = useAgsdlExecutionStore();
  const hasFlow = useMemo(() => { try { return !!source && !!readDocument(source).flow; } catch { return false; } }, [source]);
  const is030 = useMemo(() => { try { return !!source && readDocument(source).contract === 'agsdl-0.3.0'; } catch { return false; } }, [source]);
  useEffect(() => { if (target.planId && conversationId) void useAgsdlExecutionStore.getState().open030(target, conversationId); }, [target, conversationId]);
  useEffect(() => {
    useAgsdlExecutionStore.setState({ error: undefined, notice030: undefined, launchDiagnostics030: [] });
  }, [source]);
  const launched = execution.launched030;
  useEffect(() => { if (launched) setLaunchOpen(false); }, [launched]);
  useEffect(() => {
    if (!projectId || !target.planId) { setBundle(undefined); return; }
    try { setBundle(getWorkflowRunAccess030({ owner: { projectId, planId: target.planId, branch: runBranch }, conversationId: conversationId ?? undefined })); }
    catch { setBundle(undefined); }
  }, [projectId, runBranch, target, conversationId, registrations]);
  const inlineRunHost = useRef<HTMLDivElement>(null);
  const expandedRunHost = useRef<HTMLDivElement>(null);
  const [runHost] = useState(() => {
    const element = document.createElement('div');
    element.className = 'h-full min-h-0 min-w-0';
    return element;
  });
  // Move the portal container, keeping the monitor and its local selection mounted.
  useLayoutEffect(() => {
    const destination = expanded ? expandedRunHost.current : inlineRunHost.current;
    if (bundle && destination) destination.appendChild(runHost);
    return () => { runHost.remove(); };
  }, [bundle, expanded, runHost]);
  const matchingOwner = execution.owner?.projectId === projectId && execution.owner?.branch === runBranch && execution.owner?.planId === target.planId;
  const launchActions = is030 ? <>
    <button type="button" className="agsdl-icon-button" title={t('agsdl.execution.start030')} aria-label={t('agsdl.execution.start030')} onClick={() => setLaunchOpen(true)}><Play size={14} /></button>
    <button type="button" className="agsdl-icon-button" title={t('agsdl.execution.stop030')} aria-label={t('agsdl.execution.stop030')} disabled={!selectedRun || execution.stopping || !matchingOwner} onClick={() => { if (selectedRun) void execution.stop030(selectedRun); }}><Square size={13} /></button>
  </> : null;
  const editor = <AgsdlEditor target={target} planStatus={planStatus} onExpand={() => setExpanded(true)} canvasActions={!bundle ? launchActions : undefined} />;
  const projectPicker = !selectedProjectId && projectIds.length > 1 ? <label className="block">{t('agsdl.shell030.project')}<select aria-label={t('agsdl.shell030.project')} value={projectId ?? ''} onChange={event => { setBundle(undefined); setChosenProject(event.target.value); }} className="w-full rounded border border-border bg-card p-1 text-xs">
    <option value="">{t('agsdl.shell030.chooseProject')}</option>{projectIds.map(id => <option key={id} value={id}>{[...standaloneProjects, ...projectGroups.flatMap(group => group.projects)].find(project => project.id === id)?.name ?? t('agsdl.shell030.project')}</option>)}
  </select></label> : undefined;
  const runView = bundle && <WorkflowRunView030 bundle={bundle} currentSource={source} expanded={expanded} initialRunId={matchingOwner ? execution.launched030 : undefined} onSelection={selectRun}
    canvas={expanded ? <AgsdlEditor target={target} planStatus={planStatus} expanded onExpand={() => setExpanded(false)} /> : editor}
    controls={launchActions} projectPicker={projectPicker} onExpand={() => setExpanded(open => !open)} />;
  return <aside className="h-full min-h-0 min-w-0 flex flex-col bg-card border-l border-border" data-tour-id="architect-strategy-panel">
    <div ref={inlineRunHost} className="relative flex-1 min-h-0">
      {target.planId ? bundle ? null : <>{editor}{projectPicker && <details className="agsdl-project-picker"><summary>{t('agsdl.shell030.project')}</summary>{projectPicker}</details>}</> : <div className="agsdl-empty">{t('agsdl.choosePlan')}</div>}
    </div>
    {target.planId && bundle && createPortal(runView, runHost)}
    {target.planId && expanded && <Dialog title={t('agsdl.editor')} onClose={() => setExpanded(false)} closeOnBackdropClick panelClassName="flex h-[min(90vh,960px)] w-[min(94vw,1440px)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      {bundle ? <div ref={expandedRunHost} className="h-full min-h-0 min-w-0" /> : <AgsdlEditor target={target} planStatus={planStatus} expanded onExpand={() => setExpanded(false)} canvasActions={launchActions} />}
    </Dialog>}
    {launchOpen && <Dialog title={t('agsdl.execution.start030')} onClose={() => setLaunchOpen(false)} closeOnBackdropClick panelClassName="agsdl-detail-modal">
      <header><strong>{t('agsdl.execution.start030')}</strong><button className="agsdl-icon-button" aria-label={t('agsdl.close')} onClick={() => setLaunchOpen(false)}><X size={14} /></button></header>
      <div className="agsdl-inspector-body space-y-3">
        {hasFlow && <label className="agsdl-edit-field">{t('agsdl.execution.input030')}<textarea value={prompt} onChange={event => setPrompt(event.target.value)} /></label>}
        {execution.error && <div role="alert"><p>{t(execution.error)}</p>
          {!!execution.launchDiagnostics030?.length && <><ul>{execution.launchDiagnostics030.map((issue, i) => <li key={i}>{issue.message}</li>)}</ul><details><summary>{t('agsdl.viewer.technicalDetails')}</summary><pre className="whitespace-pre-wrap break-words">{JSON.stringify(execution.launchDiagnostics030, null, 2)}</pre></details></>}
          {execution.error === 'agsdl.execution.codexLoginRequired' && <details><summary>{t('agsdl.canvas030.loginHelp')}</summary><p>{t('agsdl.canvas030.loginInstructions')}</p><a className="agsdl-link" href="https://github.com/Andrologic/Macro/blob/develop/docs/agsdl-codex-native.md#private-login" target="_blank" rel="noreferrer">{t('agsdl.canvas030.loginGuide')}</a></details>}
        </div>}
        {execution.notice030 && <p role="status">{t(execution.notice030)}</p>}
        {execution.intent030 && execution.intent030.state.kind !== 'closed' && <div className="flex gap-2">
          <button type="button" disabled={execution.intentBusy} onClick={() => void execution.resume()}>{t('agsdl.execution.resume')}</button>
          {['prepared', 'submissionPending', 'refused'].includes(execution.intent030.state.kind) && <button type="button" disabled={execution.intentBusy} onClick={() => void execution.discard()}>{t('agsdl.execution.discard')}</button>}
        </div>}
      </div>
      <footer><button type="button" onClick={() => setLaunchOpen(false)}>{t('agsdl.close')}</button><button type="button" disabled={!conversationId || execution.intentBusy} onClick={() => void execution.start030(prompt)}>{t(execution.error === 'agsdl.execution.codexLoginRequired' ? 'agsdl.canvas030.retryLogin' : 'agsdl.execution.start030')}</button></footer>
    </Dialog>}
  </aside>;
}
