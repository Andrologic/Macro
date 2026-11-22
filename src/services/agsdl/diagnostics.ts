import type { AgsdlReport } from "../../types/agsdl";
import { hasFlowDocumentContract, keyId, list, object, pointerPart, readDocument, scanSource, text } from "./document";
import { locationsForSource } from "./reader030WorkerProtocol";
import type { ViewerCard } from "./viewer";

export interface LocalizedDiagnostic {
  rule: string;
  details: string;
  path?: string;
  severity?: "error" | "warning";
  step?: string[];
  /** Present only when the authored pointer identifies source bytes. */
  span?: { start: number; end: number };
  targets: string[];
}

/** Only a real source span or an unambiguous AgSDL key can establish a location. */
export function localizeDiagnostics(source: string, reports: AgsdlReport[], cards: ViewerCard[]): LocalizedDiagnostic[] {
  if (hasFlowDocumentContract(source)) {
    return reports.flatMap(report => {
      const locations = locationsForSource(report, source);
      return report.results.flatMap(result => result.findings.map(finding => {
        const path = result.input === "primary" ? finding.location.pointer : undefined;
        const span = path === undefined ? undefined : locations?.get(path);
        const targets = !span || !path ? [] : cards.filter(card => {
          if (finding.rule.startsWith("HARNESS_") && !card.path.startsWith("/agents/")) return false;
          if (path === card.path || path.startsWith(`${card.path}/`)) return true;
          const name = text(card.details.agentName) || text(card.details.agent);
          const agent = name ? `/agents/${pointerPart(name)}` : undefined;
          return !!agent && (path === agent || path.startsWith(`${agent}/`));
        }).map(card => card.path);
        return { rule: finding.rule, details: finding.details, path, span,
          severity: finding.severity, step: finding.step, targets };
      }));
    });
  }
  let doc: ReturnType<typeof readDocument>, spans: ReturnType<typeof scanSource>["spans"];
  try { doc = readDocument(source); spans = scanSource(source).spans; }
  catch {
    return reports.flatMap(report => report.results.flatMap(result => result.findings.map(finding => ({
      rule: finding.rule, details: finding.details, severity: finding.severity, step: finding.step,
      path: result.input === "primary" ? finding.location.pointer : undefined, targets: [],
    }))));
  }
  const definitions = list(doc.definitions).map(object);
  const uniqueDefinition = (key: unknown): string | undefined => {
    if (!text(object(key).id)) return;
    const matches = definitions.flatMap((definition, index) => keyId(definition.key) === keyId(key) ? [`/definitions/${index}`] : []);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const targetsFor = (path: string | undefined): string[] => {
    if (!path) return [];
    const owners = [path];
    const relationMatch = /^\/relations\/(\d+)(?:\/|$)/.exec(path);
    if (relationMatch) {
      const relation = object(list(doc.relations)[Number(relationMatch[1])]);
      for (const key of [relation.source, relation.target]) {
        const owner = uniqueDefinition(key);
        if (owner) owners.push(owner);
      }
    }
    return cards.filter(card => owners.some(owner => {
      if (owner === card.path || owner.startsWith(`${card.path}/`)) return true;
      const agentName = text(card.details.agentName) || text(card.details.agent);
      const agent020 = agentName ? `/agents/${pointerPart(agentName)}` : undefined;
      if (agent020 && (owner === agent020 || owner.startsWith(`${agent020}/`))) return true;
      if (agentName) {
        const agent = object(object(doc.agents)[agentName]);
        const configurations = typeof agent.configuration === "string" ? [agent.configuration] : Object.values(object(object(agent.configuration).cases)).filter((value): value is string => typeof value === "string");
        for (const name of configurations) {
          const configurationPath = `/configurations/${pointerPart(name)}`;
          if (owner === configurationPath || owner.startsWith(`${configurationPath}/`)) return true;
          const configuration = object(object(doc.configurations)[name]);
          for (const binding of [configuration.engine, ...Object.values(object(configuration.tools))]) {
            if (typeof binding !== "string") continue;
            const bindingPath = `/bindings/${pointerPart(binding)}`;
            if (owner === bindingPath || owner.startsWith(`${bindingPath}/`)) return true;
          }
        }
      }
      const agentPath = uniqueDefinition(card.details.agent);
      if (agentPath && (owner === agentPath || owner.startsWith(`${agentPath}/`))) return true;
      const definitionPath = /^\/definitions\/\d+/.exec(owner)?.[0];
      if (!definitionPath) return false;
      const index = Number(definitionPath.split("/")[2]);
      const definition = definitions[index];
      if (definition?.kind === "Interface" && uniqueDefinition(card.details.interface) === definitionPath) return true;
      return card.path.startsWith("/legacy/") && definition?.kind === "Agent" && object(definition.annotations).macroLegacyNodeId === card.id;
    })).map(card => card.path);
  };
  const diagnostics: LocalizedDiagnostic[] = reports.flatMap(report => report.results.flatMap(result => result.findings.map(finding => {
    const context = { severity: finding.severity, step: finding.step };
    if (result.input !== "primary") return { ...context, rule: finding.rule, details: finding.details, path: undefined, targets: [] };
    let path = finding.location.pointer;
    if (path === undefined && Number.isSafeInteger(finding.location.byte)) {
      const byte = finding.location.byte!;
      path = [...spans].filter(([, span]) => byte >= span.start && byte < span.end).sort((a, b) => (a[1].end - a[1].start) - (b[1].end - b[1].start))[0]?.[0];
    }
    const invocation = finding.invocation && spans.has(finding.invocation) ? finding.invocation : undefined;
    const span = path === undefined ? undefined : spans.get(path);
    const targets = [...new Set([...targetsFor(span ? path : undefined), ...targetsFor(invocation)])]
      .filter(target => !finding.rule.startsWith("HARNESS_") || target.startsWith("/agents/"));
    return { ...context, rule: finding.rule, details: finding.details, path, span, targets };
  })));
  list(doc.unresolved).forEach((value, index) => {
    const unresolved = object(value);
    const subject = uniqueDefinition(unresolved.subject);
    diagnostics.push({ rule: text(unresolved.rule) || "unresolved", details: text(unresolved.obligation) || text(unresolved.reason), path: `/unresolved/${index}`, targets: subject ? targetsFor(subject) : [] });
  });
  return diagnostics;
}

/** Resolve a correction owner even for missing properties, root issues and hidden scopes. */
export function diagnosticOwner030(source: string, issue: LocalizedDiagnostic, cards: ViewerCard[]): ViewerCard {
  const candidates = cards.filter(card => {
    const path = card.edition030?.ownerPath ?? card.path;
    return path && issue.path !== undefined && (issue.path === path || issue.path.startsWith(`${path}/`));
  }).sort((left, right) => right.path.length - left.path.length);
  return candidates[0] ?? cards.find(card => card.edition030?.ownerPath === "") ?? {
    path: "agsdl:document", id: "document", title: "", kind: "System", mission: "", unresolved: false,
    inputs: [], outputs: [], branches: [], details: {},
    edition030: { ownerPath: "", sourceJson: source, routes: [] },
  };
}

/** The original rule and message remain alongside a short explanation of the affected contract. */
export function diagnosticExplanation030(rule: string): string {
  if (rule.startsWith("HARNESS_")) return "harness";
  if (["PARSE", "SHAPE", "SCHEMA", "CONTRACT", "DUPLICATE", "SIZE"].includes(rule)) return "document";
  if (["PROMPT", "MESSAGE_PATH"].includes(rule)) return "mission";
  if (rule.includes("JOIN") || rule.includes("QUORUM")) return "join";
  if (rule === "SHARED_INSTANCE_PARALLEL" || rule === "DELIVERY") return "instance";
  if (rule.includes("COMPOS")) return "composition";
  return "review";
}
