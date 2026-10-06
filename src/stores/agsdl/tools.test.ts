import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ArchitectPlanRecord } from "../../services/architectPlanService";
import type { AgsdlEditorDocument } from "../../types/agsdl";
import type { AIModel, AIProvider } from "../../types";
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
const { handleAgsdlToolCall, agsdlAuthoringGuide } = await import("./tools");
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
      { providerId: 'provider-active', name: 'Active', models: [{ modelId: 'model-active', name: 'Available' }] },
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
    expect(JSON.parse(read.outline.agents[0].declaration_json)).toEqual(document.agents.helper);
    expect(JSON.parse(read.outline.configurations[0].declaration_json)).toEqual(document.configurations.project);
    expect(JSON.parse(read.outline.bindings[0].declaration_json)).toEqual(document.bindings.desktop);
    expect(read.outline.definitions).toBeUndefined();
    expect(read.annex_ids).toEqual(["original"]);
    expect(read.diagnostics[0].executionSupport).toBe("not-assessed");
    expect(JSON.parse(read.diagnostics[0].documentReportJson).executionSupport).toBe("not-assessed");
    const changed = JSON.parse(await call("agsdl_update", { expected_revision: read.revision, changes: [{ op: "set", path: "/configurations/project/settings", value_json: '{"providerId":"provider-active","modelId":"model-active","opaque":12345678901234567890}' }] }));
    expect(changed.source).toContain('"opaque":12345678901234567890');
    expect(changed.outline.configurations[0].declaration_json).toContain('"opaque":12345678901234567890');
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
