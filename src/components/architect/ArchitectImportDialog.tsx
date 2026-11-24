import { Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { architectLibrary, type InspectedImport } from "../../services/ipc/architectLibrary";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { agsdlErrorText } from "../agsdl/errorText";
import { DisclosureSummary } from "../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Icon } from "../ui/Icon";
import { SpinnerIcon } from "../ui/SpinnerIcon";
import { notify } from "../ui/toastService";
import { Skeleton } from "../shared/Skeleton";
import { ArchitectDialogShell, InfoBlock } from "./ArchitectDialogShell";
import { importBlocker } from "./importBlocker";
import { PermissionSummary } from "./PermissionSummary";
import { summarizePermissions } from "../../services/agsdl/permissionSummary";

type Inspection =
  | { status: "reading" }
  | { status: "ready"; inspected: InspectedImport }
  | { status: "blocked"; key: ReturnType<typeof importBlocker>["key"]; technical: string };

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
/** Archive content is shown as plain text, bounded: never rendered as markup, never fetched. */
const plain = (value: string, limit = 200) => value.length > limit ? `${value.slice(0, limit)}…` : value;

export function ArchitectImportDialog({ path, projectId: initialProjectId, onClose }: {
  path: string;
  projectId: string;
  onClose: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const projects = useArchitectLibraryStore(state => state.projects);
  const projectBlueprints = useArchitectLibraryStore(state => state.projectBlueprints);
  const [inspection, setInspection] = useState<Inspection>({ status: "reading" });
  const [projectId, setProjectId] = useState(initialProjectId);
  const [name, setName] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const handle = useRef<string | undefined>(undefined);
  const committed = useRef(false);

  useEffect(() => {
    let active = true;
    setInspection({ status: "reading" });
    architectLibrary.inspectImport(path).then(inspected => {
      if (!active) { void architectLibrary.discardImport(inspected.handle).catch(() => {}); return; }
      handle.current = inspected.handle;
      setInspection({ status: "ready", inspected });
    }).catch(failure => { if (active) setInspection({ status: "blocked", ...importBlocker(failure) }); });
    return () => {
      active = false;
      if (handle.current && !committed.current) void architectLibrary.discardImport(handle.current).catch(() => {});
      handle.current = undefined;
    };
  }, [path]);

  const projectList = projects.status === "ready" ? projects.value : [];
  const ready = inspection.status === "ready" ? inspection.inspected : undefined;
  const preview = ready?.preview;
  const effectiveName = (name ?? (preview?.title || preview?.authoredId || "")).trim();
  const taken = projectBlueprints[projectId]?.status === "ready"
    && projectBlueprints[projectId].value.some(blueprint => blueprint.name.trim().toLowerCase() === effectiveName.toLowerCase());
  // A .agsdl file is an archive and anything else is a project folder, even before the preview says so.
  const archive = preview ? preview.packageFormat === "agsdl-archive-1" : /\.agsdl$/i.test(path);
  const summary = preview ? summarizePermissions(preview) : undefined;
  const otherWarnings = preview ? preview.warnings.filter(warning => !warning.launchBlocker).length : 0;
  const points = otherWarnings + (summary?.externalContent ? 1 : 0) + (summary?.launchBlockers ? 1 : 0);
  const disabledReason = inspection.status === "reading" ? t("agsdl.architect.import.reasonReading")
    : inspection.status === "blocked" ? t("agsdl.architect.import.reasonBlocked")
      : !effectiveName ? t("agsdl.architect.import.reasonName") : !projectId ? t("agsdl.architect.import.reasonProject")
        : taken ? t("agsdl.architect.import.nameTaken") : undefined;

  const commit = async () => {
    if (!ready || busy || disabledReason) return;
    setBusy(true); setError("");
    try {
      committed.current = true;
      await useArchitectLibraryStore.getState().commitImport(ready.handle, projectId, effectiveName);
      notify.success(t("agsdl.architect.import.done", { name: effectiveName }));
      onClose();
    } catch (failure) {
      committed.current = false;
      setError(agsdlErrorText(failure, t));
      setBusy(false);
    }
  };

  const kind = archive ? "archive" : "folder";
  const title = preview?.title ? t(`agsdl.architect.import.titleNamed.${kind}`, { name: preview.title }) : t(`agsdl.architect.import.title.${kind}`);
  return <ArchitectDialogShell title={title} wide locked={busy} onClose={onClose}
    subtitle={<span title={path}>{baseName(path)}{preview ? ` · ${t("agsdl.architect.import.files", { count: preview.files.length })}` : ""}</span>}
    footer={<>
      <button type="button" disabled={busy} onClick={onClose}>{t("agsdl.cancel")}</button>
      <button type="button" className="agsdl-action-button is-primary" disabled={busy || !!disabledReason} title={disabledReason}
        onClick={() => void commit()}>
        {busy && <SpinnerIcon size={12} />}{t(busy ? "agsdl.architect.import.importing" : "agsdl.architect.import.action")}
      </button>
    </>}>
    {inspection.status === "reading" && <div role="status" className="space-y-2">
      <p className="!m-0 flex items-center gap-2"><SpinnerIcon size={13} />{t("agsdl.architect.import.reading")}</p>
      <Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" />
    </div>}
    {inspection.status === "blocked" && <div role="alert" className="space-y-2">
      <p className="!m-0 flex items-start gap-2 font-medium text-red-500"><Icon name="circle-x" size={14} className="mt-0.5 shrink-0" />{t("agsdl.architect.import.blocked")}</p>
      <p className="!m-0">{t(`agsdl.architect.import.blocker.${inspection.key}`)}</p>
      {inspection.technical && <details className="agsdl-details"><DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
        <p className="break-words font-mono text-[11px]">{plain(inspection.technical, 600)}</p></details>}
    </div>}
    {preview && summary && <>
      <p className={`!m-0 flex items-start gap-2 font-medium ${points ? "text-amber-500" : "text-emerald-500"}`}>
        <Icon name={points ? "triangle-alert" : "check-circle"} size={14} className="mt-0.5 shrink-0" />
        <span>{points ? t("agsdl.architect.import.validWithPoints", { count: points }) : t("agsdl.architect.import.valid")}</span>
      </p>
      <section aria-label={t("agsdl.architect.import.system")}>
        <h4 className="mb-1 text-[11px] font-medium text-muted-foreground">{t("agsdl.architect.import.system")}</h4>
        <p className="!m-0">{t("agsdl.architect.import.counts", {
          agents: Object.keys(preview.agents).length, tools: Object.keys(preview.mcpServers).length })}</p>
      </section>
      <PermissionSummary source={preview} />
      {otherWarnings > 0 && <p className="!m-0 flex items-start gap-2 text-amber-500">
        <Icon name="triangle-alert" size={13} className="mt-0.5 shrink-0" />
        <span>{t("agsdl.architect.import.warnings", { count: otherWarnings })}</span>
      </p>}
      <InfoBlock icon={<Info size={13} />}>
        <p className="!m-0">{t("agsdl.architect.import.macroSettings")}</p>
        {preview.historyWillBeRemoved && <p className="!m-0">{t("agsdl.architect.import.historyRemoved")}</p>}
      </InfoBlock>
      <details className="agsdl-details">
        <DisclosureSummary>{t("agsdl.architect.import.allDetails")}</DisclosureSummary>
        <ImportDetails preview={preview} />
      </details>
      <fieldset className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 border-t border-border pt-3" disabled={busy}>
        <label htmlFor="architect-import-project" className="text-muted-foreground">{t("agsdl.library.project")}</label>
        <select id="architect-import-project" className="rounded-md border border-border bg-background px-2 py-1.5" value={projectId}
          onChange={event => setProjectId(event.target.value)}>
          {projectList.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <label htmlFor="architect-import-name" className="text-muted-foreground">{t("agsdl.design.name")}</label>
        <input id="architect-import-name" className="rounded-md border border-border bg-background px-2 py-1.5" maxLength={120}
          value={name ?? (preview.title || preview.authoredId)} aria-invalid={taken || undefined} onChange={event => setName(event.target.value)} />
      </fieldset>
      {taken && <p role="alert" className="!m-0 text-red-500">{t("agsdl.architect.import.nameTaken")}</p>}
      <p className="!m-0 text-[11px] text-muted-foreground">{t(archive ? "agsdl.library.importArchiveResult" : "agsdl.library.importFolderResult")}</p>
    </>}
    {error && <p role="alert" className="!m-0 whitespace-pre-line break-words text-red-500">{t("agsdl.architect.import.failed")} {error}</p>}
  </ArchitectDialogShell>;
}

function ImportDetails({ preview }: { preview: NonNullable<InspectedImport["preview"]> }) {
  const { t } = useAgsdlTranslation();
  const agents = Object.entries(preview.agents);
  const tools = Object.entries(preview.mcpServers);
  return <div className="space-y-3 text-[11px]">
    {agents.length > 0 && <section><h4 className="mb-1 font-medium text-muted-foreground">{t("agsdl.architect.import.detailAgents")}</h4>
      <ul className="space-y-0.5">{agents.map(([id, agent]) => <li key={id} className="break-words">
        <strong>{plain(id, 80)}</strong> · {plain(agent.harness, 40)}{agent.model?.name ? ` · ${plain(agent.model.name, 60)}` : ""}
        {agent.permissions.preset ? ` · ${plain(agent.permissions.preset, 30)}` : ""}
        {agent.usage === "declaredOnly" && <span className="text-muted-foreground"> · {t("agsdl.architect.import.unreachable")}</span>}
      </li>)}</ul></section>}
    {tools.length > 0 && <section><h4 className="mb-1 font-medium text-muted-foreground">{t("agsdl.architect.import.detailTools")}</h4>
      <ul className="space-y-0.5">{tools.map(([id, tool]) => <li key={id} className="break-words">
        <strong>{plain(id, 80)}</strong> · <span className="font-mono">{plain(tool.transport.type === "local" ? tool.transport.command.join(" ") : tool.transport.url)}</span>
        {tool.requiredSecrets.length > 0 && <span> · {tool.requiredSecrets.map(secret => plain(secret, 60)).join(", ")}{tool.usage === "declaredOnly" ? ` (${t("agsdl.architect.import.notRequested")})` : ""}</span>}
      </li>)}</ul></section>}
    {preview.externalReferences.length > 0 && <section><h4 className="mb-1 font-medium text-muted-foreground">{t("agsdl.architect.import.detailExternal")}</h4>
      <ul className="space-y-0.5">{preview.externalReferences.map((reference, index) =>
        <li key={index} className="select-text break-all font-mono">{plain(reference.uri)}</li>)}</ul></section>}
    {preview.warnings.length > 0 && <section><h4 className="mb-1 font-medium text-muted-foreground">{t("agsdl.architect.import.detailWarnings")}</h4>
      <ul className="space-y-0.5">{preview.warnings.map((warning, index) => <li key={index} className="break-words font-mono">
        {warning.code} · {warning.location.file}{warning.location.pointer} · {plain(warning.message)}</li>)}</ul></section>}
  </div>;
}
