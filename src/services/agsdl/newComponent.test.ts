import { describe, expect, it } from "bun:test";
import { applyChanges } from "./document";
import { componentId, emptyNewComponent, planNewComponent, usedComponentIds, validateNewComponent } from "./newComponent";

const blank = JSON.stringify({ contract: "agsdl-0.4.0", id: "demo", title: "Demo" });
const withAgent = JSON.stringify({ contract: "agsdl-0.4.0", id: "demo", agents: { relecteur: { harness: "codex", permissions: "read-only" } } });
const form = (patch: Partial<typeof emptyNewComponent>) => ({ ...emptyNewComponent, ...patch });

describe("component identifiers", () => {
  it("turns a name into a readable identifier", () => {
    expect(componentId("Relecteur de sécurité")).toBe("relecteur-de-securite");
    expect(componentId("  Revue—finale! ")).toBe("revue-finale");
    expect(componentId("2e passe")).toBe("item-2e-passe");
    expect(componentId("???")).toBe("");
    expect(componentId("a".repeat(100))).toHaveLength(64);
  });
});

describe("new component validation", () => {
  const used = new Set(["relecteur"]);
  it("asks for a name, a usable name and an unused name", () => {
    expect(validateNewComponent("agent", form({ name: " " }), used)).toEqual({ field: "name", key: "empty" });
    expect(validateNewComponent("agent", form({ name: "???" }), used)).toEqual({ field: "name", key: "invalid" });
    expect(validateNewComponent("agent", form({ name: "Relecteur" }), used)).toEqual({ field: "name", key: "taken" });
    expect(validateNewComponent("agent", form({ name: "Rapporteur" }), used)).toBeUndefined();
  });
  it("requires a description for a skill", () => {
    expect(validateNewComponent("skill", form({ name: "Style" }), used)).toEqual({ field: "description", key: "empty" });
    expect(validateNewComponent("skill", form({ name: "Style", description: "Écrire sobrement" }), used)).toBeUndefined();
  });
  it("checks a tool address for its transport", () => {
    const tool = (patch: Partial<typeof emptyNewComponent>) => validateNewComponent("tool", form({ name: "Docs", ...patch }), used);
    expect(tool({})).toEqual({ field: "address", key: "empty" });
    expect(tool({ address: "docs.example.test" })).toEqual({ field: "address", key: "url" });
    expect(tool({ address: "ftp://docs.example.test" })).toEqual({ field: "address", key: "url" });
    expect(tool({ address: "https://docs.example.test/mcp" })).toBeUndefined();
    expect(tool({ transport: "local", address: 'node "a b.js"' })).toEqual({ field: "address", key: "command" });
    expect(tool({ transport: "local", address: "node server.js --quiet" })).toBeUndefined();
  });
  it("reads the used identifiers of the right catalog", () => {
    expect(usedComponentIds(withAgent, "agent")).toEqual(new Set(["relecteur"]));
    expect(usedComponentIds(withAgent, "skill")).toEqual(new Set());
    expect(usedComponentIds("not json", "agent")).toEqual(new Set());
  });
});

describe("new component plan", () => {
  it("writes an agent file and declares it, without touching the flow", () => {
    const plan = planNewComponent("agent", form({ name: "Relecteur", description: "Relit le travail", instructions: "Signale ce qui manque." }), blank, true);
    expect(plan.id).toBe("relecteur");
    expect(plan.files).toEqual([{ kind: "write", path: "agents/relecteur.json", text: expect.stringContaining('"permissions": "read-only"') }]);
    const file = JSON.parse((plan.files[0] as { text: string }).text);
    expect(file).toEqual({ harness: "codex", permissions: "read-only", description: "Relit le travail", instructions: "Signale ce qui manque." });
    const next = JSON.parse(applyChanges(blank, plan.changes));
    expect(next.agents).toEqual({ relecteur: { file: "agents/relecteur.json" } });
    expect(next.flow).toBeUndefined();
  });
  it("adds to an existing catalog", () => {
    const plan = planNewComponent("agent", form({ name: "Rapporteur", harness: "claude-code", access: "workspace" }), withAgent, true);
    expect(Object.keys(JSON.parse(applyChanges(withAgent, plan.changes)).agents)).toEqual(["relecteur", "rapporteur"]);
    expect(JSON.parse((plan.files[0] as { text: string }).text)).toEqual({ harness: "claude-code", permissions: "workspace" });
  });
  it("declares an agent inline for a document without project files", () => {
    const plan = planNewComponent("agent", form({ name: "Rapporteur" }), blank, false);
    expect(plan.files).toEqual([]);
    expect(JSON.parse(applyChanges(blank, plan.changes)).agents).toEqual({ rapporteur: { harness: "codex", permissions: "read-only" } });
  });
  it("writes a skill with the header harnesses read", () => {
    const plan = planNewComponent("skill", form({ name: "Style", description: "Écrire\nsobrement", instructions: "Phrases courtes." }), blank, true);
    expect(plan.files).toEqual([{ kind: "write", path: "skills/style/SKILL.md", text: '---\nname: style\ndescription: "Écrire sobrement"\n---\n\nPhrases courtes.\n' }]);
    expect(JSON.parse(applyChanges(blank, plan.changes)).skills).toEqual({ style: { uri: "skills/style/SKILL.md" } });
  });
  it("declares a remote or local tool without files", () => {
    const remote = planNewComponent("tool", form({ name: "Docs", address: " https://docs.example.test/mcp " }), blank, true);
    expect(remote.files).toEqual([]);
    expect(JSON.parse(applyChanges(blank, remote.changes)).mcpServers).toEqual({ docs: { url: "https://docs.example.test/mcp" } });
    const local = planNewComponent("tool", form({ name: "Github", transport: "local", address: "node  github.js --quiet" }), blank, true);
    expect(JSON.parse(applyChanges(blank, local.changes)).mcpServers).toEqual({ github: { command: ["node", "github.js", "--quiet"] } });
  });
});
