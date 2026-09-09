import { describe, expect, it } from "bun:test";
import { layoutViewer } from "./graphLayout";
import { projectViewer } from "./viewer";
import { createExample } from "./examples";

const cards = () => projectViewer(createExample("release")).graphs[0].cards;
describe("AgSDL graph layout", () => {
  it("positions the real chain in order and shares the failure terminal beside it", () => {
    const input = cards();
    const graph = layoutViewer(input);
    expect(graph.edges).toHaveLength(6);
    const positions = new Map(graph.nodes.map(node => [node.card.path, node.position]));
    expect(positions.get(input[1].path)!.y).toBeGreaterThan(positions.get(input[0].path)!.y);
    expect(positions.get(input[2].path)!.y).toBeGreaterThan(positions.get(input[1].path)!.y);
    expect(positions.get(input[4].path)!.x).toBeGreaterThan(positions.get(input[2].path)!.x);
    expect(graph.edges.filter(edge => edge.target === input[4].path)).toHaveLength(3);
  });
  it("lays out forks, joins and cycles without overlap or inventing missing routes", () => {
    const input = cards();
    input[0].branches[1].reference.target = input[2].path;
    input[1].branches[0].reference.target = input[3].path;
    input[2].branches[0].reference.target = input[3].path;
    const fork = layoutViewer(input);
    expect(fork.nodes[1].position.y).toBe(fork.nodes[2].position.y);
    expect(fork.nodes[1].position.x).not.toBe(fork.nodes[2].position.x);
    input[1].branches[0].reference = { label: "missing", source: "step", target: "absent", unresolved: true };
    input[2].branches[0].reference.target = input[0].path;
    const cyclic = layoutViewer(input);
    expect(new Set(cyclic.nodes.map(node => JSON.stringify(node.position))).size).toBe(input.length);
    expect(cyclic.edges.some(edge => edge.target === "absent")).toBe(false);
  });
  it("renders inherited dependencies in their declared direction, without data-flow claims", () => {
    const input = cards().slice(0, 2).map(card => ({ ...card, branches: [] }));
    input[1].dependencies = [{ source: "step", label: input[0].title, target: input[0].path }];
    const graph = layoutViewer(input);
    expect(graph.edges).toMatchObject([{ source: input[0].path, target: input[1].path, dependency: true }]);
    expect(graph.nodes[1].position.y).toBeGreaterThan(graph.nodes[0].position.y);
  });
});
