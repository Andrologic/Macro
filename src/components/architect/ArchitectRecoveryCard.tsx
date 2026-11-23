import { TriangleAlert } from "lucide-react";
import { diagnosticIssue } from "../../services/agsdl/itemIssues";
import type { ProjectDiagnostic } from "../../services/ipc/architectLibrary";
import { useArchitectDialogStore } from "../../stores/useArchitectDialogStore";
import { DisclosureSummary } from "../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Button } from "../ui/Button";
import { downloadOriginal } from "./architectLibraryActions";

/**
 * A version or draft that could not be turned into a project. Nothing is lost:
 * it can be adapted into a new blueprint to repair, or downloaded as it was stored.
 * It can be neither launched nor exported, so those actions are absent rather than disabled.
 */
export function ArchitectRecoveryCard({ blueprintId, name, projectId, number, revision, diagnostics, technical = [] }: {
  blueprintId: string;
  name: string;
  projectId: string;
  /** The version number, or null for a draft. */
  number: number | null;
  revision: number;
  diagnostics: readonly ProjectDiagnostic[];
  /** Messages with no location, shown only as technical detail. */
  technical?: readonly string[];
}) {
  const { t } = useAgsdlTranslation();
  const open = useArchitectDialogStore(state => state.open);
  const issues = diagnostics.map(diagnosticIssue);
  const first = issues.find(issue => issue.name);
  const adapt = () => open({
    kind: "adapt", name, projectId, repair: true,
    source: number === null ? { kind: "recoveryDraft", blueprintId } : { kind: "version", key: { blueprintId, number } },
  });
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-8 text-center text-xs" data-recovery-card>
    <p className="m-0 text-[11px] text-muted-foreground">{number === null
      ? t("agsdl.architect.recovery.captionDraft", { name }) : t("agsdl.architect.recovery.caption", { name, number })}</p>
    <TriangleAlert size={22} className="text-amber-500" aria-hidden="true" />
    <h3 className="m-0 text-sm font-semibold">{t(number === null ? "agsdl.architect.recovery.titleDraft" : "agsdl.architect.recovery.title")}</h3>
    <p className="m-0 max-w-md leading-relaxed text-muted-foreground">{t("agsdl.architect.recovery.body")}</p>
    {first?.name && <p className="m-0 max-w-md">{t("agsdl.architect.recovery.why", { item: t(`agsdl.architect.saveVersion.item.${first.kind}`, { name: first.name }) })}</p>}
    {(issues.length > 0 || technical.length > 0) && <details className="agsdl-details w-full max-w-md text-left">
      <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
      <ul className="space-y-1 font-mono text-[11px]">
        {issues.map((issue, index) => <li key={index} className="break-words">{issue.technical}</li>)}
        {technical.map((line, index) => <li key={`t${index}`} className="break-words">{line}</li>)}
      </ul>
    </details>}
    <div className="flex flex-wrap justify-center gap-2 pt-1">
      <Button size="sm" className="!h-7 !px-3 !py-0 text-xs" onClick={adapt}>{t("agsdl.library.adaptRepair")}</Button>
      <Button size="sm" variant="secondary" className="!h-7 !px-3 !py-0 text-xs"
        onClick={() => void downloadOriginal({ blueprintId, revision, number, name })}>{t("agsdl.library.downloadOriginal")}</Button>
      {number !== null && <Button size="sm" variant="ghost" className="!h-7 !px-3 !py-0 text-xs"
        onClick={() => open({ kind: "deleteVersion", key: { blueprintId, number } })}>{t("agsdl.architect.menu.delete")}</Button>}
    </div>
  </div>;
}
