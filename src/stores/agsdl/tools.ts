import { isFlowDocumentContract } from "../../services/agsdl/contract";
import { isSupportedContract } from "../../services/agsdl/document";
import { readDesign,updateDesignMetadata,validDisplayMetadata,type AgsdlDisplayMetadata,type DesignMetadata } from "../../services/agsdl/design";
import { list,object,pointerPart,readDocument,scanSource,sourceAt,text } from "../../services/agsdl/document";
import { AGSDL_EXAMPLES,createExampleDocument,type AgsdlExample } from "../../services/agsdl/examples";
import { flowAuthoringGuide } from "../../services/agsdl/guide030";
import { unassessedHarnessCatalogue,type ReadAgsdlHarnessCatalogue } from "../../services/agsdl/harnessCatalogue";
import { macroNativeModelEdition } from "../../services/agsdl/nativeModelEdition";
import { getArchitectPlan } from "../../services/architectPlanService";
import { paginateTextBytes,TOOL_OUTPUT_LIMITS } from "../../shared/toolOutputLimits";
import type { AgsdlChange } from "../../types/agsdl";
import { agsdlSessionKey,useAgsdlStore } from "../useAgsdlStore";
import { useProviderStore } from "../useProviderStore";

/** An authoring request was refused without changing the source. */
export class AgsdlAuthoringRefusal extends Error {
  constructor(message: string) { super(message); this.name = "AgsdlAuthoringRefusal"; }
}

class AgsdlReadArgumentError extends Error {}

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


export function agsdlAuthoringGuide(contract: unknown, empty = false) {
  if (contract === "agsdl-0.1.0") return legacyGuide;
  if (isFlowDocumentContract(contract)) return flowAuthoringGuide(contract);
  if (empty) return flowAuthoringGuide();
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
const catalogNames = (contract: unknown) => isFlowDocumentContract(contract)
  ? ["agents", "content", "skills", "mcpServers", "compositions"]
  : ["agents", "configurations", "bindings", "content", "skills", "compositions"];
function inventory(doc: Record<string, unknown>, path: string): InventoryEntry[] {
  const entries: InventoryEntry[] = [];
  if (isFlowDocumentContract(doc.contract)) {
    for (const catalog of catalogNames(doc.contract)) {
      for (const name of Object.keys(object(doc[catalog]))) entries.push({ catalog, name, path: `/${catalog}/${pointerPart(name)}` });
    }
    for (const [name, value] of Object.entries(object(doc.compositions))) {
      list(object(value).parameters).forEach((parameter, index) => entries.push({ catalog: "parameters", name: text(parameter), path: `/compositions/${pointerPart(name)}/parameters/${index}` }));
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AgsdlReadArgumentError(`${key} must be a nonnegative safe integer.`);
  return value;
}
function inventoryPage(doc: Record<string, unknown>, entries: InventoryEntry[], args: Record<string, unknown>) {
  if (!isSupportedContract(doc.contract)) {
    return { contract: bytes(doc.contract ?? null) < 256 ? doc.contract : undefined, supported: false };
  }
  const offset = integerArg(args, "offset", 0), limit = Math.min(integerArg(args, "limit", 100), 200);
  if (!limit) throw new AgsdlReadArgumentError("limit must be positive.");
  if (offset > entries.length) throw new AgsdlReadArgumentError("offset exceeds the inventory total.");
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
    ...Object.fromEntries(catalogNames(doc.contract).map(catalog => [catalog, items.filter(item => "catalog" in item && item.catalog === catalog)])),
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
  if (section === "models" && offset > 0 && args.cursor === undefined) throw new AgsdlReadArgumentError("Use the returned cursor to continue the provider catalog read.");
  let limit = Math.min(integerArg(args, "limit", PAGE_BYTES), PAGE_BYTES);
  if (!limit) throw new AgsdlReadArgumentError("limit must be positive.");
  while (true) {
    const page = paginateTextBytes(content, { ...(args.cursor === undefined ? { start_byte: offset } : { cursor: args.cursor, ...(args.offset !== undefined ? { start_byte: offset } : {}) }), max_bytes: limit }, JSON.stringify({ ...base, section, path: typeof args.path === "string" ? args.path : "" }) + "\n" + content);
    const response = { ...base, section, text_page: { format: "json-text", encoding: "utf-8", content: page.content,
      offset: page.startByte, limit: page.maxBytes, total_bytes: page.totalBytes, returned_bytes: page.returnedBytes,
      next_offset: page.truncated ? page.endByte : null, next_cursor: page.nextCursor } };
    if (bytes(response) <= AGSDL_TOOL_RESPONSE_BYTES) return JSON.stringify(response);
    if (limit <= 4) throw new AgsdlReadArgumentError("The read target identifiers exceed the response budget.");
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
  if (!isFlowDocumentContract(readDocument(source).contract)) throw new Error("display_json requires AgSDL 0.3 or 0.4.");
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

export type AgsdlToolCall = {
  toolName: string;
  args: Record<string, unknown>;
  conversationId: string;
  isCurrent: () => boolean;
  /** Runtime-owned qualification. Omission reports not-assessed, never infers native models. */
  blueprintId?: string;
  readHarnessCatalogue?: ReadAgsdlHarnessCatalogue;
};

export async function handleAgsdlToolCall(params: AgsdlToolCall): Promise<string> {
  try {
    return await handleAgsdlToolRequest(params);
  } catch (error) {
    // Read argument errors have no source effect; update response errors may follow a save.
    if (params.toolName === "agsdl_get" && error instanceof AgsdlReadArgumentError) {
      throw new AgsdlAuthoringRefusal(error.message);
    }
    throw error;
  }
}

async function resolveLegacyDocument(params: AgsdlToolCall, args: Record<string, unknown>) {
  const target = {
    planId: text(args.plan_id),
    branchName: text(args.target_branch),
  };
  if (!target.planId || !target.branchName)
    throw new Error(
      "Supply plan_id and target_branch (storageTargetBranch) from this conversation.",
    );
  const plan = await getArchitectPlan(target.branchName, target.planId);
  if (!params.isCurrent()) throw new Error("The authoring turn has ended.");
  if (
    !plan ||
    plan.status === "deleted" ||
    plan.conversationId !== params.conversationId
  )
    throw new Error(
      "The AgSDL document must belong to the calling plan conversation.",
    );
  if (!plan.agsdl) throw new AgsdlAuthoringRefusal("Select an AgSDL system in the Architect navigator.");
  return { target, editable: plan.status === "draft" };
}

async function handleAgsdlToolRequest(params: AgsdlToolCall): Promise<string> {
  if (!params.isCurrent()) throw new Error("The authoring turn has ended.");
  const { args } = params;
  const { target, editable } = params.blueprintId ? {
    target: { blueprintId: params.blueprintId }, editable: true,
  } : await resolveLegacyDocument(params, args);
  if (params.blueprintId && (args.plan_id !== undefined || args.target_branch !== undefined ||
      (args.blueprint_id !== undefined && args.blueprint_id !== params.blueprintId) ||
      (params.toolName === "agsdl_update" && args.blueprint_id !== params.blueprintId)))
    throw new AgsdlAuthoringRefusal("Read the selected blueprint with agsdl_get before editing.");
  const store = useAgsdlStore.getState;
  await store().load(target);
  if (!params.isCurrent()) throw new Error("The authoring turn has ended.");
  const current = () => store().sessions[agsdlSessionKey(target)];
  if (params.toolName === "agsdl_get" && args.expected_revision !== undefined && args.expected_revision !== current().version) {
    throw new AgsdlAuthoringRefusal("The document changed. Restart agsdl_get pagination with the current revision.");
  }
  if (params.toolName === "agsdl_update") {
    if (current().saving)
      throw new Error("Wait for the current save to finish before editing.");
    if (!editable)
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
      throw new AgsdlAuthoringRefusal("Supply exactly one of changes, source, example, design_json, or display_json.");
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
  if (!session || session.version !== validationVersion) {
    const message = "The document changed during validation. Read agsdl_get again.";
    if (params.toolName === "agsdl_get") throw new AgsdlAuthoringRefusal(message);
    throw new Error(message);
  }
  let doc: Record<string, unknown> = {};
  try {
    if (session.source) doc = readDocument(session.source);
  } catch {
    /* Keep malformed source available for repair. */
  }
  const pointer = typeof args.path === "string" ? args.path : "";
  const source = session.source && pointer ? sourceAt(session.source, pointer) : session.source;
  if (params.toolName === "agsdl_get" && args.expected_revision !== undefined && args.expected_revision !== session.version) throw new AgsdlAuthoringRefusal("The document changed. Restart agsdl_get pagination with the current revision.");
  if (args.section !== undefined && !sections.includes(args.section as ReadSection)) throw new AgsdlReadArgumentError("Unknown AgSDL read section.");
  const section = args.section as ReadSection | undefined;
  const base = { ...("blueprintId" in target ? { blueprint_id: target.blueprintId } : { plan_id: target.planId, target_branch: target.branchName }), revision: session.version,
    persisted_revision: session.persistedRevision, dirty: session.dirty, ...(bytes(pointer) <= 1024 ? { path: pointer } : { path_omitted: true }) };
  const entries = inventory(doc, pointer);
  let designContext: unknown;
  try { if (session.source) designContext = readDesign(session.source, session.design); }
  catch (error) { designContext = { error: String(error) }; }
  const usesHarnessCatalogue = isFlowDocumentContract(doc.contract) || !session.source;
  const needsModels = section === 'models' || (!section && !pointer);
  let models: unknown;
  if (needsModels && usesHarnessCatalogue) models = params.readHarnessCatalogue ? await params.readHarnessCatalogue() : unassessedHarnessCatalogue(isFlowDocumentContract(doc.contract) ? doc.contract : undefined);
  else if (needsModels) {
    const providerState = useProviderStore.getState();
    models = providerState.providers.filter(provider => provider.isEnabled !== false).map(provider => ({
      providerId: provider.id, name: provider.name,
      models: (providerState.modelsByProvider[provider.id] ?? []).filter(model => model.isEnabled !== false).map(model => ({ modelId: model.id, name: model.name, edition: macroNativeModelEdition(provider.id, model.id) })),
    }));
  }
  if (!params.isCurrent()) throw new Error("The authoring turn has ended.");
  if (current()?.version !== session.version) {
    const message = "The document changed during the catalogue read. Read agsdl_get again.";
    if (params.toolName === "agsdl_get") throw new AgsdlAuthoringRefusal(message);
    throw new Error(message);
  }
  if ((integerArg(args, "offset", 0) > 0 || args.cursor !== undefined) && args.expected_revision === undefined) throw new AgsdlReadArgumentError("expected_revision is required after the first page.");
  if (args.cursor !== undefined && (!section || section === "outline")) throw new AgsdlReadArgumentError("cursor is only available for text sections.");
  if (section === "outline") {
    const response = { ...base, outline: inventoryPage(doc, entries, args) };
    if (bytes(response) > AGSDL_TOOL_RESPONSE_BYTES) throw new AgsdlReadArgumentError("The read target identifiers exceed the response budget.");
    return JSON.stringify(response);
  }
  if (section) {
    let content: string;
    if (section === "source") content = source;
    else if (section === "guide") content = JSON.stringify(agsdlAuthoringGuide(doc.contract, !session.source));
    else if (section === "report") {
      const index = integerArg(args, "report_index", 0), report = session.reports[index];
      if (!report) throw new AgsdlReadArgumentError("report_index does not identify an available report.");
      content = typeof report.documentReportJson === "string" ? report.documentReportJson : JSON.stringify(report);
      return textPage(content, args, section, { ...base, report_index: index });
    } else if (section === "outline_entry") {
      const index = integerArg(args, "entry_index", 0);
      if (!entries[index]) throw new AgsdlReadArgumentError("entry_index does not identify an available inventory entry.");
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
    if (isFlowDocumentContract(doc.contract)) addBounded(response, "display_context", session.display ?? {}, "display", AGSDL_TOOL_RESPONSE_BYTES - PAGE_BYTES);
    addBounded(response, usesHarnessCatalogue ? "harness_catalogue" : "macro_models", models, "models", AGSDL_TOOL_RESPONSE_BYTES - PAGE_BYTES);
    if (!session.source) response.examples = AGSDL_EXAMPLES;
  }
  addBounded(response, "error", session.error, "error");
  addBounded(response, "source", source, "source");
  if (bytes(response) > AGSDL_TOOL_RESPONSE_BYTES) throw new AgsdlReadArgumentError("The read target identifiers exceed the response budget.");
  return JSON.stringify(response);
}
