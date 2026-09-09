import React, { useEffect, useMemo, useState } from "react";
import { Info, Maximize2, Minimize2, X } from "lucide-react";
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
    ? document.legacyCards : document?.declarations.filter(item => item.kind === "Agent") ?? []), [graph, document]);
  const cards = system.cards;
  const selectedCard = cards.find(item => item.path === selected) ?? graph?.cards.find(item => item.path === selected);
  const select = (path: string) => {
    setSelection({ key, path });
    setOverview(false);
  };
  const nodeTitle = (item: ViewerCard) => {
    if (item.kind === "input") return t("agsdl.viewer.systemInput");
    const hasTitle = !!(item.details.annotations as { title?: string } | undefined)?.title;
    if (item.kind === "output" && !hasTitle) return t(item.outputs.length ? "agsdl.viewer.systemOutput" : "agsdl.viewer.systemEnd");
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
  const inspect = (item: ViewerCard) => (
    <>
      {item.mission && <p className="agsdl-mission">{item.mission}</p>}
      {item.unresolved && <p className="agsdl-unresolved">{t("agsdl.viewer.unresolvedAgent")}</p>}
      {item.dependencies && <section className="agsdl-ports">
        <h4>{t("agsdl.viewer.dependencies")}</h4>
        {item.dependencies.map((ref, index) => <div key={index}>{reference(ref)}</div>)}
        <p className="agsdl-muted">{t("agsdl.viewer.unknownTransfers")}</p>
      </section>}
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
      {item.kind === "approval" && <section className="agsdl-ports">
        {item.approvalCall && <p>{t("agsdl.viewer.actionToApprove")} · {reference(item.approvalCall)}</p>}
        <h4>{t("agsdl.viewer.approvers")}</h4>
        {item.approvers?.length ? item.approvers.map((ref, index) => <div key={index}>{reference(ref)}</div>) : <p className="agsdl-muted">{t("agsdl.viewer.approverMissing")}</p>}
      </section>}
      <details className="agsdl-details">
        <summary>{t("agsdl.viewer.technicalDetails")}</summary>
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
  return (
    <div className="agsdl-viewer" aria-label={t("agsdl.editor")}>
      <header className="agsdl-viewer-header">
        <strong title={document?.title}>{document?.title || t("agsdl.editor")}</strong>
        <div className="agsdl-header-actions">
          {onExpand && <button className="agsdl-icon-button" onClick={onExpand}
            aria-label={t(expanded ? "agsdl.shrink" : "agsdl.expand")}
            title={t(expanded ? "agsdl.shrink" : "agsdl.expand")}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>}
          {document && <button className="agsdl-icon-button" aria-label={t("agsdl.viewer.overview")}
            title={t("agsdl.viewer.overview")} aria-pressed={overview}
            onClick={() => { setOverview(!overview); setSelection(undefined); }}><Info size={14} /></button>}
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
          <div className="agsdl-graph-caption">
            {document.migrated ? t("agsdl.viewer.dependencies") : graph ? t("agsdl.viewer.exchangeHint") : t("agsdl.viewer.declarative")}
            {findings.length > 0 && <button className="agsdl-link" onClick={() => { setOverview(true); setSelection(undefined); }}>{t("agsdl.diagnostics")} · {findings.length}</button>}
          </div>
          {(selectedCard || overview) && <section className="agsdl-inspector" aria-label={t("agsdl.properties")}>
            <header>
              <strong>{selectedCard ? nodeTitle(selectedCard) : graph?.title || document.title}</strong>
              <button className="agsdl-icon-button" onClick={() => { setOverview(false); setSelection(undefined); }} aria-label={t("agsdl.close")}><X size={14} /></button>
            </header>
            <div className="agsdl-inspector-body">
              {selectedCard ? inspect(selectedCard) : <>
                <p className="agsdl-muted">{t("agsdl.viewer.chatHint")}</p>
                {document.migrated && <p>{t("agsdl.viewer.migrationNote")}</p>}
                {document.migrationIssues.filter(issue => issue !== "execution-not-migrated").map(issue => <p key={issue}>{t(`agsdl.viewer.issues.${issue}`, { defaultValue: issue })}</p>)}
                {graph && <>
                  <p>{t("agsdl.viewer.entry")} → {reference(graph.entry)}</p>
                  {portList(graph.inputs, "inputs", true)}
                  {portList(graph.outputs, "outputs", true)}
                </>}
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
      <footer className="agsdl-status" aria-live="polite">
        {session?.saving ? t("agsdl.saving") : session?.dirty ? t("agsdl.unsaved") : t("agsdl.viewer.authoring")}
      </footer>
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
