import { readDesign, defaultDesign, type AgsdlEnvelopeMetadata } from "./design";
import { AGSDL_CONTRACT, keyId, list, object, pointerPart, readDocument, text } from "./document";
import { projectViewer, type ViewerCard } from "./viewer";

export type DesignChangeAspect = "identity" | "instructions" | "connections" | "configuration";
export interface DesignChange { kind: "added" | "modified" | "removed"; title: string; path?: string; before?: string; after?: string; aspects?: DesignChangeAspect[]; details?: Array<{ aspect: DesignChangeAspect; before: string; after: string; technical?: boolean }> }
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const connectionKeys = new Set(["success", "failure", "true", "false", "bindings", "context", "inputs", "outputs", "resources", "approvers", "approvalCall", "dependencies", "interface"]);
function withoutPrompt(value: Record<string, unknown>, agentLike = false) {
  const copy = structuredClone(value);
  if (agentLike) delete copy.name;
  if (copy.annotations) { const annotations = object(copy.annotations); delete annotations.title; if (agentLike) delete annotations.description; if (!Object.keys(annotations).length) delete copy.annotations; }
  if (agentLike && copy.payload) { const payload = object(copy.payload); delete payload.mission; }
  return copy;
}
interface Participant { card: ViewerCard; parts: Record<DesignChangeAspect, unknown> }
function snapshot(source: string, metadata?: AgsdlEnvelopeMetadata) {
  if (readDocument(source).contract === AGSDL_CONTRACT) return snapshot020(source, metadata);
  const doc = readDocument(source), residual = structuredClone(doc);
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
    const raw = structuredClone(card.details), agent = object(raw.agentDefinition ?? (["Agent", "System"].includes(card.kind) ? raw : undefined));
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
    const copy = structuredClone(definition);
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
    const empty = { participants: new Map<string, Participant>(), residual: {}, doc: {} as Record<string, unknown> };
    const old = before ? snapshot(before, beforeMetadata) : empty, next = after ? snapshot(after, afterMetadata) : empty;
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
    const configurationValue = (doc: Record<string, unknown>) => doc.contract === AGSDL_CONTRACT ? { configurations: doc.configurations, bindings: doc.bindings } : doc.runtime;
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

function snapshot020(source: string, metadata?: AgsdlEnvelopeMetadata) {
  const doc = readDocument(source), residual = structuredClone(doc);
  const participants = new Map<string, Participant>();
  const cards = metadata?.display?.cards ?? {};
  const contentText = (value: unknown): string => list(value).map(item => {
    const use = object(item), source = use.ref ? object(object(doc.content)[text(use.ref)]) : use;
    return typeof source.value === 'string' ? source.value : text(source.uri);
  }).filter(Boolean).join('\n\n');
  const add = (id: string, path: string, kind: string, mission: string, details: Record<string, unknown>, parts: Participant['parts']) => {
    const card: ViewerCard = { id, path, kind, title: cards[path]?.title || id, mission: mission || cards[path]?.description || '', unresolved: false, inputs: [], outputs: [], branches: [], details };
    parts.identity = { title: card.title, kind };
    participants.set(`${path}:0`, { card, parts });
  };
  for (const [id, raw] of Object.entries(object(doc.agents))) {
    const agent = object(raw), { prompt, resources, configuration, ...rest } = agent;
    const path = `/agents/${pointerPart(id)}`;
    add(id, path, 'Agent', contentText(prompt), agent, { identity: {}, instructions: { prompt, mission: cards[path]?.description }, connections: { resources }, configuration: { configuration, ...rest } });
  }
  const flows: Array<[string, Record<string, unknown>]> = [['/flow', object(doc.flow)], ...Object.entries(object(doc.compositions)).map(([name, value]): [string, Record<string, unknown>] => [`/compositions/${pointerPart(name)}`, object(value)])];
  for (const [base, flow] of flows) for (const [id, raw] of Object.entries(object(flow.steps))) {
    const step = object(raw), { next, onError, call, after, members, steers, message, ...rest } = step;
    const path = `${base}/steps/${pointerPart(id)}`;
    add(id, path, text(step.type), contentText(object(message).prompt), step, { identity: {}, instructions: { message, mission: cards[path]?.description }, connections: { next, onError, call, after, members, steers }, configuration: rest });
  }
  delete residual.agents; delete residual.configurations; delete residual.bindings;
  if (residual.flow) delete object(residual.flow).steps;
  for (const composition of Object.values(object(residual.compositions))) delete object(composition).steps;
  const remainingCards = Object.fromEntries(Object.entries(cards).map(([path, { title: _title, description: _description, ...rest }]) => [path, rest]).filter(([_, rest]) => Object.keys(rest as object).length));
  return { participants, doc, residual: { document: residual, title: metadata?.display?.title, cards: remainingCards, migration: metadata?.migration } };
}
