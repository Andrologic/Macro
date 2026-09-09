import type { ViewerCard, ViewerGraph } from "./viewer";
import type { ViewerEdge } from "./graphLayout";

/** A user-facing reading projection. Never writes synthetic boundary nodes into AgSDL. */
export function projectSystemOverview(graph: ViewerGraph | undefined, declarations: ViewerCard[]) {
  if (!graph) {
    const paths = new Set(declarations.map(card => card.path));
    return {
      cards: declarations,
      edges: declarations.flatMap(card => (card.dependencies ?? []).flatMap((ref, index): ViewerEdge[] =>
        ref.target && !ref.unresolved && paths.has(ref.target)
          ? [{ id: `${card.path}/dependency/${index}`, source: ref.target, target: card.path, label: "dependency", dependency: true }]
          : [],
      )),
    };
  }
  const input: ViewerCard = {
    path: `${graph.path}/input`, id: "input", kind: "input", title: "",
    mission: "", unresolved: !!graph.entry.unresolved,
    inputs: graph.inputs, outputs: [], branches: [],
    details: { entry: graph.entry, inputs: graph.inputs },
  };
  const cards = [input, ...graph.cards.flatMap((card): ViewerCard[] => {
    if (card.kind !== "end") return [card];
    if (card.outcome !== "success") return [];
    return [{
      ...card, kind: "output",
      // Only declared system outputs belong to the system boundary.
      outputs: graph.outputs.map(port => ({ ...port, binding: card.outputs.find(value => value.name === port.name)?.binding })),
    }];
  })];
  const byPath = new Map(cards.map(card => [card.path, card]));
  const edges: ViewerEdge[] = [];
  const add = (source: string, target: string | undefined, label: string) => {
    if (!target || !byPath.has(target)) return;
    edges.push({ id: `${source}/${label}`, source, target, label, dependency: false });
  };
  if (!graph.entry.unresolved) add(input.path, graph.entry.target, "entry");
  for (const card of graph.cards) {
    if (!byPath.has(card.path)) continue;
    for (const branch of card.branches) {
      // Operational failure routing stays in the technical inspector.
      if (branch.label === "failure" || branch.reference.unresolved) continue;
      add(card.path, branch.reference.target, branch.label);
    }
  }
  for (const card of cards) {
    if (card.kind === "input") continue;
    const ports = card.kind === "output" ? card.outputs : card.inputs;
    for (const port of ports) {
      const ref = port.binding;
      if (!ref || ref.unresolved) continue;
      const source = ref.source === "input" ? input.path : ref.source === "step" ? ref.target : undefined;
      if (!source || !byPath.has(source)) continue;
      // Shared context is shown at the boundary and in the receiving agent's details.
      // Non-adjacent exchanges are revealed on selection rather than implying a shortcut.
      let edge = edges.find(edge => edge.source === source && edge.target === card.path);
      if (!edge) {
        edge = { id: `${source}/exchange/${card.path}`, source, target: card.path, label: "exchange", dependency: false, exchangeOnly: true };
        edges.push(edge);
      }
      const name = ref.source === "input" ? ref.label : ref.port;
      if (name && !edge.transfers?.includes(name)) (edge.transfers ??= []).push(name);
    }
  }
  return { cards, edges };
}
