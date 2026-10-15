import { list, object, pointerPart, scanSource, text } from "./document";
import type { AgsdlEnvelopeMetadata } from "./design";
import type { ViewerCard, ViewerFlowInput, ViewerGraph, ViewerPort, ViewerPromptSource, ViewerReference } from "./viewer";

type Value = Record<string, unknown>;
const display = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "";
const pathFor = (map: string, name: string) => `/${map}/${pointerPart(name)}`;

/** Authored routes only. Fan-out destinations retain their distinct identities. */
export function flowRoutes(step: Value): Array<{ label: string; target: unknown; path: string }> {
  const routes: Array<{ label: string; target: unknown; path: string }> = [];
  if (Array.isArray(step.next)) step.next.forEach((target, index) => routes.push({ label: "next", target, path: `/next/${index}` }));
  else for (const [label, targets] of Object.entries(object(step.next))) {
    list(targets).forEach((target, index) => routes.push({ label, target, path: `/next/${pointerPart(label)}/${index}` }));
  }
  list(step.onError).forEach((target, index) => routes.push({ label: "onError", target, path: `/onError/${index}` }));
  return routes;
}

/** Reading model for the closed 0.2 contract. No runtime state or instances are inferred. */
export function projectViewer020(doc: Value, inputSource: string, metadata?: AgsdlEnvelopeMetadata) {
  let scanned: ReturnType<typeof scanSource> | undefined;
  const rawValue = (path: string) => {
    scanned ??= scanSource(inputSource);
    const span = scanned.spans.get(path);
    return span ? new TextDecoder().decode(scanned.bytes.subarray(span.start, span.end)) : undefined;
  };
  const agents = object(doc.agents);
  const content = object(doc.content);
  const skills = object(doc.skills);
  const configurations = object(doc.configurations);
  const compositions = object(doc.compositions);
  const named = (map: string, name: unknown): ViewerReference => {
    const id = text(name);
    const exists = !!id && Object.hasOwn(object(doc[map]), id);
    return { label: id || display(name), source: "unknown", target: exists ? pathFor(map, id) : undefined, unresolved: !exists };
  };
  const source = (value: unknown): Value => {
    const use = object(value);
    return typeof use.ref === "string" ? object(content[use.ref]) : use;
  };
  const contentReference = (value: unknown, path?: string): ViewerReference => {
    const use = object(value);
    if (typeof use.ref === "string") return named("content", use.ref);
    const resolved = source(value);
    if (Object.hasOwn(resolved, "value")) return { label: display(resolved.value), source: "literal",
      ...(typeof resolved.value !== "string" && path ? { valueJson: rawValue(`${path}/value`) } : {}) };
    if (typeof resolved.uri === "string") return { label: resolved.uri, uri: resolved.uri, source: "unknown" };
    return { label: display(value), source: "unknown", unresolved: true };
  };
  const promptSources = (agent: Value, path: string): ViewerPromptSource[] => [
    ...list(agent.skills).flatMap(name => list(object(skills[text(name)]).prompt).map((use, index) => ({ use, path: `${pathFor("skills", text(name))}/prompt/${index}` }))),
    ...list(agent.prompt).map((use, index) => ({ use, path: `${path}/prompt/${index}` })),
  ].map(({ use, path }): ViewerPromptSource => {
    const resolved = source(use), ref = text(object(use).ref);
    const owner = ref ? pathFor("content", ref) : path;
    const common = { mediaType: text(resolved.mediaType), ...(ref ? { reference: named("content", ref) } : {}) };
    if (typeof resolved.value === "string") return { ...common, kind: "text", text: resolved.value };
    if (typeof resolved.uri === "string") return { ...common, kind: "uri", uri: resolved.uri };
    if (Object.hasOwn(resolved, "value")) return { ...common, kind: "structured", valueJson: rawValue(`${owner}/value`) };
    return { ...common, kind: "unknown" };
  });
  const prompt = (agent: Value, path: string): string => promptSources(agent, path).flatMap(item => item.kind === "text" ? [item.text ?? ""] : []).join("\n\n");
  const resources = (agent: Value, path: string): ViewerPort[] => {
    const entries = [
      ...list(agent.skills).flatMap(name => Object.entries(object(object(skills[text(name)]).resources)).map(([key, use]) => ({ name: key, use, path: `${pathFor("skills", text(name))}/resources/${pointerPart(key)}` }))),
      ...Object.entries(object(agent.resources)).map(([name, use]) => ({ name, use, path: `${path}/resources/${pointerPart(name)}` })),
    ];
    return entries.map(({ name, use, path }) => ({ name, type: text(source(use).mediaType), binding: contentReference(use, path) }));
  };
  const results = (agent: Value): ViewerPort[] => Object.entries(object(object(agent.interface).results)).map(([name, rule]) => ({
    name, type: list(object(rule).mediaTypes).map(text).join(" · "),
  }));
  const configurationNames = (agent: Value) => typeof agent.configuration === "string"
    ? [agent.configuration] : Object.values(object(object(agent.configuration).cases)).map(text);
  const tools = (agent: Value): ViewerReference[] => [...new Set(configurationNames(agent).flatMap(name => Object.values(object(object(configurations[name]).tools)).map(text)))].map(name => named("bindings", name));
  const details = (value: Value, extras: Value = {}) => ({ ...value, ...extras, contract: "agsdl-0.2.0" });
  const agentCard = (name: string, value: unknown): ViewerCard => {
    const agent = object(value);
    return { path: pathFor("agents", name), id: name, title: name, kind: "Agent", mission: prompt(agent, pathFor("agents", name)), promptSources: promptSources(agent, pathFor("agents", name)), unresolved: false,
      inputs: resources(agent, pathFor("agents", name)), outputs: results(agent), tools: tools(agent), resources: list(agent.skills).map(name => named("skills", name)),
      branches: [], details: details(agent, { agentName: name, agentPath: pathFor("agents", name) }) };
  };
  const declarations = Object.entries(agents).map(([name, value]) => agentCard(name, value));
  for (const [map, kind] of [["content", "Resource"], ["skills", "Skill"], ["configurations", "Configuration"], ["bindings", "Binding"], ["compositions", "Composition"]]) {
    for (const [name, value] of Object.entries(object(doc[map]))) {
      const declaration = object(value);
      declarations.push({ path: pathFor(map, name), id: name, title: name, kind, mission: map === "skills" ? prompt(declaration, pathFor(map, name)) : map === "content" ? text(declaration.uri) || text(declaration.value) : "",
        ...(map === "skills" ? { promptSources: promptSources(declaration, pathFor(map, name)) } : {}),
        unresolved: false, inputs: [], outputs: [], branches: [], details: details(declaration) });
    }
  }
  const graphs: ViewerGraph[] = [];
  const graph = (value: unknown, path: string, title: string, composition?: string): ViewerGraph => {
    const flow = object(value);
    const steps = object(flow.steps);
    const reference = (target: unknown): ViewerReference => {
      if (typeof target === "string") {
        const exists = Object.hasOwn(steps, target);
        return { label: target, source: "step", target: exists ? `${path}/steps/${pointerPart(target)}` : undefined, unresolved: !exists };
      }
      const exportTarget = object(target);
      if (composition && typeof exportTarget.output === "string") return {
        label: exportTarget.output, source: "unknown", unresolved: !list(flow.outputs).includes(exportTarget.output),
      };
      if (composition && exportTarget.error === true) return { label: "onError", source: "unknown" };
      return { label: display(target), source: "step", unresolved: true };
    };
    const cards = Object.entries(steps).map(([name, value]): ViewerCard => {
      const step = object(value);
      const type = text(step.type);
      const agentName = text(step.agent);
      const parameter = text(object(step.agent).parameter);
      const agent = Object.hasOwn(agents, agentName) ? object(agents[agentName]) : undefined;
      const participant = parameter && composition ? { label: parameter, source: "unknown" as const,
        unresolved: !list(flow.agentParameters).includes(parameter) } : named("agents", step.agent);
      const card: ViewerCard = { path: `${path}/steps/${pointerPart(name)}`, id: name, title: name, kind: type, mission: agent ? prompt(agent, pathFor("agents", agentName)) : "",
        ...(agent ? { promptSources: promptSources(agent, pathFor("agents", agentName)) } : {}),
        unresolved: type === "agent" ? !!participant.unresolved : type === "compose" ? !!named("compositions", step.composition).unresolved
          : ["call", "approval"].includes(type) ? !!named("bindings", step.binding).unresolved : false,
        inputs: agent ? resources(agent, pathFor("agents", agentName)) : [], outputs: agent ? results(agent) : [],
        branches: flowRoutes(step).map(route => ({ label: route.label, reference: reference(route.target), path: `${path}/steps/${pointerPart(name)}${route.path}` })),
        details: details(step, { ...(composition ? { composition } : {}), ...(agent ? { agentDefinition: agent, agentName, agentPath: pathFor("agents", agentName) } : {}) }),
      };
      if (type === "agent") { card.participant = participant; card.tools = agent ? tools(agent) : []; }
      if (type === "compose") card.composition = named("compositions", step.composition);
      if (type === "approval") { card.approvalCall = reference(step.call); card.approvalBinding = named("bindings", step.binding); }
      if (type === "call") card.tools = [named("bindings", step.binding)];
      if (type === "join") card.dependencies = list(step.members).map(reference);
      if (type === "prepare") {
        const message = object(step.message);
        card.mission = prompt(message, `${card.path}/message`);
        card.promptSources = promptSources(message, `${card.path}/message`);
        card.inputs = Object.entries(object(message.resources)).map(([name, use]) => {
          const item = object(use);
          const operand = object(item.source ?? item.select);
          const binding = Object.hasOwn(operand, "value")
            ? Object.hasOwn(item, "source") ? contentReference(operand.value, `${card.path}/message/resources/${pointerPart(name)}/source/value`) : { label: display(operand.value), source: "literal" as const }
            : Object.hasOwn(item, "select") || Object.hasOwn(item, "source") ? { label: display(item), source: "unknown" as const } : contentReference(use);
          return { name, type: text(item.mediaType) || text(source(Object.hasOwn(item, "source") ? operand.value : use).mediaType), binding };
        });
      }
      return card;
    });
    projectFlowInputs(cards, reference(flow.entry).target, !!composition);
    return { path, title, entry: reference(flow.entry), inputs: [], outputs: list(flow.outputs).map(name => ({ name: text(name), type: "" })), cards, contract: "agsdl-0.2.0" };
  };
  if (Object.hasOwn(doc, "flow")) graphs.push(graph(doc.flow, "/flow", text(doc.id)));
  if (Object.hasOwn(doc, "flow")) for (const [name, value] of Object.entries(compositions)) graphs.push(graph(value, pathFor("compositions", name), name, name));
  for (const graph of graphs) {
    const title = metadata?.display?.cards?.[graph.path]?.title;
    if (title?.trim()) graph.title = title;
  }
  for (const card of [...declarations, ...graphs.flatMap(graph => graph.cards)]) {
    const own = metadata?.display?.cards?.[card.path];
    const participant = metadata?.display?.cards?.[text(card.details.agentPath)];
    const inherited = participant ? Object.fromEntries(["macroGroup", "macroTaskId", "macroLegacyNodeId", "macroStatus"].filter(key => Object.hasOwn(participant, key)).map(key => [key, object(participant)[key]])) : {};
    const display = { ...inherited, ...own };
    if (!Object.keys(display).length) continue;
    if (typeof display.title === "string" && display.title.trim()) card.title = display.title;
    card.details = { ...card.details, displayAnnotations: { ...display } };
  }
  const byPath = new Map([...declarations, ...graphs.flatMap(graph => graph.cards)].map(card => [card.path, card]));
  const label = (reference: ViewerReference | undefined) => {
    if (reference?.target && !reference.unresolved) reference.label = byPath.get(reference.target)?.title ?? reference.label;
  };
  for (const graph of graphs) {
    label(graph.entry);
    for (const card of graph.cards) {
      label(card.participant); label(card.composition); label(card.approvalCall); label(card.approvalBinding);
      for (const branch of card.branches) label(branch.reference);
      for (const input of card.flowInputs ?? []) label(input.reference);
      for (const ref of [...card.tools ?? [], ...card.dependencies ?? [], ...card.resources ?? []]) label(ref);
      for (const input of card.inputs) label(input.binding);
    }
  }
  return { title: metadata?.display?.title || text(doc.id), contract: "agsdl-0.2.0", systemDetails: doc, graphs, declarations, legacyCards: [] as ViewerCard[], migrated: !!metadata?.migration,
    migrationIssues: metadata?.migration?.issues ?? [] as string[], unresolved: [] as unknown[], dependencies: [] as unknown[] };
}


/** Static origins describe the declared delivery boundary, never actual occurrence data. */
function projectFlowInputs(cards: ViewerCard[], entry: string | undefined, composition: boolean) {
  type Origin = { kind: ViewerFlowInput["origin"]; path?: string };
  const byPath = new Map(cards.map(card => [card.path, card]));
  const incoming = new Map(cards.map(card => [card.path, new Map<string, Origin>()]));
  const queue: string[] = [];
  const add = (path: string | undefined, origin: Origin) => {
    if (!path || !incoming.has(path)) return;
    const key = JSON.stringify([origin.kind, origin.path]);
    const values = incoming.get(path)!;
    if (values.has(key)) return;
    values.set(key, origin); queue.push(path);
  };
  add(entry, { kind: composition ? "unknown" : "entry" });
  const outgoing = (card: ViewerCard, branch: ViewerCard["branches"][number]): Origin[] => {
    if (branch.path?.startsWith(`${card.path}/onError/`)) return [{ kind: "error", path: card.path }];
    if (card.kind === "condition" || (card.kind === "approval" && branch.label === "approved")) return [...incoming.get(card.path)!.values()];
    if (["agent", "call", "prepare", "join"].includes(card.kind)) return [{ kind: card.kind as Origin["kind"], path: card.path }];
    // Denial and opaque composition exports have no asserted producing origin here.
    return [{ kind: "unknown", path: card.path }];
  };
  for (let index = 0; index < queue.length; index++) {
    const card = byPath.get(queue[index])!;
    for (const branch of card.branches) if (!branch.reference.unresolved) {
      for (const origin of outgoing(card, branch)) add(branch.reference.target, origin);
    }
  }
  const projection = (origin: Origin, receiver: ViewerCard): string => {
    if (receiver.kind === "agent") {
      if (["entry", "prepare"].includes(origin.kind)) return "Message";
      if (origin.kind === "agent") return "resources.result ← text · text/plain";
      if (origin.kind === "call") return "resources.result ← data · application/json";
      if (origin.kind === "join") return "resources.result ← members · application/json";
      if (origin.kind === "error") return "resources.error ← error · application/json";
    }
    return { entry: "Message", prepare: "Message", agent: "completion", call: "data", join: "members", error: "error", unknown: "current value" }[origin.kind];
  };
  for (const card of cards) {
    card.flowInputs = [...incoming.get(card.path)!.values()].map(origin => ({
      origin: origin.kind, projection: projection(origin, card), reference: {
        label: origin.path ? byPath.get(origin.path)!.title : composition ? "current value" : "Message",
        source: origin.path ? "step" : "input", target: origin.path,
      },
    }));
    for (const branch of card.branches) {
      const receiver = branch.reference.target ? byPath.get(branch.reference.target) : undefined;
      if (!receiver || branch.reference.unresolved || !incoming.get(card.path)!.size) continue;
      branch.transfers = [...new Set(outgoing(card, branch).map(origin => projection(origin, receiver)))];
    }
    if (card.kind === "prepare" && card.flowInputs.length === 1) {
      for (const input of card.inputs) {
        const resource = object(object(card.details.message).resources)[input.name];
        if (!Object.hasOwn(object(resource), "select") && !Object.hasOwn(object(resource), "source")) continue;
        const current = card.flowInputs[0];
        const producer = current.reference;
        if (!producer.target || !input.binding) continue;
        const operand = object(object(resource).source ?? object(resource).select);
        // Literal operands do not read the incoming value and have no producing step.
        if (!Array.isArray(operand.path)) continue;
        const selectedPath = operand.path;
        const port = current.origin === "agent" && selectedPath.length === 2 && selectedPath[0] === "results" &&
          typeof selectedPath[1] === "string" && byPath.get(producer.target)?.outputs.some(output => output.name === selectedPath[1])
          ? selectedPath[1] : undefined;
        input.binding = { ...input.binding, target: producer.target, label: `${producer.label} · ${input.binding.label}`,
          ...(port ? { source: "step", port } : {}) };
      }
    }
  }
}
