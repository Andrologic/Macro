import type { AgsdlChange } from "../../types/agsdl";
import { keyId,list,object,readDocument,scanSource,sourceAt,text } from "./document";
import type { ViewerCard } from "./viewer";

export interface MacroConfiguration {
  edition030?: boolean;
  effort?: string;
  harness?: string;
  editable: boolean;
  engine?: "macro" | "codex" | "claude";
  providerId: string;
  modelId: string;
  bindingPath?: string;
}

/** Only an unambiguous, already declared graph binding can be configured here. */
export function macroAgentConfiguration(source: string, card: ViewerCard): MacroConfiguration {
  const blocked = { editable: false, providerId: "", modelId: "" };
  if (card.edition030) {
    const path = card.edition030.agentPath;
    if (!path) return blocked;
    const agent = object(scanSource(sourceAt(source, path)).tree), model = object(agent.model);
    return { editable: true, edition030: true, providerId: "", modelId: text(model.name), effort: text(model.effort), harness: text(agent.harness), bindingPath: path };
  }
  const doc = readDocument(source);
  if (doc.contract !== "agsdl-0.1.0" || !["Agent", "invoke"].includes(card.kind)) return blocked;
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
  const editable = (binding.engine == null || (["macro", "macro/desktop"].includes(text(engine.identity)) && engine.version === "1")) &&
    (binding.parameters == null || (typeof binding.parameters === "object" && !Array.isArray(binding.parameters))) &&
    [params.providerId, params.modelId].every(value => value === undefined || typeof value === "string");
  return { editable, providerId: text(params.providerId), modelId: text(params.modelId),
    bindingPath: `/runtime/configurations/${configs[0].index}/agents/${bindings[0].index}` };
}

export function macroConfigurationChanges(source: string, card: ViewerCard, providerId: string, modelId: string, effort?: string): AgsdlChange[] {
  const config = macroAgentConfiguration(source, card);
  if (!config.editable || !config.bindingPath) throw new Error("agsdl.macroConfig.unsupported");
  if (config.edition030) return agentModelChanges030(source, config.bindingPath, { name: modelId || undefined, effort: effort || undefined });
  const doc = readDocument(source);
  const parts = config.bindingPath.split("/");
  const binding = object(list(object(list(object(doc.runtime).configurations)[Number(parts[3])]).agents)[Number(parts[5])]);
  const legacyEngine = object(binding.engine).identity === "macro" && object(binding.engine).version === "1";
  if (config.providerId === providerId && config.modelId === modelId && !legacyEngine) return [];
  if (!providerId || !modelId) throw new Error("agsdl.macroConfig.unsupported");
  const changes: AgsdlChange[] = [];
  if (binding.engine == null) changes.push({ op: "set", path: `${config.bindingPath}/engine`, valueJson: JSON.stringify({ identity: "macro/desktop", version: "1" }) });
  else if (legacyEngine) changes.push({ op: "set", path: `${config.bindingPath}/engine/identity`, valueJson: JSON.stringify("macro/desktop") });
  if (binding.parameters == null) changes.push({ op: "set", path: `${config.bindingPath}/parameters`, valueJson: "{}" });
  if (config.providerId !== providerId) changes.push({ op: "set", path: `${config.bindingPath}/parameters/providerId`, valueJson: JSON.stringify(providerId) });
  if (config.modelId !== modelId) changes.push({ op: "set", path: `${config.bindingPath}/parameters/modelId`, valueJson: JSON.stringify(modelId) });
  return changes;
}


/** Both model properties are optional and independent. No availability gate at save time. */
export function agentModelChanges030(source: string, agentPath: string, value: { name?: string; effort?: string }): AgsdlChange[] {
  const agent = object(scanSource(sourceAt(source, agentPath)).tree), model = object(agent.model);
  if (model.name === value.name && model.effort === value.effort) return [];
  const path = `${agentPath}/model`;
  const changes: AgsdlChange[] = [];
  if (agent.model === undefined && (value.name !== undefined || value.effort !== undefined)) changes.push({ op: "set", path, valueJson: "{}" });
  for (const key of ["name", "effort"] as const) {
    if (model[key] === value[key]) continue;
    changes.push(value[key] === undefined ? { op: "remove", path: `${path}/${key}` } : { op: "set", path: `${path}/${key}`, valueJson: JSON.stringify(value[key]) });
  }
  return changes;
}

/** Engine identity also used by historical 0.1 display. It grants no authority. */
export const MACRO_ENGINE_CONTRACT = { identity: "macro/agent-engine", version: "1" } as const;
export const MACRO_ENGINE_IMPLEMENTATION = { identity: "macro/desktop", version: "1" } as const;
