import type { ViewerEdge } from "./graphLayout";
import type { ViewerCard } from "./viewer";

type Value = Record<string, unknown>;
const object = (value: unknown): Value => value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Configuration facts a block preview shows, in a fixed order. Values are AgSDL names or display titles. */
export type BlockDetailKey = "instructions" | "model" | "uses" | "receives" | "produces" | "limit"
  | "arguments" | "effect" | "timeout" | "validity" | "test" | "mode" | "accept" | "agents" | "transmits";
export interface BlockDetail { key: BlockDetailKey; values: string[] }

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
export function blockDetails(card: ViewerCard, declarations: ViewerCard[]): BlockDetail[] {
  const byPath = new Map(declarations.map(item => [item.path, item]));
  const title = (path: string, fallback: string) => byPath.get(path)?.title || fallback;
  const details: BlockDetail[] = [];
  const add = (key: BlockDetailKey, values: Array<string | undefined>) => {
    const kept = values.filter((value): value is string => Boolean(value?.trim()));
    if (kept.length) details.push({ key, values: kept });
  };
  const step = card.details;
  if (card.kind === "agent") {
    const agent = object(step.agentDefinition);
    // The agent's own instruction, not the skills prepended to it.
    add("instructions", [list(agent.prompt).map(object).find(use => typeof use.value === "string")?.value as string | undefined]);
    const configuration = agent.configuration;
    if (typeof configuration === "string") {
      const declared = object(byPath.get(`/configurations/${configuration}`)?.details);
      const engine = typeof declared.engine === "string" ? title(`/bindings/${declared.engine}`, declared.engine) : undefined;
      add("model", [typeof declared.model === "string" ? declared.model : engine]);
    } else {
      const select = object(configuration);
      const cases = Object.values(object(select.cases)).map(name => title(`/configurations/${String(name)}`, String(name)));
      add("model", [`${operandText(select.select)} → ${cases.join(" | ")}`]);
    }
    add("uses", [...(card.tools ?? []).map(tool => tool.label), ...(card.capabilities?.skills ?? [])]);
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
    add("mode", [typeof step.mode === "string" ? step.mode : "all", typeof step.remaining === "string" ? `remaining: ${step.remaining}` : undefined]);
    add("accept", [predicateText(step.accept)]);
  }
  if (card.kind === "compose") add("agents", Object.entries(object(step.agents)).map(([parameter, agent]) => `${parameter} → ${title(`/agents/${String(agent)}`, String(agent))}`));
  if (card.kind === "prepare") add("transmits", card.inputs.map(input => input.name));
  if (typeof step.maxVisits === "number") add("limit", [String(step.maxVisits)]);
  return details;
}

/** A connection is described by the rule that takes it and what it delivers, never by its ends. */
export interface EdgeDetails { route: "next" | "choice" | "true" | "false" | "approved" | "denied" | "error" | "exchange" | "dependency"; choice?: string; transmits: string[] }
export function edgeDetails(edge: ViewerEdge): EdgeDetails {
  const route = edge.exchangeOnly ? "exchange" : edge.dependency ? "dependency"
    : edge.label === "onError" ? "error" : ["next", "success", ""].includes(edge.label) ? "next"
      : ["true", "false", "approved", "denied"].includes(edge.label) ? edge.label as EdgeDetails["route"] : "choice";
  return { route, ...(route === "choice" ? { choice: edge.label } : {}), transmits: list(edge.transfers).map(String) };
}
