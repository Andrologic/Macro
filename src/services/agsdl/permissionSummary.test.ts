import { expect, it } from "bun:test";
import type { ImportPreview } from "../ipc/architectLibrary";
import { summarizePermissions, type PermissionSource } from "./permissionSummary";

type Agent = ImportPreview["agents"][string];
const agent = (permissions: Partial<Agent["permissions"]>, extra: Partial<Agent> = {}): Agent => ({
  usage: "reachable", harness: "codex", harnessVersion: null, model: null, mcpServers: [], completionCheck: null,
  permissions: { preset: null, directories: {}, outside: null, reviewer: null, rules: [], ...permissions }, ...extra,
});
const source = (overrides: Partial<PermissionSource> = {}): PermissionSource => ({
  agents: {}, directCalls: [], mcpServers: {}, externalReferences: [], warnings: [], ...overrides,
});
const ids = (model: ReturnType<typeof summarizePermissions>) => model.capabilities.map(capability => capability.id);

it("a read-only system can only read in its execution folder", () => {
  const model = summarizePermissions(source({ agents: { a: agent({ preset: "read-only" }) } }));
  expect(ids(model)).toEqual(["readFiles"]);
  expect(model.capabilities.some(capability => capability.elevated)).toBe(false);
});

it("workspace adds writing and commands, and flags commands as elevated", () => {
  const model = summarizePermissions(source({ agents: { a: agent({ preset: "workspace" }) } }));
  expect(ids(model)).toEqual(["readFiles", "writeFiles", "runCommands"]);
  expect(model.capabilities.find(capability => capability.id === "runCommands")?.elevated).toBe(true);
});

it("full permission reaches outside the folder and the network, all elevated", () => {
  const model = summarizePermissions(source({ agents: { a: agent({ preset: "full" }) } }));
  expect(ids(model)).toEqual(expect.arrayContaining(["writeAnywhere", "readOutside", "network", "runCommands"]));
  expect(model.capabilities.filter(capability => capability.elevated).length).toBe(4);
});

it("rules and extra folders widen a preset, and unreachable agents add nothing", () => {
  const model = summarizePermissions(source({ agents: {
    a: agent({ preset: "read-only", outside: "read", directories: { "../out": "write", "../in": "read" },
      rules: [{ action: "network", match: "*.example.test", effect: "allow" }, { action: "shell", match: null, effect: "deny" }] }),
    ghost: agent({ preset: "full" }, { usage: "declaredOnly" }),
  } }));
  expect(ids(model)).toEqual(expect.arrayContaining(["readOutside", "network", "writeFolders"]));
  expect(ids(model)).not.toContain("runCommands");
  expect(ids(model)).not.toContain("writeAnywhere");
  expect(model.capabilities.find(capability => capability.id === "writeFolders")?.subject).toBe("1");
  expect(model.inactiveAgents).toEqual(["ghost"]);
});

it("lists the tools agents and direct calls use, once each, and bounds a long command", () => {
  const long = "x".repeat(200);
  const model = summarizePermissions(source({
    agents: { a: agent({ preset: "workspace" }, { mcpServers: ["github", "docs"] }), b: agent({ preset: "workspace" }, { mcpServers: ["github"] }) },
    mcpServers: {
      github: { usage: "reachable", transport: { type: "local", command: ["node", "gh.js"] }, packagedFiles: ["gh.js"], requiredSecrets: ["GITHUB_TOKEN"] },
      docs: { usage: "reachable", transport: { type: "remote", url: "https://docs.example.test" }, packagedFiles: [], requiredSecrets: [] },
    },
    directCalls: [
      { location: { file: "agsdl.json", pointer: "/flow/steps/a" }, usage: "reachable", target: { type: "shell", command: long } },
      { location: { file: "agsdl.json", pointer: "/flow/steps/b" }, usage: "declaredOnly", target: { type: "shell", command: "rm -rf /" } },
    ],
  }));
  const tools = model.capabilities.filter(capability => capability.id === "useTool");
  expect(tools.map(tool => [tool.subject, tool.remote])).toEqual([["docs", true], ["github", false]]);
  const command = model.capabilities.find(capability => capability.id === "runCommand")!;
  expect(command.subject!.length).toBe(81);
  expect(model.capabilities.filter(capability => capability.id === "runCommand")).toHaveLength(1);
});

it("asks only for programs and secrets of tools the flow can use, by name", () => {
  const model = summarizePermissions(source({
    mcpServers: {
      github: { usage: "reachable", transport: { type: "local", command: ["node", "gh.js"] }, packagedFiles: ["gh.js"], requiredSecrets: ["GITHUB_TOKEN"] },
      local: { usage: "reachable", transport: { type: "local", command: ["./run.sh"] }, packagedFiles: ["run.sh"], requiredSecrets: [] },
      packaged: { usage: "unknown", transport: { type: "local", command: ["run.py"] }, packagedFiles: ["run.py"], requiredSecrets: [] },
      idle: { usage: "declaredOnly", transport: { type: "local", command: ["uvx", "idle"] }, packagedFiles: [], requiredSecrets: ["IDLE_KEY"] },
    },
    externalReferences: [
      { uri: "https://example.test/a.md", kind: "content", usage: "reachable", location: { file: "agsdl.json", pointer: "/content/a" } },
      { uri: "https://example.test/mcp", kind: "mcpEndpoint", usage: "reachable", location: { file: "agsdl.json", pointer: "/mcpServers/x/url" } },
      { uri: "https://example.test/old.md", kind: "content", usage: "declaredOnly", location: { file: "agsdl.json", pointer: "/content/old" } },
    ],
    warnings: [
      { code: "EXTERNAL_SKILL", message: "m", launchBlocker: true, location: { file: "agsdl.json", pointer: "/skills/s" } },
      { code: "OTHER", message: "m", launchBlocker: false, location: { file: "agsdl.json", pointer: "" } },
    ],
  }));
  expect(model.secrets).toEqual([
    { name: "GITHUB_TOKEN", server: "github", requested: true },
    { name: "IDLE_KEY", server: "idle", requested: false },
  ]);
  expect(model.programs).toEqual(["node"]);
  expect(model.externalContent).toBe(1);
  expect(model.launchBlockers).toBe(1);
});

it("lists each engine and model once", () => {
  const model = summarizePermissions(source({ agents: {
    a: agent({ preset: "read-only" }, { harness: "codex", model: { name: "gpt-x", effort: null } }),
    b: agent({ preset: "read-only" }, { harness: "codex", model: { name: "gpt-x", effort: "high" } }),
    c: agent({ preset: "read-only" }, { harness: "claude-code" }),
  } }));
  expect(model.engines).toEqual([{ harness: "codex", model: "gpt-x" }, { harness: "claude-code", model: null }]);
});
