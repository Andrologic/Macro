import type { PlanNode, PredictedBranch, ProjectGroup, Task } from '../types';
import {
  getArchitectPlan,
  getGitFlowBaseBranch,
  listArchitectPlans,
  listArchitectPlanTargetBranches,
  resolveTargetBranch,
  type ArchitectPlanRecord,
  type ArchitectPlanSummary,
} from './architectPlanService';
import {
  buildImplementTaskCatalog,
  isExecutableImplementPlanStatus,
  type ImplementTaskCatalog,
} from './implementTaskCatalog';

interface ActivePlanContextState {
  id: string;
  slug?: string;
  title: string;
  label?: string;
  description: string;
  status: string;
  targetBranch: string;
}

interface AppState {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  projectGroups: ProjectGroup[];
  activeArchitectPlanId: string | null;
  activePlanContext: ActivePlanContextState | null;
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
}

interface LoadImplementTaskCatalogDependencies {
  getAppState: () => AppState | Promise<AppState>;
  listArchitectPlans: typeof listArchitectPlans;
  getArchitectPlan: typeof getArchitectPlan;
  listArchitectPlanTargetBranches: typeof listArchitectPlanTargetBranches;
  getGitFlowBaseBranch: typeof getGitFlowBaseBranch;
  resolveTargetBranch: typeof resolveTargetBranch;
  buildImplementTaskCatalog: typeof buildImplementTaskCatalog;
}

const normalizeProjectIds = (projectIds?: string[], projectId?: string): string[] =>
  Array.from(new Set(
    [
      ...(Array.isArray(projectIds) ? projectIds : []),
      ...(projectId ? [projectId] : []),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  ));

const resolveRelevantProjectIds = (
  appState: Pick<AppState, 'selectedGroupId' | 'selectedProjectId' | 'projectGroups'>
): string[] | null => {
  if (appState.selectedGroupId) {
    const selectedGroup = appState.projectGroups.find((group) => group.id === appState.selectedGroupId);
    const groupProjectIds = selectedGroup?.projects
      .map((project) => project.id)
      .filter((projectId) => projectId.trim().length > 0) ?? [];
    if (groupProjectIds.length > 0) {
      return groupProjectIds;
    }
  }

  if (appState.selectedProjectId) {
    return [appState.selectedProjectId];
  }

  return null;
};

const planMatchesRelevantProjects = (
  plan: Pick<ArchitectPlanRecord, 'projectId' | 'projectIds'> | Pick<ArchitectPlanSummary, 'projectId' | 'projectIds'>,
  relevantProjectIds: string[] | null
): boolean => {
  if (!relevantProjectIds || relevantProjectIds.length === 0) {
    return true;
  }

  const planProjectIds = normalizeProjectIds(plan.projectIds, plan.projectId);
  if (planProjectIds.length === 0) {
    return true;
  }

  const relevantProjectIdSet = new Set(relevantProjectIds);
  return planProjectIds.some((projectId) => relevantProjectIdSet.has(projectId));
};

const buildExecutableActivePlanRecord = (appState: AppState): ArchitectPlanRecord | null => {
  const activePlanId = appState.activeArchitectPlanId;
  const activePlanContext = appState.activePlanContext;
  if (
    !activePlanId ||
    !activePlanContext ||
    !isExecutableImplementPlanStatus(activePlanContext.status) ||
    appState.planNodes.length === 0
  ) {
    return null;
  }

  const projectIds = Array.from(
    new Set(
      [
        ...appState.planNodes.flatMap((node) => node.projectIds || (node.projectId ? [node.projectId] : [])),
        ...appState.predictedBranches.map((branch) => branch.projectId),
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    )
  );

  return {
    id: activePlanId,
    slug:
      (typeof activePlanContext.slug === 'string' && activePlanContext.slug.trim().length > 0
        ? activePlanContext.slug.trim()
        : activePlanContext.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) ||
      activePlanId,
    title: activePlanContext.title,
    label: activePlanContext.label,
    description: activePlanContext.description,
    status: activePlanContext.status as ArchitectPlanRecord['status'],
    targetBranch: activePlanContext.targetBranch,
    projectId: projectIds[0],
    projectIds,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: appState.planNodes,
    predictedBranches: appState.predictedBranches,
  };
};

const upsertPlanRecord = (
  plans: ArchitectPlanRecord[],
  nextPlan: ArchitectPlanRecord
): ArchitectPlanRecord[] => {
  const filteredPlans = plans.filter((plan) => plan.id !== nextPlan.id);
  return [nextPlan, ...filteredPlans];
};

const dedupePlanRefs = (items: Array<{ branchName: string; planId: string }>): Array<{ branchName: string; planId: string }> => {
  const seenPlanIds = new Set<string>();
  const uniqueItems: Array<{ branchName: string; planId: string }> = [];

  for (const item of items) {
    if (seenPlanIds.has(item.planId)) {
      continue;
    }
    seenPlanIds.add(item.planId);
    uniqueItems.push(item);
  }

  return uniqueItems;
};

const resolveCandidateTargetBranches = (
  branchNames: Array<string | null | undefined>,
  resolveBranch: (value: unknown) => string
): string[] => {
  const resolvedBranches: string[] = [];

  for (const branchName of branchNames) {
    if (typeof branchName !== 'string' || branchName.trim().length === 0) {
      continue;
    }

    try {
      resolvedBranches.push(resolveBranch(branchName));
    } catch {
      // Ignore unexpected metadata branch folders that do not match the supported Git Flow patterns.
    }
  }

  return Array.from(new Set(resolvedBranches));
};

export const createLoadImplementTaskCatalog = (
  dependencies: LoadImplementTaskCatalogDependencies = {
    getAppState: async () => {
      const { useAppStore } = await import('../stores/useAppStore');
      return useAppStore.getState();
    },
    listArchitectPlans,
    getArchitectPlan,
    listArchitectPlanTargetBranches,
    getGitFlowBaseBranch,
    resolveTargetBranch,
    buildImplementTaskCatalog,
  }
) => {
  return async (fallbackTasks: Task[]): Promise<ImplementTaskCatalog> => {
    const appState = await dependencies.getAppState();
    const relevantProjectIds = resolveRelevantProjectIds(appState);
    const activeTargetBranch = resolveCandidateTargetBranches(
      [appState.activePlanContext?.targetBranch || null],
      dependencies.resolveTargetBranch
    )[0] || null;
    let plans: ArchitectPlanRecord[] = [];

    try {
      const discoveredTargetBranches = await dependencies.listArchitectPlanTargetBranches();
      const candidateTargetBranches = resolveCandidateTargetBranches(
        [
          activeTargetBranch,
          ...discoveredTargetBranches,
          dependencies.getGitFlowBaseBranch(),
        ],
        dependencies.resolveTargetBranch
      );

      const planIndexes = (
        await Promise.all(
          candidateTargetBranches.map(async (branchName) => {
            try {
              return {
                branchName,
                index: await dependencies.listArchitectPlans(branchName),
              };
            } catch {
              return null;
            }
          })
        )
      ).filter((entry): entry is { branchName: string; index: Awaited<ReturnType<typeof listArchitectPlans>> } => Boolean(entry));
      const executablePlanRefs = dedupePlanRefs(
        planIndexes.flatMap(({ branchName, index }) =>
          index.plans
            .filter((plan) => isExecutableImplementPlanStatus(plan.status))
            .filter((plan) => planMatchesRelevantProjects(plan, relevantProjectIds))
            .map((plan) => ({
              branchName,
              planId: plan.id,
            }))
        )
      );
      const loadedPlans = await Promise.all(
        executablePlanRefs.map(async ({ branchName, planId }) => {
          try {
            return await dependencies.getArchitectPlan(branchName, planId);
          } catch {
            return null;
          }
        })
      );
      plans = loadedPlans.filter((plan): plan is ArchitectPlanRecord => Boolean(plan && plan.status !== 'deleted'));
    } catch {
      plans = [];
    }

    const activePlan = buildExecutableActivePlanRecord(appState);
    if (activePlan && planMatchesRelevantProjects(activePlan, relevantProjectIds)) {
      plans = upsertPlanRecord(plans, activePlan);
    }

    return dependencies.buildImplementTaskCatalog({
      plans,
      fallbackTasks,
    });
  };
};

export const loadImplementTaskCatalog = createLoadImplementTaskCatalog();
