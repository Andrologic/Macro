import type { LaunchPreview, McpToolEffect } from "../../../services/ipc/architectLaunch";
import { DisclosureSummary } from "../../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../../agsdl/useAgsdlTranslation";

export function LaunchMcpDetails({ preview, expanded = false }: { preview: LaunchPreview; expanded?: boolean }) {
  const { t } = useAgsdlTranslation();
  const agents = Object.entries(preview.agentMcp);
  const calls = preview.permissions.directCalls.flatMap(call =>
    call.usage === "reachable" && call.target.type === "mcp" ? [call.target] : []);
  const servers = new Set([
    ...Object.keys(preview.remoteMcp), ...calls.map(call => call.server),
    ...agents.flatMap(([, equipment]) => Object.keys(equipment).filter(server => equipment[server].equipped)),
  ]);
  if (!servers.size && !agents.length) return null;

  const title = t("agsdl.launch.mcp.title");
  const effectText = (effect: McpToolEffect) => t("agsdl.launch.mcp.effect." + effect);
  const rules = (entries: Record<string, McpToolEffect>) => Object.entries(entries).map(([pattern, effect]) =>
    <li key={pattern}><code>{pattern}</code> · {effectText(effect)}</li>);
  const details = <div className="space-y-2 break-words">
    {Array.from(servers, id => {
      const remote = Object.hasOwn(preview.remoteMcp, id) ? preview.remoteMcp[id] : undefined;
      const server = Object.hasOwn(preview.permissions.mcpServers, id) ? preview.permissions.mcpServers[id] : undefined;
      const direct = [...new Set(calls.filter(call => call.server === id).map(call => call.tool))];
      return <section key={id} className="space-y-0.5">
        <p className="!m-0 font-medium">{id}</p>
        {remote && <>
          <p className="!m-0 break-all font-mono">{remote.url}</p>
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
    {agents.map(([agent, equipment]) => <section key={agent} className="space-y-0.5">
      <p className="!m-0 font-medium">{agent}</p>
      {Object.entries(equipment).map(([server, access]) => {
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
