import { useState, type ReactNode } from "react";
import { Pencil, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from "../../stores/useAgsdlStore";
import { componentChanges, componentFields, type ComponentField } from "../../services/agsdl/componentFields";
import type { ViewerCard } from "../../services/agsdl/viewer";

export function ComponentDetailsDialog({ title, target, card, canEdit = true, children, onClose }: {
  title: string; target: AgsdlTarget; card?: ViewerCard; canEdit?: boolean; children: ReactNode; onClose: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [draft, setDraft] = useState<{ fields: ComponentField[]; values: string[]; version: string }>();
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const dirty = draft?.fields.some((field, index) => field.value !== draft.values[index]);
  const close = () => {
    if (busy) return;
    if (dirty && !applied) setDiscard(true);
    else onClose();
  };
  const start = () => {
    if (!card || !session) return;
    const fields = componentFields(session.source, card);
    setDraft({ fields, values: fields.map(field => field.value), version: session.version });
    setError("");
  };
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true); setError("");
    try {
      const store = useAgsdlStore.getState();
      const current = store.sessions[agsdlSessionKey(target)];
      if (current.version !== draft.version) throw new Error(t("agsdl.viewer.editConflict"));
      if (!applied) {
        const changes = componentChanges(draft.fields, draft.values);
        if (!changes.length) { setDraft(undefined); return; }
        store.edit(target, changes, draft.version);
        const version = useAgsdlStore.getState().sessions[agsdlSessionKey(target)].version;
        setDraft({ ...draft, version }); setApplied(true);
      }
      await store.save(target);
      setDraft(undefined); setApplied(false); setDiscard(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  return <Dialog title={title} onClose={close} closeOnBackdropClick
    backdropClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
    panelClassName="agsdl-detail-modal">
    <header><strong>{title}</strong><div className="agsdl-header-actions">
      {!draft && canEdit && card && ["invoke", "Agent", "System", "Instructions", "condition", "approval"].includes(card.kind) && session?.status === "draft" && <button className="agsdl-icon-button" onClick={start} disabled={session.saving} aria-label={t("agsdl.viewer.editComponent")} title={t("agsdl.viewer.editComponent")}><Pencil size={15} /></button>}
      <button className="agsdl-icon-button" disabled={busy} onClick={close} aria-label={t("agsdl.close")}><X size={16} /></button>
    </div></header>
    <div className="agsdl-inspector-body">
      {draft ? <form id="agsdl-component-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <p className="agsdl-muted">{t("agsdl.viewer.editScope")}</p>
        {draft.fields.map((field, index) => <label className="agsdl-edit-field" key={field.path}>
          <span>{t(field.kind === "name" ? "agsdl.viewer.componentName" : "agsdl.instructions")}{field.kind === "instructions" && draft.fields.length > 2 ? ` ${index}` : ""}</span>
          {field.kind === "name" ? <input required value={draft.values[index]} disabled={busy || applied} onChange={event => setDraft({ ...draft, values: draft.values.map((value, i) => i === index ? event.target.value : value) })} />
            : <textarea rows={7} value={draft.values[index]} disabled={busy || applied} onChange={event => setDraft({ ...draft, values: draft.values.map((value, i) => i === index ? event.target.value : value) })} />}
        </label>)}
      </form> : children}
      {error && <p role="alert" className="agsdl-unresolved">{error}</p>}
      {applied && error && <p>{t("agsdl.viewer.editSaveFailed")}</p>}
      {discard && <div className="agsdl-discard" role="alert">
        <p>{t("agsdl.discardTitle")}</p>
        <button onClick={() => setDiscard(false)}>{t("agsdl.cancel")}</button>
        <button onClick={onClose}>{t("agsdl.viewer.discardEdit")}</button>
      </div>}
    </div>
    {draft && <footer>
      <button disabled={busy} onClick={() => { if (applied) close(); else { setDraft(undefined); setError(""); setDiscard(false); } }}>{t(applied ? "agsdl.close" : "agsdl.cancel")}</button>
      <button form="agsdl-component-form" type="submit" disabled={busy || session?.saving || !dirty}>{t(busy ? "agsdl.saving" : applied ? "agsdl.retry" : "agsdl.save")}</button>
    </footer>}
  </Dialog>;
}
