type ArchitectPlanIdInput =
  | ReadonlyArray<string | null | undefined>
  | string
  | null
  | undefined;

export interface ArchitectPlanScopeRef {
  projectId?: string | null;
  projectIds?: ReadonlyArray<string | null | undefined>;
  contextProjectIds?: ReadonlyArray<string | null | undefined>;
  expectedProjectIds?: ReadonlyArray<string | null | undefined>;
}

export interface NormalizedArchitectPlanScope {
  actionableProjectIds: string[];
  contextProjectIds: string[];
  expectedProjectIds: string[];
}

export const deriveArchitectPlanActionableProjectIdsFromExpected = (
  expectedProjectIds?: ReadonlyArray<string | null | undefined>,
  contextProjectIds?: ReadonlyArray<string | null | undefined>
): string[] => {
  const contextProjectIdSet = new Set(normalizeArchitectPlanIdList(contextProjectIds));

  return normalizeArchitectPlanIdList(expectedProjectIds).filter(
    (projectId) => !contextProjectIdSet.has(projectId)
  );
};

export const normalizeArchitectPlanIdList = (
  ...inputs: ArchitectPlanIdInput[]
): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  const collect = (candidate: string | null | undefined): void => {
    if (typeof candidate !== 'string') {
      return;
    }

    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  };

  for (const input of inputs) {
    if (Array.isArray(input)) {
      input.forEach((candidate) => collect(candidate));
      continue;
    }

    if (typeof input === 'string' || input == null) {
      collect(input);
    }
  }

  return normalized;
};

export const normalizeArchitectPlanActionableProjectIds = (
  scope: Pick<ArchitectPlanScopeRef, 'projectId' | 'projectIds'>,
  options?: {
    fallbackProjectIds?: ReadonlyArray<string | null | undefined>;
  }
): string[] => {
  const actionableProjectIds = normalizeArchitectPlanIdList(
    scope.projectIds,
    scope.projectId
  );

  return actionableProjectIds.length > 0
    ? actionableProjectIds
    : normalizeArchitectPlanIdList(options?.fallbackProjectIds);
};

export const normalizeArchitectPlanScope = (
  scope: ArchitectPlanScopeRef,
  options?: {
    fallbackActionableProjectIds?: ReadonlyArray<string | null | undefined>;
    useExpectedAsActionableFallback?: boolean;
  }
): NormalizedArchitectPlanScope => {
  const fallbackActionableProjectIds = options?.useExpectedAsActionableFallback
    ? normalizeArchitectPlanIdList(
        options.fallbackActionableProjectIds,
        deriveArchitectPlanActionableProjectIdsFromExpected(
          scope.expectedProjectIds,
          scope.contextProjectIds
        )
      )
    : normalizeArchitectPlanIdList(options?.fallbackActionableProjectIds);
  const actionableProjectIds = normalizeArchitectPlanActionableProjectIds(scope, {
    fallbackProjectIds: fallbackActionableProjectIds,
  });
  const actionableProjectIdSet = new Set(actionableProjectIds);
  const contextProjectIds = normalizeArchitectPlanIdList(scope.contextProjectIds).filter(
    (projectId) => !actionableProjectIdSet.has(projectId)
  );

  return {
    actionableProjectIds,
    contextProjectIds,
    expectedProjectIds: normalizeArchitectPlanIdList(
      actionableProjectIds,
      contextProjectIds
    ),
  };
};

export const getArchitectPlanActionableProjectIdsFromScope = (
  scope: ArchitectPlanScopeRef,
  options?: {
    fallbackActionableProjectIds?: ReadonlyArray<string | null | undefined>;
    useExpectedAsActionableFallback?: boolean;
  }
): string[] => normalizeArchitectPlanScope(scope, options).actionableProjectIds;

export const getArchitectPlanContextProjectIdsFromScope = (
  scope: ArchitectPlanScopeRef,
  options?: {
    fallbackActionableProjectIds?: ReadonlyArray<string | null | undefined>;
    useExpectedAsActionableFallback?: boolean;
  }
): string[] => normalizeArchitectPlanScope(scope, options).contextProjectIds;

export const getArchitectPlanVisibleProjectIdsFromScope = (
  scope: ArchitectPlanScopeRef,
  options?: {
    fallbackActionableProjectIds?: ReadonlyArray<string | null | undefined>;
    useExpectedAsActionableFallback?: boolean;
  }
): string[] => normalizeArchitectPlanScope(scope, options).expectedProjectIds;
