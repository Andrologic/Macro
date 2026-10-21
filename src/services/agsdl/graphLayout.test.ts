import { describe, expect, it } from "bun:test";
import { layoutViewer, routeViewerEdge, viewerEdgePath, VIEWER_CARD_WIDTH, type ViewerEdge, type ViewerLayoutNode } from "./graphLayout";
import { presentGraph } from "./graphPresentation";
import type { ViewerCard } from "./viewer";

const card = (id: string, kind = "agent"): ViewerCard => ({
  path: `/flow/steps/${id}`, id, title: id, kind, mission: "", unresolved: false, inputs: [], outputs: [], branches: [], details: {},
});
const edge = (source: string, target: string, label = "next"): ViewerEdge => ({
  id: `${source}/${label}/${target}`, source: `/flow/steps/${source}`, target: `/flow/steps/${target}`, label, dependency: false,
});
const at = (graph: { nodes: ViewerLayoutNode[] }, id: string) => graph.nodes.find(node => node.card.id === id)!;
const center = (node: ViewerLayoutNode) => node.position.x + VIEWER_CARD_WIDTH / 2;
const overlaps = (nodes: ViewerLayoutNode[]) => nodes.some((a, index) => nodes.slice(index + 1).some(b =>
  a.position.x < b.position.x + VIEWER_CARD_WIDTH && b.position.x < a.position.x + VIEWER_CARD_WIDTH
  && a.position.y < b.position.y + b.height && b.position.y < a.position.y + a.height));

describe("AgSDL reading layout", () => {
  it("keeps the main path in one straight column below the tallest card of each row", () => {
    const cards = ["a", "b", "c"].map(id => card(id));
    const graph = layoutViewer(cards, [edge("a", "b"), edge("b", "c")], { [cards[0].path]: 180 });
    expect(graph.nodes.map(node => node.position.y)).toEqual([0, 240, 352]);
    expect(new Set(graph.nodes.map(center)).size).toBe(1);
  });

  it("centres a fork under its source and the join under its members", () => {
    const cards = ["fork", "left", "middle", "right", "join"].map(id => card(id));
    const graph = layoutViewer(cards, [
      edge("fork", "left"), edge("fork", "middle"), edge("fork", "right"),
      edge("left", "join"), edge("middle", "join"), edge("right", "join"),
    ]);
    const members = ["left", "middle", "right"].map(id => at(graph, id));
    expect(new Set(members.map(node => node.position.y)).size).toBe(1);
    expect(center(at(graph, "middle"))).toBeCloseTo(center(at(graph, "fork")));
    expect(center(at(graph, "join"))).toBeCloseTo(center(at(graph, "fork")));
    expect(overlaps(graph.nodes)).toBe(false);
  });

  it("keeps the condition's main outcome straight and draws the correction loop outside the cards it spans", () => {
    const cards = ["write", "review", "ready", "publish", "revise"].map(id => card(id));
    const back = edge("revise", "review");
    const graph = layoutViewer(cards, [edge("write", "review"), edge("review", "ready"), edge("ready", "publish", "true"), edge("ready", "revise", "false"), back]);
    expect(at(graph, "publish").position.y).toBe(at(graph, "revise").position.y);
    expect(center(at(graph, "publish"))).toBeCloseTo(center(at(graph, "ready")));
    const route = graph.routes.get(back.id)!;
    expect(route.loop).toBe(true);
    const rail = route.steps[0].x!;
    const spanned = ["review", "ready", "publish", "revise"].map(id => at(graph, id));
    expect(spanned.every(node => rail > node.position.x + VIEWER_CARD_WIDTH || rail < node.position.x)).toBe(true);
    expect(route.steps[0].y).toBeGreaterThan(at(graph, "revise").position.y + at(graph, "revise").height);
    expect(route.steps[1].y).toBeLessThan(at(graph, "review").position.y);
  });

  it("terminates on cyclic drafts without a root and never stacks cards", () => {
    const cards = ["a", "b", "c"].map(id => card(id));
    const graph = layoutViewer(cards, [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("b", "b")]);
    expect(overlaps(graph.nodes)).toBe(false);
    expect(graph.routes.get(edge("b", "b").id)?.loop).toBe(true);
  });

  it("shares one side rail for distant connections to the same handler and moves the handler to that side", () => {
    const cards = ["start", "check", "approve", "act", "done", "escalate"].map(id => card(id));
    const edges = [edge("start", "check"), edge("check", "approve", "true"), edge("approve", "act", "approved"), edge("act", "done"),
      edge("start", "escalate", "onError"), edge("check", "escalate", "false"), edge("act", "escalate", "onError")];
    const graph = layoutViewer(cards, edges);
    const distant = edges.slice(4, 6).map(item => graph.routes.get(item.id)!);
    expect(new Set(distant.map(route => route.steps[0].x)).size).toBe(1);
    expect(distant[0].steps[0].x).not.toBe(center(at(graph, "start")));
    const handler = at(graph, "escalate"), done = at(graph, "done");
    expect(handler.position.y).toBe(done.position.y);
    const railX = distant[0].steps[0].x!;
    expect(Math.sign(center(handler) - center(done))).toBe(Math.sign(railX - center(done)));
    expect(new Set(["start", "check", "approve", "act"].map(id => center(at(graph, id)))).size).toBe(1);
  });
});

describe("AgSDL connection paths", () => {
  it("draws rounded orthogonal paths that start and end on the actual handles", () => {
    const path = viewerEdgePath({ kind: "orthogonal", steps: [{ y: 80, x: 300 }, { y: 400 }] }, { sourceX: 105, sourceY: 52, targetX: 105, targetY: 420 });
    expect(path.startsWith("M105 52 ")).toBe(true);
    expect(path.endsWith("L105 420")).toBe(true);
    expect(path).toContain("Q300 80");
    expect(path).toContain("Q300 400");
    expect(viewerEdgePath({ kind: "orthogonal", steps: [{ y: 80 }] }, { sourceX: 105, sourceY: 52, targetX: 105, targetY: 112 })).toBe("M105 52 L105 112");
  });

  it("routes revealed exchanges that are not part of the layout and ignores unknown blocks", () => {
    const cards = ["a", "b", "c", "d"].map(id => card(id));
    for (const item of cards.slice(1, 3)) item.details = { displayAnnotations: { macroGroup: "Review" } };
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")];
    const folded = presentGraph(cards, edges, new Set(["macro-group:Review"]), "overview");
    const graph = layoutViewer(folded.cards, folded.edges, { "macro-group:Review": 519 });
    const group = graph.nodes.find(node => node.card.path === "macro-group:Review")!;
    const outgoing = folded.edges.find(connection => connection.source === "macro-group:Review")!;
    expect(graph.routes.get(outgoing.id)!.steps[0].y).toBeGreaterThan(group.position.y + group.height);
    const exchange = { ...edge("a", "d"), exchangeOnly: true };
    const route = routeViewerEdge(graph.nodes, exchange)!;
    expect(route.steps[0].x).toBeGreaterThan(Math.max(...graph.nodes.map(node => node.position.x + VIEWER_CARD_WIDTH)));
    expect(routeViewerEdge(graph.nodes, edge("missing", "d"))).toBeUndefined();
    expect(graph.edges).toEqual(folded.edges);
  });
});
