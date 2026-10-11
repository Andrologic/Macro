import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, History, Loader2, MessageSquarePlus, Play, RefreshCw, RotateCw, Square, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { useAgsdlExecutionStore } from "../../stores/useAgsdlExecutionStore";
import { useChatStore } from "../../stores/useChatStore";
import { prepareAgsdlChatContext, prepareAgsdlRuntimeContext } from "../../stores/agsdl/chatContext";
import { executionInput, nativeRunState } from "../../services/agsdl/executionView";
import type { AgsdlTarget } from "../../stores/useAgsdlStore";
import type { SystemStartId } from "../../services/agsdlExecution/contracts";
import { notify } from "../ui/toastService";
import { agsdlErrorText } from "./errorText";
import { DisclosureSummary } from "./DisclosureSummary";


export function ExecutionDialog({ target, onClose }: { target: AgsdlTarget; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const conversationId = useChatStore(state => state.selectedConversationId);
  const conversationProjectId = useChatStore(state => state.conversations.find(item => item.id === state.selectedConversationId)?.project_id);
  // A plan without its first message has no conversation to own executions yet.
  const conversationPending = useChatStore(state => !!state.selectedConversationId && !!state.getPendingArchitectConversationTarget?.(state.selectedConversationId));
  const needsConversation = conversationPending || !conversationId || !conversationProjectId;
  const state = useAgsdlExecutionStore();
  const open = state.open;
  const [attaching, setAttaching] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [agentName, setAgentName] = useState("");
  useEffect(() => { if (conversationId && !conversationPending) void open(target, conversationId); }, [target, conversationId, conversationPending, open]);
  const scoped = state.owner?.planId === target.planId && state.owner.branch === target.branchName && state.conversationId === conversationId && state.owner.projectId === conversationProjectId;
  const snapshot = scoped ? state.snapshot : undefined;
  const startInput = useMemo(() => { try { return state.preflight ? executionInput(state.preflight.authoredSource) : undefined; } catch { return; } }, [state.preflight]);
  const deliveryInput = useMemo(() => { try { return snapshot ? executionInput(snapshot.authoredSource) : undefined; } catch { return; } }, [snapshot]);
  const ready = !!state.preflight?.productRuntimeAvailable && state.preflight.staticValid && state.preflight.runtimeSupported && !state.preflight.incomplete;
  // Opening only reads: without a Preflight, support is unknown rather than missing.
  const status = t(!state.preflight ? "agsdl.execution.notChecked" : state.preflight.runtimeSupported ? state.preflight.productRuntimeAvailable ? "agsdl.execution.available" : "agsdl.execution.unavailable" : "agsdl.execution.unsupported");
  const runKey = snapshot?.systemStartId;
  const selectedRun = state.runs.find(run => run.systemStartId === runKey);
  const runState = selectedRun ? nativeRunState({ ...selectedRun, systemStop: state.projection?.systemStop ?? selectedRun.systemStop }) : undefined;
  // Native intent state drives the actions; its identities and codes stay out of the text.
  const intent = scoped ? state.intent : undefined;
  const intentOpen = !!intent && intent.state.kind !== "closed";
  const locked = state.busy || state.intentBusy || intentOpen;
  const hasData = scoped && (state.runs.length > 0 || !!snapshot || intentOpen);
  const loading = !conversationPending && !!conversationId && !!conversationProjectId && (!scoped || (!state.loaded && !state.error));
  // Error keys are translated; unknown text never reaches the interface.
  const fallbackError = state.loaded ? "agsdl.execution.error" : "agsdl.execution.readFailed";
  const errorMessage = state.error
    ? t(state.error === "agsdl.execution.error" ? fallbackError : state.error, { defaultValue: t(fallbackError) })
    : "";
  const errorLine = scoped && state.error ? <div role="alert" className="agsdl-execution-state agsdl-unresolved"><AlertCircle size={15} /><span>{errorMessage}</span>
    <button className="agsdl-link" disabled={state.busy} onClick={() => conversationId && void open(target, conversationId)}>{t("agsdl.retry")}</button></div> : null;
  const startControls = <>
    {(startInput?.hasEntry || deliveryInput?.graphless) && <label className="agsdl-edit-field"><span>{t("agsdl.execution.prompt")}</span><textarea rows={3} value={prompt} maxLength={65536} disabled={state.intentBusy || intentOpen} placeholder={t("agsdl.execution.promptPlaceholder")} onChange={event => setPrompt(event.target.value)} /></label>}
  </>;
  const explainPreflight = async () => {
    if (!state.preflight) return;
    setAttaching(true);
    try {
      await prepareAgsdlChatContext(target, {
        path: "", title: t("agsdl.execution.diagnostics"),
        diagnostic: JSON.stringify({ staticValid: state.preflight.staticValid, runtimeSupported: state.preflight.runtimeSupported,
          productRuntimeAvailable: state.preflight.productRuntimeAvailable, incomplete: state.preflight.incomplete, diagnostics: state.preflight.diagnostics }),
      });
      onClose();
    } catch (error) { notify.error(t("agsdl.staleChatSelection"), { description: agsdlErrorText(error, t) }); }
    finally { setAttaching(false); }
  };
  const attach = async () => {
    if (!snapshot || !state.diagnostic || !state.projection) return;
    setAttaching(true);
    try {
      await prepareAgsdlRuntimeContext({ planId: target.planId, branchName: target.branchName, systemStartId: snapshot.systemStartId,
        source: snapshot.source, cursor: state.projection.cursor, path: "", title: t("agsdl.execution.capture"), diagnosticSelection: [] });
      onClose();
    } catch (error) { notify.error(t("agsdl.staleChatSelection"), { description: agsdlErrorText(error, t) }); }
    finally { setAttaching(false); }
  };
  return <Dialog title={t("agsdl.execution.title")} onClose={onClose} closeOnBackdropClick panelClassName="agsdl-detail-modal agsdl-execution-modal">
    <header><strong>{t("agsdl.execution.title")}</strong><div className="agsdl-header-actions">{scoped && state.loaded && <button className="agsdl-icon-button" aria-label={t("agsdl.execution.refresh")} title={t("agsdl.execution.refresh")} disabled={state.busy} onClick={() => void state.refresh()}><RefreshCw size={15} /></button>}<button className="agsdl-icon-button" onClick={onClose} aria-label={t("agsdl.close")} title={t("agsdl.close")}><X size={16} /></button></div></header>
    <div className="agsdl-inspector-body">
      {needsConversation && <div className="agsdl-execution-state"><History size={16} /><span>{t("agsdl.execution.firstMessageRequired")}</span></div>}
      {loading && <p role="status" className="agsdl-execution-state"><Loader2 size={15} className="animate-spin" />{t("agsdl.execution.loading")}</p>}
      {!conversationPending && scoped && !state.loaded && errorLine}
      {!conversationPending && scoped && state.loaded && !hasData && <>
        <div className="agsdl-execution-state">
          <History size={16} />
          <span><strong>{t("agsdl.execution.empty")}</strong><br /><span className="agsdl-muted">{t("agsdl.execution.emptyHint")}</span></span>
          <button className="agsdl-link" disabled={state.busy} onClick={() => void state.refresh()}><RefreshCw size={13} /> {t("agsdl.execution.refresh")}</button>
        </div>
        {state.preflight && <div className="agsdl-execution-state agsdl-muted" role="status">
          {ready ? <Check size={14} /> : <AlertCircle size={14} />}
          <span>{status}</span>
          {!!state.preflight.diagnostics.length && <button className="agsdl-icon-button" aria-label={t("agsdl.execution.diagnostics")} title={state.preflight.diagnostics.map(item => item.message).join("\n")} disabled={attaching} onClick={() => void explainPreflight()}><MessageSquarePlus size={15} /></button>}
        </div>}
        {ready && <>
          {startControls}
          <button aria-label={t("agsdl.execution.start")} disabled={locked || (startInput?.hasEntry && !prompt.trim())} onClick={() => void state.start(prompt)}><Play size={15} /> {t("agsdl.execution.start")}</button>
        </>}
        {errorLine}
      </>}
      {!conversationPending && scoped && state.loaded && hasData && <>
        <details className="agsdl-new-execution">
          <DisclosureSummary><Play size={14} />{t("agsdl.execution.start")}</DisclosureSummary>
          {!state.preflight && <button className="agsdl-action-button" disabled={state.busy} onClick={() => void state.refresh()}><RefreshCw size={14} />{t("agsdl.execution.refresh")}</button>}
          {state.preflight && !ready && <p className="agsdl-muted">{status}</p>}
          {(ready || (state.preflight?.productRuntimeAvailable && deliveryInput?.graphless)) && startControls}
          <button className="agsdl-action-button is-primary" aria-label={t("agsdl.execution.start")} title={status} disabled={locked || !ready || (startInput?.hasEntry && !prompt.trim())} onClick={() => void state.start(prompt)}><Play size={14} />{t("agsdl.execution.start")}</button>
          {!!state.preflight?.diagnostics.length && <button className="agsdl-action-button" disabled={attaching} onClick={() => void explainPreflight()}><MessageSquarePlus size={14} />{t("agsdl.reviewWithAI")}</button>}
        </details>
        {state.runs.length > 0 && <label className="agsdl-edit-field agsdl-run-selector"><span>{t("agsdl.execution.run")}</span><select disabled={state.busy || state.intentBusy} value={snapshot?.systemStartId ?? ""} onChange={event => { setAgentName(""); void state.select((event.target.value || undefined) as SystemStartId | undefined); }}>
          <option value="">{t("agsdl.execution.noRun")}</option>{snapshot && !state.runs.some(run => run.systemStartId === snapshot.systemStartId) && <option value={snapshot.systemStartId}>{t("agsdl.execution.run")}</option>}{state.runs.map((run, index) => <option value={run.systemStartId} key={run.systemStartId}>{t("agsdl.execution.runNumber", { number: index + 1 })} · {t("agsdl.execution.completedCount", { completed: run.counts.completed })}</option>)}</select></label>}
        {runState && <div role="status" className={`agsdl-execution-state ${runState === 'failed' || runState === 'uncertain' ? 'agsdl-unresolved' : 'agsdl-muted'}`}>
          {runState === 'active' || runState === 'queued' ? <Loader2 size={14} className="animate-spin" /> : runState === 'completed' ? <Check size={14} /> : runState === 'stopped' ? <Square size={14} /> : <AlertCircle size={14} />}
          <span>{t(`agsdl.execution.state.${runState}`)}</span>
        </div>}
        {state.nextRuns && <button disabled={state.busy} onClick={() => void state.moreRuns()}>{t("agsdl.execution.moreRuns")}</button>}
        {snapshot && <>
          {deliveryInput?.graphless && state.preflight?.productRuntimeAvailable && <div className="agsdl-execution-actions"><select aria-label={t("agsdl.execution.agent")} value={agentName} disabled={locked} onChange={event => setAgentName(event.target.value)}><option value="">{t("agsdl.execution.agentRequired")}</option>{deliveryInput.agents.map(name => <option key={name} value={name}>{name}</option>)}</select><button disabled={locked || !state.preflight?.productRuntimeAvailable || !deliveryInput.agents.includes(agentName) || !prompt.trim()} onClick={() => void state.deliver(agentName, prompt)}>{t("agsdl.execution.deliver")}</button></div>}
          <div className="agsdl-execution-actions"><button className="agsdl-action-button" aria-pressed={state.captured} disabled={state.busy} onClick={() => { state.showCaptured(!state.captured); onClose(); }}><History size={14} />{t(state.captured ? "agsdl.execution.currentDocument" : "agsdl.execution.capture")}</button>
            {(!runState || ["active", "queued", "uncertain"].includes(runState)) && <button className="agsdl-action-button" aria-label={t("agsdl.execution.stop")} title={t("agsdl.execution.stop")} disabled={state.stopping || state.projection?.systemStop.kind === "confirmed"} onClick={() => void state.stop()}><Square size={14} />{t("agsdl.execution.stop")}</button>}
            {state.projection && state.projection.systemStop.kind !== "none" && <span role="img" aria-label={t(`agsdl.execution.stopState.${state.projection.systemStop.kind}`)} title={t(`agsdl.execution.stopState.${state.projection.systemStop.kind}`)}><AlertCircle size={14} /></span>}
          </div>
          {state.projection?.nextPage && <button disabled={state.busy || state.stale} onClick={() => void state.moreProjection()}>{t("agsdl.execution.moreActivations")}</button>}
          {state.stale && <button title={t("agsdl.execution.stale")} disabled={state.busy} onClick={() => { void state.refresh(); }}>{t("agsdl.execution.restart")}</button>}
          {state.approvals?.approvals.filter(item => item.status === "pending").map(approval => <section key={approval.approvalId} className="agsdl-ports"><h4 title={approval.summary}>{approval.toolName}</h4>
            <button disabled={state.busy} onClick={() => void state.decide(approval, true)}>{t("agsdl.execution.approve")}</button> <button disabled={state.busy} onClick={() => void state.decide(approval, false)}>{t("agsdl.execution.reject")}</button></section>)}
          {state.approvals?.incomplete && <span role="img" aria-label={t("agsdl.execution.partial")} title={t("agsdl.execution.partial")}><AlertCircle size={14} /></span>}
          <button className="agsdl-action-button" aria-label={t("agsdl.attachToChat")} disabled={state.busy || attaching || !state.projection || state.stale} onClick={() => void attach()}><MessageSquarePlus size={14} />{t("agsdl.reviewWithAI")}</button>
        </>}
        {intentOpen && <div className="agsdl-execution-actions" role="status">
          <span className="agsdl-muted">{t(`agsdl.execution.intent.${intent!.state.kind}`)}</span>
          {intent!.state.kind !== "refused" && <button className="agsdl-action-button" aria-label={t("agsdl.execution.resume")} title={t("agsdl.execution.resume")} disabled={state.intentBusy} onClick={() => void state.resume()}><RotateCw size={14} />{t("agsdl.execution.resume")}</button>}
          {intent!.state.kind !== "admitted" && <button className="agsdl-action-button" aria-label={t("agsdl.execution.discard")} title={t("agsdl.execution.discard")} disabled={state.intentBusy} onClick={() => void state.discard()}><X size={14} />{t("agsdl.execution.discard")}</button>}
        </div>}
        {(state.busy || state.intentBusy) && <span role="status" className="agsdl-execution-state agsdl-muted"><Loader2 size={13} className="animate-spin" />{t("agsdl.execution.loading")}</span>}
        {errorLine}
      </>}
    </div>
  </Dialog>;
}
