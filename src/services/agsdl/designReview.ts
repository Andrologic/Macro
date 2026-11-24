import { isFlowDocumentContract } from "./contract";
import { clone,decimal,NumberToken,parse } from "../../vendor/agsdl/shared/values.mjs";
import { defaultDesign,readDesign,type AgsdlEnvelopeMetadata } from "./design";
import { keyId,list,object,pointerPart,readDocument,text } from "./document";
import { projectViewer,type ViewerCard } from "./viewer";

export type DesignChangeAspect = "identity" | "instructions" | "connections" | "configuration";
export interface DesignChange { kind: "added" | "modified" | "removed"; title: string; path?: string; before?: string; after?: string; aspects?: DesignChangeAspect[]; details?: Array<{ aspect: DesignChangeAspect; before: string; after: string; technical?: boolean }> }
// Typed encoding distinguishes numeric tokens from authored strings and objects.
const canonical = (value: unknown): unknown => value instanceof NumberToken || typeof value === "number"
  ? ["number", ...(typeof value === "number" && !Number.isFinite(value) ? [String(value)] : decimal(value).map(String))]
  : Array.isArray(value) ? ["array", value.map(canonical)]
    : value && typeof value === "object" ? ["object", Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])]
      : [typeof value, value];
const stable = (value: unknown): string => JSON.stringify(canonical(value));
function reviewDocument(source: string) {
  // Enforce the editor limit and edition checks before reading exact numeric tokens.
  readDocument(source);
  const parsed = parse(new TextEncoder().encode(source));
  if (parsed.error) throw new Error("Invalid AgSDL source.");
  return object(parsed.tree);
}
const connectionKeys = new Set(["success", "failure", "true", "false", "bindings", "context", "inputs", "outputs", "resources", "approvers", "approvalCall", "dependencies", "interface"]);
function withoutPrompt(value: Record<string, unknown>, agentLike = false) {
  const copy = clone(value);
  if (agentLike) delete copy.name;
  if (copy.annotations) { const annotations = object(copy.annotations); delete annotations.title; if (agentLike) delete annotations.description; if (!Object.keys(annotations).length) delete copy.annotations; }
  if (agentLike && copy.payload) { const payload = object(copy.payload); delete payload.mission; }
  return copy;
}
interface Participant { card: ViewerCard; parts: Record<DesignChangeAspect, unknown> }
interface Snapshot { participants: Map<string, Participant>; residual: Record<string, unknown>; doc: Record<string, unknown>; coveredCatalogs?: Record<string, Set<string>> }
function snapshot(source: string, metadata?: AgsdlEnvelopeMetadata): Snapshot {
  if (isFlowDocumentContract(readDocument(source).contract)) return snapshot030(source, metadata);
  const doc = readDocument(source), residual = clone(doc);
  const viewer = projectViewer(source);
  const definitions = list(doc.definitions).map(object), relations = list(doc.relations).map(object);
  const coveredDefinitions = new Set<number>(), coveredRelations = new Set<number>();
  const entries: Array<[string, ViewerCard]> = viewer.graphs.flatMap((graph, index) => graph.cards
    .filter(card => card.kind !== "end")
    .map(card => [`graph:${keyId(object(list(doc.graphs)[index]).definition)}:${card.id}`, card] as [string, ViewerCard]));
  const usedAgents = new Set(viewer.graphs.flatMap(graph => graph.cards.filter(card => card.kind === "invoke").map(card => keyId(card.details.agent))));
  for (const card of viewer.legacyCards.length ? viewer.legacyCards : viewer.declarations.filter(card => ["Agent", "System"].includes(card.kind))) {
    if (!usedAgents.has(keyId(card.details.key))) entries.push([card.path.startsWith('/legacy/') ? `legacy:${card.id}` : `definition:${keyId(card.details.key)}`, card]);
  }
  const participants = new Map<string, Participant>();
  const occurrences = new Map<string, number>();
  for (const [identity, card] of entries) {
    const raw = clone(card.details), agent = object(raw.agentDefinition ?? (["Agent", "System"].includes(card.kind) ? raw : undefined));
    delete raw.agentDefinition;
    if (raw.displayAnnotations) { raw.annotations = raw.displayAnnotations; delete raw.displayAnnotations; }
    const agentKey = keyId(agent.key);
    definitions.forEach((definition, index) => { if (definition === card.details || (agent.key && keyId(definition.key) === agentKey)) coveredDefinitions.add(index); });
    const instructionDefinitions: unknown[] = [], agentRelations: unknown[] = [];
    relations.forEach((relation, index) => {
      if (!agent.key || keyId(relation.source) !== agentKey) return;
      coveredRelations.add(index);
      if (relation.relation === "directedBy") {
        instructionDefinitions.push(relation);
        definitions.forEach((definition, index) => {
          if (keyId(definition.key) === keyId(relation.target)) { coveredDefinitions.add(index); instructionDefinitions.push(definition); }
        });
      } else agentRelations.push(relation);
    });
    const connections = Object.fromEntries(Object.entries(raw).filter(([name]) => connectionKeys.has(name)));
    const configuration = withoutPrompt(Object.fromEntries(Object.entries(raw).filter(([name]) => !connectionKeys.has(name))), ["Agent", "System"].includes(card.kind));
    const parts = { identity: { title: card.title, kind: card.kind }, instructions: { mission: card.mission, definitions: instructionDefinitions }, connections: { ...connections, relations: agentRelations }, configuration: { component: configuration, agent: withoutPrompt(agent, true) } };
    const occurrence = occurrences.get(identity) ?? 0; occurrences.set(identity, occurrence + 1);
    // Invalid duplicate identifiers remain inspectable instead of disappearing into a Map overwrite.
    participants.set(`${identity}:${occurrence}`, { card, parts });
  }
  residual.definitions = definitions.filter((_, index) => !coveredDefinitions.has(index)).map(definition => {
    const copy = clone(definition);
    if (copy.kind === "ControlFlow") {
      const annotations = object(copy.annotations), steps = object(annotations.macroSteps);
      for (const graph of list(doc.graphs).map(object)) if (keyId(graph.definition) === keyId(copy.key)) {
        for (const step of list(graph.steps).map(object)) if (step.kind !== "end" && typeof step.id === "string") delete steps[step.id];
      }
      if (annotations.macroSteps && !Object.keys(steps).length) delete annotations.macroSteps;
      if (copy.annotations && !Object.keys(annotations).length) delete copy.annotations;
    }
    return copy;
  });
  residual.relations = relations.filter((_, index) => !coveredRelations.has(index));
  if (Array.isArray(residual.graphs)) residual.graphs = residual.graphs.map(graph => ({ ...object(graph), steps: list(object(graph).steps).filter(step => object(step).kind === "end") }));
  delete residual.runtime;
  const root = object(residual.root), annotations = object(root.annotations);
  delete annotations.macroDesign;
  if (!Object.keys(annotations).length) delete root.annotations;
  return { participants, residual, doc };
}

/** Compare source identities and authored references, never neighboring display labels. */
export function reviewDesignChanges(before: string, after: string, beforeMetadata?: AgsdlEnvelopeMetadata, afterMetadata?: AgsdlEnvelopeMetadata): { changes: DesignChange[]; configuration: boolean; design: boolean; other: boolean; designDetails?: Array<{ label: string; before: string; after: string }> } {
  try {
    const empty: Snapshot = { participants: new Map<string, Participant>(), residual: {}, doc: {} as Record<string, unknown> };
    const old = before ? snapshot(before, beforeMetadata) : empty, next = after ? snapshot(after, afterMetadata) : empty;
    // Compare declarations not already attributed to participants. Use both snapshots
    // so removing a reference does not make an unchanged declaration look modified.
    for (const map of ["content", "skills", "mcpServers"]) {
      const oldNames = old.coveredCatalogs?.[map] ?? new Set<string>(), nextNames = next.coveredCatalogs?.[map] ?? new Set<string>();
      const names = new Set([...oldNames, ...nextNames].filter(name =>
        (oldNames.has(name) && nextNames.has(name)) || stable(object(old.doc[map])[name]) === stable(object(next.doc[map])[name])));
      for (const state of [old, next]) {
        const document = object(state.residual.document), catalog = object(document[map]);
        for (const name of names) delete catalog[name];
        if (names.size && !Object.keys(catalog).length) delete document[map];
      }
    }
    const changes: DesignChange[] = [];
    for (const [id, { card, parts }] of next.participants) {
      const previous = old.participants.get(id);
      // A declaration becoming unused is revealed in the viewer, not newly authored.
      if (!previous && id.startsWith("definition:") && list(old.doc.definitions).some(value => keyId(object(value).key) === keyId(card.details.key) && stable(value) === stable(card.details))) continue;
      const aspects = (Object.keys(parts) as DesignChangeAspect[]).filter(aspect => !previous || stable(previous.parts[aspect]) !== stable(parts[aspect]));
      if (!previous || aspects.length) {
        const details = aspects.map(aspect => ({
          aspect,
          before: aspect === "identity" ? previous?.card.title ?? "" : aspect === "instructions" ? previous?.card.mission ?? "" : "",
          after: aspect === "identity" ? card.title : aspect === "instructions" ? card.mission : "",
          technical: aspect === "connections" || aspect === "configuration",
        }));
        changes.push({ kind: previous ? "modified" : "added", title: card.title, path: card.path, before: previous?.card.mission, after: card.mission, aspects, details });
      }
    }
    for (const [id, { card }] of old.participants) if (!next.participants.has(id) && !(id.startsWith("definition:") && list(next.doc.definitions).some(value => keyId(object(value).key) === keyId(card.details.key) && stable(value) === stable(card.details)))) changes.push({ kind: "removed", title: card.title, before: card.mission });
    const configurationValue = (doc: Record<string, unknown>) => isFlowDocumentContract(doc.contract)
      ? Object.fromEntries(Object.entries(object(doc.agents)).map(([name, value]) => {
        const { instructions: _instructions, resources: _resources, title: _title, description: _description, ...configuration } = object(value);
        return [name, configuration];
      }))
      : doc.runtime;
    const configuration = stable(configurationValue(old.doc)) !== stable(configurationValue(next.doc));
    const previousDesign = before ? readDesign(before, beforeMetadata?.design) : defaultDesign();
    const currentDesign = after ? readDesign(after, afterMetadata?.design) : defaultDesign();
    const design = stable(previousDesign) !== stable(currentDesign);
    const designDetails: Array<{ label: string; before: string; after: string }> = [];
    if (design && before && after) {
      const previous = previousDesign, current = currentDesign;
      for (const field of ["purpose", "context"] as const) {
        if (previous[field] !== current[field]) designDetails.push({ label: `agsdl.design.${field}`, before: previous[field], after: current[field] });
      }
      for (const id of new Set([...previous.requirements, ...current.requirements].map(item => item.id))) {
        const oldValue = previous.requirements.find(item => item.id === id), newValue = current.requirements.find(item => item.id === id);
        if (stable(oldValue) !== stable(newValue)) designDetails.push({ label: newValue?.label || oldValue?.label || "agsdl.design.adaptations", before: oldValue?.value ?? "", after: newValue?.value ?? "" });
      }
      for (const id of new Set([...previous.rules, ...current.rules].map(item => item.id))) {
        const oldRule = previous.rules.find(item => item.id === id), newRule = current.rules.find(item => item.id === id);
        if (stable(oldRule) !== stable(newRule)) designDetails.push({ label: newRule?.title || oldRule?.title || "agsdl.design.rules", before: oldRule?.instructions ?? "", after: newRule?.instructions ?? "" });
      }
    }
    return { changes, configuration, design, ...(designDetails.length ? { designDetails } : {}), other: stable(old.residual) !== stable(next.residual) };
  } catch { return { changes: [], configuration: false, design: false, other: before !== after || stable(beforeMetadata) !== stable(afterMetadata) }; }
}

function snapshot030(source: string, metadata?: AgsdlEnvelopeMetadata): Snapshot {
  const doc = reviewDocument(source), residual = clone(doc);
  const participants = new Map<string, Participant>();
  const cards = metadata?.display?.cards ?? {};
  const coveredCatalogs: Record<string, Set<string>> = { content: new Set(), skills: new Set(), mcpServers: new Set() };
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    const use = object(value);
    if (typeof use.ref === 'string') {
      coveredCatalogs.content.add(use.ref);
      return { use, declaration: object(doc.content)[use.ref] };
    }
    return value;
  };
  const resources = (value: unknown) => Object.fromEntries(Object.entries(object(value)).map(([name, use]) => [name, resolve(use)]));
  const message = (value: unknown) => {
    if (value === undefined) return undefined;
    const record = object(value);
    return { ...record, prompt: resolve(record.prompt), resources: resources(record.resources) };
  };
  const route = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(route);
    if (!value || typeof value !== 'object' || value instanceof NumberToken) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'message' ? message(item) : route(item)]));
  };
  const mission = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(mission).filter(Boolean).join('\n\n');
    const record = object(value);
    if ('declaration' in record) return mission(record.declaration);
    return typeof record.value === 'string' ? record.value : text(record.uri);
  };
  const declarations = (catalog: string, names: unknown) => list(names).map(name => {
    const id = text(name); coveredCatalogs[catalog].add(id);
    return { id, declaration: object(doc[catalog])[id] };
  });
  const add = (path: string, id: string, kind: string, details: Record<string, unknown>, instructions: unknown, connections: unknown, configuration: unknown) => {
    const description = cards[path]?.description;
    const card: ViewerCard = { id, path, kind, title: cards[path]?.title || text(details.title) || id,
      mission: [mission(instructions), description].filter(Boolean).join('\n\n'), unresolved: false, inputs: [], outputs: [], branches: [], details };
    participants.set(`${path}:0`, { card, parts: { identity: { title: card.title, kind, description: details.description }, instructions: { content: instructions, description }, connections, configuration } });
  };
  for (const [name, value] of Object.entries(object(doc.agents))) {
    const agent = object(value);
    const { instructions, resources: info, skills, mcpServers, title: _title, description: _description, ...settings } = agent;
    add(`/agents/${pointerPart(name)}`, name, 'Agent', agent, resolve(instructions), resources(info),
      { ...settings, skills: declarations('skills', skills), mcpServers: declarations('mcpServers', mcpServers) });
  }
  const flows: Array<[string, Record<string, unknown>]> = [
    ['/flow', object(doc.flow)],
    ...Object.entries(object(doc.compositions)).map(([name, value]): [string, Record<string, unknown>] => [`/compositions/${pointerPart(name)}`, object(value)]),
  ];
  for (const [base, flow] of flows) {
    if (!Object.keys(flow).length) continue;
    const { steps, entry, onError, title: _title, description: _description, ...settings } = flow;
    add(base, base.split('/').at(-1)!, base === '/flow' ? 'Flow' : 'Composition', flow, undefined, { entry, onError: route(onError) }, settings);
    for (const [name, value] of Object.entries(object(steps))) {
      const step = object(value);
      const { prompt, next, onError, title: _title, description: _description, ...settings } = step;
      const server = text(object(step.mcp).server);
      if (server) coveredCatalogs.mcpServers.add(server);
      add(`${base}/steps/${pointerPart(name)}`, name, text(step.type), step, resolve(prompt),
        { next: route(next), onError: route(onError) },
        { ...settings, ...(server ? { server: object(doc.mcpServers)[server] } : {}) });
    }
  }
  delete residual.agents; delete residual.flow; delete residual.compositions;
  const remainingCards = Object.fromEntries(Object.entries(cards).map(([path, card]) => {
    if (!participants.has(`${path}:0`)) return [path, card];
    const { title: _title, description: _description, ...rest } = card;
    return [path, rest];
  }).filter(([, rest]) => Object.keys(rest as object).length));
  return { participants, doc, coveredCatalogs, residual: { document: residual, title: metadata?.display?.title, cards: remainingCards, migration: metadata?.migration } };
}
