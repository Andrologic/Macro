import { notify } from "../ui/toastService";
import { ExecutionDialog } from "./ExecutionDialog";
import { useAgsdlExecutionStore } from "../../stores/useAgsdlExecutionStore";
import { useChatStore } from "../../stores/useChatStore";
import { nativeActivationState, nativeCardActivations } from "../../services/agsdl/executionView";
import { sameSource } from "../../services/agsdl/runtimeSelection";
import { prepareAgsdlRuntimeContext } from "../../stores/agsdl/chatContext";
import { DisclosureSummary } from "./DisclosureSummary";
import { useTrackedTasks } from "./useTrackedTasks";
import React, { useEffect, useMemo, useState } from "react";
import { Activity, BookOpen, CircleAlert, Layers, Info, MessageSquarePlus, Maximize2, X } from "lucide-react";
import { DesignLibraryDialog, DesignStart } from "./DesignLibraryDialog";
import { SystemDesignDialog } from "./SystemDesignDialog";
import { DesignChangesDialog } from "./DesignChangesDialog";
import { readDesign } from "../../services/agsdl/design";
import { reviewDesignChanges } from "../../services/agsdl/designReview";
import { AgentDetails } from "./AgentDetails";
import { ComponentDetailsDialog } from "./ComponentDetailsDialog";
import { WorkflowGraph } from "./WorkflowGraph";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import {
  useAgsdlStore,
  agsdlSessionKey,
  type AgsdlTarget,
} from "../../stores/useAgsdlStore";
import {
  projectViewer,
  type ViewerCard,
  type ViewerPort,
  type ViewerReference,
} from "../../services/agsdl/viewer";
import { localizeDiagnostics, type LocalizedDiagnostic } from "../../services/agsdl/diagnostics";
import { projectSystemOverview } from "../../services/agsdl/systemOverview";
import "./agsdl.css";
import { prepareAgsdlChatContext } from "../../stores/agsdl/chatContext";
import { agsdlErrorText } from "./errorText";

// Chat and focused component edits share the same versioned document store.
export const AgsdlEditor: React.FC<{
  target: AgsdlTarget;
  planStatus?: string;
  expanded?: boolean;
  onExpand?: () => void;
}> = ({ target, planStatus, expanded, onExpand }) => {
  const { t } = useAgsdlTranslation();
  const key = agsdlSessionKey(target);
  const session = useAgsdlStore((state) => state.sessions[key]);
  const execution = useAgsdlExecutionStore();
  const conversationProjectId = useChatStore(state => state.conversations.find(item => item.id === state.selectedConversationId)?.project_id);
  const conversationId = useChatStore(state => state.selectedConversationId);
  const executionScoped = execution.owner?.planId === target.planId && execution.owner.branch === target.branchName && execution.conversationId === conversationId && execution.owner.projectId === conversationProjectId;
  const watchExecution = execution.watch;
  const watchedRun = executionScoped ? execution.snapshot?.systemStartId : undefined;
  const watchedOwner = executionScoped ? execution.owner : undefined;
  useEffect(() => watchedOwner && watchedRun && conversationId ? watchExecution(watchedOwner, conversationId, watchedRun) : undefined, [watchedOwner, watchedRun, conversationId, watchExecution]);
  const [executionOpen, setExecutionOpen] = useState(false);
  const captured = executionScoped && execution.captured && !!execution.snapshot;
  const sourceConfirmed = executionScoped && !!execution.preflight && !!session && !session.dirty && !session.saving &&
    execution.preflight.authoredSource === session.source;
  const exactRun = sourceConfirmed && !!execution.snapshot && sameSource(execution.snapshot.source, execution.preflight!.source as import("../../services/agsdlExecution/contracts").SourceRevision);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState(false);
  const [library, setLibrary] = useState<"start" | "blueprint" | "system" | "save">();
  const [designOpen, setDesignOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState("");
  const [graphIndex, setGraphIndex] = useState(0);
  const [selection, setSelection] = useState<{ key: string; path: string; card?: ViewerCard; trail?: Array<{ key: string; path: string; card?: ViewerCard }> }>();
  useEffect(() => {
    let active = true;
    useAgsdlStore
      .getState()
      .load(target)
      .then(() => {
        if (active) setError("");
      })
      .catch((error: unknown) => {
        if (active) setError(agsdlErrorText(error));
      });
    return () => {
      active = false;
    };
  }, [target]);
  const changeHistory = async (redo = false) => {
    try {
      const store = useAgsdlStore.getState();
      store.undo(target, redo);
      await store.save(target);
      setError("");
    } catch (error) { setError(agsdlErrorText(error, t)); }
  };
  const source = captured ? execution.snapshot!.authoredSource : session?.source;
  const sourceDesign = captured ? undefined : session?.design;
  const displayMetadata = captured ? undefined : session?.display;
  const migrationMetadata = captured ? undefined : session?.migration;
  const design = useMemo(() => {
    try { return source ? readDesign(source, sourceDesign) : undefined; } catch { return undefined; }
  }, [source, sourceDesign]);
  const review = useMemo(() => session?.history.length ? reviewDesignChanges(session.history.at(-1)!.source, session.source, session.history.at(-1), session) : undefined, [session]);
  const showChanges = !captured && !!review && (review.changes.length > 0 || review.design || review.configuration || review.other) && session?.version !== dismissedVersion;
  const pendingRequirements = design?.requirements.filter(item => !item.value.trim()) ?? [];
  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(() => void useAgsdlStore.getState().validate(target), 250);
    return () => clearTimeout(timer);
  }, [source, target]);
  const parsed = useMemo(() => {
    if (!source) return {};
    try {
      return { document: projectViewer(source, { display: displayMetadata, migration: migrationMetadata }) };
    } catch (error) {
      return { error: String(error) };
    }
  }, [source, displayMetadata, migrationMetadata]);
  const document = parsed.document;
  const visibleGraphIndex = Math.min(graphIndex, Math.max(0, (document?.graphs.length ?? 0) - 1));
  const graph = document?.graphs[visibleGraphIndex];
  const selected = selection?.key === key ? selection.path : "";
  const system = useMemo(() => projectSystemOverview(graph, document?.legacyCards.length
    ? document.legacyCards : document?.declarations.filter(item => ["Agent", "System"].includes(item.kind)) ?? []), [graph, document]);
  const diagnostics = useMemo(() => source && document && !captured ? localizeDiagnostics(source, session?.reports ?? [], [...document.graphs.flatMap(graph => graph.cards), ...document.declarations, ...document.legacyCards]) : [], [source, document, session?.reports, captured]);
  const cards = useMemo(() => system.cards.map(card => ({ ...card, issueCount: diagnostics.filter(issue => issue.targets.includes(card.path)).length })), [system.cards, diagnostics]);
  const selectedEdge = system.edges.find(edge => edge.id === selected);
  const legacyTrackedTasks = useTrackedTasks(cards, target);
  const trackedTasks = captured ? {} : legacyTrackedTasks;
  const nativeActivations = useMemo(() => (captured || exactRun) && execution.projection ? nativeCardActivations(cards, execution.projection, execution.approvals?.approvals ?? []) : {}, [captured, exactRun, cards, execution.projection, execution.approvals]);
  const currentCard = cards.find(item => item.path === selected) ?? graph?.cards.find(item => item.path === selected) ?? document?.declarations.find(item => item.path === selected);
  // Keep an open form alive if an agent removes its component. Its captured
  // version will reject saving; the user's text remains available to copy.
  const snapshotCard = selection?.key === key ? selection.card : undefined;
  const selectedCard = snapshotCard && (!currentCard || currentCard.id !== snapshotCard.id) ? snapshotCard : currentCard;
  const inspectTask = execution.inspectTask;
  const inspectedPath = selectedCard?.path;
  const inspectedRun = executionScoped && (captured || exactRun) ? execution.snapshot?.systemStartId : undefined;
  useEffect(() => { if (inspectedPath && inspectedRun) void inspectTask(inspectedPath); }, [inspectedPath, inspectedRun, inspectTask]);
  const select = (path: string) => {
    setDiagnosticError("");
    const card = cards.find(item => item.path === path) ?? graph?.cards.find(item => item.path === path) ?? document?.declarations.find(item => item.path === path);
    setSelection(current => !path ? undefined : {
      key, path, card,
      trail: current?.key === key && current.path && current.path !== path
        ? [...(current.trail ?? []), { key, path: current.path, card: current.card }].slice(-20)
        : current?.key === key ? current.trail : [],
    });
    setOverview(false);
  };
  const previousSelection = selection?.key === key ? selection.trail?.at(-1) : undefined;
  const goBack = () => {
    if (!previousSelection) return;
    const index = document?.graphs.findIndex(graph => graph.cards.some(card => card.path === previousSelection.path)) ?? -1;
    if (index >= 0) setGraphIndex(index);
    setSelection({ ...previousSelection, trail: selection?.trail?.slice(0, -1) });
    setDiagnosticError("");
  };
  const attachContext = async (selection: Parameters<typeof prepareAgsdlChatContext>[1]) => {
    if ((captured || exactRun) && execution.snapshot && execution.projection) {
      await prepareAgsdlRuntimeContext({ ...target, systemStartId: execution.snapshot.systemStartId, source: execution.snapshot.source,
        cursor: execution.projection.cursor, path: selection.path, title: selection.title, relatedPaths: selection.relatedPaths });
    } else await prepareAgsdlChatContext(target, selection);
    setOverview(false);
    setSelection(undefined);
    setDesignOpen(false);
    if (expanded) onExpand?.();
  };
  const diagnosticAction = (issues: LocalizedDiagnostic[], path: string, title: string) => issues.length > 0 && <button className="agsdl-link" disabled={attaching} onClick={() => {
    setAttaching(true); setDiagnosticError("");
    void attachContext({ path: issues.length === 1 ? issues[0].path ?? path : path, title, diagnostic: issues.map(issue => `${issue.rule}: ${issue.details}`).join("\n") })
      .catch((error: unknown) => {
        setDiagnosticError(agsdlErrorText(error, t));
      })
      .finally(() => setAttaching(false));
  }}>{t("agsdl.viewer.correctIssue")}</button>;
  const nodeTitle = (item: ViewerCard) => {
    const hasTitle = !!((item.details.displayAnnotations ?? item.details.annotations) as { title?: string } | undefined)?.title;
    if (item.kind === "approval" && item.details.contract !== "agsdl-0.2.0" && !hasTitle) return t("agsdl.viewer.approvalRequired");
    if (item.kind === "end" && !hasTitle) return t(`agsdl.edge.${item.outcome}`, { defaultValue: item.title });
    return item.title || t("agsdl.viewer.unnamed");
  };
  const referenceLabel = (ref: ViewerReference) => {
    const destination = graph?.cards.find((card) => card.path === ref.target);
    return destination?.kind === "end" &&
      !(destination.details.annotations as { title?: string } | undefined)
        ?.title
      ? t(`agsdl.edge.${destination.outcome}`, { defaultValue: ref.label })
      : ref.label;
  };
  const reference = (ref: ViewerReference) => (
    <span className={ref.unresolved ? "agsdl-unresolved" : ""}>
      {ref.source === "input" && (
        <span className="agsdl-muted">{t("agsdl.viewer.graphInput")} · </span>
      )}
      {ref.source === "literal" && (
        <span className="agsdl-muted">{t("agsdl.viewer.literal")} · </span>
      )}
      {ref.target ? (
        <button className="agsdl-link" onClick={() => select(ref.target!)}>
          {referenceLabel(ref)}
        </button>
      ) : (
        ref.label || t("agsdl.viewer.unspecified")
      )}
      {ref.unresolved && <span> · {t("agsdl.viewer.unresolved")}</span>}
    </span>
  );
  const portList = (
    items: ViewerPort[],
    direction: "inputs" | "outputs",
    expanded = false,
    showBindings = true,
  ) =>
    items.length > 0 && (
      <section className="agsdl-ports">
        <h4>{t(`agsdl.viewer.${direction}`)}</h4>
        {items.map((port) => (
          <div className="agsdl-port" key={port.name}>
            <strong>{port.name}</strong>
            {expanded && port.type && (
              <span className="agsdl-muted">{port.type}</span>
            )}
            {showBindings && (direction === "inputs" || port.binding) && (
              <div className="agsdl-provenance">
                {" "}
                ←
                {port.binding
                  ? reference(port.binding)
                  : t("agsdl.viewer.noBinding")}
              </div>
            )}
          </div>
        ))}
      </section>
    );
  const exchangeSummary = (item: ViewerCard) => (
    <div className="agsdl-exchange-summary">
      {(["inputs", "outputs"] as const).map(direction => item[direction].length > 0 && (
        <section key={direction}>
          <h4>{t(`agsdl.viewer.${direction}`)}</h4>
          {item[direction].map(port => <div key={port.name} className="agsdl-exchange-row">
            {port.name}
            {direction === "inputs" && item.kind !== "input" && port.binding &&
              <div className="agsdl-io-origin">{reference(port.binding)}</div>}
            {direction === "inputs" && item.kind !== "input" && !port.binding &&
              <span className="agsdl-muted"> · {t("agsdl.viewer.noBinding")}</span>}
          </div>)}
        </section>
      ))}
    </div>
  );
  const inspect = (item: ViewerCard) => (
    <>
      {["Agent", "invoke", "agent"].includes(item.kind)
        ? <AgentDetails captured={captured} card={item} cards={[...(document?.graphs.flatMap(graph => graph.cards) ?? []), ...(document?.declarations ?? []), ...(document?.legacyCards ?? [])]} source={source!} onSelect={select} />
        : item.mission && <p className="agsdl-mission">{item.mission}</p>}
      {item.composition && <p>{reference(item.composition)}</p>}
      {diagnosticAction(diagnostics.filter(issue => issue.targets.includes(item.path)), item.path, nodeTitle(item))}
      {item.unresolved && <p className="agsdl-unresolved">{t("agsdl.viewer.unresolvedAgent")}</p>}
      {!["Agent", "invoke", "agent"].includes(item.kind) && <>
        {item.interfaces?.length ? <section className="agsdl-ports"><h4>{t("agsdl.viewer.property.interfaces")}</h4>{item.interfaces.map((ref, index) => <div key={index}>{reference(ref)}</div>)}</section> : null}
        {item.dependencies && <section className="agsdl-ports">
          <h4>{t("agsdl.viewer.dependencies")}</h4>
          {item.dependencies.map((ref, index) => <div key={index}>{reference(ref)}</div>)}
          <p className="agsdl-muted">{t("agsdl.viewer.unknownTransfers")}</p>
        </section>}
        {exchangeSummary(item)}
        {item.kind === "approval" && <section className="agsdl-ports">
          {item.approvalCall && <p>{t("agsdl.viewer.actionToApprove")} · {reference(item.approvalCall)}</p>}
          {item.approvalBinding && <p>{reference(item.approvalBinding)}</p>}
          {!item.approvalBinding && <h4>{t("agsdl.viewer.approvers")}</h4>}
          {item.approvalBinding ? null : item.approvers?.length ? item.approvers.map((ref, index) => <div key={index}>{reference(ref)}</div>) : <p className="agsdl-muted">{t("agsdl.viewer.approverMissing")}</p>}
        </section>}
        <details className="agsdl-details">
          <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
          {item.flowInputs?.length ? <section className="agsdl-ports"><h4>{t("agsdl.viewer.detail.inputs")}</h4>
            {item.flowInputs.map((input, index) => <div key={index}>{input.projection} ← {reference(input.reference)}</div>)}
          </section> : null}
          {portList(item.inputs, "inputs", true, item.kind !== "input")}
          {portList(item.outputs, "outputs", true)}
          {item.tools?.length ? <section className="agsdl-ports">
            <h4>{t("agsdl.agentTools")}</h4>
            {item.tools.map((ref, index) => <div key={index}>{reference(ref)}</div>)}
          </section> : null}
          {item.resources?.length ? <section className="agsdl-ports">
            <h4>{t("agsdl.viewer.resources")}</h4>
            {item.resources.map((ref, index) => <div key={index}>{reference(ref)}</div>)}
          </section> : null}
          {item.branches.length > 0 && <section className="agsdl-ports">
            <h4>{t("agsdl.viewer.control")}</h4>
            {item.branches.map((branch, index) => <div key={branch.path ?? `${branch.label}-${index}`}>
              {t(`agsdl.edge.${branch.label}`, { defaultValue: branch.label })} → {reference(branch.reference)}
            </div>)}
          </section>}
          <ReadOnlyValue value={item.details} />
        </details>
      </>}
    </>
  );
  const findings = diagnostics;
  const hasIssues = findings.length > 0 || (document?.unresolved.length ?? 0) > 0;
  const showOverview = !!document;
  return (
    <div className="agsdl-viewer" data-agsdl-plan={target.planId} aria-label={t("agsdl.editor")} onKeyDown={event => { if (event.key === "Escape") { setOverview(false); setSelection(undefined); } }}>
      <header className="agsdl-viewer-header">
        <strong title={document?.title}>{document?.title || t("agsdl.editor")}</strong>
        <div className="agsdl-header-actions">
          <button className="agsdl-icon-button" onClick={() => setExecutionOpen(true)} aria-label={t("agsdl.execution.title")} title={t("agsdl.execution.title")}><Activity size={14} /></button>
          {onExpand && <button className="agsdl-icon-button" onClick={onExpand}
            aria-label={t(expanded ? "agsdl.shrink" : "agsdl.expand")}
            title={t(expanded ? "agsdl.shrink" : "agsdl.expand")}>
            {expanded ? <X size={14} /> : <Maximize2 size={14} />}
          </button>}
          {showOverview && <button className="agsdl-icon-button" aria-label={t("agsdl.viewer.overview")}
            title={t("agsdl.viewer.overview")} aria-pressed={overview}
            onClick={() => { setOverview(!overview); setSelection(undefined); }}><Info size={14} /></button>}
          {source && <button className="agsdl-icon-button" title={t("agsdl.design.saveBlueprint")} aria-label={t("agsdl.design.saveBlueprint")} disabled={session?.saving} onClick={() => setLibrary("save")}><BookOpen size={14} /></button>}

        </div>
        {document && document.graphs.length > 1 && (
          <select
            aria-label={t("agsdl.graph")}
            value={visibleGraphIndex}
            onChange={(event) => {
              setGraphIndex(Number(event.target.value));
              setSelection(undefined);
              setOverview(false);
            }}
          >
            {document.graphs.map((graph, index) => (
              <option key={graph.path} value={index}>
                {graph.title || `${t("agsdl.graph")} ${index + 1}`}
              </option>
            ))}
          </select>
        )}
      </header>
      {executionScoped && execution.snapshot && <div className="agsdl-graph-caption"><button className="agsdl-link" onClick={() => execution.showCaptured(!captured)}>{t(captured ? "agsdl.execution.capture" : exactRun ? "agsdl.execution.sameSource" : sourceConfirmed ? "agsdl.execution.differentSource" : "agsdl.execution.unconfirmedSource")}</button></div>}
      {executionOpen && <ExecutionDialog key={`${key}:${conversationId}:${conversationProjectId}`} target={target} onClose={() => setExecutionOpen(false)} />}
      {(error || session?.error || parsed.error) && (
        <div role="alert" className="agsdl-error">
          {error || (session?.error && t("agsdl.actionFailed")) || (
            <>
              <p>{t("agsdl.viewer.unreadable")}</p>
              <details className="agsdl-details">
                <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
                <p>{parsed.error}</p>
              </details>
            </>
          )}
          {(error || session?.error) && (
            <button
              className="agsdl-link"
              disabled={session?.saving}
              onClick={() => {
                const store = useAgsdlStore.getState();
                // Preserve the agent's unsaved work when retrying a failed save.
                void (session?.dirty ? store.save(target) : store.load(target, true))
                  .then(() => store.validate(target))
                  .then(() => setError(""))
                  .catch((error: unknown) => setError(agsdlErrorText(error, t)));
              }}
            >
              {t("agsdl.retry")}
            </button>
          )}
        </div>
      )}
      {!session ? <div className="agsdl-empty">{t("agsdl.loading")}</div>
        : !source ? session.status === "draft" && (!planStatus || planStatus === "draft") ? <DesignStart onChoose={setLibrary} /> : <div className="agsdl-empty">{t("agsdl.emptyTitle")}</div>
        : document && <>
          {cards.length > 0 ? <WorkflowGraph
            key={`${key}:${captured ? execution.snapshot!.systemStartId : "current"}:${graph?.path ?? "declarations"}`}
            cards={cards} edges={system.edges} selected={selected}
            trackedTasks={trackedTasks} nativeActivations={nativeActivations}
            select={select} title={nodeTitle} source={source}
            changedPaths={showChanges ? review?.changes.flatMap(change => change.path ? [change.path] : []) : []}
          /> : <div className="agsdl-start"><h3>{document.title}</h3><p>{t("agsdl.design.emptySystem")}</p><button onClick={() => setDesignOpen(true)}>{t("agsdl.design.settings")}</button></div>}
          {(document.migrated || !graph) && <div className="agsdl-graph-caption">
            {t(document.migrated ? "agsdl.viewer.dependencies" : "agsdl.viewer.declarative")}
          </div>}
          {(selectedCard || selectedEdge || overview) && <ComponentDetailsDialog
            key={selectedCard?.path ?? selectedEdge?.id ?? "overview"}
            title={selectedCard ? nodeTitle(selectedCard) : selectedEdge ? t(selectedEdge.dependency ? "agsdl.viewer.dependencies" : "agsdl.viewer.connection") : document.title}
            card={selectedCard} canEdit={!captured && !attaching && selectedCard === currentCard && (!planStatus || planStatus === "draft")} target={target}
            onBack={previousSelection ? goBack : undefined}
            onAttach={!attaching && ((selectedCard && selectedCard === currentCard) || selectedEdge || overview) ? () => attachContext(selectedCard
              ? { path: selectedCard.path, title: nodeTitle(selectedCard) }
              : selectedEdge ? { path: selectedEdge.source, relatedPaths: [selectedEdge!.target], title: `${selectedEdge!.label}: ${nodeTitle(cards.find(card => card.path === selectedEdge!.source)!)} → ${nodeTitle(cards.find(card => card.path === selectedEdge!.target)!)}` }
              : { path: "", title: document.title, diagnostic: findings.length ? findings.map(issue => `${issue.rule}: ${issue.details}`).join("\n") : undefined }) : undefined}
            onClose={() => { setOverview(false); setSelection(undefined); setDiagnosticError(""); }}>
            <section className="agsdl-inspector" aria-label={t("agsdl.properties")}>
              {diagnosticError && <p role="alert" className="agsdl-unresolved">{diagnosticError}</p>}
              {selectedCard && nativeActivations[selectedCard.path] && <section className="agsdl-ports">
                <h4>{t(nativeActivations[selectedCard.path].partial ? "agsdl.execution.partial" : `agsdl.execution.state.${nativeActivations[selectedCard.path].state}`)}</h4>
                {nativeActivations[selectedCard.path].activations.map((activation, index) => <div key={activation.work.activationId} className="agsdl-execution-actions">
                  <span>{t("agsdl.execution.activationNumber", { number: index + 1 })} · {t(`agsdl.execution.state.${nativeActivationState(activation, execution.approvals?.approvals ?? [])}`)}</span>
                  <button className="agsdl-link" disabled={attaching || execution.busy || execution.stale} onClick={() => {
                    setAttaching(true);
                    void prepareAgsdlRuntimeContext({ ...target, systemStartId: execution.snapshot!.systemStartId, source: execution.snapshot!.source,
                      activationId: activation.work.activationId, cursor: execution.projection!.cursor, path: selectedCard.path, title: nodeTitle(selectedCard) })
                      .catch(error => notify.error(t("agsdl.staleChatSelection"), { description: agsdlErrorText(error, t) })).finally(() => setAttaching(false));
                  }}>{t("agsdl.attachToChat")}</button>
                  {activation.workState !== "terminal" && <button className="agsdl-link" disabled={execution.stopping} onClick={() => void execution.stop(activation.work.activationId)}>{t("agsdl.execution.stop")}</button>}
                </div>)}
              </section>}
              {selectedCard && (captured || exactRun) && execution.cardTask && execution.cardTask.run === inspectedRun && execution.cardTask.path === selectedCard.path && execution.cardTask.resolved && <button className="agsdl-link" onClick={() => {
                void execution.openTask(selectedCard.path).catch(error => notify.info(agsdlErrorText(error, t, "agsdl.execution.taskUnavailable")));
              }}>{t("agsdl.execution.openTask")}</button>}
              {selectedCard ? inspect(selectedCard) : selectedEdge ? <>
                <p>{reference({ source: "step", label: nodeTitle(cards.find(card => card.path === selectedEdge.source)!), target: selectedEdge.source })}
                  {" → "}{reference({ source: "step", label: nodeTitle(cards.find(card => card.path === selectedEdge.target)!), target: selectedEdge.target })}</p>
                <p>{t(selectedEdge.exchangeOnly ? "agsdl.designGraph.transfer" : selectedEdge.dependency ? "agsdl.designGraph.dependency" : "agsdl.designGraph.sequence")}</p>
                {["true", "false"].includes(selectedEdge.label) && <p>{t(`agsdl.edge.${selectedEdge.label}`)}</p>}
                {selectedEdge.transfers?.length ? <section className="agsdl-ports">
                  <h4>{t("agsdl.viewer.transfers")}</h4>
                  {selectedEdge.transfers.map(name => <div key={name}>{name}</div>)}
                </section> : <p className="agsdl-muted">{t("agsdl.viewer.noTransfer")}</p>}
              </> : <>
                <section className="agsdl-design-summary">
                  {design?.purpose && <p>{design.purpose}</p>}
                  <div className="agsdl-system-summary"><Layers size={16} /><span>{t("agsdl.designGraph.members", { count: cards.length })}</span></div>
                  {hasIssues && <button className="agsdl-link agsdl-design-pending" disabled={attaching} onClick={() => {
                    setAttaching(true); setDiagnosticError("");
                    void attachContext({ path: "", title: document.title, diagnostic: [...findings.map(issue => `${issue.rule}: ${issue.details}`), ...document.unresolved.map(item => JSON.stringify(item))].join("\n") })
                      .catch(error => setDiagnosticError(agsdlErrorText(error, t))).finally(() => setAttaching(false));
                  }}><MessageSquarePlus size={14} />{t("agsdl.reviewWithAI")}</button>}
                  {pendingRequirements.length > 0 && <button className="agsdl-design-pending agsdl-link" onClick={() => { setOverview(false); setDesignOpen(true); }}><CircleAlert size={13} />{t("agsdl.design.pending", { count: pendingRequirements.length })}</button>}
                  <button className="agsdl-action-button" onClick={() => { setOverview(false); setDesignOpen(true); }}>{t("agsdl.design.settings")}</button>
                </section>
              </>}
            </section>
          </ComponentDetailsDialog>}
        </>}
      {library && session && <DesignLibraryDialog key={`${key}:${library}`} target={target} mode={library} onClose={() => setLibrary(undefined)} onCreated={() => {
        const created = useAgsdlStore.getState().sessions[key];
        try {
          if (created && readDesign(created.source, created.design).requirements.some(item => !item.value.trim())) setDesignOpen(true);
        } catch { setError(t("agsdl.viewer.unreadable")); }
      }} />}
      {designOpen && session && <SystemDesignDialog key={key} target={target} canEdit={!captured && (!planStatus || planStatus === "draft")} onAttach={() => attachContext({ path: "", title: document?.title || t("agsdl.design.settings") })} onClose={() => setDesignOpen(false)} />}
      {changesOpen && review && <DesignChangesDialog review={review} onClose={() => setChangesOpen(false)} onSelect={path => {
        const index = document?.graphs.findIndex(graph => graph.cards.some(card => card.path === path)) ?? -1;
        if (index >= 0) setGraphIndex(index);
        select(path);
      }} onUndo={() => void changeHistory()} canUndo={session?.status === "draft" && !session.saving && (!planStatus || planStatus === "draft")} />}
      {showChanges && <div className="agsdl-change-notice"><button onClick={() => setChangesOpen(true)}>{t("agsdl.design.changes")}</button><button className="agsdl-icon-button" onClick={() => setDismissedVersion(session!.version)} aria-label={t("agsdl.design.dismissChanges")}><X size={12} /></button></div>}
      {(session?.saving || session?.dirty) && <footer className="agsdl-status" role="status">
        {t(session.saving ? "agsdl.saving" : "agsdl.unsaved")}
      </footer>}
    </div>
  );
};

function ReadOnlyValue({ value }: { value: unknown }): React.ReactNode {
  if (value === null || typeof value !== "object")
    return <span className="agsdl-value">{String(value)}</span>;
  return (
    <dl className="agsdl-properties">
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <ReadOnlyValue value={item} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
