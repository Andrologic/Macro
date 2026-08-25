import {
  clearArchitectPlanFrontendCaches,
  getGitFlowBaseBranch,
  listArchitectPlans,
  listArchitectPlanTargetBranches,
  resolveTargetBranch,
  type ArchitectPlanSummary,
} from './architectPlanService';
import { planMatchesArchitectScope, compareArchitectPlanSelectionPriority } from './architectPlanSelection';
import * as tauriIpc from './tauriIpc';
import { devLogger } from '../utils/devLogger';

export type ArchitectPlanCatalogSelectionReason =
  | 'remembered_plan'
  | 'current_plan'
  | 'branch_active_plan'
  | 'recently_updated'
  | 'none';

export type ArchitectPlanCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ArchitectPlanCatalogBranch {
  branchName: string;
  activePlanId: string | null;
  plans: ArchitectPlanSummary[];
  error: string | null;
}

export interface ArchitectPlanCatalogSnapshot {
  branchCatalogByBranch: Record<string, ArchitectPlanCatalogBranch>;
  branches: ArchitectPlanCatalogBranch[];
  scannedBranchNames: string[];
  scopedProjectIds: string[];
  visiblePlans: ArchitectPlanSummary[];
  modernPlanCount: number;
  selectedPlan: ArchitectPlanSummary | null;
  selectedBranchName: string | null;
  selectionReason: ArchitectPlanCatalogSelectionReason;
  errors: Array<{ branchName: string; message: string }>;
}

export interface MacroProjectMetadataLoadResult {
  snapshot: ArchitectPlanCatalogSnapshot;
  selectedPlan: ArchitectPlanSummary | null;
  selectedBranchName: string | null;
  selectionReason: ArchitectPlanCatalogSelectionReason;
}

export class ArchitectPlanCatalogUnavailableError extends Error {
  readonly errors: ArchitectPlanCatalogSnapshot['errors'];

  constructor(errors: ArchitectPlanCatalogSnapshot['errors']) {
    super(errors.map(({ branchName, message }) => `${branchName}: ${message}`).join('; '));
    this.name = 'ArchitectPlanCatalogUnavailableError';
    this.errors = errors;
  }
}

export const buildArchitectPlanCatalogScopeKey = (params: {
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
  scopedProjectIds: string[];
}): string =>
  [
    params.selectedGroupId ?? 'none',
    params.selectedProjectId ?? 'none',
    params.scopedProjectIds.join('\u0000'),
  ].join('::');

interface MacroProjectMetadataLoaderDeps {
  getGitFlowBaseBranch: typeof getGitFlowBaseBranch;
  listArchitectPlans: typeof listArchitectPlans;
  listArchitectPlanTargetBranches: typeof listArchitectPlanTargetBranches;
  resolveTargetBranch: typeof resolveTargetBranch;
  clearArchitectPlanFrontendCaches: typeof clearArchitectPlanFrontendCaches;
  workspaceArchitectInvalidate: typeof tauriIpc.workspaceArchitectInvalidate;
  isTauriAvailable: typeof tauriIpc.isTauriAvailable;
}

export interface LoadMacroProjectMetadataForSelectionParams {
  scopedProjectIds: string[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
  rememberedPlanId?: string | null;
  currentActivePlanId?: string | null;
  currentTargetBranch?: string | null;
  candidateBranches?: Array<string | null | undefined>;
  includeArchivedInVisible?: boolean;
  includeDeletedInVisible?: boolean;
  deps?: Partial<MacroProjectMetadataLoaderDeps>;
}

const defaultDeps: MacroProjectMetadataLoaderDeps = {
  get getGitFlowBaseBranch() {
    return getGitFlowBaseBranch;
  },
  get listArchitectPlans() {
    return listArchitectPlans;
  },
  get listArchitectPlanTargetBranches() {
    return listArchitectPlanTargetBranches;
  },
  get resolveTargetBranch() {
    return resolveTargetBranch;
  },
  get clearArchitectPlanFrontendCaches() {
    return clearArchitectPlanFrontendCaches;
  },
  get workspaceArchitectInvalidate() {
    return tauriIpc.workspaceArchitectInvalidate;
  },
  get isTauriAvailable() {
    return tauriIpc.isTauriAvailable;
  },
};

const normalizeBranchCandidates = (
  branchNames: Array<string | null | undefined>,
  resolveBranch: typeof resolveTargetBranch,
): string[] => {
  const resolvedBranches: string[] = [];
  for (const branchName of branchNames) {
    if (typeof branchName !== 'string' || branchName.trim().length === 0) {
      continue;
    }
    try {
      resolvedBranches.push(resolveBranch(branchName));
    } catch {
      // Ignore stale branch metadata folders that do not resolve to supported Git-flow branches.
    }
  }
  return Array.from(new Set(resolvedBranches));
};

const normalizeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const planIsVisible = (
  plan: ArchitectPlanSummary,
  scopedProjectIds: string[],
  includeArchived: boolean,
  includeDeleted: boolean,
): boolean => {
  if (!includeDeleted && plan.status === 'deleted') {
    return false;
  }
  if (!includeArchived && plan.status === 'archived') {
    return false;
  }
  return planMatchesArchitectScope(plan, scopedProjectIds);
};

const findVisiblePlanById = (
  visiblePlans: ArchitectPlanSummary[],
  planId?: string | null,
): ArchitectPlanSummary | null => {
  if (!planId) {
    return null;
  }
  return visiblePlans.find((plan) => plan.id === planId) ?? null;
};

const findBranchForPlan = (
  branches: ArchitectPlanCatalogBranch[],
  planId: string,
): string | null =>
  branches.find((branch) => branch.plans.some((plan) => plan.id === planId))
    ?.branchName ?? null;

const selectCatalogPlan = (params: {
  branches: ArchitectPlanCatalogBranch[];
  visiblePlans: ArchitectPlanSummary[];
  rememberedPlanId?: string | null;
  currentActivePlanId?: string | null;
}): {
  plan: ArchitectPlanSummary | null;
  branchName: string | null;
  reason: ArchitectPlanCatalogSelectionReason;
} => {
  const rememberedPlan = findVisiblePlanById(
    params.visiblePlans,
    params.rememberedPlanId,
  );
  if (rememberedPlan) {
    return {
      plan: rememberedPlan,
      branchName: findBranchForPlan(params.branches, rememberedPlan.id),
      reason: 'remembered_plan',
    };
  }

  const currentPlan = findVisiblePlanById(
    params.visiblePlans,
    params.currentActivePlanId,
  );
  if (currentPlan) {
    return {
      plan: currentPlan,
      branchName: findBranchForPlan(params.branches, currentPlan.id),
      reason: 'current_plan',
    };
  }

  for (const branch of params.branches) {
    const branchActivePlan = findVisiblePlanById(
      params.visiblePlans,
      branch.activePlanId,
    );
    if (branchActivePlan) {
      return {
        plan: branchActivePlan,
        branchName: branch.branchName,
        reason: 'branch_active_plan',
      };
    }
  }

  const recentPlan = [...params.visiblePlans].sort(
    compareArchitectPlanSelectionPriority,
  )[0] ?? null;
  return {
    plan: recentPlan,
    branchName: recentPlan ? findBranchForPlan(params.branches, recentPlan.id) : null,
    reason: recentPlan ? 'recently_updated' : 'none',
  };
};

export const loadMacroProjectMetadataForSelection = async (
  params: LoadMacroProjectMetadataForSelectionParams,
): Promise<MacroProjectMetadataLoadResult> => {
  const deps = { ...defaultDeps, ...(params.deps ?? {}) };

  deps.clearArchitectPlanFrontendCaches();

  if (deps.isTauriAvailable()) {
    try {
      await deps.workspaceArchitectInvalidate({});
    } catch (error) {
      devLogger.warn(
        JSON.stringify({
          event: 'architect_metadata_invalidate_failed',
          at: new Date().toISOString(),
          error: normalizeErrorMessage(error),
        }),
      );
    }
  }

  let discoveredBranches: string[] = [];
  try {
    discoveredBranches = await deps.listArchitectPlanTargetBranches();
  } catch (error) {
    devLogger.warn(
      JSON.stringify({
        event: 'architect_plan_branch_discovery_failed',
        at: new Date().toISOString(),
        error: normalizeErrorMessage(error),
      }),
    );
  }

  const candidateBranches = normalizeBranchCandidates(
    [
      params.currentTargetBranch,
      ...(params.candidateBranches ?? []),
      ...discoveredBranches,
      deps.getGitFlowBaseBranch(),
    ],
    deps.resolveTargetBranch,
  );

  const errors: ArchitectPlanCatalogSnapshot['errors'] = [];
  const branches = (
    await Promise.all(
      candidateBranches.map(async (branchName) => {
        try {
          const index = await deps.listArchitectPlans(branchName, true, true, {
            scopedProjectIdsHint: params.scopedProjectIds,
          });
          return {
            branchName,
            activePlanId: index.activePlanId,
            plans: index.plans,
            error: null,
          } satisfies ArchitectPlanCatalogBranch;
        } catch (error) {
          const message = normalizeErrorMessage(error);
          errors.push({ branchName, message });
          return {
            branchName,
            activePlanId: null,
            plans: [],
            error: message,
          } satisfies ArchitectPlanCatalogBranch;
        }
      }),
    )
  );

  if (candidateBranches.length > 0 && branches.every((branch) => branch.error !== null)) {
    throw new ArchitectPlanCatalogUnavailableError(errors);
  }

  const includeArchived = params.includeArchivedInVisible === true;
  const includeDeleted = params.includeDeletedInVisible === true;
  const visiblePlans = branches
    .flatMap((branch) => branch.plans)
    .filter((plan) =>
      planIsVisible(plan, params.scopedProjectIds, includeArchived, includeDeleted),
    )
    .sort(compareArchitectPlanSelectionPriority);

  const selected = selectCatalogPlan({
    branches,
    visiblePlans,
    rememberedPlanId: params.rememberedPlanId,
    currentActivePlanId: params.currentActivePlanId,
  });

  const branchCatalogByBranch = Object.fromEntries(
    branches.map((branch) => [branch.branchName, branch]),
  );

  const snapshot: ArchitectPlanCatalogSnapshot = {
    branchCatalogByBranch,
    branches,
    scannedBranchNames: candidateBranches,
    scopedProjectIds: params.scopedProjectIds,
    visiblePlans,
    modernPlanCount: branches.reduce((count, branch) => count + branch.plans.length, 0),
    selectedPlan: selected.plan,
    selectedBranchName: selected.branchName,
    selectionReason: selected.reason,
    errors,
  };

  devLogger.info(
    JSON.stringify({
      event: 'architect_metadata_catalog_loaded',
      at: new Date().toISOString(),
      selectedGroupId: params.selectedGroupId ?? null,
      selectedProjectId: params.selectedProjectId ?? null,
      scopedProjectIds: params.scopedProjectIds,
      scannedBranches: candidateBranches,
      scannedBranchCount: candidateBranches.length,
      planCount: snapshot.modernPlanCount,
      visiblePlanCount: visiblePlans.length,
      visiblePlanIds: visiblePlans.map((plan) => plan.id),
      selectedPlanId: selected.plan?.id ?? null,
      selectedBranchName: selected.branchName,
      selectionReason: selected.reason,
    }),
  );

  return {
    snapshot,
    selectedPlan: selected.plan,
    selectedBranchName: selected.branchName,
    selectionReason: selected.reason,
  };
};
