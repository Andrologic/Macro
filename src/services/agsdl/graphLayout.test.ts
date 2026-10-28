import { describe, expect, it } from "bun:test";
import { layoutViewer, routeViewerEdge, viewerEdgePath, viewerLayoutBounds, VIEWER_CARD_WIDTH, VIEWER_FRAME, type ViewerEdge, type ViewerLayoutNode } from "./graphLayout";
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
    expect(graph.nodes.map(node => node.position.y)).toEqual([0, 240, 350]);
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

  it("keeps room around framed steps and drops a neighbour's rail below the frame", () => {
    const cards = ["start", "inner", "check", "beside", "after", "handler"].map(id => card(id));
    const framed = ["inner", "check"].map(id => `/flow/steps/${id}`);
    const edges = [edge("start", "inner"), edge("start", "beside", "other"), edge("inner", "check"), edge("check", "after"), edge("after", "handler"), edge("beside", "handler", "onError")];
    const plain = layoutViewer(cards, edges), graph = layoutViewer(cards, edges, {}, [framed]);
    // The frame's heading band and bottom padding push the following rows down.
    expect(at(graph, "inner").position.y - at(plain, "inner").position.y).toBe(VIEWER_FRAME.top + VIEWER_FRAME.heading);
    expect(at(graph, "after").position.y - at(plain, "after").position.y).toBe(VIEWER_FRAME.top + VIEWER_FRAME.heading + VIEWER_FRAME.padding);
    // The block beside the frame stays clear of its border.
    const gap = Math.abs(center(at(graph, "beside")) - center(at(graph, "inner"))) - VIEWER_CARD_WIDTH;
    expect(gap).toBeGreaterThanOrEqual(40 + VIEWER_FRAME.padding);
    const frameBottom = at(graph, "check").position.y + at(graph, "check").height + VIEWER_FRAME.padding;
    const rail = graph.routes.get(edges[5].id)!;
    expect(rail.steps[0].y).toBeGreaterThan(frameBottom);
  });

  it("starts a block reached from inside a frame below the whole frame", () => {
    const cards = ["start", "inner", "check", "fix", "review"].map(id => card(id));
    const edges = [edge("start", "inner"), edge("inner", "check"), edge("inner", "review", "green"), edge("check", "fix"), edge("fix", "inner")];
    const graph = layoutViewer(cards, edges, {}, [["inner", "check", "fix"].map(id => `/flow/steps/${id}`)]);
    expect(at(graph, "review").position.y).toBeGreaterThan(at(graph, "fix").position.y);
  });
});

describe("AgSDL handler rails", () => {
  it("puts two distant handlers on opposite sides so their rails never cross", () => {
    const cards = ["a", "b", "c", "d", "e", "escalate", "recover"].map(id => card(id));
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"), edge("d", "escalate", "denied"), edge("d", "recover", "onError"),
      edge("a", "escalate", "escalate"), edge("b", "escalate", "denied"), edge("a", "recover", "onError"), edge("b", "recover", "onError"), edge("c", "recover", "onError")];
    const graph = layoutViewer(cards, edges);
    const rail = (target: string) => graph.routes.get(edges.find(item => item.source.endsWith("/a") && item.target.endsWith(target))!.id)!.steps[0].x!;
    const spine = center(at(graph, "a"));
    expect(Math.sign(rail("escalate") - spine)).toBe(-Math.sign(rail("recover") - spine));
    expect(Math.sign(center(at(graph, "escalate")) - center(at(graph, "e")))).toBe(Math.sign(rail("escalate") - spine));
  });

  it("sends a failure straight across a clear row and includes every rail in the fitted area", () => {
    const cards = ["a", "b", "c", "d", "e", "recover"].map(id => card(id));
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"), edge("a", "recover", "onError"), edge("b", "recover", "onError"), edge("d", "recover", "onError")];
    const graph = layoutViewer(cards, edges);
    const rails = edges.slice(4, 6).map(item => graph.routes.get(item.id)!);
    const railX = rails[0].steps[0].x!;
    expect(rails.every(route => route.steps[0].x === railX)).toBe(true);
    // Failures exit on the right; they stay level only when the rail is on that side.
    expect(rails.every(route => Boolean(route.steps[0].level) === railX > center(at(graph, "a")))).toBe(true);
    const bounds = viewerLayoutBounds(graph);
    expect(bounds.x <= railX && railX <= bounds.x + bounds.width).toBe(true);
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
