import React, { useEffect, useMemo, useState } from "react";
import { CircleAlert, Info, Maximize2, X } from "lucide-react";
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
import { projectSystemOverview } from "../../services/agsdl/systemOverview";
import "./agsdl.css";

// Keep the integration contract while the document is edited exclusively through chat.
export const AgsdlEditor: React.FC<{
  target: AgsdlTarget;
  planStatus?: string;
  expanded?: boolean;
  onExpand?: () => void;
}> = ({ target, expanded, onExpand }) => {
  const { t } = useAgsdlTranslation();
  const key = agsdlSessionKey(target);
  const session = useAgsdlStore((state) => state.sessions[key]);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState(false);
  const [graphIndex, setGraphIndex] = useState(0);
  const [selection, setSelection] = useState<{ key: string; path: string }>();
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
  const source = session?.source;
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
  const cards = system.cards;
  const selectedEdge = system.edges.find(edge => !edge.exchangeOnly && edge.id === selected);
  const selectedCard = cards.find(item => item.path === selected) ?? graph?.cards.find(item => item.path === selected) ?? document?.declarations.find(item => item.path === selected);
  const select = (path: string) => {
    setSelection({ key, path });
    setOverview(false);
  };
  const nodeTitle = (item: ViewerCard) => {
    const hasTitle = !!(item.details.annotations as { title?: string } | undefined)?.title;
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
      {item.mission && <p className="agsdl-mission" title={item.mission}>{item.mission}</p>}
      {item.unresolved && <p className="agsdl-unresolved">{t("agsdl.viewer.unresolvedAgent")}</p>}
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
        {item.mission && <p>{item.mission}</p>}
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
    </>
  );
  const findings =
    session?.reports.flatMap((report) =>
      report.results.flatMap((result) => result.findings),
    ) ?? [];
  const hasIssues = findings.length > 0 || (document?.unresolved.length ?? 0) > 0;
  const showOverview = !!document;
  return (
    <div className="agsdl-viewer" aria-label={t("agsdl.editor")} onKeyDown={event => { if (event.key === "Escape") { setOverview(false); setSelection(undefined); } }}>
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
        : !source ? <div className="agsdl-empty"><strong>{t("agsdl.emptyTitle")}</strong><p>{t("agsdl.emptyDescription")}</p></div>
        : document && <>
          {cards.length > 0 ? <WorkflowGraph
            key={`${key}:${graph?.path ?? "declarations"}`}
            cards={cards} edges={system.edges} selected={selected}
            select={select} title={nodeTitle}
          /> : <div className="agsdl-empty">{t("agsdl.noGraph")}</div>}
          {(document.migrated || !graph) && <div className="agsdl-graph-caption">
            {t(document.migrated ? "agsdl.viewer.dependencies" : "agsdl.viewer.declarative")}
          </div>}
          {(selectedCard || selectedEdge || overview) && <section key={selectedCard?.path ?? selectedEdge?.id ?? "overview"} className={`agsdl-inspector${selectedCard || selectedEdge ? " is-node-inspector" : ""}`} aria-label={t("agsdl.properties")}>
            <header>
              <strong>{selectedCard ? nodeTitle(selectedCard) : selectedEdge ? t(selectedEdge.dependency ? "agsdl.viewer.dependencies" : "agsdl.viewer.connection") : document.title}</strong>
              <button className="agsdl-icon-button" onClick={() => { setOverview(false); setSelection(undefined); }} aria-label={t("agsdl.close")}><X size={14} /></button>
            </header>
            <div className="agsdl-inspector-body">
              {selectedCard ? inspect(selectedCard) : selectedEdge ? <>
                <p>{reference({ source: "step", label: nodeTitle(cards.find(card => card.path === selectedEdge.source)!), target: selectedEdge.source })}
                  {" → "}{reference({ source: "step", label: nodeTitle(cards.find(card => card.path === selectedEdge.target)!), target: selectedEdge.target })}</p>
                {!selectedEdge.dependency && <p>{t(`agsdl.edge.${selectedEdge.label}`, { defaultValue: selectedEdge.label })}</p>}
                {selectedEdge.transfers?.length ? <section className="agsdl-ports">
                  <h4>{t("agsdl.viewer.transfers")}</h4>
                  {selectedEdge.transfers.map(name => <div key={name}>{name}</div>)}
                </section> : <p className="agsdl-muted">{t("agsdl.viewer.noTransfer")}</p>}
              </> : <>
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
                  {document.declarations.map(item => <details key={item.path} className="agsdl-details"><summary>{nodeTitle(item)}</summary>{inspect(item)}</details>)}
                </details>
                {document.dependencies.length > 0 && <details className="agsdl-details"><summary>{t("agsdl.dependencies")}</summary><ReadOnlyValue value={document.dependencies} /></details>}
                {document.unresolved.length > 0 && <details className="agsdl-details"><summary>{t("agsdl.viewer.unresolved")}</summary><ReadOnlyValue value={document.unresolved} /></details>}
                {findings.length > 0 && <details className="agsdl-details"><summary>{t("agsdl.diagnostics")} · {findings.length}</summary>
                  {findings.map((finding, index) => <p key={index}><strong>{finding.rule}</strong> {finding.details}</p>)}
                </details>}
              </>}
            </div>
          </section>}
        </>}
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
