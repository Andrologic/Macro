import { useId, useState, type ReactNode } from "react";
import type { LaunchPreview, McpAddressScope, McpSecretDelivery, McpToolEffect, RemoteMcpSettings } from "../../../services/ipc/architectLaunch";
import { DisclosureSummary } from "../../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../../agsdl/useAgsdlTranslation";

import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { selectClass, unusedServerReason } from "./launchModel";

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
      <span className="block break-words" id={id}>{t("agsdl.launch.mcp.sendAs", { name })}</span>
      <Select fullWidth={false} className={selectClass} aria-labelledby={id} value={type}
        onChange={event => setType(event.target.value === "bearer" ? "bearer" : "header")}>
        <option value="bearer">{t("agsdl.launch.mcp.bearer")}</option>
        <option value="header">{t("agsdl.launch.mcp.header")}</option>
      </Select>
    </label>
    {type === "header" && <Input className="!h-7 min-w-24 flex-1 font-mono text-xs" autoComplete="off" spellCheck={false}
      aria-label={t("agsdl.launch.mcp.headerName", { name })} placeholder={t("agsdl.launch.mcp.headerPlaceholder")} value={header} required onChange={event => setHeader(event.target.value)} />}
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
        <span className="font-medium">{t("agsdl.launch.mcp.addressScope")}</span>
        <Select fullWidth={false} className={selectClass} value={setup.addressScope} onChange={event => {
          const addressScope = addressScopes.find(scope => scope === event.target.value);
          if (addressScope) onChange(server, setup.url, { delivery: {}, ...settings, addressScope });
        }}>
          {addressScopes.map(scope => <option key={scope} value={scope}>{t("agsdl.launch.mcp.scope." + scope)}</option>)}
        </Select>
      </label>
      <p className="!m-0 text-[11px] text-muted-foreground">{t("agsdl.launch.mcp.scopeHelp")}</p>
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

/** Servers the system declares but this run does not connect, with the reason in plain words and the detail on demand. */
export function LaunchMcpNotes({ preview }: { preview: LaunchPreview }) {
  const { t } = useAgsdlTranslation();
  if (!preview.mcpNotes.length) return null;
  return <ul className="space-y-1.5 text-muted-foreground">
    {preview.mcpNotes.map(({ server, unsupportedEndpoint }) => {
      if (unsupportedEndpoint) return <li key={server} className="break-words">{t("agsdl.launch.mcp.unusedEndpoint", { server })}</li>;
      const reason = unusedServerReason(preview, server);
      return <li key={server} className="break-words">
        <p className="!m-0">{t(reason.kind === "nobody" ? "agsdl.launch.mcp.unusedNobody" : "agsdl.launch.mcp.unusedNotAllowed", { server })}</p>
        {reason.agents.length > 0 && <details className="agsdl-details !mt-1 !border-0 !pt-0">
          <DisclosureSummary>{t("agsdl.launch.mcp.whyTitle")}</DisclosureSummary>
          <ul className="space-y-0.5">{reason.agents.map(agent => <li key={agent.id}>{t("agsdl.launch.mcp.why." + agent.why, { agent: agent.id, engine: agent.engine })}</li>)}</ul>
          <p className="!m-0 pt-1 text-[11px]">{t("agsdl.launch.mcp.whyHint")}</p>
        </details>}
      </li>;
    })}
  </ul>;
}

const effectIcon: Record<McpToolEffect, { name: "check-circle" | "message-circle-question" | "circle-x"; tone: string }> = {
  allow: { name: "check-circle", tone: "text-emerald-500" },
  ask: { name: "message-circle-question", tone: "text-amber-500" },
  deny: { name: "circle-x", tone: "text-red-500" },
};

/** One tool rule: the effect is carried by an icon and a word, never by colour alone. */
function Effect({ effect, children }: { effect: McpToolEffect; children: ReactNode }) {
  const { t } = useAgsdlTranslation();
  const { name, tone } = effectIcon[effect];
  return <li className="flex items-start gap-2">
    <Icon name={name} size={12} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
    <span className="min-w-0 break-words">{children}<span className="text-muted-foreground"> · {t("agsdl.launch.mcp.effect." + effect)}</span></span>
  </li>;
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
  const rules = (entries: Record<string, McpToolEffect>) => Object.entries(entries).map(([pattern, effect]) =>
    <Effect key={pattern} effect={effect}><code>{pattern}</code></Effect>);
  const details = <div className="space-y-3 break-words">
    {Array.from(servers, id => {
      const remote = Object.hasOwn(preview.remoteMcp, id) ? preview.remoteMcp[id] : undefined;
      const server = Object.hasOwn(preview.permissions.mcpServers, id) ? preview.permissions.mcpServers[id] : undefined;
      const direct = Object.hasOwn(preview.mcpDirectTools, id) ? preview.mcpDirectTools[id] : [];
      return <section key={id} className="space-y-0.5 rounded-md border border-border px-3 py-2">
        <p className="!m-0 font-medium">{id}</p>
        {remote && <>
          <p className="!m-0 break-all font-mono text-[11px]">{remote.url}</p>
          <p className="!m-0">{t("agsdl.launch.mcp.allowedAddresses", { scope: t("agsdl.launch.mcp.scope." + remote.addressScope) })}</p>
          <p className="!m-0 text-[11px] text-muted-foreground">{t("agsdl.launch.mcp.remoteHint")}</p>
          {Object.entries(remote.delivery).map(([name, header]) =>
            <p key={name} className="!m-0">{header === "Authorization: Bearer"
              ? t("agsdl.launch.mcp.deliveryBearer", { name })
              : t("agsdl.launch.mcp.delivery", { name, header })}</p>)}
        </>}
        {server?.transport.type === "local" && <>
          <p className="!m-0 font-mono">{JSON.stringify(server.transport.command)}</p>
          {server.packagedFiles.length > 0 && <p className="!m-0">{t("agsdl.launch.mcp.files", { names: server.packagedFiles.join(", ") })}</p>}
          {server.requiredSecrets.length > 0 && <p className="!m-0">{t("agsdl.launch.mcp.environment", { names: server.requiredSecrets.join(", ") })}</p>}
        </>}
        {direct.length > 0 && <p className="!m-0">{t("agsdl.launch.mcp.direct", { names: direct.join(", ") })}</p>}
      </section>;
    })}
    {agents.map(({ name, equipment }) => <section key={name} className="space-y-1 border-l-2 border-border pl-3">
      <p className="!m-0 font-medium">{name}</p>
      {equipment.map(([server, access]) => {
        const hasPatterns = Object.keys(access.agentPatterns).length > 0 || Object.keys(access.hostPatterns).length > 0;
        return <div key={server} className="space-y-0.5">
          <p className="!m-0 text-muted-foreground">{server}{!access.equipped && <> · {t("agsdl.launch.mcp.skipped")}</>}</p>
          {access.equipped && (hasPatterns
            ? <div className="space-y-0.5">
              <p className="!m-0 text-[11px] text-muted-foreground">{t("agsdl.launch.mcp.patternHint")}</p>
              <p className="!m-0">{t("agsdl.launch.mcp.agentRules", { effect: t("agsdl.launch.mcp.effect." + access.agentDefault) })}</p>
              <ul className="space-y-0.5">{rules(access.agentPatterns)}</ul>
              <p className="!m-0">{t("agsdl.launch.mcp.hostRules", { effect: t("agsdl.launch.mcp.effect." + access.hostDefault) })}</p>
              <ul className="space-y-0.5">{rules(access.hostPatterns)}</ul>
            </div>
            : <ul className="space-y-0.5">
              {rules(access.tools)}
              <Effect effect={access.default}>{t("agsdl.launch.mcp.otherToolsLabel")}</Effect>
            </ul>)}
        </div>;
      })}
    </section>)}
  </div>;
  return expanded
    ? <section aria-label={title}><h4 className="mb-1 text-[11px] font-medium text-muted-foreground">{title}</h4>{details}</section>
    : <details className="agsdl-details"><DisclosureSummary>{title}</DisclosureSummary>{details}</details>;
}
