import type { AgsdlChange } from "../../types/agsdl";
import { keyId, list, object, readDocument, text } from "./document";
import type { ViewerCard } from "./viewer";

export interface MacroConfiguration {
  editable: boolean;
  providerId: string;
  modelId: string;
  bindingPath?: string;
}

/** Only an unambiguous, already declared graph binding can be configured here. */
export function macroAgentConfiguration(source: string, card: ViewerCard): MacroConfiguration {
  const blocked = { editable: false, providerId: "", modelId: "" };
  if (!["Agent", "invoke"].includes(card.kind)) return blocked;
  const doc = readDocument(source);
  const definitions = list(doc.definitions).map(object);
  let agent = card.kind === "invoke" ? card.details.agent : card.details.key;
  if (card.path.startsWith("/legacy/")) {
    const owners = definitions.filter(def => def.kind === "Agent" && object(def.annotations).macroLegacyNodeId === card.id);
    if (owners.length !== 1) return blocked;
    agent = owners[0].key;
  }
  const valid = (key: unknown) => ["scope", "id", "version"].every(part => text(object(key)[part]));
  if (!valid(agent) || definitions.filter(def => def.kind === "Agent" && keyId(def.key) === keyId(agent)).length !== 1) return blocked;
  const graphs = list(doc.graphs).map(object);
  const graphIndex = /^\/graphs\/(\d+)\//.exec(card.path)?.[1];
  const owners = graphIndex === undefined
    ? graphs.filter(graph => list(graph.steps).map(object).some(step => keyId(step.agent) === keyId(agent)))
    : [graphs[Number(graphIndex)]];
  if (owners.length !== 1 || !owners[0] || !valid(owners[0].definition)) return blocked;
  if (graphs.filter(graph => keyId(graph.definition) === keyId(owners[0].definition)).length !== 1) return blocked;
  const runtime = object(doc.runtime);
  let configs = list(runtime.configurations).map((value, index) => ({ value: object(value), index }))
    .filter(({ value }) => keyId(value.graph) === keyId(owners[0].definition));
  if (configs.length > 1) configs = configs.filter(({ value }) => value.id === runtime.selected);
  if (configs.length !== 1) return blocked;
  const bindings = list(configs[0].value.agents).map((value, index) => ({ value: object(value), index }))
    .filter(({ value }) => valid(value.agent) && keyId(value.agent) === keyId(agent));
  if (bindings.length !== 1) return blocked;
  const binding = bindings[0].value, engine = object(binding.engine), params = object(binding.parameters);
  const editable = (binding.engine == null || (engine.identity === "macro" && engine.version === "1")) &&
    (binding.parameters == null || (typeof binding.parameters === "object" && !Array.isArray(binding.parameters))) &&
    [params.providerId, params.modelId].every(value => value === undefined || typeof value === "string");
  return { editable, providerId: text(params.providerId), modelId: text(params.modelId),
    bindingPath: `/runtime/configurations/${configs[0].index}/agents/${bindings[0].index}` };
}

export function macroConfigurationChanges(source: string, card: ViewerCard, providerId: string, modelId: string): AgsdlChange[] {
  const config = macroAgentConfiguration(source, card);
  if (config.providerId === providerId && config.modelId === modelId) return [];
  if (!config.editable || !config.bindingPath || !providerId || !modelId) throw new Error("agsdl.macroConfig.unsupported");
  const doc = readDocument(source);
  const parts = config.bindingPath.split("/");
  const binding = object(list(object(list(object(doc.runtime).configurations)[Number(parts[3])]).agents)[Number(parts[5])]);
  const changes: AgsdlChange[] = [];
  if (binding.engine == null) changes.push({ op: "set", path: `${config.bindingPath}/engine`, valueJson: JSON.stringify({ identity: "macro", version: "1" }) });
  if (binding.parameters == null) changes.push({ op: "set", path: `${config.bindingPath}/parameters`, valueJson: "{}" });
  changes.push({ op: "set", path: `${config.bindingPath}/parameters/providerId`, valueJson: JSON.stringify(providerId) },
    { op: "set", path: `${config.bindingPath}/parameters/modelId`, valueJson: JSON.stringify(modelId) });
  return changes;
}
