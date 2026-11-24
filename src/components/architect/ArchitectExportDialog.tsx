import { Info } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { architectLibrary, type MacroProjectSettings, type ProjectTarget } from "../../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore, type BlueprintDocumentTarget } from "../../stores/useAgsdlStore";
import { projectSettings } from "../../stores/agsdl/projectEdits";
import { useArchitectDialogStore, type ArchitectDialog } from "../../stores/useArchitectDialogStore";
import { open, save } from "../../services/tauriDialog";
import { agsdlErrorText } from "../agsdl/errorText";
import { DisclosureSummary } from "../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { SpinnerIcon } from "../ui/SpinnerIcon";
import { notify } from "../ui/toastService";
import { ArchitectDialogShell, InfoBlock } from "./ArchitectDialogShell";

type ExportDialog = Extract<ArchitectDialog, { kind: "export" }>;

/** A file name made of what the author named the blueprint: never an internal identifier. */
export function exportFileName(name: string, number?: number) {
  const printable = [...name].map(char => char.charCodeAt(0) < 32 ? "-" : char).join("");
  const safe = printable.replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "") || "AgSDL";
  return number === undefined ? safe : `${safe}-v${number}`;
}

/** Macro settings that differ from their defaults: what an export would not carry. */
export function nonDefaultSettings(settings: MacroProjectSettings | undefined) {
  if (!settings) return [];
  const found: Array<"hidden" | "hint" | "folder" | "fields"> = [];
  if (settings.hiddenAgentIds.length) found.push("hidden");
  if (settings.entryMessageHint) found.push("hint");
  if (settings.workingFolderMode !== "perExecution") found.push("folder");
  if (settings.launchFields) found.push("fields");
  return found;
}

export function ArchitectExportDialog({ dialog, onClose }: { dialog: ExportDialog; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const { target, name } = dialog;
  const version = target.kind === "version" ? target.key : undefined;
  const blueprintId = target.kind === "version" ? target.key.blueprintId : target.blueprintId;
  const versionNumber = version?.number;
  const sessionTarget = useMemo<BlueprintDocumentTarget>(() => versionNumber === undefined ? { blueprintId } : { blueprintId, number: versionNumber }, [blueprintId, versionNumber]);
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(sessionTarget)]);
  const [format, setFormat] = useState<"archive" | "project">(version ? dialog.format ?? "archive" : "project");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The settings that would be left behind live with the opened version or draft.
  useEffect(() => { void useAgsdlStore.getState().load(sessionTarget).catch(() => {}); }, [sessionTarget]);
  const settings = session?.project ? projectSettings(session.project) : undefined;
  const left = nonDefaultSettings(settings);

  const exportedName = exportFileName(name, version?.number);
  const choose = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (format === "archive" && version) {
        const destination = await save({ defaultPath: `${exportedName}.agsdl`, filters: [{ name: "AgSDL", extensions: ["agsdl"] }] });
        if (!destination) return;
        await architectLibrary.exportArchive(version, destination);
      } else {
        const parent = await open({ directory: true });
        if (!parent) return;
        let ref: ProjectTarget;
        if (version) ref = { kind: "version", key: version };
        else {
          // A draft is exported as it stands, including edits not yet written.
          await useAgsdlStore.getState().save(sessionTarget);
          ref = { kind: "draft", blueprintId, revision: useAgsdlStore.getState().sessions[agsdlSessionKey(sessionTarget)].persistedRevision };
        }
        await architectLibrary.exportProject(ref, `${parent}/${exportedName}`);
      }
      notify.success(version ? t("agsdl.architect.export.doneVersion", { number: version.number }) : t("agsdl.architect.export.doneDraft"),
        { description: format === "archive" ? `${exportedName}.agsdl` : exportedName });
      onClose();
    } catch (failure) {
      setError(agsdlErrorText(failure, t, "agsdl.architect.export.failed"));
    } finally { setBusy(false); }
  };

  const title = version ? t("agsdl.architect.export.titleVersion", { number: version.number }) : t("agsdl.architect.export.titleDraft");
  const formats = version ? (["archive", "project"] as const) : (["project"] as const);
  return <ArchitectDialogShell title={title} subtitle={name} locked={busy} onClose={onClose}
    footer={<>
      <button type="button" disabled={busy} onClick={onClose}>{t("agsdl.cancel")}</button>
      <button type="button" className="agsdl-action-button is-primary" disabled={busy} onClick={() => void choose()}>
        {busy && <SpinnerIcon size={12} />}{t(busy ? "agsdl.architect.export.exporting" : "agsdl.architect.export.choose")}
      </button>
    </>}>
    {!version && <p className="!m-0">{t("agsdl.architect.export.draftHint")}{" "}
      <button type="button" className="agsdl-link" onClick={() => useArchitectDialogStore.getState().open({ kind: "saveVersion", blueprintId })}>
        {t("agsdl.library.saveVersion")}</button></p>}
    <fieldset className="space-y-2" disabled={busy}>
      <legend className="sr-only">{title}</legend>
      {formats.map(value => <label key={value} className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 has-[:checked]:bg-accent/50">
        <input type="radio" name="architect-export-format" className="mt-0.5 accent-primary" checked={format === value} onChange={() => setFormat(value)} />
        <span><span className="block font-medium">{t(`agsdl.architect.export.format.${value}`)}</span>
          <span className="block text-muted-foreground">{t(`agsdl.architect.export.format.${value}Hint`)}</span></span>
      </label>)}
    </fieldset>
    <InfoBlock icon={<Info size={13} />}>
      <p className="!m-0">{left.length
        ? t("agsdl.architect.export.leftBehind", { items: left.map(item => t(`agsdl.architect.export.setting.${item}`)).join(", ") })
        : t("agsdl.architect.export.settingsNotIncluded")}</p>
      <details className="agsdl-details !mt-1 !border-0 !pt-0">
        <DisclosureSummary>{t("agsdl.architect.export.whyTitle")}</DisclosureSummary>
        <p className="!m-0 text-muted-foreground">{t("agsdl.architect.export.why")}</p>
      </details>
    </InfoBlock>
    {error && <p role="alert" className="!m-0 whitespace-pre-line break-words text-red-500">{error}</p>}
  </ArchitectDialogShell>;
}
