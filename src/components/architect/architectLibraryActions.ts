import i18n from "../../i18n";
import { architectLibrary } from "../../services/ipc/architectLibrary";
import { open, save } from "../../services/tauriDialog";
import { useArchitectDialogStore } from "../../stores/useArchitectDialogStore";
import { agsdlErrorText } from "../agsdl/errorText";
import { notify } from "../ui/toastService";
import { exportFileName } from "./ArchitectExportDialog";

const t = () => i18n.getFixedT(null, "agsdl");

/** Pick a .agsdl file or a project folder, then open the import preview. Nothing is written yet. */
export async function chooseImport(directory: boolean, projectId: string): Promise<void> {
  const path = await open({
    directory,
    filters: directory ? undefined : [{ name: "AgSDL", extensions: ["agsdl"] }],
  });
  if (path) useArchitectDialogStore.getState().open({ kind: "import", path, projectId });
}

/** Save the original document of a version that could not be recovered, exactly as it was stored. */
export async function downloadOriginal(input: { blueprintId: string; revision: number; number: number | null; name: string }): Promise<void> {
  const translate = t();
  try {
    const destination = await save({
      defaultPath: `${exportFileName(input.name, input.number ?? undefined)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!destination) return;
    await architectLibrary.exportOriginalEnvelope(input.blueprintId, input.revision, input.number, destination);
    notify.success(translate("agsdl.architect.recovery.downloaded"));
  } catch (error) {
    notify.error(translate("agsdl.architect.recovery.downloadFailed"), { description: agsdlErrorText(error, translate) });
  }
}
