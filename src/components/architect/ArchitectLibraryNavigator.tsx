import { BookOpen, FolderPlus, Plus, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { architectLibrary, type InspectedImport } from "../../services/ipc/architectLibrary";
import { open } from "../../services/tauriDialog";
import { agsdlErrorText } from "../agsdl/errorText";
import { ArchitectImportDialog } from "./ArchitectImportDialog";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { BlueprintNameDialog, architectLibraryLabel, LibraryReadFailure } from "./BlueprintVersionDialogs";
import "../agsdl/agsdl.css";

export default function ArchitectLibraryNavigator() {
  const { t } = useAgsdlTranslation();
  const library = useArchitectLibraryStore();
  const { projectId, projects, blueprintId, blueprints, draft, versionNumber, versions } = library;
  const [creation, setCreation] = useState<{ kind: "project" } | { kind: "blueprint"; projectId: string }>();
  const [inspected, setInspected] = useState<InspectedImport>();
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const inspect = async (directory: boolean) => {
    setImporting(true);
    setImportError("");
    try {
      const path = await open({
        directory,
        filters: directory ? undefined : [{ name: "AgSDL", extensions: ["agsdl", "json"] }],
      });
      if (path) setInspected(await architectLibrary.inspectImport(path));
    } catch (error) { setImportError(agsdlErrorText(error, t)); }
    finally { setImporting(false); }
  };
  useEffect(() => {
    const state = useArchitectLibraryStore.getState();
    void state.refreshProjects();
    void state.refreshBlueprints();
  }, []);

  const projectList = projects.status === "ready" ? projects.value : [];
  const blueprintList = blueprints.status === "ready" ? blueprints.value : [];
  const renderBlueprints = (archived: boolean) => {
    const entries = blueprintList.filter(item => item.archived === archived);
    if (archived && !entries.length) return null;
    return <section aria-label={t(archived ? "agsdl.library.archives" : "agsdl.library.blueprints")}>
      <h3 className="px-2 py-1 font-medium text-muted-foreground">{t(archived ? "agsdl.library.archives" : "agsdl.library.blueprints")}</h3>
      {entries.length ? <ul>{entries.map(item => (
        <li key={item.id}>
          <button type="button" title={architectLibraryLabel(item, blueprintList)} aria-current={blueprintId === item.id ? "true" : undefined}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted aria-[current=true]:bg-muted"
            onClick={() => void library.selectBlueprint(item.projectId, item.id)}>
            <BookOpen size={14} className="shrink-0" /><span className="truncate">{architectLibraryLabel(item, blueprintList)}</span>
          </button>
        </li>
      ))}</ul> : <p className="px-2 py-1 text-muted-foreground">{t("agsdl.library.noBlueprints")}</p>}
    </section>;
  };

  return <nav className="flex h-full min-h-0 flex-col gap-2 bg-card p-2 text-xs" aria-label={t("agsdl.library.title")} data-tour-id="architect-project-navigator">
    <div className="flex items-center justify-between gap-2 px-2">
      <h2 className="font-semibold">{t("agsdl.library.title")}</h2>
      <button type="button" className="agsdl-icon-button" title={t("agsdl.library.newProject")} aria-label={t("agsdl.library.newProject")}
        onClick={() => setCreation({ kind: "project" })}><FolderPlus size={15} /></button>
    </div>
    <div className="flex items-center gap-1 px-2">
      <select className="min-w-0 flex-1 rounded border border-border bg-card p-1"
        aria-label={t("agsdl.library.project")} value={projectId ?? ""} disabled={projects.status !== "ready"}
        onChange={event => void library.selectProject(event.target.value || null)}>
        <option value="">{t("agsdl.library.chooseProject")}</option>
        {projectList.map(item => <option key={item.id} value={item.id}>{architectLibraryLabel(item, projectList)}</option>)}
      </select>
      {projectId && <button type="button" className="agsdl-icon-button" title={t("agsdl.library.newBlueprint")} aria-label={t("agsdl.library.newBlueprint")}
        onClick={() => setCreation({ kind: "blueprint", projectId })}><Plus size={15} /></button>}
    </div>
    {!!projectList.length && <div className="flex flex-wrap gap-2 px-2">
      <button type="button" className="agsdl-link flex items-center gap-1" disabled={importing} onClick={() => void inspect(false)}>
        <Upload size={12} /> {t("agsdl.library.importFile")}
      </button>
      <button type="button" className="agsdl-link" disabled={importing} onClick={() => void inspect(true)}>{t("agsdl.library.importFolder")}</button>
    </div>}
    {importError && <p className="px-2" role="alert">{importError}</p>}
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      {projects.status === "error" && <LibraryReadFailure retry={library.refreshProjects} />}
      {blueprints.status === "error" && <LibraryReadFailure retry={library.refreshBlueprints} />}
      {(projects.status === "loading" || blueprints.status === "loading") && <p className="px-2" role="status">{t("agsdl.library.loading")}</p>}
      {blueprints.status === "ready" && <>{renderBlueprints(false)}{renderBlueprints(true)}</>}
      {draft && <section className="border-t border-border pt-2" aria-label={t("agsdl.library.versions")}>
        <h3 className="px-2 py-1 font-medium text-muted-foreground">{t("agsdl.library.versions")}</h3>
        {versions.status === "error" && <LibraryReadFailure retry={library.refreshVersions} />}
        {versions.status === "loading" && <p className="px-2" role="status">{t("agsdl.library.loading")}</p>}
        {versions.status === "ready" && (versions.value.length
          ? <ul>{versions.value.map(version => <li key={version.number}>
            <button type="button" className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted aria-[current=true]:bg-muted"
              aria-current={versionNumber === version.number ? "true" : undefined} onClick={() => void library.selectVersion(version.number)}>
              <span className="block truncate">{t("agsdl.library.version", { number: version.number })}{version.storageState === "recovery" && <> · {t("agsdl.library.needsRepair")}</>}</span>
              {version.note && <span className="block truncate text-muted-foreground" title={version.note}>{version.note}</span>}
            </button>
          </li>)}</ul>
          : <p className="px-2 py-1 text-muted-foreground">{t("agsdl.library.noVersions")}</p>)}
      </section>}
    </div>
    {inspected && <ArchitectImportDialog inspected={inspected} projects={projectList}
      projectId={projectId ?? projectList[0]?.id ?? ""} onClose={() => {
        void architectLibrary.discardImport(inspected.handle).catch(() => {});
        setInspected(undefined);
      }} />}
    {creation?.kind === "project" && <BlueprintNameDialog title={t("agsdl.library.newProject")} onSave={library.createProject} onClose={() => setCreation(undefined)} />}
    {creation?.kind === "blueprint" && <BlueprintNameDialog title={t("agsdl.library.newBlueprint")} onSave={name => library.createBlueprint(creation.projectId, name)} onClose={() => setCreation(undefined)} />}
  </nav>;
}
