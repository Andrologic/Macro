import { useCallback, useEffect, useState } from "react";
import { openExternalUrl } from "../../services/externalUrlOpener";
import { architectLaunch, type LaunchConfiguration, type LaunchModelOverrides, type LaunchPreview, type RemoteMcpSettings } from "../../services/ipc/architectLaunch";
import { architectLibrary, type BlueprintVersionSummary, type VersionKey } from "../../services/ipc/architectLibrary";
import { open } from "../../services/tauriDialog";
import { openWorkflowRun030, refreshArchiveRunAccess } from "../../services/workflowAgentTasks";
import { useAppStore } from "../../stores/useAppStore";
import { useArchitectLaunchStore } from "../../stores/useArchitectLaunchStore";
import { DisclosureSummary } from "../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { ArchitectDialogShell } from "../architect/ArchitectDialogShell";
import { Skeleton } from "../shared/Skeleton";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { SpinnerIcon } from "../ui/SpinnerIcon";
import { Textarea } from "../ui/Textarea";
import { notify } from "../ui/toastService";
import { LaunchChecklist, ModelRow, SecretRow, pendingCount } from "./launch/LaunchChecklist";
import { LaunchConsent } from "./launch/LaunchConsent";
import { LaunchMcpDetails, LaunchMcpNotes, LaunchMcpSettings } from "./launch/LaunchMcpDetails";
import { LaunchSummary } from "./launch/LaunchSummary";
import { failureCode, failureText, isFolderFailure, isRecheckFailure, selectClass } from "./launch/launchModel";

interface SystemChoice {
  id: string;
  name: string;
  /** Launchable versions, newest first. */
  versions: BlueprintVersionSummary[];
}

export async function loadLaunchSystems(): Promise<SystemChoice[]> {
  const projects = await architectLibrary.listProjects();
  const groups = await Promise.all(projects.map(project => architectLibrary.listBlueprints(project.id)));
  return Promise.all(groups.flat().map(async blueprint => ({
    id: blueprint.id,
    name: blueprint.name,
    versions: (await architectLibrary.listVersions(blueprint.id))
      .filter(version => version.storageState === "archive").sort((a, b) => b.number - a.number),
  })));
}

/** The secrets a version's tools ask for, with their stored state. The values never come back. */
export function ArchiveRunSecrets({ version, onClose }: { version: VersionKey; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<LaunchPreview>();
  const [failed, setFailed] = useState(false);
  const { blueprintId, number } = version;
  useEffect(() => {
    let active = true;
    setFailed(false);
    void architectLaunch.prepare({ blueprintId, number }).then(value => {
      if (active) setPreview(value);
    }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [blueprintId, number, revision]);
  return <ArchitectDialogShell title={t("agsdl.launch.secrets")} onClose={onClose}
    footer={<button type="button" onClick={onClose}>{t("agsdl.close")}</button>}>
    {!preview && !failed && <div role="status" className="space-y-2">
      <p className="!m-0 flex items-center gap-2"><SpinnerIcon size={13} />{t("agsdl.launch.checking")}</p><Skeleton className="h-8" />
    </div>}
    {failed && <p role="alert" className="!m-0 text-red-500">{t("agsdl.launch.failed")}{" "}
      <button type="button" className="agsdl-link" onClick={() => setRevision(current => current + 1)}>{t("agsdl.retry")}</button></p>}
    {preview && !preview.secrets.length && <p className="!m-0 text-muted-foreground">
      {t(preview.blockers.some(blocker => Object.hasOwn(preview.remoteMcpSetup, blocker.subject))
        ? "agsdl.launch.mcp.configureInLaunch" : "agsdl.launch.noSecrets")}
    </p>}
    {preview?.secrets.map(secret => <SecretRow key={JSON.stringify([secret.server, secret.name])}
      version={version} secret={secret} configuration={preview.configuration} onSaved={() => setRevision(current => current + 1)} />)}
  </ArchitectDialogShell>;
}

interface Problem { message: string; technical: string; recheck: boolean }

export default function ArchitectLaunchDialog({ initialVersion }: { initialVersion?: VersionKey }) {
  const { t } = useAgsdlTranslation();
  const close = useArchitectLaunchStore(state => state.close);
  const [systems, setSystems] = useState<SystemChoice[]>();
  const [systemsFailed, setSystemsFailed] = useState(false);
  const [systemsRevision, setSystemsRevision] = useState(0);
  const [blueprintId, setBlueprintId] = useState(initialVersion?.blueprintId ?? "");
  const [number, setNumber] = useState(initialVersion?.number);
  const [preview, setPreview] = useState<LaunchPreview>();
  const [unavailableVersion, setUnavailableVersion] = useState<VersionKey>();
  const [confirmedFolderToken, setConfirmedFolderToken] = useState<string | null>(null);
  const [modelOverrides, setModelOverrides] = useState<LaunchModelOverrides>({});
  const [configuration, setConfiguration] = useState<LaunchConfiguration>();
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [revision, setRevision] = useState(0);
  const [problem, setProblem] = useState<Problem>();
  const [notice, setNotice] = useState("");
  const selected = systems?.find(system => system.id === blueprintId);
  const usable = selected?.versions.filter(option =>
    !(unavailableVersion?.blueprintId === blueprintId && unavailableVersion.number === option.number)) ?? [];
  const version = number === undefined ? usable[0] : usable.find(option => option.number === number);
  const versionMissing = !!systems && number !== undefined && !version;
  const versionNumber = version?.number;

  useEffect(() => {
    let active = true;
    setSystemsFailed(false);
    void loadLaunchSystems().then(value => {
      if (!active) return;
      setSystems(value);
      if (!initialVersion) setBlueprintId(value.find(system => system.versions.length > 0)?.id ?? "");
    }, () => { if (active) setSystemsFailed(true); });
    return () => { active = false; };
  }, [initialVersion, systemsRevision]);

  useEffect(() => {
    if (versionNumber === undefined) return;
    let active = true;
    void architectLaunch.prepare({ blueprintId, number: versionNumber }, configuration, modelOverrides).then(value => {
      if (!active) return;
      setPreview(value);
      setChecking(false);
    }, failure => {
      if (!active) return;
      setPreview(undefined);
      setChecking(false);
      if (failureCode(failure) === "ARCHIVE_UNAVAILABLE") {
        setNumber(versionNumber);
        setUnavailableVersion({ blueprintId, number: versionNumber });
      } else {
        setProblem({ ...failureText(failure, t), recheck: true });
      }
    });
    return () => { active = false; };
  }, [blueprintId, versionNumber, configuration, modelOverrides, revision, t]);

  const current = preview?.version.blueprintId === blueprintId && preview.version.number === versionNumber ? preview : undefined;
  const folderConfirmed = !!current?.folderReuseToken && current.folderReuseToken === confirmedFolderToken;
  const pending = current ? pendingCount(current, folderConfirmed) : 0;
  const messageMissing = !!current?.startMessageRequired && !message.trim();
  const settled = !!current && !checking && !pending;
  const ready = settled && !busy && !messageMissing;
  const reason = busy ? undefined : !current && problem ? t("agsdl.launch.recheckReason") : !current || checking ? t("agsdl.launch.checkingReason")
    : pending ? t("agsdl.launch.remaining", { count: pending }) : messageMissing ? t("agsdl.launch.messageRequired") : undefined;
  const replaced = Object.keys(modelOverrides).filter(agent => !current?.blockers.some(blocker => blocker.code === "modelUnavailable" && blocker.subject === agent));

  const recheck = useCallback(() => {
    setProblem(undefined);
    setChecking(true);
    setRevision(value => value + 1);
  }, []);
  const reset = () => {
    setPreview(undefined);
    setConfiguration(undefined);
    setModelOverrides({});
    setConfirmedFolderToken(null);
    setProblem(undefined);
    setNotice("");
    setConsent(false);
  };
  const chooseFolder = async () => {
    try {
      const folder = await open({ directory: true });
      if (!folder) return;
      setChecking(true);
      setConfirmedFolderToken(null);
      setConfiguration(previous => ({ ...(previous ?? current?.configuration), workingFolder: folder }));
    } catch {
      setProblem({ message: t("agsdl.launch.failed"), technical: "", recheck: false });
    }
  };
  const setMcpSettings = (server: string, url: string, settings: RemoteMcpSettings) => {
    if (!current) return;
    setConsent(false);
    setChecking(true);
    setNotice("");
    setConfiguration(previous => {
      const base = previous ?? current.configuration;
      const remoteMcp = base.remoteMcp ?? {};
      const endpoints = Object.hasOwn(remoteMcp, server) ? remoteMcp[server] : {};
      return { ...base, remoteMcp: { ...remoteMcp, [server]: { ...endpoints, [url]: settings } } };
    });
  };
  const override = (agent: string, model: string) => {
    setChecking(true);
    setModelOverrides(previous => {
      if (model) return { ...previous, [agent]: { name: model } };
      const next = { ...previous };
      delete next[agent];
      return next;
    });
  };

  const start = async () => {
    if (!ready || !current) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const { identity, source } = await architectLaunch.start({
        version: current.version,
        configuration: current.configuration,
        startMessage: current.startMessageRequired ? message : null,
        name: name.trim() || null,
        consentToken: consent ? current.consentToken : null,
        folderReuseToken: folderConfirmed ? confirmedFolderToken : null,
        modelOverrides,
      });
      close();
      void refreshArchiveRunAccess().catch(() => {});
      // Nothing opens by itself: the run is one click away. The start message stays out of the notice.
      notify.actionRequired(t("agsdl.launch.launched"), {
        tone: "info",
        description: [selected?.name, t("agsdl.library.version", { number: current.version.number })].filter(Boolean).join(" · "),
        actions: [{ label: t("agsdl.launch.viewRun"), onClick: () =>
          openWorkflowRun030({ scope: { systemStartId: identity.systemStartId, source }, conversationId: source.owner.planId }) }],
      });
    } catch (failure) {
      const code = failureCode(failure);
      if (isRecheckFailure(code)) {
        setConsent(false);
        if (isFolderFailure(code)) setConfirmedFolderToken(null);
        recheck();
      } else if (code === "ARCHIVE_UNAVAILABLE") {
        setConsent(false);
        setNumber(current.version.number);
        setUnavailableVersion(current.version);
      } else {
        setProblem({ ...failureText(failure, t), recheck: false });
      }
    } finally {
      setBusy(false);
    }
  };
  /** The first press moves to the permission step when one is needed; the second one launches. */
  const proceed = () => {
    if (!ready || !current) return;
    if (!consent && current.consentToken) setConsent(true);
    else void start();
  };

  const versionLabel = version && t("agsdl.library.version", { number: version.number });
  const title = consent ? t("agsdl.launch.permissions")
    : initialVersion && selected ? t("agsdl.launch.titleNamed", { name: selected.name }) : t("agsdl.launch.title");
  const subtitle = consent ? `${t("agsdl.launch.step2")} · ${[selected?.name, versionLabel, t("agsdl.inbox.local")].filter(Boolean).join(" · ")}` : undefined;
  const nothingToLaunch = !!systems && !systems.some(system => system.versions.length > 0) && !initialVersion;
  const showSystemPicker = !!systems && !nothingToLaunch && (!initialVersion || !selected);
  const noVersion = !!systems && !!selected && !selected.versions.length;
  const primary = busy ? t("agsdl.launch.starting")
    : t(consent ? "agsdl.launch.approve" : current?.consentToken ? "agsdl.launch.continue" : "agsdl.launch.start");

  const openArchitect = <Button size="sm" variant="secondary" className="!h-7 !px-3 !py-0 text-xs"
    onClick={() => { close(); useAppStore.getState().setMode("Architect"); }}>{t("agsdl.launch.openArchitect")}</Button>;

  return <ArchitectDialogShell title={title} subtitle={subtitle} locked={busy} onClose={close}
    footer={<>
      <span className="mr-auto self-center text-[11px] text-muted-foreground" role="status">{!consent && reason}</span>
      <button type="button" disabled={busy} onClick={consent ? () => setConsent(false) : close}>
        {t(consent ? "agsdl.launch.back" : "agsdl.cancel")}
      </button>
      <button type="button" className="agsdl-action-button is-primary" disabled={!ready} title={consent ? undefined : reason} onClick={proceed}>
        {busy && <SpinnerIcon size={12} />}{primary}
      </button>
    </>}>
    {systemsFailed && <p role="alert" className="!m-0 text-red-500">{t("agsdl.launch.systemsFailed")}{" "}
      <button type="button" className="agsdl-link" onClick={() => setSystemsRevision(value => value + 1)}>{t("agsdl.retry")}</button></p>}
    {!systems && !systemsFailed && <div role="status" className="space-y-2">
      <p className="!m-0 flex items-center gap-2"><SpinnerIcon size={13} />{t("agsdl.launch.checking")}</p>
      <Skeleton className="h-8" /><Skeleton className="h-16" />
    </div>}
    {nothingToLaunch && <div role="status" className="space-y-2">
      <p className="!m-0">{t("agsdl.launch.noSystems")}</p>{openArchitect}
    </div>}
    {!consent && <>
      {showSystemPicker && <div className="space-y-1">
        <label htmlFor="launch-system" className="block font-medium">{t("agsdl.launch.system")}</label>
        <Select id="launch-system" className={selectClass} value={blueprintId}
          disabled={busy} onChange={event => { setBlueprintId(event.target.value); setNumber(undefined); reset(); }}>
          <option value="" disabled>{t("agsdl.launch.chooseSystem")}</option>
          {systems?.map(system => <option key={system.id} value={system.id} disabled={!system.versions.length}>
            {system.name}{system.versions.length ? "" : ` · ${t("agsdl.launch.noVersionShort")}`}</option>)}
        </Select>
      </div>}
      {noVersion && <div role="status" className="space-y-2"><p className="!m-0">{t("agsdl.launch.noVersion")}</p>{openArchitect}</div>}
      {versionMissing && <div role="alert" className="space-y-1">
        <p className="!m-0 text-red-500">{t("agsdl.launch.versionMissing", { number })}</p>
        {usable.length > 0 && <Select className={selectClass} aria-label={t("agsdl.launch.versionLabel")} value=""
          onChange={event => { setNumber(Number(event.target.value)); reset(); }}>
          <option value="" disabled>{t("agsdl.launch.chooseVersion")}</option>
          {usable.map(option => <option key={option.number} value={option.number}>{t("agsdl.library.version", { number: option.number })}</option>)}
        </Select>}
      </div>}
      {current?.startMessageRequired && <div className="space-y-1">
        <label htmlFor="launch-start-message" className="block font-medium">{t("agsdl.launch.message")}</label>
        {current.startMessageHint && <p className="!m-0 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
          {t("agsdl.launch.authorHint", { hint: current.startMessageHint })}</p>}
        <Textarea id="launch-start-message" rows={4} className="text-xs" value={message} disabled={busy} autoFocus
          placeholder={current.startMessageHint ? undefined : t("agsdl.launch.messagePlaceholder")} onChange={event => setMessage(event.target.value)}
          onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); proceed(); } }} />
      </div>}
      {version && selected && <LaunchSummary versions={usable} versionNumber={version.number} note={current?.note ?? version.note ?? null}
        folderMode={current?.workingFolderMode ?? "perExecution"} folder={current?.configuration.workingFolder ?? null}
        checking={(!current && !problem) || checking} disabled={busy} runName={name} onRunName={setName}
        onVersion={value => { setNumber(value); reset(); }} onChooseFolder={() => void chooseFolder()}>
        {replaced.length > 0 && current && <div className="space-y-2">
          <p className="!m-0 text-muted-foreground">{t("agsdl.launch.replacedModels")}</p>
          {replaced.map(agent => <ModelRow key={agent} agent={agent} resolved availableModels={current.availableModels}
            overrides={modelOverrides} disabled={busy} onOverride={override} />)}
        </div>}
      </LaunchSummary>}
      {version && !current && !problem && <div role="status" className="space-y-2"><Skeleton className="h-8" /></div>}
      {current && <LaunchMcpSettings preview={current} disabled={busy || checking} onChange={setMcpSettings} />}
      {current && <LaunchChecklist preview={current} overrides={modelOverrides} folderConfirmed={folderConfirmed} disabled={busy} checking={checking}
        onOverride={override} onChooseFolder={() => void chooseFolder()}
        onConfirmFolder={confirmed => setConfirmedFolderToken(confirmed ? current.folderReuseToken : null)}
        onSecretSaved={secret => { setNotice(t("agsdl.launch.secretSaved", { name: secret.name })); setChecking(true); setRevision(value => value + 1); }}
        onOpenGuide={url => void openExternalUrl(url).catch(() => setProblem({ message: t("agsdl.launch.failed"), technical: "", recheck: false }))}
        onRecheck={recheck} />}
      {current && <LaunchMcpNotes notes={current.mcpNotes} />}
      {current && <LaunchMcpDetails preview={current} />}
      {notice && <p role="status" className="!m-0 text-[11px] text-emerald-500">{notice}</p>}
    </>}
    {consent && current && <LaunchConsent preview={current} />}
    {problem && <div role="alert" className="space-y-1 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2">
      <p className="!m-0 whitespace-pre-line break-words text-red-500">{problem.message}</p>
      {problem.technical && <details className="agsdl-details !mt-1 !border-0 !pt-0">
        <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
        <p className="!m-0 break-words font-mono text-[11px]">{problem.technical}</p>
      </details>}
      {problem.recheck && <Button size="sm" variant="ghost" className="!h-7 !px-3 !py-0 text-xs" onClick={recheck}>{t("agsdl.launch.recheck")}</Button>}
    </div>}
  </ArchitectDialogShell>;
}
