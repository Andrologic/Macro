import { Info } from "lucide-react";
import type { LaunchPreview } from "../../../services/ipc/architectLaunch";
import { DisclosureSummary } from "../../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../../agsdl/useAgsdlTranslation";
import { InfoBlock } from "../../architect/ArchitectDialogShell";
import { PermissionSummary } from "../../architect/PermissionSummary";
import { Icon } from "../../ui/Icon";
import { LaunchMcpDetails, mcpServersInUse } from "./LaunchMcpDetails";
import { interpreterEnvironment } from "./launchModel";

/**
 * What the system will be able to do, asked once per version and again only when permissions grow.
 * The same summary as the import preview says it; this step adds what only a launch knows:
 * the checks Macro runs on its own, and what the approval does not cover.
 */
export function LaunchConsent({ preview }: { preview: LaunchPreview }) {
  const { t } = useAgsdlTranslation();
  const { permissions } = preview;
  const reachable = Object.entries(permissions.agents).filter(([, agent]) => agent.usage === "reachable");
  const checks = reachable.filter(([, agent]) => agent.completionCheck);
  const usedServers = mcpServersInUse(preview);
  const localToolsInUse = [...usedServers].some(id => permissions.mcpServers[id]?.transport.type === "local");
  const effective: typeof permissions = {
    ...permissions,
    agents: Object.fromEntries(Object.entries(permissions.agents)
      .map(([id, agent]) => [id, { ...agent, mcpServers: agent.mcpServers.filter(server => preview.agentMcp[id]?.[server]?.equipped) }])),
    mcpServers: Object.fromEntries(Object.entries(permissions.mcpServers).filter(([id]) => usedServers.has(id))),
    directCalls: permissions.directCalls.flatMap(call => {
      if (call.target.type === "shell") return [call];
      const { server, tool } = call.target;
      return Object.hasOwn(preview.mcpDirectTools, server) && preview.mcpDirectTools[server].includes(tool)
        ? [{ ...call, usage: "reachable" }]
        : [];
    }),
  };
  const interpreterSecrets = preview.secrets.filter(secret =>
    permissions.mcpServers[secret.server]?.transport.type === "local" && interpreterEnvironment.has(secret.name));
  const addresses = permissions.externalReferences.filter(reference => reference.kind !== "mcpEndpoint" && reference.usage !== "declaredOnly");
  return <div className="space-y-3">
    <InfoBlock icon={<Info size={13} />}><p className="!m-0">{t("agsdl.launch.consentIntro")}</p></InfoBlock>
    <PermissionSummary source={effective} sections={["permissions", "engines"]} />
    <LaunchMcpDetails preview={preview} expanded />
    {checks.length > 0 && <section aria-label={t("agsdl.launch.checksTitle")}>
      <h4 className="mb-1 text-[11px] font-medium text-muted-foreground">{t("agsdl.launch.checksTitle")}</h4>
      <ul className="space-y-2">{checks.map(([id, agent]) => <li key={id} className="space-y-0.5">
        <p className="!m-0 font-medium">{id}</p>
        <p className="!m-0">
          {agent.completionCheckChoices?.length
            ? t("agsdl.launch.completionCheckChoices", { choices: agent.completionCheckChoices.join(", ") })
            : t("agsdl.launch.completionCheck")}
          {agent.completionCheckMaxFailures && <> {t("agsdl.launch.completionCheckMaxFailures", { limit: agent.completionCheckMaxFailures })}</>}
        </p>
        <code className="block whitespace-pre-wrap break-words rounded bg-muted/60 px-2 py-1 text-[11px]">{agent.completionCheck}</code>
      </li>)}</ul>
    </section>}
    {addresses.length > 0 && <section aria-label={t("agsdl.launch.addressesTitle")}>
      <h4 className="mb-1 text-[11px] font-medium text-muted-foreground">{t("agsdl.launch.addressesTitle")}</h4>
      <ul className="space-y-0.5">{addresses.map((reference, index) =>
        <li key={index} className="break-all font-mono text-[11px]">{reference.uri}</li>)}</ul>
    </section>}
    {interpreterSecrets.map(secret => <p key={JSON.stringify([secret.server, secret.name])}
      className="!m-0 flex items-start gap-2 text-amber-500">
      <Icon name="triangle-alert" size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{t("agsdl.launch.mcpInterpreterSecret", { server: secret.server, name: secret.name })}</span>
    </p>)}
    {localToolsInUse && <InfoBlock icon={<Info size={13} />}><p className="!m-0">{t("agsdl.launch.mcpConsentScope")}</p></InfoBlock>}
    {reachable.length > 0 && <details className="agsdl-details">
      <DisclosureSummary>{t("agsdl.launch.permissionDetails")}</DisclosureSummary>
      <ul className="space-y-2 text-[11px]">{reachable.map(([id, agent]) => <li key={id}>
        <p className="!m-0 font-medium">{id} · {t(`agsdl.launch.preset.${agent.permissions.preset ?? "read-only"}`, { defaultValue: agent.permissions.preset ?? "" })}</p>
        <pre className="!m-0 whitespace-pre-wrap break-words font-mono">{JSON.stringify(agent.permissions, null, 2)}</pre>
      </li>)}</ul>
    </details>}
  </div>;
}
