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
/** Each step moves vertically to `y`, then horizontally to `x`; the last step ends above the target. */
export interface ViewerRouteStep { y: number; x?: number }
export interface ViewerEdgeRoute { kind: "orthogonal"; steps: ViewerRouteStep[]; loop?: boolean }

export const VIEWER_CARD_WIDTH = 210;
const ROW_GAP = 60;
const CARD_GAP = 40;
const LANE_GAP = 14;
const TRACK_GAP = 8;
const SIDE_MARGIN = 24;
const SIDE_LANE = 14;
const LOOP_OFFSET = 8;
const RAIL_SPAN = 2;
const TRACK_LIMIT = ROW_GAP / 2 - 10;

const minimumHeight = (card: ViewerCard) => card.kind === "approval" ? 68 : ["prepare", "condition", "join"].includes(card.kind) ? 40 : 52;
// Main continuations keep their source's column; alternatives and failures move aside.
const routeRank = (label: string) => label === "onError" ? 2 : ["next", "success", "true", "approved", ""].includes(label) ? 0 : 1;

interface LayerNode { id: string; layer: number; card?: ViewerCard; order: number; x: number }
interface LayerLink { from: string; to: string; weight: number }

/** Isotonic placement: closest weighted positions that keep the order and spacing of a row. */
function placeRow(row: LayerNode[], desired: number[], weights: number[], separation: (left: LayerNode, right: LayerNode) => number) {
  const offsets = [0];
  for (let index = 1; index < row.length; index++) offsets.push(offsets[index - 1] + separation(row[index - 1], row[index]));
  const blocks: Array<{ value: number; weight: number; size: number }> = [];
  for (let index = 0; index < row.length; index++) {
    blocks.push({ value: desired[index] - offsets[index], weight: weights[index], size: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].value > blocks[blocks.length - 1].value) {
      const right = blocks.pop()!, left = blocks.pop()!;
      const weight = left.weight + right.weight;
      blocks.push({ value: (left.value * left.weight + right.value * right.weight) / weight, weight, size: left.size + right.size });
    }
  }
  let index = 0;
  for (const block of blocks) for (let item = 0; item < block.size; item++, index++) row[index].x = block.value + offsets[index];
}

function crossings(upper: LayerNode[], lower: LayerNode[], links: LayerLink[]) {
  const position = new Map([...upper, ...lower].map(node => [node.id, node.order]));
  const pairs = links.filter(link => upper.some(node => node.id === link.from) && lower.some(node => node.id === link.to))
    .map(link => [position.get(link.from)!, position.get(link.to)!]);
  let count = 0;
  for (let a = 0; a < pairs.length; a++) for (let b = a + 1; b < pairs.length; b++) {
    if ((pairs[a][0] - pairs[b][0]) * (pairs[a][1] - pairs[b][1]) < 0) count++;
  }
  return count;
}

/**
 * Layered reading layout. Returns are detected from the entry so loops never
 * stretch the process into one column. A connection skipping one row gets an
 * inner lane; longer ones and returns follow side rails shared per target.
 */
export function layoutViewer(cards: ViewerCard[], edges: ViewerEdge[], heights: Readonly<Record<string, number>> = {}) {
  const byPath = new Map(cards.map(card => [card.path, card]));
  const cardIndex = new Map(cards.map((card, index) => [card.path, index]));
  const flow = edges.filter(edge => !edge.exchangeOnly && byPath.has(edge.source) && byPath.has(edge.target));
  const outgoing = new Map(cards.map(card => [card.path, [] as ViewerEdge[]]));
  const incoming = new Map(cards.map(card => [card.path, 0]));
  for (const edge of flow) {
    outgoing.get(edge.source)!.push(edge);
    if (edge.source !== edge.target) incoming.set(edge.target, incoming.get(edge.target)! + 1);
  }
  for (const list of outgoing.values()) list.sort((a, b) => routeRank(a.label) - routeRank(b.label));

  // Depth-first from the roots: an edge to a block still being visited closes a loop.
  const state = new Map<string, "open" | "done">();
  const returns = new Set<ViewerEdge>();
  const discovery = new Map<string, number>();
  const visit = (path: string) => {
    state.set(path, "open");
    discovery.set(path, discovery.size);
    for (const edge of outgoing.get(path)!) {
      const next = state.get(edge.target);
      if (next === "open") returns.add(edge);
      else if (!next) visit(edge.target);
    }
    state.set(path, "done");
  };
  for (const card of [...cards.filter(card => incoming.get(card.path) === 0), ...cards]) if (!state.has(card.path)) visit(card.path);

  // Longest path over the acyclic reading graph.
  const forward = flow.filter(edge => !returns.has(edge));
  const rank = new Map(cards.map(card => [card.path, 0]));
  const pending = new Map(cards.map(card => [card.path, 0]));
  for (const edge of forward) pending.set(edge.target, pending.get(edge.target)! + 1);
  const queue = cards.filter(card => pending.get(card.path) === 0).map(card => card.path);
  for (let index = 0; index < queue.length; index++) {
    for (const edge of outgoing.get(queue[index])!) {
      if (returns.has(edge)) continue;
      rank.set(edge.target, Math.max(rank.get(edge.target)!, rank.get(queue[index])! + 1));
      pending.set(edge.target, pending.get(edge.target)! - 1);
      if (pending.get(edge.target) === 0) queue.push(edge.target);
    }
  }

  // A single main continuation is weighted so the main path stays straight.
  const primary = new Set<ViewerEdge>();
  const leads = new Map<string, string>();
  for (const list of outgoing.values()) {
    const open = list.filter(edge => !returns.has(edge));
    const main = open.filter(edge => routeRank(edge.label) === 0);
    // Plain fan-outs stay symmetric; among named alternatives the first one leads.
    const lead = main.length ? main.length === 1 ? main[0] : undefined : open.find(edge => routeRank(edge.label) === 1);
    if (lead && list.length > 1) {
      primary.add(lead);
      if (rank.get(lead.target)! - rank.get(lead.source)! === 1) leads.set(lead.source, lead.target);
    }
  }

  const nodes = new Map<string, LayerNode>();
  for (const card of cards) nodes.set(card.path, { id: card.path, layer: rank.get(card.path)!, card, order: 0, x: 0 });
  const links = new Map<string, LayerLink>();
  const link = (from: string, to: string, weight: number) => {
    const key = `${from}\u0000${to}`;
    const existing = links.get(key);
    if (existing) existing.weight = Math.max(existing.weight, weight);
    else links.set(key, { from, to, weight });
  };
  const chains = new Map<ViewerEdge, string[]>();
  // Connections skipping several rows follow a side rail, like returns, instead of crossing the process.
  const rails: ViewerEdge[] = [...returns];
  for (const edge of forward) {
    if (rank.get(edge.target)! - rank.get(edge.source)! > RAIL_SPAN) { rails.push(edge); continue; }
    const chain = [edge.source];
    for (let layer = rank.get(edge.source)! + 1; layer < rank.get(edge.target)!; layer++) {
      const id = `lane\u0000${edge.target}\u0000${layer}`;
      if (!nodes.has(id)) nodes.set(id, { id, layer, order: 0, x: 0 });
      chain.push(id);
    }
    chain.push(edge.target);
    chains.set(edge, chain);
    for (let index = 1; index < chain.length; index++) {
      const lanes = Number(!nodes.get(chain[index - 1])!.card) + Number(!nodes.get(chain[index])!.card);
      // Blocks align first; lanes stay straight but yield to blocks.
      link(chain[index - 1], chain[index], lanes === 2 ? 3 : lanes ? 0.001 : primary.has(edge) ? 12 : 4);
    }
  }
  const allLinks = [...links.values()];
  const layerCount = Math.max(0, ...[...nodes.values()].map(node => node.layer)) + 1;
  const layers: LayerNode[][] = Array.from({ length: layerCount }, () => []);
  for (const node of nodes.values()) layers[node.layer].push(node);
  const firstSeen = (node: LayerNode) => node.card ? discovery.get(node.id)! : discovery.get(node.id.split("\u0000")[1])! - 0.5;
  for (const layer of layers) {
    layer.sort((a, b) => firstSeen(a) - firstSeen(b) || (cardIndex.get(a.id) ?? 0) - (cardIndex.get(b.id) ?? 0));
    layer.forEach((node, index) => { node.order = index; });
  }

  // Barycentric sweeps; keep the ordering with the fewest crossings.
  const predecessors = new Map<string, LayerLink[]>(), successors = new Map<string, LayerLink[]>();
  for (const item of allLinks) {
    (predecessors.get(item.to) ?? predecessors.set(item.to, []).get(item.to)!).push(item);
    (successors.get(item.from) ?? successors.set(item.from, []).get(item.from)!).push(item);
  }
  const total = () => layers.slice(1).reduce((sum, layer, index) => sum + crossings(layers[index], layer, allLinks), 0);
  let best = layers.map(layer => [...layer]), bestCount = total();
  const sortBy = (layer: LayerNode[], related: (node: LayerNode) => LayerNode[]) => {
    const center = new Map(layer.map(node => {
      const others = related(node);
      return [node.id, others.length ? others.reduce((sum, other) => sum + other.order, 0) / others.length : node.order];
    }));
    layer.sort((a, b) => center.get(a.id)! - center.get(b.id)! || a.order - b.order);
    layer.forEach((node, index) => { node.order = index; });
  };
  for (let pass = 0; pass < 8 && bestCount > 0; pass++) {
    for (const layer of pass % 2 ? [...layers].reverse() : layers) {
      sortBy(layer, node => (pass % 2 ? successors.get(node.id)?.map(item => nodes.get(item.to)!) : predecessors.get(node.id)?.map(item => nodes.get(item.from)!)) ?? []);
    }
    const count = total();
    if (count < bestCount) { bestCount = count; best = layers.map(layer => [...layer]); }
  }
  best.forEach((layer, index) => { layers[index] = layer; layer.forEach((node, order) => { node.order = order; }); });

  // Coordinates: children align with their parents, then parents settle over their children.
  const width = (node: LayerNode) => node.card ? VIEWER_CARD_WIDTH : 0;
  const separation = (left: LayerNode, right: LayerNode) => (width(left) + width(right)) / 2 + (left.card && right.card ? CARD_GAP : LANE_GAP);
  const align =(layer: LayerNode[], related: (node: LayerNode) => Array<{ x: number; weight: number }>) => {
    const desired: number[] = [], weights: number[] = [];
    for (const node of layer) {
      const others = related(node);
      const weight = others.reduce((sum, other) => sum + other.weight, 0);
      desired.push(weight ? others.reduce((sum, other) => sum + other.x * other.weight, 0) / weight : node.x);
      weights.push(weight || 0.001);
    }
    placeRow(layer, desired, weights, separation);
  };
  // Alternatives settle beside the main continuation instead of pulling it aside.
  const above = (node: LayerNode) => (predecessors.get(node.id) ?? []).map(item => {
    const parent = nodes.get(item.from)!, lead = leads.get(parent.id);
    const offset = node.card && lead && lead !== node.id ? (node.order - nodes.get(lead)!.order) * (VIEWER_CARD_WIDTH + CARD_GAP) : 0;
    return { x: parent.x + offset, weight: item.weight };
  });
  const below = (node: LayerNode) => (successors.get(node.id) ?? []).map(item => {
    const child = nodes.get(item.to)!, lead = leads.get(node.id);
    const offset = child.card && lead && lead !== child.id ? (child.order - nodes.get(lead)!.order) * (VIEWER_CARD_WIDTH + CARD_GAP) : 0;
    return { x: child.x - offset, weight: item.weight };
  });
  const place = () => {
    for (const layer of layers) {
      let x = 0;
      layer.forEach((node, index) => { if (index) x += separation(layer[index - 1], node); node.x = x; });
      const shift = x / 2;
      for (const node of layer) node.x -= shift;
    }
    for (let pass = 0; pass < 3; pass++) {
      for (const layer of layers.slice(1)) align(layer, above);
      if (pass < 2) for (const layer of [...layers].reverse().slice(1)) align(layer, below);
    }
  };
  place();
  // A rail is shared by every connection to its block and runs on the side the block leans to.
  const railSide = (target: string) => {
    const node = nodes.get(target)!;
    const xs = [...nodes.values()].map(item => item.x);
    const center = (Math.min(...xs) + Math.max(...xs)) / 2;
    const sources = rails.filter(edge => edge.target === target).map(edge => nodes.get(edge.source)!);
    const lean = Math.abs(node.x - center) >= VIEWER_CARD_WIDTH / 4 ? node.x - center
      : sources.reduce((sum, item) => sum + item.x, 0) / sources.length - center;
    return lean >= 0 ? 1 : -1;
  };
  const sides = new Map([...new Set(rails.map(edge => edge.target))].map(target => [target, railSide(target)]));
  // Blocks reached through forward rails move to their rail's side, so the rail enters without crossing.
  let reordered = false;
  const movable = (node: LayerNode) => sides.has(node.id) && !rails.some(edge => edge.target === node.id && returns.has(edge));
  for (const layer of layers) {
    if (layer.length < 2 || !layer.some(movable)) continue;
    const next = [...layer.filter(node => movable(node) && sides.get(node.id)! < 0), ...layer.filter(node => !movable(node)), ...layer.filter(node => movable(node) && sides.get(node.id)! > 0)];
    if (next.some((node, index) => node !== layer[index])) { reordered = true; layer.splice(0, layer.length, ...next); layer.forEach((node, order) => { node.order = order; }); }
  }
  if (reordered) place();
  const left = Math.min(...[...nodes.values()].map(node => node.x - width(node) / 2));
  for (const node of nodes.values()) node.x -= left;

  // Rows follow measured card heights, including wrapped titles.
  const cardHeight = (card: ViewerCard) => Math.max(minimumHeight(card), heights[card.path] ?? 0);
  const rowTop: number[] = [], rowBottom: number[] = [];
  let y = 0;
  for (const layer of layers) {
    rowTop.push(y);
    const height = Math.max(0, ...layer.flatMap(node => node.card ? [cardHeight(node.card)] : []));
    rowBottom.push(y + height);
    y += height + ROW_GAP;
  }
  const channel = (layer: number) => rowBottom[layer] + ROW_GAP / 2;

  // Horizontal runs sharing a corridor get separate tracks unless they share an end.
  const routes = new Map<string, ViewerEdgeRoute>();
  type Run = { edge: ViewerEdge; layer: number; from: string; to: string; x1: number; x2: number; track: number };
  const runs: Run[] = [];
  const runSteps = new Map<ViewerEdge, Array<{ run: Run; x?: number }>>();
  for (const [edge, chain] of chains) {
    const steps: Array<{ run: Run; x?: number }> = [];
    for (let index = 1; index < chain.length; index++) {
      const from = nodes.get(chain[index - 1])!, to = nodes.get(chain[index])!;
      const last = index === chain.length - 1;
      if (!last && Math.abs(from.x - to.x) < 0.5 && index > 1) continue;
      const run = { edge, layer: from.layer, from: from.id, to: to.id, x1: Math.min(from.x, to.x), x2: Math.max(from.x, to.x), track: 0 };
      runs.push(run);
      steps.push({ run, x: last ? undefined : to.x });
    }
    runSteps.set(edge, steps);
  }
  for (let layer = 0; layer < layerCount; layer++) {
    const local = runs.filter(run => run.layer === layer && run.x2 - run.x1 > 0.5).sort((a, b) => (b.x2 - b.x1) - (a.x2 - a.x1));
    for (const run of local) {
      const used = new Set(local.slice(0, local.indexOf(run)).filter(other => other.from !== run.from && other.to !== run.to && other.x1 < run.x2 - 0.5 && run.x1 < other.x2 - 0.5).map(other => other.track));
      while (used.has(run.track)) run.track++;
    }
    const tracks = Math.max(0, ...local.map(run => run.track)) + 1;
    for (const run of local) run.track = Math.max(-TRACK_LIMIT, Math.min(TRACK_LIMIT, (run.track - (tracks - 1) / 2) * TRACK_GAP));
  }
  for (const [edge, steps] of runSteps) {
    routes.set(edge.id, { kind: "orthogonal", steps: steps.map(({ run, x }) => ({ y: channel(run.layer) + run.track, ...(x === undefined ? {} : { x }) })) });
  }

  // Rails run outside the rows they span; enclosing rails stay outside the rails they contain.
  const groups = new Map<string, { side: number; target: LayerNode; edges: ViewerEdge[]; from: number; to: number; x: number }>();
  for (const edge of rails) {
    const target = nodes.get(edge.target)!;
    const side = sides.get(edge.target)!;
    const key = `${edge.target}\u0000${side}`;
    const group = groups.get(key) ?? { side, target, edges: [], from: target.layer, to: target.layer, x: 0 };
    const source = nodes.get(edge.source)!;
    group.edges.push(edge);
    group.from = Math.min(group.from, source.layer);
    group.to = Math.max(group.to, source.layer);
    groups.set(key, group);
  }
  const placed: Array<{ side: number; from: number; to: number; x: number }> = [];
  for (const group of [...groups.values()].sort((a, b) => (a.to - a.from) - (b.to - b.from))) {
    const { side, from, to } = group;
    const spanned = layers.slice(from, to + 1).flat();
    let x = side > 0 ? Math.max(...spanned.map(node => node.x + width(node) / 2)) + SIDE_MARGIN : Math.min(...spanned.map(node => node.x - width(node) / 2)) - SIDE_MARGIN;
    for (const other of placed) if (other.side === side && other.from <= to && from <= other.to) x = side > 0 ? Math.max(x, other.x + SIDE_LANE) : Math.min(x, other.x - SIDE_LANE);
    placed.push({ side, from, to, x });
    group.x = x;
  }
  const exits = new Map<string, number>(), entries = new Map<string, number>();
  const slot = (counter: Map<string, number>, key: string, owner: string) => {
    const id = `${key}\u0000${owner}`;
    if (!counter.has(id)) counter.set(id, [...counter.keys()].filter(item => item.startsWith(`${key}\u0000`)).length);
    return counter.get(id)! % 3;
  };
  for (const group of groups.values()) for (const edge of group.edges) {
    const source = nodes.get(edge.source)!;
    routes.set(edge.id, { kind: "orthogonal", ...(returns.has(edge) ? { loop: true } : {}), steps: [
      { y: rowBottom[source.layer] + LOOP_OFFSET + slot(exits, `${source.layer}:${group.side}`, edge.source) * 4, x: group.x },
      { y: rowTop[group.target.layer] - LOOP_OFFSET - slot(entries, `${group.target.layer}`, group.target.id) * 4 },
    ] });
  }

  const layout = cards.map(card => {
    const node = nodes.get(card.path)!;
    return { card, position: { x: node.x - VIEWER_CARD_WIDTH / 2, y: rowTop[node.layer] }, height: cardHeight(card) };
  });
  return { nodes: layout, edges, routes };
}

/** Fallback for connections outside the reading layout, such as revealed exchanges. */
export function routeViewerEdge(nodes: ViewerLayoutNode[], edge: ViewerEdge): ViewerEdgeRoute | undefined {
  const source = nodes.find(node => node.card.path === edge.source);
  const target = nodes.find(node => node.card.path === edge.target);
  if (!source || !target) return undefined;
  const rowBottom = Math.max(...nodes.filter(node => node.position.y === source.position.y).map(node => node.position.y + node.height));
  const nextRow = Math.min(...nodes.filter(node => node.position.y > source.position.y).map(node => node.position.y));
  if (target.position.y > source.position.y && target.position.y === nextRow) {
    return { kind: "orthogonal", steps: [{ y: (rowBottom + target.position.y) / 2 }] };
  }
  const outsideX = Math.max(...nodes.map(node => node.position.x + VIEWER_CARD_WIDTH)) + SIDE_MARGIN;
  return { kind: "orthogonal", loop: target.position.y <= source.position.y, steps: [{ y: rowBottom + LOOP_OFFSET + 14, x: outsideX }, { y: target.position.y - LOOP_OFFSET - 14 }] };
}

/** Orthogonal path with rounded corners, ending at the actual React Flow handles. */
export function viewerEdgePath(route: ViewerEdgeRoute, handles: { sourceX: number; sourceY: number; targetX: number; targetY: number }): string {
  const { sourceX, sourceY, targetX, targetY } = handles;
  const points = [{ x: sourceX, y: sourceY }];
  let x = sourceX;
  for (const step of route.steps) {
    points.push({ x, y: step.y });
    x = step.x ?? targetX;
    points.push({ x, y: step.y });
  }
  points.push({ x: targetX, y: points.at(-1)!.y }, { x: targetX, y: targetY });
  const clean = points.filter((point, index) => index === 0 || Math.abs(point.x - points[index - 1].x) > 0.01 || Math.abs(point.y - points[index - 1].y) > 0.01)
    .filter((point, index, all) => index === 0 || index === all.length - 1
      || !((Math.abs(all[index - 1].x - point.x) < 0.01 && Math.abs(point.x - all[index + 1].x) < 0.01)
        || (Math.abs(all[index - 1].y - point.y) < 0.01 && Math.abs(point.y - all[index + 1].y) < 0.01)));
  const round = (value: number) => Math.round(value * 100) / 100;
  let path = `M${round(clean[0].x)} ${round(clean[0].y)}`;
  for (let index = 1; index < clean.length - 1; index++) {
    const previous = clean[index - 1], point = clean[index], next = clean[index + 1];
    const radius = Math.min(6, Math.hypot(point.x - previous.x, point.y - previous.y) / 2, Math.hypot(next.x - point.x, next.y - point.y) / 2);
    const before = { x: point.x - Math.sign(point.x - previous.x) * radius, y: point.y - Math.sign(point.y - previous.y) * radius };
    const after = { x: point.x + Math.sign(next.x - point.x) * radius, y: point.y + Math.sign(next.y - point.y) * radius };
    path += ` L${round(before.x)} ${round(before.y)} Q${round(point.x)} ${round(point.y)} ${round(after.x)} ${round(after.y)}`;
  }
  const end = clean.at(-1)!;
  return `${path} L${round(end.x)} ${round(end.y)}`;
}
