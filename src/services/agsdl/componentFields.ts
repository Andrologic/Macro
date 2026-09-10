import { keyId, list, object, readDocument, text } from "./document";
import type { ViewerCard } from "./viewer";
import type { AgsdlChange } from "../../types/agsdl";

export interface ComponentField {
  path: string;
  parent: string;
  container: string;
  containerExists: boolean;
  value: string;
  kind: "name" | "instructions";
}

/** Resolve editable text to its actual owner; never overwrite a composed mission. */
export function componentFields(source: string, card: ViewerCard): ComponentField[] {
  const doc = readDocument(source);
  const definitions = list(doc.definitions).map(object);
  let owner = card.details;
  let path = card.path;
  if (path.startsWith("/legacy/")) {
    const matches = definitions.map((value, index) => ({ value, index })).filter(({ value }) =>
      value.kind === "Agent" && object(value.annotations).macroLegacyNodeId === card.id);
    if (matches.length !== 1) return [];
    owner = matches[0].value;
    path = `/definitions/${matches[0].index}`;
  }
  if (!/^\/(graphs\/\d+\/steps|definitions)\/\d+$/.test(path)) return [];
  const field = (parent: string, value: Record<string, unknown>, container: string, key: string, initial: string, kind: ComponentField["kind"]): ComponentField => ({
    path: `${parent}/${container}/${key}`, parent, container,
    containerExists: value[container] !== null && typeof value[container] === "object" && !Array.isArray(value[container]),
    value: initial, kind,
  });
  const fields = [field(path, owner, "annotations", "title", card.title, "name")];
  const agentKey = owner.kind === "invoke" ? owner.agent : owner.key;
  const agents = definitions.map((value, index) => ({ value, index })).filter(({ value }) => keyId(value.key) === keyId(agentKey));
  const agent = agents.length === 1 ? agents[0] : undefined;
  if (agent) {
    for (const [container, key] of [["annotations", "description"], ["payload", "mission"]]) {
      const value = text(object(agent.value[container])[key]);
      if (value) fields.push(field(`/definitions/${agent.index}`, agent.value, container, key, value, "instructions"));
    }
    for (const relation of list(doc.relations).map(object)) {
      if (relation.relation !== "directedBy" || keyId(relation.source) !== keyId(agent.value.key)) continue;
      const matches = definitions.map((value, index) => ({ value, index })).filter(({ value }) => value.kind === "Instructions" && keyId(value.key) === keyId(relation.target));
      if (matches.length !== 1) continue;
      const { value, index } = matches[0];
      fields.push(field(`/definitions/${index}`, value, "payload", "body", text(object(value.payload).body), "instructions"));
    }
  }
  if (owner.kind === "Instructions") fields.push(field(path, owner, "payload", "body", text(object(owner.payload).body), "instructions"));
  if (fields.length === 1) fields.push(field(path, owner, "annotations", "description", text(object(owner.annotations).description), "instructions"));
  return fields.filter((item, index) => fields.findIndex(other => other.path === item.path) === index);
}

export function componentChanges(fields: ComponentField[], values: string[]): AgsdlChange[] {
  const changes: AgsdlChange[] = [];
  const created = new Set<string>();
  fields.forEach((field, index) => {
    if (field.value === values[index]) return;
    const parent = `${field.parent}/${field.container}`;
    if (!field.containerExists && !created.has(parent)) {
      changes.push({ op: "set", path: parent, valueJson: "{}" });
      created.add(parent);
    }
    changes.push({ op: "set", path: field.path, valueJson: JSON.stringify(values[index]) });
  });
  return changes;
}
