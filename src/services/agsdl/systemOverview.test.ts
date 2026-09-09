import { describe, expect, it } from "bun:test";
import { projectSystemOverview } from "./systemOverview";
import { projectViewer } from "./viewer";
import { createExample } from "./examples";

const document = () => JSON.parse(createExample("release"));
const overview = (doc = document()) => projectSystemOverview(projectViewer(JSON.stringify(doc)).graphs[0], []);
describe("system overview", () => {
  it("shows declared inputs, data handoffs and returned results instead of operational terminals", () => {
    const result = overview();
    expect(result.cards.map(card => card.kind)).toEqual(["input", "invoke", "invoke", "invoke", "output"]);
    expect(result.cards[0].inputs.map(port => port.name)).toEqual(["brief", "context"]);
    expect(result.cards[4].outputs[0].binding?.port).toBe("report");
    expect(result.edges.some(edge => edge.label === "failure")).toBe(false);
    expect(result.edges.filter(edge => !edge.exchangeOnly)).toHaveLength(4);
    expect(result.edges.find(edge => edge.source === result.cards[1].path && edge.target === result.cards[2].path)?.transfers).toEqual(["report"]);
    expect(result.edges.filter(edge => edge.exchangeOnly).every(edge => edge.transfers?.includes("context"))).toBe(true);
  });
  it("does not call a control route a data transfer when no binding proves it", () => {
    const doc = document();
    doc.graphs[0].steps[1].bindings.brief = { literal: "Independent brief" };
    const result = overview(doc);
    expect(result.edges.find(edge => edge.source === result.cards[1].path && edge.target === result.cards[2].path)?.transfers).toBeUndefined();
    doc.graphs[0].steps[1].bindings.brief = { step: "checklist", port: "missing" };
    expect(overview(doc).edges.filter(edge => edge.transfers?.includes("missing"))).toEqual([]);
  });
  it("keeps an approval gate and its named approver without implying a data shortcut", () => {
    const doc = document();
    const root = doc.root.key;
    const approver = { ...root, id: "release-owner" };
    const requirement = { ...root, id: "release-approval" };
    doc.definitions.push({ key: approver, kind: "Principal", owner: root, annotations: { title: "Release owner" }, payload: {} });
    doc.definitions.push({ key: requirement, kind: "ApprovalRequirement", owner: root, payload: { approvers: [approver], validForMs: 60000 } });
    doc.graphs[0].steps[0].success = "approval";
    doc.graphs[0].steps.push({ id: "approval", kind: "approval", requirement, call: "review", approved: "review", denied: "failed", failure: "failed" });
    const result = overview(doc);
    const approval = result.cards.find(card => card.kind === "approval")!;
    expect(approval.approvers?.map(ref => ref.label)).toEqual(["Release owner"]);
    expect(result.edges.filter(edge => !edge.exchangeOnly).some(edge => edge.target === approval.path)).toBe(true);
    const transfer = result.edges.find(edge => edge.source === result.cards[1].path && edge.target === result.cards[2].path)!;
    expect(transfer.exchangeOnly).toBe(true);
    expect(transfer.transfers).toEqual(["report"]);
  });
  it("does not invent a user boundary or transfers for a legacy dependency graph", () => {
    const cards = projectViewer(createExample("release")).graphs[0].cards.slice(0, 2).map(card => ({ ...card, branches: [] }));
    cards[1].dependencies = [{ source: "step", label: "Checklist", target: cards[0].path }];
    const result = projectSystemOverview(undefined, cards);
    expect(result.cards).toEqual(cards);
    expect(result.edges).toMatchObject([{ source: cards[0].path, target: cards[1].path, dependency: true }]);
    expect(result.edges[0].transfers).toBeUndefined();
  });
});
