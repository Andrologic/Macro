import { keyId, list, object, readDocument, text } from "./document";
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
  selected: boolean;
  engine: string;
  engineIdentity: string;
  engineVersion: string;
  parameters: Record<string, unknown>;
  tools: Array<{
    reference: ViewerReference;
    choices: Array<{ id: string; selected: boolean; implementation: string; parameters: Record<string, unknown> }>;
  }>;
}

/** Runtime declarations belong to the exact agent and graph, never to the global provider settings. */
export function agentConfigurations(source: string, card: ViewerCard): AgentConfiguration[] {
  const doc = readDocument(source);
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
