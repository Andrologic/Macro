import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ArchitectPlanRecord } from "../../services/architectPlanService";
import type { AgsdlEditorDocument } from "../../types/agsdl";
import type { AIModel, AIProvider } from "../../types";
import { preserveToolResultContent } from '../../services/toolResultArtifacts';
import { createDeferred } from "../../test-utils/deferred";
import { TOOL_OUTPUT_LIMITS } from '../../shared/toolOutputLimits';
import { createLegacyExample as createExample } from "../../services/agsdl/examples";

let plan: ArchitectPlanRecord;
let releaseSave: (() => void) | undefined;
let saveDelay: Promise<void> | undefined;
let failSave = false;
mock.module("../../services/architectPlanService", () => ({
  migrateArchitectPlanToAgsdl: async (_branch: string, id: string) =>
    id === plan.id ? structuredClone(plan) : null,
  getArchitectPlan: async (_branch: string, id: string) =>
    id === plan.id ? structuredClone(plan) : null,
  updateArchitectPlan: async (input: {
    agsdl: AgsdlEditorDocument;
    expectedAgsdlRevision: number;
  }) => {
    if (saveDelay) await saveDelay;
    if (failSave) throw new Error("Storage unavailable");
    if (
      plan.status !== "draft" ||
      input.expectedAgsdlRevision !== (plan.agsdl?.revision ?? 0)
    )
      throw new Error("Revision conflict");
    plan = {
      ...plan,
      agsdl: { ...input.agsdl, revision: input.expectedAgsdlRevision + 1 },
    };
    return structuredClone(plan);
  },
}));
const { useAgsdlStore, agsdlSessionKey } = await import(
  "../useAgsdlStore"
);
const { handleAgsdlToolCall, agsdlAuthoringGuide, AGSDL_TOOL_RESPONSE_BYTES } = await import("./tools");
const { useProviderStore } = await import("../useProviderStore");
let restoreProviderCatalog: (() => void) | undefined;
const providers = [
  { id: 'provider-active', name: 'Active', status: 'online' },
  { id: 'provider-disabled', name: 'Disabled', status: 'offline', isEnabled: false },
] satisfies AIProvider[];
const modelsByProvider = {
  'provider-active': [
    { id: 'model-active', name: 'Available', provider_id: 'provider-active' },
    { id: 'model-disabled', name: 'Unavailable', provider_id: 'provider-active', isEnabled: false },
  ],
  'provider-disabled': [{ id: 'model-hidden', name: 'Hidden', provider_id: 'provider-disabled' }],
} satisfies Record<string, AIModel[]>;
const target = { branchName: "develop", planId: "plan-test" };
const current = () =>
  useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
const call = (
  toolName: string,
  args: Record<string, unknown> = {},
  conversationId = "conversation-test",
  isCurrent = () => true,
) =>
  handleAgsdlToolCall({
    toolName,
    args: { plan_id: target.planId, target_branch: target.branchName, ...args },
    conversationId,
    isCurrent,
  });

beforeEach(() => {
  const originalGetState = useProviderStore.getState;
  const providerCatalog = spyOn(useProviderStore, 'getState').mockImplementation(() => ({
    ...originalGetState(),
    providers,
    modelsByProvider,
  }));
  restoreProviderCatalog = () => providerCatalog.mockRestore();
  plan = {
    id: target.planId,
    title: "Test",
    slug: "test",
    description: "",
    status: "draft",
    targetBranch: "develop",
    conversationId: "conversation-test",
    nodes: [],
    predictedBranches: [],
    createdAt: "",
    updatedAt: "",
    agsdl: { source: createExample("release"), annexes: {}, revision: 1 },
  };
  useAgsdlStore.setState({ sessions: {} });
  failSave = false;
  saveDelay = undefined;
});
afterEach(() => {
  releaseSave?.();
  restoreProviderCatalog?.();
});

describe("shared AgSDL authoring session", () => {
  it("keeps newer UI edits dirty when a prior snapshot finishes saving", async () => {
    const store = useAgsdlStore.getState();
    await store.load(target);
    store.replace(target, createExample("feature"));
    saveDelay = new Promise((resolve) => {
      releaseSave = resolve;
    });
    const saving = store.save(target);
    store.replace(target, createExample("hotfix"));
    releaseSave!();
    await saving;
    expect(plan.agsdl?.source).toBe(createExample("feature"));
    expect(current().source).toBe(createExample("hotfix"));
    expect(current().dirty).toBe(true);
    expect(current().persistedRevision).toBe(2);
    saveDelay = undefined;
    await store.save(target);
    expect(plan.agsdl?.source).toBe(createExample("hotfix"));
    expect(current().dirty).toBe(false);
    store.undo(target);
    expect(current().source).toBe(createExample("feature"));
    store.undo(target, true);
    expect(current().source).toBe(createExample("hotfix"));
  });

  it("retains the local draft on save failure", async () => {
    const store = useAgsdlStore.getState();
    await store.load(target);
    store.replace(target, createExample("feature"));
    failSave = true;
    await expect(store.save(target)).rejects.toThrow("Storage unavailable");
    expect(current().source).toBe(createExample("feature"));
    expect(current().dirty).toBe(true);
    expect(current().saving).toBe(false);
    expect(plan.agsdl?.source).toBe(createExample("release"));
  });

  it("shares agent edits with the panel and requires current revisions", async () => {
    const read = JSON.parse(await call("agsdl_get"));
    expect(read.source).toBe(current().source);
    expect(read.macro_models).toEqual([
      { providerId: 'provider-active', name: 'Active', models: [{ modelId: 'model-active', name: 'Available', edition: { identity: 'macro/native-model/p/cHJvdmlkZXItYWN0aXZl/m/bW9kZWwtYWN0aXZl', version: '1' } }] },
    ]);
    const result = JSON.parse(
      await call("agsdl_update", {
        expected_revision: read.revision,
        changes: [
          {
            op: "set",
            path: "/graphs/0/steps/0/success",
            value_json: '"unknown"',
          },
        ],
      }),
    );
    expect(result.revision).not.toBe(read.revision);
    expect(
      result.diagnostics.some(
        (report: { results: Array<{ verdict: string }> }) =>
          report.results.some((value) => value.verdict !== "pass"),
      ),
    ).toBe(true);
    expect(current().dirty).toBe(false);
    expect(plan.agsdl?.source).toBe(current().source);
    await expect(
      call("agsdl_update", { expected_revision: read.revision, source: "{}" }),
    ).rejects.toThrow("changed");
  });

  it("rejects another conversation, expired turns, locked plans", async () => {
    await expect(call("agsdl_get", {}, "other-conversation")).rejects.toThrow(
      "calling plan",
    );
    await expect(call("agsdl_get", {}, undefined, () => false)).rejects.toThrow(
      "ended",
    );
    const read = JSON.parse(await call("agsdl_get"));
    plan.status = "validated";
    await expect(
      call("agsdl_update", { expected_revision: read.revision, source: "{}" }),
    ).rejects.toThrow("draft");
  });

  it("initializes an empty document through an example and reads exact pointer values", async () => {
    delete plan.agsdl;
    const read = JSON.parse(await call("agsdl_get"));
    expect(read.error).toBeNull();
    expect(read.examples).toContain("release");
    const result = JSON.parse(
      await call("agsdl_update", {
        expected_revision: read.revision,
        example: "release",
      }),
    );
    expect(result.persisted_revision).toBe(1);
    expect(result.design_context).toMatchObject({ version: 1, kind: "system" });
    expect(result.display_context).toMatchObject({ title: "Release", cards: { "/agents/checklist": { title: "Checklist" }, "/flow/steps/checklist": { title: "Checklist" } } });
    expect((plan as ArchitectPlanRecord).agsdl?.display).toEqual(result.display_context);
    const subtree = JSON.parse(
      await call("agsdl_get", { path: "/flow/entry" }),
    );
    expect(JSON.parse(subtree.source)).toBe("checklist");
    await expect(
      call("agsdl_update", {
        expected_revision: result.revision,
        example: "hotfix",
      }),
    ).rejects.toThrow("empty");
  });
  it("blocks undo while saving and saves undo/redo with current persisted revisions", async () => {
    const store = useAgsdlStore.getState();
    await store.load(target);
    const initial = current().source;
    store.replace(target, createExample("feature"));
    saveDelay = new Promise(resolve => { releaseSave = resolve; });
    const saving = store.save(target);
    expect(() => store.undo(target)).toThrow("save");
    releaseSave!(); await saving; saveDelay = undefined;
    store.undo(target); await store.save(target);
    expect(plan.agsdl?.source).toBe(initial);
    expect(current().dirty).toBe(false);
    store.undo(target, true); await store.save(target);
    expect(plan.agsdl?.source).toBe(createExample("feature"));
    expect(current().persistedRevision).toBe(4);
  });

  it("ignores a validation result after the session is removed", async () => {
    const store = useAgsdlStore.getState();
    await store.load(target);
    const validating = store.validate(target);
    useAgsdlStore.setState({ sessions: {} });
    await expect(validating).resolves.toBeUndefined();
    expect(useAgsdlStore.getState().sessions).toEqual({});
  });

});


describe("edition-specific authoring", () => {
  it("uses a 0.2 guide for empty documents, preserves 0.1 meaning and rejects candidate editions", () => {
    expect(agsdlAuthoringGuide(undefined, true).contract).toBe("agsdl-0.2.0");
    expect(JSON.stringify(agsdlAuthoringGuide("agsdl-0.1.0"))).toContain("D declares root");
    const modern = JSON.stringify(agsdlAuthoringGuide("agsdl-0.2.0"));
    expect(modern).toContain("persistent Agent");
    expect(modern).toContain("not-assessed");
    expect(modern).not.toContain("D declares root");
    expect(modern).not.toContain("invoke/condition/approval/end");
    expect(modern).toContain("approval or compose");
    expect(modern).not.toContain("approval or block");
    expect(agsdlAuthoringGuide("agsdl-exp-flow-0.2-c1")).toMatchObject({ supported: false });
    expect(agsdlAuthoringGuide(undefined)).toMatchObject({ supported: false });
  });
  it("exposes real 0.2 bindings, conditional configuration and reader support scope", async () => {
    const requirement = { contract: { identity: "example/media", version: "1" } };
    const document = {
      contract: "agsdl-0.2.0", id: "conditional",
      agents: { helper: { configuration: { select: { path: ["resources", "mode", "value"] }, cases: { local: "project" } } } },
      configurations: { project: { engine: "desktop", requires: [requirement] } },
      bindings: { desktop: { contract: { identity: "macro/agent-engine", version: "1" }, implementation: { identity: "macro/desktop", version: "1" } } },
    };
    plan.agsdl = { source: JSON.stringify(document), annexes: { original: "unchanged archive" }, revision: 1 };
    const read = JSON.parse(await call("agsdl_get"));
    expect(read.authoring_guide.contract).toBe(document.contract);
    for (const [catalog, name] of [['agents', 'helper'], ['configurations', 'project'], ['bindings', 'desktop']] as const) {
      const entry = read.outline.entries.find((item: { path: string }) => item.path === `/${catalog}/${name}`);
      expect(entry).toMatchObject({ catalog, name });
      const exact = JSON.parse(await call('agsdl_get', { path: entry.path }));
      expect(JSON.parse(exact.source)).toEqual((document[catalog] as Record<string, unknown>)[name]);
      expect(exact.outline).toBeUndefined();
    }
    expect(read.outline.definitions).toBeUndefined();
    expect(read.annex_ids).toEqual(["original"]);
    expect(read.diagnostics[0].executionSupport).toBe("not-assessed");
    expect(JSON.parse(read.diagnostics[0].documentReportJson).executionSupport).toBe("not-assessed");
    const changed = JSON.parse(await call("agsdl_update", { expected_revision: read.revision, changes: [{ op: "set", path: "/configurations/project/settings", value_json: '{"providerId":"provider-active","modelId":"model-active","opaque":12345678901234567890}' }] }));
    expect(changed.source).toContain('"opaque":12345678901234567890');
    expect(JSON.parse(await call('agsdl_get', { path: '/configurations/project' })).source).toContain('"opaque":12345678901234567890');
    expect(plan.agsdl?.annexes).toEqual({ original: "unchanged archive" });
    expect(JSON.parse(changed.diagnostics[0].documentReportJson).executionSupport).toBe("not-assessed");
  });
});


it("edits 0.2 design intent in the versioned envelope and preserves source and other metadata", async () => {
  const source = '{"contract":"agsdl-0.2.0","id":"draft","agents":{},"configurations":{},"bindings":{}}';
  const design = { version: 1 as const, kind: "system" as const, purpose: "Original purpose", context: "", rules: [], requirements: [], future: { opaque: true } };
  plan.agsdl = { source, annexes: { archive: "original" }, revision: 1, design, display: { title: "System" }, migration: { version: 1, from: "agsdl-0.1.0", issues: [] } };
  const read = JSON.parse(await call("agsdl_get"));
  expect(read.design_context).toEqual(design);
  const next = { ...design, purpose: "New purpose" };
  const changed = JSON.parse(await call("agsdl_update", { expected_revision: read.revision, design_json: JSON.stringify(next) }));
  expect(changed.source).toBe(source);
  expect(changed.design_context).toEqual(next);
  expect(plan.agsdl).toMatchObject({ source, design: next, display: { title: "System" }, migration: { version: 1, from: "agsdl-0.1.0", issues: [] }, annexes: { archive: "original" } });
  expect(changed.revision).not.toBe(read.revision);
  await expect(call("agsdl_update", { expected_revision: read.revision, design_json: JSON.stringify(next) })).rejects.toThrow("changed");
  await expect(call("agsdl_update", { expected_revision: changed.revision, design_json: '{"version":1,"version":1}' })).rejects.toThrow("Duplicate");
  await expect(call("agsdl_update", { expected_revision: changed.revision, design_json: '{"version":2}' })).rejects.toThrow("malformed");
  expect(current().source).toBe(source);
});


it("keeps unsupported source and reports distinct without assigning 0.1 or 0.2 semantics", async () => {
  const source = '{"contract":"agsdl-exp-flow-0.2-c1","definitions":[],"agents":{}}';
  plan.agsdl = { source, annexes: {}, revision: 1 };
  const read = JSON.parse(await call("agsdl_get"));
  expect(read.source).toBe(source);
  expect(read.authoring_guide).toMatchObject({ supported: false, contract: "agsdl-exp-flow-0.2-c1" });
  expect(read.outline).toEqual({ supported: false, contract: "agsdl-exp-flow-0.2-c1" });
  expect(read.diagnostics[0]).toMatchObject({ scope: "unsupported-contract", executionSupport: "not-assessed" });
  expect(plan.agsdl.source).toBe(source);
});


it("patches 0.2 display labels and groups while preserving exact source, identities and unknown metadata", async () => {
  const source = '{"contract":"agsdl-0.2.0","id":"system","agents":{"helper":{"configuration":"project"}},"configurations":{"project":{"engine":"desktop","settings":{"opaque":12345678901234567890.123456789}}},"bindings":{"desktop":{"contract":{"identity":"macro/agent-engine","version":"1"},"implementation":{"identity":"macro/desktop","version":"1"}}},"flow":{"entry":"work","steps":{"work":{"type":"agent","agent":"helper"}}}}';
  const design = { version: 1 as const, kind: "system" as const, purpose: "Purpose", context: "", rules: [], requirements: [] };
  const display = { title: "Original", future: { opaque: true }, cards: { "/agents/helper": { title: "Helper", description: "Preserved", extension: ["future"] }, "/flow/steps/work": { title: "Work", macroTaskId: "task-owned" } } };
  plan.agsdl = { source, annexes: { archive: "original" }, revision: 1, design, display, migration: { version: 1, from: "agsdl-0.1.0", issues: [] } };
  const read = JSON.parse(await call("agsdl_get"));
  expect(read.display_context).toEqual(display);
  const update = { title: "Équipe", cards: { "/agents/helper": { title: "Vérification", macroGroup: "Contrôles" }, "/flow/steps/work": { macroGroup: "Contrôles" } } };
  const result = JSON.parse(await call("agsdl_update", { expected_revision: read.revision, display_json: JSON.stringify(update) }));
  const expected = { ...display, title: "Équipe", cards: { "/agents/helper": { ...display.cards["/agents/helper"], title: "Vérification", macroGroup: "Contrôles" }, "/flow/steps/work": { ...display.cards["/flow/steps/work"], macroGroup: "Contrôles" } } };
  expect(result.display_context).toEqual(expected);
  expect(result.source).toBe(source);
  expect(new TextEncoder().encode(plan.agsdl?.source)).toEqual(new TextEncoder().encode(source));
  expect(plan.agsdl).toMatchObject({ source, display: expected, design, annexes: { archive: "original" }, migration: { version: 1, from: "agsdl-0.1.0", issues: [] } });
  expect(result.revision).not.toBe(read.revision);
  expect(result.persisted_revision).toBe(2);
  const { projectViewer } = await import("../../services/agsdl/viewer");
  const viewer = projectViewer(source, plan.agsdl);
  expect(viewer.title).toBe("Équipe");
  expect(viewer.declarations.find(card => card.path === "/agents/helper")).toMatchObject({ title: "Vérification", details: { displayAnnotations: { macroGroup: "Contrôles" } } });
  await expect(call("agsdl_update", { expected_revision: read.revision, display_json: '{}' })).rejects.toThrow("changed");
  const cleared = JSON.parse(await call("agsdl_update", { expected_revision: result.revision, display_json: '{"cards":{"/agents/helper":{"macroGroup":""}}}' }));
  expect(cleared.display_context.cards["/agents/helper"].macroGroup).toBe("");
  expect(cleared.display_context.cards["/flow/steps/work"]).toEqual(expected.cards["/flow/steps/work"]);
  expect(cleared.source).toBe(source);
});

it("rejects invalid display shapes, missing paths and combined mutations without changing the session", async () => {
  plan.agsdl = { source: '{"contract":"agsdl-0.2.0","id":"draft","agents":{},"configurations":{},"bindings":{}}', annexes: {}, revision: 1, display: { title: "Original" } };
  const read = JSON.parse(await call("agsdl_get"));
  for (const display_json of ['null', '[]', '{"title":42}', '{"cards":[]}', '{"cards":{"/agents":null}}', '{"cards":{"/agents":{"macroGroup":false}}}', '{"cards":{"/missing":{"title":"Missing"}}}', '{"cards":{"/agents~2":{"title":"Invalid"}}}', '{"title":"A","title":"B"}']) {
    await expect(call("agsdl_update", { expected_revision: read.revision, display_json })).rejects.toThrow();
    expect(current().version).toBe(read.revision);
    expect(current().source).toBe(read.source);
    expect(current().display).toEqual({ title: "Original" });
  }
  await expect(call("agsdl_update", { expected_revision: read.revision, source: read.source, display_json: '{}' })).rejects.toThrow("exactly one");
  expect(plan.agsdl.display).toEqual({ title: "Original" });
});

it("limits display_json to 0.2 documents and preserves legacy and unsupported editions", async () => {
  for (const source of [createExample("release"), '{"contract":"agsdl-exp-flow-0.2-c1"}']) {
    useAgsdlStore.setState({ sessions: {} });
    plan.agsdl = { source, annexes: {}, revision: 1 };
    const read = JSON.parse(await call("agsdl_get"));
    expect(read.display_context).toBeUndefined();
    await expect(call("agsdl_update", { expected_revision: read.revision, display_json: '{"title":"New"}' })).rejects.toThrow("requires AgSDL 0.2.0");
    expect(plan.agsdl.source).toBe(source);
    expect(current().version).toBe(read.revision);
  }
});

it("discovers every pointer across UTF-8 bounded pages before the real transport spill limit", async () => {
  const agents = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`agent-${index}`, { configuration: `config-${index}`, skills: [`skill-${index}`], prompt: [{ value: '🔎'.repeat(500) }] }]));
  const configurations = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`config-${index}`, { engine: `binding-${index}` }]));
  const bindings = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`binding-${index}`, { contract: { identity: 'macro/agent-engine', version: '1' }, implementation: { identity: 'macro/desktop', version: '1' } }]));
  const skills = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`skill-${index}`, { prompt: [{ value: 'Guidance' }] }]));
  const steps = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`step-${index}`, { type: 'agent', agent: `agent-${index}`, next: index === 129 ? [] : [`step-${index + 1}`] }]));
  const source = JSON.stringify({ contract: 'agsdl-0.2.0', id: 'large', agents, configurations, bindings, skills, flow: { entry: 'step-0', steps } })
    .replace('"engine":"binding-0"', '"engine":"binding-0","requires":[{"contract":{"identity":"synthetic/budget","version":"1"},"parameters":{"limit":9007199254740993123456789}}]');
  plan.agsdl = { source, annexes: {}, revision: 1 };
  expect(new TextEncoder().encode(plan.agsdl.source).byteLength).toBeGreaterThan(TOOL_OUTPUT_LIMITS.toolResult.spillThresholdBytes);
  const spill = mock(async () => 'SPILLED');
  const transportedRead = async (args: Record<string, unknown> = {}) => {
    const raw = await call('agsdl_get', args);
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(AGSDL_TOOL_RESPONSE_BYTES);
    const transported = await preserveToolResultContent('agsdl_get', raw, spill);
    expect(transported).toBe(raw);
    return JSON.parse(String(transported));
  };
  const root = await transportedRead();
  expect(root.source).toBeUndefined();
  expect(root.source_omitted.section).toBe('source');
  expect(root.source_omitted.total_bytes).toBe(new TextEncoder().encode(source).byteLength);
  expect(root.diagnostics[0].results[0].verdict).toBe('pass');
  expect(root.outline.total).toBe(650);
  const entries = [...root.outline.entries];
  let next = root.outline.next_offset;
  while (next !== null) {
    const page = await transportedRead({ section: 'outline', offset: next, expected_revision: root.revision });
    expect(page.outline.offset).toBe(next);
    expect(page.outline.total).toBe(650);
    expect(page.outline.returned).toBeGreaterThan(0);
    entries.push(...page.outline.entries); next = page.outline.next_offset;
  }
  expect(entries).toHaveLength(650);
  expect(new Set(entries.map(entry => entry.path)).size).toBe(650);
  for (const [catalog, declarations] of Object.entries({ agents, configurations, bindings, skills, steps })) {
    const prefix = catalog === 'steps' ? '/flow/steps' : `/${catalog}`;
    expect(entries.filter(entry => entry.catalog === catalog).map(entry => entry.path)).toEqual(Object.keys(declarations).map(name => `${prefix}/${name}`));
    const [name, value] = Object.entries(declarations).at(-1)!;
    const exact = await transportedRead({ path: `${prefix}/${name}`, expected_revision: root.revision });
    expect(JSON.parse(exact.source)).toEqual(value);
    expect(exact.outline).toBeUndefined();
    expect(exact.authoring_guide).toBeUndefined();
  }
  const filtered = await transportedRead({ section: 'outline', path: '/agents', offset: 100, limit: 200, expected_revision: root.revision });
  expect(filtered.outline.total).toBe(130);
  expect(filtered.outline.entries[0].path).toBe('/agents/agent-100');
  const originalReport = current().reports[0].documentReportJson as string;
  expect(new TextEncoder().encode(originalReport).byteLength).toBeGreaterThan(TOOL_OUTPUT_LIMITS.toolResult.spillThresholdBytes);
  let report = '', offset = 0;
  do {
    const page = await transportedRead({ section: 'report', report_index: 0, offset, expected_revision: root.revision });
    report += page.text_page.content;
    offset = page.text_page.next_offset;
  } while (offset !== null);
  expect(report).toBe(originalReport);
  expect(report).toContain('9007199254740993123456789');
  expect(JSON.parse(report).valid).toBe(true);
  expect(spill).not.toHaveBeenCalled();
});

it('recovers oversized names and literal source without splitting UTF-8 or losing exact tokens', async () => {
  const name = `agent${'x'.repeat(20_000)}`;
  const unicodeName = `agent${'é🔎'.repeat(4_000)}`;
  const literal = '\u0000🔎é'.repeat(8_000);
  const source = JSON.stringify({ contract: 'agsdl-0.2.0', id: 'large', agents: { [name]: { configuration: 'project', prompt: [{ value: literal }] }, [unicodeName]: { configuration: 'project' } }, configurations: { project: { engine: 'desktop' } }, bindings: { desktop: { contract: { identity: 'macro/agent-engine', version: '1' }, implementation: { identity: 'macro/desktop', version: '1' } } } });
  plan.agsdl = { source, annexes: {}, revision: 1, design: { version: 1, kind: 'system', purpose: literal, context: '', rules: [], requirements: [] } };
  const root = JSON.parse(await call('agsdl_get'));
  expect(root.outline.entries[0].entry_omitted.section).toBe('outline_entry');
  expect(root.design_context_omitted.section).toBe('design');
  const readText = async (args: Record<string, unknown>) => {
    let text = '', offset = 0;
    do {
      const raw = await call('agsdl_get', { ...args, offset, expected_revision: root.revision });
      expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(AGSDL_TOOL_RESPONSE_BYTES);
      const page = JSON.parse(raw).text_page;
      expect(page.offset).toBe(offset);
      expect(page.returned_bytes).toBe(new TextEncoder().encode(page.content).byteLength);
      text += page.content; offset = page.next_offset;
    } while (offset !== null);
    return text;
  };
  const entry = JSON.parse(await readText({ section: 'outline_entry', entry_index: 0 }));
  expect(entry).toMatchObject({ name, path: `/agents/${name}` });
  const unicodeEntry = JSON.parse(await readText({ section: 'outline_entry', entry_index: 1 }));
  expect(unicodeEntry).toMatchObject({ name: unicodeName, path: `/agents/${unicodeName}` });
  const individual = JSON.parse(await call('agsdl_get', { path: unicodeEntry.path }));
  expect(individual.path_omitted).toBe(true);
  expect(individual.outline).toBeUndefined();
  expect(JSON.parse(individual.source)).toEqual({ configuration: 'project' });
  expect(await readText({ section: 'source' })).toBe(source);
  const exactLiteral = await readText({ section: 'source', path: `${entry.path}/prompt/0/value` });
  expect(JSON.parse(exactLiteral)).toBe(literal);
  expect(JSON.parse(await readText({ section: 'design' })).purpose).toBe(literal);
  await expect(call('agsdl_get', { section: 'source', offset: 1 })).rejects.toThrow('expected_revision');
  await expect(call('agsdl_get', { section: 'outline', offset: 1, expected_revision: 'stale' })).rejects.toThrow('changed');
  for (const args of [{ section: 'missing' }, { section: 'outline', offset: -1 }, { section: 'outline', limit: 0 }, { section: 'source', limit: 1.5 }, { section: 'report', report_index: 99 }]) {
    await expect(call('agsdl_get', args)).rejects.toThrow();
  }
});

it('saves adapted configuration metadata and invalidates only its support claims', async () => {
  const requirement = { contract: { identity: 'example/region-support', version: '1' } };
  const claims = [{ requirement, status: 'supported', evidence: 'a'.repeat(64) }];
  const doc = { contract: 'agsdl-0.2.0', id: 'adapted', agents: { helper: { configuration: 'project' } },
    configurations: { project: { engine: 'desktop', settings: { region: 'old' }, requires: [requirement], claims } },
    bindings: { desktop: { contract: { identity: 'macro/agent-engine', version: '1' }, implementation: { identity: 'macro/desktop', version: '1' }, claims } },
  };
  const design = { version: 1 as const, kind: 'system' as const, purpose: '', context: '', rules: [], requirements: [{ id: 'region', label: 'Region', description: '', value: 'old', targetPath: '/configurations/project/settings/region' }] };
  plan.agsdl = { source: JSON.stringify(doc), annexes: {}, revision: 1, design };
  const before = JSON.parse(await call('agsdl_get'));
  expect(JSON.parse(before.diagnostics[0].documentReportJson).support.find((item: { path: string }) => item.path === '/agents/helper').status).toBe('declared-supported');
  const after = JSON.parse(await call('agsdl_update', { expected_revision: before.revision, design_json: JSON.stringify({ ...design, requirements: [{ ...design.requirements[0], value: 'new' }] }) }));
  expect(JSON.parse(plan.agsdl.source).configurations.project.settings.region).toBe('new');
  expect(JSON.parse(plan.agsdl.source).configurations.project.claims).toBeUndefined();
  expect(JSON.parse(plan.agsdl.source).bindings.desktop.claims).toEqual(claims);
  expect(JSON.parse(after.diagnostics[0].documentReportJson).support.find((item: { path: string }) => item.path === '/agents/helper').status).toBe('unknown');
  expect(after.design_context.requirements[0].value).toBe('new');
  useAgsdlStore.getState().undo(target);
  expect(current().source).toBe(before.source);
  expect(current().design!.requirements[0].value).toBe('old');
});


it('keeps small legacy and modern catalog keys and pages composition paths independently', async () => {
  const legacy = JSON.parse(await call('agsdl_get'));
  expect(legacy.outline.definitions[0]).toMatchObject({ path: '/definitions/0', key: JSON.parse(legacy.source).definitions[0].key });
  expect(legacy.outline.graphs[0].definition).toEqual(JSON.parse(legacy.source).graphs[0].definition);
  const source = JSON.stringify({ contract: 'agsdl-0.2.0', id: 'composed', agents: {}, configurations: {}, bindings: {},
    compositions: { audit: { entry: 'first', outputs: ['done'], steps: {
      first: { type: 'prepare', message: { prompt: [{ value: 'First' }] }, next: ['last'] },
      last: { type: 'prepare', message: { prompt: [{ value: 'Last' }] }, next: [{ output: 'done' }] },
    } }, sibling: { entry: 'other', outputs: ['done'], steps: { other: { type: 'prepare', next: [{ output: 'done' }] } } } } });
  useAgsdlStore.setState({ sessions: {} });
  plan.agsdl = { source, annexes: {}, revision: 1 };
  const modern = JSON.parse(await call('agsdl_get'));
  for (const catalog of ['agents', 'configurations', 'bindings', 'content', 'skills', 'compositions']) expect(Array.isArray(modern.outline[catalog])).toBe(true);
  expect(modern.outline.compositions.map((entry: { name: string }) => entry.name)).toEqual(['audit', 'sibling']);
  const first = JSON.parse(await call('agsdl_get', { section: 'outline', path: '/compositions/audit/steps', limit: 1 }));
  expect(first.outline.total).toBe(2);
  expect(first.outline.entries.map((entry: { path: string }) => entry.path)).toEqual(['/compositions/audit/steps/first']);
  const last = JSON.parse(await call('agsdl_get', { section: 'outline', path: first.path, offset: first.outline.next_offset, expected_revision: first.revision }));
  expect(last.outline.entries.map((entry: { path: string }) => entry.path)).toEqual(['/compositions/audit/steps/last']);
  expect(last.outline.next_offset).toBeNull();
  const exact = JSON.parse(await call('agsdl_get', { path: last.outline.entries[0].path, expected_revision: last.revision }));
  expect(JSON.parse(exact.source).message.prompt[0].value).toBe('Last');
  expect(exact.outline).toBeUndefined();
});

it('bounds imported unknown-edition guides without changing their source marker', async () => {
  const contract = 'agsdl-unknown-' + '🔎'.repeat(20_000);
  const source = JSON.stringify({ contract, opaque: 'preserved' });
  plan.agsdl = { source, annexes: {}, revision: 1 };
  const raw = await call('agsdl_get'), root = JSON.parse(raw);
  expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(AGSDL_TOOL_RESPONSE_BYTES);
  expect(root.authoring_guide).toMatchObject({ supported: false, contract: null, contract_omitted: true });
  expect(root.outline.supported).toBe(false);
  let recovered = '', offset = 0;
  do {
    const raw = await call('agsdl_get', { section: 'source', offset, expected_revision: root.revision });
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(AGSDL_TOOL_RESPONSE_BYTES);
    const page = JSON.parse(raw).text_page;
    recovered += page.content; offset = page.next_offset;
  } while (offset !== null);
  expect(recovered).toBe(source);
  expect(plan.agsdl.source).toBe(source);
});

it('rejects a read when revision or turn authority changes during asynchronous validation', async () => {
  for (const change of ['revision', 'turn']) {
    useAgsdlStore.setState({ sessions: {} });
    await useAgsdlStore.getState().load(target);
    const revision = current().version;
    const entered = createDeferred<void>(), resume = createDeferred<void>();
    let active = true;
    const validation = spyOn(useAgsdlStore.getState(), 'validate').mockImplementationOnce(async () => {
      entered.resolve(); await resume.promise;
    });
    try {
      const reading = call('agsdl_get', { section: 'source', expected_revision: revision }, undefined, () => active);
      await entered.promise;
      if (change === 'revision') useAgsdlStore.getState().replace(target, '{}', undefined, revision);
      else active = false;
      resume.resolve();
      await expect(reading).rejects.toThrow(change === 'revision' ? 'changed during validation' : 'turn has ended');
    } finally { resume.resolve(); validation.mockRestore(); }
  }
});


it('binds provider-catalog text cursors to their contents even when the document revision is unchanged', async () => {
  const original = modelsByProvider['provider-active'];
  try {
    modelsByProvider['provider-active'] = Array.from({ length: 1000 }, (_, index) => ({ id: `model-${index}`, name: 'Long model name '.repeat(20), provider_id: 'provider-active' }));
    const root = JSON.parse(await call('agsdl_get'));
    expect(root.macro_models_omitted.section).toBe('models');
    const first = JSON.parse(await call('agsdl_get', { section: 'models', expected_revision: root.revision }));
    expect(first.text_page.next_cursor).toBeString();
    const next = JSON.parse(await call('agsdl_get', { section: 'models', cursor: first.text_page.next_cursor, expected_revision: root.revision }));
    expect(next.text_page.offset).toBe(first.text_page.next_offset);
    await expect(call('agsdl_get', { section: 'models', offset: first.text_page.next_offset, expected_revision: root.revision })).rejects.toThrow('cursor');
    modelsByProvider['provider-active'] = [...modelsByProvider['provider-active'], { id: 'new-model', name: 'Added during read', provider_id: 'provider-active' }];
    await expect(call('agsdl_get', { section: 'models', cursor: first.text_page.next_cursor, expected_revision: root.revision })).rejects.toThrow('does not belong');
    expect(current().version).toBe(root.revision);
  } finally { modelsByProvider['provider-active'] = original; }
});


it('reconstructs exact AgSDL source when U+FEFF starts a UTF-8 page', async () => {
  const value = 'a'.repeat(16383) + '\uFEFF' + 'b'.repeat(60000);
  const source = JSON.stringify({ contract: 'agsdl-0.2.0', id: 'bom', agents: {}, configurations: {}, bindings: {}, content: { value: { value } } });
  plan.agsdl = { source, annexes: {}, revision: 1 };
  const root = JSON.parse(await call('agsdl_get'));
  let recovered = '', offset = 0, cursor: string | undefined;
  let sawBoundary = false;
  do {
    const raw = await call('agsdl_get', { section: 'source', path: '/content/value/value', expected_revision: root.revision, ...(cursor ? { cursor } : {}) });
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(AGSDL_TOOL_RESPONSE_BYTES);
    const page = JSON.parse(raw).text_page;
    expect(page.offset).toBe(offset);
    expect(page.total_bytes).toBe(new TextEncoder().encode(JSON.stringify(value)).byteLength);
    expect(page.returned_bytes).toBe(new TextEncoder().encode(page.content).byteLength);
    if (offset === 16384) {
      expect(page.content).toStartWith('\uFEFF'); sawBoundary = true;
    }
    recovered += page.content; offset = page.next_offset; cursor = page.next_cursor;
  } while (offset !== null);
  expect(sawBoundary).toBe(true);
  expect(recovered).toBe(JSON.stringify(value));
  expect(JSON.parse(recovered)).toBe(value);
  expect(current().version).toBe(root.revision);
  expect(plan.agsdl.source).toBe(source);
});


it('provides the current contract guide through bounded revision-safe text pages after a source-only read', async () => {
  const { createExampleDocument } = await import('../../services/agsdl/examples');
  plan.agsdl = { ...createExampleDocument('feature'), revision: 1 };
  const sourceRead = JSON.parse(await call('agsdl_get', { section: 'source' }));
  expect(sourceRead.authoring_guide).toBeUndefined();
  let content = '', offset = 0;
  do {
    const raw = await call('agsdl_get', { section: 'guide', limit: 1024, offset, expected_revision: sourceRead.revision });
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(AGSDL_TOOL_RESPONSE_BYTES);
    const page = JSON.parse(raw);
    expect(page.revision).toBe(sourceRead.revision);
    content += page.text_page.content;
    offset = page.text_page.next_offset;
  } while (offset !== null);
  const guide = JSON.parse(content);
  expect(guide.contract).toBe('agsdl-0.2.0');
  expect(guide.flow_shapes).toContain('maxVisits');
  expect(guide.runtime).toContain('macro/agent-engine');
  expect(guide.runtime).toContain('configuration.model');
  expect(guide.runtime).toContain('native Preflight');
  await expect(call('agsdl_get', { section: 'guide', offset: 1, expected_revision: 'stale' })).rejects.toThrow('changed');
});
