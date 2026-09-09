import type { AgsdlEditorDocument } from "../../types/agsdl";
import type { ArchitectPlanRecord } from "../architectPlanService";

const CONTRACT = "agsdl-0.1.0";
const VERSION = "1";

type LegacyPlan = Pick<
  ArchitectPlanRecord,
  "id" | "title" | "label" | "description" | "nodes" | "predictedBranches"
>;

const key = (scope: string, id: string) => ({ scope, id, version: VERSION });

const safeId = (value: string, fallback: string): string => {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  return normalized || fallback;
};

const issueCodes = (plan: LegacyPlan): string[] => {
  const issues: string[] = [];
  const ids = new Set<string>();
  const nodeIds = new Set(plan.nodes.map((node) => node.id));
  let hasCycle = false;

  for (const node of plan.nodes) {
    if (ids.has(node.id)) issues.push("duplicate-node-id");
    ids.add(node.id);
    if (node.dependencies.some((dependency) => !nodeIds.has(dependency))) {
      issues.push("missing-dependency");
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (hasCycle || visited.has(id)) return;
    if (visiting.has(id)) {
      hasCycle = true;
      return;
    }
    visiting.add(id);
    const node = plan.nodes.find((candidate) => candidate.id === id);
    node?.dependencies.forEach((dependency) => {
      if (nodeIds.has(dependency)) visit(dependency);
    });
    visiting.delete(id);
    visited.add(id);
  };
  plan.nodes.forEach((node) => visit(node.id));
  if (hasCycle) issues.push("cyclic-dependencies");

  const dependencyEdges = plan.nodes.reduce(
    (count, node) => count + node.dependencies.length,
    0,
  );
  const dependencyCounts = new Map(plan.nodes.map((node) => [node.id, 0]));
  for (const node of plan.nodes) {
    for (const dependency of node.dependencies) {
      if (nodeIds.has(dependency)) {
        dependencyCounts.set(dependency, (dependencyCounts.get(dependency) ?? 0) + 1);
      }
    }
  }
  const roots = plan.nodes.filter((node) => node.dependencies.length === 0);
  const terminals = plan.nodes.filter((node) => (dependencyCounts.get(node.id) ?? 0) === 0);
  const simpleChain =
    plan.nodes.length <= 1 ||
    (dependencyEdges === plan.nodes.length - 1 &&
      roots.length === 1 &&
      terminals.length === 1 &&
      plan.nodes.every(
        (node) => node.dependencies.length <= 1 && (dependencyCounts.get(node.id) ?? 0) <= 1,
      ));
  if (dependencyEdges > 0 && !simpleChain) issues.push("nonlinear-dependencies");
  issues.push("execution-not-migrated");
  return [...new Set(issues)];
};

const nodeBody = (node: LegacyPlan["nodes"][number]): string => {
  const todos = (node.todos ?? [])
    .map((todo) => `${todo.status}: ${todo.title}${todo.description ? `\n${todo.description}` : ""}`)
    .join("\n");
  return [node.description || "", todos].filter(Boolean).join("\n\n");
};

/**
 * Projects a legacy Macro strategy into a read-only AgSDL document.
 *
 * The exact legacy records live in a Resource payload. The generated Agents and
 * Instructions are descriptive declarations only; no AgSDL graph or execution
 * configuration is emitted.
 */
export const convertLegacyPlan = (plan: LegacyPlan): AgsdlEditorDocument | null => {
  if (plan.nodes.length === 0 && plan.predictedBranches.length === 0) return null;

  const scope = `macro-plan-${safeId(plan.id, "legacy")}`;
  const root = key(scope, "system");
  const definitions: Array<Record<string, unknown>> = [];
  const relations: Array<Record<string, unknown>> = [];

  plan.nodes.forEach((node, index) => {
    const nodeId = safeId(node.id, `node-${index + 1}`);
    const agent = key(scope, `agent-${nodeId}-${index + 1}`);
    const principal = key(scope, `principal-${nodeId}-${index + 1}`);
    const instructions = key(scope, `instructions-${nodeId}-${index + 1}`);
    const iface = key(scope, `interface-${nodeId}-${index + 1}`);
    definitions.push(
      {
        key: agent,
        kind: "Agent",
        owner: root,
        annotations: {
          title: node.title,
          macroLegacyNodeId: node.id,
          macroStatus: node.status,
        },
        payload: {},
      },
      { key: principal, kind: "Principal", owner: root, payload: {} },
      {
        key: instructions,
        kind: "Instructions",
        owner: root,
        payload: {
          target: "Agent",
          at: "before-invoke",
          format: { identity: "macro/legacy-plan", version: VERSION },
          body: nodeBody(node),
          requires: [],
        },
      },
      { key: iface, kind: "Interface", owner: root, payload: {} },
    );
    relations.push(
      {
        source: agent,
        relation: "actsAs",
        target: principal,
        expectedKind: "Principal",
      },
      {
        source: agent,
        relation: "directedBy",
        target: instructions,
        expectedKind: "Instructions",
      },
      {
        source: agent,
        relation: "exposes",
        target: iface,
        expectedKind: "Interface",
      },
    );
  });

  const issues = issueCodes(plan);
  const resource = {
    key: key(scope, "macro-legacy-plan"),
    kind: "Resource",
    owner: root,
    payload: {
      id: plan.id,
      title: plan.title,
      label: plan.label ?? null,
      description: plan.description,
      nodes: plan.nodes,
      predictedBranches: plan.predictedBranches,
    },
  };
  definitions.push(resource);

  const source = JSON.stringify(
    {
      contract: CONTRACT,
      root: {
        key: root,
        kind: "System",
        annotations: {
          title: plan.label || plan.title,
          macroMigration: { version: 1, issues },
        },
      },
      definitions,
      relations,
      exports: [],
      dependencies: [],
      unresolved: [],
      extensions: [],
    },
    null,
    2,
  );
  return { revision: 1, source, annexes: {} };
};
