import { describe, expect, it } from "bun:test";
import { createExample } from "./examples";
import { projectViewer } from "./viewer";

const example = () => JSON.parse(createExample("feature"));
describe("AgSDL read-only projection", () => {
  it("shows agent names, full mission, data provenance and every control outcome separately", () => {
    const graph = projectViewer(createExample("feature")).graphs[0];
    expect(graph.cards[0].title).toBe("Specification");
    expect(graph.cards[0].mission).toContain("acceptance criteria");
    expect(graph.cards[1].inputs[0].binding).toEqual({
      label: "Specification · report",
      port: "report",
      source: "step",
      target: "/graphs/0/steps/0",
      unresolved: false,
    });
    expect(graph.cards[0].branches.map((branch) => branch.label)).toEqual([
      "success",
      "failure",
    ]);
    expect(graph.cards[0].branches[1].reference.target).toBe(
      "/graphs/0/steps/4",
    );
    expect(graph.cards[3].outputs[0].binding?.label).toBe(
      "Verification · report",
    );
    expect(graph.cards[4].outcome).toBe("failure");
  });
  it("does not invent links for absent agents, missing ports or ambiguous step ids", () => {
    const doc = example();
    doc.graphs[0].steps[0].agent.id = "absent";
    doc.graphs[0].steps[1].bindings.brief.port = "absent";
    doc.graphs[0].steps[2].id = doc.graphs[0].steps[0].id;
    const graph = projectViewer(JSON.stringify(doc)).graphs[0];
    expect(graph.cards[0].unresolved).toBe(true);
    expect(graph.entry.unresolved).toBe(true);
    expect(graph.entry.target).toBeUndefined();
    expect(graph.cards[1].inputs[0].binding?.unresolved).toBe(true);
    expect(graph.cards[1].inputs[0].binding?.target).toBeUndefined();
  });
  it("retains unresolved and absent failure branches", () => {
    const doc = example();
    doc.graphs[0].steps[0].failure = "missing";
    delete doc.graphs[0].steps[1].failure;
    const cards = projectViewer(JSON.stringify(doc)).graphs[0].cards;
    expect(cards[0].branches[1].reference).toEqual({
      label: "missing",
      unresolved: true,
      source: "step",
    });
    expect(cards[1].branches[1].reference.unresolved).toBe(true);
  });
  it("renders declarations without fabricating a workflow", () => {
    const doc = example();
    delete doc.graphs;
    const result = projectViewer(JSON.stringify(doc));
    expect(result.graphs).toEqual([]);
    expect(
      result.declarations.find((item) => item.title === "Specification")
        ?.mission,
    ).toContain("acceptance criteria");
  });
  it("projects retained legacy dependencies without control or data claims", () => {
    const doc = example();
    delete doc.graphs;
    doc.root.annotations.macroMigration = {
      version: 1,
      issues: ["execution-not-migrated"],
    };
    doc.definitions.push({
      kind: "Resource",
      key: { id: "macro-legacy-plan" },
      payload: {
        nodes: [
          {
            id: "a",
            title: "First agent",
            dependencies: [],
            artifactContracts: [
              { id: "result", title: "Review report", kind: "report" },
            ],
          },
          { id: "b", title: "Second agent", dependencies: ["a", "absent"] },
        ],
      },
    });
    const result = projectViewer(JSON.stringify(doc));
    expect(result.graphs).toEqual([]);
    expect(result.legacyCards[1].dependencies?.[0].target).toBe("/legacy/0");
    expect(result.legacyCards[1].dependencies?.[1].unresolved).toBe(true);
    expect(result.legacyCards[1].branches).toEqual([]);
    expect(result.legacyCards[1].inputs).toEqual([]);
    expect(result.legacyCards[0].outputs[0].name).toBe("Review report");
  });
  it("reflects AI edits to migrated agent instructions instead of the archived description", () => {
    const doc = example();
    delete doc.graphs;
    doc.root.annotations.macroMigration = { version: 1, issues: [] };
    doc.definitions.find(
      (definition: { kind: string }) => definition.kind === "Agent",
    ).annotations.macroLegacyNodeId = "a";
    doc.definitions.find(
      (definition: { kind: string }) => definition.kind === "Instructions",
    ).payload.body = "Updated mission from chat";
    doc.definitions.push({
      kind: "Resource",
      key: { id: "macro-legacy-plan" },
      payload: {
        nodes: [
          {
            id: "a",
            title: "Old title",
            description: "Old mission",
            dependencies: [],
          },
        ],
      },
    });
    const card = projectViewer(JSON.stringify(doc)).legacyCards[0];
    expect(card.mission).toBe("Updated mission from chat");
    expect(card.title).toBe("Specification");
  });
  it("does not treat a non-Agent definition as an invoked agent", () => {
    const doc = example();
    doc.graphs[0].steps[0].agent = doc.definitions[0].key;
    expect(
      projectViewer(JSON.stringify(doc)).graphs[0].cards[0].unresolved,
    ).toBe(true);
  });
  it("rejects malformed JSON and unsupported contracts", () => {
    expect(() => projectViewer("{")).toThrow();
    expect(() => projectViewer("{}")).toThrow("contract");
  });
});
