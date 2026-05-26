import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import {
  getPlanArtifactContentPath,
  getPlanArtifactIndexPath,
  listVisibleTaskArtifactReviewEntries,
  normalizeArtifactContracts,
  putTaskArtifact,
  readPlanTaskArtifactIndex,
  readVisibleTaskArtifactDiff,
  resolveVisiblePlanTaskIds,
  unvalidateVisibleTaskArtifact,
  validateVisibleTaskArtifact,
} from './architectPlanArtifactService';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';

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
  const files = new Map<string, string>();

  beforeEach(() => {
    files.clear();
    installTauriRuntimeMock(mock(async (command, payload) => {
      if (command === 'workspace_get_active_root') {
        return '/workspace';
      }
      if (command === 'fs_read_file') {
        const path = String(payload?.path || '');
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
});
