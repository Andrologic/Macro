import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import {
  getPlanArtifactContentPath,
  getPlanArtifactIndexPath,
  listPlanArtifactOverview,
  listVisibleTaskArtifactReviewEntries,
  normalizeArtifactContracts,
  PlanTaskArtifactIndexReadError,
  putTaskArtifact,
  readPlanTaskArtifactIndex,
  readVisibleTaskArtifactDiff,
  resolveTaskArtifactTarget,
  resolveVisiblePlanTaskIds,
  unvalidateVisibleTaskArtifact,
  validateVisibleTaskArtifact,
} from './architectPlanArtifactService';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import { useAppStore } from '../stores/useAppStore';

const createPlan = (): Pick<ArchitectPlanRecord, 'nodes'> => ({
  nodes: [
    {
      id: 'audit',
      title: 'Audit',
      type: 'task',
      status: 'completed',
      dependencies: [],
    },
    {
      id: 'api',
      title: 'API',
      type: 'task',
      status: 'completed',
      dependencies: ['audit'],
    },
    {
      id: 'ui',
      title: 'UI',
      type: 'task',
      status: 'completed',
      dependencies: ['audit'],
    },
    {
      id: 'e2e',
      title: 'E2E',
      type: 'task',
      status: 'pending',
      dependencies: ['api', 'ui'],
    },
    {
      id: 'docs',
      title: 'Docs',
      type: 'task',
      status: 'pending',
      dependencies: [],
    },
  ],
});

const visibleIds = (params: Parameters<typeof resolveVisiblePlanTaskIds>[0]) =>
  [...resolveVisiblePlanTaskIds(params)].sort();

const emptyProjectMetadata = {
  description: '',
  tags: [],
  team_members: [],
  api_contracts: [],
  dependencies: [],
};

describe('architectPlanArtifactService visibility', () => {
  it('includes the current task, direct parents, and grandparents', () => {
    expect(
      visibleIds({
        plan: createPlan(),
        task: { id: 'api', dependencies: ['audit'], task_source: 'architect' },
      }),
    ).toEqual(['api', 'audit']);

    expect(
      visibleIds({
        plan: createPlan(),
        task: { id: 'e2e', dependencies: ['api', 'ui'], task_source: 'architect' },
      }),
    ).toEqual(['api', 'audit', 'e2e', 'ui']);
  });

  it('excludes siblings, descendants, and unrelated tasks', () => {
    expect(
      visibleIds({
        plan: createPlan(),
        task: { id: 'api', dependencies: ['audit'], task_source: 'architect' },
      }),
    ).not.toContain('ui');
    expect(
      visibleIds({
        plan: createPlan(),
        task: { id: 'api', dependencies: ['audit'], task_source: 'architect' },
      }),
    ).not.toContain('e2e');
    expect(
      visibleIds({
        plan: createPlan(),
        task: { id: 'api', dependencies: ['audit'], task_source: 'architect' },
      }),
    ).not.toContain('docs');
  });

  it('allows the synthetic finalization task to see leaves and their ancestors', () => {
    expect(
      visibleIds({
        plan: createPlan(),
        task: {
          id: 'plan-finalization-plan-1',
          dependencies: ['e2e', 'docs'],
          task_source: 'plan_finalization',
        },
      }),
    ).toEqual(['api', 'audit', 'docs', 'e2e', 'ui']);
  });

  it('does not expose inherited artifacts for standalone tasks', () => {
    expect(
      visibleIds({
        plan: createPlan(),
        task: { id: 'api', dependencies: ['audit'], task_source: 'standalone' },
      }),
    ).toEqual([]);
  });
});

describe('architectPlanArtifactService artifact contracts', () => {
  it('treats all Architect-declared artifact contracts as required', () => {
    expect(
      normalizeArtifactContracts({
        artifactContracts: [
          {
            id: 'required-map',
            title: 'Migration map',
            kind: 'migration_map',
            required: true,
          },
          {
            id: 'legacy-optional',
            title: 'Legacy optional note',
            kind: 'note',
            required: false,
          },
          {
            id: 'missing-required',
            title: 'Missing required field',
            kind: 'audit',
          } as never,
        ],
      }).map((contract) => ({
        id: contract.id,
        required: contract.required,
      })),
    ).toEqual([
      { id: 'required-map', required: true },
      { id: 'legacy-optional', required: true },
      { id: 'missing-required', required: true },
    ]);
  });
});

describe('architectPlanArtifactService reviews and versions', () => {
  const branchName = 'feature/artifacts';
  const plan = {
    id: 'plan-1',
    status: 'active',
    projectIds: ['project-1'],
    nodes: createPlan().nodes,
  } as unknown as ArchitectPlanRecord;
  const apiTask = {
    id: 'api',
    title: 'API',
    task_source: 'architect',
    plan_id: 'plan-1',
    plan_storage_branch: branchName,
    plan_target_branch: branchName,
    dependencies: ['audit'],
    execution_targets: [],
  } as unknown as CatalogedImplementTask;
  const uiTask = {
    ...apiTask,
    id: 'ui',
    title: 'UI',
    dependencies: ['audit'],
  } as CatalogedImplementTask;
  const files = new Map<string, string>();

  beforeEach(() => {
    files.clear();
    installTauriRuntimeMock(mock(async (command, payload) => {
      if (command === 'workspace_get_active_root') {
        return '/workspace';
      }
      if (command === 'fs_exists') {
        const path = String(payload?.path || '');
        const workspacePath = String(payload?.workspacePath || '');
        return files.has(`${workspacePath}::${path}`) || files.has(path);
      }
      if (command === 'fs_read_file') {
        const path = String(payload?.path || '');
        const workspacePath = String(payload?.workspacePath || '');
        const scopedPath = `${workspacePath}::${path}`;
        if (files.has(scopedPath)) {
          return { content: files.get(scopedPath) };
        }
        if (!files.has(path)) {
          throw new Error(`missing ${path}`);
        }
        return { content: files.get(path) };
      }
      if (command === 'fs_write_file') {
        files.set(String(payload?.path || ''), String(payload?.content || ''));
        return {};
      }
      return undefined;
    }));
  });

  afterEach(() => {
    removeTauriRuntimeMock();
    useAppStore.setState({
      standaloneProjects: [],
      projectGroups: [],
      selectedProjectId: null,
      selectedGroupId: null,
    });
  });

  const seedParentArtifact = () => {
    const indexPath = getPlanArtifactIndexPath(branchName, plan.id);
    const contentPath = getPlanArtifactContentPath(
      branchName,
      plan.id,
      'audit',
      'audit-findings',
      'markdown',
    );
    files.set(contentPath, '# Findings\n\nParent version.\n');
    files.set(indexPath, `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.id,
      updatedAt: '2026-05-26T00:00:00.000Z',
      artifacts: [
        {
          id: 'audit-findings',
          planId: plan.id,
          taskId: 'audit',
          kind: 'audit',
          title: 'Audit findings',
          summary: 'Parent summary',
          contentType: 'markdown',
          path: contentPath,
          contentHash: 'parent',
          createdAt: '2026-05-26T00:00:00.000Z',
          updatedAt: '2026-05-26T00:00:00.000Z',
          createdBy: 'agent',
        },
      ],
      reviews: [],
    }, null, 2)}\n`);
  };

  it('refuses to treat a corrupt existing index as an empty index', async () => {
    const indexPath = getPlanArtifactIndexPath(branchName, plan.id);
    files.set(indexPath, '{not valid json');

    await expect(readPlanTaskArtifactIndex({
      branchName,
      planId: plan.id,
      projectIds: plan.projectIds,
    })).rejects.toBeInstanceOf(PlanTaskArtifactIndexReadError);

    expect(files.get(indexPath)).toBe('{not valid json');

    files.set(indexPath, JSON.stringify({ planId: plan.id, artifacts: 'not an array' }));
    await expect(readPlanTaskArtifactIndex({
      branchName,
      planId: plan.id,
      projectIds: plan.projectIds,
    })).rejects.toBeInstanceOf(PlanTaskArtifactIndexReadError);
  });

  it('serializes concurrent task artifact writes without id collisions or lost updates', async () => {
    const [apiArtifact, uiArtifact] = await Promise.all([
      putTaskArtifact({
        target: { branchName, plan, task: apiTask, currentTask: apiTask },
        args: { title: 'Notes', kind: 'note', content: 'API notes' },
      }),
      putTaskArtifact({
        target: { branchName, plan, task: uiTask, currentTask: uiTask },
        args: { title: 'Notes', kind: 'note', content: 'UI notes' },
      }),
    ]);

    expect([apiArtifact.id, uiArtifact.id].sort()).toEqual(['api-notes', 'ui-notes']);
    const index = await readPlanTaskArtifactIndex({
      branchName,
      planId: plan.id,
      projectIds: plan.projectIds,
    });
    expect(index.artifacts.map((artifact) => artifact.id).sort()).toEqual([
      'api-notes',
      'ui-notes',
    ]);
  });

  it('stores descendant edits as a new artifact that supersedes the visible parent', async () => {
    seedParentArtifact();

    const artifact = await putTaskArtifact({
      target: {
        branchName,
        plan,
        task: apiTask,
        currentTask: apiTask,
      },
      args: {
        title: 'Audit findings update',
        summary: 'API task adjustments',
        kind: 'audit',
        content: '# Findings\n\nChild version.\n',
        supersedes_artifact_id: 'audit-findings',
      },
    });

    expect(artifact.taskId).toBe('api');
    expect(artifact.supersedes).toBe('audit-findings');

    const index = await readPlanTaskArtifactIndex({
      branchName,
      planId: plan.id,
      projectIds: plan.projectIds,
    });
    expect(index.artifacts.map((candidate) => candidate.id).sort()).toEqual([
      'audit-findings',
      artifact.id,
    ].sort());

    const diff = await readVisibleTaskArtifactDiff({
      branchName,
      plan,
      task: apiTask,
      artifactId: artifact.id,
    });
    expect(diff.status).toBe('modified');
    expect(diff.previousArtifact?.id).toBe('audit-findings');
    expect(diff.previousContent).toContain('Parent version');
    expect(diff.content).toContain('Child version');
  });

  it('tracks validation per consuming task without changing artifact content', async () => {
    seedParentArtifact();

    let entries = await listVisibleTaskArtifactReviewEntries({
      branchName,
      plan,
      task: apiTask,
    });
    expect(entries.find((entry) => entry.artifact.id === 'audit-findings')?.hasPendingReview).toBe(true);

    await validateVisibleTaskArtifact({
      branchName,
      plan,
      task: apiTask,
      artifactId: 'audit-findings',
    });
    entries = await listVisibleTaskArtifactReviewEntries({
      branchName,
      plan,
      task: apiTask,
    });
    expect(entries.find((entry) => entry.artifact.id === 'audit-findings')?.hasValidatedReview).toBe(true);

    await unvalidateVisibleTaskArtifact({
      branchName,
      plan,
      task: apiTask,
      artifactId: 'audit-findings',
    });
    entries = await listVisibleTaskArtifactReviewEntries({
      branchName,
      plan,
      task: apiTask,
    });
    expect(entries.find((entry) => entry.artifact.id === 'audit-findings')?.hasPendingReview).toBe(true);
  });

  it('lists produced and still-expected artifacts for a whole plan', async () => {
    const indexPath = getPlanArtifactIndexPath(branchName, plan.id);
    const contentPath = getPlanArtifactContentPath(
      branchName,
      plan.id,
      'api',
      'api-contract',
      'markdown',
    );
    files.set(contentPath, '# API\n');
    files.set(indexPath, `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.id,
      updatedAt: '2026-05-26T00:00:00.000Z',
      artifacts: [
        {
          id: 'api-contract',
          planId: plan.id,
          taskId: 'api',
          kind: 'contract',
          title: 'API contract',
          summary: 'Produced contract',
          contentType: 'markdown',
          path: contentPath,
          contentHash: 'api',
          createdAt: '2026-05-26T00:00:00.000Z',
          updatedAt: '2026-05-26T00:00:00.000Z',
          createdBy: 'agent',
          contractId: 'api-contract',
        },
      ],
      reviews: [
        {
          artifactId: 'api-contract',
          taskId: 'api',
          validatedAt: '2026-05-26T00:01:00.000Z',
        },
      ],
    }, null, 2)}\n`);

    const overview = await listPlanArtifactOverview({
      branchName,
      plan: {
        ...plan,
        nodes: [
          {
            id: 'api',
            title: 'API',
            artifactContracts: [
              {
                id: 'api-contract',
                title: 'API contract',
                kind: 'contract',
              },
            ],
          },
          {
            id: 'ui',
            title: 'UI',
            artifactContracts: [
              {
                id: 'ui-map',
                title: 'UI map',
                kind: 'diagram',
              },
            ],
          },
        ],
      } as unknown as ArchitectPlanRecord,
    });

    expect(overview.entries.map((entry) => entry.artifact.id)).toEqual(['api-contract']);
    expect(overview.entries[0]?.hasValidatedReview).toBe(true);
    expect(overview.expected.map((item) => item.contract.id)).toEqual(['ui-map']);
    expect(overview.expected[0]?.taskTitle).toBe('UI');
  });

  it('loads plan artifacts from the restored standalone project when persisted project ids are stale', async () => {
    useAppStore.setState({
      standaloneProjects: [
        {
          id: 'project-octan-sales',
          name: 'octan_sales',
          mountName: 'octan_sales',
          path: '/repos/octan_sales',
          created_at: '2026-06-05T00:00:00.000Z',
          status: 'active',
          metadata: emptyProjectMetadata,
        },
      ],
      projectGroups: [],
      selectedProjectId: 'project-octan-sales',
      selectedGroupId: null,
    });

    const indexPath = getPlanArtifactIndexPath(branchName, plan.id);
    files.set(`/repos/octan_sales::${indexPath}`, `${JSON.stringify({
      schemaVersion: 1,
      planId: plan.id,
      updatedAt: '2026-06-05T00:00:00.000Z',
      artifacts: [
        {
          id: 'migration-map',
          planId: plan.id,
          taskId: 'api',
          kind: 'map',
          title: 'Migration map',
          summary: 'Physical artifact from @macro',
          contentType: 'markdown',
          path: getPlanArtifactContentPath(
            branchName,
            plan.id,
            'api',
            'migration-map',
            'markdown',
          ),
          contentHash: 'map',
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:00.000Z',
          createdBy: 'agent',
        },
      ],
      reviews: [],
    }, null, 2)}\n`);

    const overview = await listPlanArtifactOverview({
      branchName,
      plan: {
        ...plan,
        projectId: 'project-lplr-app-old',
        projectIds: ['project-lplr-app-old'],
        availableProjectIds: ['project-octan-sales'],
        nodes: [
          {
            id: 'api',
            title: 'API',
            artifactContracts: [],
          },
        ],
      } as unknown as ArchitectPlanRecord,
    });

    expect(overview.entries.map((entry) => entry.artifact.id)).toEqual(['migration-map']);
  });

  it('retargets raw artifact tool plans to the current standalone project at runtime', async () => {
    useAppStore.setState({
      standaloneProjects: [
        {
          id: 'project-octan-sales',
          name: 'octan_sales',
          mountName: 'octan_sales',
          path: '/repos/octan_sales',
          created_at: '2026-06-05T00:00:00.000Z',
          status: 'active',
          metadata: emptyProjectMetadata,
        },
      ],
      projectGroups: [],
      selectedProjectId: 'project-octan-sales',
      selectedGroupId: null,
    });

    const target = await resolveTaskArtifactTarget({
      args: { task_id: 'api' },
      executionContext: {
        taskId: 'api',
      } as never,
      selectedTaskId: 'api',
      tasks: [
        {
          id: 'api',
          title: 'API',
          task_source: 'architect',
          plan_id: plan.id,
          plan_storage_branch: branchName,
          project_id: 'project-lplr-app-old',
          project_ids: ['project-lplr-app-old'],
          execution_targets: [
            {
              projectId: 'project-lplr-app-old',
              branchName,
              baseBranchName: 'main',
              targetBranchName: branchName,
              worktreeKey: 'old',
            },
          ],
        },
      ] as unknown as CatalogedImplementTask[],
      getArchitectPlan: async () =>
        ({
          ...plan,
          projectId: 'project-lplr-app-old',
          projectIds: ['project-lplr-app-old'],
          availableProjectIds: ['project-octan-sales'],
        }) as ArchitectPlanRecord,
    });

    expect(target.plan.projectId).toBe('project-octan-sales');
    expect(target.plan.projectIds).toEqual(['project-octan-sales']);
  });
});
