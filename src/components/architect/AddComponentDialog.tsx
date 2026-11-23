import { useMemo, useState, type FormEvent } from "react";
import { localProjectEdit } from "../../stores/agsdl/projectEdits";
import {
  componentId, emptyNewComponent, planNewComponent, usedComponentIds, validateNewComponent,
  type NewComponentField, type NewComponentForm, type NewComponentKind,
} from "../../services/agsdl/newComponent";
import { agsdlSessionKey, useAgsdlStore, type BlueprintDocumentTarget } from "../../stores/useAgsdlStore";
import { agsdlErrorText } from "../agsdl/errorText";
import { DisclosureSummary } from "../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { SpinnerIcon } from "../ui/SpinnerIcon";
import { notify } from "../ui/toastService";
import { ArchitectDialogShell } from "./ArchitectDialogShell";

/**
 * Creates one agent, skill or tool by hand. The files are written through the same project batch
 * as every other edit; the flow is never touched, the author decides where an agent takes part.
 */
export function AddComponentDialog({ kind, target, onClose }: { kind: NewComponentKind; target: BlueprintDocumentTarget; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [form, setForm] = useState<NewComponentForm>(emptyNewComponent);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState("");
  const used = useMemo(() => usedComponentIds(session?.source ?? "", kind), [session?.source, kind]);
  const issue = validateNewComponent(kind, form, used);
  const id = componentId(form.name);
  const project = !!session?.project;
  // Only what the author has started to write is judged: an empty field is not yet a mistake.
  const shown = issue && (issue.key !== "empty") ? issue : undefined;
  const reason = issue ? t(`agsdl.architect.add.reason.${issue.field}.${issue.key}`) : undefined;
  const set = (patch: Partial<NewComponentForm>) => setForm(current => ({ ...current, ...patch }));
  const plan = !issue && session?.source ? (() => { try { return planNewComponent(kind, form, session.source, project); } catch { return undefined; } })() : undefined;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || issue || !session) return;
    setBusy(true); setError("");
    try {
      const store = useAgsdlStore.getState();
      if (!applied) {
        const current = store.sessions[agsdlSessionKey(target)];
        const next = planNewComponent(kind, form, current.source, !!current.project);
        if (current.project) {
          await store.applyProjectBatch(target, [...next.files, ...next.changes.map(change => localProjectEdit(current.project!.saved, change))], undefined, current.version);
        } else await store.edit(target, next.changes, current.version);
        setApplied(true);
      }
      await store.save(target);
      notify.success(t(`agsdl.architect.add.${kind}.done`, { name: form.name.trim() }));
      onClose();
    } catch (failure) {
      setError(agsdlErrorText(failure, t));
      setBusy(false);
    }
  };

  const fieldError = (field: NewComponentField) => shown?.field === field
    ? <span role="alert" className="text-xs text-red-500">{reason}</span> : null;
  const label = (name: "name" | "description" | "instructions" | "transport") =>
    t(name === "description" || name === "instructions" ? `agsdl.architect.add.${kind}.${name}` : `agsdl.architect.add.field.${name}`);
  const disabled = busy || applied;
  const title = t(`agsdl.architect.add.${kind}.title`);
  return <ArchitectDialogShell title={title} locked={busy} onClose={onClose}
    footer={<>
      <span className="mr-auto self-center text-[11px] text-muted-foreground">{shown ? undefined : reason}</span>
      <button type="button" disabled={busy} onClick={onClose}>{t("agsdl.cancel")}</button>
      <button type="submit" form="architect-add-component" className="agsdl-action-button is-primary" disabled={busy || !!issue} title={reason}>
        {busy && <SpinnerIcon size={12} />}{t(busy ? "agsdl.architect.add.adding" : applied ? "agsdl.retry" : "agsdl.architect.add.confirm")}
      </button>
    </>}>
    <form id="architect-add-component" className="space-y-3" onSubmit={event => void submit(event)} noValidate>
      <p className="!m-0 text-muted-foreground">{t(`agsdl.architect.add.${kind}.intro`)}</p>
      <label className="agsdl-edit-field">{label("name")}
        <input value={form.name} autoFocus maxLength={80} disabled={disabled} aria-invalid={shown?.field === "name" || undefined}
          placeholder={t(`agsdl.architect.add.${kind}.namePlaceholder`)} onChange={event => set({ name: event.target.value })} />
        {fieldError("name")}
        {!shown && id && id !== form.name.trim() && <span className="text-xs text-muted-foreground">{t("agsdl.architect.add.savedAs", { id })}</span>}
      </label>
      {kind !== "tool" && <label className="agsdl-edit-field">{label("description")}
        <input value={form.description} disabled={disabled} maxLength={200} onChange={event => set({ description: event.target.value })} />
      </label>}
      {kind !== "tool" && <label className="agsdl-edit-field">{label("instructions")}
        <textarea rows={5} value={form.instructions} disabled={disabled} onChange={event => set({ instructions: event.target.value })} />
      </label>}
      {kind === "tool" && <>
        <label className="agsdl-edit-field">{label("transport")}
          <select value={form.transport} disabled={disabled} onChange={event => set({ transport: event.target.value === "local" ? "local" : "remote" })}>
            <option value="remote">{t("agsdl.architect.add.transport.remote")}</option>
            <option value="local">{t("agsdl.architect.add.transport.local")}</option>
          </select>
        </label>
        <label className="agsdl-edit-field">{t(`agsdl.architect.add.tool.address.${form.transport}`)}
          <input value={form.address} disabled={disabled} spellCheck={false} aria-invalid={shown?.field === "address" || undefined}
            placeholder={t(`agsdl.architect.add.tool.addressPlaceholder.${form.transport}`)} onChange={event => set({ address: event.target.value })} />
          {fieldError("address")}
        </label>
        <p className="!m-0 text-xs text-muted-foreground">{t(`agsdl.architect.add.tool.addressHelp.${form.transport}`)}</p>
      </>}
      {kind === "agent" && <details className="agsdl-details">
        <DisclosureSummary>{t("agsdl.authoring030.advanced")}</DisclosureSummary>
        <label className="agsdl-edit-field">{t("agsdl.architect.add.field.harness")}
          <select value={form.harness} disabled={disabled} onChange={event => set({ harness: event.target.value === "claude-code" ? "claude-code" : "codex" })}>
            <option value="codex">Codex</option>
            <option value="claude-code">Claude Code</option>
          </select>
        </label>
        <label className="agsdl-edit-field">{t("agsdl.architect.add.field.access")}
          <select value={form.access} disabled={disabled} onChange={event => set({ access: event.target.value === "workspace" ? "workspace" : "read-only" })}>
            <option value="read-only">{t("agsdl.architect.add.access.readOnly")}</option>
            <option value="workspace">{t("agsdl.architect.add.access.workspace")}</option>
          </select>
        </label>
        <p className="!m-0 text-xs text-muted-foreground">{t("agsdl.architect.add.agent.advancedHelp")}</p>
      </details>}
      {plan && project && plan.files.length > 0 && <details className="agsdl-details">
        <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
        <p className="!m-0 text-muted-foreground">{t("agsdl.architect.add.files")}</p>
        <ul className="font-mono text-[11px]">{plan.files.map(file => <li key={file.path} className="break-all">{file.path}</li>)}</ul>
      </details>}
      {error && <p role="alert" className="!m-0 whitespace-pre-line break-words text-red-500">{error}{applied && <> {t("agsdl.architect.add.notSaved")}</>}</p>}
    </form>
  </ArchitectDialogShell>;
}
