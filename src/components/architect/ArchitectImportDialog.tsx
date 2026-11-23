import type { ArchitectProject, InspectedImport } from "../../services/ipc/architectLibrary";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { BlueprintNameDialog } from "./BlueprintVersionDialogs";

export function ArchitectImportDialog({ inspected, projectId, projects, onClose }: {
  inspected: InspectedImport;
  projectId: string;
  projects: ArchitectProject[];
  onClose: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const { handle, preview } = inspected;
  const archive = preview.packageFormat === "agsdl-archive-1";
  return <BlueprintNameDialog title={t("agsdl.library.importProject")}
    initialName={preview.title || preview.authoredId}
    destinations={{ projectId, projects }}
    onSave={(name, destination) => useArchitectLibraryStore.getState().commitImport(handle, destination, name)}
    onClose={onClose}>
    <p>{t(archive ? "agsdl.library.importArchiveResult" : "agsdl.library.importFolderResult")}</p>
    <p>{t("agsdl.library.portableSettings")}</p>
    <details>
      <summary>{t("agsdl.viewer.technicalDetails")}</summary>
      <pre className="agsdl-source-value">{JSON.stringify(preview, null, 2)}</pre>
    </details>
  </BlueprintNameDialog>;
}
