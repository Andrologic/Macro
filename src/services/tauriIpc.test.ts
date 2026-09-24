import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const actualCore = await import("@tauri-apps/api/core");
const invokeCalls: Array<{ command: string; payload: unknown; options?: unknown }> = [];
const invokeMock = mock(async (command: string, payload?: unknown, options?: unknown) => {
  invokeCalls.push({ command, payload, ...(options ? { options } : {}) });
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

describe("tauriIpc confined web fetch", () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    invokeMock.mockClear();
  });

  it("routes page and favicon downloads through the native command", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.webFetchExecute({
      url: "https://example.com/page",
      resourceKind: "page",
    });
    await tauriIpc.webFetchExecute({
      url: "https://example.com/favicon.ico",
      resourceKind: "favicon",
    });

    expect(invokeCalls).toEqual([
      {
        command: "web_fetch_execute",
        payload: {
          url: "https://example.com/page",
          resourceKind: "page",
        },
      },
      {
        command: "web_fetch_execute",
        payload: {
          url: "https://example.com/favicon.ico",
          resourceKind: "favicon",
        },
      },
    ]);
  });
});

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
          projectMounts: [],
          virtualRootEnabled: null,
          focusedProjectId: null,
          executionId: null,
        },
      },
    ]);
  });

  it("passes the execution id to workspace execution and cancellation commands", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.executeWorkspaceTool({
      mode: "Implement",
      toolId: "grep",
      args: { query: "needle" },
      executionId: "execution-123",
    });
    await tauriIpc.cancelWorkspaceTool("execution-123");

    expect(invokeCalls).toEqual([
      expect.objectContaining({
        command: "tool_execute_workspace",
        payload: expect.objectContaining({ executionId: "execution-123" }),
      }),
      {
        command: "tool_cancel_workspace",
        payload: { executionId: "execution-123" },
      },
    ]);
  });

  it("requests a Git log page and its atomic snapshot revision", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.gitLogPage({
      repoPath: "C:/dev/Macro",
      limit: 21,
      offset: 20,
      branch: "feature/tool-suite",
    });

    expect(invokeCalls).toEqual([
      {
        command: "git_log_page",
        payload: {
          repoPath: "C:/dev/Macro",
          limit: 21,
          offset: 20,
          branch: "feature/tool-suite",
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
          params: {
            id: "provider-1",
            name: "MiniMax",
            providerType: "openai",
            baseUrl: "https://api.minimax.io/v1",
            apiKey: "test-api-key",
            isLocal: false,
            isEnabled: true,
          },
        },
      },
    ]);
  });

  it("creates providers without a separate enabled flag", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.createProviderConfig({
      name: "OpenRouter",
      providerType: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-api-key",
      isLocal: false,
    });

    expect(invokeCalls).toEqual([
      {
        command: "db_create_provider_config",
        payload: {
          name: "OpenRouter",
          providerType: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "test-api-key",
          isLocal: false,
        },
      },
    ]);
  });

  it("sends speech recordings as a raw IPC body with provider metadata headers", async () => {
    const tauriIpc = await loadTauriIpc();
    const audio = new Uint8Array([1, 2, 3]);

    await tauriIpc.transcribeSpeech({
      providerId: "openai-speech",
      audio,
      mimeType: "audio/webm;codecs=opus",
      fileName: "dictation.webm",
      language: "fr",
    });

    expect(invokeCalls).toEqual([
      {
        command: "speech_transcribe",
        payload: audio,
        options: {
          headers: {
            "x-macro-speech-provider-id": "openai-speech",
            "x-macro-speech-mime-type": "audio/webm;codecs=opus",
            "x-macro-speech-file-name": "dictation.webm",
            "x-macro-speech-language": "fr",
          },
        },
      },
    ]);
  });

  it("adds origin remotes with camelCase payload keys", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.gitRemoteAddOrigin({
      repoPath: "C:/dev/web",
      url: "https://github.com/example/web.git",
    });

    expect(invokeCalls).toEqual([
      {
        command: "git_remote_add_origin",
        payload: {
          repoPath: "C:/dev/web",
          url: "https://github.com/example/web.git",
        },
      },
    ]);
  });

  it("forwards frontend diagnostics to the native logger", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.frontendLog({
      level: "error",
      scope: "frontend",
      message: "[Frontend:error] Importing a module script failed",
    });

    expect(invokeCalls).toEqual([
      {
        command: "frontend_log",
        payload: {
          level: "error",
          scope: "frontend",
          message: "[Frontend:error] Importing a module script failed",
        },
      },
    ]);
  });

  it("wraps message creation in params for db_create_message", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.createMessage("conv-1", "user", "hello", {
      tokenCount: 3,
      hiddenContext: "hidden",
    });

    expect(invokeCalls).toEqual([
      {
        command: "db_create_message",
        payload: {
          params: {
            conversationId: "conv-1",
            id: null,
            turnId: null,
            role: "user",
            content: "hello",
            tokenCount: 3,
            toolTracesJson: null,
            hiddenContext: "hidden",
            providerInputItemsJson: null,
            providerTurnStateJson: null,
            contextRefsJson: null,
          },
        },
      },
    ]);
  });

  it("wraps message updates in params for db_update_message", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.updateMessage("msg-1", "updated", {
      providerInputItems: [{ type: "message" }],
    });

    expect(invokeCalls).toEqual([
      {
        command: "db_update_message",
        payload: {
          params: {
            id: "msg-1",
            turnId: null,
            content: "updated",
            tokenCount: null,
            toolTracesJson: null,
            hiddenContext: null,
            providerInputItemsJson: JSON.stringify([{ type: "message" }]),
            providerTurnStateJson: null,
            contextRefsJson: null,
          },
        },
      },
    ]);
  });

  it("records conversation compaction events through db_insert_conversation_compaction_event", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.dbInsertConversationCompactionEvent({
      conversation_id: "conv-1",
      trigger: "safety_prestream",
      provider_id: "provider-1",
      model_id: "model-small",
      model_context_window_tokens: 8000,
      tokens_before: 9000,
      tokens_after: 1200,
      status: "success",
      reason: "model_window_shrank",
    });

    expect(invokeCalls).toEqual([
      {
        command: "db_insert_conversation_compaction_event",
        payload: {
          input: {
            conversation_id: "conv-1",
            trigger: "safety_prestream",
            provider_id: "provider-1",
            model_id: "model-small",
            model_context_window_tokens: 8000,
            tokens_before: 9000,
            tokens_after: 1200,
            status: "success",
            reason: "model_window_shrank",
          },
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

  it("uses camelCase for top-level Tauri arguments and keeps DTO fields snake_case", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.dbSetAppSetting({ key: "panel", valueJson: '{"open":true}' });
    await tauriIpc.dbCompareAndSwapAppSetting({
      key: "panel",
      expectedValueJson: '{"open":true}',
      valueJson: '{"open":false}',
    });
    await tauriIpc.dbGetProjectContextState("project-1");
    await tauriIpc.dbDeleteProjectContextState("project-1");
    await tauriIpc.dbUpsertProjectContextState({
      projectId: "project-1",
      groupId: "group-1",
    });

    expect(invokeCalls).toEqual([
      {
        command: "db_set_app_setting",
        payload: {
          key: "panel",
          valueJson: '{"open":true}',
        },
      },
      {
        command: "db_compare_and_swap_app_setting",
        payload: {
          key: "panel",
          expectedValueJson: '{"open":true}',
          valueJson: '{"open":false}',
        },
      },
      {
        command: "db_get_project_context_state",
        payload: {
          projectId: "project-1",
        },
      },
      {
        command: "db_delete_project_context_state",
        payload: {
          projectId: "project-1",
        },
      },
      {
        command: "db_upsert_project_context_state",
        payload: {
          input: {
            project_id: "project-1",
            group_id: "group-1",
            focus_project_id: null,
            last_plan_id: null,
            last_task_id: null,
            architect_conversation_id: null,
            implement_conversation_id: null,
          },
        },
      },
    ]);
  });

  it("resolves project icons in one batch", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.workspaceResolveProjectIcons(["project-1", "project-2"]);

    expect(invokeCalls).toEqual([
      {
        command: "workspace_resolve_project_icons",
        payload: { projectIds: ["project-1", "project-2"] },
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
          is_error: false,
          error_kind: null,
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
    await tauriIpc.workspaceRestoreProjectGroup({ groupId: "group-1" });
    await tauriIpc.workspaceRestoreProject({ projectId: "project-1" });
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
          requestId: null,
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
        command: "workspace_restore_project_group",
        payload: {
          groupId: "group-1",
        },
      },
      {
        command: "workspace_restore_project",
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

  it("binds a legacy direct checkpoint through the workspace command", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.workspaceBindManualFeatureDirectCheckpoint({
      taskId: "task-direct",
      projectId: "project-direct",
      checkpointId: "task-direct-0000000000000001",
    });

    expect(invokeCalls).toEqual([
      {
        command: "workspace_bind_manual_feature_direct_checkpoint",
        payload: {
          taskId: "task-direct",
          projectId: "project-direct",
          checkpointId: "task-direct-0000000000000001",
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
    await tauriIpc.workspaceCreateNewProjectRepo({
      repoName: "API",
      parentPath: "C:/dev",
      folderName: "api",
      groupId: "group-1",
      groupName: "Suite",
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
          requestId: null,
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
          requestId: null,
        },
      },
      {
        command: "workspace_create_new_project_repo",
        payload: {
          repoName: "API",
          parentPath: "C:/dev",
          folderName: "api",
          groupId: "group-1",
          groupName: "Suite",
          gitFlowSettings: null,
          requestId: null,
        },
      },
      {
        command: "workspace_update_project_git_flow_with_setup",
        payload: {
          params: {
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

  it("uses camelCase payload keys for recoverable project discovery", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.workspaceDiscoverRecoverableProjects({
      maxChildrenPerRoot: 25,
    });

    expect(invokeCalls).toEqual([
      {
        command: "workspace_discover_recoverable_projects",
        payload: {
          request: {
            maxChildrenPerRoot: 25,
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
    await tauriIpc.terminalCreateSession({ cwd: "C:/Users/test" });
    await tauriIpc.terminalRun({
      sessionId: "terminal-1",
      command: "git status",
      timeoutMs: 5000,
      executionId: "execution-1",
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
        command: "terminal_create_session",
        payload: {
          projectId: null,
          cwd: "C:/Users/test",
        },
      },
      {
        command: "terminal_run",
        payload: {
          sessionId: "terminal-1",
          command: "git status",
          timeoutMs: 5000,
          executionId: "execution-1",
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
          executionId: null,
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
      fallbackBranches: ["develop", "main"],
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
          fallbackBranches: ["develop", "main"],
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
    await tauriIpc.terminalStartCommandTab({
      kind: "task",
      projectId: "project-1",
      cwd: "C:/dev/worktree",
      title: "Build · API",
      taskId: "task-1",
      command: "bun test",
      promptContext: {
        projectLabel: "api",
        taskLabel: "Refactor parser",
        branchLabel: null,
      },
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
        command: "terminal_start_command_tab",
        payload: {
          kind: "task",
          projectId: "project-1",
          cwd: "C:/dev/worktree",
          title: "Build · API",
          taskId: "task-1",
          promptContext: {
            projectLabel: "api",
            taskLabel: "Refactor parser",
            branchLabel: null,
          },
          command: "bun test",
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

describe("tauriIpc provider models", () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    invokeMock.mockClear();
  });

  it("marks exhaustive provider scans as replacements", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.upsertProviderModels({
      providerId: "provider-openai",
      models: [],
      replaceDiscovered: true,
    });

    expect(invokeCalls).toEqual([
      {
        command: "db_upsert_provider_models",
        payload: {
          providerId: "provider-openai",
          models: [],
          replaceDiscovered: true,
        },
      },
    ]);
  });

  it("keeps partial provider model enrichments non-destructive", async () => {
    const tauriIpc = await loadTauriIpc();

    await tauriIpc.upsertProviderModels({
      providerId: "provider-openai",
      models: [],
    });

    expect(invokeCalls).toEqual([
      {
        command: "db_upsert_provider_models",
        payload: {
          providerId: "provider-openai",
          models: [],
          replaceDiscovered: false,
        },
      },
    ]);
  });

  afterAll(() => {
    mock.restore();
  });
});

describe("tauriIpc persistent MCP runtime", () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    invokeMock.mockClear();
  });

  it("routes persistent MCP runtime operations through planned mcp_runtime_* commands", async () => {
    const tauriIpc = await loadTauriIpc();
    const key = { serverId: "github", projectId: null, configGeneration: 3 };

    await tauriIpc.mcpRuntimeGetSnapshot();
    const selector = { serverId: "test", projectIds: ["project-1"] };
    await tauriIpc.mcpRuntimeConnect(selector);
    await tauriIpc.mcpOAuthAuthorize(selector);
    await tauriIpc.mcpOAuthLogout(selector);
    await tauriIpc.mcpStoreOAuthClientSecret({ serverId: "test", value: "secret" });
    await tauriIpc.mcpDeleteOAuthClientSecret("test");
    await tauriIpc.mcpRuntimeDisconnect(key);
    await tauriIpc.mcpRuntimeRefreshCatalog(key);
    await tauriIpc.mcpRuntimeCallTool({
      key,
      toolName: "echo",
      arguments: { value: "ok" },
      operationId: "operation-1",
    });
    await tauriIpc.mcpRuntimeCancelOperation("operation-1");

    expect(invokeCalls).toEqual([
      {
        command: "mcp_runtime_get_snapshot",
        payload: undefined,
      },
      {
        command: "mcp_runtime_connect",
        payload: { selector },
      },
      {
        command: "mcp_oauth_authorize",
        payload: { selector },
      },
      {
        command: "mcp_oauth_logout",
        payload: { selector },
      },
      {
        command: "mcp_store_oauth_client_secret",
        payload: { serverId: "test", value: "secret" },
      },
      {
        command: "mcp_delete_oauth_client_secret",
        payload: { serverId: "test" },
      },
      {
        command: "mcp_runtime_disconnect",
        payload: { key },
      },
      {
        command: "mcp_runtime_refresh_catalog",
        payload: { key },
      },
      {
        command: "mcp_runtime_call_tool",
        payload: {
          key,
          toolName: "echo",
          arguments: { value: "ok" },
          operationId: "operation-1",
        },
      },
      {
        command: "mcp_runtime_cancel_operation",
        payload: { operationId: "operation-1" },
      },
    ]);
  });

  it("exposes the planned runtime event channel name", async () => {
    const tauriIpc = await loadTauriIpc();

    expect(tauriIpc.MCP_RUNTIME_EVENT_NAME).toBe("mcp:runtime");
  });

  afterAll(() => {
    mock.restore();
  });
});

describe("Pilot native credential IPC", () => {
  const scope = {
    configuration_id: 'config:test-01', relay_origin: 'https://relay.example',
    kind: 'session_token' as const, resource_id: 'session:test-01',
  };

  it('uses exact scoped payloads and does not turn errors into absence', async () => {
    const ipc = await loadTauriIpc();
    const runtime = window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } };
    const previous = runtime.__TAURI_INTERNALS__;
    runtime.__TAURI_INTERNALS__ = { invoke: () => undefined };
    invokeCalls.length = 0;
    try {
      invokeMock.mockImplementationOnce(async (command: string, payload?: unknown) => {
        invokeCalls.push({ command, payload });
        return null as unknown as string;
      });
      expect(await ipc.pilotSecretRead(scope, '7')).toBeNull();
      await ipc.pilotSecretWrite(scope, 'A'.repeat(43), '7');
      await ipc.pilotSecretDelete(scope, '7');
      expect(invokeCalls).toEqual([
        { command: 'pilot_secret_read', payload: { scope, generation: '7' } },
        { command: 'pilot_secret_write', payload: { scope, secret: 'A'.repeat(43), generation: '7' } },
        { command: 'pilot_secret_delete', payload: { scope, generation: '7' } },
      ]);
      for (const status of ['intervention_required', 'cancelled', 'vault_unavailable', 'context_changed', 'suspended']) {
        invokeMock.mockRejectedValueOnce(status);
        await expect(ipc.pilotSecretRead(scope, '7')).rejects.toBe(status);
      }
      invokeCalls.length = 0;
      const context = { configuration_id: scope.configuration_id, relay_origin: scope.relay_origin, owner_id: scope.resource_id };
      await ipc.pilotVaultActivate(context, '7');
      await ipc.pilotVaultResume([scope], '7');
      await ipc.pilotVaultInvalidate('7');
      expect(invokeCalls).toEqual([
        { command: 'pilot_vault_activate', payload: { context, generation: '7' } },
        { command: 'pilot_vault_resume', payload: { scopes: [scope], generation: '7' } },
        { command: 'pilot_vault_invalidate', payload: { generation: '7' } },
      ]);
    } finally {
      if (previous === undefined) delete runtime.__TAURI_INTERNALS__;
      else runtime.__TAURI_INTERNALS__ = previous;
    }
  });

  it('refuses storage outside native Tauri before invoking any command', async () => {
    const ipc = await loadTauriIpc();
    const runtime = window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } };
    const previous = runtime.__TAURI_INTERNALS__;
    delete runtime.__TAURI_INTERNALS__;
    invokeCalls.length = 0;
    try {
      await expect(ipc.pilotSecretRead(scope, '7')).rejects.toThrow('native desktop runtime');
      await expect(ipc.pilotSecretWrite(scope, 'A'.repeat(43), '7')).rejects.toThrow('native desktop runtime');
      await expect(ipc.pilotSecretDelete(scope, '7')).rejects.toThrow('native desktop runtime');
      expect(invokeCalls).toHaveLength(0);
    } finally {
      if (previous !== undefined) runtime.__TAURI_INTERNALS__ = previous;
    }
  });
});

describe('Pilot trace IPC errors', () => {
  it('preserves controlled native errors and hides database diagnostics', async () => {
    const ipc = await loadTauriIpc();
    invokeMock.mockRejectedValueOnce({ message: 'resource_limit' });
    await expect(ipc.pilotToolTracesList('conversation')).rejects.toThrow('resource_limit');
    invokeMock.mockRejectedValueOnce({ message: 'stale_revision' });
    await expect(ipc.pilotToolTraceRead({ conversationId: 'conversation', messageId: 'message', traceIndex: 0, expectedRevision: 1 })).rejects.toThrow('stale_revision');
    invokeMock.mockRejectedValueOnce({ message: 'database error with private diagnostics' });
    await expect(ipc.pilotToolTracesList('conversation')).rejects.toThrow('unavailable');
  });
});

describe('Pilot loaded configuration IPC', () => {
  it('requests observation without native document discovery', async () => {
    const ipc = await loadTauriIpc();
    invokeCalls.length = 0;
    await ipc.configGetSnapshot(['project-fixture'], true);
    expect(invokeCalls).toEqual([{ command: 'config_get_snapshot', payload: { projectIds: ['project-fixture'], observeOnly: true } }]);
  });
});

describe('Pilot task mutation IPC', () => {
  it('routes every workspace mutation to the targeted native operation', async () => {
    const ipc = await loadTauriIpc();
    invokeCalls.length = 0;
    await ipc.workspaceRenameManualFeature({ taskId: 'task-fixture', title: 'New', pilotOnly: true });
    await ipc.workspaceArchiveManualFeature({ taskId: 'task-fixture', pilotOnly: true });
    await ipc.workspaceDeleteManualFeatureDraft('task-fixture', true);
    await ipc.workspaceDeleteManualFeature('task-fixture', true);
    await ipc.workspaceBindManualFeatureDirectCheckpoint({ taskId: 'task-fixture', projectId: 'project-fixture', checkpointId: 'checkpoint-fixture', pilotOnly: true });
    expect(invokeCalls).toEqual([
      { command: 'workspace_pilot_mutate_manual_task', payload: { taskId: 'task-fixture', mutation: { action: 'rename', title: 'New' } } },
      { command: 'workspace_pilot_mutate_manual_task', payload: { taskId: 'task-fixture', mutation: { action: 'archive', reason: null, mergedAt: null } } },
      { command: 'workspace_pilot_mutate_manual_task', payload: { taskId: 'task-fixture', mutation: { action: 'delete', draftOnly: true } } },
      { command: 'workspace_pilot_mutate_manual_task', payload: { taskId: 'task-fixture', mutation: { action: 'delete', draftOnly: false } } },
      { command: 'workspace_pilot_mutate_manual_task', payload: { taskId: 'task-fixture', mutation: { action: 'bind_checkpoint', projectId: 'project-fixture', checkpointId: 'checkpoint-fixture' } } },
    ]);
  });
});


describe('Pilot native effect routing', () => {
  it('requests non-repairing metadata commits and terminal preparation', async () => {
    const ipc = await loadTauriIpc();
    invokeCalls.length = 0;
    await ipc.macroBranchCommitIfDirty({ workspacePath: '/synthetic/project', pilotOnly: true });
    await ipc.terminalStartCommandTab({ kind: 'task', projectId: 'project-fixture', title: 'Run', command: 'echo fixture', pilotOnly: true });
    expect(invokeCalls[0]).toEqual({ command: 'macro_branch_commit_if_dirty', payload: { workspacePath: '/synthetic/project', message: null, pilotOnly: true, metadataPaths: [] } });
    expect(invokeCalls[1]).toMatchObject({ command: 'terminal_start_command_tab', payload: { pilotOnly: true } });
  });
});
