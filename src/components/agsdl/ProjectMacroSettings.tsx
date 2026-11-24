import { useEffect, useRef, useState, type FormEvent } from "react";
import { readLaunchFields } from "../../services/agsdl/launchFields";
import type { MacroSettingsChange } from "../../services/ipc/architectLibrary";
import { projectSettings } from "../../stores/agsdl/projectEdits";
import { agsdlSessionKey, useAgsdlStore, type BlueprintDocumentTarget } from "../../stores/useAgsdlStore";
import { Icon } from "../ui/Icon";
import { ProjectLaunchFields } from "./ProjectLaunchFields";
import { agsdlErrorText } from "./errorText";
import { useAgsdlTranslation } from "./useAgsdlTranslation";

/**
 * Settings that belong to Macro, not to the document: they travel with a version inside Macro
 * and are never written into the AgSDL source.
 */
export function ProjectMacroSettings({ target, agentId }: { target: BlueprintDocumentTarget; agentId?: string }) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [hint, setHint] = useState<string>();
  const [error, setError] = useState<{ message: string; retry: () => void }>();
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!session?.project) return null;
  const settings = projectSettings(session.project);
  const editable = session.status === "draft";
  const disabled = session.saving || !!session.draftConflict;

  const persist = async (patch: MacroSettingsChange) => {
    const store = useAgsdlStore.getState();
    setError(undefined);
    try {
      await store.applyProjectBatch(target, [], patch, store.sessions[agsdlSessionKey(target)]?.version, undefined, true);
      if (patch.entryMessageHint !== undefined) setHint(undefined);
      setSaved(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 2000);
    } catch (failure) {
      setError({ message: agsdlErrorText(failure, t), retry: () => void persist(patch) });
    }
  };

  const feedback = <>
    <span className="text-[10px] text-muted-foreground" role="status" aria-live="polite">{saved ? t("agsdl.architect.operate.saved") : ""}</span>
    {error && <p role="alert" className="!my-0 text-red-500">{error.message} {t("agsdl.architect.operate.notSaved")}{" "}
      <button type="button" className="agsdl-link" onClick={error.retry}>{t("agsdl.retry")}</button></p>}
  </>;

  if (agentId) {
    const hidden = settings.hiddenAgentIds.includes(agentId);
    if (!editable) return hidden ? <p className="flex items-center gap-1.5"><Icon name="eye-off" size={12} />{t("agsdl.library.hiddenAgent")}</p> : null;
    const change = (next: boolean) => next ? [...settings.hiddenAgentIds, agentId] : settings.hiddenAgentIds.filter(id => id !== agentId);
    // Not an .agsdl-edit-field: that class stretches every input to the full width.
    return <section className="mt-4 space-y-1" aria-label={t("agsdl.architect.operate.title")}>
      <h4 className="m-0 text-[11px] font-medium text-muted-foreground">{t("agsdl.architect.operate.title")}</h4>
      <label className="flex min-w-0 items-start gap-2">
        <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-primary" checked={hidden} disabled={disabled} onChange={event => {
          void persist({ hiddenAgentIds: change(event.target.checked) });
        }} />
        <span><span className="block">{t("agsdl.library.hideAgent")}</span>
          <span className="block text-xs text-muted-foreground">{t("agsdl.architect.operate.hideHint")}</span></span>
      </label>
      <div className="min-h-4 pl-[22px]">{feedback}</div>
    </section>;
  }
  const folderMode = settings.workingFolderMode;
  const fields = readLaunchFields(settings.launchFields);
  const startRequired = settings.startMessageRequired ?? true;
  const folderLabel = t(folderMode === "atLaunch" ? "agsdl.library.folderAtLaunch" : "agsdl.library.folderPerExecution");
  const heading = "m-0 text-[11px] font-medium text-muted-foreground";
  if (!editable) return <div className="space-y-4">
    <section className="space-y-1"><h4 className={heading}>{t("agsdl.library.workingFolderMode")}</h4><p className="!m-0">{folderLabel}</p>
      <p className="!m-0 text-xs text-muted-foreground">{t(`agsdl.architect.launch.folderHelp.${folderMode}`)}</p></section>
    <section className="space-y-1"><h4 className={heading}>{t("agsdl.architect.launch.startMessage")}</h4>
      {fields ? <ul className="!m-0 list-none !p-0">
        {fields.fields.map(field => <li key={field.key}>{field.label} · {field.key} · {t(`agsdl.launch.fields.types.${field.type}`)}
          {field.required && ` · ${t("agsdl.launch.fields.required")}`}</li>)}
      </ul> : <p className="!m-0">{t(startRequired ? "agsdl.library.startMessageRequired" : "agsdl.architect.launch.startMessageOptional")}</p>}
      {(fields || startRequired) && settings.entryMessageHint && <p className="!m-0 whitespace-pre-wrap break-words text-muted-foreground">{t("agsdl.library.entryHint")} · {settings.entryMessageHint}</p>}</section>
  </div>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (hint !== undefined && !disabled) void persist({ entryMessageHint: hint || null });
  };
  return <div className="space-y-5">
    {/* The folder and the checkbox are saved at once; the hint is text and keeps an explicit Save. */}
    <section className="space-y-1.5" aria-label={t("agsdl.library.workingFolderMode")}>
      <label className="agsdl-edit-field !mt-0"><span className={heading}>{t("agsdl.library.workingFolderMode")}</span>
        <select value={folderMode} disabled={disabled} onChange={event => {
          const mode = event.target.value === "atLaunch" ? "atLaunch" : "perExecution";
          void persist({ workingFolderMode: mode });
        }}>
          <option value="perExecution">{t("agsdl.library.folderPerExecution")}</option>
          <option value="atLaunch">{t("agsdl.library.folderAtLaunch")}</option>
        </select>
      </label>
      <p className="!m-0 text-xs text-muted-foreground">{t(`agsdl.architect.launch.folderHelp.${folderMode}`)}</p>
    </section>
    <section className="space-y-1.5" aria-label={t("agsdl.architect.launch.startMessage")}>
      <h4 className={heading}>{t("agsdl.architect.launch.startMessage")}</h4>
      {!fields && <>
        <label className="flex min-w-0 items-center gap-2">
          <input type="checkbox" className="size-3.5 shrink-0 accent-primary" checked={startRequired} disabled={disabled} onChange={event => {
            void persist({ startMessageRequired: event.target.checked });
          }} />
          <span>{t("agsdl.library.startMessageRequired")}</span>
        </label>
        <p className="!m-0 text-xs text-muted-foreground">{t("agsdl.architect.launch.startMessageHelp")}</p>
      </>}
      {(fields || startRequired) && <form onSubmit={submit}>
        <label className="agsdl-edit-field">{t("agsdl.library.entryHint")}
          <textarea rows={3} value={hint ?? settings.entryMessageHint ?? ""} disabled={disabled} onChange={event => setHint(event.target.value)} />
        </label>
        {!fields && <p className="text-xs text-muted-foreground">{t("agsdl.architect.operate.entryHintHelp")}</p>}
        <button type="submit" className="agsdl-link" disabled={hint === undefined || disabled}>{t("agsdl.save")}</button>
      </form>}
    </section>
    <ProjectLaunchFields key={JSON.stringify(fields ?? null)} fields={fields?.fields ?? []} disabled={disabled}
      onSave={schema => void persist({ launchFields: schema })} />
    <div className="min-h-4">{feedback}</div>
  </div>;
}
