import { describe, expect, it } from "bun:test";
import { projectViewer } from "./viewer";
import { projectViewer030 } from "./viewer030";
import { projectDocument } from "./projection";
import { projectSystemOverview } from "./systemOverview";
import { presentGraph } from "./graphPresentation";

const source = `{
 "contract":"agsdl-0.3.0","id":"review","title":"Révision",
 "agents":{"writer":{"harness":"codex","permissions":"read-only","instructions":[{"value":"Standing"},{"ref":"precise"}],"skills":["guide"],"model":{"effort":"high"},"results":{"summary":{"required":true}}}},
 "content":{"precise":{"value":{"ref":"literal","n":9007199254740993,"large":1e9999}}},"skills":{"guide":{"uri":"skills/guide/SKILL.md"}},
 "flow":{"entry":"start","onError":{"step":"recover","message":{}},"steps":{
 "start":{"type":"agent","agent":"writer","next":{"next":{"step":"judge","message":{},"each":["results","items"],"concurrency":9007199254740993,"max":1e9999},"failure":"recover","stop":[]},"onError":"recover"},
 "judge":{"type":"approval","next":{"accept":["recover",{"step":"finish"}],"deny":[]}},
 "recover":{"type":"call","command":"echo ok","next":"finish"},"finish":{"type":"join","next":{"done":[]}}}},
 "compositions":{"template":{"parameters":["reviewer"],"entry":"body","steps":{"body":{"type":"agent","agent":{"parameter":"reviewer"},"next":{"output":"done"}}},"outputs":["done"]}}
}`;

describe("AgSDL 0.3 source projection", () => {
  it("keeps route identity, exact numbers, terminal choices and error roles through the canvas", () => {
    const viewer = projectViewer(source), graph = viewer.graphs[0], start = graph.cards[0];
    expect(viewer.title).toBe("Révision");
    const routes = start.edition030!.routes;
    expect(routes.map(route => [route.path, route.key, route.role, route.targetKind])).toEqual([
      ["/flow/steps/start/next/next", "next", "normal", "step"],
      ["/flow/steps/start/next/failure", "failure", "normal", "step"],
      ["/flow/steps/start/next/stop", "stop", "normal", "terminal"],
      ["/flow/steps/start/onError", undefined, "error", "step"],
    ]);
    expect(routes[0]).toMatchObject({ concurrencyJson: "9007199254740993", maxJson: "1e9999", messageJson: "{}" });
    const overview = projectSystemOverview(graph, viewer.declarations);
    expect(overview.edges.filter(edge => edge.source === start.path)).toHaveLength(3);
    expect(overview.edges.find(edge => edge.label === "failure")?.route030?.role).toBe("normal");
    expect(presentGraph(overview.cards, overview.edges, new Set(), "overview").edges.find(edge => edge.route030?.key === "next")?.originals[0].route030?.messageJson).toBe("{}");
    expect(graph.errorRoutes030?.[0].path).toBe("/flow/onError");
    expect(overview.edges.some(edge => edge.id.startsWith("/flow/onError"))).toBe(false);
    expect(projectDocument(source, "process").edges.some(edge => edge.path === "/flow/steps/recover/next")).toBe(true);
  });
  it("keeps definitions and composition templates without fabricating a main flow or parameter binding", () => {
    // Build the graphless source using spans rather than serializing the exact AST.
    const start = source.indexOf(' "flow":'), end = source.indexOf(' "compositions":');
    const viewer = projectViewer030(source.slice(0, start) + source.slice(end));
    expect(viewer.graphs.map(graph => graph.path)).toEqual(["/compositions/template"]);
    expect(viewer.declarations.some(card => card.path === "/agents/writer")).toBe(true);
    const body = viewer.graphs[0].cards[0];
    expect(body.participant).toMatchObject({ label: "reviewer", unresolved: false });
    expect(body.edition030?.agentPath).toBeUndefined();
    expect(body.branches[0].route030?.targetKind).toBe("output");
    expect(body.branches[0].reference.target).toBeUndefined();
  });
  it("separates skills, standing instructions, opaque literal data and the authored step prompt", () => {
    const card = projectViewer030(source).declarations.find(card => card.path === "/agents/writer")!;
    expect(card.promptSources?.map(item => item.kind)).toEqual(["text", "structured"]);
    expect(card.promptSources?.[1].valueJson).toContain("9007199254740993");
    expect(card.promptSources?.[1].valueJson).toContain('"ref":"literal"');
    expect(card.resources?.[0].target).toBe("/skills/guide");
    expect(card.mission).toBe("Standing");
    expect(card.outputs.map(port => port.name)).toEqual(["text", "summary"]);
  });
});

it("projects probe 1's global handler from the covered call only", () => {
  const raw = JSON.stringify({ contract: "agsdl-0.3.0", id: "global-handler", agents: {}, flow: {
    entry: "a", onError: "recover", steps: { a: { type: "call", command: "echo a" }, recover: { type: "call", command: "echo recover" } },
  } });
  const graph = projectViewer030(raw).graphs[0];
  expect(graph.static030!.report.valid).toBe(true);
  expect(projectSystemOverview(graph, []).edges).toMatchObject([{
    source: "/flow/steps/a", target: "/flow/steps/recover", label: "onError",
    route030: { path: "/flow/onError", sourcePath: "/flow/steps/a", inherited: true, role: "error" },
  }]);
});

it("excludes join branches, local overrides and handler-only paths from inherited error links", () => {
  const call = (next?: unknown) => ({ type: "call", command: "echo synthetic", ...(next === undefined ? {} : { next }) });
  const raw = JSON.stringify({ contract: "agsdl-0.3.0", id: "error-scope", agents: {}, flow: {
    entry: "start", onError: "recover", steps: {
      start: call(["left", "right"]), left: { ...call("merge"), onError: "local" }, local: call("merge"), right: call("merge"),
      merge: { type: "join", next: "after" }, after: { ...call(), onError: [] }, recover: call("tail"), tail: call(),
    },
  } });
  const graph = projectViewer030(raw).graphs[0];
  expect(graph.static030!.report.valid).toBe(true);
  const edges = projectSystemOverview(graph, []).edges;
  expect(edges.filter(edge => edge.route030?.inherited).map(edge => edge.source)).toEqual(["/flow/steps/start", "/flow/steps/merge"]);
  expect(edges.find(edge => edge.source === "/flow/steps/left" && edge.label === "onError")?.target).toBe("/flow/steps/local");
});

it("excludes the handler target itself but covers a handler successor also reached normally", () => {
  const raw = JSON.stringify({ contract: "agsdl-0.3.0", id: "shared-handler-path", agents: {}, flow: {
    entry: "a", onError: "recover", steps: {
      a: { type: "call", command: "echo a", next: "recover" },
      recover: { type: "call", command: "echo recover", next: "tail" }, tail: { type: "call", command: "echo tail" },
    },
  } });
  const graph = projectViewer030(raw).graphs[0];
  expect(graph.static030!.report.valid).toBe(true);
  expect(projectSystemOverview(graph, []).edges.filter(edge => edge.route030?.inherited).map(edge => edge.source)).toEqual(["/flow/steps/a", "/flow/steps/tail"]);
});
