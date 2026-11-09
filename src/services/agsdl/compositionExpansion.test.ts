import { expect, it } from "bun:test";
import { demoPlans } from "../../demo/fixtures";
import { expandCompositions, expandedStepPath, originalStepPath } from "./compositionExpansion";
import { projectSystemOverview } from "./systemOverview";
import { projectViewer } from "./viewer";

it("unfolds a composition step into its steps, run by the bound agent and leaving through the step's routes", () => {
  const plan = demoPlans.find(item => item.id === "demo-crisis")!;
  const projected = projectViewer(plan.agsdl.source, plan.agsdl);
  const flow = projectSystemOverview(projected.graphs[0], []);
  const step = "/flow/steps/intervention";
  const copy = (name: string) => expandedStepPath(step, `/compositions/assessment/steps/${name}`);
  const { cards, edges, frames } = expandCompositions(flow.cards, flow.edges, projected.graphs, new Set([step]), projected.declarations);

  expect(cards.some(card => card.path === step)).toBe(false);
  expect(frames).toEqual([{ path: step, title: "Préparer une intervention", entry: copy("review"), members: [copy("review"), copy("handoff"), copy("counterCheck"), copy("check")] }]);
  expect(cards.find(card => card.path === copy("review"))?.participant?.label).toBe("Concepteur de l’intervention");
  // A step that names its agent directly keeps it.
  expect(cards.find(card => card.path === copy("counterCheck"))?.participant?.label).toBe("Contre-expert");
  const routes = edges.filter(edge => edge.source.startsWith(step) || edge.target.startsWith(step)).map(edge => [edge.source, edge.target, edge.label]);
  expect(routes).toEqual(expect.arrayContaining([
    ["/flow/steps/decide", copy("review"), "intervenir"],
    [copy("counterCheck"), copy("check"), "next"],
    [copy("check"), "/flow/steps/operationsApproval", "true"],
    [copy("check"), "/flow/steps/escalation", "false"],
    [copy("review"), "/flow/steps/recovery", "onError"],
  ]));
  expect(routes.some(([source]) => source === step)).toBe(false);
  // The other uses of the same composition stay folded.
  expect(cards.some(card => card.path === "/flow/steps/observation")).toBe(true);
  expect(originalStepPath(copy("review"))).toBe("/compositions/assessment/steps/review");
});

const nestedSource = (task: Record<string, unknown> = {}, child: Record<string, unknown> = {}) => JSON.stringify({
  contract: "agsdl-0.3.0", id: "nested", agents: { worker: { harness: "example", permissions: "read-only", instructions: "Standing mission" } },
  flow: { entry: "before", onError: "recover", steps: {
    before: { type: "agent", agent: "worker", instance: "review", next: "use" },
    use: { type: "compose", composition: "parent", agents: { p: "worker" }, next: { done: { step: "after", message: { prompt: "Next mission" } } } },
    after: { type: "approval", next: { done: [] } }, recover: { type: "call", command: "echo recovered" },
  } },
  compositions: {
    parent: { parameters: ["p"], entry: "child", outputs: ["done"], steps: {
      child: { type: "compose", composition: "leaf", agents: { q: { parameter: "p" } }, next: { done: { output: "done" } }, ...child },
      ...(child.onError ? { parentRecovery: { type: "call", command: "echo parent", next: { output: "done" } } } : {}),
    } },
    leaf: { parameters: ["q"], entry: "work", outputs: ["done"], steps: {
      work: { type: "agent", agent: { parameter: "q" }, instance: "review", next: { output: "done" }, ...task },
      ...(task.onError ? { local: { type: "call", command: "echo local", next: { output: "done" } } } : {}),
    } },
  },
});
const use = "/flow/steps/use";
const childUse = expandedStepPath(use, "/compositions/parent/steps/child");
const workUse = expandedStepPath(childUse, "/compositions/leaf/steps/work");
const expandNested = (source: string) => {
  const projected = projectViewer(source), graph = projected.graphs[0];
  expect(graph.static030!.report.valid).toBe(true);
  const overview = projectSystemOverview(graph, []);
  return { projected, ...expandCompositions(overview.cards, overview.edges, projected.graphs, new Set([use, childUse]), projected.declarations) };
};

it("fixes probe 2 recursively, preserving outputs, messages, parameter bindings and source owners", () => {
  const { cards, frames, edges } = expandNested(nestedSource());
  expect(frames).toHaveLength(2);
  expect(frames.map(frame => frame.entry)).toEqual([workUse, workUse]);
  expect(frames[0].members).toEqual([workUse]);
  expect(cards.some(card => card.kind === "compose")).toBe(false);
  const work = cards.find(card => card.path === workUse)!;
  expect(work.participant?.target).toBe("/agents/worker");
  expect(work.mission).toBe("Standing mission");
  expect(work.edition030?.ownerPath).toBe("/compositions/leaf/steps/work");
  expect(originalStepPath(work.path)).toBe("/compositions/leaf/steps/work");
  expect(work.static030).toMatchObject({ occurrenceId: workUse, sourcePath: "/compositions/leaf/steps/work", address: ["use", "child", "work"] });
  expect(work.static030!.agent!.conversationKey).toBe(cards.find(card => card.path === "/flow/steps/before")!.static030!.agent!.conversationKey);
  expect(edges.find(edge => edge.source === "/flow/steps/before")?.target).toBe(workUse);
  expect(edges.find(edge => edge.source === workUse && edge.target === "/flow/steps/after")?.route030).toMatchObject({
    sourcePath: "/compositions/leaf/steps/work", sourceOccurrenceId: workUse, path: "/flow/steps/use/next/done", messageJson: '{"prompt":"Next mission"}',
    via: ["/compositions/leaf/steps/work/next", "/compositions/parent/steps/child/next/done", "/flow/steps/use/next/done"],
  });
  expect(edges.find(edge => edge.source === workUse && edge.label === "onError")?.target).toBe("/flow/steps/recover");
  expect(edges.filter(edge => edge.source === workUse && edge.label === "onError")).toHaveLength(1);
});

it("respects local errors and the nearest compose handler before propagating a handler's own failure", () => {
  const { edges, cards } = expandNested(nestedSource({ onError: "local" }, { onError: "parentRecovery" }));
  const local = expandedStepPath(childUse, "/compositions/leaf/steps/local");
  const parentRecovery = expandedStepPath(use, "/compositions/parent/steps/parentRecovery");
  const errors = edges.filter(edge => edge.route030?.role === "error").map(edge => [edge.source, edge.target]);
  expect(errors).toEqual(expect.arrayContaining([[workUse, local], [local, parentRecovery], [parentRecovery, "/flow/steps/recover"]]));
  expect(errors.filter(([from]) => from === workUse)).toEqual([[workUse, local]]);
  expect(errors.filter(([from]) => from === local)).toEqual([[local, parentRecovery]]);
  expect(cards.find(card => card.path === local)!.static030!.sourcePath).toBe("/compositions/leaf/steps/local");
});

it("leaves unopened descendants folded and guards invalid recursive composition drafts", () => {
  const projected = projectViewer(nestedSource());
  const overview = projectSystemOverview(projected.graphs[0], []);
  const folded = expandCompositions(overview.cards, overview.edges, projected.graphs, new Set([use]), projected.declarations);
  expect(folded.frames).toHaveLength(1);
  expect(folded.cards.some(card => card.path === childUse && card.kind === "compose")).toBe(true);
  const source = JSON.parse(nestedSource());
  source.compositions.leaf.steps.work = { type: "compose", composition: "parent", agents: { p: "worker" }, next: { done: { output: "done" } } };
  const draft = projectViewer(JSON.stringify(source));
  expect(draft.graphs[0].static030!.report.valid).toBe(false);
  const initial = projectSystemOverview(draft.graphs[0], []);
  const result = expandCompositions(initial.cards, initial.edges, draft.graphs, new Set([use, childUse, workUse]), draft.declarations);
  expect(result.frames).toHaveLength(2);
  expect(result.cards.some(card => card.path === workUse && card.kind === "compose")).toBe(true);
});

it("expands the exact two-level call-only probe without leaving a child compose card", () => {
  const raw = JSON.stringify({ contract: "agsdl-0.3.0", id: "probe-two", agents: {},
    flow: { entry: "use", steps: { use: { type: "compose", composition: "parent", next: { done: [] } } } },
    compositions: {
      parent: { entry: "child", steps: { child: { type: "compose", composition: "leaf", next: { done: { output: "done" } } } }, outputs: ["done"] },
      leaf: { entry: "work", steps: { work: { type: "call", command: "echo synthetic", next: { output: "done" } } }, outputs: ["done"] },
    },
  });
  const { cards, frames, edges } = expandNested(raw);
  expect(frames).toHaveLength(2);
  expect(cards.map(card => card.kind)).toEqual(["call"]);
  expect(cards[0].path).toBe(workUse);
  expect(edges).toEqual([]);
});

it("propagates errors from a composition's join, not from the join's branches", () => {
  const raw = JSON.stringify({ contract: "agsdl-0.3.0", id: "composed-join", agents: {},
    flow: { entry: "use", onError: "recover", steps: {
      use: { type: "compose", composition: "pipeline", next: { done: [] } }, recover: { type: "call", command: "echo recovered" },
    } },
    compositions: { pipeline: { entry: "split", outputs: ["done"], steps: {
      split: { type: "call", command: "echo split", next: ["left", "right"] },
      left: { type: "call", command: "echo left", next: "gather" }, right: { type: "call", command: "echo right", next: "gather" },
      gather: { type: "join", next: { output: "done" } },
    } } },
  });
  const { cards, edges, projected } = expandNested(raw);
  const path = (name: string) => expandedStepPath(use, `/compositions/pipeline/steps/${name}`);
  expect(projected.graphs[0].static030!.report.joins["use/gather"]).toEqual({ origin: "use/split", branches: ["left", "right"] });
  expect(edges.filter(edge => edge.route030?.inherited).map(edge => edge.source)).toEqual([path("split"), path("gather")]);
  expect(cards.find(card => card.path === path("gather"))!.static030!.join).toMatchObject({ originOccurrenceId: path("split") });
  expect(cards.find(card => card.path === path("left"))!.static030!.error).toEqual({ kind: "join", joinOccurrenceIds: [path("gather")] });
});

it("keeps repeated composition occurrences separate and reconnects loops to expanded entries", () => {
  const source = JSON.parse(nestedSource());
  source.flow.steps.use.next = { done: "second" };
  source.flow.steps.second = { type: "compose", composition: "parent", agents: { p: "worker" }, next: { done: "before" } };
  delete source.flow.steps.after;
  const projected = projectViewer(JSON.stringify(source)), graph = projected.graphs[0];
  expect(graph.static030!.report.valid).toBe(true);
  const overview = projectSystemOverview(graph, []);
  const second = "/flow/steps/second", child = expandedStepPath(second, "/compositions/parent/steps/child");
  const work = expandedStepPath(child, "/compositions/leaf/steps/work");
  const result = expandCompositions(overview.cards, overview.edges, projected.graphs, new Set([use, childUse, second, child]), projected.declarations);
  expect(result.frames).toHaveLength(4);
  expect(result.edges.some(edge => edge.source === workUse && edge.target === work)).toBe(true);
  expect(result.edges.some(edge => edge.source === work && edge.target === "/flow/steps/before")).toBe(true);
  expect(result.cards.filter(card => card.static030?.sourcePath === "/compositions/leaf/steps/work").map(card => card.path)).toEqual([workUse, work]);
  expect(result.cards.some(card => card.kind === "compose")).toBe(false);
  const paths = new Set(result.cards.map(card => card.path));
  expect(result.edges.every(edge => paths.has(edge.source) && paths.has(edge.target))).toBe(true);
  expect(new Set(result.edges.map(edge => edge.id)).size).toBe(result.edges.length);
  expect(overview.cards.some(card => card.path === use)).toBe(true);
  expect(graph.cards.find(card => card.path === use)!.branches[0].reference.target).toBe(second);
});

it("does not invent inherited errors for an unused template whose join boundaries are unreported", () => {
  const source = JSON.parse(nestedSource());
  delete source.flow;
  source.compositions.parent.steps.child.onError = "parentRecovery";
  source.compositions.parent.steps.parentRecovery = { type: "call", command: "echo recovery", next: { output: "done" } };
  source.compositions.leaf.steps = {
    split: { type: "call", command: "echo split", next: ["left", "right"] },
    left: { type: "call", command: "echo left", next: "gather" }, right: { type: "call", command: "echo right", next: "gather" },
    gather: { type: "join", next: { output: "done" } },
  };
  source.compositions.leaf.entry = "split";
  const projected = projectViewer(JSON.stringify(source));
  const graph = projected.graphs.find(graph => graph.path === "/compositions/parent")!;
  expect(graph.static030!.report.valid).toBe(true);
  const overview = projectSystemOverview(graph, []);
  const compose = "/compositions/parent/steps/child";
  const result = expandCompositions(overview.cards, overview.edges, projected.graphs, new Set([compose]), projected.declarations);
  expect(result.cards.find(card => card.id === "left")!.static030!.error.kind).toBe("unreported");
  expect(result.cards.find(card => card.id === "gather")!.static030!.join!.originOccurrenceId).toBeNull();
  expect(result.edges.some(edge => edge.route030?.inherited)).toBe(false);
});
