import { describe, expect, it, mock } from 'bun:test';
import {
  buildArchitectPlanCatalogScopeKey,
  loadMacroProjectMetadataForSelection,
} from './macroProjectMetadataLoader';
import type { ArchitectPlanSummary } from './architectPlanService';

const buildPlan = (
  overrides: Partial<ArchitectPlanSummary> & { id: string },
): ArchitectPlanSummary => ({
  id: overrides.id,
  slug: overrides.slug ?? overrides.id,
  title: overrides.title ?? overrides.id,
  label: overrides.label ?? overrides.title ?? overrides.id,
  description: overrides.description ?? '',
  status: overrides.status ?? 'draft',
  targetBranch: overrides.targetBranch ?? 'develop',
  projectId: overrides.projectId,
  projectIds: overrides.projectIds ?? ['project-1'],
  contextProjectIds: overrides.contextProjectIds,
  expectedProjectIds: overrides.expectedProjectIds,
  createdAt: overrides.createdAt ?? '2026-04-17T10:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-04-17T10:00:00.000Z',
  nodeCount: overrides.nodeCount ?? 1,
  predictedBranchCount: overrides.predictedBranchCount ?? 1,
});

const createDeps = (plansByBranch: Record<string, { activePlanId: string | null; plans: ArchitectPlanSummary[] }>) => ({
  getGitFlowBaseBranch: () => 'develop',
  listArchitectPlanTargetBranches: mock(async () => Object.keys(plansByBranch)),
  listArchitectPlans: mock(async (branchName: string) => plansByBranch[branchName] ?? { activePlanId: null, plans: [] }),
  resolveTargetBranch: (branchName: unknown) =>
    String(branchName || 'develop').replace(/^refs\/heads\//, ''),
  clearArchitectPlanFrontendCaches: mock(() => undefined),
  workspaceArchitectInvalidate: mock(async () => undefined),
  isTauriAvailable: () => true,
});

describe('loadMacroProjectMetadataForSelection', () => {
  it('builds a stable catalog scope key from the current selection and scoped projects', () => {
    expect(
      buildArchitectPlanCatalogScopeKey({
        selectedGroupId: null,
        selectedProjectId: 'project-1',
        scopedProjectIds: ['project-1'],
      })
    ).toBe('none::project-1::project-1');
    expect(
      buildArchitectPlanCatalogScopeKey({
        selectedGroupId: 'group-1',
        selectedProjectId: 'project-2',
        scopedProjectIds: ['project-1', 'project-2'],
      })
    ).toBe('group-1::project-2::project-1\u0000project-2');
  });

  it('selects the remembered visible plan before branch active and recent plans', async () => {
    const remembered = buildPlan({
      id: 'remembered',
      projectIds: ['project-1'],
      updatedAt: '2026-04-17T09:00:00.000Z',
    });
    const active = buildPlan({
      id: 'active',
      projectIds: ['project-1'],
      updatedAt: '2026-04-17T11:00:00.000Z',
    });
    const recent = buildPlan({
      id: 'recent',
      projectIds: ['project-1'],
      updatedAt: '2026-04-17T12:00:00.000Z',
    });
    const deps = createDeps({
      develop: {
        activePlanId: active.id,
        plans: [remembered, active, recent],
      },
    });

    const result = await loadMacroProjectMetadataForSelection({
      scopedProjectIds: ['project-1'],
      rememberedPlanId: remembered.id,
      deps,
    });

    expect(result.selectedPlan?.id).toBe(remembered.id);
    expect(result.selectionReason).toBe('remembered_plan');
    expect(result.snapshot.visiblePlans.map((plan) => plan.id)).toEqual([
      recent.id,
      active.id,
      remembered.id,
    ]);
    expect(result.snapshot.scopedProjectIds).toEqual(['project-1']);
    expect(deps.clearArchitectPlanFrontendCaches).toHaveBeenCalledTimes(1);
    expect(deps.workspaceArchitectInvalidate).toHaveBeenCalledTimes(1);
    expect(deps.listArchitectPlans).toHaveBeenCalledWith('develop', true, true, {
      scopedProjectIdsHint: ['project-1'],
    });
  });

  it('keeps standalone project plans visible when their project ids match the current scope', async () => {
    const lplrPlan = buildPlan({
      id: 'refonte-catalogue-produit',
      projectIds: ['project-lplr-app-1780237886690'],
      expectedProjectIds: ['project-lplr-app-1780237886690'],
      targetBranch: 'main',
      updatedAt: '2026-06-01T07:49:45.660Z',
    });
    const otherPlan = buildPlan({
      id: 'other-project',
      projectIds: ['project-other'],
      expectedProjectIds: ['project-other'],
      targetBranch: 'main',
      updatedAt: '2026-06-01T08:49:45.660Z',
    });
    const deps = createDeps({
      main: {
        activePlanId: lplrPlan.id,
        plans: [otherPlan, lplrPlan],
      },
      develop: {
        activePlanId: null,
        plans: [],
      },
    });

    const result = await loadMacroProjectMetadataForSelection({
      scopedProjectIds: ['project-lplr-app-1780237886690'],
      candidateBranches: ['main', 'develop'],
      deps,
    });

    expect(result.snapshot.scannedBranchNames).toEqual(['main', 'develop']);
    expect(result.snapshot.visiblePlans.map((plan) => plan.id)).toEqual([
      lplrPlan.id,
    ]);
    expect(result.selectedPlan?.id).toBe(lplrPlan.id);
    expect(result.selectionReason).toBe('branch_active_plan');
  });

  it('ignores legacy invisible scopes and falls back to the most recently updated visible plan', async () => {
    const otherProjectPlan = buildPlan({
      id: 'other-project',
      projectIds: ['project-2'],
      updatedAt: '2026-04-17T13:00:00.000Z',
    });
    const olderVisible = buildPlan({
      id: 'older-visible',
      projectIds: ['project-1'],
      updatedAt: '2026-04-17T10:00:00.000Z',
    });
    const newestVisible = buildPlan({
      id: 'newest-visible',
      projectIds: ['project-1'],
      updatedAt: '2026-04-17T12:00:00.000Z',
    });
    const deps = createDeps({
      develop: {
        activePlanId: otherProjectPlan.id,
        plans: [otherProjectPlan, olderVisible, newestVisible],
      },
    });

    const result = await loadMacroProjectMetadataForSelection({
      scopedProjectIds: ['project-1'],
      rememberedPlanId: 'missing-plan',
      deps,
    });

    expect(result.selectedPlan?.id).toBe(newestVisible.id);
    expect(result.selectionReason).toBe('recently_updated');
    expect(result.snapshot.visiblePlans.map((plan) => plan.id)).toEqual([
      newestVisible.id,
      olderVisible.id,
    ]);
  });

  it('scans discovered branches and candidate branches without failing the whole catalog on one bad branch', async () => {
    const developPlan = buildPlan({
      id: 'develop-plan',
      projectIds: ['project-1'],
      targetBranch: 'develop',
    });
    const releasePlan = buildPlan({
      id: 'release-plan',
      projectIds: ['project-1'],
      targetBranch: 'release/1.0.0',
      updatedAt: '2026-04-17T12:00:00.000Z',
    });
    const plansByBranch = {
      develop: { activePlanId: null, plans: [developPlan] },
      'release/1.0.0': { activePlanId: releasePlan.id, plans: [releasePlan] },
    };
    const deps = {
      getGitFlowBaseBranch: () => 'develop',
      listArchitectPlanTargetBranches: mock(async () => [
        'release/1.0.0',
        'bad branch',
      ]),
      listArchitectPlans: mock(async (branchName: string) => {
        if (branchName === 'bugfix/missing') {
          throw new Error('missing branch index');
        }
        return plansByBranch[branchName as keyof typeof plansByBranch] ?? {
          activePlanId: null,
          plans: [],
        };
      }),
      resolveTargetBranch: (branchName: unknown) => {
        const normalized = String(branchName || 'develop').replace(/^refs\/heads\//, '');
        if (normalized.includes(' ')) {
          throw new Error('invalid branch');
        }
        return normalized;
      },
      clearArchitectPlanFrontendCaches: mock(() => undefined),
      workspaceArchitectInvalidate: mock(async () => undefined),
      isTauriAvailable: () => false,
    };

    const result = await loadMacroProjectMetadataForSelection({
      scopedProjectIds: ['project-1'],
      currentTargetBranch: 'refs/heads/develop',
      candidateBranches: ['bugfix/missing'],
      deps,
    });

    expect(result.selectedPlan?.id).toBe(releasePlan.id);
    expect(result.selectionReason).toBe('branch_active_plan');
    expect(result.snapshot.scannedBranchNames).toEqual([
      'develop',
      'bugfix/missing',
      'release/1.0.0',
    ]);
    expect(result.snapshot.errors).toEqual([
      { branchName: 'bugfix/missing', message: 'missing branch index' },
    ]);
  });

  it('rejects the catalog when every candidate branch fails', async () => {
    const deps = createDeps({ develop: { activePlanId: null, plans: [] } });
    deps.listArchitectPlans.mockImplementation(async () => {
      throw new Error('metadata unavailable');
    });

    await expect(loadMacroProjectMetadataForSelection({
      scopedProjectIds: ['project-1'],
      deps,
    })).rejects.toThrow('develop: metadata unavailable');
  });
});
