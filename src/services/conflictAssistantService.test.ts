import { beforeEach, describe, expect, it, mock } from "bun:test";

const setModeMock = mock(() => undefined);
const setSelectedTaskMock = mock((_taskId: string | null) => undefined);
const createConversationMock = mock(async (..._args: unknown[]) => ({
  id: "repo-auditor-conv",
}));
const setComposerDraftMock = mock((..._args: unknown[]) => undefined);
const selectConversationMock = mock(async (..._args: unknown[]) => true);
const sendMessageMock = mock(async () => undefined);

const appStoreState = {
  setMode: setModeMock,
  setSelectedTask: setSelectedTaskMock,
  selectedProjectId: null as string | null,
  selectedGroupId: null as string | null,
  selectedTaskId: null as string | null,
};

const chatStoreState = {
  createConversation: createConversationMock,
  setComposerDraft: setComposerDraftMock,
  selectConversation: selectConversationMock,
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
    setSelectedTaskMock.mockClear();
    createConversationMock.mockClear();
    createConversationMock.mockImplementation(async () => ({
      id: "repo-auditor-conv",
    }));
    setComposerDraftMock.mockClear();
    selectConversationMock.mockClear();
    sendMessageMock.mockClear();
    appStoreState.selectedProjectId = null;
    appStoreState.selectedGroupId = null;
    appStoreState.selectedTaskId = null;

    mock.module("../stores/useAppStore", () => ({
      useAppStore: createStoreHook(appStoreState),
    }));

    mock.module("../stores/useChatStore", () => ({
      useChatStore: createStoreHook(chatStoreState),
    }));
  });

  it("opens a dedicated Implement conversation with a draft prompt and no send", async () => {
    const moduleId = `./conflictAssistantService.ts?repo-auditor`;
    const { openConflictAssistant } = await import(moduleId);

    const conversationId = await openConflictAssistant({
      prompt: "Resolve these blockers.",
    });

    expect(conversationId).toBe("repo-auditor-conv");
    expect(setModeMock).toHaveBeenCalledWith("Implement");
    expect(createConversationMock).toHaveBeenCalledWith(
      "Resolve merge conflicts",
      null,
      null,
      null
    );
    expect(setComposerDraftMock).toHaveBeenCalledWith(
      "repo-auditor-conv",
      "Resolve these blockers."
    );
    expect(selectConversationMock).toHaveBeenCalledWith("repo-auditor-conv");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("keeps the repo auditor profile pending until the composer sends", async () => {
    const moduleId = `./conflictAssistantService.ts?repo-auditor-profile`;
    const {
      clearConflictAssistantInternalAgentProfile,
      getConflictAssistantInternalAgentProfile,
      openConflictAssistant,
    } = await import(moduleId);

    const conversationId = await openConflictAssistant({
      prompt: "Inspect the repository state.",
    });

    expect(getConflictAssistantInternalAgentProfile(conversationId)).toBe(
      "repo_auditor",
    );
    clearConflictAssistantInternalAgentProfile(conversationId);
    expect(getConflictAssistantInternalAgentProfile(conversationId)).toBeUndefined();
  });

  it("uses the custom conversation title when provided", async () => {
    const moduleId = `./conflictAssistantService.ts?repo-auditor-title`;
    const { openConflictAssistant } = await import(moduleId);

    await openConflictAssistant({
      prompt: "Diagnose metadata conflicts.",
      conversationTitle: "Custom review title",
    });

    expect(createConversationMock).toHaveBeenCalledWith(
      "Custom review title",
      null,
      null,
      null
    );
  });

  it("passes the selected project and group as conversation scope", async () => {
    appStoreState.selectedProjectId = "project-1";
    appStoreState.selectedGroupId = "group-1";

    const moduleId = `./conflictAssistantService.ts?repo-auditor-scope`;
    const { openConflictAssistant } = await import(moduleId);

    await openConflictAssistant({ prompt: "Help me." });

    expect(createConversationMock).toHaveBeenCalledWith(
      "Resolve merge conflicts",
      null,
      "project-1",
      "group-1"
    );
  });

  it("creates a fresh conversation on each call", async () => {
    let counter = 0;
    createConversationMock.mockImplementation(async () => ({
      id: `conv-${++counter}`,
    }));

    const moduleId = `./conflictAssistantService.ts?repo-auditor-fresh`;
    const { openConflictAssistant } = await import(moduleId);

    const first = await openConflictAssistant({ prompt: "First." });
    const second = await openConflictAssistant({ prompt: "Second." });

    expect(first).toBe("conv-1");
    expect(second).toBe("conv-2");
    expect(createConversationMock).toHaveBeenCalledTimes(2);
    expect(setComposerDraftMock).toHaveBeenNthCalledWith(1, "conv-1", "First.");
    expect(setComposerDraftMock).toHaveBeenNthCalledWith(2, "conv-2", "Second.");
  });

  it("does not call sendMessage at all", async () => {
    const moduleId = `./conflictAssistantService.ts?repo-auditor-no-send`;
    const { openConflictAssistant } = await import(moduleId);

    await openConflictAssistant({ prompt: "Stay in composer." });
    await openConflictAssistant({ prompt: "Still in composer." });

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("clears the selected task so the new conversation is selectable in Implement mode", async () => {
    appStoreState.selectedTaskId = "task-1";

    const moduleId = `./conflictAssistantService.ts?repo-auditor-clear-task`;
    const { openConflictAssistant } = await import(moduleId);

    await openConflictAssistant({ prompt: "Resolve." });

    expect(setSelectedTaskMock).toHaveBeenCalledWith(null);
  });

  it("does not call setSelectedTask when no task is selected", async () => {
    appStoreState.selectedTaskId = null;

    const moduleId = `./conflictAssistantService.ts?repo-auditor-no-task`;
    const { openConflictAssistant } = await import(moduleId);

    await openConflictAssistant({ prompt: "Resolve." });

    expect(setSelectedTaskMock).not.toHaveBeenCalled();
  });

  it("logs a warning when selectConversation returns false", async () => {
    selectConversationMock.mockImplementationOnce(async () => false);
    const warnSpy = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy as never;

    try {
      const moduleId = `./conflictAssistantService.ts?repo-auditor-select-fails`;
      const { openConflictAssistant } = await import(moduleId);

      await openConflictAssistant({ prompt: "Resolve." });

      expect(warnSpy).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});
