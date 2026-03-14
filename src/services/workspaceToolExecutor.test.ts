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
          path: 'C:/dev/macro-api',
        },
        {
          id: 'web',
          name: 'Web App',
          path: 'C:/dev/macro-web',
        },
      ],
    },
  ],
};

const registerWorkspaceToolExecutorMocks = (appState: Partial<MockAppState> = {}) => {
  mock.restore();
  mock.module('./tauriIpc', () => ({
    isTauriAvailable: () => false,
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

  afterAll(() => {
    mock.restore();
  });
});
