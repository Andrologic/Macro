import type { ViewerEdge } from "./graphLayout";
import type { ViewerCard } from "./viewer";

type Value = Record<string, unknown>;
const object = (value: unknown): Value => value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Configuration facts a block preview shows, in a fixed order. Values are AgSDL names or display titles. */
export type BlockDetailKey = "instructions" | "steers" | "model" | "uses" | "receives" | "produces" | "limit"
  | "after" | "arguments" | "effect" | "action" | "targets" | "context" | "timeout" | "validity" | "test" | "mode" | "accept" | "agents" | "transmits";
export interface BlockDetail { key: BlockDetailKey; values: string[]; message030?: string; params030?: Record<string, string>; advanced?: boolean }

/** Operands read as their path (`data.exitCode`) or their literal value (`0`, `"portal"`). */
export function operandText(operand: unknown): string {
  const use = object(operand);
  if (Array.isArray(use.path)) return use.path.length ? use.path.join(".") : "input";
  return JSON.stringify(use.value) ?? "";
}

/** Predicates read as the comparisons they declare. */
export function predicateText(predicate: unknown): string {
  const use = object(predicate);
  if (Array.isArray(use.equals)) return use.equals.map(operandText).join(" = ");
  if (Array.isArray(use.all)) return use.all.map(predicateText).join(" ∧ ");
  if (Object.hasOwn(use, "not")) return `¬(${predicateText(use.not)})`;
  return "";
}

export function durationText(ms: unknown): string {
  if (typeof ms !== "number" || ms <= 0) return "";
  const minutes = ms / 60000;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
  if (minutes >= 1) return `${Math.round(minutes)} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** Reads the configuration of one step from the projected document; never invents a value. */
export function blockDetails(card: ViewerCard, declarations: ViewerCard[], steps: ViewerCard[] = []): BlockDetail[] {
  if (card.edition030) return blockDetails030(card, declarations, steps);
  const byPath = new Map(declarations.map(item => [item.path, item]));
  const title = (path: string, fallback: string) => byPath.get(path)?.title || fallback;
  const details: BlockDetail[] = [];
  const add = (key: BlockDetailKey, values: Array<string | undefined>) => {
    const kept = values.filter((value): value is string => Boolean(value?.trim()));
    if (kept.length) details.push({ key, values: kept });
  };
  const step = card.details;
  const sibling = (name: unknown) => typeof name === "string"
    ? steps.find(item => item.path === `${card.path.slice(0, card.path.lastIndexOf("/"))}/${name}`)?.title || name : undefined;
  if (card.kind === "agent" && step.delivery === "steering") {
    // A steering message joins work already running: its content arrives on the incoming connection,
    // and it has no instruction, configuration, resource or result of its own.
    add("steers", [sibling(step.steers)]);
  } else if (card.kind === "agent" || card.kind === "Agent") {
    // A step carries its agent's definition; an agent declared outside any flow is that definition.
    const agent = card.kind === "Agent" ? step : object(step.agentDefinition);
    // The agent's own instruction, not the skills prepended to it.
    add("instructions", [list(agent.prompt).map(object).find(use => typeof use.value === "string")?.value as string | undefined]);
    const configuration = agent.configuration;
    if (typeof configuration === "string") {
      const declared = object(byPath.get(`/configurations/${configuration}`)?.details);
      const engine = typeof declared.engine === "string" ? title(`/bindings/${declared.engine}`, declared.engine) : undefined;
      // AgSDL declares a model as an edition; older documents wrote its name directly.
      const model = typeof declared.model === "string" ? declared.model : object(declared.model).identity;
      add("model", [typeof model === "string" ? model : engine]);
    } else {
      const select = object(configuration);
      const cases = Object.values(object(select.cases)).map(name => title(`/configurations/${String(name)}`, String(name)));
      add("model", [`${operandText(select.select)} → ${cases.join(" | ")}`]);
    }
    add("uses", [...(card.tools ?? []).map(tool => tool.target ? title(tool.target, tool.label) : tool.label), ...(card.capabilities?.skills ?? [])]);
    add("receives", card.inputs.map(input => input.name));
    add("produces", card.outputs.map(output => `${output.name} (${output.type || "?"})`));
  }
  if (card.kind === "call") {
    add("arguments", Object.entries(object(step.arguments)).map(([name, operand]) => `${name} = ${operandText(operand)}`));
    const binding = typeof step.binding === "string" ? object(byPath.get(`/bindings/${step.binding}`)?.details) : {};
    add("effect", [typeof binding.effects === "string" ? binding.effects : "unknown"]);
  }
  if (card.kind === "approval") {
    add("timeout", [durationText(step.timeoutMs)]);
    add("validity", [durationText(step.validForMs)]);
  }
  if (card.kind === "condition") add("test", [predicateText(step.test)]);
  if (card.kind === "join") {
    // Members count only once launched by this step; name it as the graph does.
    add("after", [sibling(step.after)]);
    add("mode", [card.edition030 && step.quorum ? "quorum" : typeof step.mode === "string" ? step.mode : "all", typeof step.remaining === "string" ? `remaining: ${step.remaining}` : undefined]);
    add("accept", [predicateText(step.accept)]);
  }
  if (card.kind === "compose") add("agents", Object.entries(object(step.agents)).map(([parameter, agent]) => `${parameter} → ${title(`/agents/${String(agent)}`, String(agent))}`));
  if (card.kind === "prepare") add("transmits", card.inputs.map(input => input.name));
  // The scope names what an external effect touches, as the document declares it.
  // An approval shows the scope of the step it authorizes.
  const authorized = card.kind === "approval" ? steps.find(item => item.id === step.call)?.details : undefined;
  const scope = object((authorized ?? step).scope);
  add("action", [typeof scope.action === "string" ? scope.action : undefined]);
  add("targets", list(scope.resources).filter((item): item is string => typeof item === "string"));
  // An object context reads field by field, like call arguments.
  const context = object(scope.context);
  const fields = object(context.value);
  if (Object.keys(fields).length && Object.hasOwn(context, "value")) add("context", Object.entries(fields).map(([name, value]) => `${name} = ${JSON.stringify(value)}`));
  else if (Object.hasOwn(scope, "context")) add("context", [operandText(scope.context)]);
  if (typeof step.maxVisits === "number") add("limit", [String(step.maxVisits)]);
  return details;
}

/** A connection is described by the rule that takes it and what it delivers, never by its ends. */
export interface EdgeDetails { route: "next" | "choice" | "true" | "false" | "approved" | "denied" | "error" | "exchange" | "dependency"; choice?: string; transmits: string[] }
export function edgeDetails(edge: ViewerEdge): EdgeDetails {
  const route = edge.exchangeOnly ? "exchange" : edge.dependency ? "dependency"
    : edge.route030 ? edge.route030.role === "error" ? "error" : edge.route030.key === undefined ? "next" : "choice"
    : edge.label === "onError" ? "error" : ["next", "success", ""].includes(edge.label) ? "next"
      : ["true", "false", "approved", "denied"].includes(edge.label) ? edge.label as EdgeDetails["route"] : "choice";
  return { route, ...(route === "choice" ? { choice: edge.route030?.key ?? edge.label } : {}), transmits: list(edge.transfers).map(String) };
}

/** Business facts come from the source-bound semantic projection, never inferred run activity. */
function blockDetails030(card: ViewerCard, declarations: ViewerCard[], steps: ViewerCard[]): BlockDetail[] {
  const facts: BlockDetail[] = [];
  const add = (key: BlockDetailKey, message030: string, params030: Record<string, string> = {}) =>
    facts.push({ key, values: [], message030, params030 });
  const occurrence = card.static030;
  const owners = [...steps, ...declarations];
  const name = (id: string) => (owners.find(item => (item.static030?.occurrenceId ?? item.path) === id)
    ?? owners.find(item => item.path === id.slice(id.lastIndexOf('#') + 1)))?.title;
  const agent = occurrence?.agent;
  if (agent) {
    add('agents', `conversation.${agent.instance}`, { name: agent.name ?? '' });
    if (agent.delivery) add('transmits', `delivery.${agent.delivery}`);
  }
  const join = occurrence?.join;
  if (join) {
    if (join.mode === 'quorum') {
      add('mode', join.quorumCountJson === '1' ? 'quorum.one' : 'quorum.rule', { threshold: join.quorumCountJson ?? '?' });
      facts.push({ key: 'accept', values: join.accept });
    } else add('mode', 'join.all');
    add('after', `remaining.${join.remaining}`);
    const origin = join.originOccurrenceId && name(join.originOccurrenceId);
    if (origin) add('after', 'join.origin', { name: origin });
    else add('after', 'join.unreported');
    if (join.failures === 'keep' && join.mode === 'all') add('effect', 'join.keep');
  }
  const error = occurrence?.error;
  if (error) {
    const owner = error.kind === 'join' ? name(error.joinOccurrenceIds[0])
      : error.kind === 'compose' ? name(error.ownerOccurrenceId) : undefined;
    add('context', `error.${error.kind}`, { name: owner ?? '' });
  }
  if (typeof card.details.description === 'string') facts.unshift({ key: 'instructions', values: [card.details.description] });
  const technical = (key: BlockDetailKey, values: string[]) => {
    if (values.length) facts.push({ key, values, advanced: true });
  };
  technical('uses', [...(card.capabilities?.skills ?? []), ...(card.tools ?? []).map(tool => tool.label)]);
  technical('produces', card.outputs.map(output => `${output.name} (${output.type})`));
  if (card.edition030?.maxVisitsJson) technical('limit', [card.edition030.maxVisitsJson]);
  return facts;
}
