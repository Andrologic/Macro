import { describe, expect, it, mock } from 'bun:test';

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
      selectedProjectId: null,
      selectedGroupId: null,
      projectGroups: [],
    }),
  },
}));

const loadWorkspaceToolExecutor = () => import('./workspaceToolExecutor');

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
});
