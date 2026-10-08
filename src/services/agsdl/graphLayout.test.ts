import { describe, expect, it } from "bun:test";
import { layoutViewer, routeViewerEdge, outsideViewerEdgePath, type ViewerEdge } from "./graphLayout";
import { getSmoothStepPath, Position } from "@xyflow/react";
import { presentGraph } from "./graphPresentation";
import { projectViewer } from "./viewer";
import { projectSystemOverview } from "./systemOverview";
import { createLegacyExample } from "./examples";

const overview = () => projectSystemOverview(projectViewer(createLegacyExample("release")).graphs[0], []);
describe("AgSDL system layout", () => {
  it("orders the three agents without inventing input or result participants", () => {
    const input = overview();
    const graph = layoutViewer(input.cards, input.edges);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes.map(node => node.position.y)).toEqual([0, 100, 200]);
  });
  it("keeps successors below the tallest measured card in each rank", () => {
    const input = overview();
    const fork = [
      { id: "first/second", source: input.cards[0].path, target: input.cards[1].path, label: "", dependency: false },
      { id: "first/third", source: input.cards[0].path, target: input.cards[2].path, label: "", dependency: false },
    ];
    const fourth = { ...input.cards[2], path: "/extra", id: "extra" };
    const edges = [...fork, { id: "second/extra", source: input.cards[1].path, target: fourth.path, label: "", dependency: false }];
    const graph = layoutViewer([...input.cards, fourth], edges, { [input.cards[0].path]: 180, [input.cards[2].path]: 320 });
    expect(graph.nodes[1].position.y).toBe(228);
    expect(graph.nodes[2].position.y).toBe(228);
    expect(graph.nodes[3].position.y).toBe(596);
    expect(graph.edges).toEqual(edges);
  });
  it("lays out forks and cycles without overlap", () => {
    const agents = overview().cards;
    const cards = [...agents, { ...agents[2], path: "/synthetic/fourth", id: "fourth", title: "Additional review" }];
    const edge = (from: number, to: number) => ({ id: `${from}/${to}`, source: cards[from].path, target: cards[to].path, label: "", dependency: false });
    const edges = [edge(0, 1), edge(0, 2), edge(1, 3), edge(2, 3)];
    const fork = layoutViewer(cards, edges);
    expect(fork.nodes[1].position.y).toBe(fork.nodes[2].position.y);
    expect(fork.nodes[1].position.x).not.toBe(fork.nodes[2].position.x);
    const cycle = layoutViewer(cards, [...edges, edge(3, 0)]);
    expect(new Set(cycle.nodes.map(node => JSON.stringify(node.position))).size).toBe(cards.length);
  });
});


describe("AgSDL visible edge routes", () => {
  const cards = () => {
    const agents = overview().cards;
    return [...agents, { ...agents[2], path: "/fourth", id: "fourth" }];
  };
  const edge = (source: string, target: string): ViewerEdge => ({ id: `${source}/${target}`, source, target, label: "next", dependency: false });

  it("converges unequal-height branches below both cards, whichever branch is tall", () => {
    for (const tallIndex of [1, 2]) {
      const nodes = cards();
      const edges = [edge(nodes[0].path, nodes[1].path), edge(nodes[0].path, nodes[2].path), edge(nodes[1].path, nodes[3].path), edge(nodes[2].path, nodes[3].path)];
      const graph = layoutViewer(nodes, edges, { [nodes[tallIndex].path]: 519 });
      const target = graph.nodes[3];
      const routes = edges.slice(2).map(connection => routeViewerEdge(graph.nodes, connection));
      expect(routes[0]).toEqual(routes[1]);
      for (let index = 0; index < routes.length; index++) {
        const route = routes[index]!;
        expect(route.kind).toBe("channel");
        if (route.kind !== "channel") throw new Error("Missing row corridor");
        const source = graph.nodes[index + 1];
        const rowBottom = Math.max(...graph.nodes.slice(1, 3).map(node => node.position.y + node.height));
        expect(route.centerY).toBeGreaterThan(rowBottom);
        expect(route.centerY).toBeLessThan(target.position.y);
        const [, , actualChannelY] = getSmoothStepPath({
          sourceX: source.position.x + 105, sourceY: source.position.y + source.height + 1,
          targetX: target.position.x + 105, targetY: target.position.y - 1,
          sourcePosition: Position.Bottom, targetPosition: Position.Top, centerY: route.centerY,
        });
        expect(actualChannelY).toBe(route.centerY);
      }
      expect(graph.edges).toEqual(edges);
    }
  });

  it("routes the cycle return outside all cards and attaches to the exact original handles", () => {
    const nodes = cards().slice(0, 3);
    const edges = [edge(nodes[0].path, nodes[1].path), edge(nodes[1].path, nodes[2].path), edge(nodes[2].path, nodes[0].path)];
    const graph = layoutViewer(nodes, edges, { [nodes[1].path]: 451 });
    const route = routeViewerEdge(graph.nodes, edges[2])!;
    expect(route.kind).toBe("outside");
    if (route.kind !== "outside") throw new Error("Missing cycle corridor");
    expect(route.outsideX).toBeGreaterThan(Math.max(...graph.nodes.map(node => node.position.x + 210)));
    expect(route.exitY).toBeGreaterThan(graph.nodes[2].position.y + graph.nodes[2].height);
    expect(route.entryY).toBeLessThan(graph.nodes[0].position.y);
    const sourceY = graph.nodes[2].position.y + graph.nodes[2].height + 1;
    const targetY = graph.nodes[0].position.y - 1;
    const path = outsideViewerEdgePath(route, { sourceX: 105, sourceY, targetX: 105, targetY });
    expect(path.startsWith(`M105 ${sourceY} `)).toBe(true);
    expect(path.endsWith(`L105 ${targetY}`)).toBe(true);
    expect(path).toContain(`L${route.outsideX} ${route.entryY + 5}`);
    expect(graph.edges).toEqual(edges);
  });

  it("keeps a folded tall group's routes attached and bypasses intermediate rows for exchanges", () => {
    const nodes = cards();
    for (const card of nodes.slice(1, 3)) card.details = { ...card.details, displayAnnotations: { macroGroup: "Review" } };
    const edges = [edge(nodes[0].path, nodes[1].path), edge(nodes[0].path, nodes[2].path), edge(nodes[1].path, nodes[3].path), edge(nodes[2].path, nodes[3].path)];
    const folded = presentGraph(nodes, edges, new Set(["macro-group:Review"]), "overview");
    const graph = layoutViewer(folded.cards, folded.edges, { "macro-group:Review": 519 });
    const outgoing = folded.edges.find(connection => connection.source === "macro-group:Review")!;
    const route = routeViewerEdge(graph.nodes, outgoing)!;
    expect(route.kind).toBe("channel");
    if (route.kind !== "channel") throw new Error("Missing group corridor");
    const group = graph.nodes.find(node => node.card.path === outgoing.source)!;
    expect(route.centerY).toBeGreaterThan(group.position.y + group.height);
    expect(route.centerY).toBeLessThan(graph.nodes.find(node => node.card.path === outgoing.target)!.position.y);
    const exchange = { ...edge(nodes[0].path, nodes[3].path), exchangeOnly: true };
    expect(routeViewerEdge(graph.nodes, exchange)?.kind).toBe("outside");
    expect(routeViewerEdge(graph.nodes, edge("missing", nodes[3].path))).toBeUndefined();
    expect(graph.edges).toEqual(folded.edges);
  });
});
