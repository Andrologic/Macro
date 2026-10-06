import { keyId, list, object, readDocument, text, pointerPart } from "./document";
import { MACRO_ENGINE_CONTRACT, MACRO_ENGINE_IMPLEMENTATION } from "./macroAgentConfiguration";
import type { ViewerCard, ViewerReference } from "./viewer";

export function outputRecipients(card: ViewerCard, cards: ViewerCard[], port: string) {
  return cards.flatMap(consumer => {
    // End steps bind the result of the system, not another agent's input.
    const inputs = consumer.kind === "end" ? consumer.outputs : consumer.inputs;
    return inputs.filter(input => input.binding?.source === "step" && !input.binding.unresolved &&
      input.binding.target === card.path && input.binding.port === port)
      .map(input => ({ card: consumer, port: input.name }));
  });
}

export interface AgentConfiguration {
  id: string;
  macro?: boolean;
  selected: boolean;
  engine: string;
  engineIdentity: string;
  engineVersion: string;
  parameters: Record<string, unknown>;
  engineReference?: ViewerReference;
  engineParameters?: Record<string, unknown>;
  tools: Array<{
    reference: ViewerReference;
    choices: Array<{ id: string; selected: boolean; implementation: string; parameters: Record<string, unknown> }>;
  }>;
}

/** Runtime declarations belong to the exact agent and graph, never to the global provider settings. */
export function agentConfigurations(source: string, card: ViewerCard): AgentConfiguration[] {
  const doc = readDocument(source);
  if (doc.contract === "agsdl-0.2.0") {
    const agents = object(doc.agents);
    const name = text(card.details.agentName);
    if (!name || !Object.hasOwn(agents, name)) return [];
    const agent = object(agents[name]);
    const fixed = typeof agent.configuration === "string";
    const names = fixed ? [text(agent.configuration)] : [...new Set(Object.values(object(object(agent.configuration).cases)).map(text))];
    const edition = (value: unknown) => [text(object(value).identity), text(object(value).version)].filter(Boolean).join(" · ");
    const bindings = object(doc.bindings);
    return names.flatMap(id => {
      if (!Object.hasOwn(object(doc.configurations), id)) return [];
      const configuration = object(object(doc.configurations)[id]);
      const engine = object(bindings[text(configuration.engine)]);
      const implementation = object(engine.implementation);
      return [{ id, selected: fixed,
        macro: configuration.model === undefined && ["identity", "version"].every(key => object(engine.contract)[key] === MACRO_ENGINE_CONTRACT[key as keyof typeof MACRO_ENGINE_CONTRACT] && implementation[key] === MACRO_ENGINE_IMPLEMENTATION[key as keyof typeof MACRO_ENGINE_IMPLEMENTATION]) && Object.keys(object(engine.contract)).length === 2 && Object.keys(implementation).length === 2,
        engine: edition(implementation), engineIdentity: text(implementation.identity), engineVersion: text(implementation.version),
        engineReference: { label: text(configuration.engine), source: "unknown" as const, target: Object.hasOwn(bindings, text(configuration.engine)) ? `/bindings/${pointerPart(text(configuration.engine))}` : undefined, unresolved: !Object.hasOwn(bindings, text(configuration.engine)) },
        engineParameters: object(engine.settings),
        parameters: { ...object(configuration.settings), ...(configuration.model ? { model: configuration.model } : {}) },
        tools: Object.entries(object(configuration.tools)).map(([localName, bindingName]) => {
          const binding = object(bindings[text(bindingName)]);
          const exists = Object.hasOwn(bindings, text(bindingName));
          return { reference: { label: localName, source: "unknown" as const, target: exists ? `/bindings/${pointerPart(text(bindingName))}` : undefined, unresolved: !exists },
            choices: exists ? [{ id: text(bindingName), selected: true, implementation: edition(binding.implementation), parameters: object(binding.settings) }] : [] };
        }),
      }];
    });
  }
  const definitions = list(doc.definitions).map(object);
  const validKey = (key: unknown) => ["scope", "id", "version"].every(part => text(object(key)[part]));
  let agentKey = card.kind === "invoke" ? card.details.agent : card.details.key;
  if (card.path.startsWith("/legacy/")) {
    const matches = definitions.filter(def => def.kind === "Agent" && object(def.annotations).macroLegacyNodeId === card.id);
    agentKey = matches.length === 1 ? matches[0].key : undefined;
  }
  if (!validKey(agentKey) || definitions.filter(def => def.kind === "Agent" && keyId(def.key) === keyId(agentKey)).length !== 1) return [];
  const graphIndex = /^\/graphs\/(\d+)\//.exec(card.path)?.[1];
  const graph = graphIndex === undefined ? undefined : object(list(doc.graphs)[Number(graphIndex)]);
  const runtime = object(doc.runtime);
  const edition = (value: unknown) => [text(object(value).identity), text(object(value).version)].filter(Boolean).join(" · ");
  return list(runtime.configurations).map(object).flatMap(configuration => {
    if (graph && (!validKey(graph.definition) || keyId(configuration.graph) !== keyId(graph.definition))) return [];
    const bindings = list(configuration.agents).map(object).filter(binding => validKey(binding.agent) && keyId(binding.agent) === keyId(agentKey));
    if (bindings.length !== 1) return [];
    const binding = bindings[0];
    return [{
      id: text(configuration.id), selected: runtime.selected === configuration.id,
      engine: edition(binding.engine), engineIdentity: text(object(binding.engine).identity), engineVersion: text(object(binding.engine).version), parameters: object(binding.parameters),
      tools: list(binding.tools).map(object).map(tool => {
        const matches = definitions.map((value, index) => ({ value, index })).filter(({ value }) => value.kind === "Tool" && validKey(tool.tool) && keyId(value.key) === keyId(tool.tool));
        const match = matches.length === 1 ? matches[0] : undefined;
        return {
          reference: {
            label: match ? text(object(match.value.annotations).title) || text(object(match.value.key).id) : text(object(tool.tool).id),
            source: "unknown" as const, target: match ? `/definitions/${match.index}` : undefined, unresolved: !match,
          },
          choices: list(tool.choices).map(object).map(choice => ({
            id: text(choice.id), selected: choice.id === tool.selected,
            implementation: edition(choice.implementation), parameters: object(choice.parameters),
          })),
        };
      }),
    }];
  });
}
