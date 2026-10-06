import { describe, expect, it } from "bun:test";
import { projectViewer } from "./viewer";
import { presentGraph } from "./graphPresentation";
import { projectSystemOverview } from "./systemOverview";
import { agentConfigurations, outputRecipients } from "./agentDetails";
import { projectDocument } from "./projection";
import { componentFields, componentChanges } from "./componentFields";
import { componentProperties, propertyChanges } from "./componentProperties";
import { validateDocument } from "./document";

const document = () => ({
  contract: "agsdl-0.2.0", id: "review-system",
  content: { brief: { value: "Review the change." }, image: { uri: "diagram.png", mediaType: "image/png" } },
  bindings: { engine: { contract: { identity: "example/engine", version: "1" }, implementation: { identity: "example/runtime", version: "2" } },
    check: { contract: { identity: "example/check", version: "1" }, implementation: { identity: "example/checker", version: "3" }, settings: { sandbox: true } } },
  configurations: { review: { engine: "engine", tools: { verify: "check" }, settings: { temperature: 0 } }, alternate: { engine: "engine" } },
  skills: { reviewing: { prompt: [{ value: "Use the evidence." }] } },
  agents: { reviewer: { configuration: "review", skills: ["reviewing"], prompt: [{ ref: "brief" }, { ref: "image" }],
    resources: { diagram: { ref: "image" } }, interface: { results: { report: { mediaTypes: ["application/json"] } } } } },
  compositions: { verify: { agentParameters: ["worker"], entry: "review", outputs: ["pass"], steps: {
    review: { type: "agent", agent: { parameter: "worker" }, next: [{ output: "pass" }] },
  } } },
  flow: { entry: "prepare", steps: {
    prepare: { type: "prepare", message: { prompt: [{ value: "Inspect the result." }], resources: { report: { source: { path: ["results", "report"] } } } }, next: ["review"] },
    review: { type: "agent", agent: "reviewer", next: ["condition"], onError: ["error"] },
    condition: { type: "condition", test: { equals: [{ path: ["text"] }, { value: "ok" }] }, next: { true: ["fork"], false: ["again"] } },
    again: { type: "agent", agent: "reviewer", next: ["fork"] },
    fork: { type: "prepare", message: {}, next: ["left", "right"] },
    left: { type: "call", binding: "check", next: ["join"] }, right: { type: "agent", agent: "reviewer", next: ["join"] },
    join: { type: "join", after: "fork", members: ["left", "right"], next: ["gate"] },
    gate: { type: "approval", call: "publish", binding: "check", timeoutMs: 1000, validForMs: 1000, next: { approved: ["publish"], denied: ["error"] } },
    publish: { type: "call", binding: "check", next: ["compose"] },
    compose: { type: "compose", composition: "verify", agents: { worker: "reviewer" }, next: { pass: [] } },
    error: { type: "prepare", message: {} },
  } },
});
const source = () => JSON.stringify(document());

describe("AgSDL 0.2 reading projection", () => {
  it("keeps repeated visits separate from the persistent participant and shared configuration", () => {
    const viewer = projectViewer(source());
    const visits = viewer.graphs[0].cards.filter(card => card.kind === "agent");
    expect(visits.map(card => card.path)).toEqual(["/flow/steps/review", "/flow/steps/again", "/flow/steps/right"]);
    expect(visits.map(card => card.participant?.target)).toEqual(Array(3).fill("/agents/reviewer"));
    expect(viewer.declarations.filter(card => card.kind === "Agent")).toHaveLength(1);
    expect(visits[0].mission).toBe("Use the evidence.\n\nReview the change.");
    expect(visits[0].mission).not.toContain("diagram.png");
    expect(visits[0].inputs[0].binding?.target).toBe("/content/image");
    expect(visits[0].outputs).toEqual([{ name: "report", type: "application/json" }]);
    expect(agentConfigurations(source(), visits[0])).toMatchObject([{ id: "review", selected: true, engine: "example/runtime · 2", parameters: { temperature: 0 }, tools: [{ reference: { label: "verify", target: "/bindings/check" } }] }]);
  });
  it("projects all seven authored types and unique fan-out/error routes without guessed exchanges", () => {
    const viewer = projectViewer(source());
    const graph = viewer.graphs[0];
    expect(new Set(graph.cards.map(card => card.kind))).toEqual(new Set(["agent", "prepare", "condition", "call", "join", "approval", "compose"]));
    const overview = projectSystemOverview(graph, viewer.declarations);
    expect(presentGraph(overview.cards, overview.edges, new Set(), "exchanges").edges.length).toBeGreaterThan(0);
    const fork = overview.edges.filter(edge => edge.source === "/flow/steps/fork");
    expect(fork.map(edge => edge.id)).toEqual(["/flow/steps/fork/next/0", "/flow/steps/fork/next/1"]);
    expect(fork.map(edge => edge.target)).toEqual(["/flow/steps/left", "/flow/steps/right"]);
    expect(overview.edges.find(edge => edge.id === "/flow/steps/review/onError/0")?.target).toBe("/flow/steps/error");
    expect(overview.edges.find(edge => edge.source === "/flow/steps/condition" && edge.target === "/flow/steps/again")?.transfers).toEqual(["resources.result ← text · text/plain"]);
    expect(overview.edges.find(edge => edge.id === "/flow/steps/review/onError/0")?.transfers).toEqual(["error"]);
    expect(overview.edges.some(edge => edge.transfers?.includes("report"))).toBe(false);
    expect(outputRecipients(graph.cards[1], graph.cards, "report")).toEqual([]);
    expect(projectDocument(source(), "process").edges.map(edge => edge.id)).toEqual(overview.edges.map(edge => edge.id));
    const prepared = graph.cards[0];
    expect(prepared.inputs[0].binding).toMatchObject({ source: "unknown" });
    expect(prepared.inputs[0].binding?.target).toBeUndefined();
    expect(graph.cards.find(card => card.id === "again")?.flowInputs).toMatchObject([{ origin: "agent", reference: { target: "/flow/steps/review" }, projection: "resources.result ← text · text/plain" }]);
  });
  it("retains Call data through Condition and Join members through approval without promoting them to prompts", () => {
    const doc = document();
    (doc as Record<string, unknown>).flow = { entry: "call", steps: {
      call: { type: "call", binding: "check", next: ["condition"] },
      condition: { type: "condition", test: { equals: [{ path: ["data"] }, { value: true }] }, next: { true: ["worker"], false: [] } },
      worker: { type: "agent", agent: "reviewer" },
    } };
    const viewer = projectViewer(JSON.stringify(doc));
    expect(viewer.graphs[0].cards[2].flowInputs).toMatchObject([{ origin: "call", reference: { target: "/flow/steps/call" }, projection: "resources.result ← data · application/json" }]);
    const graph = projectViewer(source()).graphs[0];
    expect(graph.cards.find(card => card.id === "publish")?.flowInputs).toMatchObject([{ origin: "join", reference: { target: "/flow/steps/join" }, projection: "members" }]);
    expect(graph.cards.find(card => card.id === "publish")?.branches[0].transfers).toEqual(["data"]);
  });
  it("links an exact prepared result selector to its unique declared producer, leaving multiple producers ambiguous", () => {
    const doc = document();
    const steps = {
      entry: { type: "prepare", message: {}, next: ["first"] },
      first: { type: "agent", agent: "reviewer", next: ["selected"] },
      second: { type: "agent", agent: "reviewer", next: ["selected"] },
      selected: { type: "prepare", message: { resources: { evidence: { source: { path: ["results", "report"] } } } }, next: ["receiver"] },
      receiver: { type: "agent", agent: "reviewer" },
    };
    (doc as Record<string, unknown>).flow = { entry: "entry", steps };
    let graph = projectViewer(JSON.stringify(doc)).graphs[0];
    expect(graph.cards[3].inputs[0].binding).toMatchObject({ source: "step", target: "/flow/steps/first", port: "report" });
    expect(outputRecipients(graph.cards[1], graph.cards, "report").map(item => [item.card.id, item.port])).toEqual([["selected", "evidence"]]);
    expect(graph.cards[4].flowInputs).toMatchObject([{ origin: "prepare", projection: "Message", reference: { target: "/flow/steps/selected" } }]);
    steps.entry.next = ["first", "second"];
    graph = projectViewer(JSON.stringify(doc)).graphs[0];
    expect(graph.cards[3].inputs[0].binding?.target).toBeUndefined();
    expect(outputRecipients(graph.cards[1], graph.cards, "report")).toEqual([]);
    steps.entry.next = ["first"];
    steps.selected.message.resources.evidence.source.path = ["results", "absent"];
    graph = projectViewer(JSON.stringify(doc)).graphs[0];
    expect(graph.cards[3].inputs[0].binding?.port).toBeUndefined();
    expect(outputRecipients(graph.cards[1], graph.cards, "report")).toEqual([]);
  });
  it("distinguishes a decision choice named onError from the actual error continuation", async () => {
    const serialized = JSON.stringify({
      contract: "agsdl-0.2.0", id: "decision-routes",
      bindings: { engine: { contract: { identity: "example/engine", version: "1" }, implementation: { identity: "example/runtime", version: "1" } } },
      configurations: { main: { engine: "engine" } }, agents: { reviewer: { configuration: "main" } },
      flow: { entry: "review", steps: {
        review: { type: "agent", agent: "reviewer", decision: { binding: "engine", choices: ["onError"] }, next: { onError: ["receiver"] }, onError: ["handler"] },
        receiver: { type: "agent", agent: "reviewer" }, handler: { type: "agent", agent: "reviewer" },
      } },
    });
    expect((await validateDocument(serialized))[0].results[0].verdict).toBe("pass");
    const graph = projectViewer(serialized).graphs[0];
    expect(graph.cards[1].flowInputs).toMatchObject([{ origin: "agent", projection: "resources.result ← text · text/plain" }]);
    expect(graph.cards[2].flowInputs).toMatchObject([{ origin: "error", projection: "resources.error ← error · application/json" }]);
    expect(graph.cards[0].branches.map(branch => [branch.path, branch.transfers])).toEqual([
      ["/flow/steps/review/next/onError/0", ["resources.result ← text · text/plain"]],
      ["/flow/steps/review/onError/0", ["resources.error ← error · application/json"]],
    ]);
  });
  it("keeps prepared literal values and literal sources independent of the incoming producer", async () => {
    const serialized = JSON.stringify({
      contract: "agsdl-0.2.0", id: "prepared-literals",
      bindings: { engine: { contract: { identity: "example/engine", version: "1" }, implementation: { identity: "example/runtime", version: "1" } } },
      configurations: { main: { engine: "engine" } }, agents: { reviewer: { configuration: "main" } },
      flow: { entry: "review", steps: {
        review: { type: "agent", agent: "reviewer", next: ["prepared"] },
        prepared: { type: "prepare", message: { resources: {
          constant: { select: { value: "constant" } },
          image: { source: { value: { uri: "https://example.com/image.png", mediaType: "image/png" } } },
          inline: { source: { value: { value: "fixed text", mediaType: "text/plain" } } },
          response: { select: { path: ["text"] } },
        } } },
      } },
    });
    expect((await validateDocument(serialized))[0].results[0].verdict).toBe("pass");
    const inputs = projectViewer(serialized).graphs[0].cards[1].inputs;
    expect(inputs[0].binding).toEqual({ label: "constant", source: "literal" });
    expect(inputs[1]).toMatchObject({ type: "image/png", binding: { label: "https://example.com/image.png", source: "unknown" } });
    expect(inputs[1].binding?.target).toBeUndefined();
    expect(inputs[2]).toMatchObject({ type: "text/plain", binding: { label: "fixed text", source: "literal" } });
    expect(inputs[2].binding?.target).toBeUndefined();
    expect(inputs[3].binding?.target).toBe("/flow/steps/review");
  });
  it("keeps a normal decision named failure distinct from onError routing", () => {
    const doc = document();
    (doc.flow.steps.review as Record<string, unknown>).next = { failure: ["condition"] };
    const viewer = projectViewer(JSON.stringify(doc));
    expect(projectSystemOverview(viewer.graphs[0], viewer.declarations).edges.filter(edge => edge.source === "/flow/steps/review").map(edge => edge.label)).toEqual(["failure", "onError"]);
  });
  it("shows authored compositions with parameter references and explicit exports without cloning agents", () => {
    const viewer = projectViewer(source());
    expect(viewer.graphs).toHaveLength(2);
    const body = viewer.graphs[1];
    expect(body.path).toBe("/compositions/verify");
    expect(body.cards[0].participant).toEqual({ label: "worker", source: "unknown", unresolved: false });
    expect(body.cards[0].branches[0].reference).toEqual({ label: "pass", source: "unknown", unresolved: false });
    expect(agentConfigurations(source(), body.cards[0])).toEqual([]);
    expect(viewer.graphs[0].cards.find(card => card.kind === "compose")?.composition?.target).toBe("/compositions/verify");
  });
  it("keeps graphless documents graphless, including unused composition declarations", () => {
    const doc: Record<string, unknown> = document(); delete doc.flow;
    const viewer = projectViewer(JSON.stringify(doc));
    expect(viewer.graphs).toEqual([]);
    expect(projectSystemOverview(undefined, viewer.declarations.filter(card => card.kind === "Agent")).edges).toEqual([]);
    expect(viewer.declarations.some(card => card.kind === "Composition")).toBe(true);
  });
  it("does not pick a dynamic configuration before initialization", () => {
    const doc = document();
    (doc.agents.reviewer as Record<string, unknown>).configuration = { select: { path: ["resources", "mode", "value"] }, cases: { first: "review", other: "alternate" } };
    const serialized = JSON.stringify(doc);
    const agent = projectViewer(serialized).declarations[0];
    expect(agentConfigurations(serialized, agent).map(config => [config.id, config.selected])).toEqual([["review", false], ["alternate", false]]);
  });
  it("retains unresolved references and never edits closed 0.2 shapes with 0.1 annotations", () => {
    const doc = document(); doc.flow.steps.review.agent = "missing"; doc.flow.steps.review.next = ["absent"];
    const serialized = JSON.stringify(doc);
    const card = projectViewer(serialized).graphs[0].cards[1];
    expect(card.participant).toMatchObject({ unresolved: true, target: undefined });
    expect(card.branches[0].reference).toMatchObject({ unresolved: true, target: undefined });
    const fields = componentFields(serialized, card), properties = componentProperties(serialized, card);
    expect(componentChanges(fields, [])).toEqual([]);
    expect(propertyChanges(properties.fields, [])).toEqual([]);
  });
  it("reads display names from the editor envelope without changing identities or source content", () => {
    const serialized = source();
    const viewer = projectViewer(serialized, { display: { title: "Review", cards: { "/agents/reviewer": { title: "Reviewer", macroLegacyNodeId: "legacy-review" }, "/flow/steps/review": { title: "First review" } } } });
    expect(viewer.title).toBe("Review");
    expect(viewer.graphs[0].cards[1]).toMatchObject({ path: "/flow/steps/review", id: "review", title: "First review", participant: { target: "/agents/reviewer" } });
    expect(viewer.graphs[0].cards[1].details.displayAnnotations).toMatchObject({ macroLegacyNodeId: "legacy-review" });
    expect(viewer.graphs[0].cards[1].participant?.label).toBe("Reviewer");
    expect(JSON.parse(serialized)).not.toHaveProperty("annotations");
  });
});
