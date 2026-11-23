import { expect, it } from "bun:test";
import { groupProjectFiles, projectFileGroup, projectInventory } from "./projectInventory";

const system = (extra: Record<string, unknown> = {}) => JSON.stringify({
  contract: "agsdl-0.4.0", id: "review",
  agents: {
    reviewer: { harness: "codex", permissions: "read-only", instructions: "Review.", skills: ["style"], mcpServers: ["github"] },
    writer: { harness: "codex", permissions: "workspace", instructions: "Write.", skills: ["style"] },
    spare: { harness: "codex", permissions: "read-only", instructions: "Unused." },
  },
  skills: { style: { uri: "skills/style" }, lonely: { uri: "skills/lonely" } },
  mcpServers: { github: { command: ["node", "github.js"] }, docs: { url: "https://docs.example.test/mcp" } },
  flow: { entry: "write", steps: {
    write: { type: "agent", agent: "writer", next: "review" },
    review: { type: "agent", agent: "reviewer" },
  } },
  ...extra,
});

it("reads usage and counts from the assembled document, never the command lines", () => {
  const inventory = projectInventory(system())!;
  expect(inventory.counts).toEqual({ agents: 3, skills: 2, tools: 2 });
  expect([...inventory.agentsInFlow!].sort()).toEqual(["reviewer", "writer"]);
  expect(inventory.skillUsers.get("style")).toEqual(["reviewer", "writer"]);
  expect(inventory.skillUsers.has("lonely")).toBe(false);
  expect(inventory.toolUsers.get("github")).toEqual(["reviewer"]);
  expect(inventory.toolTransport.get("github")).toBe("local");
  expect(inventory.toolTransport.get("docs")).toBe("remote");
});

it("counts agents of compositions as used and reports no flow as unknown usage", () => {
  const composed = projectInventory(system({ compositions: { check: { steps: { one: { type: "agent", agent: "spare" } } } } }))!;
  expect(composed.agentsInFlow!.has("spare")).toBe(true);
  const document = JSON.parse(system());
  delete document.flow;
  expect(projectInventory(JSON.stringify(document))!.agentsInFlow).toBeNull();
});

it("returns null for unreadable sources instead of throwing", () => {
  expect(projectInventory("not json")).toBeNull();
});

it("groups files by their first folder in a fixed order and keeps unknown files together", () => {
  expect(projectFileGroup("agents/a.json")).toBe("agents");
  expect(projectFileGroup("flows/main.json")).toBe("flow");
  expect(projectFileGroup("mcp/server/run.js")).toBe("tools");
  expect(projectFileGroup("agsdl.json")).toBe("other");
  expect(projectFileGroup("notes/readme.md")).toBe("other");
  const file = (path: string) => ({ path, size: 1, executable: false });
  const groups = groupProjectFiles([file("skills/s/SKILL.md"), file("agsdl.json"), file("agents/b.json"), file("agents/a.json"), file("mcp/x.js")]);
  expect(groups.map(group => group.group)).toEqual(["agents", "skills", "tools", "other"]);
  expect(groups[0].files.map(entry => entry.path)).toEqual(["agents/a.json", "agents/b.json"]);
});
