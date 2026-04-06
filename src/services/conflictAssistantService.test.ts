import { beforeEach, describe, expect, it, mock } from "bun:test";

const setModeMock = mock(() => undefined);
const ensureConversationForCurrentModeMock = mock(async () => "debug-conv");
const sendMessageMock = mock(async () => ({
  status: "sent",
  conversationId: "debug-conv",
  userMessageId: "user-1",
  assistantMessageId: "assistant-1",
}));

describe("conflictAssistantService", () => {
  beforeEach(() => {
    mock.restore();
    setModeMock.mockClear();
    ensureConversationForCurrentModeMock.mockClear();
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
          sendMessage: sendMessageMock,
        }),
      },
    }));
  });

  it("opens conflict assistants in Debug with the repo auditor profile", async () => {
    const moduleId = `./conflictAssistantService.ts?repo-auditor`;
    const { openConflictAssistant } = await import(moduleId);

    const conversationId = await openConflictAssistant("Resolve these blockers.");

    expect(conversationId).toBe("debug-conv");
    expect(setModeMock).toHaveBeenCalledWith("Debug");
    expect(sendMessageMock).toHaveBeenCalledWith({
      conversationId: "debug-conv",
      content: "Resolve these blockers.",
      internalAgentProfile: "repo_auditor",
    });
  });
});
