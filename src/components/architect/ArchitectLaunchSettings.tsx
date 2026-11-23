import { agsdlSessionKey, useAgsdlStore, type BlueprintDocumentTarget } from "../../stores/useAgsdlStore";
import { ProjectMacroSettings } from "../agsdl/ProjectMacroSettings";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";

/**
 * What the person who launches this system is asked or allowed to set (docs/agentic-systems.md 3.4 and 3.5):
 * the working folder and the start message. Macro's own settings, saved with the draft and copied into each version.
 */
export function ArchitectLaunchSettings({ target }: { target: BlueprintDocumentTarget }) {
  const { t } = useAgsdlTranslation();
  const project = useAgsdlStore(state => !!state.sessions[agsdlSessionKey(target)]?.project);
  return <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-14 text-xs">
    <div className="max-w-md space-y-5">
      <div className="space-y-1">
        <h3 className="m-0 text-sm font-medium">{t("agsdl.architect.views.launch")}</h3>
        <p className="!m-0 text-muted-foreground">{t("agsdl.architect.launch.intro")}</p>
      </div>
      {project ? <ProjectMacroSettings target={target} />
        : <p className="!m-0 text-muted-foreground" role="status">{t("agsdl.architect.launch.unavailable")}</p>}
    </div>
  </div>;
}
