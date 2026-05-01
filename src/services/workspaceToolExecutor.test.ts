import { afterAll, describe, expect, it, mock } from "bun:test";
const actualTauriIpc = await import("./tauriIpc");

type MockAppState = {
  selectedProjectId: string | null;
  selectedGroupId: string | null;
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
  const tauriModule =
    (appState as { tauriModule?: Record<string, unknown> }).tauriModule || {};
  mock.module("./tauriIpc", () => ({
    ...actualTauriIpc,
    isTauriAvailable: () => false,
    validateToolExecution: async () => ({ allowed: true }),
    executeWorkspaceTool: async () => "UNSUPPORTED_WORKSPACE_TOOL",
    fsListDir: async () => [],
    fsExists: async () => false,
    fsReadFileWithOptions: async () => ({
      content: "",
      language: "text",
      is_binary: false,
      size: 0,
      encoding: "utf-8",
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
    }),
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
      assertPathAllowed("Architect", "branches/main/plans/plan-1/plan.md"),
    ).not.toThrow();
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

  it("routes a prefixed relative path to the matching subproject workspace", async () => {
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

  it("falls back to the focused subproject inside the selected global project", async () => {
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

  it("lists a virtual root containing only subproject mounts", async () => {
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

  it("fans out glob results across subprojects and prefixes virtual paths", async () => {
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

  it("resolves read operations against the focused subproject before cross-mount search", async () => {
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
    expect(result).toContain("export const App = 'web';");
  });

  it("routes git_merge through the selected subproject repository in virtual-root mode", async () => {
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        gitMerge: async ({
          repoPath,
          branchName,
          intoBranch,
        }: {
          repoPath: string;
          branchName: string;
          intoBranch: string;
        }) => `merged ${branchName} into ${intoBranch} at ${repoPath}`,
        gitStatus: async (repoPath: string) => ({
          branch: repoPath === "C:/dev/macro-web" ? "develop" : "unknown",
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

  it("applies apply_patch in virtual-root mode and returns validation details", async () => {
    const writes: Array<{ path: string; content: string }> = [];
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
        }: {
          path: string;
          content: string;
        }) => {
          writes.push({ path, content });
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
    expect(deletes).toEqual([]);
  });

  it("rolls back earlier apply_patch writes when a later virtual-root write fails", async () => {
    let appContent = "export const App = 'before';\n";
    const writes: Array<{ path: string; content: string }> = [];
    const deletes: string[] = [];

    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async (path: string) => path === "C:/dev/macro-web/src/App.tsx",
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
    expect(deletes).toEqual([]);
  });

  it("deletes a file from the routed worktree workspace", async () => {
    const deletes: string[] = [];

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
        fsDelete: async ({ path }: { path: string }) => {
          deletes.push(path);
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
    expect(deletes).toEqual(["C:/worktrees/web-task/src/obsolete.ts"]);
  });

  it("rejects delete on an explicitly targeted read-only subproject", async () => {
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
      'Error executing delete: subproject "API" is read-only.'
    );
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
