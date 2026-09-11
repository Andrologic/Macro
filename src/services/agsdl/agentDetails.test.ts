import { describe, expect, it } from "bun:test";
import { createExample } from "./examples";
import { projectViewer } from "./viewer";
import { agentConfigurations, outputRecipients } from "./agentDetails";

describe("agent details provenance and configuration", () => {
  it("finds real output consumers and distinguishes a system result from an agent", () => {
    const doc = JSON.parse(createExample("feature"));
    let cards = projectViewer(JSON.stringify(doc)).graphs[0].cards;
    expect(outputRecipients(cards[0], cards, "report").map(item => [item.card.id, item.port])).toEqual([[cards[1].id, "brief"]]);
    expect(outputRecipients(cards[2], cards, "report")[0].card.kind).toBe("end");
    delete doc.graphs[0].steps[1].bindings.brief;
    cards = projectViewer(JSON.stringify(doc)).graphs[0].cards;
    expect(outputRecipients(cards[0], cards, "report")).toEqual([]); // A success route is not a data binding.
    doc.graphs[0].steps[1].bindings.brief = { step: doc.graphs[0].steps[0].id, port: "missing" };
    cards = projectViewer(JSON.stringify(doc)).graphs[0].cards;
    expect(outputRecipients(cards[0], cards, "report")).toEqual([]);
  });
  it("keeps runtime bindings scoped to the exact graph and agent without picking a configuration", () => {
    const doc = JSON.parse(createExample("feature"));
    const runtime = doc.runtime.configurations[0];
    runtime.agents[0].engine = { identity: "example/engine", version: "1" };
    runtime.agents[0].parameters = { model: "example-model", temperature: 0 };
    const tool = { scope: "example", id: "search", version: "1" };
    doc.definitions.push({ kind: "Tool", key: tool, payload: {}, annotations: { title: "Search" } });
    runtime.agents[0].tools = [{ tool, selected: "mcp", choices: [{ id: "mcp", implementation: { identity: "example/mcp", version: "1" }, parameters: { server: "example-server", tool: "search" } }] }];
    doc.runtime.configurations.push({ ...structuredClone(runtime), id: "other-graph", graph: { ...runtime.graph, version: "2" } });
    let source = JSON.stringify(doc), card = projectViewer(source).graphs[0].cards[0];
    doc.relations.push({ source: doc.graphs[0].steps[0].agent, relation: "uses", target: doc.graphs[0].steps[0].resources[0], expectedKind: "Resource" });
    source = JSON.stringify(doc); card = projectViewer(source).graphs[0].cards[0];
    expect(card.tools).toEqual([]); // A resource relation is not a tool permission.
    const configurations = agentConfigurations(source, card);
    expect(configurations).toHaveLength(1);
    expect(configurations[0].selected).toBe(false);
    expect(configurations[0].engine).toBe("example/engine · 1");
    expect(configurations[0].tools[0].choices[0]).toMatchObject({ selected: true, parameters: { server: "example-server", tool: "search" } });
    expect(configurations[0].tools[0].reference.target).toBe(`/definitions/${doc.definitions.length - 1}`);
    runtime.agents.push(structuredClone(runtime.agents[0]));
    source = JSON.stringify(doc); card = projectViewer(source).graphs[0].cards[0];
    expect(agentConfigurations(source, card)).toEqual([]); // Ambiguous bindings do not establish access.
  });
});
