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

describe("conflictAssistantService", () => {
  beforeEach(() => {
    mock.restore();
    setModeMock.mockClear();
    ensureConversationForCurrentModeMock.mockClear();
    createConversationMock.mockClear();
    sendMessageMock.mockClear();

    mock.module("../stores/useAppStore", () => ({
      useAppStore: {
        getState: () => ({
          setMode: setModeMock,
        }),
      },
    }));

    mock.module("../stores/useChatStore", () => ({
      useChatStore: {
        getState: () => ({
          ensureConversationForCurrentMode: ensureConversationForCurrentModeMock,
          createConversation: createConversationMock,
          sendMessage: sendMessageMock,
        }),
      },
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
