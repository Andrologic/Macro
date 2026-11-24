import { Info } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { readDocument } from "../../services/agsdl/document";
import { diagnosticIssue, issueView, parseUpgradeDetails, type IssueView, type ItemIssue } from "../../services/agsdl/itemIssues";
import { AgsdlUserError } from "../../services/agsdl/userErrors";
import { architectLibrary } from "../../services/ipc/architectLibrary";
import { projectSettings } from "../../stores/agsdl/projectEdits";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectLaunchStore } from "../../stores/useArchitectLaunchStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { agsdlErrorText } from "../agsdl/errorText";
import { DisclosureSummary } from "../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Icon } from "../ui/Icon";
import { SpinnerIcon } from "../ui/SpinnerIcon";
import { notify } from "../ui/toastService";
import { ArchitectDialogShell, InfoBlock } from "./ArchitectDialogShell";
import { useDraftMatchesVersion } from "./useDraftMatchesVersion";

type Check =
  | { status: "checking" }
  /** `blocking` issues stop the save. `warnings` never do. */
  | { status: "done"; blocking: ItemIssue[]; warnings: ItemIssue[]; reach: Reach }
  /** No dry run exists for this draft. The save itself still reports what is wrong. */
  | { status: "unavailable" };

/** What the flow does not reach, as the dry run reports it: the same reading the launch window uses. */
interface Reach { none: boolean; agents: string[]; technical: string[] }
const noReach: Reach = { none: false, agents: [], technical: [] };
const reachCodes = ["NO_AGENT_REACHED", "AGENT_NOT_REACHED"];
const unescapePointer = (part: string) => part.replace(/~1/g, "/").replace(/~0/g, "~");

const legacyContract = (source: string | undefined) => {
  try { return !!source && readDocument(source).contract === "agsdl-0.3.0"; } catch { return false; }
};

/** The dry run and the save both report problems as items, in the same block. */
export function ItemIssueList({ issues, onShow }: { issues: ItemIssue[]; onShow?: (view: IssueView) => void }) {
  const { t } = useAgsdlTranslation();
  return <>
    <ul className="space-y-1">{issues.map((issue, index) => <li key={index} className="flex items-baseline gap-2">
      <span className="min-w-0 flex-1 break-words">{issue.name
        ? t(`agsdl.architect.saveVersion.item.${issue.kind}`, { name: issue.name })
        : t("agsdl.architect.saveVersion.item.document")}</span>
      {onShow && issue.kind !== "document" && <button type="button" className="agsdl-link shrink-0" onClick={() => onShow(issueView(issue.kind))}>
        {t("agsdl.architect.saveVersion.show")}</button>}
    </li>)}</ul>
    <details className="agsdl-details !mt-2">
      <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
      <ul className="space-y-1 font-mono text-[11px]">{issues.map((issue, index) => <li key={index} className="break-words">{issue.technical}</li>)}</ul>
    </details>
  </>;
}

export function SaveVersionDialog({ blueprintId, onClose, onShow }: {
  blueprintId: string;
  onClose: () => void;
  /** Leaves the dialog and shows the part of the system an issue belongs to. */
  onShow?: (view: IssueView) => void;
}) {
  const { t } = useAgsdlTranslation();
  const target = useMemo(() => ({ blueprintId }), [blueprintId]);
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const versions = useArchitectLibraryStore(state => state.versions);
  const draftName = useArchitectLibraryStore(state => state.draft?.name ?? "");
  const agentNames = session?.project ? projectSettings(session.project).agentNames : undefined;
  const [note, setNote] = useState("");
  const [check, setCheck] = useState<Check>({ status: "checking" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ issues: ItemIssue[] } | { message: string }>();

  const number = (versions.status === "ready" ? Math.max(0, ...versions.value.map(version => version.number)) : 0) + 1;
  const converting = legacyContract(session?.source);
  const conflict = !!session?.draftConflict;
  const unchangedSince = useDraftMatchesVersion(blueprintId);

  // Dry run: validate what will be frozen, without writing anything.
  const revision = session?.persistedRevision;
  const pending = session?.project?.pending;
  useEffect(() => {
    if (revision === undefined || !pending) { setCheck({ status: "unavailable" }); return; }
    let active = true;
    setCheck({ status: "checking" });
    architectLibrary.validateDraft(blueprintId, revision, pending).then(view => {
      if (!active) return;
      if (!view.projection) { setCheck({ status: "done", blocking: view.diagnostics.map(diagnosticIssue), warnings: [], reach: noReach }); return; }
      const unreached = view.diagnostics.filter(diagnostic => reachCodes.includes(diagnostic.code));
      setCheck({
        status: "done", blocking: [], reach: {
          none: unreached.some(diagnostic => diagnostic.code === "NO_AGENT_REACHED"),
          agents: unreached.filter(diagnostic => diagnostic.code === "AGENT_NOT_REACHED").map(diagnostic => unescapePointer(diagnostic.pointer.split("/")[2] ?? "")),
          technical: unreached.map(diagnostic => [diagnostic.code, diagnostic.pointer, diagnostic.message].join(" · ")),
        },
        warnings: view.diagnostics.filter(diagnostic => !reachCodes.includes(diagnostic.code)).map(diagnosticIssue),
      });
    }).catch(() => { if (active) setCheck({ status: "unavailable" }); });
    return () => { active = false; };
  }, [blueprintId, revision, pending]);

  const blocked = check.status === "done" && check.blocking.length > 0;
  const reason = check.status === "checking" ? t("agsdl.architect.saveVersion.reasonChecking")
    : blocked ? t("agsdl.architect.saveVersion.reasonBlocked") : conflict ? t("agsdl.library.revisionConflict")
      : unchangedSince !== undefined && !busy ? t("agsdl.architect.header.saveUnchanged", { number: unchangedSince }) : undefined;

  const submit = async (launch = false) => {
    if (busy || reason || session?.saving) return;
    setBusy(true); setFailure(undefined);
    try {
      const key = await useArchitectLibraryStore.getState().saveVersion(blueprintId, note);
      const saved = key.number;
      notify.success(t("agsdl.architect.saveVersion.done", { number: saved }), { description: note.trim().slice(0, 120) || draftName || undefined });
      onClose();
      if (launch) useArchitectLaunchStore.getState().open({ blueprintId: key.blueprintId, number: key.number });
    } catch (error) {
      setFailure(error instanceof AgsdlUserError && error.messageKey === "agsdl.library.upgradeInvalid"
        ? { issues: parseUpgradeDetails(error.details) } : { message: agsdlErrorText(error, t) });
      setBusy(false);
    }
  };

  const title = t("agsdl.architect.saveVersion.title", { number });
  const issuesTitle = failure && "issues" in failure ? t("agsdl.architect.saveVersion.cannotConvert")
    : t("agsdl.architect.saveVersion.cannotSave");
  const shown = failure && "issues" in failure ? failure.issues : check.status === "done" ? check.blocking : [];
  return <ArchitectDialogShell title={title} subtitle={draftName} locked={busy} onClose={onClose}
    footer={<>
      <span className="mr-auto self-center text-[11px] text-muted-foreground">{reason}</span>
      <button type="button" disabled={busy} onClick={onClose}>{t("agsdl.cancel")}</button>
      <button type="button" disabled={busy || !!reason || !!session?.saving} title={reason}
        onClick={() => void submit(true)}>{t("agsdl.launch.saveAndLaunch")}</button>
      <button type="button" className="agsdl-action-button is-primary" disabled={busy || !!reason || !!session?.saving} title={reason}
        onClick={() => void submit()}>
        {busy && <SpinnerIcon size={12} />}{t(busy ? "agsdl.saving" : "agsdl.architect.saveVersion.action", { number })}
      </button>
    </>}>
    <label className="agsdl-edit-field !mt-0">{t("agsdl.library.versionNote")}
      <textarea className="!min-h-[72px]" rows={3} value={note} disabled={busy} placeholder={t("agsdl.architect.saveVersion.notePlaceholder")}
        onChange={event => setNote(event.target.value)} />
    </label>
    {check.status === "checking" && <p role="status" className="!m-0 flex items-center gap-2 text-muted-foreground">
      <SpinnerIcon size={13} />{t("agsdl.architect.saveVersion.checking")}</p>}
    {converting && <InfoBlock icon={<Info size={13} />} title={t("agsdl.architect.saveVersion.oldFormat")}>
      <p className="!m-0">{t("agsdl.architect.saveVersion.convertNotice", { number })}</p>
      <details className="agsdl-details !mt-1 !border-0 !pt-0">
        <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
        <p className="!m-0 text-muted-foreground">{t("agsdl.architect.saveVersion.convertDetails")}</p>
      </details>
    </InfoBlock>}
    {shown.length > 0 && <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2">
      <p className="!m-0 font-medium text-red-500">{issuesTitle}</p>
      <p className="!mb-1">{t("agsdl.architect.saveVersion.issueCount", { count: shown.length })}</p>
      <ItemIssueList issues={shown} onShow={onShow && (view => { onClose(); onShow(view); })} />
    </div>}
    {check.status === "done" && (check.reach.none || check.reach.agents.length > 0) && <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
      <p className="!m-0 flex items-center gap-2 font-medium text-amber-500"><Icon name="triangle-alert" size={13} />
        {check.reach.none ? t("agsdl.architect.saveVersion.reach.noneTitle") : t("agsdl.architect.saveVersion.reach.someTitle", { count: check.reach.agents.length })}</p>
      <p className="!m-0 !mt-1 break-words">{check.reach.none ? t("agsdl.architect.saveVersion.reach.none")
        : t("agsdl.architect.saveVersion.reach.some", { names: check.reach.agents.map(id => agentNames?.[id] ?? id).join(", ") })}</p>
      <div className="!mt-1 flex items-baseline gap-3">
        {onShow && <button type="button" className="agsdl-link" onClick={() => { onClose(); onShow("flow"); }}>{t("agsdl.architect.saveVersion.reach.open")}</button>}
      </div>
      <details className="agsdl-details !mt-1 !border-0 !pt-0">
        <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
        <ul className="space-y-1 font-mono text-[11px]">{check.reach.technical.map((line, index) => <li key={index} className="break-words">{line}</li>)}</ul>
      </details>
    </div>}
    {check.status === "done" && check.warnings.length > 0 && <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
      <p className="!m-0 flex items-center gap-2 font-medium text-amber-500"><Icon name="triangle-alert" size={13} />{t("agsdl.architect.saveVersion.warnings", { count: check.warnings.length })}</p>
      <ItemIssueList issues={check.warnings} />
    </div>}
    {failure && "message" in failure && <p role="alert" className="!m-0 whitespace-pre-line break-words text-red-500">{failure.message}</p>}
  </ArchitectDialogShell>;
}
