import type { AgsdlChange } from "../../types/agsdl";
import { keyId, list, object, readDocument, text, pointerPart } from "./document";
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
  const doc = readDocument(source);
  if (doc.contract === "agsdl-0.2.0") return configuration02(doc, card);
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

export function macroConfigurationChanges(source: string, card: ViewerCard, providerId: string, modelId: string): AgsdlChange[] {
  const config = macroAgentConfiguration(source, card);
  if (!config.editable || !config.bindingPath) throw new Error("agsdl.macroConfig.unsupported");
  const doc = readDocument(source);
  if (doc.contract === "agsdl-0.2.0") return configurationChanges02(doc, config, providerId, modelId);
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


/** Macro's external Engine declaration; identity alone makes no support claim. */
export const MACRO_ENGINE_CONTRACT = { identity: "macro/agent-engine", version: "1" } as const;
export const MACRO_ENGINE_IMPLEMENTATION = { identity: "macro/desktop", version: "1" } as const;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const editionMatches = (value: unknown, edition: { identity: string; version: string }) => {
  const candidate = object(value);
  return candidate.identity === edition.identity && candidate.version === edition.version && Object.keys(candidate).length === 2;
};

/** Select only the authored fixed configuration. Dynamic alternatives remain explicit. */
function configuration02(doc: Record<string, unknown>, card: ViewerCard): MacroConfiguration {
  const blocked = { editable: false, providerId: "", modelId: "" };
  let name: string | undefined;
  const agentPath = /^\/agents\/([^/]+)$/.exec(card.path);
  if (agentPath) name = agentPath[1].replaceAll("~1", "/").replaceAll("~0", "~");
  else {
    const stepPath = /^\/flow\/steps\/([^/]+)$/.exec(card.path);
    const step = stepPath ? object(object(object(doc.flow).steps)[stepPath[1].replaceAll("~1", "/").replaceAll("~0", "~")]) : {};
    if (step.type === "agent") name = text(step.agent);
  }
  if (!name || !Object.hasOwn(object(doc.agents), name)) return blocked;
  const agent = object(object(doc.agents)[name]);
  if (typeof agent.configuration !== "string" || !Object.hasOwn(object(doc.configurations), agent.configuration)) return blocked;
  const config = object(object(doc.configurations)[agent.configuration]);
  if (typeof config.engine !== "string" || !Object.hasOwn(object(doc.bindings), config.engine)) return blocked;
  const engine = object(object(doc.bindings)[config.engine]);
  const settings = object(config.settings);
  // An explicit Model edition is not a provider catalog id and cannot be silently replaced.
  const editable = editionMatches(engine.contract, MACRO_ENGINE_CONTRACT) && editionMatches(engine.implementation, MACRO_ENGINE_IMPLEMENTATION) &&
    config.model === undefined && (config.settings === undefined || isRecord(config.settings)) &&
    [settings.providerId, settings.modelId].every(value => value === undefined || typeof value === "string");
  return { editable, providerId: text(settings.providerId), modelId: text(settings.modelId),
    bindingPath: `/configurations/${pointerPart(agent.configuration)}` };
}

function configurationChanges02(doc: Record<string, unknown>, config: MacroConfiguration, providerId: string, modelId: string): AgsdlChange[] {
  if (config.providerId === providerId && config.modelId === modelId) return [];
  if (!providerId || !modelId) throw new Error("agsdl.macroConfig.unsupported");
  const path = config.bindingPath!;
  const name = path.slice("/configurations/".length).replaceAll("~1", "/").replaceAll("~0", "~");
  const declaration = object(object(doc.configurations)[name]);
  const changes: AgsdlChange[] = [];
  if (declaration.settings === undefined) changes.push({ op: "set", path: `${path}/settings`, valueJson: "{}" });
  if (config.providerId !== providerId) changes.push({ op: "set", path: `${path}/settings/providerId`, valueJson: JSON.stringify(providerId) });
  if (config.modelId !== modelId) changes.push({ op: "set", path: `${path}/settings/modelId`, valueJson: JSON.stringify(modelId) });
  // Exact configuration claims cease to apply after any configuration change.
  if (declaration.claims !== undefined) changes.push({ op: "remove", path: `${path}/claims` });
  return changes;
}
