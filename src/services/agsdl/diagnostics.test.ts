import { expect, it } from "bun:test";
import { localizeDiagnostics } from "./diagnostics";
import { createExample } from "./examples";
import { projectViewer } from "./viewer";
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
