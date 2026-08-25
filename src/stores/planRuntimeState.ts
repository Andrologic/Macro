export interface PlanRuntimeStateSnapshot {
  branchWorktrees: Record<string, string>;
  activeBranchName: string | null;
  activeRepositoryPath: string | null;
}

export interface ClearPlanRuntimeStateParams {
  planId?: string | null;
  deletedWorktreeKeys?: string[];
}

export interface ClearedPlanRuntimeState extends PlanRuntimeStateSnapshot {
  shouldClearActivePlan: boolean;
  shouldSyncWorkspaceRoot: boolean;
}

export const clearPlanRuntimeStateSnapshot = (params: {
  currentState: PlanRuntimeStateSnapshot;
  activePlanId?: string | null;
} & ClearPlanRuntimeStateParams): ClearedPlanRuntimeState => {
  const deletedSet = new Set((params.deletedWorktreeKeys || []).filter(Boolean));
  const removedPaths = new Set(
    Object.entries(params.currentState.branchWorktrees)
      .filter(([worktreeKey]) => deletedSet.has(worktreeKey))
      .map(([, worktreePath]) => worktreePath)
  );
  const shouldClearActivePlan = Boolean(
    params.planId && params.activePlanId === params.planId
  );
  const shouldClearActiveRepository =
    Boolean(
      params.currentState.activeRepositoryPath &&
      removedPaths.has(params.currentState.activeRepositoryPath)
    ) || shouldClearActivePlan;

  return {
    branchWorktrees: Object.fromEntries(
      Object.entries(params.currentState.branchWorktrees).filter(
        ([worktreeKey]) => !deletedSet.has(worktreeKey)
      )
    ),
    activeBranchName: shouldClearActiveRepository
      ? null
      : params.currentState.activeBranchName,
    activeRepositoryPath: shouldClearActiveRepository
      ? null
      : params.currentState.activeRepositoryPath,
    shouldClearActivePlan,
    shouldSyncWorkspaceRoot: shouldClearActiveRepository,
  };
};
