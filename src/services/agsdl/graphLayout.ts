import type { ViewerCard } from "./viewer";

export interface ViewerEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  dependency: boolean;
}

/** Lay out only declared, resolved connections. Invalid cycles remain inspectable. */
export function layoutViewer(cards: ViewerCard[]) {
  const paths = new Set(cards.map(card => card.path));
  const edges: ViewerEdge[] = cards.flatMap(card => [
    ...card.branches.flatMap(({ label, reference }) =>
      reference.target && !reference.unresolved && paths.has(reference.target)
        ? [{ id: `${card.path}/${label}`, source: card.path, target: reference.target, label, dependency: false }]
        : [],
    ),
    ...(card.dependencies ?? []).flatMap((reference, index) =>
      reference.target && !reference.unresolved && paths.has(reference.target)
        ? [{ id: `${card.path}/dependency/${index}`, source: reference.target, target: card.path, label: "dependency", dependency: true }]
        : [],
    ),
  ]);
  // Shared failure terminals sit beside the main path, without stretching its ranks.
  const failures = new Set(cards.filter(card => card.kind === "end" && card.outcome === "failure").map(card => card.path));
  const main = cards.filter(card => !failures.has(card.path));
  const outgoing = new Map(cards.map(card => [card.path, [] as string[]]));
  const incoming = new Map(main.map(card => [card.path, 0]));
  for (const edge of edges) {
    if (failures.has(edge.source) || failures.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
  }
  const ranks = new Map<string, number>();
  const queue = main.filter(card => incoming.get(card.path) === 0).map(card => card.path);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    const rank = ranks.get(id) ?? 0;
    ranks.set(id, rank);
    for (const target of outgoing.get(id)!) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, rank + 1));
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  let lastRank = Math.max(0, ...ranks.values());
  // Cyclic drafts must terminate and must not place nodes on top of each other.
  for (const card of main) if (!queue.includes(card.path)) ranks.set(card.path, ++lastRank);
  const columns = new Map<number, number>();
  const nodes = main.map(card => {
    const rank = ranks.get(card.path) ?? 0;
    const column = columns.get(rank) ?? 0;
    columns.set(rank, column + 1);
    return { card, position: { x: column * 210 + (card.kind === "end" ? 35 : 0), y: rank * 100 } };
  });
  const failureX = Math.max(1, ...columns.values()) * 210;
  cards.filter(card => failures.has(card.path)).forEach((card, index) => {
    nodes.push({ card, position: { x: failureX + index * 130, y: lastRank * 100 } });
  });
  return { nodes, edges };
}
