import { afterEach,beforeEach,describe,expect,it,mock,spyOn } from "bun:test";
import { createLegacyExample as createExample } from "../../services/agsdl/examples";
import type { ArchitectPlanRecord } from "../../services/architectPlanService";
import { preserveToolResultContent } from '../../services/toolResultArtifacts';
import { TOOL_OUTPUT_LIMITS } from '../../shared/toolOutputLimits';
import { createDeferred } from "../../test-utils/deferred";
import type { AIModel,AIProvider } from "../../types";
import type { AgsdlEditorDocument } from "../../types/agsdl";

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
const { handleAgsdlToolCall, AgsdlAuthoringRefusal, agsdlAuthoringGuide, AGSDL_TOOL_RESPONSE_BYTES } = await import("./tools");
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

const retiredSource = '{"contract":"agsdl-0.2.0","id":"retired","agents":{},"content":{"exact":{"value":9007199254740993}}}';
it.each([
  retiredSource.replace('"retired"', '"edited"'),
  '{"contract":"agsdl-0.3.0","id":"replacement","agents":{}}',
])('refuses full-source edits of a retired document without changing its session or persistence', async source => {
  plan.agsdl = { source: retiredSource, annexes: {}, revision: 1 };
  const read = JSON.parse(await call('agsdl_get'));
  const before = structuredClone(current());
  await expect(call('agsdl_update', { expected_revision: read.revision, source })).rejects.toThrow('AgSDL 0.2 is no longer supported');
  expect(current()).toEqual(before);
  expect(plan.agsdl).toEqual({ source: retiredSource, annexes: {}, revision: 1 });
});

it('refuses replacing a supported source with edition 0.2 before editing or saving', async () => {
  const read = JSON.parse(await call('agsdl_get'));
  const before = structuredClone(current());
  const persisted = structuredClone(plan.agsdl);
  await expect(call('agsdl_update', { expected_revision: read.revision, source: retiredSource })).rejects.toThrow('AgSDL 0.2 is no longer supported');
  expect(current()).toEqual(before);
  expect(plan.agsdl).toEqual(persisted);
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

  it("refuses to load or edit a software plan without an AgSDL document", async () => {
    delete plan.agsdl;
    const original = structuredClone(plan);
    await expect(call("agsdl_get")).rejects.toBeInstanceOf(AgsdlAuthoringRefusal);
    await expect(call("agsdl_update", { example: "release", expected_revision: "old" })).rejects.toBeInstanceOf(AgsdlAuthoringRefusal);
    await expect(useAgsdlStore.getState().load(target)).rejects.toThrow("unavailable");
    expect(plan).toEqual(original);
    expect(current()).toBeUndefined();
  });

  it("initializes an empty document through an example and reads exact pointer values", async () => {
    plan.agsdl = { source: '', annexes: {}, revision: 1 };
    const read = JSON.parse(await call("agsdl_get"));
    expect(read.error).toBeNull();
    expect(read.examples).toContain("release");
    const result = JSON.parse(
      await call("agsdl_update", {
        expected_revision: read.revision,
        example: "release",
      }),
    );
    expect(result.persisted_revision).toBe(2);
    useAgsdlStore.setState({ sessions: {} });
    expect(result.design_context).toMatchObject({ version: 1, kind: "system" });
    expect(result.display_context).toMatchObject({ title: "Release", cards: { "/agents/implement": { title: "Release evidence" }, "/flow/steps/implement": { title: "Complete the mission" } } });
    expect((plan as ArchitectPlanRecord).agsdl?.display).toEqual(result.display_context);
    const subtree = JSON.parse(
      await call("agsdl_get", { path: "/flow/entry" }),
    );
    expect(JSON.parse(subtree.source)).toBe("implement");
    await expect(
      call("agsdl_update", {
        expected_revision: subtree.revision,
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
  it("uses the 0.4 guide for empty documents, preserves 0.1 meaning and rejects candidate editions", () => {
    expect(agsdlAuthoringGuide(undefined, true).contract).toBe("agsdl-0.4.0");
    expect(JSON.stringify(agsdlAuthoringGuide("agsdl-0.1.0"))).toContain("D declares root");
    expect(agsdlAuthoringGuide("agsdl-0.2.0")).toMatchObject({ supported: false });
    expect(agsdlAuthoringGuide("agsdl-exp-flow-0.2-c1")).toMatchObject({ supported: false });
    expect(agsdlAuthoringGuide(undefined)).toMatchObject({ supported: false });
  });
});

it("rejects invalid display shapes, missing paths and combined mutations without changing the session", async () => {
  plan.agsdl = { source: '{"contract":"agsdl-0.3.0","id":"draft","agents":{}}', annexes: {}, revision: 1, display: { title: "Original" } };
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

it("discovers every pointer across UTF-8 bounded pages before the real transport spill limit", async () => {
  const agents = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`agent-${index}`, { harness: 'codex', permissions: 'read-only', model: { name: `model-${index}` }, skills: [`skill-${index}`], resources: { evidence: { value: 'Synthetic' } }, planFirst: 'auto', instructions: [{ value: '🔎'.repeat(500) }] }]));
  const content = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`text-${index}`, { value: 'Guidance' }]));
  const mcpServers = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`server-${index}`, { command: ['synthetic'] }]));
  const skills = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`skill-${index}`, { uri: 'file:///synthetic/guidance.md' }]));
  const steps = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`step-${index}`, { type: 'agent', agent: `agent-${index}`, next: index === 199 ? [] : [`step-${index + 1}`] }]));
  const source = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'large', agents, content, mcpServers, skills, flow: { entry: 'step-0', steps } })
    .replace('"value":"Guidance"', '"value":9007199254740993123456789');
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
  expect(root.error).toBeNull();
  expect(root.diagnostics_omitted).toMatchObject({ section: 'report', report_count: 1 });
  expect(root.outline.total).toBe(1000);
  const entries = [...root.outline.entries];
  let next = root.outline.next_offset;
  while (next !== null) {
    const page = await transportedRead({ section: 'outline', offset: next, expected_revision: root.revision });
    expect(page.outline.offset).toBe(next);
    expect(page.outline.total).toBe(1000);
    expect(page.outline.returned).toBeGreaterThan(0);
    entries.push(...page.outline.entries); next = page.outline.next_offset;
  }
  expect(entries).toHaveLength(1000);
  expect(new Set(entries.map(entry => entry.path)).size).toBe(1000);
  for (const [catalog, declarations] of Object.entries({ agents, content, mcpServers, skills, steps })) {
    const prefix = catalog === 'steps' ? '/flow/steps' : `/${catalog}`;
    expect(entries.filter(entry => entry.catalog === catalog).map(entry => entry.path)).toEqual(Object.keys(declarations).map(name => `${prefix}/${name}`));
    const [name, value] = Object.entries(declarations).at(-1)!;
    const exact = await transportedRead({ path: `${prefix}/${name}`, expected_revision: root.revision });
    expect(JSON.parse(exact.source)).toEqual(value);
    expect(exact.outline).toBeUndefined();
    expect(exact.authoring_guide).toBeUndefined();
  }
  const filtered = await transportedRead({ section: 'outline', path: '/agents', offset: 100, limit: 200, expected_revision: root.revision });
  expect(filtered.outline.total).toBe(200);
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
  const number = await transportedRead({ path: '/content/text-0/value', expected_revision: root.revision });
  expect(number.source).toBe('9007199254740993123456789');
  expect(JSON.parse(report).valid).toBe(true);
  expect(spill).not.toHaveBeenCalled();
});

it('recovers oversized names and literal source without splitting UTF-8 or losing exact tokens', async () => {
  const name = `agent${'x'.repeat(20_000)}`;
  const unicodeName = `agent${'é🔎'.repeat(4_000)}`;
  const literal = '\u0000🔎é'.repeat(8_000);
  const source = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'large', agents: { [name]: { harness: 'codex', instructions: [{ value: literal }] }, [unicodeName]: { harness: 'codex' } } });
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
  expect(JSON.parse(individual.source)).toEqual({ harness: 'codex' });
  expect(await readText({ section: 'source' })).toBe(source);
  const exactLiteral = await readText({ section: 'source', path: `${entry.path}/instructions/0/value` });
  expect(JSON.parse(exactLiteral)).toBe(literal);
  expect(JSON.parse(await readText({ section: 'design' })).purpose).toBe(literal);
  await expect(call('agsdl_get', { section: 'source', offset: 1 })).rejects.toThrow('expected_revision');
  await expect(call('agsdl_get', { section: 'outline', offset: 1, expected_revision: 'stale' })).rejects.toThrow('changed');
  for (const args of [{ section: 'missing' }, { section: 'outline', offset: -1 }, { section: 'outline', limit: 0 }, { section: 'source', limit: 1.5 }, { section: 'report', report_index: 99 }]) {
    await expect(call('agsdl_get', args)).rejects.toBeInstanceOf(AgsdlAuthoringRefusal);
  }
});


it('keeps small legacy and modern catalog keys and pages composition paths independently', async () => {
  const legacy = JSON.parse(await call('agsdl_get'));
  expect(legacy.outline.definitions[0]).toMatchObject({ path: '/definitions/0', key: JSON.parse(legacy.source).definitions[0].key });
  expect(legacy.outline.graphs[0].definition).toEqual(JSON.parse(legacy.source).graphs[0].definition);
  const source = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'composed', agents: { a: { harness: 'codex' } },
    compositions: { audit: { entry: 'first', outputs: ['done'], steps: {
      first: { type: 'agent', agent: 'a', message: { data: { value: 'First' } }, next: ['last'] },
      last: { type: 'agent', agent: 'a', message: { data: { value: 'Last' } }, next: [{ output: 'done' }] },
    } }, sibling: { entry: 'other', outputs: ['done'], steps: { other: { type: 'agent', agent: 'a', next: [{ output: 'done' }] } } } } });
  useAgsdlStore.setState({ sessions: {} });
  plan.agsdl = { source, annexes: {}, revision: 1 };
  const modern = JSON.parse(await call('agsdl_get'));
  for (const catalog of ['agents', 'mcpServers', 'content', 'skills', 'compositions']) expect(Array.isArray(modern.outline[catalog])).toBe(true);
  expect(modern.outline.compositions.map((entry: { name: string }) => entry.name)).toEqual(['audit', 'sibling']);
  const first = JSON.parse(await call('agsdl_get', { section: 'outline', path: '/compositions/audit/steps', limit: 1 }));
  expect(first.outline.total).toBe(2);
  expect(first.outline.entries.map((entry: { path: string }) => entry.path)).toEqual(['/compositions/audit/steps/first']);
  const last = JSON.parse(await call('agsdl_get', { section: 'outline', path: first.path, offset: first.outline.next_offset, expected_revision: first.revision }));
  expect(last.outline.entries.map((entry: { path: string }) => entry.path)).toEqual(['/compositions/audit/steps/last']);
  expect(last.outline.next_offset).toBeNull();
  const exact = JSON.parse(await call('agsdl_get', { path: last.outline.entries[0].path, expected_revision: last.revision }));
  expect(JSON.parse(exact.source).message.data.value).toBe('Last');
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
  plan.agsdl = { ...createExampleDocument('feature', 'agsdl-0.3.0'), revision: 1 };
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
  expect(guide).toEqual(agsdlAuthoringGuide('agsdl-0.3.0'));
  await expect(call('agsdl_get', { section: 'guide', offset: 1, expected_revision: 'stale' })).rejects.toThrow('changed');
});


it('refuses a stale read without saving, and allows a fresh read', async () => {
  const read = JSON.parse(await call('agsdl_get'));
  const source = current().source;
  const persistedRevision = current().persistedRevision;
  await expect(call('agsdl_get', { expected_revision: 'stale' })).rejects.toBeInstanceOf(AgsdlAuthoringRefusal);
  expect(current().source).toBe(source);
  expect(current().persistedRevision).toBe(persistedRevision);
  expect(JSON.parse(await call('agsdl_get', { expected_revision: read.revision })).revision).toBe(read.revision);
});


it('keeps an update response failure uncertain after its source was saved', async () => {
  const read = JSON.parse(await call('agsdl_get'));
  const source = createExample('feature');
  const result = await call('agsdl_update', { expected_revision: read.revision, source, section: 'missing' }).catch(error => error);
  expect(result).toBeInstanceOf(Error);
  expect(result).not.toBeInstanceOf(AgsdlAuthoringRefusal);
  expect(result.message).toContain('Unknown AgSDL read section');
  expect(plan.agsdl?.source).toBe(source);
  expect(current().dirty).toBe(false);
});


it('refuses conflicting update alternatives before mutating or saving the source', async () => {
  const read = JSON.parse(await call('agsdl_get'));
  const before = current().source;
  const revision = current().persistedRevision;
  await expect(call('agsdl_update', { expected_revision: read.revision, source: '{}', example: 'feature' })).rejects.toBeInstanceOf(AgsdlAuthoringRefusal);
  expect(current().source).toBe(before);
  expect(current().dirty).toBe(false);
  expect(current().persistedRevision).toBe(revision);
  expect(plan.agsdl?.source).toBe(before);
});

it('discovers all 0.3 catalogues, composition parameters and steps across bounded pages', async () => {
  const { authoringPatterns030 } = await import('../../services/agsdl/examples030');
  const doc = authoringPatterns030().composition;
  doc.mcpServers = { docs: { url: 'https://docs.example.test/mcp' } };
  doc.skills = { review: { uri: 'skills/review/SKILL.md' } };
  doc.content = { guidance: { value: '🔎'.repeat(18000) } };
  plan.agsdl = { source: JSON.stringify(doc), annexes: { archive: 'unchanged' }, revision: 1 };
  const read = JSON.parse(await call('agsdl_get', { section: 'outline', limit: 2 }));
  const entries = [...read.outline.entries]; let next = read.outline.next_offset;
  while (next !== null) {
    const page = JSON.parse(await call('agsdl_get', { section: 'outline', limit: 2, offset: next, expected_revision: read.revision }));
    entries.push(...page.outline.entries); next = page.outline.next_offset;
  }
  expect(entries.map(entry => entry.path)).toContain('/mcpServers/docs');
  expect(entries.map(entry => entry.path)).toContain('/compositions/review/parameters/0');
  expect(entries.map(entry => entry.path)).toContain('/compositions/review/steps/inspect');
  expect(entries.some(entry => ['configurations', 'bindings'].includes(entry.catalog))).toBe(false);
  let recovered = '', cursor: string | undefined;
  do {
    const raw = await call('agsdl_get', { section: 'source', path: '/content/guidance/value', expected_revision: read.revision, ...(cursor ? { cursor } : {}) });
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(AGSDL_TOOL_RESPONSE_BYTES);
    const page = JSON.parse(raw).text_page; recovered += page.content; cursor = page.next_cursor ?? undefined;
  } while (cursor);
  expect(recovered).toBe(JSON.stringify('🔎'.repeat(18000)));
  expect(plan.agsdl.annexes).toEqual({ archive: 'unchanged' });
});

it('pages the complete 0.4 guide and keeps empty defaults independent of Chat providers', async () => {
  plan.agsdl = { source: '', annexes: {}, revision: 1 };
  const read = JSON.parse(await call('agsdl_get'));
  expect(read.macro_models).toBeUndefined();
  expect(read.harness_catalogue).toMatchObject({ contract: 'agsdl-0.4.0', assessment: 'not-assessed', harnesses: [] });
  let recovered = '', offset = 0;
  do {
    const raw = await call('agsdl_get', { section: 'guide', limit: 1024, offset, expected_revision: read.revision });
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(AGSDL_TOOL_RESPONSE_BYTES);
    const page = JSON.parse(raw).text_page; recovered += page.content; offset = page.next_offset;
  } while (offset !== null);
  const guide = JSON.parse(recovered);
  expect(guide.contract).toBe('agsdl-0.4.0');
  expect(guide.minimal).toEqual({ contract: 'agsdl-0.4.0', id: 'new-system', agents: {} });
  expect(guide.agent_shape.permissions).toBe('read-only');
  for (const field of ['instructs', 'permissions', 'results', 'conduct', 'models', 'equipment', 'messages', 'fanout', 'joins', 'compositions', 'calls', 'approvals', 'limits', 'validation', 'design', 'presentation']) expect(guide[field]).toBeString();
  expect(Object.keys(guide.examples)).toHaveLength(6);
});

it('keeps 0.4 design and display edits in the envelope, with one revision and exact source', async () => {
  const { createExampleDocument } = await import('../../services/agsdl/examples');
  plan.agsdl = { ...createExampleDocument('feature'), revision: 1 };
  const source = plan.agsdl.source;
  const read = JSON.parse(await call('agsdl_get'));
  const updated = JSON.parse(await call('agsdl_update', { expected_revision: read.revision, display_json: '{"cards":{"/agents/review":{"title":"Revue indépendante"}}}' }));
  expect(updated.display_context.cards['/agents/review'].title).toBe('Revue indépendante');
  expect(plan.agsdl.source).toBe(source);
  const next = { ...updated.design_context, purpose: 'Vérifier les preuves' };
  await call('agsdl_update', { expected_revision: updated.revision, design_json: JSON.stringify(next) });
  expect(plan.agsdl.source).toBe(source);
  expect(plan.agsdl.design?.purpose).toBe(next.purpose);
  await expect(call('agsdl_update', { expected_revision: current().version, display_json: '{"cards":{"/missing":{"title":"Missing"}}}' })).rejects.toThrow('does not exist');
});

it('uses qualified harness model names and binds catalogue cursors to runtime observations', async () => {
  plan.agsdl = { source: '', annexes: {}, revision: 1 };
  const catalogue = { contract: 'agsdl-0.3.0' as const, assessment: 'runtime-catalogue' as const, harnesses: [{ name: 'codex', available: true, version: 'observed-version', models: Array.from({ length: 1000 }, (_, index) => ({ name: `local/open-model-${index}`, efforts: ['custom-effort'] })) }] };
  const nativeCall = (args: Record<string, unknown>) => handleAgsdlToolCall({ toolName: 'agsdl_get', args: { plan_id: target.planId, target_branch: target.branchName, ...args }, conversationId: 'conversation-test', isCurrent: () => true, readHarnessCatalogue: async () => catalogue });
  const first = JSON.parse(await nativeCall({ section: 'models' }));
  expect(first.text_page.content).toContain('local/open-model');
  expect(first.text_page.content).not.toContain('macro/native-model');
  expect(first.text_page.next_cursor).toBeString();
  const next = JSON.parse(await nativeCall({ section: 'models', cursor: first.text_page.next_cursor, expected_revision: first.revision }));
  expect(next.text_page.offset).toBe(first.text_page.next_offset);
  catalogue.harnesses[0].models.push({ name: 'new-open-model', efforts: [] });
  await expect(nativeCall({ section: 'models', cursor: first.text_page.next_cursor, expected_revision: first.revision })).rejects.toThrow('does not belong');
});

it('revalidates source ownership after an asynchronous native catalogue read and reads source without it', async () => {
  plan.agsdl = { source: '', annexes: {}, revision: 1 };
  const read = JSON.parse(await call('agsdl_get'));
  const readHarnessCatalogue = mock(async () => {
    useAgsdlStore.getState().replace(target, '{}', undefined, current().version);
    return { contract: 'agsdl-0.3.0' as const, assessment: 'not-assessed' as const, harnesses: [] };
  });
  await expect(handleAgsdlToolCall({ toolName: 'agsdl_get', args: { plan_id: target.planId, target_branch: target.branchName, expected_revision: read.revision }, conversationId: 'conversation-test', isCurrent: () => true, readHarnessCatalogue })).rejects.toBeInstanceOf(AgsdlAuthoringRefusal);
  const unavailable = mock(async () => { throw new Error('Native catalogue unavailable'); });
  await expect(handleAgsdlToolCall({ toolName: 'agsdl_get', args: { plan_id: target.planId, target_branch: target.branchName, section: 'source' }, conversationId: 'conversation-test', isCurrent: () => true, readHarnessCatalogue: unavailable })).resolves.toBeString();
  expect(unavailable).not.toHaveBeenCalled();
});

it('returns an original 0.3 report without dropping severity, expanded steps or inferred joins', async () => {
  const { createExampleDocument } = await import('../../services/agsdl/examples');
  plan.agsdl = { ...createExampleDocument('feature'), revision: 1 };
  await useAgsdlStore.getState().load(target);
  const exact = '{"contract":"agsdl-0.3.0","valid":true,"diagnostics":[{"code":"SHARED_INSTANCE_PARALLEL","severity":"warning","path":"/compositions/review/steps/inspect","step":["review","inspect"],"message":"Parallel work is serialized."}],"joins":{"gather":{"origin":"files","branches":["review"]}}}';
  const validate = spyOn(useAgsdlStore.getState(), 'validate').mockImplementationOnce(async () => {
    const session = current();
    useAgsdlStore.setState({ sessions: { ...useAgsdlStore.getState().sessions, [agsdlSessionKey(target)]: { ...session, reports: [{ operation: 'readDocument', contract: 'agsdl-0.3.0', documentReportJson: exact, results: [] }] } } });
  });
  try {
    const page = JSON.parse(await call('agsdl_get', { section: 'report', report_index: 0 }));
    expect(page.text_page.content).toBe(exact);
    expect(JSON.parse(page.text_page.content).diagnostics[0]).toMatchObject({ severity: 'warning', step: ['review', 'inspect'] });
  } finally { validate.mockRestore(); }
});
