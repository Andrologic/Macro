import type { AgsdlChange } from "../../types/agsdl";
import { createExample, createLegacyExample } from "./examples";
import {
  AGSDL_CONTRACT,
  sourceAt,
  keyId,
  list,
  object,
  pointerPart,
  readDocument,
  text,
} from "./document";
import { successors } from "./projection";

const set = (path: string, value: unknown): AgsdlChange => ({
  op: "set",
  path,
  valueJson: JSON.stringify(value),
});
const definitionIds = (doc: Record<string, unknown>): string[] => [
  text(object(object(doc.root).key).id),
  ...list(doc.definitions).map((definition) =>
    text(object(object(definition).key).id),
  ),
];
const nextId = (prefix: string, used: string[]) => {
  let index = 1;
  while (used.includes(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
};

export function renameStep(
  source: string,
  graphIndex: number,
  stepIndex: number,
  name: string,
): AgsdlChange[] {
  const doc = readDocument(source);
  if (doc.contract === AGSDL_CONTRACT) {
    if (graphIndex !== 0) throw new Error('Edit composition steps through their explicit composition source paths.');
    return renameFlowStep(source, stepIndex, name);
  }
  const graph = object(list(doc.graphs)[graphIndex]);
  const steps = list(graph.steps).map(object);
  const oldName = text(steps[stepIndex]?.id);
  if (
    !name.trim() ||
    steps.some((step, index) => index !== stepIndex && step.id === name)
  )
    throw new Error("Step identifiers must be nonempty and unique.");
  const base = `/graphs/${graphIndex}`;
  const changes = [set(`${base}/steps/${stepIndex}/id`, name)];
  if (graph.entry === oldName) changes.push(set(`${base}/entry`, name));
  steps.forEach((step, index) => {
    const path = `${base}/steps/${index}`;
    for (const field of [
      ...successors(step),
      ...(step.kind === "approval" ? ["call"] : []),
    ])
      if (step[field] === oldName) changes.push(set(`${path}/${field}`, name));
    for (const field of ["context", "test"])
      if (object(step[field]).step === oldName)
        changes.push(set(`${path}/${field}/step`, name));
    for (const [port, binding] of Object.entries(object(step.bindings)))
      if (object(binding).step === oldName)
        changes.push(set(`${path}/bindings/${pointerPart(port)}/step`, name));
  });
  return changes;
}

/** Add a complete Agent declaration. Adding its invocation remains a draft graph edit. */
export function addAgent(source: string, graphIndex?: number): AgsdlChange[] {
  const doc = readDocument(source);
  if (doc.contract === AGSDL_CONTRACT) {
    if (graphIndex !== undefined && graphIndex !== 0) throw new Error('Composition Agents require an explicitly declared Agent parameter.');
    return addPersistentAgent(source, graphIndex);
  }
  const root = object(object(doc.root).key);
  if (!root.scope || !root.id || !root.version)
    throw new Error("Define the system root before adding an agent.");
  const used = definitionIds(doc);
  const suffixes = [
    "",
    "-principal",
    "-interface",
    "-action",
    "-instructions",
    "-resource",
  ];
  let number = 1;
  while (suffixes.some((suffix) => used.includes(`agent-${number}${suffix}`)))
    number++;
  const id = `agent-${number}`;
  const sample = readDocument(createLegacyExample("release"));
  const firstId = "checklist";
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      const record = object(value);
      if (
        Object.keys(record).length === 3 &&
        typeof record.scope === "string" &&
        typeof record.id === "string" &&
        typeof record.version === "string"
      ) {
        if (record.id === "system") return root;
        return {
          scope: root.scope,
          id: record.id
            .replace(firstId, id)
            .replace("project", `${id}-resource`),
          version: root.version,
        };
      }
      return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [key, rewrite(item)]),
      );
    }
    return value;
  };
  const definitions = list(sample.definitions).filter(
    (def) =>
      text(object(object(def).key).id).startsWith(firstId) ||
      object(object(def).key).id === "project",
  );
  const changes = definitions.map((def) => {
    const rewritten = object(rewrite(def));
    if (rewritten.kind === "Agent")
      rewritten.annotations = { ...object(rewritten.annotations), title: id };
    if (rewritten.kind === "Instructions")
      rewritten.payload = {
        ...object(rewritten.payload),
        body: "Describe this agent’s responsibility, expected evidence, and completion criteria.",
      };
    return set("/definitions/-", rewritten);
  });
  changes.push(
    ...list(sample.relations)
      .filter((relation) => object(object(relation).source).id === firstId)
      .map((relation) => set("/relations/-", rewrite(relation))),
  );
  if (graphIndex !== undefined) {
    const graph = object(list(doc.graphs)[graphIndex]);
    const inputs = object(graph.inputs);
    const inputNames = Object.keys(inputs);
    const brief = nextId("brief", inputNames);
    const context = nextId("context", inputNames);
    changes.push(
      set(`/graphs/${graphIndex}/inputs/${brief}`, "string"),
      set(`/graphs/${graphIndex}/inputs/${context}`, "json"),
    );
    const step = object(rewrite(list(object(list(sample.graphs)[0]).steps)[0]));
    const stepId = nextId(
      "step",
      list(graph.steps).map((item) => text(object(item).id)),
    );
    changes.push(
      set(`/graphs/${graphIndex}/steps/-`, {
        ...step,
        id: stepId,
        context: { input: context },
        bindings: { brief: { input: brief } },
        success: "",
        failure: "",
      }),
    );
    list(object(doc.runtime).configurations)
      .map(object)
      .forEach((configuration, index) => {
        if (keyId(configuration.graph) !== keyId(graph.definition)) return;
        const binding = list(
          object(list(object(sample.runtime).configurations)[0]).agents,
        )[0];
        changes.push(
          set(`/runtime/configurations/${index}/agents/-`, rewrite(binding)),
        );
      });
  }
  return changes;
}

export function addStep(
  source: string,
  graphIndex: number,
  kind: "condition" | "approval" | "end" | "prepare" | "call" | "join",
): AgsdlChange[] {
  const doc = readDocument(source);
  if (doc.contract === AGSDL_CONTRACT) {
    if (graphIndex !== 0) throw new Error('Edit composition steps through their explicit composition source paths.');
    return addFlowStep(source, kind);
  }
  const graph = object(list(doc.graphs)[graphIndex]);
  const id = nextId(
    kind,
    list(graph.steps).map((item) => text(object(item).id)),
  );
  const base = `/graphs/${graphIndex}`;
  if (kind === "end")
    return [
      set(`${base}/steps/-`, {
        id,
        kind,
        outcome: "failure",
        reason: "Describe the terminal outcome.",
      }),
    ];
  if (kind === "condition") {
    const input = nextId("condition", Object.keys(object(graph.inputs)));
    return [
      set(`${base}/inputs/${input}`, "boolean"),
      set(`${base}/steps/-`, {
        id,
        kind,
        test: { input },
        true: "",
        false: "",
        failure: "",
      }),
    ];
  }
  const root = object(object(doc.root).key);
  const used = definitionIds(doc);
  const principal = { ...root, id: nextId("approver", used) };
  const requirement = { ...root, id: nextId("approval", used) };
  return [
    set("/definitions/-", {
      key: principal,
      kind: "Principal",
      owner: root,
      payload: {},
    }),
    set("/definitions/-", {
      key: requirement,
      kind: "ApprovalRequirement",
      owner: root,
      payload: { approvers: [principal], validForMs: 60000 },
    }),
    set(`${base}/steps/-`, {
      id,
      kind,
      call: "",
      requirement,
      timeoutMs: 60000,
      approved: "",
      denied: "",
      failure: "",
    }),
  ];
}

export function addDefinition(source: string, kind: string): AgsdlChange[] {
  if (kind === "Agent") return addAgent(source);
  const doc = readDocument(source);
  if (doc.contract === AGSDL_CONTRACT) return addPersistentDeclaration(source, kind);
  const root = object(object(doc.root).key);
  const id = nextId(kind.toLowerCase(), definitionIds(doc));
  const key = { ...root, id };
  let payload: unknown = {};
  const changes: AgsdlChange[] = [];
  if (kind === "Instructions")
    payload = {
      target: "Agent",
      at: "before-invoke",
      format: { identity: "text/plain", version: "1" },
      body: "Describe the instructions.",
      requires: [],
    };
  if (kind === "Skill")
    payload = {
      inputs: {},
      outputs: {},
      preconditions: "Describe prerequisites.",
      completion: "Describe completion.",
      dependencies: [],
      tools: [],
      requires: [],
    };
  if (kind === "Tool") {
    const action = {
      ...root,
      id: nextId("action", definitionIds(doc)),
    };
    changes.push(
      set("/definitions/-", {
        key: action,
        kind: "Action",
        owner: root,
        payload: {},
      }),
    );
    payload = {
      action,
      inputs: {},
      outputs: {},
      effects: "unknown",
      failures: [],
      requires: [],
    };
  }
  changes.push(set("/definitions/-", { key, owner: root, kind, payload }));
  return changes;
}

function renameFlowStep(source: string, index: number, name: string): AgsdlChange[] {
  const flow = object(readDocument(source).flow), steps = object(flow.steps);
  const old = Object.keys(steps)[index];
  if (!old) throw new Error('Select an existing flow step.');
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || (name !== old && Object.hasOwn(steps, name))) throw new Error('Step identifiers must be valid AgSDL names and unique.');
  if (old === name) return [];
  const base = '/flow/steps';
  const changes: AgsdlChange[] = [{ op: 'set', path: `${base}/${pointerPart(name)}`, valueJson: sourceAt(source, `${base}/${pointerPart(old)}`) }, { op: 'remove', path: `${base}/${pointerPart(old)}` }];
  if (flow.entry === old) changes.push(set('/flow/entry', name));
  for (const [id, value] of Object.entries(steps)) {
    const step = object(value), path = `${base}/${pointerPart(id === old ? name : id)}`;
    const rewriteTargets = (targets: unknown, targetPath: string) => list(targets).forEach((target, position) => { if (target === old) changes.push(set(`${targetPath}/${position}`, name)); });
    if (Array.isArray(step.next)) rewriteTargets(step.next, `${path}/next`);
    else for (const [output, targets] of Object.entries(object(step.next))) rewriteTargets(targets, `${path}/next/${pointerPart(output)}`);
    rewriteTargets(step.onError, `${path}/onError`);
    rewriteTargets(step.members, `${path}/members`);
    for (const field of ['call', 'after', 'steers']) if (step[field] === old) changes.push(set(`${path}/${field}`, name));
  }
  return changes;
}
function addPersistentAgent(source: string, graphIndex?: number): AgsdlChange[] {
  const doc = readDocument(source);
  const id = nextId('agent', Object.keys(object(doc.agents)));
  const configuration = nextId(`${id}-configuration`, Object.keys(object(doc.configurations)));
  const binding = nextId(`${id}-engine`, Object.keys(object(doc.bindings)));
  const sample = readDocument(createExample('release'));
  const agent = structuredClone(object(object(sample.agents).checklist));
  agent.configuration = configuration;
  agent.prompt = [{ value: 'Describe this agent’s responsibility, expected evidence, and completion criteria.' }];
  agent.resources = {};
  const changes = [
    set(`/bindings/${pointerPart(binding)}`, object(sample.bindings).engine),
    set(`/configurations/${pointerPart(configuration)}`, { engine: binding }),
    set(`/agents/${pointerPart(id)}`, agent),
  ];
  if (graphIndex !== undefined) {
    const flow = object(doc.flow), steps = object(flow.steps);
    const stepId = nextId('step', Object.keys(steps));
    if (!doc.flow) changes.push(set('/flow', { entry: stepId, steps: { [stepId]: { type: 'agent', agent: id, next: [] } } }));
    else changes.push(set(`/flow/steps/${pointerPart(stepId)}`, { type: 'agent', agent: id, next: [] }));
  }
  return changes;
}
function addFlowStep(source: string, kind: string): AgsdlChange[] {
  const doc = readDocument(source), flow = object(doc.flow), steps = object(flow.steps);
  if (!doc.flow) throw new Error('Add an Agent flow before adding another step.');
  if (kind === 'end') throw new Error('AgSDL 0.2 ends a branch with an empty next list.');
  const id = nextId(kind, Object.keys(steps)), path = `/flow/steps/${pointerPart(id)}`;
  if (kind === 'condition') return [set(path, { type: kind, test: { equals: [{ value: true }, { value: true }] }, next: { true: [], false: [] } })];
  if (kind === 'prepare') return [set(path, { type: kind, message: { prompt: [{ value: 'Describe the next work.' }] }, next: [] })];
  if (kind === 'join') throw new Error('A Join requires an existing direct fork and its member steps. Author these references explicitly.');
  if (kind === 'approval') throw new Error('An Approval requires an existing protected Call and explicit approval binding. Author these references explicitly.');
  if (kind === 'call') {
    const binding = nextId('call', Object.keys(object(doc.bindings)));
    return [set(`/bindings/${binding}`, { contract: { identity: 'example/call', version: '1' }, implementation: { identity: 'example/configure-call', version: '1' }, effects: 'unknown' }), set(path, { type: kind, binding, next: [] })];
  }
  throw new Error('Unsupported AgSDL 0.2 step type.');
}
function addPersistentDeclaration(source: string, kind: string): AgsdlChange[] {
  const doc = readDocument(source);
  if (kind === 'Instructions' || kind === 'Resource') {
    const id = nextId(kind.toLowerCase(), Object.keys(object(doc.content)));
    return [set(doc.content === undefined ? '/content' : `/content/${id}`, doc.content === undefined ? { [id]: { value: '' } } : { value: '' })];
  }
  if (kind === 'Skill') {
    const id = nextId('skill', Object.keys(object(doc.skills)));
    const skill = { prompt: [{ value: 'Describe reusable instructions.' }] };
    return [set(doc.skills === undefined ? '/skills' : `/skills/${id}`, doc.skills === undefined ? { [id]: skill } : skill)];
  }
  if (kind === 'Tool') {
    const id = nextId('tool', Object.keys(object(doc.bindings)));
    return [set(`/bindings/${id}`, { contract: { identity: 'example/tool', version: '1' }, implementation: { identity: 'example/configure-tool', version: '1' }, effects: 'unknown' })];
  }
  throw new Error('This definition kind belongs to AgSDL 0.1. Use Agents, content, skills or bindings in 0.2.');
}
