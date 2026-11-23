import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { BlueprintVersionSummary } from "../../../services/ipc/architectLibrary";
import { useAgsdlTranslation } from "../../agsdl/useAgsdlTranslation";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { SpinnerIcon } from "../../ui/SpinnerIcon";
import { baseName, selectClass } from "./launchModel";

/**
 * "Version · place · moment" on one line, with the details one click away.
 * This machine and "now" are the only places and moments for now: they are shown, never offered as choices.
 */
export function LaunchSummary({ versions, versionNumber, note, folder, folderMode, checking, disabled, runName, onRunName, onVersion, onChooseFolder, children }: {
  versions: readonly BlueprintVersionSummary[];
  versionNumber: number;
  note: string | null;
  folderMode: "perExecution" | "atLaunch";
  folder: string | null;
  checking: boolean;
  disabled?: boolean;
  runName: string;
  onRunName: (name: string) => void;
  onVersion: (number: number) => void;
  onChooseFolder: () => void;
  /** Settings that depend on what the check found, such as replaced models. */
  children?: ReactNode;
}) {
  const { t, i18n } = useAgsdlTranslation();
  const [open, setOpen] = useState(false);
  const panel = useId();
  const latest = Math.max(...versions.map(version => version.number));
  const label = t("agsdl.library.version", { number: versionNumber });
  const segments: Array<{ text: string; warn?: boolean }> = [
    { text: versionNumber === latest ? label : t("agsdl.launch.olderVersion", { version: label }), warn: versionNumber !== latest },
    { text: t("agsdl.inbox.local") },
    { text: t("agsdl.launch.now") },
  ];
  if (folderMode === "atLaunch") segments.push(folder ? { text: baseName(folder) } : { text: t("agsdl.launch.folderNone"), warn: true });
  const placeholder = t("agsdl.launch.runNamePlaceholder", {
    date: new Date().toLocaleString(i18n.resolvedLanguage, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
  });
  return <section aria-label={t("agsdl.launch.summary")} className="rounded-md border border-border">
    <button type="button" className="flex min-h-8 w-full items-center gap-2 px-3 py-1.5 text-left text-xs" aria-expanded={open} aria-controls={panel}
      onClick={() => setOpen(value => !value)}>
      <span className="min-w-0 flex-1 truncate">
        {checking && <SpinnerIcon size={12} className="mr-1.5 inline align-[-2px]" />}
        {segments.map((segment, index) => <span key={index}>
          {index > 0 && <span className="text-muted-foreground"> · </span>}
          <span className={segment.warn ? "text-amber-500" : undefined}>{segment.text}</span>
        </span>)}
      </span>
      <span className="agsdl-link shrink-0">{t("agsdl.launch.edit")}</span>
      <ChevronDown size={14} aria-hidden="true" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open && <div id={panel} className="space-y-3 border-t border-border px-3 py-3">
      <div className="space-y-1">
        <label htmlFor={`${panel}-version`} className="block text-muted-foreground">{t("agsdl.launch.versionLabel")}</label>
        <Select id={`${panel}-version`} className={selectClass} value={versionNumber} disabled={disabled}
          onChange={event => onVersion(Number(event.target.value))}>
          {versions.map(option => <option key={option.number} value={option.number}>
            {t("agsdl.library.version", { number: option.number })}{option.number === latest ? ` · ${t("agsdl.launch.latest")}` : ""}{option.note ? ` · ${option.note}` : ""}
          </option>)}
        </Select>
        {note && <p className="!m-0 whitespace-pre-wrap break-words pt-1 text-muted-foreground">{note}</p>}
      </div>
      <dl className="!m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("agsdl.launch.where")}</dt><dd className="!m-0">{t("agsdl.inbox.local")}</dd>
        <dt className="text-muted-foreground">{t("agsdl.launch.when")}</dt><dd className="!m-0">{t("agsdl.launch.now")}</dd>
      </dl>
      <label className="block space-y-1">
        <span className="text-muted-foreground">{t("agsdl.launch.runName")}</span>
        <Input className="!h-7 text-xs" maxLength={120} value={runName} placeholder={placeholder} disabled={disabled}
          onChange={event => onRunName(event.target.value)} />
      </label>
      {folderMode === "atLaunch" && <div className="space-y-1">
        <p className="!m-0 text-muted-foreground">{t("agsdl.launch.folder")}</p>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{folder ?? t("agsdl.launch.folderNone")}</span>
          <Button size="sm" variant="secondary" className="!h-7 !px-3 !py-0 text-xs" disabled={disabled} onClick={onChooseFolder}>
            {t("agsdl.launch.chooseFolder")}
          </Button>
        </div>
      </div>}
      {children}
    </div>}
  </section>;
}
