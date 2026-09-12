import { useEffect, useState } from "react";
import { ArrowRight, BookOpen, Copy, Plus, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from "../../stores/useAgsdlStore";
import { createEmptySystem, readDesign } from "../../services/agsdl/design";
import { builtInDesignSources, instantiateDesign, listDesignSources, saveBlueprint, type DesignSource } from "../../services/agsdl/blueprints";
import "./design.css";

export function DesignLibraryDialog({ target, mode, onClose }: { target: AgsdlTarget; mode: "start" | "blueprint" | "system" | "save"; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [version, setVersion] = useState(session.version);
  const [tab, setTab] = useState(mode === "system" ? "system" : "blueprint");
  const [sources, setSources] = useState<DesignSource[]>(builtInDesignSources);
  const [loading, setLoading] = useState(mode !== "save" && mode !== "start");
  const [selected, setSelected] = useState<DesignSource>();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (mode === "save" || mode === "start") return;
    let active = true;
    void listDesignSources().then(items => { if (active) setSources(items); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode]);
  const title = t(mode === "save" ? "agsdl.design.saveBlueprint" : mode === "start" ? "agsdl.design.newSystem" : "agsdl.design.library");
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const store = useAgsdlStore.getState();
      const current = store.sessions[agsdlSessionKey(target)];
      if (current.version !== version) throw new Error(t("agsdl.viewer.editConflict"));
      if (mode === "save") {
        await saveBlueprint(target, name.trim(), undefined, version);
      } else if (applied) {
        await store.save(target);
      } else if (mode === "start") {
        if (current.source) throw new Error(t("agsdl.design.notEmpty"));
        store.replace(target, createEmptySystem(name.trim()), {}, version);
        setVersion(useAgsdlStore.getState().sessions[agsdlSessionKey(target)].version);
        setApplied(true);
        await store.save(target);
      } else {
        if (!selected) return;
        await instantiateDesign(target, selected, version, { onApplied: nextVersion => { setApplied(true); setVersion(nextVersion); } });
      }
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const description = (item: DesignSource) => {
    try { return readDesign(item.source).purpose; } catch { return ""; }
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
          <button disabled={busy || applied} aria-pressed={tab === "blueprint"} onClick={() => { setTab("blueprint"); setSelected(undefined); }}>{t("agsdl.design.blueprints")}</button>
          <button disabled={busy || applied} aria-pressed={tab === "system"} onClick={() => { setTab("system"); setSelected(undefined); }}>{t("agsdl.design.systems")}</button>
        </div>
        <input className="agsdl-design-search" value={query} placeholder={t("agsdl.design.search")} aria-label={t("agsdl.design.search")} onChange={event => setQuery(event.target.value)} />
        {loading && <p role="status" className="agsdl-muted">{t("agsdl.loading")}</p>}
        <div className="agsdl-design-sources">
          {sources.filter(item => item.kind === tab && item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <button key={item.id} className="agsdl-design-source" disabled={busy || applied} aria-pressed={selected?.id === item.id} onClick={() => setSelected(item)}>
            {item.kind === "blueprint" ? <BookOpen size={16} /> : <Copy size={16} />}<span><strong>{item.name}</strong><small>{item.builtin ? t("agsdl.design.included") : description(item)}</small></span><ArrowRight size={14} />
          </button>)}
          {!loading && !sources.some(item => item.kind === tab && item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="agsdl-muted">{t("agsdl.design.noSources")}</p>}
        </div>
        {selected && <p className="agsdl-muted">{t("agsdl.design.independentCopy")}</p>}
      </>}
      {error && <p role="alert" className="agsdl-unresolved">{error}</p>}
    </div>
    <footer><button onClick={onClose} disabled={busy}>{t("agsdl.cancel")}</button>
      <button type="submit" form={mode === "save" || mode === "start" ? "agsdl-library-form" : undefined} onClick={mode === "save" || mode === "start" ? undefined : () => void submit()} disabled={busy || session.saving || (mode === "save" || mode === "start" ? !name.trim() : !selected)}>{t(busy ? "agsdl.saving" : applied ? "agsdl.retry" : mode === "save" ? "agsdl.save" : "agsdl.design.create")}</button>
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
