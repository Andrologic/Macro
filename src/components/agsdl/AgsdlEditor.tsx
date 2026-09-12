import React, { useEffect, useMemo, useState } from "react";
import { BookOpen, CircleAlert, Info, Maximize2, X, Undo2, Redo2 } from "lucide-react";
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
import { prepareAgsdlChatContext } from "../../services/agsdl/chatContext";

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
  const [error, setError] = useState("");
  const [overview, setOverview] = useState(false);
  const [library, setLibrary] = useState<"start" | "blueprint" | "system" | "save">();
  const [designOpen, setDesignOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState("");
  const [graphIndex, setGraphIndex] = useState(0);
  const [selection, setSelection] = useState<{ key: string; path: string; card?: ViewerCard }>();
  useEffect(() => {
    let active = true;
    useAgsdlStore
      .getState()
      .load(target)
      .then(() => {
        if (active) setError("");
      })
      .catch((error: unknown) => {
        if (active) setError(String(error));
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
    } catch (error) { setError(String(error)); }
  };
  const source = session?.source;
  const design = useMemo(() => {
    try { return source ? readDesign(source) : undefined; } catch { return undefined; }
  }, [source]);
  const review = useMemo(() => session?.history.length ? reviewDesignChanges(session.history.at(-1)!.source, session.source) : undefined, [session]);
  const showChanges = !!review && session?.version !== dismissedVersion;
  const pendingRequirements = design?.requirements.filter(item => !item.value.trim()) ?? [];
  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(() => void useAgsdlStore.getState().validate(target), 250);
    return () => clearTimeout(timer);
  }, [source, target]);
  const parsed = useMemo(() => {
    if (!source) return {};
    try {
      return { document: projectViewer(source) };
    } catch (error) {
      return { error: String(error) };
    }
  }, [source]);
  const document = parsed.document;
  const visibleGraphIndex = Math.min(graphIndex, Math.max(0, (document?.graphs.length ?? 0) - 1));
  const graph = document?.graphs[visibleGraphIndex];
  const selected = selection?.key === key ? selection.path : "";
  const system = useMemo(() => projectSystemOverview(graph, document?.legacyCards.length
    ? document.legacyCards : document?.declarations.filter(item => ["Agent", "System"].includes(item.kind)) ?? []), [graph, document]);
  const diagnostics = useMemo(() => source && document ? localizeDiagnostics(source, session?.reports ?? [], [...document.graphs.flatMap(graph => graph.cards), ...document.declarations, ...document.legacyCards]) : [], [source, document, session?.reports]);
  const cards = useMemo(() => system.cards.map(card => ({ ...card, issueCount: diagnostics.filter(issue => issue.targets.includes(card.path)).length })), [system.cards, diagnostics]);
  const selectedEdge = system.edges.find(edge => edge.id === selected);
  const currentCard = cards.find(item => item.path === selected) ?? graph?.cards.find(item => item.path === selected) ?? document?.declarations.find(item => item.path === selected);
  // Keep an open form alive if an agent removes its component. Its captured
  // version will reject saving; the user's text remains available to copy.
  const snapshotCard = selection?.key === key ? selection.card : undefined;
  const selectedCard = snapshotCard && (!currentCard || currentCard.id !== snapshotCard.id) ? snapshotCard : currentCard;
  const select = (path: string) => {
    setDiagnosticError("");
    setSelection({ key, path, card: cards.find(item => item.path === path) ?? graph?.cards.find(item => item.path === path) ?? document?.declarations.find(item => item.path === path) });
    setOverview(false);
  };
  const attachContext = async (selection: Parameters<typeof prepareAgsdlChatContext>[1]) => {
    await prepareAgsdlChatContext(target, selection);
    setOverview(false);
    setSelection(undefined);
    if (expanded) onExpand?.();
  };
  const diagnosticAction = (issue: LocalizedDiagnostic, title: string) => issue.path !== undefined && <button className="agsdl-link" disabled={attaching} onClick={() => {
    setAttaching(true); setDiagnosticError("");
    void attachContext({ path: issue.path!, title, diagnostic: `${issue.rule}: ${issue.details}` })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setDiagnosticError(t(message, { defaultValue: message }));
      })
      .finally(() => setAttaching(false));
  }}>{t("agsdl.viewer.correctIssue")}</button>;
  const nodeTitle = (item: ViewerCard) => {
    const hasTitle = !!((item.details.displayAnnotations ?? item.details.annotations) as { title?: string } | undefined)?.title;
    if (item.kind === "approval" && !hasTitle) return t("agsdl.viewer.approvalRequired");
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
            {direction === "inputs" && item.kind !== "input" && port.binding
              ? reference(port.binding) : port.name}
            {direction === "inputs" && item.kind !== "input" && !port.binding &&
              <span className="agsdl-muted"> · {t("agsdl.viewer.noBinding")}</span>}
          </div>)}
        </section>
      ))}
    </div>
  );
  const inspect = (item: ViewerCard) => (
    <>
      {["Agent", "invoke"].includes(item.kind)
        ? <AgentDetails card={item} cards={[...(document?.graphs.flatMap(graph => graph.cards) ?? []), ...(document?.declarations ?? []), ...(document?.legacyCards ?? [])]} source={source!} onSelect={select} />
        : item.mission && <p className="agsdl-mission">{item.mission}</p>}
      {diagnostics.filter(issue => issue.targets.includes(item.path)).map((issue, index) => <div key={index}><p className="agsdl-unresolved">{issue.details}</p>{diagnosticAction(issue, nodeTitle(item))}</div>)}
      {item.unresolved && <p className="agsdl-unresolved">{t("agsdl.viewer.unresolvedAgent")}</p>}
      {!["Agent", "invoke"].includes(item.kind) && <>
        {item.interfaces?.length ? <section className="agsdl-ports"><h4>{t("agsdl.viewer.property.interfaces")}</h4>{item.interfaces.map((ref, index) => <div key={index}>{reference(ref)}</div>)}</section> : null}
        {item.dependencies && <section className="agsdl-ports">
          <h4>{t("agsdl.viewer.dependencies")}</h4>
          {item.dependencies.map((ref, index) => <div key={index}>{reference(ref)}</div>)}
          <p className="agsdl-muted">{t("agsdl.viewer.unknownTransfers")}</p>
        </section>}
        {exchangeSummary(item)}
        {item.kind === "approval" && <section className="agsdl-ports">
          {item.approvalCall && <p>{t("agsdl.viewer.actionToApprove")} · {reference(item.approvalCall)}</p>}
          <h4>{t("agsdl.viewer.approvers")}</h4>
          {item.approvers?.length ? item.approvers.map((ref, index) => <div key={index}>{reference(ref)}</div>) : <p className="agsdl-muted">{t("agsdl.viewer.approverMissing")}</p>}
        </section>}
        <details className="agsdl-details">
          <summary>{t("agsdl.viewer.technicalDetails")}</summary>
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
            {item.branches.map(branch => <div key={branch.label}>
              {t(`agsdl.edge.${branch.label}`)} → {reference(branch.reference)}
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
          {onExpand && <button className="agsdl-icon-button" onClick={onExpand}
            aria-label={t(expanded ? "agsdl.shrink" : "agsdl.expand")}
            title={t(expanded ? "agsdl.shrink" : "agsdl.expand")}>
            {expanded ? <X size={14} /> : <Maximize2 size={14} />}
          </button>}
          {showOverview && <button className="agsdl-icon-button" aria-label={t(hasIssues ? "agsdl.diagnostics" : "agsdl.viewer.overview")}
            title={t(hasIssues ? "agsdl.diagnostics" : "agsdl.viewer.overview")} aria-pressed={overview}
            onClick={() => { setOverview(!overview); setSelection(undefined); }}>
            {hasIssues ? <CircleAlert size={14} className="agsdl-unresolved" /> : <Info size={14} />}
          </button>}
          {source && <button className="agsdl-icon-button" title={t("agsdl.design.saveBlueprint")} aria-label={t("agsdl.design.saveBlueprint")} disabled={session?.saving} onClick={() => setLibrary("save")}><BookOpen size={14} /></button>}
          {session?.status === "draft" && (!planStatus || planStatus === "draft") && <>
            <button className="agsdl-icon-button" title={t("agsdl.undo")} aria-label={t("agsdl.undo")} disabled={session.saving || !session.history.length} onClick={() => void changeHistory()}><Undo2 size={14} /></button>
            <button className="agsdl-icon-button" title={t("agsdl.redo")} aria-label={t("agsdl.redo")} disabled={session.saving || !session.future.length} onClick={() => void changeHistory(true)}><Redo2 size={14} /></button>
          </>}
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
      {(error || session?.error || parsed.error) && (
        <div role="alert" className="agsdl-error">
          {error || session?.error || (
            <>
              <p>{t("agsdl.viewer.unreadable")}</p>
              <details className="agsdl-details">
                <summary>{t("agsdl.viewer.technicalDetails")}</summary>
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
                  .catch((error: unknown) => setError(String(error)));
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
            key={`${key}:${graph?.path ?? "declarations"}`}
            cards={cards} edges={system.edges} selected={selected}
            select={select} title={nodeTitle} source={source}
            changedPaths={showChanges ? review?.changes.flatMap(change => change.path ? [change.path] : []) : []}
          /> : <div className="agsdl-start"><h3>{document.title}</h3><p>{t("agsdl.design.emptySystem")}</p><button onClick={() => setDesignOpen(true)}>{t("agsdl.design.settings")}</button></div>}
          {(document.migrated || !graph) && <div className="agsdl-graph-caption">
            {t(document.migrated ? "agsdl.viewer.dependencies" : "agsdl.viewer.declarative")}
          </div>}
          {(selectedCard || selectedEdge || overview) && <ComponentDetailsDialog
            key={selectedCard?.path ?? selectedEdge?.id ?? "overview"}
            title={selectedCard ? nodeTitle(selectedCard) : selectedEdge ? t(selectedEdge.dependency ? "agsdl.viewer.dependencies" : "agsdl.viewer.connection") : document.title}
            card={selectedCard} canEdit={!attaching && selectedCard === currentCard && (!planStatus || planStatus === "draft")} target={target}
            onAttach={!attaching && ((selectedCard && selectedCard === currentCard) || selectedEdge) ? () => attachContext(selectedCard
              ? { path: selectedCard.path, title: nodeTitle(selectedCard) }
              : { path: selectedEdge!.source, relatedPaths: [selectedEdge!.target], title: `${selectedEdge!.label}: ${nodeTitle(cards.find(card => card.path === selectedEdge!.source)!)} → ${nodeTitle(cards.find(card => card.path === selectedEdge!.target)!)}` }) : undefined}
            onClose={() => { setOverview(false); setSelection(undefined); setDiagnosticError(""); }}>
            <section className="agsdl-inspector" aria-label={t("agsdl.properties")}>
              {diagnosticError && <p role="alert" className="agsdl-unresolved">{diagnosticError}</p>}
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
                  {pendingRequirements.length > 0 && <span className="agsdl-design-pending"><CircleAlert size={13} />{t("agsdl.design.pending", { count: pendingRequirements.length })}</span>}
                  <button className="agsdl-link" onClick={() => { setOverview(false); setDesignOpen(true); }}>{t("agsdl.design.settings")}</button>
                  {design?.context && <details className="agsdl-details"><summary>{t("agsdl.design.context")}</summary><p>{design.context}</p></details>}
                  {!!design?.rules.length && <details className="agsdl-details"><summary>{t("agsdl.design.rules")} · {design.rules.length}</summary>{design.rules.map(rule => <div key={rule.id}><strong>{rule.title}</strong><p>{rule.instructions}</p></div>)}</details>}
                </section>
                {document.migrated && <p>{t("agsdl.viewer.migrationNote")}</p>}
                {document.migrationIssues.filter(issue => issue !== "execution-not-migrated").map(issue => <p key={issue}>{t(`agsdl.viewer.issues.${issue}`, { defaultValue: issue })}</p>)}
                {graph && <>
                  <p>{t("agsdl.viewer.entry")} → {reference(graph.entry)}</p>
                  {portList(graph.inputs, "inputs", false, false)}
                  {portList(graph.outputs, "outputs", false, false)}
                </>}
                {document.declarations.filter(item => item.kind === "Resource").length > 0 && <details className="agsdl-details">
                  <summary>{t("agsdl.viewer.resources")}</summary>
                  {document.declarations.filter(item => item.kind === "Resource").map(item => <div key={item.path}>{reference({ label: nodeTitle(item), target: item.path, source: "unknown" })}</div>)}
                </details>}
                <details className="agsdl-details"><summary>{t("agsdl.viewer.technicalDetails")}</summary><ReadOnlyValue value={document.systemDetails} /></details>
                <details className="agsdl-details"><summary>{t("agsdl.allDeclarations")} · {document.declarations.length}</summary>
                  {document.declarations.map(item => <div key={item.path}><button className="agsdl-link" onClick={() => select(item.path)}>{nodeTitle(item)} · {t(`agsdl.kind.${item.kind}`, { defaultValue: item.kind })}</button></div>)}
                </details>
                {document.dependencies.length > 0 && <details className="agsdl-details"><summary>{t("agsdl.dependencies")}</summary><ReadOnlyValue value={document.dependencies} /></details>}
                {document.unresolved.length > 0 && <details className="agsdl-details"><summary>{t("agsdl.viewer.unresolved")}</summary><ReadOnlyValue value={document.unresolved} /></details>}
                {findings.length > 0 && <details className="agsdl-details"><summary>{t("agsdl.diagnostics")} · {findings.length}</summary>
                  {findings.map((finding, index) => <div key={index}><p><strong>{finding.rule}</strong> {finding.details}</p>
                    {diagnosticAction(finding, document.title)}
                    {finding.targets.map(path => <button className="agsdl-link" key={path} onClick={() => {
                      const index = document.graphs.findIndex(graph => graph.cards.some(card => card.path === path));
                      if (index >= 0) setGraphIndex(index);
                      select(path);
                    }}>{t("agsdl.viewer.locateIssue")} · {document.graphs.flatMap(graph => graph.cards).concat(document.declarations, document.legacyCards).find(card => card.path === path)?.title || path}</button>)}
                  </div>)}
                </details>}
              </>}
            </section>
          </ComponentDetailsDialog>}
        </>}
      {library && session && <DesignLibraryDialog key={`${key}:${library}`} target={target} mode={library} onClose={() => setLibrary(undefined)} />}
      {designOpen && session && <SystemDesignDialog key={key} target={target} canEdit={!planStatus || planStatus === "draft"} onClose={() => setDesignOpen(false)} />}
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
