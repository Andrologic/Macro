import { useCallback, useEffect, useState } from "react";
import { parseLaunchValues } from "../../services/agsdl/launchFields";
import { openExternalUrl } from "../../services/externalUrlOpener";
import { architectLaunch, type LaunchConfiguration, type LaunchModelOverrides, type LaunchPreview, type RemoteMcpSettings } from "../../services/ipc/architectLaunch";
import { architectSchedule, type ScheduledLaunch } from "../../services/ipc/architectSchedule";
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
import { GroupCombobox } from "../ui/GroupCombobox";
import { Select } from "../ui/Select";
import { SpinnerIcon } from "../ui/SpinnerIcon";
import { Textarea } from "../ui/Textarea";
import { notify } from "../ui/toastService";
import { LaunchChecklist, ModelRow, SecretRow, pendingCount } from "./launch/LaunchChecklist";
import { LaunchConsent } from "./launch/LaunchConsent";
import { LaunchFieldsForm } from "./launch/LaunchFieldsForm";
import { LaunchMcpDetails, LaunchMcpNotes, LaunchMcpSettings } from "./launch/LaunchMcpDetails";
import { LaunchReach } from "./launch/LaunchReach";
import { initialScheduleFields, LaunchScheduleFields, toScheduleTiming, type ScheduleFields } from "./launch/LaunchScheduleFields";
import { LaunchSummary } from "./launch/LaunchSummary";
import { comboboxClass, failureCode, failureText, isFolderFailure, isRecheckFailure, selectClass } from "./launch/launchModel";

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
      version={version} secret={secret} configuration={preview.configuration}
      stdio={preview.permissions.mcpServers[secret.server]?.transport.type === "local"}
      onSaved={() => setRevision(current => current + 1)} />)}
  </ArchitectDialogShell>;
}

interface Problem { message: string; technical: string; recheck: boolean }

export default function ArchitectLaunchDialog({ initialVersion, schedule, onClose }: {
  initialVersion?: VersionKey;
  schedule?: { existing?: ScheduledLaunch; onSaved: () => void };
  onClose?: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const closeLaunch = useArchitectLaunchStore(state => state.close);
  const close = onClose ?? closeLaunch;
  const existing = schedule?.existing;
  const [scheduleFields, setScheduleFields] = useState(() => ({
    ...initialScheduleFields, policy: existing?.policy ?? initialScheduleFields.policy,
  }));
  const [systems, setSystems] = useState<SystemChoice[]>();
  const [systemsFailed, setSystemsFailed] = useState(false);
  const [systemsRevision, setSystemsRevision] = useState(0);
  const [blueprintId, setBlueprintId] = useState(initialVersion?.blueprintId ?? "");
  const [number, setNumber] = useState(initialVersion?.number);
  const [preview, setPreview] = useState<LaunchPreview>();
  const [unavailableVersion, setUnavailableVersion] = useState<VersionKey>();
  const [confirmedFolderToken, setConfirmedFolderToken] = useState<string | null>(null);
  const [modelOverrides, setModelOverrides] = useState<LaunchModelOverrides>(existing?.modelOverrides ?? {});
  const [configuration, setConfiguration] = useState<LaunchConfiguration | undefined>(existing?.configuration);
  const [message, setMessage] = useState(existing?.startMessage ?? "");
  const [fieldInputs, setFieldInputs] = useState(() => new Map(
    Object.entries(existing?.launchValues ?? {}).map(([key, value]) => [key, String(value)]),
  ));
  const [name, setName] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [revision, setRevision] = useState(0);
  const [problem, setProblem] = useState<Problem>();
  const [notice, setNotice] = useState("");
  const selected = systems?.find(system => system.id === blueprintId);
  const alwaysLatest = !!schedule && scheduleFields.policy.alwaysLatest;
  const latestNumber = selected?.versions[0]?.number;
  const requestedNumber = alwaysLatest ? latestNumber : number;
  const usable = selected?.versions.filter(option =>
    !(unavailableVersion?.blueprintId === blueprintId && unavailableVersion.number === option.number)) ?? [];
  const version = requestedNumber === undefined ? usable[0] : usable.find(option => option.number === requestedNumber);
  const versionMissing = !!systems && requestedNumber !== undefined && !version;
  const versionNumber = version?.number;

  const reset = useCallback(() => {
    setFieldInputs(new Map());
    setPreview(undefined);
    setConfiguration(undefined);
    setModelOverrides({});
    setConfirmedFolderToken(null);
    setProblem(undefined);
    setNotice("");
    setConsent(false);
  }, []);
  const handleUnavailableArchive = useCallback((key: VersionKey) => {
    if (alwaysLatest) {
      reset();
      setMessage("");
      setSystemsRevision(value => value + 1);
    } else {
      setNumber(key.number);
    }
    setConsent(false);
    setUnavailableVersion(key);
  }, [alwaysLatest, reset]);

  useEffect(() => {
    let active = true;
    setSystemsFailed(false);
    void loadLaunchSystems().then(value => {
      if (!active) return;
      // Nothing is preselected unless the window was opened for a version: starting the wrong system is worse than one more click.
      setSystems(value);
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
        handleUnavailableArchive({ blueprintId, number: versionNumber });
      } else {
        setProblem({ ...failureText(failure, t), recheck: true });
      }
    });
    return () => { active = false; };
  }, [blueprintId, versionNumber, configuration, modelOverrides, revision, t, handleUnavailableArchive]);

  const current = preview?.version.blueprintId === blueprintId && preview.version.number === versionNumber ? preview : undefined;
  const folderConfirmed = !!current?.folderReuseToken && current.folderReuseToken === confirmedFolderToken;
  const pending = current ? pendingCount(current, folderConfirmed) : 0;
  const fields = current?.launchFields;
  const launchValues = fields ? parseLaunchValues(fields, fieldInputs) : undefined;
  const messageMissing = !fields && !!current?.startMessageRequired && !message.trim();
  const settled = !!current && !checking && !pending;
  const timing = schedule && !existing ? toScheduleTiming(scheduleFields, Date.now()) : null;
  const timingMissing = !!schedule && !existing && !timing;
  const ready = settled && !busy && !messageMissing && launchValues !== null && !timingMissing;
  const choosing = !!systems && !blueprintId;
  const reason = busy ? undefined : choosing ? t("agsdl.launch.chooseSystemReason") : !current && problem ? t("agsdl.launch.recheckReason") : !current || checking ? t("agsdl.launch.checkingReason")
    : pending ? t("agsdl.launch.remaining", { count: pending }) : launchValues === null ? t("agsdl.launch.fields.invalidValues") : messageMissing ? t("agsdl.launch.messageRequired")
    : timingMissing ? t("agsdl.schedule.invalidTiming") : undefined;
  const replaced = Object.keys(modelOverrides).filter(agent => !current?.blockers.some(blocker => blocker.code === "modelUnavailable" && blocker.subject === agent));

  const recheck = useCallback(() => {
    setProblem(undefined);
    setChecking(true);
    setRevision(value => value + 1);
  }, []);
  const changeScheduleFields = (next: ScheduleFields) => {
    const nextNumber = next.policy.alwaysLatest ? latestNumber : number ?? usable[0]?.number;
    if (nextNumber !== versionNumber) reset();
    setScheduleFields(next);
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
      const launch = {
        version: current.version,
        configuration: current.configuration,
        startMessage: !fields && current.startMessageRequired ? message : null,
        ...(launchValues ? { launchValues } : {}),
        name: name.trim() || null,
        consentToken: consent ? current.consentToken : null,
        folderReuseToken: folderConfirmed ? confirmedFolderToken : null,
        modelOverrides,
      };
      if (schedule) {
        await architectSchedule.save({ id: existing?.id ?? null, launch, timing, policy: scheduleFields.policy });
        schedule.onSaved();
        close();
        return;
      }
      const { identity, source } = await architectLaunch.start(launch);
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
        handleUnavailableArchive(current.version);
      } else {
        const text = failureText(failure, t);
        if (code.startsWith("INVALID_SCHEDULE_")) text.message = t("agsdl.schedule.invalidTiming");
        if (code === "SCHEDULE_CHANGED" || code === "SCHEDULE_LATEST_CHANGED") text.message = t("agsdl.schedule.changed");
        if (code === "SCHEDULE_LATEST_CHANGED") {
          reset();
          setSystemsRevision(value => value + 1);
        }
        setProblem({ ...text, recheck: false });
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
    : schedule ? t(existing ? "agsdl.schedule.configure" : "agsdl.schedule.create")
    : initialVersion && selected ? t("agsdl.launch.titleNamed", { name: selected.name }) : t("agsdl.launch.title");
  const subtitle = consent ? `${t("agsdl.launch.step2")} · ${[selected?.name, versionLabel, t("agsdl.inbox.local")].filter(Boolean).join(" · ")}` : undefined;
  const nothingToLaunch = !!systems && !systems.some(system => system.versions.length > 0) && !initialVersion;
  const showSystemPicker = !!systems && !nothingToLaunch && (!initialVersion || !selected);
  const noVersion = !!systems && !!selected && !selected.versions.length;
  /** Only systems with a saved version can be started: the others would be dead ends in the list. */
  const launchable = (systems ?? []).filter(system => system.versions.length > 0).map(({ id, name }) => ({ id, name }));
  const primary = t(busy ? schedule ? "agsdl.schedule.saving" : "agsdl.launch.starting"
    : !consent && current?.consentToken ? "agsdl.launch.continue"
    : schedule ? "agsdl.schedule.save" : consent ? "agsdl.launch.approve" : "agsdl.launch.start");

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
      {/* Until a system is chosen the list opens below the field, with room to read it. */}
      {showSystemPicker && <div className={`space-y-1 ${blueprintId ? "" : "min-h-52"}`}>
        <span className="block font-medium">{t("agsdl.launch.system")}</span>
        <GroupCombobox projectGroups={launchable} selectedGroupId={blueprintId || null} placeholder={t("agsdl.launch.chooseSystem")}
          ariaLabel={t("agsdl.launch.system")} inputClassName={comboboxClass}
          noneLabel={null} emptyLabel={t("agsdl.launch.noSystemMatch")} optionIcon="layout-template"
          onSelect={id => { if (busy) return; setBlueprintId(id ?? ""); setNumber(undefined); reset(); }} />
      </div>}
      {noVersion && <div role="status" className="space-y-2"><p className="!m-0">{t("agsdl.launch.noVersion")}</p>{openArchitect}</div>}
      {versionMissing && <div role="alert" className="space-y-1">
        <p className="!m-0 text-red-500">{t("agsdl.launch.versionMissing", { number: requestedNumber })}</p>
        {alwaysLatest && <button type="button" className="agsdl-link" onClick={() => {
          setUnavailableVersion(undefined);
          setSystemsRevision(value => value + 1);
        }}>{t("agsdl.retry")}</button>}
        {!alwaysLatest && usable.length > 0 && <Select className={selectClass} aria-label={t("agsdl.launch.versionLabel")} value=""
          onChange={event => { setNumber(Number(event.target.value)); reset(); }}>
          <option value="" disabled>{t("agsdl.launch.chooseVersion")}</option>
          {usable.map(option => <option key={option.number} value={option.number}>{t("agsdl.library.version", { number: option.number })}</option>)}
        </Select>}
      </div>}
      {fields && current && <LaunchFieldsForm schema={fields} hint={current.startMessageHint} values={fieldInputs} disabled={busy}
        onChange={(key, value) => setFieldInputs(previous => new Map(previous).set(key, value))} />}
      {!fields && current?.startMessageRequired && <div className="space-y-1">
        <label htmlFor="launch-start-message" className="block font-medium">{t("agsdl.launch.message")}</label>
        {current.startMessageHint && <p className="!m-0 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
          {t("agsdl.launch.authorHint", { hint: current.startMessageHint })}</p>}
        <Textarea id="launch-start-message" rows={4} className="text-xs" value={message} disabled={busy} autoFocus
          placeholder={current.startMessageHint ? undefined : t("agsdl.launch.messagePlaceholder")} onChange={event => setMessage(event.target.value)}
          onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); proceed(); } }} />
      </div>}
      {version && selected && <LaunchSummary scheduled={!!schedule} versions={alwaysLatest ? [version] : usable} versionNumber={version.number} note={current?.note ?? version.note ?? null}
        folderMode={current?.workingFolderMode ?? "perExecution"} folder={current?.configuration.workingFolder ?? null}
        checking={(!current && !problem) || checking} disabled={busy} runName={name} onRunName={setName}
        onVersion={value => { setNumber(value); reset(); }} onChooseFolder={() => void chooseFolder()}>
        {replaced.length > 0 && current && <div className="space-y-2">
          <p className="!m-0 text-muted-foreground">{t("agsdl.launch.replacedModels")}</p>
          {replaced.map(agent => <ModelRow key={agent} agent={agent} resolved availableModels={current.availableModels}
            overrides={modelOverrides} disabled={busy} onOverride={override} />)}
        </div>}
      </LaunchSummary>}
      {schedule && (current || (alwaysLatest && versionMissing)) && <LaunchScheduleFields value={scheduleFields} onChange={changeScheduleFields}
        editing={!!existing} sharedFolder={current?.workingFolderMode === "atLaunch"} disabled={busy} />}
      {version && !current && !problem && <div role="status" className="space-y-2"><Skeleton className="h-8" /></div>}
      {current && <LaunchReach preview={current} />}
      {current && <LaunchMcpSettings preview={current} disabled={busy || checking} onChange={setMcpSettings} />}
      {current && <LaunchChecklist preview={current} overrides={modelOverrides} folderConfirmed={folderConfirmed} disabled={busy} checking={checking}
        onOverride={override} onChooseFolder={() => void chooseFolder()}
        onConfirmFolder={confirmed => setConfirmedFolderToken(confirmed ? current.folderReuseToken : null)}
        onSecretSaved={secret => { setNotice(t("agsdl.launch.secretSaved", { name: secret.name })); setChecking(true); setRevision(value => value + 1); }}
        onOpenGuide={url => void openExternalUrl(url).catch(() => setProblem({ message: t("agsdl.launch.failed"), technical: "", recheck: false }))}
        onRecheck={recheck} />}
      {current && <LaunchMcpNotes preview={current} />}
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
