import { afterEach, describe, expect, it, mock } from 'bun:test';
import { useAppStore } from '../stores/useAppStore';

const actualTauriIpc = await import('./tauriIpc');
const files = new Map<string, string>();
const workspaceScopes: Array<string | undefined> = [];
const workspacePaths: Array<string | undefined> = [];

mock.module('./tauriIpc', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  workspaceGetActiveRoot: async () => 'C:/repo',
  fsReadFileWithOptions: async ({ path, workspaceScope }: { path: string; workspaceScope?: string }) => {
    workspaceScopes.push(workspaceScope);
    const content = files.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    return { content };
  },
  fsWriteFile: async ({ path, content, workspaceScope, workspacePath }: { path: string; content: string; workspaceScope?: string; workspacePath?: string }) => {
    workspaceScopes.push(workspaceScope);
    workspacePaths.push(workspacePath);
    await new Promise((resolve) => setTimeout(resolve, 5));
    files.set(path, content);
    return { path, bytes_written: content.length, created: true, skipped: false };
  },
}));

const { updateArchitectPlanRuntime, readArchitectPlanRuntime } =
  await import('./architectPlanRuntimeService');

describe('architectPlanRuntimeService', () => {
  afterEach(() => {
    useAppStore.setState({ standaloneProjects: [], projectGroups: [] });
  });
  it('serializes concurrent read-modify-write updates for one plan', async () => {
    files.clear();
    useAppStore.setState({
      standaloneProjects: [{
        id: 'project-1',
        name: 'Project',
        mountName: 'project',
        path: 'C:/repo',
        created_at: '',
        status: 'active',
        metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
      }],
      projectGroups: [],
    });
    const base = { branchName: 'develop', plan: { id: 'plan-1', projectIds: ['project-1'] } };

    await Promise.all([
      updateArchitectPlanRuntime({
        ...base,
        update: (record) => ({
          ...record,
          mergeWorkflows: { ...record.mergeWorkflows, first: { taskId: 'first' } as never },
        }),
      }),
      updateArchitectPlanRuntime({
        ...base,
        update: (record) => ({
          ...record,
          mergeWorkflows: { ...record.mergeWorkflows, second: { taskId: 'second' } as never },
        }),
      }),
    ]);

    const persisted = await readArchitectPlanRuntime({
      branchName: 'develop',
      planId: 'plan-1',
      repoPaths: ['C:/repo'],
    });
    expect(Object.keys(persisted?.mergeWorkflows ?? {}).sort()).toEqual(['first', 'second']);
  });

  it('keeps a persisted direct plan runtime in the project .macro scope after Git appears', async () => {
    files.clear();
    workspaceScopes.length = 0;
    workspacePaths.length = 0;
    useAppStore.setState({
      standaloneProjects: [{
        id: 'project-direct',
        name: 'Direct project',
        mountName: 'direct-project',
        path: 'C:/direct-project',
        created_at: '',
        status: 'active',
        gitSetupState: 'ready',
        directEdit: true,
        metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
      }],
      projectGroups: [],
    });

    await updateArchitectPlanRuntime({
      branchName: 'develop',
      plan: {
        id: 'plan-direct',
        projectIds: ['project-direct'],
        executionModesByProjectId: { 'project-direct': 'direct' },
      },
      repoPaths: ['C:/old-direct-project'],
      update: (record) => record,
    });

    expect(workspaceScopes).toContain('direct');
    expect(workspaceScopes).not.toContain('metadata');
    expect(workspacePaths).toEqual(['C:/direct-project']);
  });
});
