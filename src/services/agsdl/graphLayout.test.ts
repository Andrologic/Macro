import { describe, expect, it } from "bun:test";
import { getViewportForBounds } from "@xyflow/react";
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
  it("keeps 0.3 choices with identical endpoints separately selectable", () => {
    const cards = [card("a"), card("b")];
    const choices = ["onError", "next"].map(key => ({ ...edge("a", "b", key), route030: {
      path: `/flow/steps/a/next/${key}`, sourcePath: "/flow/steps/a", role: "normal" as const, key, targetKind: "step" as const,
    } }));
    const graph = layoutViewer(cards, choices);
    const source = at(graph, "a"), target = at(graph, "b");
    const handles = { sourceX: center(source), sourceY: source.position.y + source.height, targetX: center(target), targetY: target.position.y };
    const paths = choices.map(item => viewerEdgePath(graph.routes.get(item.id)!, handles));
    expect(paths[0]).not.toBe(paths[1]);
  });
  it("separates many parallel choices on forward tracks, long rails, returns and self-loops", () => {
    const choices = (from: string, to: string) => Array.from({ length: 8 }, (_, index) => {
      const key = `choice${index}`;
      return { ...edge(from, to, key), route030: { path: `/flow/steps/${from}/next/${key}`,
        sourcePath: `/flow/steps/${from}`, role: "normal" as const, key, targetKind: "step" as const } };
    });
    const check = (ids: string[], backbone: ViewerEdge[], from: string, to: string, rail: boolean) => {
      const branches = choices(from, to), graph = layoutViewer(ids.map(id => card(id)), [...backbone, ...branches]);
      const source = at(graph, from), target = at(graph, to);
      const handles = { sourceX: center(source), sourceY: source.position.y + source.height, targetX: center(target), targetY: target.position.y };
      const routes = branches.map(item => graph.routes.get(item.id)!);
      expect(new Set(routes.map(route => viewerEdgePath(route, handles))).size).toBe(branches.length);
      if (rail) {
        const rails = routes.map(route => route.steps[0].x!).sort((a, b) => a - b);
        expect(rails.every((x, i) => i === 0 || x - rails[i - 1] >= 18)).toBe(true);
        const bounds = viewerLayoutBounds(graph);
        expect(rails.every(x => x >= bounds.x && x <= bounds.x + bounds.width)).toBe(true);
      }
    };
    check(["a", "b"], [], "a", "b", false);
    check(["a", "b", "c"], [edge("a", "c")], "a", "b", false);
    check(["a", "b", "c"], [edge("a", "b"), edge("b", "c")], "a", "c", false);
    check(["a", "b", "c", "d"], [edge("a", "b"), edge("b", "c"), edge("c", "d")], "a", "d", true);
    check(["a", "b"], [edge("a", "b")], "b", "a", true);
    check(["a"], [], "a", "a", true);
  });
  it("reserves a pointer-sized vertical segment for each aligned choice in either order", () => {
    const cards = [card("a"), card("b")];
    const choices = Array.from({ length: 9 }, (_, i) => ({ ...edge("a", "b", `choice${i}`), route030: {
      path: `/flow/steps/a/next/choice${i}`, sourcePath: "/flow/steps/a", role: "normal" as const, key: `choice${i}`, targetKind: "step" as const,
    } }));
    for (const ordered of [choices, [...choices].reverse()]) {
      const graph = layoutViewer(cards, ordered), x = center(at(graph, "a"));
      const segments = ordered.map(item => graph.routes.get(item.id)!.steps).map(steps => ({ x: steps[0].x!, y1: steps[0].y, y2: steps[1].y }));
      expect(segments.every(segment => segment.x !== x && segment.y2 - segment.y1 >= 30)).toBe(true);
      const sorted = [...segments].sort((a, b) => a.y1 - b.y1);
      expect(sorted.every((segment, i) => i === 0 || segment.y1 - sorted[i - 1].y2 >= 16)).toBe(true);
    }
  });
  it("separates 0.3 rails from different sources and includes all steps in both bounds", () => {
    const cards = ["a", "b", "c", "d"].map(id => card(id));
    const branches = ["c", "d"].flatMap(source => ["x", "y"].map(key => ({ ...edge(source, "a", key), route030: {
      path: `/flow/steps/${source}/next/${key}`, sourcePath: `/flow/steps/${source}`, role: "normal" as const, key, targetKind: "step" as const,
    } })));
    const error = { ...edge("d", "a", "onError"), route030: { path: "/flow/steps/d/onError", sourcePath: "/flow/steps/d", role: "error" as const, targetKind: "step" as const } };
    for (const order of [branches, [...branches].reverse()]) {
      const graph = layoutViewer(cards, [edge("a", "b"), edge("b", "c"), edge("c", "d"), ...order, error]);
      const routes = [...branches, error].map(item => graph.routes.get(item.id)!);
      const xs = routes.map(route => route.steps[0].x!).sort((a, b) => a - b);
      expect(xs.every((x, i) => i === 0 || x - xs[i - 1] >= 18)).toBe(true);
      const bounds = viewerLayoutBounds(graph);
      for (const route of routes) for (const step of route.steps) {
        if (step.x !== undefined) expect(step.x >= bounds.x && step.x <= bounds.x + bounds.width).toBe(true);
        expect(step.y >= bounds.y && step.y <= bounds.y + bounds.height).toBe(true);
      }
    }
  });
  it("keeps unrelated rows compact when a long graph has many loop or forward choices", () => {
    const cards = Array.from({ length: 20 }, (_, i) => card(`n${i}`));
    const backbone = cards.slice(0, -1).map((_, i) => edge(`n${i}`, `n${i + 1}`));
    const choices = (from: string, to: string, count: number) => Array.from({ length: count }, (_, i) => ({ ...edge(from, to, `c${i}`), route030: {
      path: `/flow/steps/${from}/next/c${i}`, sourcePath: `/flow/steps/${from}`, role: "normal" as const, key: `c${i}`, targetKind: "step" as const,
    } }));
    const base = layoutViewer(cards, backbone);
    const loops = layoutViewer(cards, [...backbone, ...choices("n0", "n0", 40)]);
    const forward = layoutViewer(cards, [...backbone, ...choices("n10", "n11", 9)]);
    expect(viewerLayoutBounds(loops).height).toBeLessThan(viewerLayoutBounds(base).height + 100);
    expect(viewerLayoutBounds(forward).height).toBeLessThan(viewerLayoutBounds(base).height + 600);
    expect(at(forward, "n9").position.y).toBe(at(base, "n9").position.y);
    expect(at(forward, "n19").position.y - at(forward, "n12").position.y).toBe(at(base, "n19").position.y - at(base, "n12").position.y);
    for (const graph of [loops, forward]) {
      const bounds = viewerLayoutBounds(graph);
      for (const [width, height] of [[1366, 768], [1440, 900], [400, 300]]) {
        const minZoom = Math.min(0.1, width / (bounds.width * 4), height / (bounds.height * 4));
        const viewport = getViewportForBounds(bounds, width, height, minZoom, 1, 0.16);
        expect(bounds.width * viewport.zoom).toBeLessThanOrEqual(width);
        expect(bounds.height * viewport.zoom).toBeLessThanOrEqual(height);
      }
    }
  });
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
