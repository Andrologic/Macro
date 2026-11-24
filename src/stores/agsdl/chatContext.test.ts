import { beforeEach,describe,expect,it,mock } from "bun:test";
import type { ContextReference } from "../../types";
mock.module("../../i18n", () => ({ default: { t: (_key: string, options: { defaultValue: string }) => options.defaultValue } }));
let selected = "conversation-a";
let persisted: string | null = "conversation-a";
let pending: { planId: string; branchName: string } | null = null;
let release: (() => void) | undefined;
let wait: Promise<void> | undefined;
mock.module("../../services/architectPlanService", () => ({
  migrateArchitectPlanToAgsdl: async () => null,
  updateArchitectPlan: async () => { throw new Error("Unexpected save"); },
  getArchitectPlan: async () => { if (wait) await wait; return { conversationId: persisted, status: "draft" }; },
}));
let refs: ContextReference[] = [];
const remove = (id: string) => { refs = refs.filter(ref => ref.id !== id); };
mock.module("../useChatStore", () => ({ useChatStore: { getState: () => ({ selectedConversationId: selected, conversations: [{ id: "conversation-a", project_id: "project-a" }], composerContextRefs: refs, addComposerContextRef: (ref: ContextReference) => { refs.push(ref); }, removeComposerContextRef: remove, getPendingArchitectConversationTarget: () => pending }) } }));
const { useAgsdlStore, agsdlSessionKey } = await import("../useAgsdlStore");
const { prepareAgsdlChatContext, getAgsdlContext, serializeAgsdlChatContext, readAgsdlChatSelection, isAgsdlChatContextCurrent } = await import("./chatContext");
const target = { branchName: "develop", planId: "plan-a" };
beforeEach(() => {
  selected = "conversation-a"; persisted = "conversation-a"; pending = null; wait = undefined; release = undefined;
  refs = [];
  useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: {
    source: '{"definitions":[{},{}]}', annexes: {}, version: "captured-version", persistedRevision: 7,
    status: "draft", dirty: false, saving: false, history: [], future: [], reports: [], error: null,
  } } });
});
describe("AgSDL chat references", () => {
  it("attaches to an owned deferred conversation without materializing it", async () => {
    persisted = null; selected = "deferred-conversation"; pending = { ...target };
    await prepareAgsdlChatContext(target, { path: "", title: "System" });
    expect(getAgsdlContext(refs)?.planId).toBe(target.planId);
    expect(persisted).toBeNull();
    pending = { ...target, planId: "other-plan" };
    await expect(prepareAgsdlChatContext(target, { path: "", title: "System" })).rejects.toThrow("conversation");
    pending = { ...target, branchName: "another-branch" };
    await expect(prepareAgsdlChatContext(target, { path: "", title: "System" })).rejects.toThrow("conversation");
  });
  it("attaches a versioned selection without touching draft text and serializes tool-readable context", async () => {
    await prepareAgsdlChatContext(target, { path: "/definitions/0", title: "Agent", diagnostic: "Missing input" });
    const context = getAgsdlContext(refs)!;
    expect(context.version).toBe("captured-version");
    expect(serializeAgsdlChatContext(context)).toContain('"plan_id":"plan-a"');
    expect(isAgsdlChatContextCurrent(context)).toBe(true);
    expect(serializeAgsdlChatContext(undefined)).toBeUndefined();
    expect(getAgsdlContext(refs)?.conversationId).toBe("conversation-a");
  });
  it("keeps a reference restored after a reload while the saved revision is unchanged", async () => {
    await prepareAgsdlChatContext(target, { path: "/definitions/0", title: "Agent" });
    const context = getAgsdlContext(refs)!;
    const session = useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
    // A reload creates a new session version for the same saved document.
    useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: { ...session, version: "reloaded-version" } } });
    expect(isAgsdlChatContextCurrent(context)).toBe(true);
    useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: { ...session, version: "reloaded-version", persistedRevision: session.persistedRevision + 1 } } });
    expect(isAgsdlChatContextCurrent(context)).toBe(false);
    useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: { ...session, version: "reloaded-version", dirty: true } } });
    expect(isAgsdlChatContextCurrent(context)).toBe(false);
    useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: { ...session, version: "reloaded-version", source: "{}" } } });
    expect(isAgsdlChatContextCurrent({ ...context, path: "/definitions/9" })).toBe(false);
  });
  it("rejects stale document versions before sending a reference", async () => {
    await prepareAgsdlChatContext(target, { path: "/definitions/0", title: "First" });
    const context = getAgsdlContext(refs)!;
    useAgsdlStore.getState().replace(target, '{"definitions":[{}]}');
    expect(isAgsdlChatContextCurrent(context)).toBe(false);
  });
  it("rejects a conversation switch while resolving the plan", async () => {
    wait = new Promise(resolve => { release = resolve; });
    const attaching = prepareAgsdlChatContext(target, { path: "", title: "System" });
    selected = "conversation-b"; release!();
    await expect(attaching).rejects.toThrow("conversation");
    expect(refs).toEqual([]);
  });
  it("does not clear a newer selection when an earlier message finishes", async () => {
    await prepareAgsdlChatContext(target, { path: "/definitions/0", title: "First" });
    const first = getAgsdlContext(refs)!;
    await prepareAgsdlChatContext(target, { path: "/definitions/1", title: "Second" });
    remove(first.id);
    const second = getAgsdlContext(refs)!;
    expect(second.title).toBe("Second");
    remove(second.id);
    expect(refs).toEqual([]);
  });
});

it("ignores malformed selection metadata rather than exposing hidden context", () => {
  expect(readAgsdlChatSelection(undefined)).toBeUndefined();
  expect(readAgsdlChatSelection("<agsdl_selection>not json</agsdl_selection>")).toBeUndefined();
  expect(readAgsdlChatSelection('<agsdl_selection>{"document":"agsdl","title":42}</agsdl_selection>')).toBeUndefined();
});

import { agsdlContextForModel,readAgsdlSelectionPayload } from '../../services/agsdl/chatContextPayload';
import { legacyAgsdlReference,replaceAgsdlChatContext } from './chatContext';

it('shares a validated prefixed selection across display, legacy restoration, replacement and model context', async () => {
  await prepareAgsdlChatContext(target, { path: '/definitions/0', title: 'Agent </agsdl_selection> title', diagnostic: 'Review </agsdl_selection> data' });
  const context = getAgsdlContext(refs)!;
  const serialized = serializeAgsdlChatContext(context)!;
  const hidden = `Earlier metadata\n\n${serialized}\n\nLater metadata`;
  expect(readAgsdlChatSelection(hidden)).toEqual({ title: context.title, review: true });
  expect(legacyAgsdlReference(hidden, 'conversation-a', 'message-a')?.data).toMatchObject({ ...context, id: 'legacy-agsdl:message-a' });
  expect(agsdlContextForModel(hidden)).toBe(serialized);
  expect(agsdlContextForModel(hidden)).not.toContain('Earlier metadata');
  expect(agsdlContextForModel(hidden)).not.toContain('Later metadata');
  const replaced = replaceAgsdlChatContext(hidden, { ...context, title: 'Updated' })!;
  expect(readAgsdlSelectionPayload(replaced)?.title).toBe('Updated');
  expect(replaced.match(/^<agsdl_selection>$/gm)).toHaveLength(1);
  expect(replaced).toContain('Earlier metadata');
  expect(replaced).toContain('Later metadata');
  const removed = replaceAgsdlChatContext(hidden, undefined)!;
  expect(removed).toContain('Earlier metadata');
  expect(removed).toContain('Later metadata');
  expect(removed).not.toContain('<agsdl_selection>');
  expect(removed).not.toContain('Use agsdl_get');
});

it('rejects malformed or ambiguous context consistently and does not forward unknown payload fields', async () => {
  await prepareAgsdlChatContext(target, { path: '', title: 'System' });
  const serialized = serializeAgsdlChatContext(getAgsdlContext(refs)!)!;
  const payload = readAgsdlSelectionPayload(serialized)!;
  const block = (value: unknown) => `<agsdl_selection>\n${JSON.stringify(value)}\n</agsdl_selection>`;
  for (const hidden of [block(null), block([]), block({ ...payload, plan_id: 42 }), block({ ...payload, related_paths: [42] }), block({ ...payload, persisted_revision: -1 }), block({ ...payload, diagnostic: {} }), `${serialized}\n\n${serialized}`]) {
    expect(readAgsdlChatSelection(hidden)).toBeUndefined();
    expect(legacyAgsdlReference(hidden, 'conversation-a', 'message-a')).toBeUndefined();
    expect(agsdlContextForModel(hidden)).toBeUndefined();
  }
  expect(agsdlContextForModel(block({ ...payload, unrelated: 'Hidden private metadata' }))).toBeUndefined();
});

it('keeps old display-only selection labels readable without treating them as model targets', () => {
  const hidden = '<agsdl_selection>\n{"document":"agsdl","title":"Historical","path":"/definitions/0"}\n</agsdl_selection>';
  expect(readAgsdlChatSelection(hidden)).toEqual({ title: 'Historical', review: false });
  expect(legacyAgsdlReference(hidden, 'conversation-a', 'message-a')).toBeUndefined();
  expect(agsdlContextForModel(hidden)).toBeUndefined();
});


it('captures historical runtime data only while the destination and draft remain owned', async () => {
  const { captureAgsdlChatContext } = await import('./chatContext');
  const authoredSource = '{"agents":{"helper":{"prompt":"captured"}}}';
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authoredSource))), byte => byte.toString(16).padStart(2, '0')).join('');
  const source = { owner: { projectId: 'project-a', planId: target.planId, branch: target.branchName }, revision: '1', sourceSha256: sha } as import('../../services/agsdlExecution/contracts').SourceRevision;
  const context: import('../../types').AgsdlRuntimeReference = { ...target, id: 'runtime', conversationId: 'conversation-a', document: 'agsdl', contextKind: 'runtime', source,
    systemStartId: 'run' as import('../../services/agsdlExecution/contracts').SystemStartId, cursor: '1' as import('../../services/agsdlExecution/contracts').Sequence, path: '/agents/helper', title: 'Historical' };
  const historical: import('../../services/agsdl/runtimeSelection').RuntimeSelectionCapture = { reference: context, fragments: [{ path: '/agents/helper', sourceText: '{"prompt":"captured"}' }], diagnostics: [],
    versions: { snapshot: '1', contract: 'agsdl-0.2.0', compiler: 'compiler', runtime: 'runtime', registry: 'registry', profile: 'macro-serial-inline-v1' } };
  const hidden = serializeAgsdlChatContext(context, historical)!;
  await expect(captureAgsdlChatContext(context, 'conversation-a', () => true)).rejects.toThrow('unsupportedEdition020');
  await expect(captureAgsdlChatContext(context, 'conversation-a', () => false, hidden)).rejects.toThrow('draft changed');
  const capture = await captureAgsdlChatContext(context, 'conversation-a', () => true, hidden);
  expect(capture?.fragments[0].sourceText).toBe('{"prompt":"captured"}');
  expect(isAgsdlChatContextCurrent(context)).toBe(true);
  selected = 'other';
  await expect(captureAgsdlChatContext(context, 'conversation-a', () => true, hidden)).rejects.toThrow('owner or draft');
});

it("attaches a blueprint pointer only to its editable conversation", async () => {
  const { useArchitectLibraryStore } = await import("../useArchitectLibraryStore");
  const draft = { id: "blueprint-a", projectId: "library", name: "Review", archived: false, revision: 4,
    conversationId: selected, history: null, origin: null, document: { source: '{"agents":{"reviewer":{}}}', annexes: {} } };
  useArchitectLibraryStore.setState({ draft, versionNumber: null });
  useAgsdlStore.getState().openBlueprintDocument(draft);
  const attach = () => prepareAgsdlChatContext({ blueprintId: draft.id }, { path: "/agents/reviewer", title: "Reviewer" });
  await attach();
  const context = getAgsdlContext(refs)!;
  const hidden = serializeAgsdlChatContext(context)!;
  expect(context).toMatchObject({ blueprintId: draft.id, conversationId: selected, persistedRevision: 4 });
  expect(hidden).toContain('"blueprint_id":"blueprint-a"');
  expect(hidden).not.toContain("target_branch");
  expect(isAgsdlChatContextCurrent(context)).toBe(true);
  selected = "conversation-b";
  await expect(attach()).rejects.toThrow("conversation");
  selected = draft.conversationId;
  useArchitectLibraryStore.setState({ versionNumber: 1 });
  await expect(attach()).rejects.toThrow("conversation");
  expect(refs).toHaveLength(1);
});
