import type { ImportPreview } from "../ipc/architectLibrary";

/** The part of a typed preview the permission summary reads. The launch step passes the same shape. */
export type PermissionSource = Pick<ImportPreview, "agents" | "directCalls" | "mcpServers" | "externalReferences" | "warnings">;

export type CapabilityId =
  | "readFiles" | "readOutside" | "writeFiles" | "writeFolders" | "writeAnywhere"
  | "runCommands" | "runCommand" | "network" | "useTool";

export interface Capability {
  id: CapabilityId;
  /** Elevated lines are drawn with the warning colour, never by colour alone: they carry an icon. */
  elevated: boolean;
  /** A command, a tool name or a folder count, depending on the id. */
  subject?: string;
  remote?: boolean;
}

export interface SecretRequest { name: string; server: string; requested: boolean }
export interface PermissionSummaryModel {
  capabilities: Capability[];
  engines: Array<{ harness: string; model: string | null }>;
  secrets: SecretRequest[];
  /** Programs a local tool starts. Checked at launch, never installed. */
  programs: string[];
  externalContent: number;
  launchBlockers: number;
  /** Agents the flow cannot reach: only the details mention them. */
  inactiveAgents: string[];
}

const COMMAND_LIMIT = 80;
const active = (usage: string) => usage !== "declaredOnly";

export function summarizePermissions(source: PermissionSource): PermissionSummaryModel {
  const agents = Object.entries(source.agents);
  const used = agents.filter(([, agent]) => active(agent.usage));
  const found = new Map<string, Capability>();
  const add = (capability: Capability) => { if (!found.has(`${capability.id}:${capability.subject ?? ""}`)) found.set(`${capability.id}:${capability.subject ?? ""}`, capability); };

  let extraFolders = 0;
  for (const [, { permissions }] of used) {
    const preset = permissions.preset;
    const allows = (action: string) => permissions.rules.some(rule => rule.action === action && rule.effect === "allow");
    if (preset) add({ id: "readFiles", elevated: false });
    if (preset === "workspace" || preset === "full") add({ id: "writeFiles", elevated: false });
    if (preset === "full") add({ id: "writeAnywhere", elevated: true });
    if (permissions.outside === "read" || preset === "full") add({ id: "readOutside", elevated: true });
    extraFolders += Object.values(permissions.directories).filter(access => access === "write").length;
    if (preset === "workspace" || preset === "full" || allows("shell")) add({ id: "runCommands", elevated: true });
    if (preset === "full" || allows("network")) add({ id: "network", elevated: true });
  }
  if (extraFolders) add({ id: "writeFolders", elevated: true, subject: String(extraFolders) });

  for (const call of source.directCalls.filter(call => active(call.usage))) {
    if (call.target.type === "shell") {
      const command = call.target.command.length > COMMAND_LIMIT ? `${call.target.command.slice(0, COMMAND_LIMIT)}…` : call.target.command;
      add({ id: "runCommand", elevated: true, subject: command });
    }
  }

  const usedServers = new Set<string>();
  for (const [, agent] of used) for (const server of agent.mcpServers) usedServers.add(server);
  for (const call of source.directCalls.filter(call => active(call.usage)))
    if (call.target.type === "mcp") usedServers.add(call.target.server);
  for (const server of [...usedServers].sort())
    add({ id: "useTool", elevated: false, subject: server, remote: source.mcpServers[server]?.transport.type === "remote" });

  const engines = new Map<string, { harness: string; model: string | null }>();
  for (const [, agent] of used) {
    const model = agent.model?.name ?? null;
    engines.set(`${agent.harness}\0${model}`, { harness: agent.harness, model });
  }

  const secrets = Object.entries(source.mcpServers).flatMap(([server, entry]) =>
    entry.requiredSecrets.map(name => ({ name, server, requested: active(entry.usage) })));
  const programs = [...new Set(Object.values(source.mcpServers)
    .filter(entry => active(entry.usage) && entry.transport.type === "local")
    .flatMap(entry => entry.transport.type === "local" && entry.transport.command[0]
      && !entry.packagedFiles.includes(entry.transport.command[0]) && !entry.transport.command[0].startsWith(".")
      ? [entry.transport.command[0]] : []))].sort();

  return {
    capabilities: [...found.values()],
    engines: [...engines.values()],
    secrets: secrets.sort((a, b) => a.name.localeCompare(b.name)),
    programs,
    externalContent: source.externalReferences.filter(ref => ref.kind !== "mcpEndpoint" && active(ref.usage)).length,
    launchBlockers: source.warnings.filter(warning => warning.launchBlocker).length,
    inactiveAgents: agents.filter(([, agent]) => !active(agent.usage)).map(([id]) => id),
  };
}
