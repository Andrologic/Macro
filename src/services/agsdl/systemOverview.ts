import { isFlowDocumentContract } from "./contract";
import type { ViewerEdge } from "./graphLayout";
import type { ViewerCard,ViewerGraph } from "./viewer";

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
  // Interfaces and terminal outcomes belong to their owner's inspector, not
  // to the participant canvas. Never synthesize boundary nodes from them.
  const cards = graph.cards.filter(card => card.kind !== "end");
  const byPath = new Map(cards.map(card => [card.path, card]));
  const edges: ViewerEdge[] = [];
  const add = (source: string, target: string | undefined, label: string, path?: string, transfers?: string[]) => {
    if (!target || !byPath.has(target)) return;
    edges.push({ id: path ?? `${source}/${label}`, source, target, label, dependency: false, ...(transfers?.length ? { transfers } : {}) });
  };
  for (const card of graph.cards) {
    if (!byPath.has(card.path)) continue;
    for (const branch of card.branches) {
      // Legacy failure routing stays in the technical inspector. A 0.2
      // decision named failure remains a normal authored choice.
      if ((!isFlowDocumentContract(graph.contract) && branch.label === "failure") || branch.reference.unresolved) continue;
      add(card.path, branch.reference.target, branch.label, branch.path, branch.transfers);
      if (branch.route030 && branch.reference.target && byPath.has(branch.reference.target)) edges[edges.length - 1].route030 = branch.route030;
    }
    if (card.static030?.error.kind === "flow") {
      for (const route of graph.errorRoutes030 ?? []) {
        if (!route.target || !byPath.has(route.target)) continue;
        edges.push({ id: `${card.path}/inherited${route.path}`, source: card.path, target: route.target,
          label: "onError", dependency: false, transfers: [route.messageJson === undefined ? "resources.error" : "message"],
          route030: { ...route, sourcePath: card.static030.sourcePath, sourceOccurrenceId: card.path, targetOccurrenceId: route.target, inherited: true } });
      }
    }
  }
  for (const card of cards) {
    const ports = card.inputs;
    for (const port of ports) {
      const ref = port.binding;
      if (!ref || ref.unresolved) continue;
      const source = ref.source === "step" ? ref.target : undefined;
      if (!source || !byPath.has(source)) continue;
      if (!ref.port || !byPath.get(source)!.outputs.some(output => output.name === ref.port)) continue;
      // Shared context stays with the system and in the receiving agent's details.
      // Keep non-adjacent exchanges separate from the process path; their bindings
      // remain available in the inspector without drawing a shortcut on selection.
      let edge = edges.find(edge => edge.source === source && edge.target === card.path);
      if (!edge) {
        edge = { id: `${source}/exchange/${card.path}`, source, target: card.path, label: "exchange", dependency: false, exchangeOnly: true };
        edges.push(edge);
      }
      const name = ref.source === "input" ? ref.label : ref.port;
      if (name && !edge.transfers?.includes(name)) (edge.transfers ??= []).push(name);
    }
  }
  // The step that receives the consumer's entry Message.
  const entry = graph.entry.unresolved ? undefined : graph.entry.target;
  return { cards, edges, entry };
}
