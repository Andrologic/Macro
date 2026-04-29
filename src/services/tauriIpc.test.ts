import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const actualCore = await import("@tauri-apps/api/core");
const invokeCalls: Array<{ command: string; payload: unknown }> = [];
const invokeMock = mock(async (command: string, payload?: unknown) => {
  invokeCalls.push({ command, payload });
  return '{"ok":true}';
});

const registerTauriIpcMocks = () => {
  mock.restore();
  mock.module("@tauri-apps/api/core", () => ({
    ...actualCore,
    invoke: invokeMock,
  }));
};

let tauriIpcImportCounter = 0;

const loadTauriIpc = async () => {
  registerTauriIpcMocks();
  tauriIpcImportCounter += 1;
  return import(`./tauriIpc.ts?test=${tauriIpcImportCounter}`);
};

describe("tauriIpc executeWorkspaceTool", () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    invokeMock.mockClear();
  });

  it("passes workspacePath to tool_execute_workspace", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.executeWorkspaceTool({
      mode: "Architect",
      toolId: "read",
      args: { path: "src/App.tsx" },
      workspacePath: "C:/dev/Smartcards",
    });

    expect(invokeCalls).toEqual([
      {
        command: "tool_execute_workspace",
        payload: {
          mode: "Architect",
          toolId: "read",
          args: { path: "src/App.tsx" },
          workspacePath: "C:/dev/Smartcards",
          workspaceScope: null,
        },
      },
    ]);
  });

  it("calls ai_get_dev_provider_overrides without payload", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.aiGetDevProviderOverrides();

    expect(invokeCalls).toEqual([
      {
        command: "ai_get_dev_provider_overrides",
        payload: undefined,
      },
    ]);
  });

  it("passes providerType and isLocal through db_update_provider_config", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.updateProviderConfig({
      id: "provider-1",
      name: "MiniMax",
      providerType: "openai",
      baseUrl: "https://api.minimax.io/v1",
      apiKey: "test-api-key",
      isLocal: false,
      isEnabled: true,
    });

    expect(invokeCalls).toEqual([
      {
        command: "db_update_provider_config",
        payload: {
          id: "provider-1",
          name: "MiniMax",
          providerType: "openai",
          baseUrl: "https://api.minimax.io/v1",
          apiKey: "test-api-key",
          isLocal: false,
          isEnabled: true,
        },
      },
    ]);
  });

  it("passes the stable conversation id through ai_stream_chat", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.aiStreamChat({
      requestId: "req-1",
      providerId: "chatgpt",
      modelId: "gpt-5.4",
      conversationId: "conv_123",
      messages: [
        {
          role: "tool",
          content: "FILE: README.md",
          tool_call_id: "call_1",
        },
      ],
    });

    expect(invokeCalls).toEqual([
      {
        command: "ai_stream_chat",
        payload: {
          request: {
            request_id: "req-1",
            provider_id: "chatgpt",
            model_id: "gpt-5.4",
            reasoning_effort: null,
            conversation_id: "conv_123",
            messages: [
              {
                role: "tool",
                content: "FILE: README.md",
                tool_call_id: "call_1",
              },
            ],
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            workspace_path: null,
            default_workspace_path: null,
            project_mounts: [],
            virtual_root_enabled: null,
            focused_project_id: null,
            allowed_tool_ids: [],
            copilot_send_timeout_ms: null,
          },
        },
      },
    ]);
  });

  it("passes Copilot send timeout through ai_stream_chat", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.aiStreamChat({
      requestId: "req-1",
      providerId: "copilot",
      modelId: "gpt-5",
      messages: [{ role: "user", content: "Hello" }],
      copilotSendTimeoutMs: 1_800_000,
    });

    expect((invokeCalls[0]?.payload as { request?: Record<string, unknown> }).request)
      .toMatchObject({
        provider_id: "copilot",
        copilot_send_timeout_ms: 1_800_000,
      });
  });

  it("updates provider settings partially", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.updateProviderSettings({
      providerId: "copilot",
      copilotSendTimeoutMs: 2_400_000,
    });

    expect(invokeCalls).toEqual([
      {
        command: "db_update_provider_settings",
        payload: {
          providerId: "copilot",
          copilotSendTimeoutMs: 2_400_000,
        },
      },
    ]);
  });

  it("submits Copilot tool results through ai_submit_tool_result", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.aiSubmitToolResult({
      requestId: "req-1",
      toolCallId: "call_question",
      result: "Questionnaire queued.",
      hiddenContext: "<questionnaire_context />",
      visibleContent: "Need one choice.",
      interrupt: true,
    });

    expect(invokeCalls).toEqual([
      {
        command: "ai_submit_tool_result",
        payload: {
          request: {
            request_id: "req-1",
            tool_call_id: "call_question",
            result: "Questionnaire queued.",
            hidden_context: "<questionnaire_context />",
            visible_content: "Need one choice.",
            interrupt: true,
          },
        },
      },
    ]);
  });

  it("passes conversation scope repairs through db_update_conversation_scope", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.updateConversationScope({
      id: "conv-1",
      scopeMode: "Architect",
      taskId: null,
      groupId: "group-1",
      projectId: "project-1",
    });

    expect(invokeCalls).toEqual([
      {
        command: "db_update_conversation_scope",
        payload: {
          id: "conv-1",
          scopeMode: "Architect",
          taskId: null,
          groupId: "group-1",
          projectId: "project-1",
        },
      },
    ]);
  });

  it("uses camelCase payload keys for workspace project mutations", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.workspaceCreateProject({
      name: "Web",
      description: "",
      groupId: "group-1",
      groupName: "Suite",
      path: "C:/dev/web",
    });
    await tauriIpc.workspaceImportGitRepo({
      gitUrl: "https://example.com/repo.git",
      projectName: "API",
      branch: "main",
      groupId: "group-1",
      groupName: "Suite",
      path: "C:/dev/api",
    });
    await tauriIpc.workspaceRenameProjectGroup({
      groupId: "group-1",
      name: "Renamed",
    });
    await tauriIpc.workspaceRenameProject({
      projectId: "project-1",
      name: "Renamed Project",
    });
    await tauriIpc.workspaceArchiveProjectGroup({ groupId: "group-1" });
    await tauriIpc.workspaceArchiveProject({ projectId: "project-1" });
    await tauriIpc.workspaceRemoveProjectGroup({ groupId: "group-1" });
    await tauriIpc.workspaceRemoveProject({ projectId: "project-1" });
    await tauriIpc.workspaceDebugResetProject({ projectId: "project-1", force: true });
    await tauriIpc.workspaceCloseProject({ projectId: "project-1" });

    expect(invokeCalls).toEqual([
      {
        command: "workspace_create_project",
        payload: {
          name: "Web",
          description: "",
          gitFlowSettings: null,
          groupId: "group-1",
          groupName: "Suite",
          path: "C:/dev/web",
        },
      },
      {
        command: "workspace_import_git_repo",
        payload: {
          gitUrl: "https://example.com/repo.git",
          projectName: "API",
          branch: "main",
          gitFlowSettings: null,
          groupId: "group-1",
          groupName: "Suite",
          path: "C:/dev/api",
        },
      },
      {
        command: "workspace_rename_project_group",
        payload: {
          groupId: "group-1",
          name: "Renamed",
        },
      },
      {
        command: "workspace_rename_project",
        payload: {
          projectId: "project-1",
          name: "Renamed Project",
        },
      },
      {
        command: "workspace_archive_project_group",
        payload: {
          groupId: "group-1",
        },
      },
      {
        command: "workspace_archive_project",
        payload: {
          projectId: "project-1",
        },
      },
      {
        command: "workspace_remove_project_group",
        payload: {
          groupId: "group-1",
        },
      },
      {
        command: "workspace_remove_project",
        payload: {
          projectId: "project-1",
        },
      },
      {
        command: "workspace_debug_reset_project",
        payload: {
          projectId: "project-1",
          force: true,
        },
      },
      {
        command: "workspace_close_project",
        payload: {
          projectId: "project-1",
        },
      },
    ]);
  });

  it("uses camelCase payload keys for atomic workspace git setup and access previews", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.workspacePreviewProjectGitSetup({
      path: "C:/dev/web",
    });
    await tauriIpc.workspaceCreateProjectWithGitSetup({
      name: "Web",
      description: "",
      groupId: "group-1",
      groupName: "Suite",
      path: "C:/dev/web",
      gitSetupActions: ["initialize_repo", "create_initial_commit"],
      expectedRepoRootPath: "C:/dev/web",
      expectedSetupState: "not_git",
      expectedRecommendedActionSequence: [
        "initialize_repo",
        "create_initial_commit",
      ],
    });
    await tauriIpc.workspaceUpdateProjectGitFlowWithSetup({
      projectId: "project-1",
      gitFlowSettings: {
        mainBranch: "main",
        baseBranch: "develop",
        planBranchTemplate: "plan/{planSlug}",
        featureBranchTemplate: "feature/{planSlug}/{featureSlug}",
        standaloneFeatureBranchTemplate: "feature/{featureSlug}",
        releaseBranchTemplate: "release/{releaseSlug}",
        hotfixBranchTemplate: "hotfix/{hotfixSlug}",
        bugfixBranchTemplate: "bugfix/{bugfixSlug}",
      },
      gitSetupActions: ["create_develop"],
      expectedRepoRootPath: "C:/dev/web",
      expectedSetupState: "single_main_only",
      expectedRecommendedActionSequence: ["create_develop"],
    });
    await tauriIpc.workspacePreviewProjectAccessChange({
      projectId: "project-1",
      targetReadOnly: true,
    });
    await tauriIpc.workspaceUpdateProjectAccess({
      projectId: "project-1",
      userReadOnly: true,
      confirmedMigration: true,
    });

    expect(invokeCalls).toEqual([
      {
        command: "workspace_preview_project_git_setup",
        payload: {
          path: "C:/dev/web",
        },
      },
      {
        command: "workspace_create_project_with_git_setup",
        payload: {
          name: "Web",
          description: "",
          groupId: "group-1",
          groupName: "Suite",
          path: "C:/dev/web",
          gitFlowSettings: null,
          gitSetupActions: ["initialize_repo", "create_initial_commit"],
          expectedRepoRootPath: "C:/dev/web",
          expectedSetupState: "not_git",
          expectedRecommendedActionSequence: [
            "initialize_repo",
            "create_initial_commit",
          ],
        },
      },
      {
        command: "workspace_update_project_git_flow_with_setup",
        payload: {
          projectId: "project-1",
          gitFlowSettings: {
            mainBranch: "main",
            baseBranch: "develop",
            planBranchTemplate: "plan/{planSlug}",
            featureBranchTemplate: "feature/{planSlug}/{featureSlug}",
            standaloneFeatureBranchTemplate: "feature/{featureSlug}",
            releaseBranchTemplate: "release/{releaseSlug}",
            hotfixBranchTemplate: "hotfix/{hotfixSlug}",
            bugfixBranchTemplate: "bugfix/{bugfixSlug}",
          },
          gitSetupActions: ["create_develop"],
          expectedRepoRootPath: "C:/dev/web",
          expectedSetupState: "single_main_only",
          expectedRecommendedActionSequence: ["create_develop"],
        },
      },
      {
        command: "workspace_preview_project_access_change",
        payload: {
          projectId: "project-1",
          targetReadOnly: true,
        },
      },
      {
        command: "workspace_update_project_access",
        payload: {
          projectId: "project-1",
          userReadOnly: true,
          confirmedMigration: true,
        },
      },
    ]);
  });

  it("uses camelCase payload keys for workspace metadata recovery", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.workspaceRecoverMissingMetadata({
      attemptPull: true,
      projects: [
        {
          projectId: "project-web",
          groupId: "group-1",
          name: "Web",
          path: "C:/dev/web",
        },
      ],
    });

    expect(invokeCalls).toEqual([
      {
        command: "workspace_recover_missing_metadata",
        payload: {
          request: {
            attemptPull: true,
            projects: [
              {
                projectId: "project-web",
                groupId: "group-1",
                name: "Web",
                path: "C:/dev/web",
              },
            ],
          },
        },
      },
    ]);
  });

  it("uses camelCase payload keys for terminal commands", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.terminalCreateSession({
      projectId: "project-1",
      cwd: "packages/api",
    });
    await tauriIpc.terminalRun({
      sessionId: "terminal-1",
      command: "git status",
      timeoutMs: 5000,
    });
    await tauriIpc.terminalRead("terminal-1");
    await tauriIpc.terminalKill("terminal-1");

    expect(invokeCalls).toEqual([
      {
        command: "terminal_create_session",
        payload: {
          projectId: "project-1",
          cwd: "packages/api",
        },
      },
      {
        command: "terminal_run",
        payload: {
          sessionId: "terminal-1",
          command: "git status",
          timeoutMs: 5000,
        },
      },
      {
        command: "terminal_read",
        payload: {
          sessionId: "terminal-1",
        },
      },
      {
        command: "terminal_kill",
        payload: {
          sessionId: "terminal-1",
        },
      },
    ]);
  });

  it("uses camelCase payload keys for git worktree creation", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.gitWorktreeCreate({
      repoPath: "C:/dev/web",
      taskId: "task-1",
      branchName: "feature/checkout",
      fromRef: "integration-ready",
      preferredCommitBranch: "integration-ready",
    });

    expect(invokeCalls).toEqual([
      {
        command: "git_worktree_create",
        payload: {
          repoPath: "C:/dev/web",
          taskId: "task-1",
          branchName: "feature/checkout",
          fromRef: "integration-ready",
          preferredCommitBranch: "integration-ready",
        },
      },
    ]);
  });

  it("uses camelCase payload keys for interactive terminal tabs", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.terminalCreateTab({
      kind: "task",
      projectId: "project-1",
      cwd: "C:/dev/worktree",
      title: "Build · API",
      taskId: "task-1",
    });
    await tauriIpc.terminalReconnectTab("tab-1");
    await tauriIpc.terminalReadTab("tab-1");
    await tauriIpc.terminalUpdateTabMetadata({
      tabId: "tab-1",
      title: "api Â· Refactor parser",
      promptContext: {
        projectLabel: "api",
        taskLabel: "Refactor parser",
        branchLabel: null,
      },
    });
    await tauriIpc.terminalWriteInput({ tabId: "tab-1", input: "pwd\\r" });
    await tauriIpc.terminalResize({ tabId: "tab-1", cols: 120, rows: 32 });
    await tauriIpc.terminalExecuteCommand({
      tabId: "tab-1",
      command: "bun test",
    });
    await tauriIpc.terminalInterrupt("tab-1");
    await tauriIpc.terminalClearTab("tab-1");
    await tauriIpc.terminalCloseTab("tab-1");

    expect(invokeCalls).toEqual([
      {
        command: "terminal_create_tab",
        payload: {
          kind: "task",
          projectId: "project-1",
          cwd: "C:/dev/worktree",
          title: "Build · API",
          taskId: "task-1",
          promptContext: null,
        },
      },
      {
        command: "terminal_reconnect_tab",
        payload: {
          tabId: "tab-1",
        },
      },
      {
        command: "terminal_read_tab",
        payload: {
          tabId: "tab-1",
        },
      },
      {
        command: "terminal_update_tab_metadata",
        payload: {
          tabId: "tab-1",
          title: "api Â· Refactor parser",
          promptContext: {
            projectLabel: "api",
            taskLabel: "Refactor parser",
            branchLabel: null,
          },
        },
      },
      {
        command: "terminal_write_input",
        payload: {
          tabId: "tab-1",
          input: "pwd\\r",
        },
      },
      {
        command: "terminal_resize",
        payload: {
          tabId: "tab-1",
          cols: 120,
          rows: 32,
        },
      },
      {
        command: "terminal_execute_command",
        payload: {
          tabId: "tab-1",
          command: "bun test",
        },
      },
      {
        command: "terminal_interrupt",
        payload: {
          tabId: "tab-1",
        },
      },
      {
        command: "terminal_clear_tab",
        payload: {
          tabId: "tab-1",
        },
      },
      {
        command: "terminal_close_tab",
        payload: {
          tabId: "tab-1",
        },
      },
    ]);
  });

  afterAll(() => {
    mock.restore();
  });
});
