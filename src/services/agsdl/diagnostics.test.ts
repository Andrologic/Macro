import { expect, it } from "bun:test";
import { localizeDiagnostics } from "./diagnostics";
import { createLegacyExample as createExample } from "./examples";
import { projectViewer } from "./viewer";
import { rememberSourceLocations } from "./reader030WorkerProtocol";
import { scanSource } from "./document";
import type { AgsdlReport } from "../../types/agsdl";

it("localizes UTF-8 byte offsets, relations and deferrals without inventing ambiguous targets", () => {
  const doc = JSON.parse(createExample("release"));
  doc.root.annotations = { title: "Été" };
  doc.unresolved = [{ subject: doc.graphs[0].steps[0].agent, rule: "deferred", obligation: "interface" }];
  const source = JSON.stringify(doc);
  const view = projectViewer(source);
  const cards = [...view.graphs[0].cards, ...view.declarations];
  const path = "/graphs/0/steps/0/agent/id";
  const report: AgsdlReport = { operation: "inspect", results: [{ input: "primary", unit: "test", verdict: "fail", findings: [
    { rule: "byte", outcome: "fail", details: "Byte", location: { byte: scanSource(source).spans.get(path)!.start } },
    { rule: "relation", outcome: "fail", details: "Relation", location: { pointer: "/relations/0/target" } },
    { rule: "missing", outcome: "fail", details: "Unknown", location: { pointer: "/graphs/999" } },
  ] }, { input: "annex", unit: "test", verdict: "fail", findings: [{ rule: "annex", outcome: "fail", details: "Other source", location: { pointer: path } }] }] };
  rememberSourceLocations(report, source, scanSource(source).spans);
  const issues = localizeDiagnostics(source, [report], cards);
  expect(issues).toHaveLength(5);
  expect(issues[0].path).toBe(path);
  expect(issues[0].targets).toContain("/graphs/0/steps/0");
  expect(issues[1].targets).toContain("/graphs/0/steps/0");
  expect(issues[2].targets).toEqual([]);
  expect(issues[3].targets).toEqual([]);
  expect(issues[4].targets).toContain("/graphs/0/steps/0");
  doc.definitions.push(structuredClone(doc.definitions.find((definition: { key: unknown }) => JSON.stringify(definition.key) === JSON.stringify(doc.unresolved[0].subject))));
  const ambiguousSource = JSON.stringify(doc);
  expect(localizeDiagnostics(ambiguousSource, [], projectViewer(ambiguousSource).graphs[0].cards)[0].targets).toEqual([]);
});

it("retains root, hidden scope, missing property and module diagnostics with recoverable owners", async () => {
  const { diagnosticOwner030 } = await import("./diagnostics");
  const source = '{"contract":"agsdl-0.3.0","id":"x","agents":{"a":{"harness":"unknown","permissions":"read-only"}},"flow":{"entry":"a","steps":{"a":{"type":"agent","agent":"a"}}},"compositions":{"hidden":{"entry":"x","steps":{},"outputs":[]}}}';
  const view = projectViewer(source), cards = [...view.declarations, ...view.graphs.flatMap(graph => graph.cards)];
  const findings = [
    { rule: "SCHEMA", path: "" },
    { rule: "ROUTES", path: "/flow/entry" },
    { rule: "REFERENCE", path: "/compositions/hidden/entry" },
    { rule: "HARNESS_UNVERIFIED", path: "/agents/a/harness" },
    { rule: "SCHEMA", path: "/agents/a/instructions" },
  ];
  const report: AgsdlReport = { operation: "validate", results: [{ input: "primary", unit: "document", verdict: "fail", findings: findings.map(({ rule, path }) => ({ rule, details: rule, outcome: "fail", severity: rule === "HARNESS_UNVERIFIED" ? "warning" : "error", location: { pointer: path } })) }] };
  rememberSourceLocations(report, source, scanSource(source).spans);
  const issues = localizeDiagnostics(source, [report], cards);
  expect(issues).toHaveLength(5);
  expect(issues.map(issue => diagnosticOwner030(source, issue, cards).path)).toEqual(["agsdl:document", "/flow", "/compositions/hidden", "/agents/a", "/agents/a"]);
  expect(issues[3].targets).toEqual(["/agents/a"]);
  expect(issues[3].severity).toBe("warning");
});
it("retains parse findings and uses the document as correction context for unreadable source", async () => {
  const { diagnosticOwner030 } = await import("./diagnostics");
  const report: AgsdlReport = { operation: "readDocument", results: [{ input: "primary", unit: "document", verdict: "fail", findings: [{ rule: "PARSE", details: "Invalid JSON", outcome: "fail", severity: "error", location: { pointer: "" } }] }] };
  const issues = localizeDiagnostics("{broken", [report], []);
  expect(issues[0].details).toBe("Invalid JSON");
  expect(diagnosticOwner030("{broken", issues[0], []).edition030?.ownerPath).toBe("");
});
