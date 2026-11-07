import { useState, type ReactNode } from "react";
import { Dialog } from "../ui/Dialog";
import { DiscardChangesDialog } from "./DiscardChangesDialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from "../../stores/useAgsdlStore";
import { componentProperties, propertyChanges, type ComponentProperties } from "../../services/agsdl/componentProperties";
import { stringify } from "../../vendor/agsdl/browser-reader.mjs";
import { object, scanSource } from "../../services/agsdl/document";
import type { ViewerCard } from "../../services/agsdl/viewer";

export function ComponentDetails030({ title, target, card, canEdit = true, children, onClose, onAttach, onBack }: {
  title: string; target: AgsdlTarget; card?: ViewerCard; canEdit?: boolean; children: ReactNode; onClose: () => void; onAttach?: () => Promise<void>; onBack?: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [draft, setDraft] = useState<{ properties: ComponentProperties; values: string[]; version: string }>();
  const [busy, setBusy] = useState(false), [applied, setApplied] = useState(false), [error, setError] = useState("");
  const [discard, setDiscard] = useState<"close" | "edit">();
  const dirty = draft?.properties.fields.some((field, index) => field.value !== draft.values[index]);
  const close = () => { if (!busy) { if (dirty && !applied) setDiscard("close"); else onClose(); } };
  const save = async () => {
    if (!draft || busy || !canEdit || session?.status !== "draft") return;
    setBusy(true); setError("");
    try {
      const store = useAgsdlStore.getState();
      if (store.sessions[agsdlSessionKey(target)]?.version !== draft.version) throw new Error("conflict");
      if (!applied) {
        const changes = propertyChanges(draft.properties.fields, draft.values);
        if (!changes.length) { setDraft(undefined); return; }
        store.edit(target, changes, draft.version);
        setDraft({ ...draft, version: useAgsdlStore.getState().sessions[agsdlSessionKey(target)].version }); setApplied(true);
      }
      await store.save(target); setDraft(undefined); setApplied(false);
    } catch (cause) { setError(t(cause instanceof Error && cause.message === "conflict" ? "agsdl.viewer.editConflict" : "agsdl.edition030.editFailed")); }
    finally { setBusy(false); }
  };
  const update = (index: number, value: string) => { if (draft) setDraft({ ...draft, values: draft.values.map((old, i) => i === index ? value : old) }); };
  return <Dialog title={title} onClose={close} closeOnBackdropClick panelClassName="agsdl-detail-modal" backdropClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
    <header><strong>{title}</strong><div className="agsdl-header-actions">
      {!draft && onBack && <button onClick={onBack}>{t("agsdl.viewer.backToComponent")}</button>}
      {!draft && canEdit && session?.status === "draft" && <button disabled={busy || session.saving} onClick={() => {
        if (!card) return;
        const properties = componentProperties(session.source, card);
        setDraft({ properties, values: properties.fields.map(field => field.value), version: session.version }); setError("");
      }}>{t("agsdl.viewer.editComponent")}</button>}
      <button disabled={busy} onClick={close}>{t("agsdl.close")}</button></div></header>
    <div className="agsdl-inspector-body">
      {draft ? <form className="agsdl-exact-form" id="agsdl-exact-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <p>{t("agsdl.edition030.exactHint")}</p>
        {draft.properties.shared && <p>{t("agsdl.viewer.sharedProperties")}</p>}
        {draft.properties.fields.map((field, index) => field.label === "model" ? <Model030 key={`model-${field.path}`} value={draft.values[index]} disabled={busy || applied} onChange={value => update(index, value)} /> : null)}
        {draft.properties.fields.map((field, index) => <div key={field.path}>
          <label className="agsdl-edit-field"><span>{field.label}</span><small>{field.path}</small>
            <textarea rows={Math.min(12, Math.max(2, draft.values[index].split("\n").length))} spellCheck={false} value={draft.values[index]} readOnly={field.readonly} disabled={busy || applied} onChange={event => update(index, event.target.value)} />
          </label>
        </div>)}
      </form> : children}
      {error && <p role="alert">{error}</p>}
      {applied && error && <p>{t("agsdl.viewer.editSaveFailed")}</p>}
    </div>
    <footer>{draft ? <>
      <button disabled={busy} onClick={() => { if (applied) close(); else if (dirty) setDiscard("edit"); else setDraft(undefined); }}>{t("agsdl.cancel")}</button>
      <button form="agsdl-exact-form" type="submit" disabled={busy || !canEdit || session?.saving || session?.status !== "draft" || !dirty}>{t(applied ? "agsdl.retry" : "agsdl.save")}</button>
    </> : onAttach && <button disabled={busy} onClick={() => { setBusy(true); void onAttach().then(onClose).catch(() => setError(t("agsdl.actionFailed"))).finally(() => setBusy(false)); }}>{t("agsdl.attachToChat")}</button>}</footer>
    {discard && <DiscardChangesDialog onCancel={() => setDiscard(undefined)} onDiscard={() => { if (discard === "close") onClose(); else setDraft(undefined); setDiscard(undefined); }} />}
  </Dialog>;
}

function Model030({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { t } = useAgsdlTranslation();
  let model: Record<string, unknown>;
  try { model = value.trim() ? object(scanSource(value).tree) : {}; } catch { return null; }
  const change = (key: string, input: string) => {
    const next: Record<string, unknown> = { ...model };
    if (input) next[key] = input; else delete next[key];
    onChange(Object.keys(next).length || value.trim() ? stringify(next) : "");
  };
  return <fieldset disabled={disabled}><legend>{t("agsdl.macroConfig.title")}</legend><p>{t("agsdl.edition030.modelHint")}</p>
    {(["name", "effort"] as const).map(key => <label className="agsdl-edit-field" key={key}><span>{t(key === "name" ? "agsdl.macroConfig.model" : "agsdl.edition030.effort")}</span>
      <input value={typeof model[key] === "string" ? model[key] as string : ""} placeholder={t("agsdl.edition030.harnessDefault")} onChange={event => change(key, event.target.value)} /></label>)}
  </fieldset>;
}
