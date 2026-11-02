import { describe, expect, it } from "bun:test";
import { componentChanges, componentFields } from "./componentFields";
import { run } from "../../vendor/agsdl/browser-reader.mjs";
import { applyChanges } from "./document";
import { createLegacyExample } from "./examples";
import { projectViewer } from "./viewer";

describe("component text edits", () => {
  it("edits only real 0.2 string prompt owners and preserves skill order, media and exact unrelated tokens", () => {
    const source = JSON.stringify({ contract: "agsdl-0.2.0", id: "prompt-edit", agents: {
      first: { configuration: "review", skills: ["shared"], prompt: [{ value: "First instruction" }, { ref: "instruction" }, { uri: "image.png", mediaType: "image/png" }, { value: { structured: true } }] },
      second: { configuration: "review", prompt: [{ ref: "instruction" }] },
    }, skills: { shared: { prompt: [{ value: "Skill instruction" }] } }, content: { instruction: { value: "Shared instruction", mediaType: "text/plain" } },
    configurations: { review: { engine: "engine", settings: { count: "EXACT_NUMBER" } } }, bindings: { engine: { contract: { identity: "example/engine", version: "1" }, implementation: { identity: "example/runtime", version: "1" } } },
    }).replace('"EXACT_NUMBER"', '900719925474099312345');
    const fields = componentFields(source, projectViewer(source).declarations[0]);
    expect(fields.map(field => field.path)).toEqual(["/agents/first/prompt/0/value", "/content/instruction/value"]);
    expect(fields[1].shared).toBe(true);
    const edited = applyChanges(source, componentChanges(fields, ["Updated instruction", "Updated shared instruction"]));
    expect(edited).toContain("900719925474099312345");
    expect(JSON.parse(edited).agents.first.prompt.slice(2)).toEqual(JSON.parse(source).agents.first.prompt.slice(2));
    expect(JSON.parse(edited).skills).toEqual(JSON.parse(source).skills);
    expect(projectViewer(edited).declarations[0].mission).toContain("Skill instruction\n\nUpdated instruction\n\nUpdated shared instruction");
    expect(projectViewer(edited).declarations[1].mission).toBe("Updated shared instruction");
  });
  it("edits a local title and real instruction body without losing opaque values or connections", () => {
    const source = createLegacyExample("release").replace('"extensions": []', '"extensions": [{"opaque": 900719925474099312345}]');
    const original = projectViewer(source).graphs[0];
    const fields = componentFields(source, original.cards[0]);
    expect(fields.map(field => field.kind)).toEqual(["name", "instructions"]);
    const edited = applyChanges(source, componentChanges(fields, ["Nouvelle checklist", "Contrôler les prérequis."]));
    expect(edited).toContain("900719925474099312345");
    const graph = projectViewer(edited).graphs[0];
    expect(graph.cards[0].title).toBe("Nouvelle checklist");
    expect(graph.cards[0].mission).toBe("Contrôler les prérequis.");
    expect(graph.cards[0].branches).toEqual(original.cards[0].branches);
    expect(graph.cards[1].mission).toEqual(original.cards[1].mission);
  });
  it("stores step presentation on its ControlFlow definition and passes validateG after rename", async () => {
    const source = createLegacyExample("release");
    const card = projectViewer(source).graphs[0].cards[0];
    const fields = componentFields(source, card);
    const values = fields.map(field => field.kind === "name" ? "Release prerequisites" : field.value);
    const edited = applyChanges(source, componentChanges(fields, values));
    const doc = JSON.parse(edited);
    expect(doc.graphs[0].steps[0].annotations).toBeUndefined();
    expect(doc.definitions.find((item: { kind: string }) => item.kind === "ControlFlow").annotations.macroSteps.checklist.title).toBe("Release prerequisites");
    const result = await run({ operation: "validateG", primary: new TextEncoder().encode(edited), annexes: {} });
    expect((result.report as { results: Array<{ verdict: string }> }).results.every((item: { verdict: string }) => item.verdict === "pass")).toBe(true);
  });
  it("creates missing instructions on the real agent, not graph presentation", () => {
    const doc = JSON.parse(createLegacyExample("release"));
    doc.relations = doc.relations.filter((item: { relation: string; source: { id: string } }) => !(item.relation === "directedBy" && item.source.id === "checklist"));
    const source = JSON.stringify(doc), fields = componentFields(source, projectViewer(source).graphs[0].cards[0]);
    const edited = applyChanges(source, componentChanges(fields, fields.map(field => field.kind === "instructions" ? "Inspect every prerequisite." : field.value)));
    expect(projectViewer(edited).graphs[0].cards[0].mission).toBe("Inspect every prerequisite.");
    expect(JSON.parse(edited).graphs[0].steps[0].annotations).toBeUndefined();
  });
  it("keeps separately owned instruction sources separate and leaves unchanged fields untouched", () => {
    const doc = JSON.parse(createLegacyExample("release"));
    const agent = doc.definitions.find((item: { key: { id: string } }) => item.key.id === "checklist");
    agent.annotations.description = "Context";
    agent.payload.mission = "Mission";
    const source = JSON.stringify(doc);
    const card = projectViewer(source).graphs[0].cards[0];
    const fields = componentFields(source, card);
    expect(fields).toHaveLength(4);
    expect(componentChanges(fields, fields.map(field => field.value))).toEqual([]);
    const values = fields.map(field => field.value);
    values[2] = "Updated mission";
    const changes = componentChanges(fields, values);
    expect(changes).toHaveLength(1);
    const edited = projectViewer(applyChanges(source, changes)).graphs[0].cards[0];
    expect(edited.mission).toContain("Context\n\nUpdated mission\n\n");
  });
});
