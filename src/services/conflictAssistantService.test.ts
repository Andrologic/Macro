import { beforeEach, describe, expect, it, mock } from "bun:test";

const setModeMock = mock(() => undefined);
const ensureConversationForCurrentModeMock = mock(async () => "repo-auditor-conv");
const createConversationMock = mock(async () => ({
  id: "repo-auditor-conv",
}));
const sendMessageMock = mock(async () => ({
  status: "sent",
  conversationId: "repo-auditor-conv",
  userMessageId: "user-1",
  assistantMessageId: "assistant-1",
}));
const appStoreState = {
  setMode: setModeMock,
};
const chatStoreState = {
  ensureConversationForCurrentMode: ensureConversationForCurrentModeMock,
  createConversation: createConversationMock,
  sendMessage: sendMessageMock,
};

const createStoreHook = <TState extends object>(state: TState) =>
  Object.assign(
    <TSelected = TState>(selector?: (snapshot: TState) => TSelected) =>
      (selector ? selector(state) : (state as unknown as TSelected)),
    {
      getState: () => state,
      setState: (patch: Partial<TState>) => Object.assign(state, patch),
      subscribe: () => () => undefined,
    }
  );

describe("conflictAssistantService", () => {
  beforeEach(() => {
    mock.restore();
    setModeMock.mockClear();
    ensureConversationForCurrentModeMock.mockClear();
    createConversationMock.mockClear();
    sendMessageMock.mockClear();

    mock.module("../stores/useAppStore", () => ({
      useAppStore: createStoreHook(appStoreState),
    }));

    mock.module("../stores/useChatStore", () => ({
      useChatStore: createStoreHook(chatStoreState),
    }));
  });

  it("opens conflict assistants in Implement with the repo auditor profile", async () => {
    const moduleId = `./conflictAssistantService.ts?repo-auditor`;
    const { openConflictAssistant } = await import(moduleId);

    const conversationId = await openConflictAssistant("Resolve these blockers.");

    expect(conversationId).toBe("repo-auditor-conv");
    expect(setModeMock).toHaveBeenCalledWith("Implement");
    expect(sendMessageMock).toHaveBeenCalledWith({
      conversationId: "repo-auditor-conv",
      content: "Resolve these blockers.",
      internalAgentProfile: "repo_auditor",
    });
  });
});
