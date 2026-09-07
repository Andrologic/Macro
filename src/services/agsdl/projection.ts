import type { AgsdlGraphEdge, AgsdlGraphNode } from "../../types/agsdl";
import { keyId, list, object, readDocument, text } from "./document";

export function successors(step: Record<string, unknown>): string[] {
  if (step.kind === "invoke") return ["success", "failure"];
  if (step.kind === "condition") return ["true", "false", "failure"];
  if (step.kind === "approval") return ["approved", "denied", "failure"];
  return [];
}

export function projectDocument(
  source: string,
  view: "process" | "system",
  graphIndex = 0,
  focusPath?: string,
): { nodes: AgsdlGraphNode[]; edges: AgsdlGraphEdge[] } {
  const doc = readDocument(source);
  const definitions = list(doc.definitions).map(object);
  const nodes: AgsdlGraphNode[] = [];
  const edges: AgsdlGraphEdge[] = [];
  if (view === "process") {
    const graph = object(list(doc.graphs)[graphIndex]);
    const steps = list(graph.steps).map(object);
    const byId = new Map(
      steps.map((step, index) => [
        text(step.id),
        `/graphs/${graphIndex}/steps/${index}`,
      ]),
    );
    steps.forEach((step, index) => {
      const path = `/graphs/${graphIndex}/steps/${index}`;
      const agent = definitions.find(
        (def) => keyId(def.key) === keyId(step.agent),
      );
      const agentName =
        text(object(agent?.annotations).title) || text(object(step.agent).id);
      nodes.push({
        id: path,
        path,
        title: text(step.id) || `#${index + 1}`,
        subtitle: agentName || text(step.outcome) || text(step.kind),
        kind: text(step.kind),
        outputs: successors(step),
        position: { x: 0, y: index * 145 },
      });
      for (const handle of successors(step)) {
        const target = byId.get(text(step[handle]));
        if (target)
          edges.push({
            id: `${path}/${handle}`,
            source: path,
            target,
            label: handle,
            handle,
            path: `${path}/${handle}`,
          });
      }
    });
    // Stable layering, bounded even for an invalid cyclic draft.
    const ranks = new Map<string, number>();
    const visit = (id: string, rank: number, trail: Set<string>) => {
      if (trail.has(id) || rank > nodes.length) return;
      if ((ranks.get(id) ?? -1) >= rank) return;
      ranks.set(id, rank);
      for (const edge of edges.filter(
        (edge) =>
          edge.source === id && !["failure", "denied"].includes(edge.label),
      ))
        visit(edge.target, rank + 1, new Set([...trail, id]));
    };
    const entry = byId.get(text(graph.entry));
    if (entry) visit(entry, 0, new Set());
    const rows = new Map<number, number>();
    for (const node of nodes) {
      const rank = ranks.get(node.id) ?? Math.max(0, ...ranks.values());
      const column = rows.get(rank) ?? 0;
      rows.set(rank, column + 1);
      node.position = { x: column * 275, y: rank * 145 };
    }
  } else {
    const root = object(doc.root);
    const all = [
      { definition: root, path: "/root" },
      ...definitions.map((definition, index) => ({
        definition,
        path: `/definitions/${index}`,
      })),
    ];
    const identities = new Map(
      all.map(({ definition, path }) => [keyId(definition.key), path]),
    );
    const lanes = new Map<string, number>();
    const counts = new Map<string, number>();
    all.forEach(({ definition, path }) => {
      const kind = text(definition.kind);
      if (!lanes.has(kind)) lanes.set(kind, lanes.size);
      const row = counts.get(kind) ?? 0;
      counts.set(kind, row + 1);
      nodes.push({
        id: path,
        path,
        title:
          text(object(definition.annotations).title) ||
          text(object(definition.key).id),
        subtitle: kind,
        kind,
        outputs: ["relation"],
        position: { x: lanes.get(kind)! * 270, y: row * 130 },
      });
    });
    list(doc.relations)
      .map(object)
      .forEach((relation, index) => {
        const source = identities.get(keyId(relation.source));
        const ref = object(relation.target);
        let target = identities.get(keyId(ref));
        if (typeof ref.dependency === "string") {
          target = `external:${ref.dependency}:${keyId(ref.key)}`;
          if (!nodes.some((node) => node.id === target))
            nodes.push({
              id: target,
              path: `/relations/${index}/target`,
              title: text(object(ref.key).id),
              subtitle: ref.dependency,
              kind: "external",
              outputs: [],
              external: true,
              position: {
                x: lanes.size * 270,
                y: nodes.filter((node) => node.external).length * 130,
              },
            });
        }
        if (source && target)
          edges.push({
            id: `/relations/${index}`,
            source,
            target,
            label: text(relation.relation),
            path: `/relations/${index}`,
            handle: "relation",
          });
      });
  }
  if (
    view === "system" &&
    focusPath &&
    nodes.some((node) => node.path === focusPath)
  ) {
    const focus = nodes.find((node) => node.path === focusPath)!;
    const connections = edges.filter(
      (edge) => edge.source === focus.id || edge.target === focus.id,
    );
    const ids = new Set([
      focus.id,
      ...connections.flatMap((edge) => [edge.source, edge.target]),
    ]);
    const neighbors = nodes.filter(
      (node) => node.id !== focus.id && ids.has(node.id),
    );
    return {
      nodes: [
        {
          ...focus,
          position: { x: 0, y: Math.max(0, neighbors.length - 1) * 75 },
        },
        ...neighbors.map((node, index) => ({
          ...node,
          position: { x: 275, y: index * 150 },
        })),
      ],
      edges: connections,
    };
  }
  return { nodes, edges };
}
