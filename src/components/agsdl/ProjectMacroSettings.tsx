import { useState, type FormEvent } from "react";
import type { MacroSettingsChange } from "../../services/ipc/architectLibrary";
import { projectSettings } from "../../stores/agsdl/projectEdits";
import { agsdlSessionKey, useAgsdlStore, type BlueprintDocumentTarget } from "../../stores/useAgsdlStore";
import { agsdlErrorText } from "./errorText";
import { useAgsdlTranslation } from "./useAgsdlTranslation";

export function ProjectMacroSettings({ target, agentId }: { target: BlueprintDocumentTarget; agentId?: string }) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [hint, setHint] = useState<string>();
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
      setHint(undefined);
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
  if (!editable) return settings.entryMessageHint
    ? <p>{t("agsdl.library.entryHint")} · {settings.entryMessageHint}</p> : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (hint !== undefined && !disabled) void persist({ entryMessageHint: hint || null });
  };
  return <form onSubmit={submit}>
    <label className="agsdl-edit-field">{t("agsdl.library.entryHint")}
      <textarea value={hint ?? settings.entryMessageHint ?? ""} disabled={disabled} onChange={event => setHint(event.target.value)} />
    </label>
    <button type="submit" className="agsdl-link" disabled={hint === undefined || disabled}>{t("agsdl.save")}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
