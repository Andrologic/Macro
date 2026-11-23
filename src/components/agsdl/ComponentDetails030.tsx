import { useId, useState, type ReactNode } from "react";
import { ArrowLeft, Pencil, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { DiscardChangesDialog } from "./DiscardChangesDialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { agsdlSessionKey, useAgsdlStore, type AgsdlDocumentTarget } from "../../stores/useAgsdlStore";
import { agentPropertyLocks030, componentProperties, propertyChanges, type ComponentProperties } from "../../services/agsdl/componentProperties";
import { object, pointerPart, scanSource } from "../../services/agsdl/document";
import { authoringFields030, authoringValues030, patchAuthoringValue030, updateAuthoringField030, type AuthoringField030 } from "../../services/agsdl/authoringFields030";
import { DisclosureSummary } from "./DisclosureSummary";
import type { ViewerCard } from "../../services/agsdl/viewer";

export function ComponentDetails030({ title, target, card, canEdit = true, children, onClose, onAttach, onBack }: {
  title: string; target: AgsdlDocumentTarget; card?: ViewerCard; canEdit?: boolean; children: ReactNode; onClose: () => void; onAttach?: () => Promise<void>; onBack?: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const tabId = useId();
  const [tab, setTab] = useState("properties");
  const [draft, setDraft] = useState<{ properties: ComponentProperties; values: string[]; lineInputs: Record<string, string>; version: string }>();
  const [busy, setBusy] = useState(false), [applied, setApplied] = useState(false), [error, setError] = useState("");
  const [discard, setDiscard] = useState<"close" | "edit">();
  const values = draft ? authoringValues030(draft.properties.fields, draft.values, draft.lineInputs) : [];
  const locks = draft ? agentPropertyLocks030(draft.properties.fields, values) : undefined;
  const dirty = draft?.properties.fields.some((field, index) => field.value !== values[index]);
  const close = () => { if (!busy) { if (dirty && !applied) setDiscard("close"); else onClose(); } };
  const save = async () => {
    if (!draft || busy || !canEdit || session?.status !== "draft") return;
    setBusy(true); setError("");
    try {
      const store = useAgsdlStore.getState();
      if (store.sessions[agsdlSessionKey(target)]?.version !== draft.version) throw new Error("conflict");
      if (!applied) {
        const changes = propertyChanges(draft.properties.fields, authoringValues030(draft.properties.fields, draft.values, draft.lineInputs, true));
        if (!changes.length) { setDraft(undefined); return; }
        await store.edit(target, changes, draft.version);
        setDraft({ ...draft, version: useAgsdlStore.getState().sessions[agsdlSessionKey(target)].version }); setApplied(true);
      }
      await store.save(target); setDraft(undefined); setApplied(false);
    } catch (cause) { setError(t(cause instanceof Error && cause.message === "conflict" ? "agsdl.viewer.editConflict" : "agsdl.edition030.editFailed")); }
    finally { setBusy(false); }
  };
  const update = (index: number, value: string) => {
    if (draft && !locks?.locked(index)) setDraft({ ...draft, values: values.map((old, i) => i === index ? value : old),
      lineInputs: Object.fromEntries(Object.entries(draft.lineInputs).filter(([key]) => !key.startsWith(`${index}:`))) });
  };
  return <Dialog title={title} onClose={close} closeOnBackdropClick panelClassName="agsdl-detail-modal" backdropClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
    <header><strong>{title}</strong><div className="agsdl-header-actions">
      {!draft && onBack && <button className="agsdl-icon-button" onClick={onBack} title={t("agsdl.viewer.backToComponent")} aria-label={t("agsdl.viewer.backToComponent")}><ArrowLeft size={15} /><span className="sr-only">{t("agsdl.viewer.backToComponent")}</span></button>}
      {!draft && canEdit && session?.status === "draft" && <button className="agsdl-icon-button" title={t("agsdl.viewer.editComponent")} aria-label={t("agsdl.viewer.editComponent")} disabled={busy || session.saving} onClick={() => {
        if (!card) return;
        const properties = componentProperties(session.source, card);
        setDraft({ properties, values: properties.fields.map(field => field.value), lineInputs: {}, version: session.version }); setTab("properties"); setError("");
      }}><Pencil size={15} /><span className="sr-only">{t("agsdl.viewer.editComponent")}</span></button>}
      <button className="agsdl-icon-button" disabled={busy} onClick={close} title={t("agsdl.close")} aria-label={t("agsdl.close")}><X size={15} /><span className="sr-only">{t("agsdl.close")}</span></button></div></header>
    <div className="agsdl-inspector-body">
      {draft ? <form className="agsdl-exact-form" id="agsdl-exact-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <p className="agsdl-muted">{t("agsdl.authoring030.draftHint")}</p>
        {draft.properties.shared && <p className="agsdl-muted">{t("agsdl.viewer.sharedProperties")}</p>}
        {(locks?.referenceChanged || locks?.definitionChanged) && <p role="status">{t(locks.referenceChanged ? "agsdl.authoring030.ownerChangeHint" : "agsdl.authoring030.definitionChangeHint")}</p>}
        <div role="tablist" aria-label={t("agsdl.properties")} className="flex gap-3 border-b border-[rgb(var(--border))] pb-2">
          {["properties", "json"].map(value => <button key={value} type="button" role="tab" id={`${tabId}-${value}`} aria-selected={tab === value} aria-controls={`${tabId}-${value}-panel`} className={tab === value ? "font-semibold" : "agsdl-muted"} onClick={() => setTab(value)} onKeyDown={event => {
            if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setTab(value === "json" ? "properties" : "json"); document.getElementById(`${tabId}-${value === "json" ? "properties" : "json"}`)?.focus(); }
          }}>{t(value === "properties" ? "agsdl.properties" : "agsdl.authoring030.exactJson")}</button>)}
        </div>
        <div role="tabpanel" id={`${tabId}-properties-panel`} aria-labelledby={`${tabId}-properties`} hidden={tab !== "properties"}>
          <BusinessFields030 fields={draft.properties.fields} values={values} disabled={busy || applied} locked={locks?.locked} onChange={nextValues => {
            const next = agentPropertyLocks030(draft.properties.fields, nextValues);
            if (!(next.referenceChanged && next.definitionChanged)) setDraft({ ...draft, values: nextValues });
          }} onLinesChange={(field, value) => { if (!locks?.locked(field.index)) setDraft({ ...draft, lineInputs: { ...draft.lineInputs, [`${field.index}:${field.path}`]: value } }); }} />
          <details className="agsdl-details"><DisclosureSummary>{t("agsdl.authoring030.advanced")}</DisclosureSummary>
            {draft.properties.fields.map((field, index) => field.label === "model" ? <Model030 key={`model-${field.path}`} value={values[index]} disabled={busy || applied || !!locks?.locked(index)} onChange={value => update(index, value)} /> : null)}
            <p className="agsdl-muted">{t("agsdl.authoring030.exactHint")}</p>
            <button type="button" className="agsdl-link" onClick={() => setTab("json")}>{t("agsdl.authoring030.exactJson")}</button>
          </details>
        </div>
        <div role="tabpanel" id={`${tabId}-json-panel`} aria-labelledby={`${tabId}-json`} hidden={tab !== "json"}>
          <p className="agsdl-muted">{t("agsdl.edition030.exactHint")}</p>
          {draft.properties.fields.map((field, index) => <label key={field.path} className="agsdl-edit-field"><span>{field.label}</span><small>{field.path}</small>
            <textarea rows={Math.min(12, Math.max(2, values[index].split("\n").length))} spellCheck={false} value={values[index]} readOnly={field.readonly} disabled={busy || applied || locks?.locked(index)} onChange={event => update(index, event.target.value)} />
          </label>)}
        </div>
      </form> : <>
        {session && card && <BusinessFields030 fields={readProperties030(session.source, card)} />}
        {children}
        {card?.edition030 && <details className="agsdl-details"><DisclosureSummary>{t("agsdl.authoring030.advanced")}</DisclosureSummary>
          <h4>{t("agsdl.authoring030.exactJson")}</h4>
          <pre className="agsdl-source-value">{card.edition030.sourceJson}</pre>
          {card.edition030.definitionJson && card.path !== card.edition030.agentPath && <pre className="agsdl-source-value">{card.edition030.definitionJson}</pre>}
        </details>}
      </>}
      {error && <p role="alert">{error}</p>}
      {applied && error && <p>{t("agsdl.viewer.editSaveFailed")}</p>}
    </div>
    <footer>{draft ? <>
      <button disabled={busy} onClick={() => { if (applied) close(); else if (dirty) setDiscard("edit"); else setDraft(undefined); }}>{t("agsdl.cancel")}</button>
      <button form="agsdl-exact-form" type="submit" disabled={busy || !canEdit || session?.saving || session?.status !== "draft" || !dirty}>{t(applied ? "agsdl.retry" : "agsdl.authoring030.saveDraft")}</button>
    </> : onAttach && <button disabled={busy} onClick={() => { setBusy(true); void onAttach().then(onClose).catch(() => setError(t("agsdl.actionFailed"))).finally(() => setBusy(false)); }}>{t("agsdl.attachToChat")}</button>}</footer>
    {discard && <DiscardChangesDialog onCancel={() => setDiscard(undefined)} onDiscard={() => { if (discard === "close") onClose(); else setDraft(undefined); setDiscard(undefined); }} />}
  </Dialog>;
}

function Model030({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { t } = useAgsdlTranslation();
  let model: Record<string, unknown>;
  try { const parsed = value.trim() ? scanSource(value).tree : {}; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null; model = object(parsed); } catch { return null; }
  const change = (key: string, input: string) => {
    onChange(patchAuthoringValue030(value, `/${key}`, input ? JSON.stringify(input) : undefined));
  };
  return <fieldset disabled={disabled}><legend>{t("agsdl.macroConfig.title")}</legend><p>{t("agsdl.edition030.modelHint")}</p>
    {(["name", "effort"] as const).map(key => <label className="agsdl-edit-field" key={key}><span>{t(key === "name" ? "agsdl.macroConfig.model" : "agsdl.edition030.effort")}</span>
      <input value={typeof model[key] === "string" ? model[key] as string : ""} placeholder={t("agsdl.edition030.harnessDefault")} onChange={event => change(key, event.target.value)} /></label>)}
  </fieldset>;
}

function BusinessFields030({ fields, values = fields.map(field => field.value), disabled, locked, onChange, onLinesChange }: {
  fields: ComponentProperties["fields"]; values?: string[]; disabled?: boolean; locked?: (index: number) => boolean; onChange?: (values: string[]) => void; onLinesChange?: (field: AuthoringField030, value: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const controls = authoringFields030(fields, values);
  let first = true;
  return <>{(["general", "instructions", "mission", "information", "choices", "instance", "join"] as const).map(group => {
    const members = controls.filter(field => field.group === group && (onChange || field.value));
    const resources = group === "information" ? fields.findIndex(field => field.label === "resources") : -1;
    const choices = group === "choices" ? fields.findIndex(field => field.label === "next") : -1;
    if (!members.length && !(onChange && (resources >= 0 || choices >= 0))) return null;
    // The first group sits right under the header: a rule above it would separate nothing.
    const top = first; first = false;
    return <details key={group} className="agsdl-details" open={["general", "instructions", "mission"].includes(group)}
      style={top ? { minWidth: 0, marginTop: 0, paddingTop: 0, borderTopWidth: 0 } : { minWidth: 0 }}>
      <DisclosureSummary>{t(`agsdl.authoring030.groups.${group}`)}</DisclosureSummary>
      {["instructions", "mission", "information", "instance", "join"].includes(group) && <p className="agsdl-muted">{t(`agsdl.authoring030.hints.${group}`)}</p>}
      {members.map(field => <label className="agsdl-edit-field" style={{ marginTop: 8, gap: 4 }} key={`${field.index}:${field.path}`}>
        <span>{t(`agsdl.authoring030.fields.${field.label}`)}{field.name && !/^\d+$/.test(field.name) ? ` · ${field.name}` : ""}</span>
        {!onChange ? <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{field.kind === "select" ? field.optionLabels ? field.optionLabels[field.value] ?? field.value : t(`agsdl.authoring030.options.${field.value}`, { defaultValue: field.value }) : field.value}</span>
          : field.kind === "select" ? <select value={field.value} disabled={disabled || locked?.(field.index)} onChange={event => onChange(updateAuthoringField030(values, field, event.target.value))}>
            {!["workType", "joinMode", "destination"].includes(field.label) && <option value="">{t("agsdl.authoring030.default")}</option>}
            {field.label === "destination" && !field.options?.includes(field.value) && <option value={field.value} disabled>{field.value || t("agsdl.authoring030.default")}</option>}
            {field.options?.map(value => <option key={value} value={value}>{field.optionLabels ? field.optionLabels[value] : t(`agsdl.authoring030.options.${value}`)}</option>)}
          </select> : ["multiline", "lines"].includes(field.kind) ? <textarea rows={3} value={field.value} disabled={disabled || locked?.(field.index)} onChange={event => field.kind === "lines" ? onLinesChange?.(field, event.target.value) : onChange(updateAuthoringField030(values, field, event.target.value))} />
            : <input value={field.value} inputMode={field.kind === "integer" ? "numeric" : undefined} disabled={disabled || locked?.(field.index)} onChange={event => onChange(updateAuthoringField030(values, field, event.target.value))} />}
      </label>)}
      {onChange && resources >= 0 && <AddProperty030 kind="resource" disabled={disabled || locked?.(resources)} value={values[resources]} onChange={value => onChange(values.map((old, i) => i === resources ? value : old))} />}
      {onChange && choices >= 0 && <AddProperty030 kind="choice" disabled={disabled || locked?.(choices)} value={values[choices]} onChange={value => onChange(values.map((old, i) => i === choices ? value : old))} />}
    </details>;
  })}</>;
}

function AddProperty030({ kind, disabled, value, onChange }: { kind: "resource" | "choice"; disabled?: boolean; value: string; onChange: (value: string) => void }) {
  const { t } = useAgsdlTranslation();
  const [name, setName] = useState("");
  const [mode, setMode] = useState("value");
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = value ? scanSource(value).tree : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    record = object(parsed);
    if (kind === "choice" && (Object.hasOwn(record, "step") || Object.hasOwn(record, "output"))) return null;
  } catch { return null; }
  return <details className="agsdl-details"><DisclosureSummary>{t(`agsdl.authoring030.add.${kind}`)}</DisclosureSummary>
    <label className="agsdl-edit-field"><span>{t(`agsdl.authoring030.name.${kind}`)}</span><input value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></label>
    {kind === "resource" && <label className="agsdl-edit-field"><span>{t("agsdl.authoring030.sourceKind")}</span><select value={mode} disabled={disabled} onChange={event => setMode(event.target.value)}>{["value", "ref", "uri"].map(mode => <option key={mode} value={mode}>{t(`agsdl.authoring030.sources.${mode}`)}</option>)}</select></label>}
    <button type="button" className="agsdl-action-button" disabled={disabled || !name.trim() || Object.hasOwn(record, name)} onClick={() => {
      const path = `/${pointerPart(name)}`;
      onChange(patchAuthoringValue030(value, path, kind === "resource" ? JSON.stringify({ [mode]: "" }) : "[]")); setName("");
    }}>{t("agsdl.authoring030.add.confirm")}</button>
  </details>;
}

function readProperties030(source: string, card: ViewerCard): ComponentProperties["fields"] {
  try { return componentProperties(source, card).fields; } catch { return []; }
}
