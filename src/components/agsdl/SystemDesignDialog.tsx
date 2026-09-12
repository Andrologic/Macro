import { useState } from "react";
import { FileText, Plus, Trash2, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from "../../stores/useAgsdlStore";
import { designChanges, readDesign, type DesignMetadata } from "../../services/agsdl/design";
import "./design.css";

export function SystemDesignDialog({ target, onClose, canEdit = true }: { target: AgsdlTarget; onClose: () => void; canEdit?: boolean }) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [initial] = useState(() => {
    try { return { design: readDesign(session.source), version: session.version }; }
    catch (error) { return { error: String(error) }; }
  });
  const [draft, setDraft] = useState(initial.design);
  const [version, setVersion] = useState(initial.version);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState(initial.error ?? "");
  const [discard, setDiscard] = useState(false);
  const [adaptationsOpen, setAdaptationsOpen] = useState(initial.design?.requirements.some(item => !item.value.trim()) ?? false);
  const editable = canEdit && session.status === "draft" && !busy && !applied;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.design);
  const update = (patch: Partial<DesignMetadata>) => { if (draft) setDraft({ ...draft, ...patch }); };
  const close = () => { if (busy) return; if (dirty && !applied) setDiscard(true); else onClose(); };
  const save = async () => {
    if (!draft || busy || !canEdit || session.status !== "draft") return;
    setBusy(true); setError("");
    try {
      const store = useAgsdlStore.getState();
      const current = store.sessions[agsdlSessionKey(target)];
      if (current.version !== version) throw new Error(t("agsdl.viewer.editConflict"));
      if (!applied) {
        store.edit(target, designChanges(current.source, draft), version);
        setVersion(useAgsdlStore.getState().sessions[agsdlSessionKey(target)].version);
        setApplied(true);
      }
      await store.save(target);
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <Dialog title={t("agsdl.design.settings")} onClose={close} closeOnBackdropClick
    backdropClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" panelClassName="agsdl-detail-modal agsdl-design-modal">
    <header><strong>{t("agsdl.design.settings")}</strong><button className="agsdl-icon-button" onClick={close} aria-label={t("agsdl.close")}><X size={16} /></button></header>
    <div className="agsdl-inspector-body">
      {draft && <form id="agsdl-system-design" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="agsdl-edit-field"><span>{t("agsdl.design.purpose")}</span>
          <textarea rows={3} value={draft.purpose} disabled={!editable} placeholder={t("agsdl.design.purposeHint")} onChange={event => update({ purpose: event.target.value })} />
        </label>
        <details className="agsdl-details">
          <summary>{t("agsdl.design.context")}</summary>
          <label className="agsdl-edit-field"><span className="agsdl-muted">{t("agsdl.design.contextHint")}</span>
            <textarea rows={4} value={draft.context} disabled={!editable} onChange={event => update({ context: event.target.value })} />
          </label>
        </details>
        <details className="agsdl-details">
          <summary>{t("agsdl.design.rules")} {draft.rules.length > 0 && `· ${draft.rules.length}`}</summary>
          <p className="agsdl-muted">{t("agsdl.design.rulesHint")}</p>
          {draft.rules.map((rule, index) => <div className="agsdl-design-item" key={rule.id}>
            <label className="agsdl-edit-field"><span>{t("agsdl.design.ruleName")}</span><input required value={rule.title} disabled={!editable} onChange={event => update({ rules: draft.rules.map((item, i) => i === index ? { ...item, title: event.target.value } : item) })} /></label>
            <label className="agsdl-edit-field"><span>{t("agsdl.instructions")}</span><textarea rows={3} required value={rule.instructions} disabled={!editable} onChange={event => update({ rules: draft.rules.map((item, i) => i === index ? { ...item, instructions: event.target.value } : item) })} /></label>
            <button type="button" className="agsdl-design-remove" disabled={!editable} onClick={() => update({ rules: draft.rules.filter((_, i) => i !== index) })}><Trash2 size={12} />{t("agsdl.design.remove")}</button>
          </div>)}
          <button type="button" className="agsdl-design-add" disabled={!editable} onClick={() => update({ rules: [...draft.rules, { id: crypto.randomUUID(), title: "", instructions: "" }] })}><Plus size={13} />{t("agsdl.design.addRule")}</button>
        </details>
        <details className="agsdl-details" open={adaptationsOpen} onToggle={event => setAdaptationsOpen(event.currentTarget.open)}>
          <summary>{t("agsdl.design.adaptations")} {draft.requirements.length > 0 && `· ${draft.requirements.length}`}</summary>
          <p className="agsdl-muted">{t("agsdl.design.adaptationsHint")}</p>
          {draft.requirements.map((item, index) => <div className="agsdl-design-item" key={item.id}>
            <label className="agsdl-edit-field"><span>{t("agsdl.design.fieldName")}</span><input required value={item.label} disabled={!editable} onChange={event => update({ requirements: draft.requirements.map((entry, i) => i === index ? { ...entry, label: event.target.value } : entry) })} /></label>
            <label className="agsdl-edit-field"><span>{t("agsdl.design.fieldDescription")}</span><input value={item.description} disabled={!editable} onChange={event => update({ requirements: draft.requirements.map((entry, i) => i === index ? { ...entry, description: event.target.value } : entry) })} /></label>
            <label className="agsdl-edit-field"><span>{t("agsdl.design.fieldValue")}</span><textarea rows={2} value={item.value} placeholder={t("agsdl.design.toComplete")} disabled={!editable} onChange={event => update({ requirements: draft.requirements.map((entry, i) => i === index ? { ...entry, value: event.target.value } : entry) })} /></label>
            <button type="button" className="agsdl-design-remove" disabled={!editable} onClick={() => update({ requirements: draft.requirements.filter((_, i) => i !== index) })}><Trash2 size={12} />{t("agsdl.design.remove")}</button>
          </div>)}
          <button type="button" className="agsdl-design-add" disabled={!editable} onClick={() => update({ requirements: [...draft.requirements, { id: crypto.randomUUID(), label: "", description: "", value: "" }] })}><Plus size={13} />{t("agsdl.design.addField")}</button>
        </details>
        {draft.origin && <p className="agsdl-design-origin"><FileText size={13} />{t("agsdl.design.fromBlueprint", { name: draft.origin.name })}</p>}
      </form>}
      {error && <p role="alert" className="agsdl-unresolved">{error}</p>}
      {discard && <div className="agsdl-discard" role="alert"><p>{t("agsdl.discardTitle")}</p><button onClick={() => setDiscard(false)}>{t("agsdl.cancel")}</button><button onClick={onClose}>{t("agsdl.viewer.discardEdit")}</button></div>}
    </div>
    {draft && canEdit && session.status === "draft" && <footer><button onClick={close} disabled={busy}>{t("agsdl.cancel")}</button><button type="submit" form="agsdl-system-design" disabled={busy || session.saving || !dirty}>{t(busy ? "agsdl.saving" : applied ? "agsdl.retry" : "agsdl.save")}</button></footer>}
  </Dialog>;
}
