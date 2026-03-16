import { afterAll, describe, expect, it, mock } from 'bun:test';

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
      id: 'macro-suite',
      name: 'Macro Suite',
      isOpen: true,
      projects: [
        {
          id: 'api',
          name: 'API',
          mountName: 'api',
          path: 'C:/dev/macro-api',
        },
        {
          id: 'web',
          name: 'Web App',
          mountName: 'web',
          path: 'C:/dev/macro-web',
        },
      ],
    },
  ],
};

const registerWorkspaceToolExecutorMocks = (appState: Partial<MockAppState> = {}) => {
  mock.restore();
  const tauriModule = (appState as { tauriModule?: Record<string, unknown> }).tauriModule || {};
  mock.module('./tauriIpc', () => ({
    isTauriAvailable: () => false,
    validateToolExecution: async () => ({ allowed: true }),
    executeWorkspaceTool: async () => 'UNSUPPORTED_WORKSPACE_TOOL',
    fsListDir: async () => [],
    fsExists: async () => false,
    fsReadFileWithOptions: async () => ({
      content: '',
      language: 'text',
      is_binary: false,
      size: 0,
      encoding: 'utf-8',
    }),
    fsWriteFile: async ({ path }: { path: string }) => ({
      path,
      bytes_written: 0,
      created: false,
    }),
    gitStatus: async () => ({
      branch: 'main',
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
    gitDiff: async () => '',
    gitGetTree: async () => ({ branch: 'main', structure: [], modified_files_count: 0 }),
    gitAdd: async () => undefined,
    gitCommit: async () => 'commit-hash',
    gitCheckout: async () => undefined,
    gitMerge: async () => 'merged',
    gitReset: async () => undefined,
    gitStash: async () => 'stash@{0}',
    ...tauriModule,
  }));

  mock.module('./remoteKernelApi', () => ({
    canUseRemoteKernel: () => false,
    executeRemoteWorkspaceTool: async () => '',
    validateRemoteToolExecution: async () => ({
      allowed: true,
      enforce_macro_only_writes: false,
    }),
  }));

  mock.module('../stores/useAppStore', () => ({
    useAppStore: {
      getState: () => ({
        ...defaultAppState,
        ...appState,
      }),
    },
  }));
};

let workspaceToolExecutorImportCounter = 0;

const loadWorkspaceToolExecutor = async (appState?: Partial<MockAppState>) => {
  registerWorkspaceToolExecutorMocks(appState);
  workspaceToolExecutorImportCounter += 1;
  return import(`./workspaceToolExecutor.ts?test=${workspaceToolExecutorImportCounter}`);
};

describe('workspaceToolExecutor helpers', () => {
  it('flags write tools correctly', async () => {
    const { isWriteTool } = await loadWorkspaceToolExecutor();

    expect(isWriteTool('write')).toBe(true);
    expect(isWriteTool('edit')).toBe(true);
    expect(isWriteTool('read')).toBe(false);
    expect(isWriteTool('git_commit')).toBe(false);
    expect(isWriteTool('git_add')).toBe(false);
  });

  it('enforces architect write path scope', async () => {
    const { assertPathAllowed } = await loadWorkspaceToolExecutor();

    expect(() => assertPathAllowed('Architect', 'branches/main/plans/plan-1/plan.md')).not.toThrow();
    expect(() => assertPathAllowed('Architect', 'src/App.tsx')).toThrow();
    expect(() => assertPathAllowed('Chat', 'src/App.tsx')).not.toThrow();
  });

  it('matches glob patterns', async () => {
    const { globToRegex, pathMatchesGlob } = await loadWorkspaceToolExecutor();

    const regex = globToRegex('src/**/*.ts');
    expect(regex.test('src/services/toolModePolicy.ts')).toBe(true);
    expect(pathMatchesGlob('src/services/toolModePolicy.ts', 'src/**/*.ts')).toBe(true);
    expect(pathMatchesGlob('src/components/App.tsx', 'src/**/*.ts')).toBe(false);
  });

  it('routes a prefixed relative path to the matching subproject workspace', async () => {
    const { resolveToolWorkspaceRouting } = await loadWorkspaceToolExecutor();

    const routing = resolveToolWorkspaceRouting(
      'read',
      { path: 'api/src/server.ts' },
      {
        projectId: 'web',
        defaultWorkspacePath: 'C:/dev/macro-web',
        workspacePathsByProjectId: {
          api: 'C:/worktrees/api-task',
          web: 'C:/worktrees/web-task',
        },
      }
    );

    expect(routing.projectId).toBe('api');
    expect(routing.workspacePath).toBe('C:/worktrees/api-task');
    expect(routing.args).toEqual({ path: 'src/server.ts' });
  });

  it('uses explicit project_id for git tools', async () => {
    const { resolveToolWorkspaceRouting } = await loadWorkspaceToolExecutor();

    const routing = resolveToolWorkspaceRouting(
      'git_status',
      { project_id: 'web' },
      {
        workspacePathsByProjectId: {
          api: 'C:/worktrees/api-task',
          web: 'C:/worktrees/web-task',
        },
      }
    );

    expect(routing.projectId).toBe('web');
    expect(routing.workspacePath).toBe('C:/worktrees/web-task');
    expect(routing.args).toEqual({});
  });

  it('falls back to the focused subproject inside the selected global project', async () => {
    const { resolveToolWorkspaceRouting } = await loadWorkspaceToolExecutor({
      selectedGroupId: 'macro-suite',
      selectedProjectId: 'web',
    });

    const routing = resolveToolWorkspaceRouting(
      'read',
      { path: 'src/App.tsx' },
      {
        groupId: 'macro-suite',
      }
    );

    expect(routing.projectId).toBeNull();
    expect(routing.workspacePath).toBe('C:/dev/macro-web');
    expect(routing.args).toEqual({ path: 'src/App.tsx' });
  });

  it('lists a virtual root containing only subproject mounts', async () => {
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      'list',
      { path: '.' },
      'Implement',
      {
        groupId: 'macro-suite',
        focusedProjectId: 'web',
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: 'api',
            groupId: 'macro-suite',
            mountName: 'api',
            displayName: 'API',
            workspacePath: 'C:/dev/macro-api',
          },
          {
            projectId: 'web',
            groupId: 'macro-suite',
            mountName: 'web',
            displayName: 'Web App',
            workspacePath: 'C:/dev/macro-web',
          },
        ],
        workspacePathsByProjectId: {
          api: 'C:/dev/macro-api',
          web: 'C:/dev/macro-web',
        },
      }
    );

    const parsed = JSON.parse(result || '{}');
    expect(parsed.virtual_root).toBe(true);
    expect(parsed.entries.map((entry: { path: string }) => entry.path)).toEqual(['api', 'web']);
  });

  it('fans out glob results across subprojects and prefixes virtual paths', async () => {
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsListDir: async ({ path }: { path: string }) => {
          if (path === 'C:/dev/macro-api') {
            return [
              {
                path: 'C:/dev/macro-api/src/server.ts',
                relative_path: 'src/server.ts',
                name: 'server.ts',
                kind: 'file',
                is_hidden: false,
                is_readonly: false,
              },
            ];
          }
          if (path === 'C:/dev/macro-web') {
            return [
              {
                path: 'C:/dev/macro-web/src/App.tsx',
                relative_path: 'src/App.tsx',
                name: 'App.tsx',
                kind: 'file',
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
      'glob',
      { pattern: '**/*.*' },
      'Implement',
      {
        groupId: 'macro-suite',
        focusedProjectId: 'web',
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: 'api',
            groupId: 'macro-suite',
            mountName: 'api',
            displayName: 'API',
            workspacePath: 'C:/dev/macro-api',
          },
          {
            projectId: 'web',
            groupId: 'macro-suite',
            mountName: 'web',
            displayName: 'Web App',
            workspacePath: 'C:/dev/macro-web',
          },
        ],
        workspacePathsByProjectId: {
          api: 'C:/dev/macro-api',
          web: 'C:/dev/macro-web',
        },
      }
    );

    const parsed = JSON.parse(result || '{}');
    expect(parsed.paths).toEqual(['api/src/server.ts', 'web/src/App.tsx']);
  });

  it('resolves read operations against the focused subproject before cross-mount search', async () => {
    const { executeWorkspaceTool } = await loadWorkspaceToolExecutor({
      tauriModule: {
        isTauriAvailable: () => true,
        validateToolExecution: async () => ({ allowed: true }),
        fsExists: async (path: string) => path === 'C:/dev/macro-web/src/App.tsx',
        fsReadFileWithOptions: async ({ path }: { path: string }) => ({
          content: path === 'C:/dev/macro-web/src/App.tsx' ? "export const App = 'web';" : '',
          language: 'typescript',
          is_binary: false,
          size: 25,
          encoding: 'utf-8',
        }),
      },
    } as Partial<MockAppState>);

    const result = await executeWorkspaceTool(
      'read',
      { path: 'src/App.tsx' },
      'Implement',
      {
        groupId: 'macro-suite',
        focusedProjectId: 'web',
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: 'api',
            groupId: 'macro-suite',
            mountName: 'api',
            displayName: 'API',
            workspacePath: 'C:/dev/macro-api',
          },
          {
            projectId: 'web',
            groupId: 'macro-suite',
            mountName: 'web',
            displayName: 'Web App',
            workspacePath: 'C:/dev/macro-web',
          },
        ],
        workspacePathsByProjectId: {
          api: 'C:/dev/macro-api',
          web: 'C:/dev/macro-web',
        },
      }
    );

    expect(result).toContain('FILE: web/src/App.tsx');
    expect(result).toContain('PROJECT_ID: web');
    expect(result).toContain("export const App = 'web';");
  });

  it('routes git_merge through the selected subproject repository in virtual-root mode', async () => {
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
          branch: repoPath === 'C:/dev/macro-web' ? 'develop' : 'unknown',
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
      'git_merge',
      { project_id: 'web', branch_name: 'feature/auth', into_branch: 'develop' },
      'Implement',
      {
        groupId: 'macro-suite',
        focusedProjectId: 'api',
        virtualRootEnabled: true,
        projectMounts: [
          {
            projectId: 'api',
            groupId: 'macro-suite',
            mountName: 'api',
            displayName: 'API',
            workspacePath: 'C:/dev/macro-api',
          },
          {
            projectId: 'web',
            groupId: 'macro-suite',
            mountName: 'web',
            displayName: 'Web App',
            workspacePath: 'C:/dev/macro-web',
          },
        ],
        workspacePathsByProjectId: {
          api: 'C:/dev/macro-api',
          web: 'C:/dev/macro-web',
        },
      }
    );

    const parsed = JSON.parse(result || '{}');
    expect(parsed.project_id).toBe('web');
    expect(parsed.mount_name).toBe('web');
    expect(parsed.repo_path).toBe('web');
    expect(parsed.branch).toBe('develop');
    expect(parsed.merged_branch).toBe('feature/auth');
    expect(parsed.into_branch).toBe('develop');
    expect(parsed.output).toContain('C:/dev/macro-web');
  });

  afterAll(() => {
    mock.restore();
  });
});
