import type { AgsdlChange } from "../../types/agsdl";
import { createExample } from "./examples";
import {
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
  const graph = object(list(readDocument(source).graphs)[graphIndex]);
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
  const sample = readDocument(createExample("release"));
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
  kind: "condition" | "approval" | "end",
): AgsdlChange[] {
  const doc = readDocument(source);
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
