import { getArchitectPlan } from "../architectPlanService";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { list, object, readDocument, sourceAt, text } from "./document";
import { AGSDL_EXAMPLES, createExample, type AgsdlExample } from "./examples";
import type { AgsdlChange } from "../../types/agsdl";
import { readDesign } from "./design";
import { useProviderStore } from "../../stores/useProviderStore";

export const AGSDL_AUTHORING_INSTRUCTION =
  "For AgSDL process design or editing, read agsdl_get with the plan_id and target_branch (storageTargetBranch) from this conversation. Follow its authoring guide, edit through agsdl_update using the returned revision, and report scoped diagnostics. The right panel visualizes this document; focused manual edits share the same versioned session. Handle structural changes through the authoring tools. Explain changed missions, data transfers and routes in plain language. Document authoring does not execute agents.";

const guide = {
  contract: "agsdl-0.1.0",
  workflow:
    "Read the document and revision. Prefer atomic changes at JSON pointers to preserve opaque content and number tokens. After update, inspect diagnostics and correct the affected paths. Read source with these tools to diagnose unsupported contracts.",
  definition:
    "D declares root, definitions, relations, and dependencies. Keys have scope, id, version. Keep reference identity intact when renaming. Instructions, Skills, and Tools are definitions linked by relations; their opaque bodies are data.",
  graph:
    "G is a closed sequential graph with entry, typed inputs and outputs, invoke/condition/approval/end steps. Routes reference step ids. An invoke declares agent, interface, operation, context, bindings, success and failure. End success outputs must satisfy graph outputs. Loops, parallelism and nesting are outside G 0.1.0.",
  runtime:
    "Macro is the execution engine for systems designed here. Use engine {identity:'macro',version:'1'} and parameters.providerId/modelId from macro_models for newly configured agent bindings. Preserve other parameters and explicit selections. Foreign imported bindings remain readable; ask before converting their semantics. Tools and MCP access require explicit declarations and bindings, never infer grants from local availability. Structural validation does not certify execution readiness.",
  design:
    "Architect designs reusable systems, with one plan conversation per system for now. root.annotations.macroDesign is optional Macro design metadata: {version:1,kind:'system'|'blueprint',purpose:string,context:string,rules:[{id,title,instructions}],requirements:[{id,label,description,value,targetPath?}],origin?:{planId,name,revision}}. Keep ids stable. Empty requirement values are information still needed. Read supplied values and shared context, then explicitly apply them to the appropriate instructions, bindings and resources. These annotations are design intent, not runtime enforcement. Translate process rules into supported graph checks/approval steps or report unsupported checks; never claim that a prompt alone enforces a gate. Preserve template provenance and unknown metadata. A draft can remain incomplete while the user refines it.",
  presentation:
    "Use concise responsibility titles. Keep full instructions in their owning declarations. Group related agents only when useful with annotations.macroGroup:string on Agent definitions, a shared human-readable group title. G steps are closed records; never add annotations directly to a graph step. For per-step display names, descriptions or groups, use the owning ControlFlow definition.annotations.macroSteps[step.id] with title, description or macroGroup. Keep executable agent instructions in Agent/Instructions declarations. This is a reversible presentation grouping, not a subgraph or execution node. Do not create nodes for generic entry/result or add fake data transfers. Change existing identities only when necessary so the user can review updates in place.",
  scope:
    "Plan metadata only; no system execution or dependency network retrieval. Examples initialize empty documents with unconfigured engines. Attached annex bytes are preserved separately. Give agents descriptive titles and describe input/output contracts; bindings must identify actual provenance, never infer data transfer from execution order. Preserve migration metadata and report any unmapped legacy behavior.",
};

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
      throw new Error("The document changed. Read agsdl_get before editing.");
    const alternatives = ["changes", "source", "example"].filter((key) =>
      Object.hasOwn(args, key),
    );
    if (alternatives.length !== 1)
      throw new Error("Supply exactly one of changes, source, or example.");
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
    } else if (alternatives[0] === "example") {
      if (!AGSDL_EXAMPLES.includes(args.example as AgsdlExample))
        throw new Error("Unknown AgSDL example.");
      if (current().source)
        throw new Error(
          "Examples initialize empty documents. Edit the existing document through changes or source.",
        );
      store().replace(
        target,
        createExample(args.example as AgsdlExample),
        {},
        args.expected_revision,
      );
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
  if (current().source) await store().validate(target);
  const session = current();
  let doc: Record<string, unknown> = {};
  try {
    if (session.source) doc = readDocument(session.source);
  } catch {
    /* Keep malformed source available for repair. */
  }
  const pointer = typeof args.path === "string" ? args.path : "";
  const source =
    session.source && pointer
      ? sourceAt(session.source, pointer)
      : session.source;
  const limit = 48_000;
  let designContext: unknown;
  try { if (session.source) designContext = readDesign(session.source); }
  catch (error) { designContext = { error: String(error) }; }
  const providerState = useProviderStore.getState();
  return JSON.stringify({
    plan_id: target.planId,
    target_branch: target.branchName,
    revision: session.version,
    persisted_revision: session.persistedRevision,
    dirty: session.dirty,
    path: pointer,
    source: source.length <= limit ? source : undefined,
    source_omitted:
      source.length > limit
        ? "Read smaller paths using agsdl_get. Partial JSON is never returned."
        : undefined,
    outline: {
      contract: doc.contract,
      definitions: list(doc.definitions)
        .slice(0, 100)
        .map((value, index) => ({
          path: `/definitions/${index}`,
          key: object(value).key,
          kind: object(value).kind,
        })),
      graphs: list(doc.graphs).map((value, index) => ({
        path: `/graphs/${index}`,
        definition: object(value).definition,
      })),
    },
    annex_ids: Object.keys(session.annexes),
    diagnostics: session.reports.map((report) => ({
      operation: report.operation,
      results: report.results.map((result) => ({
        input: result.input,
        unit: result.unit,
        verdict: result.verdict,
        findings: result.findings.slice(0, 30),
        finding_count: result.findings.length,
      })),
    })),
    error: session.error,
    authoring_guide: pointer ? undefined : guide,
    design_context: pointer ? undefined : designContext,
    macro_models: pointer ? undefined : providerState.providers.filter(provider => provider.isEnabled !== false).map(provider => ({
      providerId: provider.id, name: provider.name,
      models: (providerState.modelsByProvider[provider.id] ?? []).filter(model => model.isEnabled !== false).map(model => ({ modelId: model.id, name: model.name })),
    })),
    examples: session.source ? undefined : AGSDL_EXAMPLES,
  });
}
