import { useEffect, useState } from "react";
import { architectLibrary, type VersionKey } from "../../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectDialogStore } from "../../stores/useArchitectDialogStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { useArchitectViewStore } from "../../stores/useArchitectViewStore";
import { agsdlErrorText } from "../agsdl/errorText";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { ConfirmPromptModal } from "../ui/ConfirmPromptModal";
import { notify } from "../ui/toastService";
import { ArchitectExportDialog } from "./ArchitectExportDialog";
import { ArchitectImportDialog } from "./ArchitectImportDialog";
import { BlueprintNameDialog } from "./BlueprintVersionDialogs";
import { SaveVersionDialog } from "./SaveVersionDialog";

/** Renders whichever library dialog the tree or the blueprint panel asked for. Mount it once. */
export function ArchitectLibraryDialogs() {
  const { t } = useAgsdlTranslation();
  const dialog = useArchitectDialogStore(state => state.dialog);
  const close = useArchitectDialogStore(state => state.close);
  const projects = useArchitectLibraryStore(state => state.projects);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "saveVersion":
      return <SaveVersionDialog blueprintId={dialog.blueprintId} onClose={close}
        onShow={view => {
          const state = useArchitectLibraryStore.getState();
          if (state.draft?.id === dialog.blueprintId) useArchitectViewStore.getState().setView(agsdlSessionKey({ blueprintId: dialog.blueprintId }), view);
        }} />;
    case "export":
      return <ArchitectExportDialog dialog={dialog} onClose={close} />;
    case "import":
      return <ArchitectImportDialog path={dialog.path} projectId={dialog.projectId} onClose={close} />;
    case "deleteVersion":
      return <DeleteVersionDialog versionKey={dialog.key} onClose={close} />;
    case "adapt": {
      const { source, name, projectId, repair } = dialog;
      return <BlueprintNameDialog key={JSON.stringify(source)} title={t(repair ? "agsdl.library.adaptRepair" : "agsdl.architect.adapt.title", { number: source.kind === "version" ? source.key.number : undefined })}
        actionLabel={t(repair ? "agsdl.library.adaptRepair" : "agsdl.architect.header.adapt")}
        initialName={repair ? name : t("agsdl.architect.adapt.defaultName", { name })}
        destinations={{ projects: projects.status === "ready" ? projects.value : [], projectId }}
        onSave={async (nextName, destination) => {
          const library = useArchitectLibraryStore.getState();
          if (source.kind === "version") await library.adaptVersion(source.key, destination, nextName);
          else {
            const session = useAgsdlStore.getState().sessions[agsdlSessionKey({ blueprintId: source.blueprintId })];
            const revision = session?.persistedRevision ?? (await architectLibrary.getDraft(source.blueprintId)).revision;
            await library.adaptRecoveryDraft(source.blueprintId, revision, destination, nextName);
          }
          notify.success(t("agsdl.architect.adapt.done", { name: nextName }));
        }}
        onClose={close}>
        <p className="agsdl-muted !mt-0">{t(repair ? "agsdl.architect.adapt.introRepair" : "agsdl.architect.adapt.intro")}</p>
      </BlueprintNameDialog>;
    }
  }
}

function DeleteVersionDialog({ versionKey, onClose }: { versionKey: VersionKey; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const [uses, setUses] = useState<"checking" | "free" | "used">("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    architectLibrary.listUses(versionKey)
      .then(found => { if (active) setUses(found.length ? "used" : "free"); })
      // The native guard refuses anyway: an unreadable list must not hide the button.
      .catch(() => { if (active) setUses("free"); });
    return () => { active = false; };
  }, [versionKey]);
  const remove = async () => {
    setBusy(true); setError("");
    try {
      await useArchitectLibraryStore.getState().deleteVersion(versionKey);
      notify.success(t("agsdl.architect.delete.done", { number: versionKey.number }));
      onClose();
    } catch (failure) { setError(agsdlErrorText(failure, t)); setBusy(false); }
  };
  return <ConfirmPromptModal isOpen title={t("agsdl.architect.delete.title", { number: versionKey.number })}
    description={t(uses === "used" ? "agsdl.architect.delete.used" : "agsdl.architect.delete.description")}
    confirmLabel={t("agsdl.architect.delete.confirm")} cancelLabel={t("agsdl.cancel")} confirmVariant="error"
    isSubmitting={busy} showConfirmButton={uses !== "used"} onCancel={onClose} onConfirm={() => void remove()}>
    {uses === "checking" && <p role="status" className="text-xs text-muted-foreground">{t("agsdl.architect.delete.checking")}</p>}
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
  </ConfirmPromptModal>;
}
