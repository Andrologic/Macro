import type { Task } from '../types';
import { useAppStore } from '../stores/useAppStore';
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

type AppState = ReturnType<typeof useAppStore.getState>;

interface LoadImplementTaskCatalogDependencies {
  getAppState: () => AppState;
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
    slug: activePlanContext.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || activePlanId,
    title: activePlanContext.title,
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

export const createLoadImplementTaskCatalog = (
  dependencies: LoadImplementTaskCatalogDependencies = {
    getAppState: useAppStore.getState,
    listArchitectPlans,
    getArchitectPlan,
    listArchitectPlanTargetBranches,
    getGitFlowBaseBranch,
    resolveTargetBranch,
    buildImplementTaskCatalog,
  }
) => {
  return async (fallbackTasks: Task[]): Promise<ImplementTaskCatalog> => {
    const appState = dependencies.getAppState();
    const relevantProjectIds = resolveRelevantProjectIds(appState);
    const activeTargetBranch = appState.activePlanContext?.targetBranch
      ? dependencies.resolveTargetBranch(appState.activePlanContext.targetBranch)
      : null;
    let plans: ArchitectPlanRecord[] = [];

    try {
      const discoveredTargetBranches = await dependencies.listArchitectPlanTargetBranches();
      const candidateTargetBranches = Array.from(new Set(
        [
          activeTargetBranch,
          ...discoveredTargetBranches,
          dependencies.resolveTargetBranch(dependencies.getGitFlowBaseBranch()),
        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      ));

      const planIndexes = await Promise.all(
        candidateTargetBranches.map(async (branchName) => ({
          branchName,
          index: await dependencies.listArchitectPlans(branchName),
        }))
      );
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
        executablePlanRefs.map(({ branchName, planId }) => dependencies.getArchitectPlan(branchName, planId))
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
