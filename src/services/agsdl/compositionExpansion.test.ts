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
