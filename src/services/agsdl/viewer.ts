import { keyId, list, object, readDocument, text } from "./document";
import { successors } from "./projection";

type Value = Record<string, unknown>;
export interface ViewerReference {
  label: string;
  target?: string;
  port?: string;
  unresolved?: boolean;
  source: "input" | "step" | "literal" | "unknown";
}
export interface ViewerPort {
  name: string;
  type: string;
  binding?: ViewerReference;
}
export interface ViewerCard {
  path: string;
  id: string;
  title: string;
  kind: string;
  mission: string;
  unresolved: boolean;
  dependencies?: ViewerReference[];
  outcome?: string;
  tools?: ViewerReference[];
  interfaces?: ViewerReference[];
  issueCount?: number;
  resources?: ViewerReference[];
  approvers?: ViewerReference[];
  approvalCall?: ViewerReference;
  inputs: ViewerPort[];
  outputs: ViewerPort[];
  branches: Array<{ label: string; reference: ViewerReference }>;
  details: Value;
}
export interface ViewerGraph {
  path: string;
  title: string;
  entry: ViewerReference;
  inputs: ViewerPort[];
  outputs: ViewerPort[];
  cards: ViewerCard[];
}
const display = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");
const title = (value: Value): string =>
  text(object(value.annotations).title) ||
  text(value.name) ||
  text(object(value.key).id) ||
  text(value.id);
const ports = (value: unknown): ViewerPort[] =>
  Object.entries(object(value)).map(([name, type]) => ({
    name,
    type: display(type),
  }));

/** A reading model only. Unresolved and ambiguous references never become links. */
export function projectViewer(source: string) {
  const doc = readDocument(source);
  if (doc.contract !== "agsdl-0.1.0")
    throw new Error("Unsupported or missing AgSDL contract.");
  const definitions = list(doc.definitions).map(object);
  const resolve = (ref: unknown) => {
    if (!text(object(ref).id)) return undefined;
    const matches = definitions.filter(
      (definition) => keyId(definition.key) === keyId(ref),
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const definitionReference = (ref: unknown): ViewerReference => {
    const definition = resolve(ref);
    const external = object(ref);
    return {
      label: definition
        ? title(definition)
        : text(external.dependency)
          ? `${text(external.dependency)} · ${text(object(external.key).id)}`
          : text(external.id) || display(ref),
      source: "unknown",
      target: definition ? `/definitions/${definitions.indexOf(definition)}` : undefined,
      unresolved: !definition,
    };
  };
  const toolsFor = (agent: Value | undefined) =>
    list(doc.relations)
      .map(object)
      .filter(
        (relation) =>
          agent &&
          relation.relation === "uses" &&
          (relation.expectedKind === "Tool" || resolve(relation.target)?.kind === "Tool") &&
          keyId(relation.source) === keyId(agent.key),
      )
      .map((relation) => definitionReference(relation.target));
  const mission = (agent: Value | undefined) => {
    if (!agent) return "";
    const instructions = list(doc.relations)
      .map(object)
      .filter(
        (relation) =>
          relation.relation === "directedBy" &&
          keyId(relation.source) === keyId(agent.key),
      )
      .map((relation) => resolve(relation.target))
      .filter((definition) => definition?.kind === "Instructions")
      .map((definition) => text(object(definition?.payload).body));
    return [
      text(object(agent.annotations).description),
      text(object(agent.payload).mission),
      ...instructions,
    ]
      .filter(Boolean)
      .join("\n\n");
  };
  const graphs: ViewerGraph[] = list(doc.graphs).map((value, graphIndex) => {
    const graph = object(value);
    const path = `/graphs/${graphIndex}`;
    const steps = list(graph.steps).map(object);
    const agentFor = (step: Value) => {
      const agent = resolve(step.agent);
      return agent?.kind === "Agent" ? agent : undefined;
    };
    const stepTitle = (step: Value) =>
      title(step) && text(object(step.annotations).title)
        ? title(step)
        : title(agentFor(step) ?? {}) || title(step);
    const reference = (id: unknown): ViewerReference => {
      const matches = steps
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => text(id) !== "" && step.id === id);
      if (matches.length !== 1)
        return { label: display(id), unresolved: true, source: "step" };
      const { step, index } = matches[0];
      return {
        label: stepTitle(step),
        target: `${path}/steps/${index}`,
        source: "step",
      };
    };
    const binding = (value: unknown): ViewerReference => {
      const ref = object(value);
      if (typeof ref.input === "string")
        return {
          label: ref.input,
          source: "input",
          unresolved: !Object.hasOwn(object(graph.inputs), ref.input),
        };
      if (typeof ref.step === "string") {
        const result = reference(ref.step);
        const step = steps.find((step) => step.id === ref.step);
        const validPort =
          typeof ref.port === "string" &&
          Object.hasOwn(object(step?.outputs), ref.port);
        return {
          ...result,
          label: `${result.label} · ${display(ref.port)}`,
          port: typeof ref.port === "string" ? ref.port : undefined,
          unresolved: result.unresolved || !validPort,
          target: validPort ? result.target : undefined,
        };
      }
      if (Object.hasOwn(ref, "literal"))
        return { label: display(ref.literal), source: "literal" };
      return { label: display(value), source: "unknown", unresolved: true };
    };
    const cards = steps.map((step, index): ViewerCard => {
      const agent = agentFor(step);
      const bindings = object(step.bindings);
      const names = new Set([
        ...Object.keys(object(step.inputs)),
        ...Object.keys(bindings),
      ]);
      const inputs = [...names].map((name) => ({
        name,
        type: display(object(step.inputs)[name]),
        binding: Object.hasOwn(bindings, name)
          ? binding(bindings[name])
          : undefined,
      }));
      for (const field of ["context", "test"])
        if (Object.hasOwn(step, field))
          inputs.push({ name: field, type: "", binding: binding(step[field]) });
      return {
        path: `${path}/steps/${index}`,
        id: text(step.id),
        title: stepTitle(step),
        kind: text(step.kind),
        mission:
          mission(agent) ||
          text(step.reason) ||
          text(object(step.annotations).description),
        unresolved: step.kind === "invoke" && !agent,
        inputs: step.kind === "end" ? [] : inputs,
        outputs: step.kind === "end" ? inputs : ports(step.outputs),
        outcome: text(step.outcome),
        tools: toolsFor(agent),
        interfaces: Object.hasOwn(step, "interface") ? [definitionReference(step.interface)] : [],
        resources: list(step.resources).map(definitionReference),
        ...(step.kind === "approval" ? {
          approvers: list(object(resolve(step.requirement)?.payload).approvers).map(definitionReference),
          approvalCall: reference(step.call),
        } : {}),
        branches: successors(step).map((label) => ({
          label,
          reference: reference(step[label]),
        })),
        details: { ...step, ...(agent ? { agentDefinition: agent } : {}) },
      };
    });
    return {
      path,
      title:
        title(resolve(graph.definition) ?? {}) ||
        title(graph) ||
        text(object(graph.definition).id),
      entry: reference(graph.entry),
      inputs: ports(graph.inputs),
      outputs: ports(graph.outputs),
      cards,
    };
  });
  const declarations = definitions.map((definition, index): ViewerCard => ({
    path: `/definitions/${index}`,
    id: text(object(definition.key).id),
    title: title(definition),
    kind: text(definition.kind),
    mission:
      mission(definition) ||
      text(object(definition.payload).body) ||
      text(object(definition.annotations).description),
    unresolved: false,
    tools: toolsFor(definition),
    interfaces: list(doc.relations).map(object).filter(relation => relation.relation === "exposes" && keyId(relation.source) === keyId(definition.key)).map(relation => definitionReference(relation.target)),
    inputs: [],
    outputs: [],
    branches: [],
    details: definition,
  }));
  const migration = object(object(object(doc.root).annotations).macroMigration);
  const archive = definitions.find(
    (definition) =>
      definition.kind === "Resource" &&
      object(definition.key).id === "macro-legacy-plan",
  );
  const legacyNodes =
    migration.version === 1
      ? list(object(archive?.payload).nodes).map(object)
      : [];
  const legacyCards: ViewerCard[] = legacyNodes.map((node, index) => {
    const agents = definitions.filter(
      (definition) =>
        definition.kind === "Agent" &&
        object(definition.annotations).macroLegacyNodeId === node.id,
    );
    const agent = agents.length === 1 ? agents[0] : undefined;
    return {
      path: `/legacy/${index}`,
      id: text(node.id),
      title: title(agent ?? {}) || text(node.title),
      kind: "Agent",
      mission: mission(agent) || text(node.description),
      tools: toolsFor(agent),
      unresolved: false,
      inputs: [],
      outputs: list(node.artifactContracts)
        .map(object)
        .map((artifact) => ({
          name: text(artifact.title) || text(artifact.id),
          type: text(artifact.kind),
        })),
      dependencies: list(node.dependencies).map((id) => {
        const matches = legacyNodes
          .map((node, index) => ({ node, index }))
          .filter(({ node }) => node.id === id);
        return matches.length === 1
          ? {
              label: text(matches[0].node.title),
              target: `/legacy/${matches[0].index}`,
              source: "step",
            }
          : { label: display(id), unresolved: true, source: "step" };
      }),
      branches: [],
      details: node,
    };
  });
  return {
    title: title(object(doc.root)),
    systemDetails: { root: doc.root, runtime: doc.runtime },
    graphs,
    legacyCards,
    migrated: migration.version === 1,
    migrationIssues: list(migration.issues).map(text),
    declarations,
    unresolved: list(doc.unresolved),
    dependencies: list(doc.dependencies),
  };
}
