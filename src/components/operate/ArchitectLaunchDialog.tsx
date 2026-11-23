import { useEffect, useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { architectLaunch, type LaunchConfiguration, type LaunchModelOverrides, type LaunchPreview, type LaunchSecret } from "../../services/ipc/architectLaunch";
import { architectLibrary, type BlueprintVersionSummary, type VersionKey } from "../../services/ipc/architectLibrary";
import { openWorkflowRun030, refreshArchiveRunAccess } from "../../services/workflowAgentTasks";
import { useAppStore } from "../../stores/useAppStore";
import { useArchitectLaunchStore } from "../../stores/useArchitectLaunchStore";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Dialog } from "../ui/Dialog";
import { notify } from "../ui/toastService";

interface SystemChoice {
  id: string;
  name: string;
  versions: BlueprintVersionSummary[];
}

export async function loadLaunchSystems(): Promise<SystemChoice[]> {
  const projects = await architectLibrary.listProjects();
  const groups = await Promise.all(projects.map(project => architectLibrary.listBlueprints(project.id)));
  return Promise.all(groups.flat().map(async blueprint => ({
    id: blueprint.id,
    name: blueprint.name,
    versions: (await architectLibrary.listVersions(blueprint.id)).filter(version => version.storageState === "archive"),
  })));
}

function SecretField({ version, secret, onSaved }: {
  version: VersionKey;
  secret: LaunchSecret;
  onSaved: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = async () => {
    setPending(true);
    setFailed(false);
    try {
      await architectLaunch.setSecret(version, secret.server, secret.name, value);
      setValue("");
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return <div className="flex flex-wrap gap-2">
    <label>{secret.server} · {secret.name}
      <input type="password" autoComplete="off" value={value}
        placeholder={secret.stored ? t("agsdl.launch.secretStored") : undefined}
        onChange={event => setValue(event.target.value)} />
    </label>
    <button type="button" disabled={pending || !value} onClick={() => void save()}>
      {t("agsdl.launch.saveSecret")}
    </button>
    {failed && <p role="alert">{t("agsdl.launch.failed")}</p>}
  </div>;
}

export function ArchiveRunSecrets({ version, onClose }: { version: VersionKey; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<LaunchPreview>();
  const [failed, setFailed] = useState(false);
  const { blueprintId, number } = version;
  useEffect(() => {
    let active = true;
    void architectLaunch.prepare({ blueprintId, number }).then(value => {
      if (active) setPreview(value);
    }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [blueprintId, number, revision]);
  const title = t("agsdl.launch.secrets");
  return <Dialog title={title} onClose={onClose} panelClassName="agsdl-detail-modal">
    <header><strong>{title}</strong></header>
    <div className="agsdl-inspector-body space-y-2">
      {!preview && <p role={failed ? "alert" : "status"}>{t(failed ? "agsdl.launch.failed" : "agsdl.launch.checking")}</p>}
      {preview && !preview.secrets.length && <p>{t("agsdl.launch.noSecrets")}</p>}
      {preview?.secrets.map(secret => <SecretField key={JSON.stringify([secret.server, secret.name])}
        version={version} secret={secret} onSaved={() => setRevision(current => current + 1)} />)}
    </div>
  </Dialog>;
}

export default function ArchitectLaunchDialog({ initialVersion }: { initialVersion?: VersionKey }) {
  const { t } = useAgsdlTranslation();
  const close = useArchitectLaunchStore(state => state.close);
  const [systems, setSystems] = useState<SystemChoice[]>();
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
  const [error, setError] = useState("");
  const selected = systems?.find(system => system.id === blueprintId);
  const version = number === undefined ? selected?.versions[0] :
    selected?.versions.find(version => version.number === number &&
      !(unavailableVersion?.blueprintId === blueprintId && unavailableVersion.number === number));
  const versionMissing = !!systems && number !== undefined && !version;
  const versionNumber = version?.number;
  const refresh = () => setRevision(current => current + 1);
  const title = t(consent ? "agsdl.launch.permissions" : "agsdl.launch.title");

  useEffect(() => {
    let active = true;
    void loadLaunchSystems().then(value => {
      if (!active) return;
      setSystems(value);
      if (!initialVersion) setBlueprintId(value.find(system => system.versions.length > 0)?.id ?? "");
    }, () => { if (active) setError("failed"); });
    return () => { active = false; };
  }, [initialVersion]);

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
      if (failure?.code === "ARCHIVE_UNAVAILABLE") {
        setNumber(versionNumber);
        setUnavailableVersion({ blueprintId, number: versionNumber });
      } else {
        const invalid = ["GRAPH_LIMIT", "INPUT_LIMIT", "ARCHIVE_LAYOUT", "ARCHIVE_LIMIT", "ARCHIVE_INTEGRITY"].includes(failure?.code);
        setError(invalid ? "invalidArchive" : "failed");
      }
    });
    return () => { active = false; };
  }, [blueprintId, versionNumber, configuration, modelOverrides, revision]);

  const current = preview?.version.blueprintId === blueprintId && preview.version.number === versionNumber ? preview : undefined;
  const folderConfirmed = !!current?.folderReuseToken && current.folderReuseToken === confirmedFolderToken;
  const ready = current && !checking && !busy && !current.blockers.length &&
    !current.secrets.some(secret => !secret.stored) && (!current.folderReuseToken || folderConfirmed) &&
    (!current.startMessageRequired || message.trim());
  const modelAgents = new Set([
    ...Object.keys(modelOverrides),
    ...current?.blockers.filter(blocker => blocker.code === "modelUnavailable").map(blocker => blocker.subject) ?? [],
  ]);
  const reset = () => {
    setPreview(undefined);
    setConfiguration(undefined);
    setModelOverrides({});
    setConfirmedFolderToken(null);
    setError("");
  };
  const chooseFolder = async () => {
    try {
      const folder = await open({ directory: true });
      if (!folder) return;
      setChecking(true);
      setConfirmedFolderToken(null);
      setConfiguration({ workingFolder: folder });
    } catch {
      setError("failed");
    }
  };
  const checkAgain = () => {
    setError("");
    setChecking(true);
    refresh();
  };
  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !current) return;
    if (!consent && current.consentToken) {
      setConsent(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await architectLaunch.start({
        version: current.version,
        configuration: current.configuration,
        startMessage: current.startMessageRequired ? message : null,
        name: name.trim() || null,
        consentToken: consent ? current.consentToken : null,
        folderReuseToken: folderConfirmed ? confirmedFolderToken : null,
        modelOverrides,
      }).then(({ identity, source }) => {
        close();
        void refreshArchiveRunAccess().catch(() => {});
        notify.actionRequired(t("agsdl.launch.launched"), {
          tone: "info",
          description: selected?.name,
          actions: [{ label: t("agsdl.launch.viewRun"), onClick: () =>
            openWorkflowRun030({
              scope: { systemStartId: identity.systemStartId, source },
              conversationId: source.owner.planId,
            }) }],
        });
      });
    } catch (failure) {
      const code = failure && typeof failure === "object" && "code" in failure ? failure.code : "";
      const folderChanged = code === "WORKING_FOLDER_IN_USE" || code === "WORKING_FOLDER_CHANGED" ||
        code === "WORKING_FOLDER_UNAVAILABLE" || code === "workingFolderRequired";
      if (folderChanged || code === "CONSENT_REQUIRED" || code === "MODEL_UNAVAILABLE" ||
          code === "MCP_SECRETS_UNAVAILABLE") {
        setConsent(false);
        if (folderChanged) setConfirmedFolderToken(null);
        checkAgain();
      } else if (code === "ARCHIVE_UNAVAILABLE") {
        setConsent(false);
        setNumber(current.version.number);
        setUnavailableVersion(current.version);
      } else {
        const diagnostic = ["GRAPH_LIMIT", "INPUT_LIMIT", "ARCHIVE_LAYOUT", "ARCHIVE_LIMIT", "ARCHIVE_INTEGRITY"].some(refusal => refusal === code);
        setError(diagnostic ? "invalidArchive" : "failed");
      }
    } finally {
      setBusy(false);
    }
  };

  return <Dialog title={title} onClose={() => { if (!busy) close(); }} panelClassName="agsdl-detail-modal">
    <header><strong>{title}</strong></header>
    <form className="agsdl-inspector-body space-y-3" onSubmit={event => void start(event)}>
      <fieldset className="space-y-3" disabled={busy}>
        {!consent && <>
          {(!initialVersion || (systems && !selected)) && <label className="agsdl-edit-field">{t("agsdl.launch.system")}
            <select value={blueprintId} onChange={event => {
              setBlueprintId(event.target.value);
              setNumber(undefined);
              reset();
            }}>
              <option value="" disabled>{t("agsdl.launch.system")}</option>
              {systems?.map(system => <option key={system.id} value={system.id}>{system.name}</option>)}
            </select>
          </label>}
          {versionMissing && <p role="alert">{t("agsdl.launch.versionMissing", { number })}</p>}
          {versionMissing && !!selected?.versions.some(option => option.number !== number) &&
            <label className="agsdl-edit-field">{t("agsdl.library.versions")}
              <select value="" onChange={event => { setNumber(Number(event.target.value)); reset(); }}>
                <option value="" disabled>{t("agsdl.launch.chooseVersion")}</option>
                {selected.versions.filter(option => option.number !== number).map(option =>
                  <option key={option.number} value={option.number}>{t("agsdl.library.version", { number: option.number })}</option>)}
              </select>
            </label>}
          {systems && !version && !selected?.versions.length && <p role="status">{t("agsdl.launch.noVersion")}{" "}
            <button type="button" onClick={() => { close(); useAppStore.getState().setMode("Architect"); }}>
              {t("agsdl.launch.openArchitect")}
            </button>
          </p>}
          {current?.startMessageRequired && <label className="agsdl-edit-field">{t("agsdl.launch.message")}
            {current.startMessageHint && <span>{current.startMessageHint}</span>}
            <textarea rows={4} value={message} onChange={event => setMessage(event.target.value)} />
          </label>}
          {version && <details>
            <summary>{t("agsdl.library.version", { number: version.number })} · {t("agsdl.inbox.local")} · {t("agsdl.launch.now")} · {t("agsdl.launch.edit")}</summary>
            <label className="agsdl-edit-field">{t("agsdl.library.versions")}
              <select value={version.number} onChange={event => { setNumber(Number(event.target.value)); reset(); }}>
                {selected?.versions.filter(option =>
                  !(unavailableVersion?.blueprintId === blueprintId && unavailableVersion.number === option.number)
                ).map(option => <option key={option.number} value={option.number}>
                  {t("agsdl.library.version", { number: option.number })}{option.note && ` · ${option.note}`}
                </option>)}
              </select>
            </label>
            {current?.note && <p>{current.note}</p>}
            <label className="agsdl-edit-field">{t("agsdl.launch.runName")}
              <input value={name} onChange={event => setName(event.target.value)} />
            </label>
            {current?.workingFolderMode === "atLaunch" && <p>
              {current.configuration.workingFolder} <button type="button" onClick={() => void chooseFolder()}>{t("agsdl.launch.chooseFolder")}</button>
            </p>}
          </details>}
          {(!systems || (!!version && (!current || checking))) && !error && <p role="status">{t("agsdl.launch.checking")}</p>}
          {!!current?.blockers.length && <section aria-label={t("agsdl.launch.blockers")}>
            <strong>{t("agsdl.launch.blockers")}</strong>
            <ul>{current.blockers.map(({ code, subject }) => <li key={JSON.stringify([code, subject])}>
              {t(`agsdl.launch.blocker.${code}`, { subject, defaultValue: subject })}
              {code === "workingFolderRequired" && <button type="button" onClick={() => void chooseFolder()}>{t("agsdl.launch.chooseFolder")}</button>}
              {code === "codexUnavailable" && <button type="button" onClick={() => useAppStore.getState().openSettings("providers")}>{t("agsdl.launch.connect")}</button>}
            </li>)}</ul>
            <button type="button" onClick={checkAgain}>{t("agsdl.launch.recheck")}</button>
          </section>}
          {current && current.availableModels.length > 0 && [...modelAgents].map(agent =>
            <label className="agsdl-edit-field" key={agent}>{t("agsdl.launch.replacementModel", { agent })}
              <select value={Object.hasOwn(modelOverrides, agent) ? modelOverrides[agent].name : ""} onChange={event => {
                const model = event.target.value;
                setChecking(true);
                setModelOverrides(previous => {
                  if (model) return { ...previous, [agent]: { name: model } };
                  const next = { ...previous };
                  delete next[agent];
                  return next;
                });
              }}>
                <option value="">{t("agsdl.launch.chooseModel")}</option>
                {current.availableModels.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
            </label>)}
          {current && <div>{current.secrets.filter(secret => !secret.stored).map(secret =>
            <SecretField key={JSON.stringify([current.version, secret.server, secret.name])}
              version={current.version} secret={secret} onSaved={refresh} />)}</div>}
        </>}
        {current?.folderReuseToken && <label className="agsdl-edit-field">
          <span>{t("agsdl.launch.folderInUse")}</span>
          <span>{current.configuration.workingFolder}</span>
          <span><input type="checkbox" checked={folderConfirmed} onChange={event =>
            setConfirmedFolderToken(event.target.checked ? current.folderReuseToken : null)} /> {t("agsdl.launch.confirmFolderReuse")}</span>
        </label>}
        {consent && current && <ul className="space-y-1">
          {Object.entries(current.permissions.agents).filter(([, agent]) => agent.usage === "reachable").map(([id, agent]) =>
            <li key={id}>{id} · {t(`agsdl.launch.preset.${agent.permissions.preset ?? "read-only"}`, {
              defaultValue: agent.permissions.preset ?? "",
            })}
              {agent.completionCheck && <p>
                {agent.completionCheckChoices?.length
                  ? t("agsdl.launch.completionCheckChoices", { choices: agent.completionCheckChoices.join(", ") })
                  : t("agsdl.launch.completionCheck")}{" "}
                <code className="whitespace-pre-wrap">{agent.completionCheck}</code>
              </p>}
              {(Object.keys(agent.permissions.directories).length > 0 || agent.permissions.rules.length > 0 || agent.permissions.outside) && <details>
                <summary>{t("agsdl.launch.permissionDetails")}</summary>
                <pre className="whitespace-pre-wrap">{JSON.stringify(agent.permissions, null, 2)}</pre>
              </details>}
            </li>)}
          {current.permissions.directCalls.filter(call => call.usage === "reachable").map(({ location, target }) =>
            <li key={JSON.stringify(location)}>{target.type === "shell" ? target.command : `${target.server} · ${target.tool}`}</li>)}
          {current.permissions.externalReferences.filter(reference => reference.usage !== "declaredOnly").map(reference =>
            <li key={JSON.stringify(reference.location)}>{reference.uri}</li>)}
        </ul>}
      </fieldset>
      {error && <p role="alert">{t(`agsdl.launch.${error}`)} <button type="button" onClick={checkAgain}>{t("agsdl.launch.recheck")}</button></p>}
      <footer className="flex justify-end gap-3">
        <button type="button" disabled={busy} onClick={consent ? () => setConsent(false) : close}>
          {t(consent ? "agsdl.launch.back" : "agsdl.cancel")}
        </button>
        <button type="submit" disabled={!ready}>
          {t(busy ? "agsdl.launch.starting" : consent ? "agsdl.launch.approve" : current?.consentToken ? "agsdl.launch.continue" : "agsdl.launch.start")}
        </button>
      </footer>
    </form>
  </Dialog>;
}
