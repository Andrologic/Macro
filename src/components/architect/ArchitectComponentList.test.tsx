import { afterEach, expect, it } from "bun:test";
import type { ProjectInventory } from "../../services/agsdl/projectInventory";
import type { ViewerCard } from "../../services/agsdl/viewer";
import { ArchitectComponentList } from "./ArchitectComponentList";
import { click, createHost } from "./architectLibrary.testSupport";

let view: ReturnType<typeof createHost>;
afterEach(() => view?.unmount());

const card = (kind: string, id: string, extra: Partial<ViewerCard> = {}): ViewerCard => ({
  path: `/${id}`, id, title: id, kind, mission: "", unresolved: false, inputs: [], outputs: [], branches: [], details: {}, ...extra,
});
const inventory = (): ProjectInventory => ({
  counts: { agents: 3, skills: 2, tools: 2 },
  agentsInFlow: new Set(["writer"]),
  skillUsers: new Map([["style", ["writer", "reviewer"]], ["glossary", ["writer"]]]),
  toolUsers: new Map([["github", ["reviewer"]]]),
  toolTransport: new Map([["github", "local" as const], ["docs", "remote" as const]]),
});
const mount = async (kind: "agents" | "skills" | "tools", cards: ViewerCard[], hidden: string[] = [], onSelect = (_path: string) => {}) => {
  view = createHost();
  await view.render(<ArchitectComponentList kind={kind} cards={cards} inventory={inventory()} hiddenAgents={hidden} onSelect={onSelect} />);
  return view.host;
};

it("shows each agent on one line: the author's description first, else the start of its work", async () => {
  const host = await mount("agents", [
    card("Agent", "writer", { mission: "A very long mission\nover several lines", details: { description: "Writes the fix" } }),
    card("Agent", "reviewer", { mission: "Reads\nthe change" }),
    card("Skill", "style"),
  ]);
  const rows = [...host.querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Writes the fix");
  expect(rows[0].textContent).not.toContain("A very long mission");
  expect(rows[1].textContent).toContain("Reads the change");
  expect(rows[1].querySelector(".line-clamp-1")).not.toBeNull();
});

it("tells which agents the flow uses and which it never reaches, by words", async () => {
  const host = await mount("agents", [card("Agent", "writer"), card("Agent", "spare")]);
  const rows = [...host.querySelectorAll("li")].map(row => row.textContent);
  expect(rows[0]).toContain("used in the flow");
  expect(rows[1]).toContain("not used");
});

it("marks an agent hidden in Operate with an icon and a spoken word", async () => {
  const host = await mount("agents", [card("Agent", "writer"), card("Agent", "reviewer")], ["writer"]);
  const [first, second] = [...host.querySelectorAll("li")];
  expect(first.querySelector("svg")).not.toBeNull();
  expect(first.querySelector(".sr-only")?.textContent).toBe("Hidden in Operate");
  expect(second.querySelector(".sr-only")).toBeNull();
});

it("shows how many agents use a skill, or that it is unused", async () => {
  const host = await mount("skills", [card("Skill", "style"), card("Skill", "glossary"), card("Skill", "lonely")]);
  const rows = [...host.querySelectorAll("li")].map(row => row.textContent);
  expect(rows[0]).toContain("used by 2 agents");
  expect(rows[1]).toContain("used by 1 agent");
  expect(rows[1]).not.toContain("agents");
  expect(rows[2]).toContain("not used");
});

it("shows whether a tool server is local or remote, never its command", async () => {
  const host = await mount("tools", [card("McpServer", "github", { details: { command: ["node", "github.js"] } }), card("McpServer", "docs")]);
  const rows = [...host.querySelectorAll("li")].map(row => row.textContent);
  expect(rows[0]).toContain("local");
  expect(rows[1]).toContain("remote");
  expect(host.textContent).not.toContain("github.js");
});

it("opens the item's card on click and says plainly when there is none", async () => {
  const selected: string[] = [];
  const host = await mount("agents", [card("Agent", "writer")], [], path => selected.push(path));
  await click(host.querySelector("li button"));
  expect(selected).toEqual(["/writer"]);
  view.unmount();
  const empty = await mount("tools", []);
  expect(empty.textContent).toContain("This system uses no tool server.");
});
