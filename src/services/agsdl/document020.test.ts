import { describe, expect, it } from "bun:test";
import { applyChanges, sourceAt, validateDocument } from "./document";
import { read } from "../../vendor/agsdl/v0.2/reader.mjs";
import { stringify } from "../../vendor/agsdl/v0.2/values.mjs";
import { localizeDiagnostics } from "./diagnostics";
import type { ViewerCard } from "./viewer";

const source = (changes: Record<string, unknown> = {}) => JSON.stringify({
  contract: "agsdl-0.2.0", id: "review",
  bindings: { macro: { contract: { identity: "macro/agent-engine", version: "1" }, implementation: { identity: "macro/desktop", version: "1" } } },
  configurations: { main: { engine: "macro" } },
  agents: { reviewer: { configuration: "main", prompt: [{ value: "Review the change." }] } },
  flow: { entry: "review", steps: { review: { type: "agent", agent: "reviewer", next: [] } } },
  ...changes,
});
const report = (text: string) => read(new TextEncoder().encode(text));

describe("published AgSDL 0.2.0 reader", () => {
  it("keeps validity, scope and execution support separate", async () => {
    const [normalized] = await validateDocument(source(), { historical: "{}" });
    expect(normalized.results[0].verdict).toBe("pass");
    expect(normalized.contract).toBe("agsdl-0.2.0");
    expect(normalized.executionSupport).toBe("not-assessed");
    expect(normalized.scope).toBe("document-shape-and-declared-references");
    expect(normalized.annexesAssessment).toBe("not-used-by-contract");
    expect(normalized.documentReportJson).toBe(stringify(report(source())));
  });

  it("does not accept historical or experimental shapes as the official contract", async () => {
    expect(report(source({ annotations: {} })).valid).toBe(false);
    expect(report(source({ contract: "agsdl-exp-flow-0.2-c1" })).findings).toEqual([{ code: "SHAPE", path: "" }]);
    const [unsupported] = await validateDocument(source({ contract: "agsdl-9.0.0" }));
    expect(unsupported.contract).toBe("agsdl-9.0.0");
    expect(unsupported.scope).toBe("unsupported-contract");
    expect(unsupported.results[0].findings[0].rule).toBe("UNSUPPORTED_CONTRACT");
  });

  it("checks declaration references, routes and collisions", () => {
    const invalid = source({
      skills: { shared: { resources: { context: { value: "one" } } } },
      agents: { reviewer: { configuration: "missing", skills: ["shared"], resources: { context: { value: "two" } } } },
      flow: { entry: "review", steps: { review: { type: "agent", agent: "reviewer", next: ["missing"] } } },
    });
    expect(report(invalid).valid).toBe(false);
    expect(report(invalid).findings.map(f => f.code)).toContain("REFERENCE");
    expect(report(invalid).findings.map(f => f.code)).toContain("RESOURCE_COLLISION");
  });

  it("retains URI uncertainty without fetching or taking the workspace as an implicit base", () => {
    const raw = report(source({ content: { instructions: { uri: "./instructions.md" } } }));
    expect(raw.valid).toBe(true);
    expect(raw.sources).toEqual([{ path: "/content/instructions", baseUri: null, uri: "./instructions.md", resolved: null, status: "unresolved" }]);
    expect(raw.unassessed).toEqual(["/content/instructions"]);
    const explicit = report(source({ baseUri: "file:///workspace/", content: { instructions: { uri: "./instructions.md" } } }));
    expect(explicit.sources).toEqual([{ path: "/content/instructions", baseUri: "file:///workspace/", uri: "./instructions.md", resolved: "file:///workspace/instructions.md", status: "resolved" }]);
  });

  it("preserves opaque numeric tokens in source edits and official report evidence", async () => {
    const original = source({ content: { opaque: { value: 1 } } }).replace('"value":1', '"value":900719925474099312345');
    const edited = applyChanges(original, [{ op: "set", path: "/agents/reviewer/prompt/0/value", valueJson: '"Vérifier les accents."' }]);
    expect(sourceAt(edited, "/content/opaque/value")).toBe("900719925474099312345");
    expect(report(edited).valid).toBe(true);
    expect(() => applyChanges(edited, [{ op: "set", path: "/contract", valueJson: '"agsdl-0.1.0"' }])).toThrow("edition change");
    const large = source({ bindings: { macro: { contract: { identity: "example/engine", version: "1" }, implementation: { identity: "example/engine", version: "1" }, requires: [{ contract: { identity: "example/requirement", version: "1" }, parameters: { budget: 1 } }] } } }).replace('"budget":1', '"budget":1.000e+999');
    const [normalized] = await validateDocument(large);
    expect(normalized.documentReportJson).toContain('"budget":1.000e+999');
  });

  it("rejects duplicate decoded keys and malformed Unicode in the byte scanner", async () => {
    for (const raw of ['{"id":"one","\\u0069d":"two"}', '"\\ud800"', '\uFEFF{}']) {
      const [normalized] = await validateDocument(raw);
      expect(normalized.scope).toBe("parse");
      expect(normalized.results[0].findings[0].rule).toBe("PARSE");
    }
    expect(read(new Uint8Array([34, 255, 34])).findings).toEqual([{ code: "PARSE", path: "" }]);
  });

  it("runs in a browser without Buffer or Node APIs", () => {
    const previous = globalThis.Buffer;
    try {
      globalThis.Buffer = undefined as unknown as typeof Buffer;
      expect(report(source()).valid).toBe(true);
    } finally { globalThis.Buffer = previous; }
  });

  it("localizes configuration failures to every use of its persistent agent", async () => {
    const original = source({ configurations: { main: { engine: "missing" } } });
    const cards: ViewerCard[] = ["review", "second-review"].map(id => ({
      path: `/flow/steps/${id}`, id, title: id, kind: "invoke", mission: "", unresolved: false,
      inputs: [], outputs: [], branches: [], details: { agent: "reviewer" },
    }));
    cards.push({ path: "/agents/reviewer", id: "reviewer", title: "reviewer", kind: "Agent", mission: "", unresolved: false, inputs: [], outputs: [], branches: [], details: { agentName: "reviewer" } });
    const diagnostics = localizeDiagnostics(original, await validateDocument(original), cards);
    expect(diagnostics.find(f => f.path === "/configurations/main/engine")?.targets).toEqual(cards.map(c => c.path));
  });
});
