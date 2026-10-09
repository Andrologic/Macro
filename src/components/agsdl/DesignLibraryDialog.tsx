import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BookOpen, Copy, Plus, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from "../../stores/useAgsdlStore";
import { createEmptySystemDocument, readDesign } from "../../services/agsdl/design";
import { builtInDesignSources, instantiateDesign, listDesignSources, saveBlueprint, type DesignSource } from "../../stores/agsdl/blueprints";
import { projectViewer, type ViewerCard } from "../../services/agsdl/viewer";
import "./design.css";
import "./designLibrary.css";
import { AgsdlUserError } from "../../services/agsdl/userErrors";
import { agsdlErrorText } from "./errorText";

type DesignLibraryMode = "start" | "blueprint" | "system" | "save";
type DesignLibraryProps = { target: AgsdlTarget; mode: DesignLibraryMode; onClose: () => void; onCreated?: () => void };

const sourcePreview = (source: DesignSource) => {
  try {
    const design = readDesign(source.source, source.design);
    const viewer = projectViewer(source.source, source);
    const graphCards = viewer.graphs.flatMap(graph => graph.cards).filter(card => card.kind !== "end" && card.title.trim());
    const declarationCards = viewer.declarations.filter(card => ["Agent", "System"].includes(card.kind) && card.title.trim());
    const cards = (graphCards.length ? graphCards : declarationCards).slice(0, 5);
    return { purpose: design.purpose, cards, remaining: Math.max(0, (graphCards.length ? graphCards : declarationCards).length - cards.length), pending: design.requirements.filter(item => !item.value.trim()).length };
  } catch {
    return { purpose: "", cards: [] as ViewerCard[], remaining: 0, pending: 0 };
  }
};

export function DesignLibraryDialog({ target, mode, onClose, onCreated }: DesignLibraryProps) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [version, setVersion] = useState(session.version);
  const [tab, setTab] = useState(mode === "system" ? "system" : "blueprint");
  const [sources, setSources] = useState<DesignSource[]>(builtInDesignSources);
  const [loading, setLoading] = useState(mode !== "save" && mode !== "start");
  const [loadFailureCount, setLoadFailureCount] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selected, setSelected] = useState<DesignSource>();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (mode === "save" || mode === "start") return;
    let active = true;
    setLoading(true);
    setError("");
    void listDesignSources().then(result => {
      if (!active) return;
      setSources(result.sources);
      setLoadFailureCount(result.failureCount);
      setLoadError("");
      setSelected(current => current ? result.sources.find(item => item.id === current.id) : undefined);
    })
      .catch(error => {
        if (!active) return;
        setLoadFailureCount(1);
        setLoadError(agsdlErrorText(error));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadAttempt, mode]);
  const title = t(mode === "save" ? "agsdl.design.saveBlueprint" : mode === "start" ? "agsdl.design.newSystem" : "agsdl.design.library");
  const selectionLocked = loading || busy || applied || session.saving;
  const visibleSources = useMemo(() => sources.filter(item => item.kind === tab && item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [query, sources, tab]);
  const selectedPreview = useMemo(() => selected ? sourcePreview(selected) : undefined, [selected]);
  useEffect(() => {
    if (selected && !visibleSources.some(item => item.id === selected.id)) setSelected(undefined);
  }, [selected, visibleSources]);
  const retrySources = () => {
    if (selectionLocked) return;
    setLoadAttempt(attempt => attempt + 1);
  };
  const submit = async () => {
    if (busy || loading || session.saving) return;
    setBusy(true); setError("");
    let succeeded = false;
    try {
      const store = useAgsdlStore.getState();
      const current = store.sessions[agsdlSessionKey(target)];
      if (current.version !== version) throw new AgsdlUserError("agsdl.viewer.editConflict", t("agsdl.viewer.editConflict"));
      if (mode === "save") {
        await saveBlueprint(target, name.trim(), undefined, version);
      } else if (applied) {
        await store.save(target);
      } else if (mode === "start") {
        if (current.source) throw new AgsdlUserError("agsdl.design.notEmpty", t("agsdl.design.notEmpty"));
        const document = createEmptySystemDocument(name.trim());
        store.replace(target, document.source, document.annexes, version, document);
        setVersion(useAgsdlStore.getState().sessions[agsdlSessionKey(target)].version);
        setApplied(true);
        await store.save(target);
      } else {
        if (!selected) return;
        await instantiateDesign(target, selected, version, { onApplied: nextVersion => { setApplied(true); setVersion(nextVersion); } });
      }
      succeeded = true;
    } catch (error) { setError(agsdlErrorText(error, t)); }
    finally { setBusy(false); }
    if (succeeded) {
      try { if (mode !== "save") onCreated?.(); }
      finally { onClose(); }
    }
  };
  const description = (item: DesignSource) => {
    try { return readDesign(item.source, item.design).purpose; } catch { return ""; }
  };
  return <Dialog title={title} onClose={() => { if (!busy) onClose(); }} closeOnBackdropClick
    backdropClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" panelClassName="agsdl-detail-modal agsdl-design-modal">
    <header><strong>{title}</strong><button className="agsdl-icon-button" disabled={busy} onClick={onClose} aria-label={t("agsdl.close")}><X size={16} /></button></header>
    <div className="agsdl-inspector-body">
      {mode === "save" || mode === "start" ? <form id="agsdl-library-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <p className="agsdl-muted">{t(mode === "save" ? "agsdl.design.snapshotHint" : "agsdl.design.startHint")}</p>
        <label className="agsdl-edit-field"><span>{t("agsdl.design.name")}</span><input required maxLength={120} value={name} disabled={busy || applied} onChange={event => setName(event.target.value)} /></label>
      </form> : <>
        <div className="agsdl-design-tabs">
          <button type="button" disabled={selectionLocked} aria-pressed={tab === "blueprint"} onClick={() => { setTab("blueprint"); setSelected(undefined); }}>{t("agsdl.design.blueprints")}</button>
          <button type="button" disabled={selectionLocked} aria-pressed={tab === "system"} onClick={() => { setTab("system"); setSelected(undefined); }}>{t("agsdl.design.systems")}</button>
        </div>
        <input className="agsdl-design-search" value={query} placeholder={t("agsdl.design.search")} aria-label={t("agsdl.design.search")} disabled={selectionLocked} onChange={event => {
          const nextQuery = event.target.value.toLocaleLowerCase();
          setQuery(event.target.value);
          setSelected(current => current && sources.some(item => item.id === current.id && item.kind === tab && item.name.toLocaleLowerCase().includes(nextQuery)) ? current : undefined);
        }} />
        {loading && <p role="status" className="agsdl-muted">{t("agsdl.loading")}</p>}
        {loadFailureCount > 0 && <div role="alert" className="agsdl-design-load-error">
          <span>{loadError || t("agsdl.design.loadFailed", { count: loadFailureCount, defaultValue: "Some starting points could not be loaded." })}</span>
          <button type="button" className="agsdl-link" disabled={selectionLocked} onClick={retrySources}>{t("agsdl.retry")}</button>
        </div>}
        <div className="agsdl-design-sources">
          {visibleSources.map(item => <button type="button" key={item.id} className="agsdl-design-source" disabled={selectionLocked} aria-pressed={selected?.id === item.id} onClick={() => setSelected(item)}>
            {item.kind === "blueprint" ? <BookOpen size={16} /> : <Copy size={16} />}<span><strong>{item.name}</strong><small>{item.builtin ? t("agsdl.design.included") : description(item)}</small></span><ArrowRight size={14} />
          </button>)}
          {!loading && !visibleSources.length && <p className="agsdl-muted">{t("agsdl.design.noSources")}</p>}
        </div>
        {selected && selectedPreview && <section className="agsdl-design-preview" aria-label={t("agsdl.design.preview", { defaultValue: "Selected starting point" })}>
          <div className="agsdl-design-preview-header"><strong>{selected.name}</strong><small>{selected.kind === "blueprint" ? t("agsdl.design.blueprints") : t("agsdl.design.systems")}</small></div>
          <p><span className="agsdl-design-preview-label">{t("agsdl.design.purpose")}</span>{selectedPreview.purpose || t("agsdl.design.noPurpose", { defaultValue: "No purpose provided." })}</p>
          <div><span className="agsdl-design-preview-label">{t("agsdl.design.components", { defaultValue: "Main components" })}</span>
            {selectedPreview.cards.length ? <ul className="agsdl-design-preview-components">{selectedPreview.cards.map(card => <li key={card.path} className="agsdl-design-preview-component"><span>{card.title}</span></li>)}{selectedPreview.remaining > 0 && <li className="agsdl-design-preview-more">+{selectedPreview.remaining}</li>}</ul> : <p className="agsdl-muted">{t("agsdl.design.noComponents", { defaultValue: "No components defined yet." })}</p>}
          </div>
          {selectedPreview.pending > 0 && <p className="agsdl-design-preview-pending">{t("agsdl.design.pending", { count: selectedPreview.pending })}</p>}
        </section>}
        {selected && <p className="agsdl-muted">{t("agsdl.design.independentCopy")}</p>}
      </>}
      {error && <p role="alert" className="agsdl-unresolved">{error}</p>}
    </div>
    <footer><button onClick={onClose} disabled={busy}>{t("agsdl.cancel")}</button>
      <button type="submit" form={mode === "save" || mode === "start" ? "agsdl-library-form" : undefined} onClick={mode === "save" || mode === "start" ? undefined : () => void submit()} disabled={busy || loading || session.saving || (mode === "save" || mode === "start" ? !name.trim() : !selected)}>{t(busy ? "agsdl.saving" : applied ? "agsdl.retry" : mode === "save" ? "agsdl.save" : "agsdl.design.create")}</button>
    </footer>
  </Dialog>;
}

export function DesignStart({ onChoose }: { onChoose: (mode: "start" | "blueprint" | "system") => void }) {
  const { t } = useAgsdlTranslation();
  return <div className="agsdl-start"><h3>{t("agsdl.design.newSystem")}</h3><p>{t("agsdl.design.startHint")}</p>
    <button onClick={() => onChoose("start")}><Plus size={16} />{t("agsdl.design.fromScratch")}</button>
    <button onClick={() => onChoose("blueprint")}><BookOpen size={16} />{t("agsdl.design.fromTemplate")}</button>
    <button onClick={() => onChoose("system")}><Copy size={16} />{t("agsdl.design.fromSystem")}</button>
  </div>;
}
