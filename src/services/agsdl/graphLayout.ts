import type { ViewerCard } from "./viewer";

export interface ViewerEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  dependency: boolean;
  transfers?: string[];
  exchangeOnly?: boolean;
}

/** Layout is independent of the source document and tolerates cyclic drafts. */
export function layoutViewer(cards: ViewerCard[], edges: ViewerEdge[]) {
  const main = cards;
  const outgoing = new Map(cards.map(card => [card.path, [] as string[]]));
  const incoming = new Map(main.map(card => [card.path, 0]));
  for (const edge of edges) {
    if (edge.exchangeOnly || !outgoing.has(edge.source) || !incoming.has(edge.target)) continue;
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
  const visited = new Set(queue);
  for (const card of main) if (!visited.has(card.path)) ranks.set(card.path, ++lastRank);
  const columns = new Map<number, number>();
  const nodes = main.map(card => {
    const rank = ranks.get(card.path) ?? 0;
    const column = columns.get(rank) ?? 0;
    columns.set(rank, column + 1);
    return { card, position: { x: column * 240, y: rank * 100 } };
  });
  return { nodes, edges };
}
