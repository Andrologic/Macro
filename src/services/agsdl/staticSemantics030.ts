import { Graph } from "../../vendor/agsdl/v0.3/graph.mjs";
import type { Report030 } from "../../vendor/agsdl/v0.3/reader.mjs";
import type { AgsdlReport } from "../../types/agsdl";
import { list, object, pointerPart, scanSource, text } from "./document";
import { locationsForSource } from "./reader030WorkerProtocol";

/** Native report paired with the exact source captured at validation time. */
export interface SourceBoundReport030 {
  source: string;
  report: Report030;
}

/** Only worker reports associated with these exact source bytes supply join origins. */
export function staticReportForSource030(source: string, reports: readonly AgsdlReport[]): SourceBoundReport030 | undefined {
  for (const report of reports) {
    if (report.contract !== "agsdl-0.3.0" || locationsForSource(report, source) === undefined || typeof report.documentReportJson !== "string") continue;
    try {
      const native = JSON.parse(report.documentReportJson) as Report030;
      if (native.contract === "agsdl-0.3.0") return { source, report: native };
    } catch {
      // An unavailable/unreadable report leaves the projection unassessed.
    }
  }
  return undefined;
}

/** Design identities only. A visit, activation or actual instance needs a runtime identity. */
export interface StaticAgent030 {
  agentPath?: string;
  parameter?: string;
  instance: "shared" | "named" | "new";
  name?: string;
  /** Run-relative conversation identity. Null for fresh instances and unbound parameters. */
  conversationKey: string | null;
  delivery: "queue" | "steer" | null;
  explicitDelivery: boolean;
}
export interface StaticJoinBranch030 {
  name: string;
  targetOccurrenceId: string;
  memberOccurrenceIds: string[];
  fanout: boolean;
}
export interface StaticJoin030 {
  /** Null until the validator reports an origin for this source owner. */
  originOccurrenceId: string | null;
  branches: StaticJoinBranch030[];
  mode: "all" | "quorum";
  quorumCountJson?: string;
  accept: string[];
  failures: "fail" | "keep";
  maxFailuresJson?: string;
  remaining: "stop" | "finish" | "wait";
}
export type StaticError030 =
  | { kind: "local" | "flow"; ownerPath: string; ownerOccurrenceId: string }
  | { kind: "join"; joinOccurrenceIds: string[] } // Nearest enclosing join first.
  | { kind: "compose"; ownerOccurrenceId: string }
  | { kind: "unreported" } // No matching report or reported join boundaries for this scope.
  | { kind: "unhandled" };
export interface StaticOccurrence030 {
  occurrenceId: string;
  sourcePath: string;
  /** Native step address shape, absent for a reusable template outside a flow. */
  address: string[] | null;
  scopeId: string;
  parentOccurrenceId?: string;
  bindings: Readonly<Record<string, string>>;
  agent?: StaticAgent030;
  error: StaticError030;
  join?: StaticJoin030;
}
export interface StaticSemantics030 {
  contract: "agsdl-0.3.0";
  occurrences: StaticOccurrence030[];
  flowErrorCovered: string[];
  /** Matching worker report and authoritative join origins; null while unavailable/stale. */
  report: Report030 | null;
}

/** Resolve only declared bindings. An unbound template parameter stays unbound. */
export function resolveStaticAgent030(ref: unknown, bindings: Readonly<Record<string, string>>): string | undefined {
  if (typeof ref === "string") return ref;
  const parameter = text(object(ref).parameter);
  return Object.hasOwn(bindings, parameter) ? bindings[parameter] : undefined;
}

/** Source inspection only. A missing/stale worker report never triggers synchronous validation. */
export function projectStaticSemantics030(source: string, report?: SourceBoundReport030): StaticSemantics030 {
  const scanned = scanSource(source), doc = object(scanned.tree);
  if (doc.contract !== "agsdl-0.3.0") throw new Error("Expected agsdl-0.3.0.");
  const validated = report?.source === source ? report.report : null;
  const shaped = validated !== null && !validated.diagnostics.some(item => item.code === "SHAPE" || item.code === "PARSE");
  const raw = (path: string) => {
    const span = scanned.spans.get(path);
    return span ? new TextDecoder().decode(scanned.bytes.subarray(span.start, span.end)) : undefined;
  };
  const occurrences: StaticOccurrence030[] = [];
  const scopes: Array<{ id: string; composition: string | null; cards: StaticOccurrence030[] }> = [];
  const declarations = new Map<string, { name: string; step: Record<string, unknown> }>();
  const visit = (container: unknown, path: string, scopeId: string, prefix: string[] | null,
    bindings: Readonly<Record<string, string>>, composition: string | null, stack: string[], parent?: string) => {
    const cards: StaticOccurrence030[] = [];
    scopes.push({ id: scopeId, composition, cards });
    for (const [name, value] of Object.entries(object(object(container).steps))) {
      const step = object(value), sourcePath = `${path}/steps/${pointerPart(name)}`;
      const occurrenceId = parent ? `${parent}#${sourcePath}` : sourcePath;
      const occurrence: StaticOccurrence030 = { occurrenceId, sourcePath, address: prefix ? [...prefix, name] : null,
        scopeId, parentOccurrenceId: parent, bindings, error: { kind: "unhandled" } };
      if (step.type === "agent") {
        const agent = resolveStaticAgent030(step.agent, bindings);
        const agentPath = agent && Object.hasOwn(object(doc.agents), agent) ? `/agents/${pointerPart(agent)}` : undefined;
        const instance = step.instance === "new" ? "new" : typeof step.instance === "string" ? "named" : "shared";
        occurrence.agent = { agentPath, parameter: text(object(step.agent).parameter) || undefined, instance,
          ...(instance === "named" ? { name: text(step.instance) } : {}),
          conversationKey: !agentPath || instance === "new" ? null : JSON.stringify([agentPath, instance, ...(instance === "named" ? [step.instance] : [])]),
          delivery: instance === "new" ? null : step.delivery === "steer" ? "steer" : "queue",
          explicitDelivery: Object.hasOwn(step, "delivery") };
      }
      if (step.type === "join") {
        const quorum = object(step.quorum);
        occurrence.join = { originOccurrenceId: null, branches: [],
          mode: Object.hasOwn(step, "quorum") ? "quorum" : "all", quorumCountJson: raw(`${sourcePath}/quorum/count`),
          accept: list(quorum.accept).map(text), failures: Object.hasOwn(step, "quorum") || step.failures === "keep" ? "keep" : "fail",
          maxFailuresJson: raw(`${sourcePath}/maxFailures`),
          remaining: step.remaining === "finish" || step.remaining === "wait" ? step.remaining : "stop" };
      }
      occurrences.push(occurrence); cards.push(occurrence); declarations.set(occurrenceId, { name, step });
      if (step.type !== "compose") continue;
      const target = text(step.composition);
      if (stack.includes(target) || !Object.hasOwn(object(doc.compositions), target)) continue;
      const childBindings = Object.fromEntries(Object.entries(object(step.agents)).flatMap(([parameter, ref]) => {
        const name = resolveStaticAgent030(ref, bindings);
        return name === undefined ? [] : [[parameter, name]];
      }));
      visit(object(doc.compositions)[target], `/compositions/${pointerPart(target)}`, occurrenceId, occurrence.address,
        childBindings, target, [...stack, target], occurrenceId);
    }
  };
  if (Object.hasOwn(doc, "flow")) visit(doc.flow, "/flow", "/flow", [], {}, null, []);
  for (const [name, value] of Object.entries(object(doc.compositions))) {
    const path = `/compositions/${pointerPart(name)}`;
    visit(value, path, path, null, {}, name, [name]);
  }
  const byAddress = new Map(occurrences.filter(item => item.address).map(item => [item.address!.join("/"), item]));
  // Report entries address expanded uses. Reusable templates use the same source owner's result.
  const bySource = new Map<string, Report030["joins"][string]>();
  for (const [address, info] of Object.entries(validated?.joins ?? {})) {
    const owner = byAddress.get(address);
    if (owner) bySource.set(owner.sourcePath, info);
  }
  const memberships = new Map<string, string[]>();
  for (const scope of scopes) {
    if (!scope.cards.some(card => bySource.has(card.sourcePath))) continue;
    const graph = Graph.for_scope(doc, scope.composition);
    const local = new Map(scope.cards.map(item => [declarations.get(item.occurrenceId)!.name, item]));
    for (const card of scope.cards) {
      if (!card.join) continue;
      const info = (card.address ? validated?.joins[card.address.join("/")] : undefined) ?? bySource.get(card.sourcePath);
      if (!info) continue;
      const origin = info.origin.split("/").at(-1)!;
      const originCard = local.get(origin);
      if (!originCard) continue;
      const joinName = declarations.get(card.occurrenceId)!.name;
      const reaching = graph.reaching(joinName, [origin]);
      const branches = info.branches.flatMap((name): StaticJoinBranch030[] => {
        const start = name === origin ? joinName : name;
        const target = local.get(start);
        if (!target) return [];
        // Traverse the validator-reported branch, stopping at its known boundaries.
        const members = start === joinName ? [] : [...graph.reachable(start, [origin, joinName])]
          .filter(member => member === start || reaching.has(member)).flatMap(member => local.get(member) ?? []);
        for (const member of members) {
          const ids = memberships.get(member.occurrenceId) ?? [];
          ids.push(card.occurrenceId); memberships.set(member.occurrenceId, ids);
        }
        return [{ name, targetOccurrenceId: target.occurrenceId, memberOccurrenceIds: members.map(item => item.occurrenceId),
          fanout: graph.edges.some(edge => edge.src === origin && edge.dst === start && edge.each !== null) }];
      });
      card.join.originOccurrenceId = originCard.occurrenceId;
      card.join.branches = branches;
    }
  }
  const root = scopes.find(scope => scope.id === "/flow");
  const branchNames = root?.cards.filter(card => memberships.has(card.occurrenceId)).map(card => card.address![0]) ?? [];
  const covered = shaped && root?.cards.length ? Graph.flow_error_covered(doc, branchNames) : new Set<string>();
  const byId = new Map(occurrences.map(card => [card.occurrenceId, card]));
  const unreportedScopes = new Set(scopes.filter(scope => scope.cards.some(card => card.join?.originOccurrenceId === null)).map(scope => scope.id));
  const coveredGraph = root?.cards.some(card => card.join?.originOccurrenceId) ? Graph.for_scope(doc, null, covered) : undefined;
  for (const card of root?.cards ?? []) {
    const origin = card.join?.originOccurrenceId ? declarations.get(card.join.originOccurrenceId)!.name : undefined;
    if (!origin) continue;
    for (const branch of card.join!.branches) {
      const start = declarations.get(branch.targetOccurrenceId)!.name;
      branch.fanout = coveredGraph!.edges.some(edge => edge.src === origin && edge.dst === start && edge.each !== null);
    }
  }
  for (const card of occurrences) {
    const step = declarations.get(card.occurrenceId)!.step;
    const joins = memberships.get(card.occurrenceId);
    const size = (id: string) => byId.get(id)!.join!.branches.find(branch => branch.memberOccurrenceIds.includes(card.occurrenceId))!.memberOccurrenceIds.length;
    joins?.sort((left, right) => size(left) - size(right) || (left < right ? -1 : left > right ? 1 : 0));
    card.error = Object.hasOwn(step, "onError") ? { kind: "local", ownerPath: `${card.sourcePath}/onError`, ownerOccurrenceId: card.occurrenceId }
      : !validated || unreportedScopes.has(card.scopeId) ? { kind: "unreported" }
      : memberships.has(card.occurrenceId) ? { kind: "join", joinOccurrenceIds: memberships.get(card.occurrenceId)! }
      : card.parentOccurrenceId ? { kind: "compose", ownerOccurrenceId: card.parentOccurrenceId }
      : card.scopeId === "/flow" && covered.has(card.address![0]) ? { kind: "flow", ownerPath: "/flow/onError", ownerOccurrenceId: "/flow" }
      : { kind: "unhandled" };
  }
  return { contract: "agsdl-0.3.0", occurrences, flowErrorCovered: root?.cards.filter(card => card.error.kind === "flow").map(card => card.occurrenceId) ?? [], report: validated };
}
