import { useState, type FormEvent } from "react";
import type { MacroSettingsChange } from "../../services/ipc/architectLibrary";
import { projectSettings } from "../../stores/agsdl/projectEdits";
import { agsdlSessionKey, useAgsdlStore, type BlueprintDocumentTarget } from "../../stores/useAgsdlStore";
import { agsdlErrorText } from "./errorText";
import { useAgsdlTranslation } from "./useAgsdlTranslation";

export function ProjectMacroSettings({ target, agentId }: { target: BlueprintDocumentTarget; agentId?: string }) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [changes, setChanges] = useState<MacroSettingsChange>({});
  const [error, setError] = useState("");
  if (!session?.project) return null;
  const settings = projectSettings(session.project);
  const editable = session.status === "draft";
  const disabled = session.saving || !!session.draftConflict;
  const persist = async (patch: MacroSettingsChange) => {
    const store = useAgsdlStore.getState();
    setError("");
    try {
      await store.applyProjectBatch(target, [], patch, session.version);
      await store.save(target);
      setChanges({});
    } catch (failure) { setError(agsdlErrorText(failure, t)); }
  };
  if (agentId) {
    const hidden = settings.hiddenAgentIds.includes(agentId);
    if (!editable) return hidden ? <p>{t("agsdl.library.hiddenAgent")}</p> : null;
    return <section className="agsdl-edit-field">
      <label><input type="checkbox" checked={hidden} disabled={disabled} onChange={event => {
        void persist({ hiddenAgentIds: event.target.checked ? [...settings.hiddenAgentIds, agentId]
          : settings.hiddenAgentIds.filter(id => id !== agentId) });
      }} /> {t("agsdl.library.hideAgent")}</label>
      {error && <p role="alert">{error}</p>}
    </section>;
  }
  const current = { ...settings, ...changes };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (editable && !disabled && Object.keys(changes).length > 0) void persist(changes);
  };
  return <form onSubmit={submit}>
    <label className="agsdl-edit-field">{t("agsdl.library.workingFolderMode")}
      <select value={current.workingFolderMode} disabled={!editable || disabled} onChange={event => {
        const mode = event.target.value === "atLaunch" ? "atLaunch" : "perExecution";
        setChanges(previous => ({ ...previous, workingFolderMode: mode }));
      }}>
        <option value="perExecution">{t("agsdl.library.folderPerExecution")}</option>
        <option value="atLaunch">{t("agsdl.library.folderAtLaunch")}</option>
      </select>
    </label>
    <label className="agsdl-edit-field">
      <span><input type="checkbox" checked={current.startMessageRequired ?? true} disabled={!editable || disabled}
        onChange={event => {
          const required = event.target.checked;
          setChanges(previous => ({ ...previous, startMessageRequired: required }));
        }} /> {t("agsdl.library.startMessageRequired")}</span>
    </label>
    <label className="agsdl-edit-field">{t("agsdl.library.entryHint")}
      <textarea value={current.entryMessageHint ?? ""} disabled={!editable || disabled} onChange={event => {
        const hint = event.target.value;
        setChanges(previous => ({ ...previous, entryMessageHint: hint || null }));
      }} />
    </label>
    {editable && <button type="submit" className="agsdl-link" disabled={!Object.keys(changes).length || disabled}>{t("agsdl.save")}</button>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
