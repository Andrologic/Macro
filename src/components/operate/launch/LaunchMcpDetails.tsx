import { useId, useState } from "react";
import type { LaunchPreview, McpAddressScope, McpSecretDelivery, McpToolEffect, RemoteMcpSettings } from "../../../services/ipc/architectLaunch";
import { DisclosureSummary } from "../../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../../agsdl/useAgsdlTranslation";

import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { selectClass } from "./launchModel";

const addressScopes: readonly McpAddressScope[] = ["public", "privateNetwork", "thisComputer"];

function DeliveryRow({ name, suggestion, selected, onApply }: {
  name: string;
  suggestion: McpSecretDelivery;
  selected?: McpSecretDelivery;
  onApply: (delivery: McpSecretDelivery) => void;
}) {
  const { t } = useAgsdlTranslation();
  const id = useId();
  const [type, setType] = useState((selected ?? suggestion).type);
  const [header, setHeader] = useState(selected?.type === "header" ? selected.name : suggestion.type === "header" ? suggestion.name : "");
  const changed = type !== selected?.type || (type === "header" && selected?.type === "header" && selected.name !== header);
  return <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
    event.preventDefault();
    if (changed) onApply(type === "bearer" ? { type } : { type, name: header });
  }}>
    <label className="space-y-1">
      <span className="block break-words font-mono" id={id}>{name}</span>
      <Select fullWidth={false} className={selectClass} aria-labelledby={id} value={type}
        onChange={event => setType(event.target.value === "bearer" ? "bearer" : "header")}>
        <option value="bearer">{t("agsdl.launch.mcp.bearer")}</option>
        <option value="header">{t("agsdl.launch.mcp.header")}</option>
      </Select>
    </label>
    {type === "header" && <Input className="!h-7 min-w-24 flex-1 font-mono text-xs" autoComplete="off" spellCheck={false}
      aria-label={t("agsdl.launch.mcp.headerName", { name })} value={header} required onChange={event => setHeader(event.target.value)} />}
    <Button type="submit" size="sm" variant="secondary" className="!h-7 !px-3 text-xs" disabled={!changed || (type === "header" && !header)}>
      {t("agsdl.launch.mcp.applyDelivery")}
    </Button>
  </form>;
}

export function LaunchMcpSettings({ preview, disabled, onChange }: {
  preview: LaunchPreview;
  disabled: boolean;
  onChange: (server: string, url: string, settings: RemoteMcpSettings) => void;
}) {
  const { t } = useAgsdlTranslation();
  return Object.entries(preview.remoteMcpSetup).map(([server, setup]) => {
    const configuration = preview.configuration.remoteMcp;
    const settings = configuration && Object.hasOwn(configuration, server) ? configuration[server][setup.url] : undefined;
    return <fieldset key={JSON.stringify([server, setup.url])} disabled={disabled} className="space-y-2 rounded-md border border-border px-3 py-2">
      <legend className="px-1 font-medium">{t("agsdl.launch.mcp.configureRemote", { server })}</legend>
      <p className="!m-0 break-all font-mono">{setup.url}</p>
      <label className="flex flex-wrap items-center gap-2">
        <span>{t("agsdl.launch.mcp.addressScope")}</span>
        <Select fullWidth={false} className={selectClass} value={setup.addressScope} onChange={event => {
          const addressScope = addressScopes.find(scope => scope === event.target.value);
          if (addressScope) onChange(server, setup.url, { delivery: {}, ...settings, addressScope });
        }}>
          {addressScopes.map(scope => <option key={scope} value={scope}>{t("agsdl.launch.mcp.scope." + scope)}</option>)}
        </Select>
      </label>
      {Object.entries(setup.suggestions).map(([name, suggestion]) => {
        const selected = settings && Object.hasOwn(settings.delivery, name) ? settings.delivery[name] : undefined;
        return <DeliveryRow key={JSON.stringify([name, selected])} name={name} suggestion={suggestion} selected={selected}
          onApply={delivery => onChange(server, setup.url, { ...settings, delivery: { ...settings?.delivery, [name]: delivery } })} />;
      })}
    </fieldset>;
  });
}

export function mcpServersInUse(preview: LaunchPreview): Set<string> {
  return new Set([
    ...Object.keys(preview.remoteMcp), ...Object.keys(preview.mcpDirectTools),
    ...Object.values(preview.agentMcp).flatMap(equipment => Object.entries(equipment)
      .filter(([, access]) => access.equipped).map(([server]) => server)),
  ]);
}

export function LaunchMcpNotes({ notes }: { notes: LaunchPreview["mcpNotes"] }) {
  const { t } = useAgsdlTranslation();
  if (!notes.length) return null;
  return <ul className="space-y-1 text-muted-foreground">
    {notes.map(({ server, unsupportedEndpoint }) => <li key={server} className="break-words">
      {t(unsupportedEndpoint ? "agsdl.launch.mcp.unusedEndpoint" : "agsdl.launch.mcp.unusedServer", { server })}
    </li>)}
  </ul>;
}

export function LaunchMcpDetails({ preview, expanded = false }: { preview: LaunchPreview; expanded?: boolean }) {
  const { t } = useAgsdlTranslation();
  const servers = mcpServersInUse(preview);
  if (!servers.size) return null;
  const agents = Object.entries(preview.agentMcp)
    .map(([name, equipment]) => ({
      name,
      equipment: Object.entries(equipment).filter(([server, access]) =>
        access.equipped || (!expanded && servers.has(server))),
    }))
    .filter(agent => agent.equipment.length > 0);

  const title = t("agsdl.launch.mcp.title");
  const effectText = (effect: McpToolEffect) => t("agsdl.launch.mcp.effect." + effect);
  const rules = (entries: Record<string, McpToolEffect>) => Object.entries(entries).map(([pattern, effect]) =>
    <li key={pattern}><code>{pattern}</code> · {effectText(effect)}</li>);
  const details = <div className="space-y-2 break-words">
    {Array.from(servers, id => {
      const remote = Object.hasOwn(preview.remoteMcp, id) ? preview.remoteMcp[id] : undefined;
      const server = Object.hasOwn(preview.permissions.mcpServers, id) ? preview.permissions.mcpServers[id] : undefined;
      const direct = Object.hasOwn(preview.mcpDirectTools, id) ? preview.mcpDirectTools[id] : [];
      return <section key={id} className="space-y-0.5">
        <p className="!m-0 font-medium">{id}</p>
        {remote && <>
          <p className="!m-0 break-all font-mono">{remote.url}</p>
          <p className="!m-0">{t("agsdl.launch.mcp.allowedAddresses", { scope: t("agsdl.launch.mcp.scope." + remote.addressScope) })}</p>
          <p className="!m-0 text-muted-foreground">{t("agsdl.launch.mcp.remoteHint")}</p>
          {Object.entries(remote.delivery).map(([name, header]) =>
            <p key={name} className="!m-0">{t("agsdl.launch.mcp.delivery", { name, header })}</p>)}
        </>}
        {server?.transport.type === "local" && <>
          <p className="!m-0 font-mono">{JSON.stringify(server.transport.command)}</p>
          {server.packagedFiles.length > 0 && <p className="!m-0">{t("agsdl.launch.mcp.files", { names: server.packagedFiles.join(", ") })}</p>}
          {server.requiredSecrets.length > 0 && <p className="!m-0">{t("agsdl.launch.mcp.environment", { names: server.requiredSecrets.join(", ") })}</p>}
        </>}
        {direct.length > 0 && <p className="!m-0">{t("agsdl.launch.mcp.direct", { names: direct.join(", ") })}</p>}
      </section>;
    })}
    {agents.map(({ name, equipment }) => <section key={name} className="space-y-0.5">
      <p className="!m-0 font-medium">{name}</p>
      {equipment.map(([server, access]) => {
        const hasPatterns = Object.keys(access.agentPatterns).length > 0 || Object.keys(access.hostPatterns).length > 0;
        return <div key={server} className="pl-2">
          <p className="!m-0">{server}{!access.equipped && <> · {t("agsdl.launch.mcp.skipped")}</>}
            {access.equipped && !hasPatterns && <> · {t("agsdl.launch.mcp.otherTools", { effect: effectText(access.default) })}</>}</p>
          {access.equipped && (hasPatterns
            ? <div className="pl-2">
              <p className="!m-0 text-muted-foreground">{t("agsdl.launch.mcp.patternHint")}</p>
              <p className="!m-0">{t("agsdl.launch.mcp.agentRules", { effect: effectText(access.agentDefault) })}</p>
              <ul>{rules(access.agentPatterns)}</ul>
              <p className="!m-0">{t("agsdl.launch.mcp.hostRules", { effect: effectText(access.hostDefault) })}</p>
              <ul>{rules(access.hostPatterns)}</ul>
            </div>
            : <ul className="pl-2">{rules(access.tools)}</ul>)}
        </div>;
      })}
    </section>)}
  </div>;
  return expanded
    ? <section aria-label={title}><h4 className="mb-1 text-[11px] font-medium text-muted-foreground">{title}</h4>{details}</section>
    : <details className="agsdl-details"><DisclosureSummary>{title}</DisclosureSummary>{details}</details>;
}
