import type { ProjectFileEntry } from "../ipc/architectLibrary";
import { MAX_AGSDL_PROJECTION_BYTES, list, object, scanSource, text } from "./document";

/** What the Agents, Skills and Tools views add to the viewer cards. Read from the assembled document only. */
export interface ProjectInventory {
  counts: { agents: number; skills: number; tools: number };
  /** Agent ids used by a step of the flow or of a composition. Null when the system has no flow. */
  agentsInFlow: ReadonlySet<string> | null;
  /** Skill id → agent ids. */
  skillUsers: ReadonlyMap<string, string[]>;
  /** Tool (MCP server) id → agent ids. */
  toolUsers: ReadonlyMap<string, string[]>;
  /** Tool id → how it is reached. Never the command line itself. */
  toolTransport: ReadonlyMap<string, "local" | "remote">;
}

const names = (value: unknown) => list(value).filter((item): item is string => typeof item === "string");

export function projectInventory(source: string): ProjectInventory | null {
  let document: Record<string, unknown>;
  try { document = object(scanSource(source, MAX_AGSDL_PROJECTION_BYTES).tree); }
  catch { return null; }
  const inFlow = new Set<string>();
  const scopes = [document.flow, ...Object.values(object(document.compositions))];
  for (const scope of scopes) {
    for (const step of Object.values(object(object(scope).steps))) {
      const agent = object(step).agent;
      if (object(step).type === "agent" && typeof agent === "string") inFlow.add(agent);
    }
  }
  const skillUsers = new Map<string, string[]>();
  const toolUsers = new Map<string, string[]>();
  for (const [id, agent] of Object.entries(object(document.agents))) {
    for (const skill of names(object(agent).skills)) skillUsers.set(skill, [...skillUsers.get(skill) ?? [], id]);
    for (const tool of names(object(agent).mcpServers)) toolUsers.set(tool, [...toolUsers.get(tool) ?? [], id]);
  }
  const toolTransport = new Map(Object.entries(object(document.mcpServers))
    .map(([id, server]) => [id, text(object(server).url) ? "remote" as const : "local" as const]));
  return {
    counts: {
      agents: Object.keys(object(document.agents)).length,
      skills: Object.keys(object(document.skills)).length,
      tools: Object.keys(object(document.mcpServers)).length,
    },
    agentsInFlow: document.flow === undefined ? null : inFlow,
    skillUsers, toolUsers, toolTransport,
  };
}

export type ProjectFileGroup = "agents" | "flow" | "skills" | "tools" | "other";
export const projectFileGroups: readonly ProjectFileGroup[] = ["agents", "flow", "skills", "tools", "other"];

const folderGroups: Record<string, ProjectFileGroup> = {
  agents: "agents", flows: "flow", flow: "flow", skills: "skills", mcp: "tools",
};

/** Group by the first folder of the portable path. Anything unrecognised is "other". */
export function projectFileGroup(path: string): ProjectFileGroup {
  const slash = path.indexOf("/");
  return slash < 0 ? "other" : folderGroups[path.slice(0, slash)] ?? "other";
}

export function groupProjectFiles(files: readonly ProjectFileEntry[]) {
  const grouped = new Map<ProjectFileGroup, ProjectFileEntry[]>();
  for (const file of files) {
    const group = projectFileGroup(file.path);
    grouped.set(group, [...grouped.get(group) ?? [], file]);
  }
  return projectFileGroups.flatMap(group => grouped.has(group)
    ? [{ group, files: grouped.get(group)!.slice().sort((a, b) => a.path.localeCompare(b.path)) }] : []);
}
