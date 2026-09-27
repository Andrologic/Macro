import type { ContextReference } from "../../types";
import { beforeEach, describe, expect, it, mock } from "bun:test";
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
mock.module("../useChatStore", () => ({ useChatStore: { getState: () => ({ selectedConversationId: selected, composerContextRefs: refs, addComposerContextRef: (ref: ContextReference) => { refs.push(ref); }, removeComposerContextRef: remove, getPendingArchitectConversationTarget: () => pending }) } }));
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
