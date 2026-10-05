import { beforeEach, describe, expect, it, mock } from "bun:test";

const setModeMock = mock(() => undefined);
const setSelectedTaskMock = mock((_taskId: string | null) => undefined);
const createConversationMock = mock(async (..._args: unknown[]) => ({
  id: "repo-auditor-conv",
}));
const setComposerDraftMock = mock((..._args: unknown[]) => undefined);
const selectConversationMock = mock(async (..._args: unknown[]) => true);
const sendMessageMock = mock(async () => undefined);

const taskCatalog = { tasks: [] as Array<{ id: string; branch_name: string; project_id: string }> };
const listTasksMock = mock(async () => taskCatalog);
const worktreeInspectMock = mock(async () => ({ status: 'ready', worktreePath: '/worktrees/api', branchName: 'feature/api' }));

const nativeStatusMock = mock(async () => ({ branch: 'feature/api', head_commit: { hash: 'abc' }, conflicted_files: ['src/api.ts'], merge_in_progress: true }));
const switchProjectContextMock = mock(async (id: string) => {
  appStoreState.selectedProjectId = id;
  appStoreState.selectedGroupId = appStoreState.projectGroups.find(group => group.projects.some(project => project.id === id))?.id ?? null;
});
const appStoreState = {
  standaloneProjects: [{ id: 'project-1', path: '/repo/api' }],
  projectGroups: [] as Array<{ id: string; projects: Array<{ id: string; path: string }> }>,
  switchProjectContext: switchProjectContextMock,
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
  beforeEach(async () => {
    mock.restore();
    const { clearConflictAssistantContext } = await import('./conflictAssistantContext');
    clearConflictAssistantContext('repo-auditor-conv');
    switchProjectContextMock.mockClear();
    nativeStatusMock.mockClear();
    listTasksMock.mockClear();
    taskCatalog.tasks = [];
    worktreeInspectMock.mockClear();
    appStoreState.standaloneProjects = [{ id: 'project-1', path: '/repo/api' }];
    appStoreState.projectGroups = [];
    nativeStatusMock.mockImplementation(async () => ({ branch: 'feature/api', head_commit: { hash: 'abc' }, conflicted_files: ['src/api.ts'], merge_in_progress: true }));
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

    mock.module('./tauriIpc', () => ({ gitStatus: nativeStatusMock, gitWorktreeInspect: worktreeInspectMock, macroBranchStatus: mock(async ({ workspacePath }: { workspacePath: string }) => ({ branch: '@macro', worktree_path: workspacePath + '/metadata', state: 'conflict' })) }));
    mock.module('./index', () => ({ services: { listTasks: listTasksMock } }));
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

  it("binds the recovery draft to its explicit project instead of current global focus", async () => {
    appStoreState.selectedProjectId = "unrelated-project";
    appStoreState.selectedGroupId = "unrelated-group";
    const moduleId = "./conflictAssistantService.ts?explicit-scope";
    const { openConflictAssistant } = await import(moduleId);
    await openConflictAssistant({
      prompt: "Inspect code conflicts.",
      scope: { projectId: "conflicted-project", groupId: null },
    });
    expect(createConversationMock).toHaveBeenCalledWith(
      "Resolve merge conflicts", null, "conflicted-project", null,
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
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
  it('opens a verified code draft and keeps repo auditor authority after the first send', async () => {
    const { openConflictAssistant, clearConflictAssistantInternalAgentProfile, getConflictAssistantInternalAgentProfile } = await import(`./conflictAssistantService.ts?${'verified-code'}`);
    await openConflictAssistant({
      prompt: 'Stale prompt', internalAgentProfile: 'default_executor',
      context: { kind: 'code', repositories: [{ projectId: 'project-1', repoPath: '/repo/api', branch: 'feature/api' }] },
    });
    expect(switchProjectContextMock).toHaveBeenCalledWith('project-1', { restoreProjectContext: false, ensureAutoPlan: false });
    expect(setComposerDraftMock.mock.calls[0]?.[1]).toContain('src/api.ts');
    expect(setComposerDraftMock.mock.calls[0]?.[1]).not.toContain('Stale prompt');
    clearConflictAssistantInternalAgentProfile('repo-auditor-conv');
    expect(getConflictAssistantInternalAgentProfile('repo-auditor-conv')).toBe('repo_auditor');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('verifies worktree task identities through the service catalog on every opening', async () => {
    taskCatalog.tasks = [{ id: 'task-api', branch_name: 'feature/api', project_id: 'project-1' }];
    const moduleId = './conflictAssistantService.ts?catalog-worktree';
    const { openConflictAssistant } = await import(moduleId);
    const { getConflictAssistantContext } = await import('./conflictAssistantContext');
    const options = { prompt: 'Inspect conflicts', context: { kind: 'code' as const, repositories: [{
      projectId: 'project-1', repoPath: '/worktrees/api', branch: 'feature/api', taskId: 'task-api',
    }] } };
    await openConflictAssistant(options);
    expect(listTasksMock).toHaveBeenCalledTimes(1);
    expect(worktreeInspectMock).toHaveBeenCalledWith({ repoPath: '/repo/api', taskId: 'task-api', branchName: 'feature/api', readOnly: true });
    expect(nativeStatusMock).toHaveBeenCalledWith('/worktrees/api');
    expect(getConflictAssistantContext('repo-auditor-conv')?.repositories[0]).toMatchObject({
      taskId: 'task-api', repoPath: '/worktrees/api', branch: 'feature/api', head: 'abc',
    });
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();

    taskCatalog.tasks = [{ id: 'different-task', branch_name: 'feature/api', project_id: 'project-1' }];
    await expect(openConflictAssistant(options)).rejects.toThrow('no verified task identity');
    expect(listTasksMock).toHaveBeenCalledTimes(2);
    expect(worktreeInspectMock).toHaveBeenCalledTimes(1);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(switchProjectContextMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid context before switching mode or creating a conversation', async () => {
    const { openConflictAssistant } = await import(`./conflictAssistantService.ts?${'invalid-code'}`);
    await expect(openConflictAssistant({ prompt: 'Draft', context: { kind: 'code', repositories: [{ projectId: 'unknown', repoPath: '/foreign', branch: 'feature/api' }] } })).rejects.toThrow('registered');
    expect(setModeMock).not.toHaveBeenCalled();
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it('binds a grouped metadata draft to native @macro worktrees and verified files', async () => {
    appStoreState.standaloneProjects = [];
    appStoreState.projectGroups = [{ id: 'group-1', projects: [{ id: 'project-1', path: '/repo/api' }, { id: 'project-2', path: '/repo/web' }] }];
    nativeStatusMock.mockImplementation(async () => ({ branch: '@macro', head_commit: { hash: 'abc' }, conflicted_files: ['workspace.json'], merge_in_progress: true }));
    const moduleId = './conflictAssistantService.ts?metadata-group';
    const { openConflictAssistant } = await import(moduleId);
    const { getConflictAssistantContext } = await import('./conflictAssistantContext');
    await openConflictAssistant({ prompt: 'Stale metadata', context: { kind: 'metadata', repositories: [
      { projectId: 'project-1', repoPath: '/repo/api' }, { projectId: 'project-2', repoPath: '/repo/web' },
    ] } });
    expect(createConversationMock).toHaveBeenCalledWith('Resolve merge conflicts', null, 'project-1', 'group-1');
    expect(getConflictAssistantContext('repo-auditor-conv')?.repositories.map(repo => repo.repoPath)).toEqual(['/repo/api/metadata', '/repo/web/metadata']);
    expect(setComposerDraftMock.mock.calls[0]?.[1]).toContain('workspace.json');
    expect(setComposerDraftMock.mock.calls[0]?.[1]).toContain('read-only');
    expect(setComposerDraftMock.mock.calls[0]?.[1]).not.toContain('Stale metadata');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('revokes verified authority if conversation selection fails', async () => {
    selectConversationMock.mockImplementationOnce(async () => false);
    const moduleId = './conflictAssistantService.ts?verified-selection-failure';
    const { openConflictAssistant } = await import(moduleId);
    const { getConflictAssistantContext } = await import('./conflictAssistantContext');
    await expect(openConflictAssistant({ prompt: 'Inspect', context: { kind: 'code', repositories: [{ projectId: 'project-1', repoPath: '/repo/api', branch: 'feature/api' }] } })).rejects.toThrow('could not be selected');
    expect(getConflictAssistantContext('repo-auditor-conv')).toBeUndefined();
  });

});
