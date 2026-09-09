import { describe, expect, it } from "bun:test";
import { layoutViewer } from "./graphLayout";
import { projectViewer } from "./viewer";
import { projectSystemOverview } from "./systemOverview";
import { createExample } from "./examples";

const overview = () => projectSystemOverview(projectViewer(createExample("release")).graphs[0], []);
describe("AgSDL system layout", () => {
  it("orders the input, agents and result without letting shared context flatten the chain", () => {
    const input = overview();
    const graph = layoutViewer(input.cards, input.edges);
    expect(graph.nodes).toHaveLength(5);
    expect(graph.nodes.map(node => node.position.y)).toEqual([0, 100, 200, 300, 400]);
  });
  it("lays out forks and cycles without overlap", () => {
    const cards = overview().cards.slice(0, 4);
    const edge = (from: number, to: number) => ({ id: `${from}/${to}`, source: cards[from].path, target: cards[to].path, label: "", dependency: false });
    const edges = [edge(0, 1), edge(0, 2), edge(1, 3), edge(2, 3)];
    const fork = layoutViewer(cards, edges);
    expect(fork.nodes[1].position.y).toBe(fork.nodes[2].position.y);
    expect(fork.nodes[1].position.x).not.toBe(fork.nodes[2].position.x);
    const cycle = layoutViewer(cards, [...edges, edge(3, 0)]);
    expect(new Set(cycle.nodes.map(node => JSON.stringify(node.position))).size).toBe(cards.length);
  });
});
