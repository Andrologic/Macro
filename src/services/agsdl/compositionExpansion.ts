import { object, pointerPart } from "./document";
import type { ViewerEdge } from "./graphLayout";
import { resolveStaticAgent030 } from "./staticSemantics030";
import { projectSystemOverview } from "./systemOverview";
import type { ViewerCard, ViewerGraph } from "./viewer";

/** One composition occurrence and the visible descendants inside its frame. */
export interface ExpandedComposition { path: string; title: string; entry: string; members: string[] }

/** Occurrence identities retain the complete chain of compose uses. */
export const expandedStepPath = (compose: string, inner: string) => `${compose}#${inner}`;
/** Return the actual source owner, including for multiply nested copies. */
export const originalStepPath = (path: string) => path.slice(path.lastIndexOf("#") + 1);

type Branch = ViewerCard["branches"][number];
const isError = (branch: Branch) => branch.route030 ? branch.route030.role === "error" : branch.label === "onError";

/** Expand requested occurrences recursively, preserving source owners and effective output routes. */
export function expandCompositions(cards: ViewerCard[], edges: ViewerEdge[], graphs: ViewerGraph[], expanded: ReadonlySet<string>, declarations: ViewerCard[]) {
  const frames: ExpandedComposition[] = [];
  let nextCards = cards, nextEdges = edges;
  const visited = new Set<string>();
  const ancestors = new Map<string, string[]>();
  const redirects = new Map<string, string>();
  const target = (path: string | undefined): string | undefined => {
    const seen = new Set<string>();
    while (path && redirects.has(path) && !seen.has(path)) { seen.add(path); path = redirects.get(path); }
    return path;
  };
  const redirectCard = (card: ViewerCard): ViewerCard => {
    const branches = card.branches.map(branch => ({ ...branch, reference: { ...branch.reference, target: target(branch.reference.target) },
      ...(branch.route030 ? { route030: { ...branch.route030, target: target(branch.route030.target), targetOccurrenceId: target(branch.route030.target) } } : {}) }));
    return { ...card, branches, ...(card.edition030 ? { edition030: { ...card.edition030, routes: branches.flatMap(branch => branch.route030 ?? []) } } : {}) };
  };
  while (true) {
    const compose = nextCards.find(card => card.kind === "compose" && expanded.has(card.path) && !visited.has(card.path));
    if (!compose) break;
    visited.add(compose.path);
    const graph = graphs.find(item => item.path === compose.composition?.target);
    const stack = ancestors.get(compose.path) ?? [];
    if (!graph?.entry.target || graph.entry.unresolved || stack.includes(graph.path)) continue;
    const copy = (path: string) => expandedStepPath(compose.path, path);
    const entry = copy(graph.entry.target);
    const bound = Object.fromEntries(Object.entries(object(compose.details.agents)).flatMap(([parameter, ref]) =>
      typeof ref === "string" ? [[parameter, ref]] : []));
    const localPaths = new Set(graph.cards.map(card => card.path));
    const remap = (path: string | undefined) => path && localPaths.has(path) ? copy(path) : target(path);
    const semantic = new Map(graph.static030?.occurrences.map(item => [item.occurrenceId, item]));
    // A flow handler is projected on the compose occurrence, outside its authored branches.
    const outward = [...compose.branches, ...nextEdges.filter(edge => edge.source === compose.path && edge.route030?.inherited
      && !compose.branches.some(branch => branch.route030?.inherited && branch.route030.path === edge.route030!.path && branch.reference.target === edge.target)).map((edge): Branch => ({
      label: "onError", path: edge.route030!.path, reference: { label: "onError", target: edge.target, source: "step" }, route030: edge.route030, transfers: edge.transfers,
    }))];
    const leave = (branch: Branch, route: Branch, source: ViewerCard, inherited = false): Branch => ({
      ...route, label: branch.label, reference: { ...route.reference, target: target(route.reference.target) },
      // Without an explicit message, the body producer supplies the compose output's default message.
      ...(route.route030 && route.route030.messageJson === undefined ? { transfers: branch.transfers ?? route.transfers } : {}),
      ...(route.route030 ? { route030: { ...route.route030, sourcePath: source.static030?.sourcePath ?? originalStepPath(source.path),
        sourceOccurrenceId: source.path, target: target(route.reference.target), targetOccurrenceId: target(route.reference.target),
        role: inherited ? "error" : branch.route030?.role ?? route.route030.role,
        key: branch.route030?.key, inherited: inherited || route.route030.inherited,
        via: [...(branch.route030?.via ?? (branch.path ? [branch.path] : [])), ...(route.route030.via ?? [route.route030.path])] } } : {}),
    });
    const members = graph.cards.filter(card => card.kind !== "end").map((original): ViewerCard => {
      const path = copy(original.path), static030 = semantic.get(path);
      const parameter = original.kind === "agent" ? object(original.details.agent).parameter : undefined;
      const agent = typeof parameter === "string" ? resolveStaticAgent030(original.details.agent, bound) : undefined;
      const declaration = agent ? declarations.find(item => item.path === `/agents/${pointerPart(agent)}`) : undefined;
      const card: ViewerCard = { ...original, path, static030,
        ...(original.edition030 ? { edition030: { ...original.edition030, ownerPath: original.static030?.sourcePath ?? originalStepPath(original.path) } } : {}),
        details: { ...original.details }, branches: [] };
      if (original.kind === "compose") {
        card.details.agents = Object.fromEntries(Object.entries(object(original.details.agents)).flatMap(([parameter, ref]) => {
          const name = resolveStaticAgent030(ref, bound);
          return name === undefined ? [[parameter, ref]] : [[parameter, name]];
        }));
        ancestors.set(path, [...stack, graph.path]);
      }
      if (declaration) {
        card.participant = { label: declaration.title, source: "unknown", target: declaration.path };
        card.unresolved = false; card.mission = declaration.mission; card.promptSources = declaration.promptSources;
        card.tools = declaration.tools; card.resources = declaration.resources; card.capabilities = declaration.capabilities;
        card.inputs = declaration.inputs; card.outputs = declaration.outputs;
        card.details = { ...card.details, agentName: agent, agentPath: declaration.path, agentDefinition: declaration.details };
        if (card.edition030) {
          card.edition030.agentPath = declaration.path;
          card.edition030.definitionJson = declaration.edition030?.definitionJson ?? declaration.edition030?.sourceJson;
        }
      }
      card.branches = original.branches.flatMap((branch): Branch[] => {
        const output = branch.route030 ? branch.route030.targetKind === "output" ? branch.route030.targetName : undefined
          : !branch.reference.target && !branch.reference.unresolved ? branch.reference.label : undefined;
        if (output !== undefined) return outward.filter(route => output === "onError" && !branch.route030 ? isError(route)
          : !isError(route) && (route.route030?.key ?? route.label) === output).map(route => leave(branch, route, card));
        return [{ ...branch, reference: { ...branch.reference, target: remap(branch.reference.target) },
          ...(branch.route030 ? { route030: { ...branch.route030, sourceOccurrenceId: path, target: remap(branch.route030.target), targetOccurrenceId: remap(branch.route030.target) } } : {}) }];
      });
      // Failure stops at the nearest join; only an unhandled body failure escapes its compose.
      if (static030?.error.kind === "compose") {
        card.branches.push(...outward.filter(isError).map(route => leave({ label: "onError", reference: { label: "onError", source: "step" } }, route, card, true)));
      }
      if (card.edition030) card.edition030.routes = card.branches.flatMap(branch => branch.route030 ?? []);
      return card;
    });
    redirects.set(compose.path, entry);
    nextCards = nextCards.flatMap(card => card.path === compose.path ? members : [card]).map(redirectCard);
    const memberPaths = new Set(members.map(card => card.path));
    // Output routing is now part of the copied branch model, so a child compose can expand it again.
    const inner = projectSystemOverview({ ...graph, path: compose.path, cards: nextCards, errorRoutes030: [], entry: { ...graph.entry, target: entry } }, []);
    nextEdges = [
      ...nextEdges.filter(edge => edge.source !== compose.path).map(edge => edge.target === compose.path ? { ...edge, target: entry,
        ...(edge.route030 ? { route030: { ...edge.route030, target: entry, targetOccurrenceId: entry } } : {}) } : edge),
      ...inner.edges.filter(edge => memberPaths.has(edge.source)).map((edge, index) => ({ ...edge, id: `${compose.path}#edge/${index}/${edge.id}`, target: target(edge.target)! })),
    ];
    for (const frame of frames) {
      frame.entry = target(frame.entry)!;
      frame.members = frame.members.flatMap(path => path === compose.path ? members.map(card => card.path) : [path]);
    }
    frames.push({ path: compose.path, title: compose.title, entry, members: members.map(card => card.path) });
  }
  return { cards: nextCards, edges: nextEdges, frames };
}
