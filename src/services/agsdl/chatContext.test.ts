import { beforeEach, describe, expect, it, mock } from "bun:test";
mock.module("../../i18n", () => ({ default: { t: (_key: string, options: { defaultValue: string }) => options.defaultValue } }));
let selected = "conversation-a";
let release: (() => void) | undefined;
let wait: Promise<void> | undefined;
mock.module("../architectPlanService", () => ({
  migrateArchitectPlanToAgsdl: async () => null,
  updateArchitectPlan: async () => { throw new Error("Unexpected save"); },
  getArchitectPlan: async () => { if (wait) await wait; return { conversationId: "conversation-a", status: "draft" }; },
}));
mock.module("../../stores/useChatStore", () => ({ useChatStore: { getState: () => ({ selectedConversationId: selected }) } }));
const { useAgsdlStore, agsdlSessionKey } = await import("../../stores/useAgsdlStore");
const { prepareAgsdlChatContext, useAgsdlChatContext, serializeAgsdlChatContext, isAgsdlChatContextCurrent } = await import("./chatContext");
const target = { branchName: "develop", planId: "plan-a" };
beforeEach(() => {
  selected = "conversation-a"; wait = undefined; release = undefined;
  useAgsdlChatContext.setState({ pending: {} });
  useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: {
    source: '{"definitions":[{},{}]}', annexes: {}, version: "captured-version", persistedRevision: 7,
    status: "draft", dirty: false, saving: false, history: [], future: [], reports: [], error: null,
  } } });
});
describe("AgSDL chat references", () => {
  it("attaches a versioned selection without touching draft text and serializes tool-readable context", async () => {
    await prepareAgsdlChatContext(target, { path: "/definitions/0", title: "Agent", diagnostic: "Missing input" });
    const context = useAgsdlChatContext.getState().pending["conversation-a"];
    expect(context.version).toBe("captured-version");
    expect(serializeAgsdlChatContext(context)).toContain('"plan_id":"plan-a"');
    expect(isAgsdlChatContextCurrent(context)).toBe(true);
    expect(serializeAgsdlChatContext(undefined)).toBeUndefined();
    expect(useAgsdlChatContext.getState().pending["conversation-b"]).toBeUndefined();
  });
  it("rejects stale document versions before sending a reference", async () => {
    await prepareAgsdlChatContext(target, { path: "/definitions/0", title: "First" });
    const context = useAgsdlChatContext.getState().pending["conversation-a"];
    useAgsdlStore.getState().replace(target, '{"definitions":[{}]}');
    expect(isAgsdlChatContextCurrent(context)).toBe(false);
  });
  it("rejects a conversation switch while resolving the plan", async () => {
    wait = new Promise(resolve => { release = resolve; });
    const attaching = prepareAgsdlChatContext(target, { path: "", title: "System" });
    selected = "conversation-b"; release!();
    await expect(attaching).rejects.toThrow("conversation");
    expect(useAgsdlChatContext.getState().pending).toEqual({});
  });
  it("does not clear a newer selection when an earlier message finishes", async () => {
    await prepareAgsdlChatContext(target, { path: "/definitions/0", title: "First" });
    const first = useAgsdlChatContext.getState().pending["conversation-a"];
    await prepareAgsdlChatContext(target, { path: "/definitions/1", title: "Second" });
    useAgsdlChatContext.getState().remove("conversation-a", first.id);
    const second = useAgsdlChatContext.getState().pending["conversation-a"];
    expect(second.title).toBe("Second");
    useAgsdlChatContext.getState().remove("conversation-a", second.id);
    expect(useAgsdlChatContext.getState().pending).toEqual({});
  });
});
