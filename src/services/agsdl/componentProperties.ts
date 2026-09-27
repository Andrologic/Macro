import type { AgsdlChange } from "../../types/agsdl";
import { keyId, list, object, pointerPart, readDocument, scanSource, text } from "./document";
import type { ViewerCard } from "./viewer";

export interface PropertyOption { value: string; label: string }
export interface ComponentProperty {
  path: string;
  label: string;
  value: string;
  options?: PropertyOption[];
  readonly?: boolean;
  /** A new relation is appended only when the optional reference is selected. */
  relationSource?: string;
  removePath?: string;
  referenceGroup?: string;
}
export interface ComponentProperties { fields: ComponentProperty[]; shared: boolean; unsupported: boolean }
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = object(a), right = object(b);
    return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
  }
  return false;
};

/** Project the real owners. Unsupported contracts stay readable and are never rewritten. */
export function componentProperties(source: string, card: ViewerCard): ComponentProperties {
  const doc = readDocument(source);
  const parsed = scanSource(source);
  const decoder = new TextDecoder();
  const raw = (path: string) => {
    const span = parsed.spans.get(path);
    if (!span) throw new Error(`Missing property: ${path}`);
    return decoder.decode(parsed.bytes.subarray(span.start, span.end));
  };
  const definitions = list(doc.definitions).map(object);
  const graphs = list(doc.graphs).map(object);
  const steps = graphs.flatMap(graph => list(graph.steps).map(object));
  const relations = list(doc.relations).map(object);
  const unique = (key: unknown) => {
    if (!["scope", "id", "version"].every(part => text(object(key)[part]))) return undefined;
    const matches = definitions.map((value, index) => ({ value, index })).filter(({ value }) => keyId(value.key) === keyId(key));
    return matches.length === 1 ? matches[0] : undefined;
  };
  let owner = card.details, path = card.path;
  if (path.startsWith("/legacy/")) {
    const matches = definitions.map((value, index) => ({ value, index })).filter(({ value }) => value.kind === "Agent" && object(value.annotations).macroLegacyNodeId === card.id);
    if (matches.length !== 1) return { fields: [], shared: false, unsupported: true };
    owner = matches[0].value; path = `/definitions/${matches[0].index}`;
  }
  const fields: ComponentProperty[] = [];
  let unsupported = ["Resource", "Tool"].includes(text(owner.kind));
  const options = (kind: string): PropertyOption[] => definitions.flatMap((definition, index) =>
    definition.kind === kind && unique(definition.key) ? [{ value: raw(`/definitions/${index}/key`), label: [text(object(definition.annotations).title), `${text(object(definition.key).scope)}/${text(object(definition.key).id)}@${text(object(definition.key).version)}`].filter(Boolean).join(" · ") }] : []);
  const reference = (at: string, value: unknown, label: string, kind: string, allowed = options(kind), readonly = false) => {
    let original: string;
    try { original = raw(at); } catch { unsupported = true; return; }
    const resolved = unique(value);
    const selected = allowed.find(option => keyId(JSON.parse(option.value)) === keyId(value));
    const valueText = selected?.value ?? original;
    fields.push({ path: at, label, value: valueText, readonly,
      options: selected ? allowed : [{ value: valueText, label: text(object(value).id) || text(object(object(value).key).id) || "?" }, ...allowed] });
    if (!resolved) unsupported = true;
  };
  const agent = owner.kind === "invoke" ? unique(owner.agent) : owner.kind === "Agent" ? unique(owner.key) : undefined;
  if (agent?.value.kind === "Agent") {
    const configured = list(object(doc.runtime).configurations).map(object).flatMap(configuration => list(configuration.agents).map(object)).some(binding => keyId(binding.agent) === keyId(agent.value.key) && (list(binding.tools).length > 0 || binding.engine != null));
    if (configured) unsupported = true;
    const agentPath = `/definitions/${agent.index}`;
    relations.forEach((relation, index) => {
      if (keyId(relation.source) !== keyId(agent.value.key)) return;
      if (relation.relation === "uses" && relation.expectedKind === "Tool") {
        reference(`/relations/${index}/target`, relation.target, "tools", "Tool", options("Tool"), configured);
        const field = fields.at(-1);
        if (field?.path === `/relations/${index}/target`) { field.referenceGroup = `tools:${agent.index}`; field.removePath = `/relations/${index}`; field.options!.unshift({ value: "", label: "remove" }); }
      }
      if (relation.relation === "exposes") {
        const consumed = steps.some(step => keyId(step.agent) === keyId(agent.value.key) && keyId(step.interface) === keyId(relation.target));
        reference(`/relations/${index}/target`, relation.target, "exposedInterfaces", "Interface", options("Interface"), consumed);
        const field = fields.at(-1);
        if (field?.path === `/relations/${index}/target`) field.referenceGroup = `interfaces:${agent.index}`;
        if (consumed) unsupported = true;
      }
    });
    if (Array.isArray(doc.relations) && !configured) fields.push({ path: "/relations/-", label: "addTool", value: "", options: [{ value: "", label: "none" }, ...options("Tool").filter(option => !relations.some(relation => relation.relation === "uses" && keyId(relation.source) === keyId(agent.value.key) && keyId(relation.target) === keyId(JSON.parse(option.value))))], referenceGroup: `tools:${agent.index}`, relationSource: raw(`${agentPath}/key`) });
  }
  if (owner.kind === "invoke") {
    const candidates = options("Interface").filter(option => {
      const definition = unique(JSON.parse(option.value))?.value;
      const operations = list(object(definition?.payload).operations).map(object).filter(operation => operation.id === owner.operation);
      return operations.length === 1 && ["inbound", "bidirectional"].includes(text(operations[0].direction)) && operations[0].mode === "request-response" && same(operations[0].inputs, owner.inputs) && same(operations[0].outputs, owner.outputs) && keyId(operations[0].action) === keyId(owner.action) && relations.some(relation => relation.relation === "exposes" && keyId(relation.source) === keyId(owner.agent) && keyId(relation.target) === keyId(JSON.parse(option.value)));
    });
    if (Object.hasOwn(owner, "interface")) reference(`${path}/interface`, owner.interface, "interfaces", "Interface", candidates);
    fields.push({ path: `${path}/operation`, label: "operation", value: text(owner.operation), readonly: true });
    if (Array.isArray(owner.resources)) {
      owner.resources.forEach((resource, index) => {
        reference(`${path}/resources/${index}`, resource, "resources", "Resource");
        const field = fields.at(-1)!; field.referenceGroup = `${path}/resources`; field.removePath = field.path; field.options!.unshift({ value: "", label: "remove" });
      });
      fields.push({ path: `${path}/resources/-`, label: "addResource", value: "", referenceGroup: `${path}/resources`, options: [{ value: "", label: "none" }, ...options("Resource").filter(option => !list(owner.resources).some(resource => keyId(resource) === keyId(JSON.parse(option.value))))] });
    } else unsupported = true;
  }
  const contracts = (at: string, value: Record<string, unknown>, consumed: boolean) => {
    for (const direction of ["inputs", "outputs"]) Object.entries(object(value[direction])).forEach(([name, type]) => {
      if (typeof type !== "string") { unsupported = true; return; }
      fields.push({ path: `${at}/${direction}/${pointerPart(name)}`, label: `${direction} · ${name}`, value: type, readonly: consumed,
        options: [...new Set([type, "string", "boolean", "json"])].map(value => ({ value, label: value })) });
    });
    if (consumed) unsupported = true;
  };
  if (owner.kind === "invoke") contracts(path, owner, true);
  if (owner.kind === "Interface") list(object(owner.payload).operations).map(object).forEach((operation, index) => {
    const at = `${path}/payload/operations/${index}`;
    const consumed = steps.some(step => keyId(step.interface) === keyId(owner.key) && step.operation === operation.id);
    fields.push({ path: `${at}/id`, label: "operation", value: text(operation.id), readonly: true });
    contracts(at, operation, consumed);
  });
  if (owner.kind === "Tool") {
    const referencesOwner = (value: unknown): boolean => {
      if (value === owner) return false;
      if (Array.isArray(value)) return value.some(referencesOwner);
      if (!value || typeof value !== "object") return false;
      const record = object(value);
      return (typeof record.id === "string" && keyId(record) === keyId(owner.key)) || Object.values(record).some(referencesOwner);
    };
    // The card is a projection; skip the source definition rather than that copy.
    const ownIndex = Number(path.split("/")[2]);
    const elsewhere = { ...doc, definitions: definitions.filter((_, index) => index !== ownIndex) };
    contracts(`${path}/payload`, object(owner.payload), referencesOwner(elsewhere));
  }
  return { fields, shared: Boolean(agent) || path.startsWith("/definitions/"), unsupported };
}

export function propertyChanges(fields: ComponentProperty[], values: string[]): AgsdlChange[] {
  for (const group of new Set(fields.map(field => field.referenceGroup).filter(Boolean))) {
    const members = fields.map((field, index) => ({ field, value: values[index] ?? field.value })).filter(item => item.field.referenceGroup === group);
    if (!members.some(item => item.value !== item.field.value)) continue;
    const keys = members.filter(item => item.value).map(item => {
      const ref = object(JSON.parse(item.value));
      return text(ref.dependency) ? JSON.stringify([ref.dependency, keyId(ref.key)]) : keyId(ref);
    });
    if (new Set(keys).size !== keys.length) throw new Error("agsdl.viewer.duplicateReference");
  }
  const resourceParents = new Set(fields.filter(field => /\/resources\/(?:\d+|-)$/.test(field.path)).map(field => field.path.slice(0, field.path.lastIndexOf("/"))));
  for (const parent of resourceParents) {
    const remaining = fields.filter((field, index) => field.path.startsWith(`${parent}/`) && (values[index] ?? field.value) !== "").length;
    const changed = fields.some((field, index) => field.path.startsWith(`${parent}/`) && values[index] !== field.value);
    if (changed && !remaining) throw new Error("agsdl.viewer.resourceRequired");
  }
  const changes = fields.flatMap((field, index): AgsdlChange[] => {
    const value = values[index];
    if (field.readonly || value === field.value || value === undefined) return [];
    if (value === "") return field.removePath ? [{ op: "remove", path: field.removePath }] : [];
    if (field.options && !field.options.some(option => option.value === value)) throw new Error("agsdl.viewer.invalidPropertySelection");
    if (field.relationSource) return [{ op: "set", path: field.path, valueJson: `{"source":${field.relationSource},"relation":"uses","target":${value},"expectedKind":"Tool"}` }];
    const isReference = /\/(target|interface|resources\/(?:\d+|-))$/.test(field.path);
    return [{ op: "set", path: field.path, valueJson: isReference ? value : JSON.stringify(value) }];
  });
  // Replace existing entries and append first; remove array entries from the end.
  return [...changes.filter(change => change.op !== "remove"), ...changes.filter(change => change.op === "remove").sort((a, b) => Number(b.path.split("/").at(-1)) - Number(a.path.split("/").at(-1)))];
}
