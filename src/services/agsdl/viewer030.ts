import { list, object, pointerPart, scanSource, text } from "./document";
import type { AgsdlEnvelopeMetadata } from "./design";
import type { ViewerCard, ViewerGraph, ViewerPromptSource, ViewerReference } from "./viewer";

export interface ViewerRoute030 {
  /** Pointer to the authored target, including scalar targets and empty choices. */
  path: string;
  sourcePath: string;
  role: "normal" | "error";
  key?: string;
  targetKind: "step" | "output" | "terminal" | "unresolved";
  target?: string;
  targetName?: string;
  messageJson?: string;
  eachJson?: string;
  concurrencyJson?: string;
  maxJson?: string;
  valueJson?: string;
}

/** Static source inspection only. Runtime normalization and message resolution belong to 05. */
export function projectViewer030(source: string, metadata?: AgsdlEnvelopeMetadata) {
  const scanned = scanSource(source);
  const doc = object(scanned.tree);
  if (doc.contract !== "agsdl-0.3.0") throw new Error("Expected agsdl-0.3.0.");
  const raw = (path: string) => {
    const span = scanned.spans.get(path);
    return span ? new TextDecoder().decode(scanned.bytes.subarray(span.start, span.end)) : undefined;
  };
  const named = (map: string, name: unknown): ViewerReference => {
    const id = text(name), exists = Object.hasOwn(object(doc[map]), id);
    return { label: id, source: "unknown", target: exists ? `/${map}/${pointerPart(id)}` : undefined, unresolved: !exists };
  };
  const prompts = (value: unknown, path: string): ViewerPromptSource[] => {
    if (typeof value === "string") return [{ kind: "text", text: value, mediaType: "text/plain" }];
    return list(value).map((use, index) => {
      const ref = text(object(use).ref);
      const owner = ref ? `/content/${pointerPart(ref)}` : `${path}/${index}`;
      const item = ref ? object(object(doc.content)[ref]) : object(use);
      const common = { mediaType: text(item.mediaType) || (typeof item.value === "string" ? "text/plain" : Object.hasOwn(item, "value") ? "application/json" : ""), ...(ref ? { reference: named("content", ref) } : {}) };
      if (typeof item.value === "string") return { ...common, kind: "text", text: item.value };
      if (typeof item.uri === "string") return { ...common, kind: "uri", uri: item.uri };
      if (Object.hasOwn(item, "value")) return { ...common, kind: "structured", valueJson: raw(`${owner}/value`) };
      return { ...common, kind: "unknown" };
    });
  };
  const base = (path: string, id: string, value: unknown, kind: string): ViewerCard => {
    const item = object(value);
    return { path, id, title: text(item.title) || id, kind, mission: text(item.description), unresolved: false,
      inputs: [], outputs: [], branches: [], details: { ...item, contract: "agsdl-0.3.0" },
      edition030: { sourceJson: raw(path) ?? "{}", maxVisitsJson: raw(`${path}/maxVisits`), routes: [] } };
  };
  const configureAgent = (card: ViewerCard, name: string) => {
    const agent = object(object(doc.agents)[name]);
    if (!Object.hasOwn(object(doc.agents), name)) return;
    const path = `/agents/${pointerPart(name)}`;
    card.details = { ...card.details, agentName: name, agentPath: path, agentDefinition: agent };
    card.edition030!.agentPath = path;
    card.edition030!.definitionJson = raw(path);
    card.promptSources = prompts(agent.instructions, `${path}/instructions`);
    card.mission = card.promptSources.filter(item => item.kind === "text").map(item => item.text).join("\n\n");
    card.resources = list(agent.skills).map(name => named("skills", name));
    card.tools = list(agent.mcpServers).map(name => named("mcpServers", name));
    card.capabilities = { skills: list(agent.skills).map(text), structuredResults: Object.values(object(agent.results)).some(rule => Object.hasOwn(object(rule), "schema")), dynamicConfiguration: false, externalEffects: false };
    card.outputs = [{ name: "text", type: "text/plain" }, ...Object.entries(object(agent.results)).map(([name, rule]) => ({ name, type: text(object(rule).mediaType) }))];
    card.inputs = Object.entries(object(agent.resources)).map(([name, use]) => {
      const item = object(use), ref = text(item.ref), owner = ref ? `/content/${pointerPart(ref)}` : `${path}/resources/${pointerPart(name)}`;
      const resolved = ref ? object(object(doc.content)[ref]) : item;
      return { name, type: text(resolved.mediaType), binding: ref ? named("content", ref) : typeof resolved.uri === "string"
        ? { label: resolved.uri, uri: resolved.uri, source: "unknown" as const }
        : { label: typeof resolved.value === "string" ? resolved.value : raw(`${owner}/value`) ?? "", valueJson: raw(`${owner}/value`), source: "literal" as const } };
    });
  };
  const documentCard = base("", text(doc.id), doc, "System");
  documentCard.path = "agsdl:document";
  documentCard.edition030!.ownerPath = "";
  const declarations: ViewerCard[] = [documentCard];
  for (const [map, kind] of [["agents", "Agent"], ["content", "Resource"], ["skills", "Skill"], ["mcpServers", "McpServer"], ["compositions", "Composition"]]) {
    for (const [name, value] of Object.entries(object(doc[map]))) {
      const card = base(`/${map}/${pointerPart(name)}`, name, value, kind);
      if (map === "agents") configureAgent(card, name);
      declarations.push(card);
    }
  }
  const graphs: ViewerGraph[] = [];
  const graph = (value: unknown, path: string, name: string, composition: boolean): ViewerGraph => {
    const flow = object(value), steps = object(flow.steps);
    const routes = (value: unknown, at: string, sourcePath: string, role: ViewerRoute030["role"], key?: string): ViewerRoute030[] => {
      if (Array.isArray(value)) return value.length ? value.flatMap((target, index) => routes(target, `${at}/${index}`, sourcePath, role, key))
        : [{ path: at, sourcePath, role, key, targetKind: "terminal", valueJson: raw(at) }];
      const target = object(value), stepName = typeof value === "string" ? value : text(target.step);
      const output = text(target.output);
      const exists = !!stepName && Object.hasOwn(steps, stepName);
      return [{ path: at, sourcePath, role, key, targetKind: stepName ? exists ? "step" : "unresolved" : output ? composition && list(flow.outputs).includes(output) ? "output" : "unresolved" : "unresolved",
        targetName: stepName || output, target: exists ? `${path}/steps/${pointerPart(stepName)}` : undefined,
        messageJson: raw(`${at}/message`), eachJson: raw(`${at}/each`), concurrencyJson: raw(`${at}/concurrency`), maxJson: raw(`${at}/max`), valueJson: raw(at) }];
    };
    const cards = Object.entries(steps).map(([id, value]) => {
      const step = object(value), card = base(`${path}/steps/${pointerPart(id)}`, id, step, text(step.type));
      if (step.type === "agent") {
        const parameter = text(object(step.agent).parameter);
        card.participant = parameter ? { label: parameter, source: "unknown", unresolved: !composition || !list(flow.parameters).includes(parameter) } : named("agents", step.agent);
        card.unresolved = !!card.participant.unresolved;
        configureAgent(card, text(step.agent));
      }
      if (step.type === "compose") { card.composition = named("compositions", step.composition); card.unresolved = !!card.composition.unresolved; }
      const next = step.next;
      const ownRoutes: ViewerRoute030[] = next === undefined ? [{ path: card.path, sourcePath: card.path, role: "normal", targetKind: "terminal" }]
        : typeof next === "string" || Array.isArray(next) || Object.hasOwn(object(next), "step") || Object.hasOwn(object(next), "output")
          ? routes(next, `${card.path}/next`, card.path, "normal")
          : Object.entries(object(next)).flatMap(([key, route]) => routes(route, `${card.path}/next/${pointerPart(key)}`, card.path, "normal", key));
      if (step.onError !== undefined) ownRoutes.push(...routes(step.onError, `${card.path}/onError`, card.path, "error"));
      card.edition030!.routes = ownRoutes;
      card.branches = ownRoutes.map(route => ({ path: route.path, label: route.key ?? (route.role === "error" ? "onError" : "next"), route030: route,
        reference: { label: route.targetName ?? "", target: route.target, source: "step", unresolved: route.targetKind === "unresolved" },
        transfers: route.messageJson !== undefined ? ["message"] : [route.role === "error" ? "resources.error" : step.type === "agent" ? "resources.text · results" : step.type === "call" ? "resources.result" : step.type === "join" ? "branches" : "message"] }));
      return card;
    });
    const entryName = text(flow.entry);
    return { path, title: text(flow.title) || name, contract: "agsdl-0.3.0", cards, inputs: [], outputs: list(flow.outputs).map(name => ({ name: text(name), type: "" })),
      entry: { label: entryName, source: "step", target: Object.hasOwn(steps, entryName) ? `${path}/steps/${pointerPart(entryName)}` : undefined, unresolved: !Object.hasOwn(steps, entryName) },
      errorRoutes030: flow.onError === undefined ? [] : routes(flow.onError, `${path}/onError`, path, "error") };
  };
  if (Object.hasOwn(doc, "flow")) {
    graphs.push(graph(doc.flow, "/flow", text(doc.title) || text(doc.id), false));
    declarations.push(base("/flow", "flow", doc.flow, "Flow"));
  }
  for (const [name, value] of Object.entries(object(doc.compositions))) graphs.push(graph(value, `/compositions/${pointerPart(name)}`, name, true));
  for (const card of [...declarations, ...graphs.flatMap(graph => graph.cards)]) {
    const display = metadata?.display?.cards?.[card.path];
    if (display) { card.details.displayAnnotations = display; if (display.title?.trim()) card.title = display.title; }
  }
  return { title: metadata?.display?.title || text(doc.title) || text(doc.id), contract: "agsdl-0.3.0", systemDetails: doc, graphs, declarations,
    legacyCards: [] as ViewerCard[], migrated: false, migrationIssues: [] as string[], unresolved: [] as unknown[], dependencies: [] as unknown[] };
}
