import { describe, expect, it } from "bun:test";
import { componentChanges, componentFields } from "./componentFields";
import { run } from "../../vendor/agsdl/browser-reader.mjs";
import { applyChanges } from "./document";
import { createExample } from "./examples";
import { projectViewer } from "./viewer";

describe("component text edits", () => {
  it("edits a local title and real instruction body without losing opaque values or connections", () => {
    const source = createExample("release").replace('"extensions": []', '"extensions": [{"opaque": 900719925474099312345}]');
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
    const source = createExample("release");
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
    const doc = JSON.parse(createExample("release"));
    doc.relations = doc.relations.filter((item: { relation: string; source: { id: string } }) => !(item.relation === "directedBy" && item.source.id === "checklist"));
    const source = JSON.stringify(doc), fields = componentFields(source, projectViewer(source).graphs[0].cards[0]);
    const edited = applyChanges(source, componentChanges(fields, fields.map(field => field.kind === "instructions" ? "Inspect every prerequisite." : field.value)));
    expect(projectViewer(edited).graphs[0].cards[0].mission).toBe("Inspect every prerequisite.");
    expect(JSON.parse(edited).graphs[0].steps[0].annotations).toBeUndefined();
  });
  it("keeps separately owned instruction sources separate and leaves unchanged fields untouched", () => {
    const doc = JSON.parse(createExample("release"));
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
