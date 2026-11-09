import { projectViewer030 } from './viewer030';
import { validateDocumentBytes } from './document';
import { describe, expect, it } from "bun:test";
import { blockDetails, durationText, edgeDetails, predicateText } from "./blockDetails";
import type { ViewerCard } from "./viewer";
import { isFailureEdge } from "./graphLayout";

const card = (kind: string, details: Record<string, unknown>, extra: Partial<ViewerCard> = {}): ViewerCard => ({
  path: `/flow/steps/${kind}`, id: kind, title: kind, kind, mission: "", unresolved: false, inputs: [], outputs: [], branches: [], details, ...extra,
});
const declaration = (path: string, title: string, details: Record<string, unknown> = {}): ViewerCard => ({
  path, id: path, title, kind: "Declaration", mission: "", unresolved: false, inputs: [], outputs: [], branches: [], details,
});

describe("block details read from AgSDL", () => {
  const declarations = [
    declaration("/configurations/project", "Project", { engine: "engine" }),
    declaration("/configurations/fast", "Fast"), declaration("/configurations/thorough", "Thorough"),
    declaration("/bindings/engine", "Engine title"), declaration("/bindings/tests", "Tests", { effects: "none" }),
  ];

  it("reads an agent's own instruction, configuration, tools, resources, results and visit limit", () => {
    const agent = card("agent", { maxVisits: 2, agentDefinition: { configuration: "project", prompt: [{ ref: "shared" }, { value: "Review the change." }] } }, {
      tools: [{ label: "Documentation", source: "unknown" }], capabilities: { skills: ["Evidence"], structuredResults: false, dynamicConfiguration: false, externalEffects: false },
      inputs: [{ name: "brief", type: "" }], outputs: [{ name: "report", type: "text/plain" }],
    });
    expect(blockDetails(agent, declarations)).toEqual([
      { key: "instructions", values: ["Review the change."] },
      { key: "model", values: ["Engine title"] },
      { key: "uses", values: ["Documentation", "Evidence"] },
      { key: "receives", values: ["brief"] },
      { key: "produces", values: ["report (text/plain)"] },
      { key: "limit", values: ["2"] },
    ]);
  });

  it("reads an agent declared outside any flow from its own definition", () => {
    const resident = { ...card("Agent", { configuration: "project", prompt: [{ value: "Answer the customer." }] }, {
      tools: [{ label: "tests", source: "unknown", target: "/bindings/tests" }], outputs: [{ name: "report", type: "text/plain" }],
    }), path: "/agents/resident" };
    expect(blockDetails(resident, declarations)).toEqual([
      { key: "instructions", values: ["Answer the customer."] },
      { key: "model", values: ["Engine title"] },
      { key: "uses", values: ["Tests"] },
      { key: "produces", values: ["report (text/plain)"] },
    ]);
  });

  it("describes a steering step by the step it steers, without a configuration or result of its own", () => {
    const write = { ...card("agent", {}), path: "/flow/steps/write", title: "Write the dossier" };
    const steer = card("agent", { delivery: "steering", steers: "write", agentDefinition: { configuration: "project", prompt: [{ value: "Write." }] } }, {
      inputs: [{ name: "guidance", type: "" }], outputs: [{ name: "report", type: "text/plain" }],
    });
    expect(blockDetails(steer, declarations, [write])).toEqual([
      { key: "steers", values: ["Write the dossier"] },
    ]);
  });

  it("shows a configuration chosen at start as its selector and cases", () => {
    const agent = card("agent", { agentDefinition: { configuration: { select: { path: ["resources", "mode", "value"] }, cases: { a: "fast", b: "thorough" } } } });
    expect(blockDetails(agent, declarations).find(item => item.key === "model")?.values).toEqual(["resources.mode.value → Fast | Thorough"]);
    const deep = card("agent", { agentDefinition: { configuration: "deep" } });
    expect(blockDetails(deep, [declaration("/configurations/deep", "Deep", { engine: "engine", model: { identity: "claude-opus-5-5", version: "1" } })])
      .find(item => item.key === "model")?.values).toEqual(["claude-opus-5-5"]);
  });

  it("reads call arguments and declared effects, unknown when omitted", () => {
    expect(blockDetails(card("call", { binding: "tests", arguments: { suite: { value: "portal" }, input: { path: ["data", "report"] } } }), declarations)).toEqual([
      { key: "arguments", values: ['suite = "portal"', "input = data.report"] },
      { key: "effect", values: ["none"] },
    ]);
    expect(blockDetails(card("call", { binding: "missing" }), declarations)).toEqual([{ key: "effect", values: ["unknown"] }]);
    const deploy = card("call", { binding: "tests", scope: { action: "deploy", resources: ["service:catalog-api"], context: { path: [] } } });
    expect(blockDetails(deploy, declarations).slice(1)).toEqual([
      { key: "action", values: ["deploy"] }, { key: "targets", values: ["service:catalog-api"] }, { key: "context", values: ["input"] },
    ]);
    const publish = card("call", { scope: { action: "publish", resources: [], context: { value: { release: "1.8.0", targets: ["web"] } } } });
    expect(blockDetails(publish, declarations).at(-1)).toEqual({ key: "context", values: ['release = "1.8.0"', 'targets = ["web"]'] });
  });

  it("reads approval timings, condition tests and join rules", () => {
    expect(blockDetails(card("approval", { timeoutMs: 3600000, validForMs: 900000 }), declarations)).toEqual([
      { key: "timeout", values: ["1 h"] }, { key: "validity", values: ["15 min"] },
    ]);
    expect(predicateText({ all: [{ equals: [{ path: ["data", "exitCode"] }, { value: 0 }] }, { not: { equals: [{ path: ["text"] }, { value: "" }] } }] }))
      .toBe('data.exitCode = 0 ∧ ¬(text = "")');
    expect(blockDetails(card("join", { mode: "first", remaining: "finish", accept: { equals: [{ path: ["choice"] }, { value: "ok" }] } }), declarations)).toEqual([
      { key: "mode", values: ["first", "remaining: finish"] }, { key: "accept", values: ['choice = "ok"'] },
    ]);
    const launch = { ...card("prepare", {}), path: "/flow/steps/launch", title: "Open the investigations" };
    expect(blockDetails(card("join", { after: "launch" }), declarations, [launch])[0]).toEqual({ key: "after", values: ["Open the investigations"] });
    expect(durationText(45000)).toBe("45 s");
    // An approval shows what it authorizes: the scope of the step it calls.
    const release = card("agent", { scope: { action: "release", resources: ["repository:portal/main"] } }, { id: "release" });
    expect(blockDetails(card("approval", { call: "release", timeoutMs: 3600000 }), declarations, [release])).toEqual([
      { key: "timeout", values: ["1 h"] }, { key: "action", values: ["release"] }, { key: "targets", values: ["repository:portal/main"] },
    ]);
  });

  it("describes a connection by its rule and payload, never by its ends", () => {
    const base = { id: "e", source: "a", target: "b", dependency: false };
    expect(edgeDetails({ ...base, label: "accept", transfers: ["completion"] })).toEqual({ route: "choice", choice: "accept", transmits: ["completion"] });
    expect(edgeDetails({ ...base, label: "onError" }).route).toBe("error");
    expect(edgeDetails({ ...base, label: "approved" }).route).toBe("approved");
    expect(edgeDetails({ ...base, label: "next" }).route).toBe("next");
    for (const key of ["onError", "next", "success", "true", "false", "approved", "denied"]) {
      const edge = { ...base, label: key, route030: { role: "normal" as const, path: `/next/${key}`, sourcePath: "/a", key, targetKind: "step" as const } };
      expect(edgeDetails(edge)).toEqual({ route: "choice", choice: key, transmits: [] });
      expect(isFailureEdge(edge)).toBe(false);
    }
    const failure = { ...base, label: "onError", route030: { role: "error" as const, path: "/onError", sourcePath: "/a", targetKind: "step" as const } };
    expect(edgeDetails(failure).route).toBe("error");
    expect(isFailureEdge(failure)).toBe(true);
    expect(isFailureEdge({ ...base, label: "onError" })).toBe(true);
  });

  it("preserves the exact 0.3 visit limit only in advanced details", () => {
    const join = card("join", { quorum: { count: 2 }, maxVisits: 9007199254740992 }, {
      edition030: { sourceJson: "{}", maxVisitsJson: "9007199254740993", routes: [] },
    });

    expect(blockDetails(join, declarations)).toContainEqual({ key: "limit", values: ["9007199254740993"], advanced: true });
  });
});

it('explains source-bound quorum, origin, remaining and error scope without run state', () => {
  const source = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'business', agents: { a: { harness: 'example', permissions: 'read-only' } },
    flow: { entry: 'split', onError: 'recover', steps: {
      split: { type: 'call', title: 'Open review', command: 'echo ok', next: ['left','right'] },
      left: { type: 'agent', agent: 'a', instance: 'new', next: { approve: 'join', reject: 'join' } },
      right: { type: 'agent', agent: 'a', instance: 'new', next: { approve: 'join', reject: 'join' } },
      join: { type: 'join', quorum: { count: 2, accept: ['approve'] }, remaining: 'finish', next: { reached: [], missed: [] } },
      recover: { type: 'call', command: 'echo recover' },
    } } });
  const report = validateDocumentBytes(new TextEncoder().encode(source));
  expect(report.valid).toBe(true);
  const projected = projectViewer030(source, undefined, { source, report });
  const cards = projected.graphs[0].cards;
  const details = blockDetails(cards.find(card=>card.id==='join')!, [], cards);
  expect(details).toContainEqual({ key: 'mode', values: [], message030: 'quorum.rule', params030: { threshold: '2' } });
  expect(details.find(detail=>detail.message030==='join.origin')?.params030).toEqual({ name: 'Open review' });
  expect(details.some(detail=>detail.message030==='remaining.finish')).toBe(true);
  expect(blockDetails(cards.find(card=>card.id==='left')!, [], cards).some(detail=>detail.message030==='error.join')).toBe(true);
  expect(blockDetails(cards[0], [], cards).some(detail=>detail.message030==='error.flow')).toBe(true);
  const stale = projectViewer030(source).graphs[0].cards;
  expect(blockDetails(stale.find(card=>card.id==='join')!, [], stale).some(detail=>detail.message030==='join.unreported')).toBe(true);
  expect(details.some(detail=>detail.values.some(value=>value.includes('active')))).toBe(false);
});
