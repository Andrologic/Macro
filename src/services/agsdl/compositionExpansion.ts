import type { ViewerEdge } from "./graphLayout";
import { projectSystemOverview } from "./systemOverview";
import type { ViewerCard, ViewerGraph } from "./viewer";

/** One composition step shown in place: its frame, the step it replaces and the copied steps inside. */
export interface ExpandedComposition { path: string; title: string; entry: string; members: string[] }

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Copied steps keep their composition path after the composition step that runs them. */
export const expandedStepPath = (compose: string, inner: string) => `${compose}#${inner}`;
/** The composition path of a copied step, or the path itself. */
export const originalStepPath = (path: string) => path.includes("#") ? path.slice(path.indexOf("#") + 1) : path;

/**
 * Replaces each expanded composition step by a copy of its composition's steps.
 * The copies run the agents this step binds to the composition's parameters,
 * receive the step's incoming connections at the composition entry, and leave
 * through the step's own routes: a named output goes where the step sends that
 * output, an error goes to the step's error route.
 */
export function expandCompositions(cards: ViewerCard[], edges: ViewerEdge[], graphs: ViewerGraph[], expanded: ReadonlySet<string>, declarations: ViewerCard[]) {
  const frames: ExpandedComposition[] = [];
  let nextCards = cards;
  let nextEdges = edges;
  for (const compose of cards) {
    const graph = compose.kind === "compose" && expanded.has(compose.path) ? graphs.find(item => item.path === compose.composition?.target) : undefined;
    const entry = graph?.entry.target;
    if (!graph || !entry || graph.entry.unresolved) continue;
    const copy = (path: string) => expandedStepPath(compose.path, path);
    const bound = object(compose.details.agents);
    const inner = projectSystemOverview(graph, []);
    const members = inner.cards.map((card): ViewerCard => {
      const parameter = card.kind === "agent" ? object(card.details.agent).parameter : undefined;
      const agent = typeof parameter === "string" && typeof bound[parameter] === "string" ? bound[parameter] as string : undefined;
      const declaration = agent ? declarations.find(item => item.path === `/agents/${agent}`) : undefined;
      return {
        ...card, path: copy(card.path),
        // The parameter becomes the agent this step binds to it.
        ...(declaration ? { participant: { label: declaration.title, source: "unknown" as const, target: declaration.path }, mission: declaration.mission,
          tools: declaration.tools, outputs: declaration.outputs, details: { ...card.details, agentDefinition: declaration.details } } : {}),
      };
    });
    const routes = (label: string) => nextEdges.filter(edge => edge.source === compose.path && edge.label === label);
    const exits = inner.cards.flatMap(card => card.branches.filter(branch => !branch.reference.target && !branch.reference.unresolved).flatMap(branch =>
      // A composition output leaves through the step's route of that name; an error through its error route.
      routes(branch.reference.label === "onError" ? "onError" : branch.reference.label).map((route, index): ViewerEdge => ({
        ...route, id: `${copy(branch.path ?? card.path)}/${index}`, source: copy(card.path), label: branch.label,
      }))));
    nextEdges = [
      ...nextEdges.filter(edge => edge.source !== compose.path).map(edge => edge.target === compose.path ? { ...edge, target: copy(entry) } : edge),
      ...inner.edges.map(edge => ({ ...edge, id: copy(edge.id), source: copy(edge.source), target: copy(edge.target) })),
      ...exits,
    ];
    nextCards = nextCards.flatMap(card => card.path === compose.path ? members : [card]);
    frames.push({ path: compose.path, title: compose.title, entry: copy(entry), members: members.map(card => card.path) });
  }
  return { cards: nextCards, edges: nextEdges, frames };
}
