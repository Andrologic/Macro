import { DiscardChangesDialog } from "./DiscardChangesDialog";
import { DisclosureSummary } from "./DisclosureSummary";
import { useId, useState } from "react";
import { FileText, MessageSquarePlus, ListChecks, Layers, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from "../../stores/useAgsdlStore";
import { readDesign, type DesignMetadata } from "../../services/agsdl/design";
import "./design.css";

export function SystemDesignDialog({ target, onClose, canEdit = true, onAttach }: { target: AgsdlTarget; onClose: () => void; canEdit?: boolean; onAttach?: () => Promise<void> }) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [initial] = useState(() => {
    try { return { design: readDesign(session.source, session.design), version: session.version }; }
    catch (error) { return { error: String(error) }; }
  });
  const [draft, setDraft] = useState(initial.design);
  const [version, setVersion] = useState(initial.version);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState(initial.error ?? "");
  const [discard, setDiscard] = useState(false);
  const [adaptationsOpen, setAdaptationsOpen] = useState(initial.design?.requirements.some(item => !item.value.trim()) ?? false);
  const fieldId = useId();
  const editable = canEdit && session.status === "draft" && !busy && !applied;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.design);
  const update = (patch: Partial<DesignMetadata>) => { if (draft) setDraft({ ...draft, ...patch }); };
  const close = () => { if (busy) return; if (dirty && !applied) setDiscard(true); else onClose(); };
  const save = async (openChat = false) => {
    if (!draft || busy || !canEdit || session.status !== "draft") return;
    setBusy(true); setError("");
    try {
      const store = useAgsdlStore.getState();
      const current = store.sessions[agsdlSessionKey(target)];
      if (current.version !== version) throw new Error(t("agsdl.viewer.editConflict"));
      if (!applied) {
        store.setDesign(target, draft, version);
        setVersion(useAgsdlStore.getState().sessions[agsdlSessionKey(target)].version);
        setApplied(true);
      }
      await store.save(target);
      if (openChat) await onAttach?.();
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <Dialog title={t("agsdl.design.settings")} onClose={close} closeOnBackdropClick
    backdropClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" panelClassName="agsdl-detail-modal agsdl-design-modal">
    <header><strong>{t("agsdl.design.settings")}</strong>{onAttach && <button className="agsdl-icon-button" disabled={busy || dirty} aria-label={t("agsdl.attachToChat")} title={t("agsdl.attachToChat")} onClick={() => { setBusy(true); void onAttach().then(onClose).catch(error => setError(String(error))).finally(() => setBusy(false)); }}><MessageSquarePlus size={16} /></button>}<button className="agsdl-icon-button" disabled={busy} onClick={close} aria-label={t("agsdl.close")}><X size={16} /></button></header>
    <div className="agsdl-inspector-body">
      {draft && <form id="agsdl-system-design" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="agsdl-edit-field"><span>{t("agsdl.design.purpose")}</span>
          <textarea rows={3} value={draft.purpose} disabled={!editable} placeholder={t("agsdl.design.purposeHint")} onChange={event => update({ purpose: event.target.value })} />
        </label>
        <details className="agsdl-details">
          <DisclosureSummary><Layers size={14} />{t("agsdl.design.context")}</DisclosureSummary>
          <label className="agsdl-edit-field"><span className="agsdl-muted">{t("agsdl.design.contextHint")}</span>
            <textarea rows={4} value={draft.context} disabled={!editable} onChange={event => update({ context: event.target.value })} />
          </label>
        </details>
        {draft.rules.length > 0 && <details className="agsdl-details">
          <DisclosureSummary>{t("agsdl.design.rules")} · {draft.rules.length}</DisclosureSummary>
          {draft.rules.map(rule => <div className="agsdl-design-item" key={rule.id}><strong>{rule.title}</strong><p>{rule.instructions}</p></div>)}
        </details>}
        {draft.requirements.length > 0 && <details className="agsdl-details" open={adaptationsOpen} onToggle={event => setAdaptationsOpen(event.currentTarget.open)}>
          <DisclosureSummary><ListChecks size={14} />{t("agsdl.design.adaptations")} {draft.requirements.length > 0 && `· ${draft.requirements.length}`}</DisclosureSummary>
          {draft.requirements.map((item, index) => <div className="agsdl-design-item agsdl-requirement" key={item.id}>
            <label className="agsdl-edit-field" htmlFor={`${fieldId}-${index}`}>
              <span className="agsdl-requirement-label">{item.label || t("agsdl.design.fieldName")}{!item.value.trim() && <small>{t("agsdl.design.toComplete")}</small>}</span>
            </label>
            {item.description && <p className="agsdl-muted" id={`${fieldId}-${index}-help`}>{item.description}</p>}
            <textarea id={`${fieldId}-${index}`} rows={2} aria-describedby={item.description ? `${fieldId}-${index}-help` : undefined} value={item.value} disabled={!editable} onChange={event => update({ requirements: draft.requirements.map((entry, i) => i === index ? { ...entry, value: event.target.value } : entry) })} />

          </div>)}

        </details>}
        {draft.origin && <p className="agsdl-design-origin"><FileText size={13} />{t("agsdl.design.fromBlueprint", { name: draft.origin.name })}</p>}
      </form>}
      {error && <p role="alert" className="agsdl-unresolved">{error}</p>}

    </div>
    {draft && canEdit && session.status === "draft" && <footer><button onClick={close} disabled={busy}>{t("agsdl.cancel")}</button><button type="submit" form="agsdl-system-design" disabled={busy || session.saving || !dirty}>{t(busy ? "agsdl.saving" : applied ? "agsdl.retry" : "agsdl.save")}</button>{onAttach && <button disabled={busy || session.saving || !dirty} onClick={() => void save(true)}><MessageSquarePlus size={14} />{t("agsdl.saveAndChat")}</button>}</footer>}
    {discard && <DiscardChangesDialog onCancel={() => setDiscard(false)} onDiscard={onClose} />}
  </Dialog>;
}
