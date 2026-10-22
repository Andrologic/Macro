import { SaveSystemDialog } from "./SaveSystemDialog";
import { DisclosureSummary } from "./DisclosureSummary";
import React, { useEffect, useMemo, useState } from "react";
import { Download, Save, Maximize2, X } from "lucide-react";
import { DesignLibraryDialog, DesignStart } from "./DesignLibraryDialog";
import { DesignChangesDialog } from "./DesignChangesDialog";
import { reviewDesignChanges } from "../../services/agsdl/designReview";
import { AgentDetails } from "./AgentDetails";
import { ComponentDetailsDialog } from "./ComponentDetailsDialog";
import { WorkflowEdgeSummary } from "./WorkflowEdge";
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
  const demoJourney = import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1';
  const persistenceTitle = t(demoJourney ? 'agsdl.persistence.export' : 'agsdl.persistence.title');
  const key = agsdlSessionKey(target);
  const session = useAgsdlStore((state) => state.sessions[key]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [error, setError] = useState("");
  const [library, setLibrary] = useState<"start" | "blueprint" | "system">();
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
  const source = session?.source;
  const displayMetadata = session?.display;
  const migrationMetadata = session?.migration;
  const review = useMemo(() => session?.history.length ? reviewDesignChanges(session.history.at(-1)!.source, session.source, session.history.at(-1), session) : undefined, [session]);
  const showChanges = !!review && (review.changes.length > 0 || review.design || review.configuration || review.other) && session?.version !== dismissedVersion;
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
    const card = cards.find(item => item.path === path) ?? graph?.cards.find(item => item.path === path) ?? document?.declarations.find(item => item.path === path);
    setSelection(current => !path ? undefined : {
      key, path, card,
      trail: current?.key === key && current.path && current.path !== path
        ? [...(current.trail ?? []), { key, path: current.path, card: current.card }].slice(-20)
        : current?.key === key ? current.trail : [],
    });
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
    await prepareAgsdlChatContext(target, selection);
    setSelection(undefined);
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
        ? <AgentDetails card={item} cards={[...(document?.graphs.flatMap(graph => graph.cards) ?? []), ...(document?.declarations ?? []), ...(document?.legacyCards ?? [])]} source={source!} onSelect={select} />
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
  return (
    <div className="agsdl-viewer" data-agsdl-plan={target.planId} aria-label={t("agsdl.editor")} onKeyDown={event => { if (event.key === "Escape") { setSelection(undefined); } }}>
      <header className="agsdl-viewer-header">
        <strong title={document?.title}>{document?.title || t("agsdl.editor")}</strong>
        <div className="agsdl-header-actions">
          {source && <button className="agsdl-icon-button" title={persistenceTitle} aria-label={persistenceTitle} onClick={() => setSaveOpen(true)}>{demoJourney ? <Download size={14} /> : <Save size={14} />}</button>}
          {onExpand && <button className="agsdl-icon-button" onClick={onExpand}
            aria-label={t(expanded ? "agsdl.shrink" : "agsdl.expand")}
            title={t(expanded ? "agsdl.shrink" : "agsdl.expand")}>
            {expanded ? <X size={14} /> : <Maximize2 size={14} />}
          </button>}
        </div>
        {document && document.graphs.length > 1 && (
          <select
            aria-label={t("agsdl.graph")}
            value={visibleGraphIndex}
            onChange={(event) => {
              setGraphIndex(Number(event.target.value));
              setSelection(undefined);
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
            key={`${key}:${graph?.path ?? "declarations"}`}
            cards={cards} edges={system.edges} selected={selected}
            select={select} title={nodeTitle} source={source}
            onAttach={!attaching ? path => {
              const card = cards.find(item => item.path === path);
              if (!card) return;
              setAttaching(true);
              void attachContext({ path, title: nodeTitle(card) }).catch((error: unknown) => {
                select(path); setDiagnosticError(agsdlErrorText(error, t));
              }).finally(() => setAttaching(false));
            } : undefined}
            changedPaths={showChanges ? review?.changes.flatMap(change => change.path ? [change.path] : []) : []}
          /> : <div className="agsdl-start"><h3>{document.title}</h3><p>{t("agsdl.design.emptySystem")}</p></div>}
          {(document.migrated || !graph) && <div className="agsdl-graph-caption">
            {t(document.migrated ? "agsdl.viewer.dependencies" : "agsdl.viewer.declarative")}
          </div>}
          {(selectedCard || selectedEdge) && <ComponentDetailsDialog
            key={selectedCard?.path ?? selectedEdge!.id}
            title={selectedCard ? nodeTitle(selectedCard) : selectedEdge ? t(selectedEdge.dependency ? "agsdl.viewer.dependencies" : "agsdl.viewer.connection") : document.title}
            card={selectedCard} canEdit={!attaching && selectedCard === currentCard && (!planStatus || planStatus === "draft")} target={target}
            onBack={previousSelection ? goBack : undefined}
            onAttach={!attaching && ((selectedCard && selectedCard === currentCard) || selectedEdge) ? () => attachContext(selectedCard
              ? { path: selectedCard.path, title: nodeTitle(selectedCard) }
              : selectedEdge ? { path: selectedEdge.source, relatedPaths: [selectedEdge!.target], title: `${selectedEdge!.label}: ${nodeTitle(cards.find(card => card.path === selectedEdge!.source)!)} → ${nodeTitle(cards.find(card => card.path === selectedEdge!.target)!)}` }
              : { path: "", title: document.title }) : undefined}
            onClose={() => { setSelection(undefined); setDiagnosticError(""); }}>
            <section className="agsdl-inspector" aria-label={t("agsdl.properties")}>
              {diagnosticError && <p role="alert" className="agsdl-unresolved">{diagnosticError}</p>}
              {selectedCard ? inspect(selectedCard) : selectedEdge ? <WorkflowEdgeSummary connection={selectedEdge}
                sourceTitle={nodeTitle(cards.find(card => card.path === selectedEdge.source)!)}
                targetTitle={nodeTitle(cards.find(card => card.path === selectedEdge.target)!)}
                onSource={() => select(selectedEdge.source)} onTarget={() => select(selectedEdge.target)} /> : null}
            </section>
          </ComponentDetailsDialog>}
        </>}
      {saveOpen && session && <SaveSystemDialog target={target} title={document?.title || ""} onClose={() => setSaveOpen(false)} />}
      {library && session && <DesignLibraryDialog key={`${key}:${library}`} target={target} mode={library} onClose={() => setLibrary(undefined)} />}
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
