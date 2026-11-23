import { isFlowDocumentContract } from "../../services/agsdl/contract";
import { AlertTriangle,Download,Maximize2,Redo2,Save,Settings2,Undo2,X } from "lucide-react";
import React,{ useEffect,useMemo,useState } from "react";
import { applyChanges } from "../../services/agsdl/document";
import { reviewDesignChanges } from "../../services/agsdl/designReview";
import { diagnosticOwner030,localizeDiagnostics,type LocalizedDiagnostic } from "../../services/agsdl/diagnostics";
import { projectSystemOverview } from "../../services/agsdl/systemOverview";
import {
projectViewer,
type ViewerCard,
type ViewerPort,
type ViewerReference,
} from "../../services/agsdl/viewer";
import { prepareAgsdlChatContext } from "../../stores/agsdl/chatContext";
import {
agsdlSessionKey,
useAgsdlStore,
type AgsdlDocumentTarget,
} from "../../stores/useAgsdlStore";
import { Dialog } from "../ui/Dialog";
import { AgentDetails } from "./AgentDetails";
import { ComponentDetailsDialog } from "./ComponentDetailsDialog";
import { DesignChangesDialog } from "./DesignChangesDialog";
import { DesignLibraryDialog,DesignStart } from "./DesignLibraryDialog";
import { Diagnostics030 } from "./Diagnostics030";
import { DisclosureSummary } from "./DisclosureSummary";
import { SaveSystemDialog } from "./SaveSystemDialog";
import { WorkflowEdgeSummary } from "./WorkflowEdge";
import { WorkflowGraph } from "./WorkflowGraph";
import "./agsdl.css";
import { agsdlErrorText, agsdlProjectIssueText } from "./errorText";
import { ProjectMacroSettings } from "./ProjectMacroSettings";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { ArchitectComponentList, type ComponentAdding, type ComponentListKind } from "../architect/ArchitectComponentList";
import { ArchitectLaunchSettings } from "../architect/ArchitectLaunchSettings";
import { projectInventory } from "../../services/agsdl/projectInventory";
import { projectSettings } from "../../stores/agsdl/projectEdits";

/** Which projection of a project the canvas area shows. The flow is the graph; the lists show its parts; launch holds what is asked at launch. */
export type AgsdlEditorView = "flow" | "agents" | "skills" | "tools" | "launch";

// Chat and focused component edits share the same versioned document store.
export const AgsdlEditor: React.FC<{
  target: AgsdlDocumentTarget;
  onAttachContext?: (selection: Parameters<typeof prepareAgsdlChatContext>[1]) => Promise<void>;
  planStatus?: string;
  expanded?: boolean;
  onExpand?: () => void;
  canvasActions?: React.ReactNode;
  view?: AgsdlEditorView;
}> = ({ target, planStatus, expanded, onExpand, canvasActions, onAttachContext, view = "flow" }) => {
  const { t } = useAgsdlTranslation();
  const demoJourney = import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1';
  const persistenceTitle = t(demoJourney ? 'agsdl.persistence.export' : 'agsdl.persistence.title');
  const legacyTarget = "planId" in target ? target : undefined;
  const canAttach = !!legacyTarget || !!onAttachContext;
  const key = agsdlSessionKey(target);
  const session = useAgsdlStore((state) => state.sessions[key]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState<{ value: string; version: string }>();
  const [nameError, setNameError] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [error, setError] = useState("");
  const [discardMigrationFile, setDiscardMigrationFile] = useState<string>();
  const [library, setLibrary] = useState<"start" | "blueprint" | "system">();
  const [changesOpen, setChangesOpen] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState("");
  const [graphIndex, setGraphIndex] = useState(0);
  const [definitions030, setDefinitions030] = useState(false);
  const [graphChosen030, setGraphChosen030] = useState(false);
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
  const project = session?.project;
  const projectTarget = "blueprintId" in target && project ? target : undefined;
  const source = session?.source;
  const displayMetadata = session?.display;
  const migrationMetadata = session?.migration;
  const reports = session?.reports;
  const review = useMemo(() => session?.history.length ? reviewDesignChanges(session.history.at(-1)!.source, session.source, session.history.at(-1), session) : undefined, [session]);
  const showChanges = !!review && (review.changes.length > 0 || review.design || review.configuration || review.other) && session?.version !== dismissedVersion;
  useEffect(() => {
    if (!source && !projectTarget) return;
    const timer = setTimeout(() => void useAgsdlStore.getState().validate(target), 250);
    return () => clearTimeout(timer);
  }, [source, target, session?.version, projectTarget]);
  const parsed = useMemo(() => {
    if (!source) return {};
    try {
      return { document: projectViewer(source, { display: displayMetadata, migration: migrationMetadata }, reports, !!projectTarget) };
    } catch (error) {
      return { error: String(error) };
    }
  }, [source, displayMetadata, migrationMetadata, reports, projectTarget]);
  const document = parsed.document;
  const listView: ComponentListKind | undefined = view === "agents" || view === "skills" || view === "tools" ? view : undefined;
  const inventory = useMemo(() => listView && source ? projectInventory(source) : null, [listView, source]);
  const blueprintTarget = "blueprintId" in target ? target : undefined;
  const hiddenAgents = useMemo(() => project ? projectSettings(project).hiddenAgentIds : [], [project]);
  const visibleGraphIndex = Math.max(0, Math.min(graphIndex, Math.max(0, (document?.graphs.length ?? 0) - 1)));
  const edition030 = isFlowDocumentContract(document?.contract);
  const graph = edition030 && (definitions030 || (!Object.hasOwn(document.systemDetails, "flow") && !graphChosen030)) ? undefined : document?.graphs[visibleGraphIndex];
  const selected = selection?.key === key ? selection.path : "";
  const system = useMemo(() => projectSystemOverview(graph, document?.legacyCards.length
    ? document.legacyCards : document?.declarations.filter(item => edition030 || ["Agent", "System"].includes(item.kind)) ?? []), [graph, document, edition030]);
  const diagnostics = useMemo(() => source ? localizeDiagnostics(source, session?.reports ?? [], document ? [...document.graphs.flatMap(graph => graph.cards), ...document.declarations, ...document.legacyCards] : []) : [], [source, document, session?.reports]);
  const allCards = document ? [...document.graphs.flatMap(graph => graph.cards), ...document.declarations, ...document.legacyCards] : [];
  const openDiagnostic = (issue: LocalizedDiagnostic) => {
    if (!source) return;
    const card = diagnosticOwner030(source, issue, allCards);
    const index = document?.graphs.findIndex(graph => graph.cards.some(item => item.path === card.path)) ?? -1;
    if (index >= 0) { setGraphIndex(index); setDefinitions030(false); setGraphChosen030(true); }
    setSelection({ key, path: card.path, card });
    setDiagnosticError("");
  };
  const attachDiagnostic = async (issue: LocalizedDiagnostic) => {
    if (!source || attaching) return;
    const card = diagnosticOwner030(source, issue, allCards);
    setAttaching(true); setDiagnosticError("");
    try {
      await attachContext({ path: card.edition030?.ownerPath ?? card.path,
        title: card.title || t("agsdl.authoring030.document"),
        diagnostic: `${issue.rule}: ${issue.details}${issue.path === undefined ? "" : `\n${issue.path}`}${issue.step ? `\n${issue.step.join("/")}` : ""}` });
    } catch (error) { setDiagnosticError(agsdlErrorText(error, t)); }
    finally { setAttaching(false); }
  };
  const cards = useMemo(() => system.cards.map(card => ({ ...card, issueCount: diagnostics.filter(issue => issue.targets.includes(card.path)).length,
    ...(typeof card.details.agentName === "string" && hiddenAgents.includes(card.details.agentName) ? { hiddenInOperate: true } : {}) })), [system.cards, diagnostics, hiddenAgents]);
  const selectedEdge = system.edges.find(edge => edge.id === selected);
  const currentCard = cards.find(item => item.path === selected) ?? graph?.cards.find(item => item.path === selected) ?? document?.declarations.find(item => item.path === selected);
  // Keep an open form alive if an agent removes its component. Its captured
  // version will reject saving; the user's text remains available to copy.
  const snapshotCard = selection?.key === key ? selection.card : undefined;
  const routeCardFor = (edge: typeof selectedEdge): ViewerCard | undefined => edge?.route030 ? { path: edge.id, id: edge.id, title: edge.label, kind: "Route", mission: "", unresolved: false, inputs: [], outputs: [], branches: [], details: { contract: document?.contract }, edition030: { sourceJson: edge.route030.valueJson ?? "", routes: [edge.route030] } } : undefined;
  const routeCard = routeCardFor(selectedEdge);
  const selectedCard = snapshotCard && (!currentCard || currentCard.id !== snapshotCard.id) ? snapshotCard : currentCard;
  const select = (path: string) => {
    setDiagnosticError("");
    const card = cards.find(item => item.path === path) ?? graph?.cards.find(item => item.path === path) ?? document?.declarations.find(item => item.path === path) ?? routeCardFor(system.edges.find(edge => edge.id === path));
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
    if (index >= 0) { setGraphIndex(index); setDefinitions030(false); setGraphChosen030(true); }
    setSelection({ ...previousSelection, trail: selection?.trail?.slice(0, -1) });
    setDiagnosticError("");
  };
  const attachContext = async (selection: Parameters<typeof prepareAgsdlChatContext>[1]) => {
    if (legacyTarget) await prepareAgsdlChatContext(legacyTarget, selection);
    else await onAttachContext?.(selection);
    setSelection(undefined);
    if (expanded) onExpand?.();
  };
  const diagnosticAction = (issues: LocalizedDiagnostic[], path: string, title: string) => canAttach && issues.length > 0 && <button className="agsdl-link" disabled={attaching} onClick={() => {
    setAttaching(true); setDiagnosticError("");
    void attachContext({ path: issues.length === 1 ? issues[0].path ?? path : path, title, diagnostic: issues.map(issue => `${issue.rule}: ${issue.details}`).join("\n") })
      .catch((error: unknown) => {
        setDiagnosticError(agsdlErrorText(error, t));
      })
      .finally(() => setAttaching(false));
  }}>{t("agsdl.viewer.correctIssue")}</button>;
  const nodeTitle = (item: ViewerCard) => {
    const hasTitle = !!((item.details.displayAnnotations ?? item.details.annotations) as { title?: string } | undefined)?.title;
    if (item.kind === "approval" && !isFlowDocumentContract(item.details.contract) && !hasTitle) return t("agsdl.viewer.approvalRequired");
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
      {item.edition030 && <Diagnostics030 issues={diagnostics.filter(issue => issue.targets.includes(item.path) || diagnosticOwner030(source!, issue, allCards).path === item.path)} onSelect={openDiagnostic} onAttach={canAttach ? attachDiagnostic : undefined} busy={attaching} error={diagnosticError} />}
      {!item.edition030 && ["Agent", "invoke", "agent"].includes(item.kind)
        ? <AgentDetails card={item} cards={[...(document?.graphs.flatMap(graph => graph.cards) ?? []), ...(document?.declarations ?? []), ...(document?.legacyCards ?? [])]} source={source!} onSelect={select} />
        : !item.edition030 && item.mission && <p className="agsdl-mission">{item.mission}</p>}
      {projectTarget && typeof item.details?.agentName === "string" && <ProjectMacroSettings target={projectTarget} agentId={item.details.agentName} />}
      {item.composition && <p>{reference(item.composition)}</p>}
      {!item.edition030 && diagnosticAction(diagnostics.filter(issue => issue.targets.includes(item.path)), item.path, nodeTitle(item))}
      {item.unresolved && <p className="agsdl-unresolved">{t("agsdl.viewer.unresolvedAgent")}</p>}
      {!item.edition030 && !["Agent", "invoke", "agent"].includes(item.kind) && <>
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
  const conflict = session?.draftConflict;
  const conflictTarget = "blueprintId" in target && target.number === undefined ? target : undefined;
  const savedDraft = conflict?.saved;
  const canvasError = error || (session?.error && agsdlErrorText(session.error, t));
  const recoveryError = settingsOpen ? nameError : error;
  const resolveConflict = async (choice: "saved" | "local") => {
    if (!conflictTarget || !savedDraft || !session) return;
    try {
      await useAgsdlStore.getState().resolveDraftConflict(conflictTarget, session.version, savedDraft.revision, choice);
      setNameDraft(undefined);
      setNameError("");
      setError("");
    } catch (failure) {
      (settingsOpen ? setNameError : setError)(agsdlErrorText(failure, t));
    }
  };
  // Adding by hand is offered on the draft only. A document that cannot be saved right now says why instead of hiding the action.
  const adding: ComponentAdding | undefined = blueprintTarget && blueprintTarget.number === undefined && session?.status === "draft" && !planStatus ? {
    target: blueprintTarget, projectFiles: !!project,
    blockedReason: session.saving ? t("agsdl.architect.add.blocked.saving") : conflict ? t("agsdl.library.revisionConflict")
      : project && !project.saved.projection ? t("agsdl.architect.add.blocked.invalid")
        : project && session.dirty ? t("agsdl.architect.add.blocked.unsaved") : undefined,
  } : undefined;
  const conflictNotice = conflict && conflictTarget && <div role="alert" className="agsdl-error">
    <p>{t("agsdl.library.revisionConflict")}</p>
    {recoveryError && recoveryError !== t("agsdl.library.revisionConflict") && <p>{recoveryError}</p>}
    <p>{t("agsdl.library.conflictViewing", { revision: session.persistedRevision })}</p>
    {savedDraft ? <>
      <p>{t("agsdl.library.conflictSaved", { revision: savedDraft.revision })}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="agsdl-link" disabled={session.saving} onClick={() => void resolveConflict("saved")}>
          {t("agsdl.library.useSavedDraft")}
        </button>
        {session.dirty && !savedDraft.archived && <button type="button" className="agsdl-link" disabled={session.saving} onClick={() => void resolveConflict("local")}>
          {t("agsdl.library.replaceSavedDraft")}
        </button>}
      </div>
    </> : <button type="button" className="agsdl-link" disabled={session.saving} onClick={() => {
      void useAgsdlStore.getState().refreshDraftConflict(conflictTarget).catch(failure =>
        (settingsOpen ? setNameError : setError)(agsdlErrorText(failure, t)));
    }}>{t("agsdl.library.readSavedDraft")}</button>}
  </div>;

  return (
    <div className="agsdl-viewer" data-agsdl-plan={legacyTarget?.planId} data-agsdl-blueprint={"blueprintId" in target ? target.blueprintId : undefined} aria-label={t("agsdl.editor")} onKeyDown={event => { if (event.key === "Escape" && !selectedCard && !selectedEdge) { setSelection(undefined); } }}>
      <header className="agsdl-viewer-header">
        <div className="agsdl-header-actions">
          {(source || project) && (!project || session?.status === "draft") && <>
            <button className="agsdl-icon-button" aria-label={t("agsdl.authoring030.undo")} title={t("agsdl.authoring030.undo")} disabled={session?.status !== "draft" || !!session?.saving || !(project?.past.length ?? session?.history.length) || (!!planStatus && planStatus !== "draft")} onClick={() => void changeHistory()}><Undo2 size={14} /></button>
            <button className="agsdl-icon-button" aria-label={t("agsdl.authoring030.redo")} title={t("agsdl.authoring030.redo")} disabled={session?.status !== "draft" || !!session?.saving || !(project?.future.length ?? session?.future.length) || (!!planStatus && planStatus !== "draft")} onClick={() => void changeHistory(true)}><Redo2 size={14} /></button>
          </>}
          {source && legacyTarget && <button className="agsdl-icon-button" title={persistenceTitle} aria-label={persistenceTitle} onClick={() => setSaveOpen(true)}>{demoJourney ? <Download size={14} /> : <Save size={14} />}</button>}
          {onExpand && <button className="agsdl-icon-button" onClick={onExpand}
            aria-label={t(expanded ? "agsdl.shrink" : "agsdl.expand")}
            title={t(expanded ? "agsdl.shrink" : "agsdl.expand")}>
            {expanded ? <X size={14} /> : <Maximize2 size={14} />}
          </button>}
        </div>
        <button className="agsdl-icon-button" aria-label={t("agsdl.canvas030.document")} title={t("agsdl.canvas030.document")} onClick={() => setSettingsOpen(true)}><Settings2 size={14} /></button>
        {diagnostics.length > 0 && <button className="agsdl-icon-button agsdl-unresolved" aria-label={t("agsdl.authoring030.diagnostics.count", { count: diagnostics.length })} title={t("agsdl.authoring030.diagnostics.count", { count: diagnostics.length })} onClick={() => setIssuesOpen(true)}><AlertTriangle size={14} /></button>}
        {canvasActions}
      </header>
      {settingsOpen && <Dialog title={t("agsdl.canvas030.document")} onClose={() => setSettingsOpen(false)} closeOnBackdropClick panelClassName="agsdl-detail-modal">
        <header><strong>{document?.title || t("agsdl.editor")}</strong><button className="agsdl-icon-button" aria-label={t("agsdl.close")} onClick={() => setSettingsOpen(false)}><X size={14} /></button></header>
        <div className="agsdl-inspector-body space-y-3">
        {edition030 && <button onClick={() => {
          if (graph) setDefinitions030(true);
          else { setDefinitions030(false); setGraphChosen030(true); }
          setSelection(undefined);
        }}>{t("agsdl.edition030.definitions")}</button>}
        {document && (document.graphs.length > 1 || (edition030 && document.graphs.length > 0)) && (
          <select
            aria-label={t("agsdl.graph")}
            value={edition030 && !graph ? -1 : visibleGraphIndex}
            onChange={(event) => {
              const nextIndex = Number(event.target.value);
              setGraphChosen030(true);
              setDefinitions030(nextIndex === -1);
              if (nextIndex >= 0) setGraphIndex(nextIndex);
              setSelection(undefined);
            }}
          >
            {edition030 && <option value={-1}>{t("agsdl.edition030.definitions")}</option>}
            {document.graphs.map((graph, index) => (
              <option key={graph.path} value={index}>
                {graph.title || `${t("agsdl.graph")} ${index + 1}`}
              </option>
            ))}
          </select>
        )}

          {session && (!project || session.status === "draft") && <form onSubmit={async event => {
            event.preventDefault();
            if (!nameDraft || session.saving || conflict) return;
            setNameError("");
            try {
              const store = useAgsdlStore.getState();
              if (edition030) {
                const changes = [{ op: "set" as const, path: "/title", valueJson: JSON.stringify(nameDraft.value) }];
                if (!projectTarget && !legacyTarget && session.display?.title) {
                  store.replace(target, applyChanges(session.source, changes), undefined, nameDraft.version,
                    { design: session.design, display: { ...session.display, title: nameDraft.value }, migration: session.migration });
                } else await store.edit(target, changes, nameDraft.version);
              } else store.replace(target, session.source, undefined, nameDraft.version, { design: session.design, display: { ...session.display, title: nameDraft.value }, migration: session.migration });
              setNameDraft({ ...nameDraft, version: useAgsdlStore.getState().sessions[key].version });
              void store.save(target).then(() => {
                setNameDraft(undefined);
                setError("");
              }).catch(error => setNameError(agsdlErrorText(error, t)));
            } catch (error) { setNameError(agsdlErrorText(error, t)); }
          }}><label className="agsdl-edit-field">{t("agsdl.design.name")}<input value={nameDraft?.value ?? document?.title ?? ""} disabled={session.status !== "draft" || session.saving || !!conflict || (!!planStatus && planStatus !== "draft")} onChange={event => setNameDraft({ value: event.target.value, version: nameDraft?.version ?? session.version })} /></label>
            <button type="submit" className="agsdl-link" disabled={!nameDraft || session.saving || !!conflict}>{t("agsdl.save")}</button>
          </form>}
          {conflictNotice}
          {!conflict && nameError && <p role="alert" className="agsdl-unresolved">{nameError}</p>}
        </div>
      </Dialog>}
      {issuesOpen && <Dialog title={t("agsdl.authoring030.diagnostics.title")} onClose={() => setIssuesOpen(false)} closeOnBackdropClick panelClassName="agsdl-detail-modal">
        <header><strong>{t("agsdl.authoring030.diagnostics.title")}</strong><button className="agsdl-icon-button" aria-label={t("agsdl.close")} onClick={() => setIssuesOpen(false)}><X size={14} /></button></header>
        <Diagnostics030 issues={diagnostics} onSelect={issue => { setIssuesOpen(false); openDiagnostic(issue); }} onAttach={canAttach ? attachDiagnostic : undefined} busy={attaching} error={diagnosticError} />
      </Dialog>}
      {!settingsOpen && conflictNotice}
      {project && project.graphRevision !== null && !project.view.projection && <p className="agsdl-canvas-notice" role="status">
        {t("agsdl.library.graphRevision", { revision: project.graphRevision })}
      </p>}
      {!!project?.view.diagnostics.length && <details className="agsdl-details px-2" open={!project.view.projection}>
        <DisclosureSummary>{t("agsdl.authoring030.diagnostics.count", { count: project.view.diagnostics.length })}</DisclosureSummary>
        {project.view.diagnostics.map((issue, index) => <p key={index} className="break-words">
          {issue.file && <code>{issue.file}{issue.pointer && `#${issue.pointer}`} · </code>}{agsdlProjectIssueText(issue, t)}
          {issue.code === "MIGRATION_RESOURCE" && issue.file && session?.status === "draft" && projectTarget &&
            <button className="agsdl-link ml-2" disabled={session.saving || !!conflict} onClick={() => setDiscardMigrationFile(issue.file!)}>{t("agsdl.library.discardMigrationFile")}</button>}
        </p>)}
      </details>}
      {discardMigrationFile && projectTarget && <Dialog title={t("agsdl.library.discardMigrationFile")} onClose={() => setDiscardMigrationFile(undefined)} panelClassName="agsdl-detail-modal">
        <p>{t("agsdl.library.discardMigrationFileConfirm", { path: discardMigrationFile })}</p>
        <footer>
          <button onClick={() => setDiscardMigrationFile(undefined)}>{t("agsdl.cancel")}</button>
          <button disabled={session?.saving} onClick={() => {
            setDiscardMigrationFile(undefined);
            void useAgsdlStore.getState().discardProjectMigrationFile(projectTarget, discardMigrationFile)
              .catch(failure => setError(agsdlErrorText(failure, t)));
          }}>{t("agsdl.library.discardMigrationFile")}</button>
        </footer>
      </Dialog>}
      {!conflict && ((!settingsOpen && canvasError) || parsed.error) && (
        <div role="alert" className="agsdl-error">
          {(!settingsOpen && canvasError) || (
            <>
              <p>{t(parsed.error?.includes("agsdl.unsupportedEdition020") ? "agsdl.unsupportedEdition020" : "agsdl.viewer.unreadable")}</p>
              <details className="agsdl-details">
                <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
                <p>{parsed.error}</p>
              </details>
            </>
          )}
          {!settingsOpen && canvasError && (
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
        : !source ? legacyTarget && session.status === "draft" && (!planStatus || planStatus === "draft") ? <DesignStart onChoose={setLibrary} /> : <div className="agsdl-empty">{t("agsdl.emptyTitle")}</div>
        : document && <>
          {view === "launch" && blueprintTarget ? <ArchitectLaunchSettings target={blueprintTarget} />
          : listView ? <ArchitectComponentList kind={listView} cards={document.declarations} inventory={inventory}
            hiddenAgents={hiddenAgents} adding={adding} onSelect={select} />
          : cards.length > 0 ? <WorkflowGraph
            key={`${key}:${graph?.path ?? "declarations"}`}
            cards={cards} edges={system.edges} entry={system.entry} compositions={document.graphs} declarations={document.declarations} selected={selected}
            select={select} title={nodeTitle} source={source}
            onAttach={canAttach && !attaching ? path => {
              const card = cards.find(item => item.path === path);
              if (!card) return;
              setAttaching(true);
              void attachContext({ path: card.edition030?.ownerPath ?? path, title: nodeTitle(card) }).catch((error: unknown) => {
                select(path); setDiagnosticError(agsdlErrorText(error, t));
              }).finally(() => setAttaching(false));
            } : undefined}
            changedPaths={showChanges ? review?.changes.flatMap(change => change.path ? [change.path] : []) : []}
          /> : <div className="agsdl-start"><h3>{document.title}</h3><p>{t("agsdl.design.emptySystem")}</p></div>}
          {(selectedCard || selectedEdge) && <ComponentDetailsDialog
            key={selectedCard?.path ?? selectedEdge!.id}
            title={selectedCard ? nodeTitle(selectedCard) : selectedEdge ? t(selectedEdge.dependency ? "agsdl.viewer.dependencies" : "agsdl.viewer.connection") : document.title}
            card={selectedCard ?? routeCard} canEdit={(!project || !session.dirty && !!project.saved.projection) && !attaching && (selectedCard === currentCard || !!routeCard || selectedCard?.kind === "Route") && (!planStatus || planStatus === "draft")} target={target}
            onBack={previousSelection ? goBack : undefined}
            onAttach={canAttach && !attaching && ((selectedCard && selectedCard === currentCard) || selectedEdge) ? () => attachContext(selectedEdge
              ? { path: selectedEdge.route030?.path ?? selectedEdge.source, relatedPaths: [selectedEdge.source, selectedEdge.target], title: `${selectedEdge.label}: ${nodeTitle(cards.find(card => card.path === selectedEdge.source)!)} → ${nodeTitle(cards.find(card => card.path === selectedEdge.target)!)}` }
              : selectedCard ? { path: selectedCard.edition030?.ownerPath ?? selectedCard.path, title: nodeTitle(selectedCard) }
              : { path: "", title: document.title }) : undefined}
            onClose={() => { setSelection(undefined); setDiagnosticError(""); }}>
            <section className="agsdl-inspector" aria-label={t("agsdl.properties")}>
              {diagnosticError && <p role="alert" className="agsdl-unresolved">{diagnosticError}</p>}
              {selectedEdge ? <WorkflowEdgeSummary connection={selectedEdge}
                sourceTitle={nodeTitle(cards.find(card => card.path === selectedEdge.source)!)}
                targetTitle={nodeTitle(cards.find(card => card.path === selectedEdge.target)!)}
                onSource={() => select(selectedEdge.source)} onTarget={() => select(selectedEdge.target)} /> : selectedCard ? inspect(selectedCard) : null}
            </section>
          </ComponentDetailsDialog>}
        </>}
      {!document && selectedCard && <ComponentDetailsDialog title={t("agsdl.authoring030.document")} target={target} card={selectedCard} canEdit={false} onClose={() => setSelection(undefined)}>
        <Diagnostics030 issues={diagnostics} onSelect={openDiagnostic} onAttach={canAttach ? attachDiagnostic : undefined} busy={attaching} error={diagnosticError} />
      </ComponentDetailsDialog>}
      {saveOpen && session && legacyTarget && <SaveSystemDialog target={legacyTarget} title={document?.title || ""} onClose={() => setSaveOpen(false)} />}
      {library && session && legacyTarget && <DesignLibraryDialog key={`${key}:${library}`} target={legacyTarget} mode={library} onClose={() => setLibrary(undefined)} />}
      {changesOpen && review && <DesignChangesDialog review={review} onClose={() => setChangesOpen(false)} onSelect={path => {
        const index = document?.graphs.findIndex(graph => graph.cards.some(card => card.path === path)) ?? -1;
        if (index >= 0) setGraphIndex(index);
        select(path);
      }} onUndo={() => void changeHistory()} canUndo={session?.status === "draft" && !session.saving && (!planStatus || planStatus === "draft")} />}
      {showChanges && <div className="agsdl-change-notice"><button onClick={() => setChangesOpen(true)}>{t("agsdl.design.changes")}</button><button className="agsdl-icon-button" onClick={() => setDismissedVersion(session!.version)} aria-label={t("agsdl.design.dismissChanges")}><X size={12} /></button></div>}
      {(session?.saving || session?.dirty) && <footer className="agsdl-canvas-notice" role="status">
        {t(session.saving ? "agsdl.saving" : "agsdl.unsaved")}
        {session.dirty && !conflict && <button className="agsdl-link ml-2" disabled={session.saving} onClick={() => { void useAgsdlStore.getState().save(target).catch(error => setError(agsdlErrorText(error, t))); }}>{t("agsdl.authoring030.saveDraft")}</button>}
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
