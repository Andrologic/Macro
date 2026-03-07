import type { Task } from '../types';
import { useAppStore } from '../stores/useAppStore';
import {
  getArchitectPlan,
  getGitFlowBaseBranch,
  listArchitectPlans,
  resolveTargetBranch,
  type ArchitectPlanRecord,
} from './architectPlanService';
import {
  buildImplementTaskCatalog,
  isExecutableImplementPlanStatus,
  type ImplementTaskCatalog,
} from './implementTaskCatalog';

const buildExecutableActivePlanRecord = (): ArchitectPlanRecord | null => {
  const appState = useAppStore.getState();
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

export const loadImplementTaskCatalog = async (fallbackTasks: Task[]): Promise<ImplementTaskCatalog> => {
  const appState = useAppStore.getState();
  const targetBranch = resolveTargetBranch(appState.activePlanContext?.targetBranch || getGitFlowBaseBranch());
  let plans: ArchitectPlanRecord[] = [];

  try {
    const planIndex = await listArchitectPlans(targetBranch);
    const executablePlanIds = planIndex.plans
      .filter((plan) => isExecutableImplementPlanStatus(plan.status))
      .map((plan) => plan.id);
    const loadedPlans = await Promise.all(
      executablePlanIds.map((planId) => getArchitectPlan(targetBranch, planId))
    );
    plans = loadedPlans.filter((plan): plan is ArchitectPlanRecord => Boolean(plan && plan.status !== 'deleted'));
  } catch {
    plans = [];
  }

  const activePlan = buildExecutableActivePlanRecord();
  if (activePlan && !plans.some((plan) => plan.id === activePlan.id)) {
    plans.unshift(activePlan);
  }

  return buildImplementTaskCatalog({
    plans,
    fallbackTasks,
  });
};
