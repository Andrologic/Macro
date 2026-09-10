import type { AgsdlReport } from "../../types/agsdl";
import { keyId, list, object, readDocument, scanSource, text } from "./document";
import type { ViewerCard } from "./viewer";

export interface LocalizedDiagnostic {
  rule: string;
  details: string;
  path?: string;
  targets: string[];
}

/** Only a real source span or an unambiguous AgSDL key can establish a location. */
export function localizeDiagnostics(source: string, reports: AgsdlReport[], cards: ViewerCard[]): LocalizedDiagnostic[] {
  const doc = readDocument(source);
  const { spans } = scanSource(source);
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
  const diagnostics = reports.flatMap(report => report.results.flatMap(result => result.findings.map(finding => {
    if (result.input !== "primary") return { rule: finding.rule, details: finding.details, path: undefined, targets: [] };
    let path = finding.location.pointer;
    if (path !== undefined && !spans.has(path)) path = undefined;
    if (path === undefined && Number.isSafeInteger(finding.location.byte)) {
      const byte = finding.location.byte!;
      path = [...spans].filter(([, span]) => byte >= span.start && byte < span.end).sort((a, b) => (a[1].end - a[1].start) - (b[1].end - b[1].start))[0]?.[0];
    }
    return { rule: finding.rule, details: finding.details, path, targets: targetsFor(path) };
  })));
  list(doc.unresolved).forEach((value, index) => {
    const unresolved = object(value);
    const subject = uniqueDefinition(unresolved.subject);
    diagnostics.push({ rule: text(unresolved.rule) || "unresolved", details: text(unresolved.obligation) || text(unresolved.reason), path: `/unresolved/${index}`, targets: subject ? targetsFor(subject) : [] });
  });
  return diagnostics;
}
