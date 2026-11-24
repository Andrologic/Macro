import { useState, type FormEvent } from "react";
import { architectLaunch, type LaunchConfiguration, type LaunchModelOverrides, type LaunchPreview, type LaunchSecret } from "../../../services/ipc/architectLaunch";
import type { VersionKey } from "../../../services/ipc/architectLibrary";
import { DisclosureSummary } from "../../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../../agsdl/useAgsdlTranslation";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { SpinnerIcon } from "../../ui/SpinnerIcon";
import { classifyBlocker, codexGuides, selectClass } from "./launchModel";

const compact = "!h-7 !px-3 !py-0 text-xs";

/** How many things still stand between the person and the Launch button, outside the start message. */
export function pendingCount(preview: LaunchPreview, folderConfirmed: boolean): number {
  return preview.blockers.length + preview.secrets.filter(secret => !secret.stored).length +
    (preview.folderReuseToken && !folderConfirmed ? 1 : 0);
}

/**
 * One secret, asked in place. The value never comes back to the screen: a stored secret
 * shows only that it exists, and can be replaced.
 */
export function SecretRow({ version, secret, configuration, disabled, onSaved }: {
  version: VersionKey;
  secret: LaunchSecret;
  configuration: LaunchConfiguration;
  disabled?: boolean;
  onSaved: (secret: LaunchSecret) => void;
}) {
  const { t } = useAgsdlTranslation();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (disabled || pending || !value) return;
    setPending(true);
    setFailed(false);
    try {
      await architectLaunch.setSecret(version, secret.server, secret.name, value, configuration);
      setValue("");
      onSaved(secret);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return <form className="space-y-1" onSubmit={event => void save(event)}>
    <p className="!m-0 flex items-start gap-2">
      <Icon name="lock" size={13} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 break-words">{t("agsdl.launch.secretNeeded", { server: secret.server, name: secret.name })}</span>
    </p>
    <div className="flex items-center gap-2 pl-5">
      <Input type="password" autoComplete="off" spellCheck={false} className="!h-7 min-w-0 flex-1 text-xs" value={value}
        disabled={disabled || pending} aria-label={t("agsdl.launch.secretValue", { name: secret.name })}
        placeholder={secret.stored ? t("agsdl.launch.secretStored") : undefined} onChange={event => setValue(event.target.value)} />
      <Button type="submit" size="sm" variant="secondary" className={compact} disabled={disabled || pending || !value}>
        {pending && <SpinnerIcon size={12} />}{t(secret.stored ? "agsdl.launch.replaceSecret" : "agsdl.launch.saveSecret")}
      </Button>
    </div>
    <p className="!m-0 pl-5 text-[11px] text-muted-foreground">{t("agsdl.launch.secretHelp")}</p>
    {failed && <p role="alert" className="!m-0 pl-5 text-red-500">{t("agsdl.launch.secretFailed")}</p>}
  </form>;
}

/** A model the engine does not offer: the person picks another one, for this run only. */
export function ModelRow({ agent, availableModels, overrides, disabled, onOverride, resolved = false }: {
  agent: string;
  availableModels: readonly string[];
  overrides: LaunchModelOverrides;
  disabled?: boolean;
  onOverride: (agent: string, model: string) => void;
  /** Shown after a replacement was chosen: the same picker, without the problem statement. */
  resolved?: boolean;
}) {
  const { t } = useAgsdlTranslation();
  const chosen = Object.hasOwn(overrides, agent) ? overrides[agent].name : "";
  return <div className="space-y-1">
    <p className="!m-0 flex items-start gap-2">
      <Icon name={resolved ? "check-circle" : "triangle-alert"} size={13}
        className={`mt-0.5 shrink-0 ${resolved ? "text-emerald-500" : "text-amber-500"}`} aria-hidden="true" />
      <span className="min-w-0 break-words">{t(resolved ? "agsdl.launch.modelReplaced" : "agsdl.launch.modelMissing", { agent })}</span>
    </p>
    {availableModels.length > 0 ? <div className="pl-5">
      <Select fullWidth={false} className={selectClass} aria-label={t("agsdl.launch.replacementModel", { agent })} value={chosen}
        disabled={disabled} onChange={event => onOverride(agent, event.target.value)}>
        <option value="">{t("agsdl.launch.chooseModel")}</option>
        {availableModels.map(model => <option key={model} value={model}>{model}</option>)}
      </Select>
    </div> : <p className="!m-0 pl-5 text-muted-foreground">{t("agsdl.launch.modelNoChoice")}</p>}
    <p className="!m-0 pl-5 text-[11px] text-muted-foreground">{t("agsdl.launch.modelHelp")}</p>
  </div>;
}

/** The zone of things to settle before launching. It exists only when something is missing, and every row fixes itself. */
export function LaunchChecklist({ preview, overrides, folderConfirmed, disabled, checking, onOverride, onChooseFolder, onConfirmFolder, onSecretSaved, onOpenGuide, onRecheck }: {
  preview: LaunchPreview;
  overrides: LaunchModelOverrides;
  folderConfirmed: boolean;
  disabled?: boolean;
  checking?: boolean;
  onOverride: (agent: string, model: string) => void;
  onChooseFolder: () => void;
  onConfirmFolder: (confirmed: boolean) => void;
  onSecretSaved: (secret: LaunchSecret) => void;
  onOpenGuide: (url: string) => void;
  onRecheck: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const missing = preview.secrets.filter(secret => !secret.stored);
  const blockers = preview.blockers.map(blocker => ({ blocker, view: classifyBlocker(blocker) }));
  const rows = missing.length + blockers.length + (preview.folderReuseToken ? 1 : 0);
  if (!rows) return null;
  const recheckable = blockers.some(({ view }) => view.kind === "author" || view.kind === "codex");
  return <section aria-label={t("agsdl.launch.blockers")} className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
    <h3 className="!m-0 flex items-center gap-2 text-xs font-medium text-amber-500">
      <Icon name="triangle-alert" size={13} aria-hidden="true" />{t("agsdl.launch.blockers")}
    </h3>
    <ul className="space-y-3">
      {blockers.map(({ blocker, view }) => <li key={JSON.stringify([blocker.code, blocker.subject])}>
        {view.kind === "model" && <ModelRow agent={view.agent} availableModels={preview.availableModels} overrides={overrides}
          disabled={disabled} onOverride={onOverride} />}
        {view.kind === "folder" && <div className="space-y-1">
          <p className="!m-0 flex items-start gap-2"><Icon name="folder" size={13} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>{t("agsdl.launch.folderRequired")}</span></p>
          <div className="pl-5"><Button size="sm" variant="secondary" className={compact} disabled={disabled} onClick={onChooseFolder}>{t("agsdl.launch.chooseFolder")}</Button></div>
        </div>}
        {view.kind === "codex" && <CodexBlockerRow view={view} onOpenGuide={onOpenGuide} />}
        {view.kind === "mcpRemote" && <RemoteMcpBlocker server={view.server} technical={view.technical} textKey={view.textKey}
          definition={preview.permissions.mcpServers[view.server]} />}
        {view.kind === "author" && <div className="space-y-1">
          <p className="!m-0 flex items-start gap-2"><Icon name="circle-x" size={13} className="mt-0.5 shrink-0 text-red-500" aria-hidden="true" />
            <span className="min-w-0 break-words">{t(`agsdl.launch.blocker.${view.textKey}`, { subject: view.subject })}</span></p>
          <p className="!m-0 pl-5 text-[11px] text-muted-foreground">{t("agsdl.launch.authorMustFix")}</p>
          <Technical technical={view.technical} />
        </div>}
      </li>)}
      {preview.folderReuseToken && <li className="space-y-1">
        <p className="!m-0 flex items-start gap-2"><Icon name="triangle-alert" size={13} className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
          <span>{t("agsdl.launch.folderInUse")}</span></p>
        {preview.configuration.workingFolder && <p className="!m-0 break-all pl-5 font-mono text-[11px]">{preview.configuration.workingFolder}</p>}
        <label className="flex items-center gap-2 pl-5">
          <input type="checkbox" className="size-3.5 accent-primary" checked={folderConfirmed} disabled={disabled}
            onChange={event => onConfirmFolder(event.target.checked)} />
          {t("agsdl.launch.confirmFolderReuse")}
        </label>
      </li>}
      {missing.map(secret => {
        const remote = Object.hasOwn(preview.remoteMcp, secret.server) ? preview.remoteMcp[secret.server] : undefined;
        return <li key={JSON.stringify([preview.version, secret.server, secret.name, remote])}>
          <SecretRow version={preview.version} secret={secret} configuration={preview.configuration}
            disabled={disabled || checking} onSaved={onSecretSaved} />
        </li>;
      })}
    </ul>
    {recheckable && <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost" className={compact} disabled={disabled || checking} onClick={onRecheck}>
        {checking ? <SpinnerIcon size={12} /> : <Icon name="rotate-ccw" size={12} aria-hidden="true" />}{t("agsdl.launch.recheck")}
      </Button>
    </div>}
  </section>;
}

function CodexBlockerRow({ view, onOpenGuide }: {
  view: Extract<ReturnType<typeof classifyBlocker>, { kind: "codex" }>;
  onOpenGuide: (url: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const guide = view.guide && codexGuides[view.guide];
  return <div className="space-y-1">
    <p className="!m-0 flex items-start gap-2">
      <Icon name="triangle-alert" size={13} className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
      <span>{t("agsdl.launch.blocker." + view.textKey)}</span>
    </p>
    {guide && <div className="pl-5">
      <a href={guide.href} className="agsdl-link"
        onClick={event => { event.preventDefault(); onOpenGuide(guide.href); }}>{t("agsdl.launch." + guide.label)}</a>
    </div>}
    <Technical technical={view.technical} />
  </div>;
}

function RemoteMcpBlocker({ server, technical, definition, textKey }: {
  textKey: string;
  server: string;
  technical: string;
  definition?: LaunchPreview["permissions"]["mcpServers"][string];
}) {
  const { t } = useAgsdlTranslation();
  const endpoint = definition?.transport.type === "remote" ? definition.transport.url : null;
  const names = definition?.requiredSecrets ?? [];
  return <div className="space-y-1">
    <p className="!m-0 flex items-start gap-2">
      <Icon name="circle-x" size={13} className="mt-0.5 shrink-0 text-red-500" aria-hidden="true" />
      <span>{t("agsdl.launch.blocker." + textKey, { subject: server })}</span>
    </p>
    {endpoint && <p className="!m-0 break-all pl-5 font-mono text-[11px]">{endpoint}</p>}
    {names.length > 0 && <p className="!m-0 break-words pl-5 text-[11px] text-muted-foreground">
      {t("agsdl.launch.blocker.mcpRemoteDeclaredSecrets", { names: names.join(", ") })}
    </p>}
    <Technical technical={technical} />
  </div>;
}

function Technical({ technical }: { technical: string }) {
  const { t } = useAgsdlTranslation();
  if (!technical) return null;
  return <details className="agsdl-details !mt-1 !border-0 !pl-5 !pt-0">
    <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
    <p className="!m-0 break-words font-mono text-[11px]">{technical}</p>
  </details>;
}
