import type { ViewerCard } from './viewer';
import type { ViewerEdge } from './graphLayout';

export type GraphReadingMode = 'overview' | 'exchanges';
export interface PresentationGroup { id: string; title: string; members: ViewerCard[] }
export interface PresentationEdge extends ViewerEdge { originals: ViewerEdge[] }

const groupName = (card: ViewerCard): string => {
  const own = (card.details.displayAnnotations ?? card.details.annotations) as Record<string, unknown> | undefined;
  const agent = card.details.agentDefinition as Record<string, unknown> | undefined;
  const inherited = agent?.annotations as Record<string, unknown> | undefined;
  const value = own?.macroGroup ?? inherited?.macroGroup;
  return typeof value === 'string' ? value.trim() : '';
};

/** Groups are explicit author annotations, never inferred execution steps. */
export function graphGroups(cards: ViewerCard[]): PresentationGroup[] {
  const groups = new Map<string, ViewerCard[]>();
  for (const card of cards) {
    const name = groupName(card);
    if (name) groups.set(name, [...(groups.get(name) ?? []), card]);
  }
  return [...groups].map(([title, members]) => ({ id: `macro-group:${encodeURIComponent(title)}`, title, members }));
}

/** A reversible display projection. Original relation identities survive folding. */
export function presentGraph(cards: ViewerCard[], edges: ViewerEdge[], collapsed: ReadonlySet<string>, mode: GraphReadingMode) {
  const groups = graphGroups(cards);
  const paths = new Set(cards.map(card => card.path));
  const owner = new Map<string, string>();
  const folded = groups.filter(group => collapsed.has(group.id));
  for (const group of folded) for (const member of group.members) owner.set(member.path, group.id);
  const projectedCards = cards.filter(card => !owner.has(card.path));
  for (const group of folded) projectedCards.push({
    path: group.id, id: group.id, title: group.title, kind: 'displayGroup', mission: '', unresolved: false,
    inputs: [], outputs: [], branches: [], details: {},
  });
  const bundles = new Map<string, PresentationEdge>();
  for (const edge of edges) {
    if (!paths.has(edge.source) || !paths.has(edge.target)) continue;
    if (mode === 'overview' ? edge.exchangeOnly : !edge.transfers?.length) continue;
    const source = owner.get(edge.source) ?? edge.source;
    const target = owner.get(edge.target) ?? edge.target;
    if (source === target && (owner.has(edge.source) || owner.has(edge.target))) continue;
    const key = owner.has(edge.source) || owner.has(edge.target)
      ? JSON.stringify([source, target, edge.dependency, edge.label, Boolean(edge.exchangeOnly)])
      : edge.id;
    const existing = bundles.get(key);
    if (existing) {
      existing.originals.push(edge);
      existing.transfers = [...new Set([...(existing.transfers ?? []), ...(edge.transfers ?? [])])];
    } else bundles.set(key, { ...edge, source, target, originals: [edge] });
  }
  return { cards: projectedCards, edges: [...bundles.values()], groups, owner };
}

export function graphNeighborhood(path: string, edges: ViewerEdge[]) {
  const nodes = new Set([path]);
  const relations = new Set<string>();
  for (const edge of edges) if (edge.source === path || edge.target === path || edge.id === path) {
    nodes.add(edge.source); nodes.add(edge.target); relations.add(edge.id);
  }
  return { nodes, edges: relations };
}
