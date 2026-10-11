import { getArchitectPlan } from "../../services/architectPlanService";
import { agsdlSessionKey, useAgsdlStore } from "../useAgsdlStore";
import { list, object, readDocument, sourceAt, text, pointerPart, scanSource } from "../../services/agsdl/document";
import { AGSDL_EXAMPLES, createExampleDocument, type AgsdlExample } from "../../services/agsdl/examples";
import type { AgsdlChange } from "../../types/agsdl";
import { readDesign, updateDesignMetadata, validDisplayMetadata, type DesignMetadata, type AgsdlDisplayMetadata } from "../../services/agsdl/design";
import { macroNativeModelEdition } from "../../services/agsdl/nativeModelEdition";
import { useProviderStore } from "../useProviderStore";
import { paginateTextBytes, TOOL_OUTPUT_LIMITS } from "../../shared/toolOutputLimits";

/** A local revision guard rejected the request before editing or saving. */
export class AgsdlAuthoringRefusal extends Error {
  constructor(message: string) { super(message); this.name = "AgsdlAuthoringRefusal"; }
}

export const AGSDL_AUTHORING_INSTRUCTION =
  "For AgSDL process design or editing, read agsdl_get with the plan_id and target_branch (storageTargetBranch) from this conversation. Read section: guide for the contract before structural changes; it is available even when a scoped source read omits the overview. Follow its authoring guide, edit through agsdl_update using the returned revision, and report scoped diagnostics. The right panel visualizes this document; focused manual edits share the same versioned session. Handle structural changes through the authoring tools. Explain changed missions, data transfers and routes in plain language. Document authoring does not execute agents.";

const legacyGuide = {
  contract: "agsdl-0.1.0",
  workflow:
    "Read the document and revision. Prefer atomic changes at JSON pointers to preserve opaque content and number tokens. After update, inspect diagnostics and correct the affected paths. Read source with these tools to diagnose unsupported contracts. Follow outline.next_offset with section: outline and expected_revision to discover every pointer. When a value is omitted, read its explicit section and concatenate text_page.content in next_offset order before parsing.",
  definition:
    "D declares root, definitions, relations, and dependencies. Keys have scope, id, version. Keep reference identity intact when renaming. Instructions, Skills, and Tools are definitions linked by relations; their opaque bodies are data.",
  graph:
    "G is a closed sequential graph with entry, typed inputs and outputs, invoke/condition/approval/end steps. Routes reference step ids. An invoke declares agent, interface, operation, context, bindings, success and failure. End success outputs must satisfy graph outputs. Loops, parallelism and nesting are outside G 0.1.0.",
  runtime:
    "Macro is the execution engine for systems designed here. Use engine {identity:'macro/desktop',version:'1'} and parameters.providerId/modelId from macro_models for newly configured agent bindings. Preserve other parameters and explicit selections. Foreign imported bindings remain readable; ask before converting their semantics. Tools and MCP access require explicit declarations and bindings, never infer grants from local availability. Structural validation does not certify execution readiness.",
  design:
    "Architect designs reusable systems, with one plan conversation per system for now. root.annotations.macroDesign is optional Macro design metadata: {version:1,kind:'system'|'blueprint',purpose:string,context:string,rules:[{id,title,instructions}],requirements:[{id,label,description,value,targetPath?}],origin?:{planId,name,revision}}. Keep ids stable. Empty requirement values are information still needed. Read supplied values and shared context, then explicitly apply them to the appropriate instructions, bindings and resources. These annotations are design intent, not runtime enforcement. Translate process rules into supported graph checks/approval steps or report unsupported checks; never claim that a prompt alone enforces a gate. Preserve template provenance and unknown metadata. A draft can remain incomplete while the user refines it.",
  presentation:
    "Use concise responsibility titles. Keep full instructions in their owning declarations. Group related agents only when useful with annotations.macroGroup:string on Agent definitions, a shared human-readable group title. G steps are closed records; never add annotations directly to a graph step. For per-step display names, descriptions or groups, use the owning ControlFlow definition.annotations.macroSteps[step.id] with title, description or macroGroup. Keep executable agent instructions in Agent/Instructions declarations. This is a reversible presentation grouping, not a subgraph or execution node. Do not create nodes for generic entry/result or add fake data transfers. Change existing identities only when necessary so the user can review updates in place.",
  scope:
    "Plan metadata only; no system execution or dependency network retrieval. Examples initialize empty documents with unconfigured engines. Attached annex bytes are preserved separately. Give agents descriptive titles and describe input/output contracts; bindings must identify actual provenance, never infer data transfer from execution order. Preserve migration metadata and report any unmapped legacy behavior.",
};


const guide02 = {
  contract: "agsdl-0.2.0",
  workflow: "Read source and revision. Follow outline.next_offset with section: outline, offset and expected_revision until null to discover every declaration; read each path for its exact source. Full static reports are available with section: report and report_index. Read each *_omitted.section explicitly before editing its data. For any text_page, concatenate content in next_offset order for the same revision before parsing the JSON text. Apply atomic JSON-pointer changes with the returned revision, preserve opaque settings and numeric tokens, then inspect fresh diagnostics. Preserve imported editions and author a separate 0.2.0 document only after deliberate migration of intent and losses.",
  document: "The closed document requires contract:'agsdl-0.2.0', id, agents, configurations and bindings. Optional fields are content, skills, flow, compositions and baseUri. id and catalog names match ^[A-Za-z][A-Za-z0-9_-]*$. Catalogs are maps. Use only the 0.2.0 shapes. Unknown fields fail validation, except in literal values, settings and external requirement parameters.",
  content: "A source has exactly value or uri, with optional mediaType. A content use may instead be {ref:catalogName}. When an interface restricts inputMediaTypes, declare a matching mediaType on every delivered Source, including prepared prompt instructions. Messages separate ordered prompt instructions from named resources containing information. An Agent declares a fixed configuration name or {select:Operand,cases:map}; successful selection before initialization remains fixed for that persistent Agent. Skills expand in declared order before the Agent prompt and cannot overwrite resource names. An interface uses inputMediaTypes, outputMediaTypes and named results with mediaTypes, optional required and the bounded valueSchema constraint language. URI access and media delivery require integration evidence. Relative URIs use only their originating explicit baseUri; preserve unresolved origins.",
  flow: "Optional flow contains entry and a steps map. Steps have type agent, call, condition, prepare, join, approval or compose and their type-specific closed fields. next lists activate every destination; agent decisions use an explicit decision binding, choices and a matching next map. condition uses test and true/false next lists. prepare authors message roles. Operands resolve against the current incoming value. Agent completion is {text:string,results:map,choice?:string}; call completion exposes data. After an Agent, prepare a text resource with {select:{path:['text']},mediaType:'text/plain'}. source copies a complete content Source object, while select wraps a value. Direct Agent completion transfers visible text as information; prepared Messages retain prompt/resources. call results expose data; join results expose members. Default Agent delivery is queue. Steering, joins, loops, bounded composition and approval chains need their declared 0.2.0 constraints and scoped static checks. Normal path termination is an absent or empty next list. Use onError for explicit recovery.",
  flow_shapes: "Use operands {value:literal} or {path:[stringOrNonnegativeIndex,...]}. Predicates are {equals:[Operand,Operand]}, {all:[Predicate,...]} or {not:Predicate}. An agent step requires agent; optional decision is {binding,choices}, delivery is queue|steering and steers names its ordinary owner step. call requires binding and may map arguments to Operands. condition requires test and next:{true:[steps],false:[steps]}. prepare requires message:{prompt?,resources?}; prepared resources may use a Content, {select:Operand,mediaType?} or {source:Operand}. join requires after and members; mode is all|first, first requires accept, and remaining is stop-and-wait|finish. approval requires call, binding, timeoutMs, validForMs and next:{approved:[steps],denied:[steps]}; call names the protected action step. Protected targets require scope:{action,resources:[descriptions],context:Operand}. compose requires composition, agents and a next map covering composition outputs. A composition requires entry, steps and outputs, with optional agentParameters; its body is non-nested and serial or conditional. Ordinary steps may declare maxVisits and onError; compose has onError but no maxVisits. Validate the bounded Join and approval structure before reporting it as structurally valid.",
  runtime: "Macro remains the engine selected for Macro-authored configurations. Declare a named binding with contract:{identity:'macro/agent-engine',version:'1'} and implementation:{identity:'macro/desktop',version:'1'}, then configuration.engine names that binding. Select providerId and modelId from macro_models, copy that model's edition into configuration.model and put the identifiers in configuration.settings; preserve all other settings, Engine/Tool declarations and explicit Model editions. The identities are external declarations and confer no support. The manual selector edits only fixed configurations with this exact Engine declaration and no separate model edition. Shared configurations affect every Agent that names them; dynamic cases remain explicit. Imported foreign bindings remain readable and require deliberate conversion. Configuration and skill changes require stop, edit and start in a consuming integration. For the current Macro serial inline runtime, use fixed configurations with settings limited to providerId, modelId, mode, maxTurns and reasoningEffort. The profile accepts inline content, agent, prepare, condition and call steps with serial routes and maxVisits; omit compositions, including empty catalogs. Authoring does not launch execution, and native Preflight is required to verify runtime readiness.",
  support: "bindings separate versioned contract and implementation, with optional settings, requires, claims and effects. Configuration tools map local names to declared bindings. Requirements name an exact contract edition plus optional parameters. Claims use requirement, status supported/unsupported/unknown and optional evidence SHA-256. Exact claims cover only their owning declaration, including settings and selected Engine/Model/Tools. Reassess or remove configuration claims after editing that declaration; preserve unchanged binding claims. Missing/unknown claims or support without evidence remain unknown. declared-supported is an assertion whose evidence was not verified. Report incompatible and unknown requirements independently. executionSupport stays not-assessed; structural validity, available provider names and human Agent responses do not prove execution or approval enforcement.",
  design: "Macro design intent lives in the editor envelope's design metadata, outside this closed AgSDL source. design_context supplies {version:1,kind:system|blueprint,purpose,context,rules:[{id,title,instructions}],requirements:[{id,label,description,value,targetPath?}],origin?:{planId,name,revision}}. Edit it through agsdl_update design_json with the full desired design_context serialized as JSON and the current revision. Keep requirement and rule ids stable; empty values identify information still needed. Apply agreed values to prompt/resources, settings and declared flow controls. Design intent grants no runtime enforcement. Use explicit scopes and approval declarations for protected admission; actual Tool invocation admission remains an external integration requirement. Preserve unknown editor metadata and provenance.",
  presentation: "Use descriptive Agent and step map names. Keep executable instructions in Agent/skill prompts or prepared Messages. Read display_context for Macro presentation metadata {title?:string,cards?:{JSONPointer:{title?:string,description?:string,macroGroup?:string}}}. Edit it through agsdl_update display_json, a JSON object patch with the current revision. Supplied cards paths must exist in the document. Omitted fields and cards retain their values; an empty string clears a display override. Preserve unknown metadata and keep source map names and pointer identities stable when changing labels. Closed declarations do not accept annotations or presentation-only fields. Routes show declared flow; distinguish their delivery roles and provenance from executable support.",
  scope: "Plan document authoring and scoped static declaration checks only. No described Agents are executed, dependency code or URI payloads are not fetched, and external evidence is not verified. Retain original edition markers, reports, annexes and migration provenance. A draft may contain diagnostics while its design is refined.",
};

/** Edition-specific instructions prevent a 0.1 graph vocabulary leaking into 0.2 authoring. */
export function agsdlAuthoringGuide(contract: unknown, empty = false) {
  if (contract === "agsdl-0.1.0") return legacyGuide;
  if (contract === "agsdl-0.2.0" || empty) return guide02;
  return { contract: typeof contract === "string" && bytes(contract) < 256 ? contract : null, ...(typeof contract === "string" && bytes(contract) >= 256 ? { contract_omitted: true } : {}), supported: false,
    workflow: "Preserve this source and its marker. Read diagnostics and repair the explicit edition or malformed JSON through a deliberate source replacement. Select a supported authoring guide only after reading the resulting document. Unknown editions have no inferred AgSDL semantics or execution support." };
}
// Leave room below the shared 50 KiB spill threshold for transport framing.
export const AGSDL_TOOL_RESPONSE_BYTES = Math.min(40 * 1024, TOOL_OUTPUT_LIMITS.toolResult.spillThresholdBytes - 1024);
const PAGE_BYTES = 16 * 1024;
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const sections = ["outline", "outline_entry", "source", "guide", "report", "design", "display", "models", "annex_ids", "error"] as const;
type ReadSection = typeof sections[number];
interface InventoryEntry { catalog: string; path: string; name?: string; type?: unknown; key?: unknown; kind?: unknown }
function inventory(doc: Record<string, unknown>, path: string): InventoryEntry[] {
  const entries: InventoryEntry[] = [];
  if (doc.contract === "agsdl-0.2.0") {
    for (const catalog of ["agents", "configurations", "bindings", "content", "skills", "compositions"]) {
      for (const name of Object.keys(object(doc[catalog]))) entries.push({ catalog, name, path: `/${catalog}/${pointerPart(name)}` });
    }
    const flows: Array<[string, unknown]> = [["/flow", doc.flow], ...Object.entries(object(doc.compositions)).map(([name, value]): [string, unknown] => [`/compositions/${pointerPart(name)}`, value])];
    for (const [base, flow] of flows) for (const [name, value] of Object.entries(object(object(flow).steps))) {
      entries.push({ catalog: "steps", name, path: `${base}/steps/${pointerPart(name)}`, type: object(value).type });
    }
  } else if (doc.contract === "agsdl-0.1.0") {
    list(doc.definitions).forEach((value, index) => entries.push({ catalog: "definitions", path: `/definitions/${index}`, key: object(value).key, kind: object(value).kind }));
    list(doc.graphs).forEach((value, index) => entries.push({ catalog: "graphs", path: `/graphs/${index}`, key: object(value).definition }));
  }
  return path ? entries.filter(entry => entry.path === path || entry.path.startsWith(`${path}/`)) : entries;
}
function integerArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a nonnegative safe integer.`);
  return value;
}
function inventoryPage(doc: Record<string, unknown>, entries: InventoryEntry[], args: Record<string, unknown>) {
  if (!["agsdl-0.1.0", "agsdl-0.2.0"].includes(text(doc.contract))) {
    return { contract: bytes(doc.contract ?? null) < 256 ? doc.contract : undefined, supported: false };
  }
  const offset = integerArg(args, "offset", 0), limit = Math.min(integerArg(args, "limit", 100), 200);
  if (!limit) throw new Error("limit must be positive.");
  if (offset > entries.length) throw new Error("offset exceeds the inventory total.");
  const items: Array<InventoryEntry | { entry_index: number; entry_omitted: { section: string; total_bytes: number } }> = [];
  let index = offset;
  while (index < entries.length && items.length < limit) {
    const entry = entries[index];
    const item = bytes(entry) > PAGE_BYTES / 4
      ? { entry_index: index, entry_omitted: { section: "outline_entry", total_bytes: bytes(entry) } } : entry;
    if (bytes([...items, item]) > PAGE_BYTES / 2) break;
    items.push(item); index += 1;
  }
  // Preserve the small-document catalog keys while paging a single ordered inventory.
  const catalogs = doc.contract === "agsdl-0.1.0" ? {
    definitions: items.filter(item => "catalog" in item && item.catalog === "definitions"),
    graphs: items.filter(item => "catalog" in item && item.catalog === "graphs").map(item => {
      const { key, ...entry } = item as InventoryEntry; return { ...entry, definition: key };
    }),
  } : {
    ...Object.fromEntries(["agents", "configurations", "bindings", "content", "skills", "compositions"].map(catalog => [catalog, items.filter(item => "catalog" in item && item.catalog === catalog)])),
    ...(doc.flow ? { flow: {
      ...(bytes(object(doc.flow).entry ?? null) < 256 ? { entry: object(doc.flow).entry } : { entry_omitted: true }),
      steps: items.filter(item => "catalog" in item && item.catalog === "steps" && item.path.startsWith("/flow/steps/")),
    } } : {}),
  };
  return { contract: doc.contract, ...(bytes(doc.id ?? null) < 256 ? { id: doc.id } : { id_omitted: true }),
    entries: items, ...catalogs, offset, limit, total: entries.length, returned: items.length, next_offset: index < entries.length ? index : null };
}
function textPage(content: string, args: Record<string, unknown>, section: ReadSection, base: Record<string, unknown>) {
  const offset = integerArg(args, "offset", 0);
  if (section === "models" && offset > 0 && args.cursor === undefined) throw new Error("Use the returned cursor to continue the provider catalog read.");
  let limit = Math.min(integerArg(args, "limit", PAGE_BYTES), PAGE_BYTES);
  if (!limit) throw new Error("limit must be positive.");
  while (true) {
    const page = paginateTextBytes(content, { ...(args.cursor === undefined ? { start_byte: offset } : { cursor: args.cursor, ...(args.offset !== undefined ? { start_byte: offset } : {}) }), max_bytes: limit }, JSON.stringify({ ...base, section, path: typeof args.path === "string" ? args.path : "" }) + "\n" + content);
    const response = { ...base, section, text_page: { format: "json-text", encoding: "utf-8", content: page.content,
      offset: page.startByte, limit: page.maxBytes, total_bytes: page.totalBytes, returned_bytes: page.returnedBytes,
      next_offset: page.truncated ? page.endByte : null, next_cursor: page.nextCursor } };
    if (bytes(response) <= AGSDL_TOOL_RESPONSE_BYTES) return JSON.stringify(response);
    if (limit <= 4) throw new Error("The read target identifiers exceed the response budget.");
    limit = Math.max(4, Math.floor(limit / 2));
  }
}
function addBounded(response: Record<string, unknown>, key: string, value: unknown, section: ReadSection, maxBytes = AGSDL_TOOL_RESPONSE_BYTES - 512) {
  if (value === undefined) return;
  if (bytes({ ...response, [key]: value }) <= maxBytes) response[key] = value;
  else response[`${key}_omitted`] = section === "report" ? { section, report_count: Array.isArray(value) ? value.length : undefined }
    : { section, total_bytes: new TextEncoder().encode(key === "source" ? String(value) : JSON.stringify(value)).byteLength };
}


/** Merge supplied display fields without changing source identities or discarding unknown metadata. */
export function updateAgsdlDisplayMetadata(source: string, previous: AgsdlDisplayMetadata | undefined, update: unknown): AgsdlDisplayMetadata {
  if (readDocument(source).contract !== "agsdl-0.2.0") throw new Error("display_json requires AgSDL 0.2.0.");
  if (!validDisplayMetadata(update) || (previous !== undefined && !validDisplayMetadata(previous))) throw new Error("The display metadata is malformed. Its original contents have been preserved.");
  const next = { ...structuredClone(previous), ...structuredClone(update) };
  if (update.cards !== undefined) {
    const parsed = scanSource(source);
    const cards = { ...structuredClone(previous?.cards) };
    for (const [path, card] of Object.entries(update.cards)) {
      if (!path.startsWith("/") || /~(?![01])/u.test(path) || !parsed.spans.has(path)) throw new Error(`Display card path does not exist: ${path}`);
      cards[path] = { ...structuredClone(previous?.cards?.[path]), ...structuredClone(card) };
    }
    next.cards = cards;
  }
  return next;
}

export async function handleAgsdlToolCall(params: {
  toolName: string;
  args: Record<string, unknown>;
  conversationId: string;
  isCurrent: () => boolean;
}): Promise<string> {
  const { args } = params;
  const target = {
    planId: text(args.plan_id),
    branchName: text(args.target_branch),
  };
  if (!target.planId || !target.branchName)
    throw new Error(
      "Supply plan_id and target_branch (storageTargetBranch) from this conversation.",
    );
  const plan = await getArchitectPlan(target.branchName, target.planId);
  if (
    !plan ||
    plan.status === "deleted" ||
    plan.conversationId !== params.conversationId
  )
    throw new Error(
      "The AgSDL document must belong to the calling plan conversation.",
    );
  const store = useAgsdlStore.getState;
  await store().load(target);
  if (!params.isCurrent()) throw new Error("The authoring turn has ended.");
  const current = () => store().sessions[agsdlSessionKey(target)];
  if (params.toolName === "agsdl_update") {
    if (current().saving)
      throw new Error("Wait for the current save to finish before editing.");
    if (plan.status !== "draft")
      throw new Error("AgSDL editing requires a draft plan.");
    if (
      typeof args.expected_revision !== "string" ||
      args.expected_revision !== current().version
    )
      throw new AgsdlAuthoringRefusal("The document changed. Read agsdl_get before editing.");
    const alternatives = ["changes", "source", "example", "design_json", "display_json"].filter((key) =>
      Object.hasOwn(args, key),
    );
    if (alternatives.length !== 1)
      throw new Error("Supply exactly one of changes, source, example, design_json, or display_json.");
    if (alternatives[0] === "changes") {
      if (!Array.isArray(args.changes))
        throw new Error("changes must be an array.");
      const changes: AgsdlChange[] = args.changes.map((value) => {
        const item = object(value);
        if (
          !["set", "remove"].includes(text(item.op)) ||
          typeof item.path !== "string" ||
          (item.op === "set" && typeof item.value_json !== "string")
        )
          throw new Error(
            "Each change needs op, path, and value_json for set.",
          );
        return {
          op: item.op as AgsdlChange["op"],
          path: item.path,
          valueJson: item.value_json as string | undefined,
        };
      });
      store().edit(target, changes, args.expected_revision);
    } else if (alternatives[0] === "design_json") {
      if (typeof args.design_json !== "string") throw new Error("design_json must be a JSON string.");
      scanSource(args.design_json);
      const design = updateDesignMetadata(readDesign(current().source, current().design), JSON.parse(args.design_json) as DesignMetadata);
      store().setDesign(target, design, args.expected_revision);
    } else if (alternatives[0] === "display_json") {
      if (typeof args.display_json !== "string") throw new Error("display_json must be a JSON string.");
      scanSource(args.display_json);
      const session = current();
      const display = updateAgsdlDisplayMetadata(session.source, session.display, JSON.parse(args.display_json));
      store().replace(target, session.source, undefined, args.expected_revision, { design: session.design, display, migration: session.migration });
    } else if (alternatives[0] === "example") {
      if (!AGSDL_EXAMPLES.includes(args.example as AgsdlExample))
        throw new Error("Unknown AgSDL example.");
      if (current().source)
        throw new Error(
          "Examples initialize empty documents. Edit the existing document through changes or source.",
        );
      const example = createExampleDocument(args.example as AgsdlExample);
      store().replace(target, example.source, example.annexes, args.expected_revision, { design: example.design, display: example.display, migration: example.migration });
    } else {
      if (typeof args.source !== "string")
        throw new Error("source must be a JSON string.");
      readDocument(args.source);
      store().replace(target, args.source, undefined, args.expected_revision);
    }
    try {
      await store().save(target);
    } catch (error) {
      throw new Error(
        `Edits remain in the editor but were not saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (params.toolName !== "agsdl_get")
    throw new Error("Unknown AgSDL tool.");
  const validationVersion = current().version;
  if (current().source) await store().validate(target);
  if (!params.isCurrent()) throw new Error("The authoring turn has ended.");
  const session = current();
  if (!session || session.version !== validationVersion) throw new Error("The document changed during validation. Read agsdl_get again.");
  let doc: Record<string, unknown> = {};
  try {
    if (session.source) doc = readDocument(session.source);
  } catch {
    /* Keep malformed source available for repair. */
  }
  const pointer = typeof args.path === "string" ? args.path : "";
  const source = session.source && pointer ? sourceAt(session.source, pointer) : session.source;
  if (params.toolName === "agsdl_get" && args.expected_revision !== undefined && args.expected_revision !== session.version) throw new Error("The document changed. Restart agsdl_get pagination with the current revision.");
  if (args.section !== undefined && !sections.includes(args.section as ReadSection)) throw new Error("Unknown AgSDL read section.");
  const section = args.section as ReadSection | undefined;
  const base = { plan_id: target.planId, target_branch: target.branchName, revision: session.version,
    persisted_revision: session.persistedRevision, dirty: session.dirty, ...(bytes(pointer) <= 1024 ? { path: pointer } : { path_omitted: true }) };
  const entries = inventory(doc, pointer);
  let designContext: unknown;
  try { if (session.source) designContext = readDesign(session.source, session.design); }
  catch (error) { designContext = { error: String(error) }; }
  const providerState = useProviderStore.getState();
  const models = providerState.providers.filter(provider => provider.isEnabled !== false).map(provider => ({
    providerId: provider.id, name: provider.name,
    models: (providerState.modelsByProvider[provider.id] ?? []).filter(model => model.isEnabled !== false).map(model => ({ modelId: model.id, name: model.name, edition: macroNativeModelEdition(provider.id, model.id) })),
  }));
  if ((integerArg(args, "offset", 0) > 0 || args.cursor !== undefined) && args.expected_revision === undefined) throw new Error("expected_revision is required after the first page.");
  if (args.cursor !== undefined && (!section || section === "outline")) throw new Error("cursor is only available for text sections.");
  if (section === "outline") {
    const response = { ...base, outline: inventoryPage(doc, entries, args) };
    if (bytes(response) > AGSDL_TOOL_RESPONSE_BYTES) throw new Error("The read target identifiers exceed the response budget.");
    return JSON.stringify(response);
  }
  if (section) {
    let content: string;
    if (section === "source") content = source;
    else if (section === "guide") content = JSON.stringify(agsdlAuthoringGuide(doc.contract, !session.source));
    else if (section === "report") {
      const index = integerArg(args, "report_index", 0), report = session.reports[index];
      if (!report) throw new Error("report_index does not identify an available report.");
      content = typeof report.documentReportJson === "string" ? report.documentReportJson : JSON.stringify(report);
      return textPage(content, args, section, { ...base, report_index: index });
    } else if (section === "outline_entry") {
      const index = integerArg(args, "entry_index", 0);
      if (!entries[index]) throw new Error("entry_index does not identify an available inventory entry.");
      return textPage(JSON.stringify(entries[index]), args, section, { ...base, entry_index: index });
    } else content = JSON.stringify(({ design: designContext ?? null, display: session.display ?? null,
      models, annex_ids: Object.keys(session.annexes), error: session.error })[section]);
    return textPage(content, args, section, base);
  }
  const response: Record<string, unknown> = { ...base };
  // A scoped source read carries only its own source and revision, never the global inventory.
  if (!pointer) {
    addBounded(response, "authoring_guide", agsdlAuthoringGuide(doc.contract, !session.source), "guide");
    response.outline = inventoryPage(doc, entries, args);
    response.report_count = session.reports.length;
    const diagnostics = session.reports.map((report, report_index) => ({ report_index, operation: report.operation,
      contract: report.contract, scope: report.scope, executionSupport: report.executionSupport,
      results: report.results.map(result => ({ input: result.input, unit: result.unit, verdict: result.verdict,
        finding_count: result.findings.length })), report_section: "report" }));
    addBounded(response, "diagnostics", diagnostics, "report", AGSDL_TOOL_RESPONSE_BYTES - PAGE_BYTES);
    // Small reports retain the old convenience field; the complete session report is always available on demand.
    if (response.diagnostics) {
      const complete = diagnostics.map((summary, index) => ({ ...summary, documentReportJson: session.reports[index].documentReportJson,
        results: session.reports[index].results.map(result => ({ ...result, finding_count: result.findings.length })) }));
      if (bytes(complete) <= 8 * 1024 && bytes({ ...response, diagnostics: complete }) <= AGSDL_TOOL_RESPONSE_BYTES - PAGE_BYTES) response.diagnostics = complete;
    }
    addBounded(response, "annex_ids", Object.keys(session.annexes), "annex_ids", AGSDL_TOOL_RESPONSE_BYTES - PAGE_BYTES);
    addBounded(response, "design_context", designContext, "design", AGSDL_TOOL_RESPONSE_BYTES - PAGE_BYTES);
    if (doc.contract === "agsdl-0.2.0") addBounded(response, "display_context", session.display ?? {}, "display", AGSDL_TOOL_RESPONSE_BYTES - PAGE_BYTES);
    addBounded(response, "macro_models", models, "models", AGSDL_TOOL_RESPONSE_BYTES - PAGE_BYTES);
    if (!session.source) response.examples = AGSDL_EXAMPLES;
  }
  addBounded(response, "error", session.error, "error");
  addBounded(response, "source", source, "source");
  if (bytes(response) > AGSDL_TOOL_RESPONSE_BYTES) throw new Error("The read target identifiers exceed the response budget.");
  return JSON.stringify(response);
}
