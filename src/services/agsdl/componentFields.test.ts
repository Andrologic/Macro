import { describe, expect, it } from "bun:test";
import { componentChanges, componentFields } from "./componentFields";
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
