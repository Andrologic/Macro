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

export interface ViewerLayoutNode {
  card: ViewerCard;
  position: { x: number; y: number };
  height: number;
}
export type ViewerEdgeRoute =
  | { kind: "channel"; centerY: number }
  | { kind: "outside"; exitY: number; entryY: number; outsideX: number };

/** Converge below the whole row; route returns and skipped rows outside cards. */
export function routeViewerEdge(nodes: ViewerLayoutNode[], edge: ViewerEdge): ViewerEdgeRoute | undefined {
  const source = nodes.find(node => node.card.path === edge.source);
  const target = nodes.find(node => node.card.path === edge.target);
  if (!source || !target) return undefined;
  const rowBottom = Math.max(...nodes.filter(node => node.position.y === source.position.y).map(node => node.position.y + node.height));
  const nextRow = Math.min(...nodes.filter(node => node.position.y > source.position.y).map(node => node.position.y));
  if (target.position.y > source.position.y && target.position.y === nextRow) {
    return { kind: "channel", centerY: (rowBottom + target.position.y) / 2 };
  }
  return {
    kind: "outside", exitY: rowBottom + 24, entryY: target.position.y - 24,
    outsideX: Math.max(...nodes.map(node => node.position.x + 210)) + 24,
  };
}

/** Rounded outside corridor, ending at the actual target handle. */
export function outsideViewerEdgePath(route: Extract<ViewerEdgeRoute, { kind: "outside" }>, handles: {
  sourceX: number; sourceY: number; targetX: number; targetY: number;
}): string {
  const { exitY, entryY, outsideX } = route;
  const { sourceX, sourceY, targetX, targetY } = handles;
  const direction = entryY > exitY ? 1 : -1;
  return `M${sourceX} ${sourceY} L${sourceX} ${exitY - 5} Q${sourceX} ${exitY} ${sourceX + 5} ${exitY} ` +
    `L${outsideX - 5} ${exitY} Q${outsideX} ${exitY} ${outsideX} ${exitY + direction * 5} ` +
    `L${outsideX} ${entryY - direction * 5} Q${outsideX} ${entryY} ${outsideX - 5} ${entryY} ` +
    `L${targetX + 5} ${entryY} Q${targetX} ${entryY} ${targetX} ${entryY + 5} L${targetX} ${targetY}`;
}

/** Layout is independent of the source document and tolerates cyclic drafts. */
export function layoutViewer(cards: ViewerCard[], edges: ViewerEdge[], heights: Readonly<Record<string, number>> = {}) {
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
  // Rank spacing follows measured card heights, including wrapped titles.
  const rowHeights = new Map<number, number>();
  for (const card of main) {
    const rank = ranks.get(card.path) ?? 0;
    const height = Math.max(card.kind === "approval" ? 68 : 52, heights[card.path] ?? 0);
    rowHeights.set(rank, Math.max(rowHeights.get(rank) ?? 52, height));
  }
  const rows = new Map<number, number>();
  let y = 0;
  for (let rank = 0; rank <= lastRank; rank++) {
    rows.set(rank, y);
    y += (rowHeights.get(rank) ?? 52) + 48;
  }
  const columns = new Map<number, number>();
  const nodes = main.map(card => {
    const rank = ranks.get(card.path) ?? 0;
    const column = columns.get(rank) ?? 0;
    columns.set(rank, column + 1);
    return { card, position: { x: column * 240, y: rows.get(rank) ?? 0 }, height: Math.max(card.kind === "approval" ? 68 : 52, heights[card.path] ?? 0) };
  });
  return { nodes, edges };
}
