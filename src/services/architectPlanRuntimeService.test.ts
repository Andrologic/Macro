import { describe, expect, it, mock } from 'bun:test';

const actualTauriIpc = await import('./tauriIpc');
const files = new Map<string, string>();

mock.module('./tauriIpc', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  workspaceGetActiveRoot: async () => 'C:/repo',
  fsReadFileWithOptions: async ({ path }: { path: string }) => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    return { content };
  },
  fsWriteFile: async ({ path, content }: { path: string; content: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    files.set(path, content);
    return { path, bytes_written: content.length, created: true, skipped: false };
  },
}));

const { updateArchitectPlanRuntime, readArchitectPlanRuntime } =
  await import('./architectPlanRuntimeService');

describe('architectPlanRuntimeService', () => {
  it('serializes concurrent read-modify-write updates for one plan', async () => {
    files.clear();
    const base = { branchName: 'develop', plan: { id: 'plan-1', projectIds: [] } };

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
});
