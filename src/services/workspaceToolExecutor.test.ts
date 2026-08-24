import { afterAll, describe, expect, it, mock } from "bun:test";
const actualTauriIpc = await import("./tauriIpc");

type MockAppState = {
  selectedProjectId: string | null;
  selectedGroupId: string | null;
  standaloneProjects: Array<{
    id: string;
    name: string;
    mountName: string;
    path: string;
  }>;
  projectGroups: Array<{
    id: string;
    name: string;
    isOpen: boolean;
    projects: Array<{
      id: string;
      name: string;
      mountName: string;
      path: string;
    }>;
  }>;
};

const defaultAppState: MockAppState = {
  selectedProjectId: null,
  selectedGroupId: null,
  standaloneProjects: [],
  projectGroups: [
    {
      id: "macro-suite",
      name: "Macro Suite",
      isOpen: true,
      projects: [
        {
          id: "api",
          name: "API",
          mountName: "api",
          path: "C:/dev/macro-api",
        },
        {
          id: "web",
          name: "Web App",
          mountName: "web",
          path: "C:/dev/macro-web",
        },
      ],
    },
  ],
};

const registerWorkspaceToolExecutorMocks = (
  appState: Partial<MockAppState> = {},
) => {
  mock.restore();
  const rawTauriModule =
    (appState as { tauriModule?: Record<string, unknown> }).tauriModule || {};
  const remoteKernelModule =
    (appState as { remoteKernelModule?: Record<string, unknown> })
      .remoteKernelModule || {};
  const providedRead = rawTauriModule.fsReadFileWithOptions as
    | ((...args: unknown[]) => Promise<Record<string, unknown>>)
    | undefined;
  const providedWrite = rawTauriModule.fsWriteFile as
    | ((...args: unknown[]) => Promise<Record<string, unknown>>)
    | undefined;
  const tauriModule = {
    ...rawTauriModule,
    ...(providedRead
      ? {
          fsReadFileWithOptions: async (...args: unknown[]) => {
            const result = await providedRead(...args);
            return {
              ...result,
              revision:
                result.revision === null
                  ? null
                  : typeof result.revision === "string"
                  ? result.revision
                  : "mock-revision",
            };
          },
        }
      : {}),
    ...(providedWrite
      ? {
          fsWriteFile: async (...args: unknown[]) => {
            const result = await providedWrite(...args);
            return {
              ...result,
              revision:
                result.revision === null
                  ? null
                  : typeof result.revision === "string"
                  ? result.revision
                  : "mock-revision",
            };
          },
        }
      : {}),
  };
  mock.module("./tauriIpc", () => ({
    ...actualTauriIpc,
    isTauriAvailable: () => false,
    validateToolExecution: async () => ({ allowed: true }),
    executeWorkspaceTool: async () => "UNSUPPORTED_WORKSPACE_TOOL",
    cancelWorkspaceTool: async () => false,
    fsListDir: async () => [],
    fsExists: async () => false,
    fsReadFileWithOptions: async () => ({
      content: "",
      language: "text",
      is_binary: false,
      size: 0,
      encoding: "utf-8",
      revision: "default-revision",
    }),
    fsStat: async (path: string | { path: string }) => {
      const resolvedPath =
        typeof path === "string" ? path : typeof path?.path === "string" ? path.path : "";
      return {
        path: resolvedPath,
        name: resolvedPath.split(/[\\/]/).pop() || "",
        kind: "file",
        size: 0,
        modified: "2026-03-26T00:00:00.000Z",
        permissions: "rw-r--r--",
        language: "text",
        is_readonly: false,
        is_hidden: false,
        is_symlink: false,
      };
    },
    fsWriteFile: async ({ path }: { path: string }) => ({
      path,
      bytes_written: 0,
      created: false,
      revision: "written-revision",
    }),
    fsDelete: async () => undefined,
    gitStatus: async () => ({
      branch: "main",
      head_commit: null,
      staged_files: [],
      unstaged_files: [],
      untracked_files: [],
      conflicted_files: [],
      merge_in_progress: false,
      conflictedFiles: [],
      mergeInProgress: false,
      is_clean: true,
    }),
    gitLog: async () => [],
    gitLogPage: async () => ({ commits: [], revision: "unborn:false:false" }),
    gitBranchList: async () => ({ local: [], remote: [], current: null }),
    gitDiff: async () => "",
    gitGetTree: async () => ({
      branch: "main",
      structure: [],
      modified_files_count: 0,
    }),
    gitAdd: async () => undefined,
    gitCommit: async () => "commit-hash",
    gitCheckout: async () => undefined,
    gitMerge: async () => "merged",
    gitReset: async () => undefined,
    gitStash: async () => "stash@{0}",
    ...tauriModule,
  }));

  mock.module("./remoteKernelApi", () => ({
    canUseRemoteKernel: () => false,
    executeRemoteWorkspaceTool: async () => "",
    validateRemoteToolExecution: async () => ({
      allowed: true,
      enforce_macro_only_writes: false,
    }),
    ...remoteKernelModule,
  }));

  const appStoreState = {
    ...defaultAppState,
    ...appState,
  };

  mock.module("../stores/useAppStore", () => ({
    useAppStore: Object.assign(
      <TSelected = typeof appStoreState>(
        selector?: (state: typeof appStoreState) => TSelected
      ) =>
        selector
          ? selector(appStoreState)
          : (appStoreState as unknown as TSelected),
      {
        getState: () => appStoreState,
        setState: (
          patch:
            | Partial<typeof appStoreState>
            | ((state: typeof appStoreState) => Partial<typeof appStoreState>)
        ) => {
          Object.assign(
            appStoreState,
            typeof patch === "function" ? patch(appStoreState) : patch
          );
        },
        subscribe: () => () => undefined,
      }
    ),
  }));
};

let workspaceToolExecutorImportCounter = 0;

const loadWorkspaceToolExecutor = async (appState?: Partial<MockAppState>) => {
  registerWorkspaceToolExecutorMocks(appState);
  workspaceToolExecutorImportCounter += 1;
  return import(
    `./workspaceToolExecutor.ts?test=${workspaceToolExecutorImportCounter}`
  );
};

describe("workspaceToolExecutor helpers", () => {
  it("flags write tools correctly", async () => {
    const { isWriteTool } = await loadWorkspaceToolExecutor();

    expect(isWriteTool("write")).toBe(true);
    expect(isWriteTool("edit")).toBe(true);
    expect(isWriteTool("delete")).toBe(true);
    expect(isWriteTool("apply_patch")).toBe(true);
    expect(isWriteTool("read")).toBe(false);
    expect(isWriteTool("git_commit")).toBe(false);
    expect(isWriteTool("git_add")).toBe(false);
  });

  it("captures before and after checkpoints for new write files without git scans", async () => {
    let exists = false;
    let content = "";
    const checkpoints: unknown[] = [];
    const writes: Array<Record<string, unknown>> = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async () => exists,
        fsWriteFile: async (params: {
          path: string;
          content: string;
          expectedRevision?: string | null;
          allowOutsideWorkspace?: boolean;
          workspacePath?: string | null;
        }) => {
          const { path, content: nextContent } = params;
          writes.push(params);
          const created = !exists;
          exists = true;
          content = nextContent;
          return {
            path,
            bytes_written: nextContent.length,
            created,
            skipped: false,
          };
        },
        fsReadFileWithOptions: async () => ({
          content,
          language: "TypeScript",
          is_binary: false,
          size: content.length,
          encoding: "utf-8",
        }),
      },
    } as Partial<MockAppState>);

    await executeWorkspaceTool(
      "write",
      { path: "src/new-file.ts", content: "export const value = 1;\n" },
      "Implement",
      {
        workspacePath: "C:/dev/macro-web",
        onCodeCheckpoint: async (checkpoint: { toolName: string; files: unknown[] }) => {
          checkpoints.push(checkpoint);
        },
      },
    );

    expect(checkpoints).toHaveLength(1);
    expect(writes).toEqual([
      expect.objectContaining({
        path: "C:/dev/macro-web/src/new-file.ts",
        expectedRevision: "absent",
        allowOutsideWorkspace: false,
        workspacePath: "C:/dev/macro-web",
      }),
    ]);
    expect(checkpoints[0]).toMatchObject({
      toolName: "write",
      files: [
        {
          path: "src/new-file.ts",
          realPath: "C:/dev/macro-web/src/new-file.ts",
          status: "created",
          before: { exists: false, content: null },
          after: { exists: true, content: "export const value = 1;\n" },
        },
      ],
    });
  });

  it("derives a guarded write revision from the same existing-file snapshot", async () => {
    let content = "old\n";
    const writes: Array<Record<string, unknown>> = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async () => true,
        fsReadFileWithOptions: async () => ({
          content,
          language: "text",
          is_binary: false,
          size: content.length,
          encoding: "utf-8",
          revision: content === "old\n" ? "before-revision" : "after-revision",
        }),
        fsWriteFile: async (params: {
          path: string;
          content: string;
          expectedRevision?: string | null;
          allowOutsideWorkspace?: boolean;
          workspacePath?: string | null;
        }) => {
          writes.push(params);
          content = params.content;
          return {
            path: params.path,
            bytes_written: params.content.length,
            created: false,
            revision: "after-revision",
          };
        },
      },
    } as Partial<MockAppState>);

    await executeWorkspaceTool(
      "write",
      { path: "src/existing.ts", content: "new\n" },
      "Implement",
      {
        workspacePath: "C:/dev/macro-web",
        onCodeCheckpoint: async () => undefined,
      },
    );

    expect(writes).toEqual([
      expect.objectContaining({
        expectedRevision: "before-revision",
        allowOutsideWorkspace: false,
        workspacePath: "C:/dev/macro-web",
      }),
    ]);
  });

  it("does not capture checkpoints when apply_patch fails before writing", async () => {
    const checkpoints: unknown[] = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async () => true,
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "apply_patch",
      {
        patch_text: [
          "*** Begin Patch",
          "*** Add File: src/already.ts",
          "+export const value = 1;",
          "*** End Patch",
        ].join("\n"),
      },
      "Implement",
      {
        workspacePath: "C:/dev/macro-web",
        onCodeCheckpoint: async (checkpoint: { toolName: string; files: unknown[] }) => {
          checkpoints.push(checkpoint);
        },
      },
    );

    expect(result).toContain("Cannot add file");
    expect(checkpoints).toHaveLength(0);
  });

  it("extracts explicit mutating project targets without falling back to focused repositories", async () => {
    const { resolveExplicitMutatingToolProjectTargets } = await loadWorkspaceToolExecutor();
    const routingOptions = {
      groupId: "macro-suite",
      focusedProjectId: "web",
      virtualRootEnabled: true,
      projectMounts: [
        {
          projectId: "api",
          groupId: "macro-suite",
          mountName: "api",
          displayName: "API",
          workspacePath: "C:/dev/macro-api",
          isReadOnly: false,
        },
        {
          projectId: "web",
          groupId: "macro-suite",
          mountName: "web",
          displayName: "Web App",
          workspacePath: "C:/dev/macro-web",
          isReadOnly: true,
        },
      ],
      workspacePathsByProjectId: {
        api: "C:/dev/macro-api",
        web: "C:/dev/macro-web",
      },
    };

    expect(
      resolveExplicitMutatingToolProjectTargets(
        "write",
        { path: "web/src/game.ts" },
        routingOptions,
      ),
    ).toEqual(["web"]);
    expect(
      resolveExplicitMutatingToolProjectTargets(
        "apply_patch",
        {
          patch_text: [
            "*** Begin Patch",
            "*** Update File: api/src/cart.ts",
            "@@",
            "-old",
            "+new",
            "*** Update File: web/src/game.ts",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
        },
        routingOptions,
      ),
    ).toEqual(["api", "web"]);
    expect(
      resolveExplicitMutatingToolProjectTargets(
        "write",
        { path: "src/implicit.ts" },
        routingOptions,
      ),
    ).toEqual([]);
    expect(
      resolveExplicitMutatingToolProjectTargets(
        "read",
        { path: "web/src/game.ts" },
        routingOptions,
      ),
    ).toEqual([]);
  });

  it("enforces architect write path scope", async () => {
    const { assertPathAllowed } = await loadWorkspaceToolExecutor();

    expect(() =>
      assertPathAllowed("Architect", "workspace.json"),
    ).not.toThrow();
    expect(() =>
      assertPathAllowed("Architect", "branches/main/plans/plan-1/plan.md"),
    ).not.toThrow();
    expect(() =>
      assertPathAllowed("Architect", ".macro/workspace.json"),
    ).toThrow();
    expect(() =>
      assertPathAllowed("Architect", "branches/../../src/App.tsx"),
    ).toThrow();
    expect(() => assertPathAllowed("Architect", "src/App.tsx")).toThrow();
    expect(() => assertPathAllowed("Chat", "src/App.tsx")).not.toThrow();
  });

  it("matches glob patterns", async () => {
    const { globToRegex, pathMatchesGlob } = await loadWorkspaceToolExecutor();

    const regex = globToRegex("src/**/*.ts");
    expect(regex.test("src/services/toolModePolicy.ts")).toBe(true);
    expect(
      pathMatchesGlob("src/services/toolModePolicy.ts", "src/**/*.ts"),
    ).toBe(true);
    expect(pathMatchesGlob("src/components/App.tsx", "src/**/*.ts")).toBe(
      false,
    );
  });

  it("routes a prefixed relative path to the matching project workspace", async () => {
    const { resolveToolWorkspaceRouting } = await loadWorkspaceToolExecutor();

    const routing = resolveToolWorkspaceRouting(
      "read",
      { path: "api/src/server.ts" },
      {
        projectId: "web",
        defaultWorkspacePath: "C:/dev/macro-web",
        workspacePathsByProjectId: {
          api: "C:/worktrees/api-task",
          web: "C:/worktrees/web-task",
        },
      },
    );

    expect(routing.projectId).toBe("api");
    expect(routing.workspacePath).toBe("C:/worktrees/api-task");
    expect(routing.args).toEqual({ path: "src/server.ts" });
  });

  it("uses explicit project_id for git tools", async () => {
    const { resolveToolWorkspaceRouting } = await loadWorkspaceToolExecutor();

    const routing = resolveToolWorkspaceRouting(
      "git_status",
      { project_id: "web" },
      {
        workspacePathsByProjectId: {
          api: "C:/worktrees/api-task",
          web: "C:/worktrees/web-task",
        },
      },
    );

    expect(routing.projectId).toBe("web");
    expect(routing.workspacePath).toBe("C:/worktrees/web-task");
    expect(routing.args).toEqual({});
  });

  it("falls back to the focused project inside the selected group", async () => {
    const { resolveToolWorkspaceRouting } = await loadWorkspaceToolExecutor({
      selectedGroupId: "macro-suite",
      selectedProjectId: "web",
    });

    const routing = resolveToolWorkspaceRouting(
      "read",
      { path: "src/App.tsx" },
      {
        groupId: "macro-suite",
      },
    );

    expect(routing.projectId).toBeNull();
    expect(routing.workspacePath).toBe("C:/dev/macro-web");
    expect(routing.args).toEqual({ path: "src/App.tsx" });
  });

  it("falls back to the selected standalone project when no group is active", async () => {
    const { resolveToolWorkspaceRouting } = await loadWorkspaceToolExecutor({
      selectedGroupId: null,
      selectedProjectId: "solo",
      standaloneProjects: [
        {
          id: "solo",
          name: "Solo App",
          mountName: "solo",
          path: "/repos/solo-app",
        },
      ],
      projectGroups: [],
    });

    const routing = resolveToolWorkspaceRouting(
      "read",
      { path: "src/App.tsx" },
      {},
    );

    expect(routing.projectId).toBeNull();
    expect(routing.workspacePath).toBe("/repos/solo-app");
    expect(routing.args).toEqual({ path: "src/App.tsx" });
  });

  it("lists a virtual root containing only project mounts", async () => {
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "list",
      { path: "." },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "api",
            groupId: "macro-suite",
            mountName: "api",
            displayName: "API",
            workspacePath: "C:/dev/macro-api",
          },
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: {
          api: "C:/dev/macro-api",
          web: "C:/dev/macro-web",
        },
      },
    );

    const parsed = JSON.parse(result || "{}");
    expect(parsed.virtual_root).toBe(true);
    expect(parsed.entries.map((entry: { path: string }) => entry.path)).toEqual(
      ["api", "web"],
    );
  });

  it("fans out glob results across projects and prefixes virtual paths", async () => {
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsListDir: async ({ path }: { path: string }) => {
          if (path === "C:/dev/macro-api") {
            return [
              {
                path: "C:/dev/macro-api/src/server.ts",
                relative_path: "src/server.ts",
                name: "server.ts",
                kind: "file",
                is_hidden: false,
                is_readonly: false,
              },
            ];
          }
          if (path === "C:/dev/macro-web") {
            return [
              {
                path: "C:/dev/macro-web/src/App.tsx",
                relative_path: "src/App.tsx",
                name: "App.tsx",
                kind: "file",
                is_hidden: false,
                is_readonly: false,
              },
            ];
          }
          return [];
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "glob",
      { pattern: "**/*.*" },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "api",
            groupId: "macro-suite",
            mountName: "api",
            displayName: "API",
            workspacePath: "C:/dev/macro-api",
          },
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: {
          api: "C:/dev/macro-api",
          web: "C:/dev/macro-web",
        },
      },
    );

    const parsed = JSON.parse(result || "{}");
    expect(parsed.paths).toEqual(["api/src/server.ts", "web/src/App.tsx"]);
  });

  it("resolves read operations against the focused project before cross-mount search", async () => {
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async (path: string) =>
          path === "C:/dev/macro-web/src/App.tsx",
        fsReadFileWithOptions: async ({ path }: { path: string }) => ({
          content:
            path === "C:/dev/macro-web/src/App.tsx"
              ? "export const App = 'web';"
              : "",
          language: "typescript",
          is_binary: false,
          size: 25,
          encoding: "utf-8",
          revision:
            "a6e6fcb7f89bc6c0d42cddc9f91f5d302e601384e87f1a0777a07e18b9ad54d2",
        }),
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "read",
      { path: "src/App.tsx" },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "api",
            groupId: "macro-suite",
            mountName: "api",
            displayName: "API",
            workspacePath: "C:/dev/macro-api",
          },
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: {
          api: "C:/dev/macro-api",
          web: "C:/dev/macro-web",
        },
      },
    );

    expect(result).toContain("FILE: web/src/App.tsx");
    expect(result).toContain("PROJECT_ID: web");
    expect(result).toContain(
      "REVISION: a6e6fcb7f89bc6c0d42cddc9f91f5d302e601384e87f1a0777a07e18b9ad54d2",
    );
    expect(result).toContain("export const App = 'web';");
  });

  it("routes git_merge through the selected project repository in virtual-root mode", async () => {
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        executeWorkspaceTool: async (params: {
          toolId: string;
          args: Record<string, unknown>;
          workspacePath?: string | null;
          virtualRootEnabled?: boolean;
        }) => {
          expect(params.toolId).toBe("git_merge");
          expect(params.workspacePath).toBe("C:/dev/macro-web");
          expect(params.virtualRootEnabled).toBe(false);
          expect(params.args.repo_path).toBe(".");
          return JSON.stringify({
            ok: true,
            repo_path: ".",
            branch: "develop",
            merged_branch: params.args.branch_name,
            into_branch: params.args.into_branch,
            output: "merged feature/auth into develop at C:/dev/macro-web",
          });
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "git_merge",
      {
        project_id: "web",
        branch_name: "feature/auth",
        into_branch: "develop",
      },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "api",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "api",
            groupId: "macro-suite",
            mountName: "api",
            displayName: "API",
            workspacePath: "C:/dev/macro-api",
          },
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: {
          api: "C:/dev/macro-api",
          web: "C:/dev/macro-web",
        },
      },
    );

    const parsed = JSON.parse(result || "{}");
    expect(parsed.project_id).toBe("web");
    expect(parsed.mount_name).toBe("web");
    expect(parsed.repo_path).toBe("web");
    expect(parsed.branch).toBe("develop");
    expect(parsed.merged_branch).toBe("feature/auth");
    expect(parsed.into_branch).toBe("develop");
    expect(parsed.output).toContain("C:/dev/macro-web");
  });

  it("uses bounded Git output from the confined backend without a direct fallback", async () => {
    const backendCalls: Array<Record<string, unknown>> = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        executeWorkspaceTool: async (params: Record<string, unknown>) => {
          backendCalls.push(params);
          return JSON.stringify({
            repo_path: ".",
            count: 1,
            total_count: 3,
            truncated: true,
            next_cursor: "backend-cursor",
            staged_files: [{ path: "a.ts", status: "modified" }],
            unstaged_files: [],
            untracked_files: [],
          });
        },
      },
    } as Partial<MockAppState>);
    const options = { workspacePath: "C:/dev/macro-web" };

    const status = JSON.parse(
      (await executeWorkspaceTool(
        "git_status",
        { limit: 2 },
        "Implement",
        options,
      )) || "{}",
    );
    expect(status.total_count).toBe(3);
    expect(status.truncated).toBe(true);
    expect(status.staged_files).toHaveLength(1);
    expect(backendCalls).toEqual([
      expect.objectContaining({
        toolId: "git_status",
        workspacePath: "C:/dev/macro-web",
        args: expect.objectContaining({ repo_path: ".", limit: 2 }),
      }),
    ]);
  });

  it("keeps virtual git_log routing and cursor validation inside the selected backend workspace", async () => {
    let featureTip = "feature-tip-1";
    const featureCommits = () => [
      {
        id: featureTip,
        hash: featureTip,
        message: "feature tip",
        author: "Macro",
        date: "2026-08-23T00:00:00Z",
        status: "committed",
        parent_ids: [],
        graph_depth: 0,
        is_branch_point: false,
      },
      {
        id: "feature-parent",
        hash: "feature-parent",
        message: "feature parent",
        author: "Macro",
        date: "2026-08-22T00:00:00Z",
        status: "committed",
        parent_ids: [],
        graph_depth: 0,
        is_branch_point: false,
      },
    ];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        executeWorkspaceTool: async (params: {
          toolId: string;
          args: Record<string, unknown>;
          workspacePath?: string | null;
          virtualRootEnabled?: boolean;
        }) => {
          expect(params.toolId).toBe("git_log");
          expect(params.workspacePath).toBe("C:/dev/macro-web");
          expect(params.virtualRootEnabled).toBe(false);
          expect(params.args.repo_path).toBe(".");
          expect(params.args.branch).toBe("feature/topic");
          if (params.args.cursor && featureTip !== "feature-tip-1") {
            return "Error executing git_log: cursor does not belong to the current repository revision.";
          }
          const commits = featureCommits();
          return JSON.stringify({
            repo_path: ".",
            commits: commits.slice(0, 1),
            next_cursor: "backend-log-cursor",
            revision: `${featureTip}:false:false`,
          });
        },
      },
    } as Partial<MockAppState>);
    const options = {
      groupId: "macro-suite",
      focusedProjectId: "web",
      virtualRootEnabled: true,
      projectMounts: [
        {
          projectId: "web",
          groupId: "macro-suite",
          mountName: "web",
          displayName: "Web App",
          workspacePath: "C:/dev/macro-web",
        },
      ],
      workspacePathsByProjectId: { web: "C:/dev/macro-web" },
    };

    const firstPage = JSON.parse(
      (await executeWorkspaceTool(
        "git_log",
        { branch: "feature/topic", limit: 1 },
        "Implement",
        options,
      )) || "{}",
    );
    expect(firstPage.commits[0].id).toBe("feature-tip-1");
    expect(firstPage.next_cursor).toBeTruthy();

    featureTip = "feature-tip-2";
    const stalePage = await executeWorkspaceTool(
      "git_log",
      {
        branch: "feature/topic",
        limit: 1,
        cursor: firstPage.next_cursor,
      },
      "Implement",
      options,
    );

    expect(stalePage).toContain("does not belong");
  });

  it("forwards abort signals to an active backend workspace search", async () => {
    let executionId: string | undefined;
    let finishExecution: ((value: string) => void) | undefined;
    const cancelledIds: string[] = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        executeWorkspaceTool: async (params: { executionId?: string }) => {
          executionId = params.executionId;
          return new Promise<string>((resolve) => {
            finishExecution = resolve;
          });
        },
        cancelWorkspaceTool: async (requestedExecutionId: string) => {
          cancelledIds.push(requestedExecutionId);
          finishExecution?.("Tool execution cancelled: grep.");
          return true;
        },
      },
    } as Partial<MockAppState>);
    const controller = new AbortController();

    const execution = executeWorkspaceTool(
      "grep",
      { query: "needle" },
      "Implement",
      { workspacePath: "C:/dev/macro-web", signal: controller.signal },
    );
    controller.abort();

    expect(await execution).toBe("Tool execution aborted");
    expect(executionId).toBeTruthy();
    expect(cancelledIds).toEqual([executionId as string]);
  });

  it("passes an explicit project selector to the backend after stripping routing arguments", async () => {
    let backendParams: Record<string, unknown> | null = null;
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        executeWorkspaceTool: async (params: Record<string, unknown>) => {
          backendParams = params;
          return "routed";
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "read",
      { path: "web/src/App.tsx", project_id: "web" },
      "Implement",
      {
        focusedProjectId: "api",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "api",
            mountName: "api",
            displayName: "API",
            workspacePath: "C:/dev/api",
          },
          {
            projectId: "web",
            mountName: "web",
            displayName: "Web",
            workspacePath: "C:/dev/web",
          },
        ],
        workspacePathsByProjectId: {
          api: "C:/dev/api",
          web: "C:/dev/web",
        },
      },
    );

    expect(result).toBe("routed");
    expect(backendParams).toMatchObject({
      focusedProjectId: "web",
      args: { path: "src/App.tsx" },
    });
  });

  it("applies apply_patch in virtual-root mode and returns validation details", async () => {
    const writes: Array<{
      path: string;
      content: string;
      expectedRevision?: string | null;
    }> = [];
    const deletes: string[] = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async (path: string) =>
          path === "C:/dev/macro-web/src/App.tsx" ||
          writes.some((entry) => entry.path === path),
        fsReadFileWithOptions: async ({ path }: { path: string }) => {
          if (path === "C:/dev/macro-web/src/App.tsx") {
            return {
              content: "export const App = 'before';\n",
              language: "typescript",
              is_binary: false,
              size: 28,
              encoding: "utf-8",
            };
          }
          if (writes.some((entry) => entry.path === path)) {
            const written = writes.find((entry) => entry.path === path)!;
            return {
              content: written.content,
              language: "typescript",
              is_binary: false,
              size: written.content.length,
              encoding: "utf-8",
            };
          }
          throw new Error(`unexpected read: ${path}`);
        },
        fsWriteFile: async ({
          path,
          content,
          expectedRevision,
        }: {
          path: string;
          content: string;
          expectedRevision?: string | null;
        }) => {
          writes.push({ path, content, expectedRevision });
          return {
            path,
            bytes_written: content.length,
            created: path.endsWith("notes.md"),
          };
        },
        fsDelete: async ({ path }: { path: string }) => {
          deletes.push(path);
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "apply_patch",
      {
        patch_text: [
          "*** Begin Patch",
          "*** Update File: web/src/App.tsx",
          "@@",
          "-export const App = 'before';",
          "+export const App = 'after';",
          "*** Add File: web/notes.md",
          "+hello",
          "*** End Patch",
        ].join("\n"),
      },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "api",
            groupId: "macro-suite",
            mountName: "api",
            displayName: "API",
            workspacePath: "C:/dev/macro-api",
          },
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: {
          api: "C:/dev/macro-api",
          web: "C:/dev/macro-web",
        },
      },
    );

    const parsed = JSON.parse(result || "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0].path).toBe("web/src/App.tsx");
    expect(parsed.files[1].path).toBe("web/notes.md");
    expect(parsed.validation.all_files_readable).toBe(true);
    expect(parsed.diff).toContain("UPDATED web/src/App.tsx");
    expect(writes.map((entry) => entry.path)).toEqual([
      "C:/dev/macro-web/src/App.tsx",
      "C:/dev/macro-web/notes.md",
    ]);
    expect(writes[0].expectedRevision).toBe("mock-revision");
    expect(writes[1].expectedRevision).toBe("absent");
    expect(deletes).toEqual([]);
  });

  it("rolls back earlier apply_patch writes when a later virtual-root write fails", async () => {
    let appContent = "export const App = 'before';\n";
    const laterContent = "export const later = 'before';\n";
    const writes: Array<{ path: string; content: string }> = [];
    const deletes: string[] = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async (path: string) =>
          path === "C:/dev/macro-web/src/App.tsx" ||
          path === "C:/dev/macro-web/src/later.ts",
        fsReadFileWithOptions: async ({ path }: { path: string }) => {
          if (path === "C:/dev/macro-web/src/App.tsx") {
            return {
              content: appContent,
              language: "typescript",
              is_binary: false,
              size: appContent.length,
              encoding: "utf-8",
            };
          }
          if (path === "C:/dev/macro-web/src/later.ts") {
            return {
              content: laterContent,
              language: "typescript",
              is_binary: false,
              size: laterContent.length,
              encoding: "utf-8",
            };
          }
          throw new Error(`unexpected read: ${path}`);
        },
        fsWriteFile: async ({
          path,
          content,
        }: {
          path: string;
          content: string;
        }) => {
          if (path === "C:/dev/macro-web/fail.md") {
            throw new Error("disk full");
          }
          writes.push({ path, content });
          appContent = content;
          return {
            path,
            bytes_written: content.length,
            created: false,
          };
        },
        fsDelete: async ({ path }: { path: string }) => {
          deletes.push(path);
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "apply_patch",
      {
        patch_text: [
          "*** Begin Patch",
          "*** Update File: web/src/App.tsx",
          "@@",
          "-export const App = 'before';",
          "+export const App = 'after';",
          "*** Add File: web/fail.md",
          "+fail",
          "*** Update File: web/src/later.ts",
          "@@",
          "-export const later = 'before';",
          "+export const later = 'after';",
          "*** End Patch",
        ].join("\n"),
      },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: {
          web: "C:/dev/macro-web",
        },
      },
    );

    expect(result).toContain("disk full");
    expect(appContent).toBe("export const App = 'before';\n");
    expect(writes.map((entry) => entry.content)).toEqual([
      "export const App = 'after';\n",
      "export const App = 'before';\n",
    ]);
    expect(writes.some((entry) => entry.path.endsWith("later.ts"))).toBe(false);
    expect(deletes).toEqual([]);
  });

  it("validates every expected patch revision before changing the first file", async () => {
    const writes: string[] = [];
    const checkpoints: unknown[] = [];
    const files: Record<string, { content: string; revision: string }> = {
      "C:/dev/macro-web/src/a.ts": {
        content: "export const a = 1;\n",
        revision: "revision-a",
      },
      "C:/dev/macro-web/src/b.ts": {
        content: "export const b = 1;\n",
        revision: "revision-b-current",
      },
    };
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async (path: string) => Boolean(files[path]),
        fsReadFileWithOptions: async ({ path }: { path: string }) => ({
          content: files[path].content,
          language: "typescript",
          is_binary: false,
          size: files[path].content.length,
          encoding: "utf-8",
          revision: files[path].revision,
        }),
        fsWriteFile: async ({ path }: { path: string }) => {
          writes.push(path);
          return { path, bytes_written: 0, created: false };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "apply_patch",
      {
        patch_text: [
          "*** Begin Patch",
          "*** Update File: web/src/a.ts",
          "@@",
          "-export const a = 1;",
          "+export const a = 2;",
          "*** Update File: web/src/b.ts",
          "@@",
          "-export const b = 1;",
          "+export const b = 2;",
          "*** End Patch",
        ].join("\n"),
        expected_revisions: {
          "web/src/a.ts": "revision-a",
          "web/src/b.ts": "revision-b-stale",
        },
      },
      "Implement",
      {
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "web",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        onCodeCheckpoint: async (checkpoint: unknown) => {
          checkpoints.push(checkpoint);
        },
      },
    );

    expect(result).toContain("Stale content for \"web/src/b.ts\"");
    expect(writes).toEqual([]);
    expect(checkpoints).toEqual([]);
  });

  it("reverts single-file mutations when checkpoint publication fails", async () => {
    let content = "export const value = 'before';\n";
    const writes: string[] = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async () => true,
        fsReadFileWithOptions: async () => ({
          content,
          language: "typescript",
          is_binary: false,
          size: content.length,
          encoding: "utf-8",
        }),
        fsWriteFile: async ({
          content: nextContent,
        }: {
          content: string;
        }) => {
          writes.push(nextContent);
          content = nextContent;
          return {
            path: "C:/dev/macro-web/src/value.ts",
            bytes_written: nextContent.length,
            created: false,
          };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "write",
      { path: "src/value.ts", content: "export const value = 'after';\n" },
      "Implement",
      {
        workspacePath: "C:/dev/macro-web",
        onCodeCheckpoint: async () => {
          throw new Error("checkpoint db unavailable");
        },
      },
    );

    expect(result).toContain("Failed to record code checkpoint");
    expect(result).toContain("mutation was reverted");
    expect(content).toBe("export const value = 'before';\n");
    expect(writes).toEqual([
      "export const value = 'after';\n",
      "export const value = 'before';\n",
    ]);
  });

  it("reverts apply_patch batches when checkpoint publication fails", async () => {
    let appContent = "export const App = 'before';\n";
    let noteExists = false;
    let noteContent = "";
    const writes: Array<{ path: string; content: string }> = [];
    const deletes: string[] = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async (path: string) =>
          path === "C:/dev/macro-web/src/App.tsx" ||
          (path === "C:/dev/macro-web/notes.md" && noteExists),
        fsReadFileWithOptions: async ({ path }: { path: string }) => {
          if (path === "C:/dev/macro-web/src/App.tsx") {
            return {
              content: appContent,
              language: "typescript",
              is_binary: false,
              size: appContent.length,
              encoding: "utf-8",
            };
          }
          if (path === "C:/dev/macro-web/notes.md" && noteExists) {
            return {
              content: noteContent,
              language: "markdown",
              is_binary: false,
              size: noteContent.length,
              encoding: "utf-8",
            };
          }
          throw new Error(`unexpected read: ${path}`);
        },
        fsWriteFile: async ({
          path,
          content,
        }: {
          path: string;
          content: string;
        }) => {
          writes.push({ path, content });
          if (path === "C:/dev/macro-web/src/App.tsx") {
            appContent = content;
          }
          if (path === "C:/dev/macro-web/notes.md") {
            noteExists = true;
            noteContent = content;
          }
          return {
            path,
            bytes_written: content.length,
            created: path.endsWith("notes.md"),
          };
        },
        fsDelete: async ({ path }: { path: string }) => {
          deletes.push(path);
          if (path === "C:/dev/macro-web/notes.md") {
            noteExists = false;
            noteContent = "";
          }
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "apply_patch",
      {
        patch_text: [
          "*** Begin Patch",
          "*** Update File: web/src/App.tsx",
          "@@",
          "-export const App = 'before';",
          "+export const App = 'after';",
          "*** Add File: web/notes.md",
          "+hello",
          "*** End Patch",
        ].join("\n"),
      },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: {
          web: "C:/dev/macro-web",
        },
        onCodeCheckpoint: async () => {
          throw new Error("checkpoint db unavailable");
        },
      },
    );

    expect(result).toContain("Failed to record code checkpoint");
    expect(result).toContain("mutations were reverted");
    expect(appContent).toBe("export const App = 'before';\n");
    expect(noteExists).toBe(false);
    expect(writes.map((entry) => entry.path)).toEqual([
      "C:/dev/macro-web/src/App.tsx",
      "C:/dev/macro-web/notes.md",
      "C:/dev/macro-web/src/App.tsx",
    ]);
    expect(deletes).toEqual(["C:/dev/macro-web/notes.md"]);
  });

  it("continues rolling back an apply_patch batch after one guarded restore fails", async () => {
    const original = new Map([
      ["C:/dev/macro-web/src/a.ts", "export const a = 'before';\n"],
      ["C:/dev/macro-web/src/b.ts", "export const b = 'before';\n"],
    ]);
    const contents = new Map(original);
    const rollbackAttempts: string[] = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async (path: string) => contents.has(path),
        fsReadFileWithOptions: async ({ path }: { path: string }) => {
          const content = contents.get(path);
          if (content === undefined) throw new Error(`unexpected read: ${path}`);
          return {
            content,
            language: "typescript",
            is_binary: false,
            size: content.length,
            encoding: "utf-8",
            revision: content.includes("before")
              ? `before:${path}`
              : `applied:${path}`,
          };
        },
        fsWriteFile: async ({
          path,
          content,
        }: {
          path: string;
          content: string;
        }) => {
          const isRollback = content === original.get(path);
          if (isRollback) {
            rollbackAttempts.push(path);
            if (path.endsWith("/b.ts")) {
              throw new Error("b.ts changed externally");
            }
          }
          contents.set(path, content);
          return {
            path,
            bytes_written: content.length,
            created: false,
            revision: isRollback ? `restored:${path}` : `applied:${path}`,
          };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "apply_patch",
      {
        patch_text: [
          "*** Begin Patch",
          "*** Update File: web/src/a.ts",
          "@@",
          "-export const a = 'before';",
          "+export const a = 'after';",
          "*** Update File: web/src/b.ts",
          "@@",
          "-export const b = 'before';",
          "+export const b = 'after';",
          "*** End Patch",
        ].join("\n"),
      },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: { web: "C:/dev/macro-web" },
        onCodeCheckpoint: async () => {
          throw new Error("checkpoint db unavailable");
        },
      },
    );

    expect(result).toContain("rollback failed");
    expect(result).toContain("b.ts changed externally");
    expect(rollbackAttempts).toEqual([
      "C:/dev/macro-web/src/b.ts",
      "C:/dev/macro-web/src/a.ts",
    ]);
    expect(contents.get("C:/dev/macro-web/src/a.ts")).toBe(
      original.get("C:/dev/macro-web/src/a.ts"),
    );
    expect(contents.get("C:/dev/macro-web/src/b.ts")).toContain("after");
  });

  it("reverts apply_patch when post-write validation fails", async () => {
    const path = "C:/dev/macro-web/src/value.ts";
    const before = "export const value = 'before';\n";
    let content = before;
    let checkpointCalls = 0;
    const writes: string[] = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async () => true,
        fsReadFileWithOptions: async () => {
          if (content.includes("after")) {
            throw new Error("post-write validation unavailable");
          }
          return {
            content,
            language: "typescript",
            is_binary: false,
            size: content.length,
            encoding: "utf-8",
            revision: "before-revision",
          };
        },
        fsWriteFile: async ({ content: nextContent }: { content: string }) => {
          writes.push(nextContent);
          content = nextContent;
          return {
            path,
            bytes_written: nextContent.length,
            created: false,
            revision: nextContent === before ? "restored-revision" : "applied-revision",
          };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "apply_patch",
      {
        patch_text: [
          "*** Begin Patch",
          "*** Update File: web/src/value.ts",
          "@@",
          "-export const value = 'before';",
          "+export const value = 'after';",
          "*** End Patch",
        ].join("\n"),
      },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: { web: "C:/dev/macro-web" },
        onCodeCheckpoint: async () => {
          checkpointCalls += 1;
        },
      },
    );

    expect(result).toContain("Validation failed after apply_patch");
    expect(result).toContain("mutations were reverted");
    expect(content).toBe(before);
    expect(writes).toEqual(["export const value = 'after';\n", before]);
    expect(checkpointCalls).toBe(0);
  });

  it("deletes a file from the routed worktree workspace", async () => {
    const deletes: Array<{ path: string; expectedRevision?: string | null }> = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        executeWorkspaceTool: async () => "UNSUPPORTED_WORKSPACE_TOOL",
        fsStat: async (path: string) => ({
          path,
          name: "obsolete.ts",
          kind: "file",
          size: 20,
          modified: "2026-03-26T10:00:00.000Z",
          permissions: "rw-r--r--",
          language: "typescript",
          is_readonly: false,
          is_hidden: false,
          is_symlink: false,
        }),
        fsReadFileWithOptions: async ({ path }: { path: string }) => ({
          content:
            path === "C:/worktrees/web-task/src/obsolete.ts"
              ? "first line\nsecond line\n"
              : "",
          language: "typescript",
          is_binary: false,
          size: 23,
          encoding: "utf-8",
        }),
        fsDelete: async ({
          path,
          expectedRevision,
        }: {
          path: string;
          expectedRevision?: string | null;
        }) => {
          deletes.push({ path, expectedRevision });
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "delete",
      { path: "src/obsolete.ts", project_id: "web" },
      "Implement",
      {
        projectId: "web",
        focusedProjectId: "web",
        defaultWorkspacePath: "C:/worktrees/web-task",
        workspacePathsByProjectId: {
          web: "C:/worktrees/web-task",
        },
      },
    );

    const parsed = JSON.parse(result || "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.files[0].path).toBe("src/obsolete.ts");
    expect(parsed.files[0].status).toBe("deleted");
    expect(parsed.files[0].deletions).toBe(2);
    expect(parsed.files[0].validation.exists).toBe(false);
    expect(deletes).toEqual([
      {
        path: "C:/worktrees/web-task/src/obsolete.ts",
        expectedRevision: "mock-revision",
      },
    ]);
  });

  it("rejects delete on an explicitly targeted read-only project", async () => {
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "delete",
      { path: "api/src/legacy.ts" },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "api",
            groupId: "macro-suite",
            mountName: "api",
            displayName: "API",
            workspacePath: "C:/dev/macro-api",
            isReadOnly: true,
          },
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
            isReadOnly: false,
          },
        ],
        workspacePathsByProjectId: {
          api: "C:/dev/macro-api",
          web: "C:/dev/macro-web",
        },
      },
    );

    expect(result).toBe(
      'Error executing delete: project "API" is read-only.'
    );
  });

  it("does not reroute an implicit virtual-root mutation away from the focused read-only project", async () => {
    const writes: string[] = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        executeWorkspaceTool: async () => "UNSUPPORTED_WORKSPACE_TOOL",
        validateToolExecution: async () => ({ allowed: true }),
        fsWriteFile: async ({ path }: { path: string }) => {
          writes.push(path);
          return { path, bytes_written: 0, created: true };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "write",
      { path: "src/new.ts", content: "export const value = 1;\n" },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "api",
            groupId: "macro-suite",
            mountName: "api",
            displayName: "API",
            workspacePath: "C:/dev/macro-api",
            isReadOnly: false,
          },
          {
            projectId: "web",
            groupId: "macro-suite",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
            isReadOnly: true,
          },
        ],
        workspacePathsByProjectId: {
          api: "C:/dev/macro-api",
          web: "C:/dev/macro-web",
        },
      },
    );

    expect(result).toBe(
      'Error executing write: project "Web App" is read-only.'
    );
    expect(writes).toEqual([]);
  });

  it("does not reroute a non-virtual mutation away from a read-only project", async () => {
    const writes: string[] = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsWriteFile: async ({ path }: { path: string }) => {
          writes.push(path);
          return { path, bytes_written: 0, created: true };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "write",
      { path: "src/new.ts", content: "export const value = 1;\n" },
      "Implement",
      {
        projectId: "web",
        focusedProjectId: "web",
        virtualRootEnabled: false,
        projectMounts: [
          {
            projectId: "api",
            mountName: "api",
            displayName: "API",
            workspacePath: "C:/dev/macro-api",
            isReadOnly: false,
          },
          {
            projectId: "web",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
            isReadOnly: true,
          },
        ],
        workspacePathsByProjectId: {
          api: "C:/dev/macro-api",
          web: "C:/dev/macro-web",
        },
      },
    );

    expect(result).toBe(
      'Error executing write: project "Web App" is read-only.'
    );
    expect(writes).toEqual([]);
  });

  it("rejects a non-virtual mutation when multiple projects exist without a resolved target", async () => {
    const writes: string[] = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsWriteFile: async ({ path }: { path: string }) => {
          writes.push(path);
          return { path, bytes_written: 0, created: true };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "write",
      { path: "src/new.ts", content: "export const value = 1;\n" },
      "Implement",
      {
        virtualRootEnabled: false,
        projectMounts: [
          {
            projectId: "api",
            mountName: "api",
            displayName: "API",
            workspacePath: "C:/dev/macro-api",
            isReadOnly: false,
          },
          {
            projectId: "web",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
            isReadOnly: false,
          },
        ],
      },
    );

    expect(result).toContain("select a project with project_id");
    expect(writes).toEqual([]);
  });

  it("rejects an ambiguous exact-text edit unless replace_all is true", async () => {
    const writes: string[] = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        executeWorkspaceTool: async () => "UNSUPPORTED_WORKSPACE_TOOL",
        validateToolExecution: async () => ({ allowed: true }),
        fsReadFileWithOptions: async () => ({
          content: "const value = 1;\nconst value = 1;\n",
          language: "typescript",
          is_binary: false,
          size: 34,
          encoding: "utf-8",
        }),
        fsWriteFile: async ({ content }: { content: string }) => {
          writes.push(content);
          return { path: "src/value.ts", bytes_written: content.length, created: false };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "edit",
      {
        path: "src/value.ts",
        old_text: "const value = 1;",
        new_text: "const value = 2;",
      },
      "Implement",
      { workspacePath: "C:/dev/macro-web" },
    );

    expect(result).toContain("old_text matched 2 locations");
    expect(result).toContain("replace_all");
    expect(writes).toEqual([]);
  });

  it("uses the revision read by edit when the caller omits expected_revision", async () => {
    let content = "export const value = 1;\n";
    const expectedRevisions: Array<string | null | undefined> = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        executeWorkspaceTool: async () => "UNSUPPORTED_WORKSPACE_TOOL",
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async () => true,
        fsReadFileWithOptions: async () => ({
          content,
          language: "typescript",
          is_binary: false,
          size: content.length,
          encoding: "utf-8",
          revision: content.includes("2") ? "updated-revision" : "read-revision",
        }),
        fsWriteFile: async ({
          content: nextContent,
          expectedRevision,
        }: {
          content: string;
          expectedRevision?: string | null;
        }) => {
          expectedRevisions.push(expectedRevision);
          content = nextContent;
          return {
            path: "src/value.ts",
            bytes_written: nextContent.length,
            created: false,
            revision: "updated-revision",
          };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "edit",
      {
        path: "src/value.ts",
        old_text: "value = 1",
        new_text: "value = 2",
      },
      "Implement",
      {
        workspacePath: "C:/dev/macro-web",
        onCodeCheckpoint: async () => undefined,
      },
    );

    expect(JSON.parse(result || "{}").ok).toBe(true);
    expect(expectedRevisions).toEqual(["read-revision"]);
  });

  it("rejects an unknown explicit project selector instead of using the focused project", async () => {
    const writes: string[] = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        fsWriteFile: async ({ path }: { path: string }) => {
          writes.push(path);
          return { path, bytes_written: 0, created: true };
        },
      },
    } as Partial<MockAppState>);

    await expect(
      executeWorkspaceTool(
        "write",
        { path: "src/config.ts", project_id: "weeb", content: "value" },
        "Implement",
        {
          focusedProjectId: "web",
          virtualRootEnabled: true,
          projectMounts: [
            {
              projectId: "api",
              mountName: "api",
              workspacePath: "C:/dev/macro-api",
            },
            {
              projectId: "web",
              mountName: "web",
              workspacePath: "C:/dev/macro-web",
            },
          ],
        },
      ),
    ).rejects.toThrow('Unknown project selector "weeb"');
    expect(writes).toEqual([]);
  });

  it("rolls back a write when its post-write validation read fails", async () => {
    let content = "before\n";
    let reads = 0;
    const checkpoints: unknown[] = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        executeWorkspaceTool: async () => "UNSUPPORTED_WORKSPACE_TOOL",
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async () => true,
        fsReadFileWithOptions: async () => {
          reads += 1;
          if (reads === 2) throw new Error("validation read failed");
          return {
            content,
            language: "text",
            is_binary: false,
            size: content.length,
            encoding: "utf-8",
            revision: reads === 1 ? "before-revision" : "restored-revision",
          };
        },
        fsWriteFile: async ({ content: nextContent }: { content: string }) => {
          content = nextContent;
          return {
            path: "src/value.txt",
            bytes_written: nextContent.length,
            created: false,
            revision: "applied-revision",
          };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "write",
      { path: "src/value.txt", content: "after\n" },
      "Implement",
      {
        workspacePath: "C:/dev/macro-web",
        onCodeCheckpoint: async (checkpoint: unknown) =>
          checkpoints.push(checkpoint),
      },
    );

    expect(result).toContain("mutation was reverted");
    expect(result).toContain("validation read failed");
    expect(content).toBe("before\n");
    expect(checkpoints).toEqual([]);
  });

  it("uses the guarded readback revision to compensate a write with a missing result revision", async () => {
    let content = "before\n";
    let reads = 0;
    let writes = 0;
    const checkpoints: unknown[] = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        executeWorkspaceTool: async () => "UNSUPPORTED_WORKSPACE_TOOL",
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async () => true,
        fsReadFileWithOptions: async () => {
          reads += 1;
          return {
            content,
            language: "text",
            is_binary: false,
            size: content.length,
            encoding: "utf-8",
            revision: reads === 1 ? "before-revision" : "guarded-readback-revision",
          };
        },
        fsWriteFile: async (params: {
          content: string;
          expectedRevision?: string | null;
        }) => {
          writes += 1;
          if (writes === 2) {
            expect(params.expectedRevision).toBe("guarded-readback-revision");
          }
          content = params.content;
          return {
            path: "src/value.txt",
            bytes_written: params.content.length,
            created: false,
            revision: writes === 1 ? null : "restored-revision",
          };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "write",
      { path: "src/value.txt", content: "after\n" },
      "Implement",
      {
        workspacePath: "C:/dev/macro-web",
        onCodeCheckpoint: async (checkpoint: unknown) =>
          checkpoints.push(checkpoint),
      },
    );

    expect(result).toContain("mutation was reverted");
    expect(result).toContain("did not return a content revision");
    expect(content).toBe("before\n");
    expect(checkpoints).toEqual([]);
  });

  it("reports a conflict instead of publishing a checkpoint when a virtual-root write is overwritten externally", async () => {
    let content = "export const value = 'base';\n";
    let revision = "base-revision";
    const checkpoints: unknown[] = [];
    const writes: Array<Record<string, unknown>> = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async () => true,
        fsReadFileWithOptions: async () => ({
          content,
          language: "typescript",
          is_binary: false,
          size: content.length,
          encoding: "utf-8",
          revision,
        }),
        fsWriteFile: async (params: {
          path: string;
          content: string;
          expectedRevision?: string | null;
        }) => {
          writes.push(params);
          if (
            params.expectedRevision === "macro-revision-1" &&
            revision === "external-revision"
          ) {
            throw new Error("revision conflict: external winner");
          }
          const macroRevision = "macro-revision-1";
          content = params.content;
          revision = macroRevision;
          queueMicrotask(() => {
            content = "export const value = 'external';\n";
            revision = "external-revision";
          });
          return {
            path: params.path,
            bytes_written: params.content.length,
            created: false,
            revision: macroRevision,
          };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "write",
      { path: "web/src/value.ts", content: "export const value = 'after';\n" },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "web",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: { web: "C:/dev/macro-web" },
        onCodeCheckpoint: async (checkpoint: unknown) =>
          checkpoints.push(checkpoint),
      },
    );

    expect(result).toContain('External modification detected for "web/src/value.ts"');
    expect(result).toContain("macro-revision-1");
    expect(result).toContain("external-revision");
    expect(result).toContain("No code checkpoint was published");
    expect(checkpoints).toEqual([]);
    expect(writes).toHaveLength(2);
    expect(content).toBe("export const value = 'external';\n");
    expect(revision).toBe("external-revision");
  });

  it("reports a conflict instead of publishing a checkpoint when an edit is overwritten externally", async () => {
    let content = "export const value = 1;\n";
    let revision = "read-revision";
    const checkpoints: unknown[] = [];
    const writes: string[] = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async () => true,
        fsReadFileWithOptions: async () => ({
          content,
          language: "typescript",
          is_binary: false,
          size: content.length,
          encoding: "utf-8",
          revision,
        }),
        fsWriteFile: async ({
          path,
          content: nextContent,
          expectedRevision,
        }: {
          path: string;
          content: string;
          expectedRevision?: string | null;
        }) => {
          writes.push(nextContent);
          if (
            expectedRevision === "edited-revision" &&
            revision === "external-revision"
          ) {
            throw new Error("revision conflict: external winner");
          }
          const macroRevision = "edited-revision";
          content = nextContent;
          revision = macroRevision;
          queueMicrotask(() => {
            content = "export const value = EXTERNAL;\n";
            revision = "external-revision";
          });
          return {
            path,
            bytes_written: nextContent.length,
            created: false,
            revision: macroRevision,
          };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "edit",
      {
        path: "src/value.ts",
        old_text: "value = 1",
        new_text: "value = 2",
      },
      "Implement",
      {
        workspacePath: "C:/dev/macro-web",
        onCodeCheckpoint: async (checkpoint: unknown) =>
          checkpoints.push(checkpoint),
      },
    );

    expect(result).toContain('External modification detected for "src/value.ts"');
    expect(result).toContain("edited-revision");
    expect(result).toContain("external-revision");
    expect(result).toContain("No code checkpoint was published");
    expect(checkpoints).toEqual([]);
    expect(writes).toEqual([
      "export const value = 2;\n",
      "export const value = 1;\n",
    ]);
    expect(content).toBe("export const value = EXTERNAL;\n");
    expect(revision).toBe("external-revision");
  });

  it("reports a conflict instead of publishing a delete checkpoint when the target reappears externally", async () => {
    let exists = true;
    const checkpoints: unknown[] = [];
    const writes: string[] = [];
    const deletes: string[] = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsStat: async (path: string) => ({
          path,
          name: "obsolete.ts",
          kind: "file",
          size: 20,
          modified: "2026-03-26T10:00:00.000Z",
          permissions: "rw-r--r--",
          language: "typescript",
          is_readonly: false,
          is_hidden: false,
          is_symlink: false,
        }),
        fsExists: async () => exists,
        fsReadFileWithOptions: async () => ({
          content: "first line\nsecond line\n",
          language: "typescript",
          is_binary: false,
          size: 23,
          encoding: "utf-8",
          revision: "current-revision",
        }),
        fsDelete: async ({ path }: { path: string }) => {
          deletes.push(path);
          exists = false;
          queueMicrotask(() => {
            exists = true;
          });
        },
        fsWriteFile: async ({
          content,
          expectedRevision,
        }: {
          content: string;
          expectedRevision?: string | null;
        }) => {
          writes.push(content);
          if (expectedRevision === "absent" && exists) {
            throw new Error("revision conflict: external file reappeared");
          }
          return {
            path: "C:/dev/macro-web/src/obsolete.ts",
            bytes_written: content.length,
            created: false,
            revision: "restored-revision",
          };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "delete",
      { path: "src/obsolete.ts" },
      "Implement",
      {
        workspacePath: "C:/dev/macro-web",
        onCodeCheckpoint: async (checkpoint: unknown) =>
          checkpoints.push(checkpoint),
      },
    );

    expect(result).toContain(
      'External modification detected for "src/obsolete.ts"',
    );
    expect(result).toContain("deleted path exists again");
    expect(result).toContain("No code checkpoint was published");
    expect(checkpoints).toEqual([]);
    expect(deletes).toHaveLength(1);
    expect(writes).toEqual(["first line\nsecond line\n"]);
  });

  it("reverts an apply_patch batch and keeps the external winner when one patched file diverges", async () => {
    const files = new Map<string, { content: string; revision: string }>();
    files.set("C:/dev/macro-web/src/a.ts", {
      content: "export const a = 'before';\n",
      revision: "before:a",
    });
    files.set("C:/dev/macro-web/src/b.ts", {
      content: "export const b = 'before';\n",
      revision: "before:b",
    });
    const checkpoints: unknown[] = [];
    const writes: Array<{
      path: string;
      content: string;
      expectedRevision?: string | null;
    }> = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async (path: string) => files.has(path),
        fsReadFileWithOptions: async ({ path }: { path: string }) => {
          const file = files.get(path);
          if (!file) throw new Error(`unexpected read: ${path}`);
          return {
            content: file.content,
            language: "typescript",
            is_binary: false,
            size: file.content.length,
            encoding: "utf-8",
            revision: file.revision,
          };
        },
        fsWriteFile: async ({
          path,
          content,
          expectedRevision,
        }: {
          path: string;
          content: string;
          expectedRevision?: string | null;
        }) => {
          writes.push({ path, content, expectedRevision });
          const current = files.get(path);
          if (
            expectedRevision &&
            expectedRevision !== "absent" &&
            (!current || current.revision !== expectedRevision)
          ) {
            throw new Error(`stale write refused for ${path}`);
          }
          const created = !current;
          const macroRevision = `applied:${writes.length}`;
          files.set(path, { content, revision: macroRevision });
          if (path.endsWith("b.ts")) {
            queueMicrotask(() => {
              files.set(path, {
                content: "export const b = 'EXTERNAL';\n",
                revision: "external:b",
              });
            });
          }
          return {
            path,
            bytes_written: content.length,
            created,
            revision: macroRevision,
          };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "apply_patch",
      {
        patch_text: [
          "*** Begin Patch",
          "*** Update File: web/src/a.ts",
          "@@",
          "-export const a = 'before';",
          "+export const a = 'after';",
          "*** Update File: web/src/b.ts",
          "@@",
          "-export const b = 'before';",
          "+export const b = 'after';",
          "*** End Patch",
        ].join("\n"),
      },
      "Implement",
      {
        groupId: "macro-suite",
        focusedProjectId: "web",
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: "web",
            mountName: "web",
            displayName: "Web App",
            workspacePath: "C:/dev/macro-web",
          },
        ],
        workspacePathsByProjectId: { web: "C:/dev/macro-web" },
        onCodeCheckpoint: async (checkpoint: unknown) =>
          checkpoints.push(checkpoint),
      },
    );

    expect(result).toContain("External modification detected");
    expect(result).toContain('"web/src/b.ts"');
    expect(result).toContain("rollback failed");
    expect(result).toContain("stale write refused");
    expect(checkpoints).toEqual([]);
    expect(files.get("C:/dev/macro-web/src/a.ts")?.content).toBe(
      "export const a = 'before';\n",
    );
    expect(files.get("C:/dev/macro-web/src/b.ts")?.content).toBe(
      "export const b = 'EXTERNAL';\n",
    );
    expect(files.get("C:/dev/macro-web/src/b.ts")?.revision).toBe("external:b");
    expect(writes.map((entry) => entry.path)).toEqual([
      "C:/dev/macro-web/src/a.ts",
      "C:/dev/macro-web/src/b.ts",
      "C:/dev/macro-web/src/b.ts",
      "C:/dev/macro-web/src/a.ts",
    ]);
    expect(writes[3].expectedRevision).toMatch(/^applied:/);
  });

  it("refuses remote mutations when recoverable checkpoints are required", async () => {
    let remoteExecutions = 0;
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      projectGroups: [],
      standaloneProjects: [],
      tauriModule: {
        isTauriAvailable: () => false,
      },
      remoteKernelModule: {
        canUseRemoteKernel: () => true,
        executeRemoteWorkspaceTool: async () => {
          remoteExecutions += 1;
          return "remote write";
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "write",
      { path: "src/value.ts", content: "value" },
      "Implement",
      {
        workspacePath: "/remote/workspace",
        onCodeCheckpoint: async () => undefined,
      },
    );

    expect(result).toContain("remote kernel cannot provide the before/after snapshots");
    expect(remoteExecutions).toBe(0);
  });

  it("rejects a stale edit before writing or publishing a checkpoint", async () => {
    const writes: string[] = [];
    const checkpoints: unknown[] = [];
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        executeWorkspaceTool: async () => "UNSUPPORTED_WORKSPACE_TOOL",
        validateToolExecution: async () => ({ allowed: true }),
        fsReadFileWithOptions: async () => ({
          content: "export const value = 1;\n",
          language: "typescript",
          is_binary: false,
          size: 24,
          encoding: "utf-8",
          revision: "current-revision",
        }),
        fsWriteFile: async ({ content }: { content: string }) => {
          writes.push(content);
          return { path: "src/value.ts", bytes_written: content.length, created: false };
        },
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "edit",
      {
        path: "src/value.ts",
        old_text: "value = 1",
        new_text: "value = 2",
        expected_revision: "stale-revision",
      },
      "Implement",
      {
        workspacePath: "C:/dev/macro-web",
        onCodeCheckpoint: async (checkpoint: unknown) => {
          checkpoints.push(checkpoint);
        },
      },
    );

    expect(result).toContain("Stale content for \"src/value.ts\"");
    expect(writes).toEqual([]);
    expect(checkpoints).toEqual([]);
  });

  it("returns a clear error when delete targets a directory", async () => {
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        executeWorkspaceTool: async () => "UNSUPPORTED_WORKSPACE_TOOL",
        fsStat: async (path: string) => ({
          path,
          name: "src",
          kind: "directory",
          size: 0,
          modified: "2026-03-26T10:00:00.000Z",
          permissions: "rwxr-xr-x",
          language: null,
          is_readonly: false,
          is_hidden: false,
          is_symlink: false,
        }),
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      "delete",
      { path: "src", project_id: "web" },
      "Implement",
      {
        projectId: "web",
        focusedProjectId: "web",
        defaultWorkspacePath: "C:/worktrees/web-task",
        workspacePathsByProjectId: {
          web: "C:/worktrees/web-task",
        },
      },
    );

    expect(result).toBe(
      "Cannot delete directory with delete tool: src. Only files are supported."
    );
  });

  afterAll(() => {
    mock.restore();
  });
});
