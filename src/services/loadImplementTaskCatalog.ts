import type { PlanNode, PredictedBranch, Project, ProjectGroup, Task } from '../types';
import { useAppStore } from '../stores/useAppStore';
import {
  getArchitectPlan,
  getArchitectPlanEffectiveTargetBranchesByProjectId,
  getGitFlowBaseBranch,
  listArchitectPlans,
  listArchitectPlanTargetBranches,
  resolveTargetBranch,
  updateArchitectPlan,
  type ArchitectPlanRecord,
} from './architectPlanService';
import {
  buildImplementTaskCatalog,
  isExecutableImplementPlanStatus,
  type ImplementTaskCatalog,
} from './implementTaskCatalog';
import { readArchitectPlanRuntime } from './architectPlanRuntimeService';
import { summarizePersistedMergeWorkflowSession } from './mergeWorkflowPersistence';
import { buildPlanFinalizationTaskId } from './planFinalization';
import { getTaskBusinessId, toPlanLocatorKey } from './durableIdentity';
import {
  collectKnownProjects,
  collectKnownProjectIds,
  retargetPlanForExecution,
  retargetTaskForExecution,
} from './projectIdentityReconciliation';
import { resolveProjectExecutionMode } from './projectExecutionMode';

interface ActivePlanContextState {
  id: string;
  slug?: string;
  title: string;
  label?: string;
  description: string;
  status: string;
  targetBranch: string;
  targetBranchesByProjectId?: Record<string, string>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  hasMixedTargetBranches?: boolean;
}

interface AppState {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  projectGroups: ProjectGroup[];
  standaloneProjects?: Project[];
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
  updateArchitectPlan?: typeof updateArchitectPlan;
}

const migrateLegacyPlanExecutionModes = (
  plan: ArchitectPlanRecord,
  appState: AppState,
): { plan: ArchitectPlanRecord; changed: boolean } => {
  const projectById = new Map(
    collectKnownProjects(appState).map((project) => [project.id, project]),
  );
  let changed = false;
  const nodes = (plan.nodes || []).map((node) => {
    const projectIds = Array.from(new Set([
      ...(node.projectIds || []),
      ...(node.projectId ? [node.projectId] : []),
    ]));
    const executionModesByProjectId = { ...(node.executionModesByProjectId || {}) };
    let nodeChanged = false;
    for (const projectId of projectIds) {
      if (executionModesByProjectId[projectId]) continue;
      const mode = resolveProjectExecutionMode({ project: projectById.get(projectId) }).mode;
      if (mode !== 'git' && mode !== 'direct') continue;
      executionModesByProjectId[projectId] = mode;
      nodeChanged = true;
      changed = true;
    }
    return nodeChanged ? { ...node, executionModesByProjectId } : node;
  });
  return {
    plan: changed ? { ...plan, nodes } : plan,
    changed,
  };
};

const reconcileFallbackTasksForCurrentScope = (
  tasks: Task[],
  relevantProjectIds: string[] | null,
  validProjectIds: string[]
): Task[] => {
  return tasks.map((task) =>
    retargetTaskForExecution(task, {
      scopedProjectIds: relevantProjectIds,
      knownProjectIds: validProjectIds,
    })
  );
};

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

  const knownProjectById = new Map(
    collectKnownProjects(appState).map((project) => [project.id, project])
  );

  const draftPlan = {
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
    targetBranchesByProjectId: activePlanContext.targetBranchesByProjectId,
    executionModesByProjectId: activePlanContext.executionModesByProjectId,
    projectId: projectIds[0],
    projectIds,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: appState.planNodes,
    predictedBranches: appState.predictedBranches,
  };
  return {
    ...draftPlan,
    targetBranchesByProjectId: getArchitectPlanEffectiveTargetBranchesByProjectId(
      draftPlan,
      {
        getProjectGitFlowSettings: (projectId) =>
          knownProjectById.get(projectId)?.gitFlowSettings ?? null,
      }
    ),
  };
};

const upsertPlanRecord = (
  plans: ArchitectPlanRecord[],
  nextPlan: ArchitectPlanRecord
): ArchitectPlanRecord[] => {
  const filteredPlans = plans.filter((plan) =>
    toPlanLocatorKey({ branchName: plan.targetBranch, planId: plan.id }) !==
    toPlanLocatorKey({ branchName: nextPlan.targetBranch, planId: nextPlan.id })
  );
  return [nextPlan, ...filteredPlans];
};

const dedupePlanRefs = (items: Array<{ branchName: string; planId: string }>): Array<{ branchName: string; planId: string }> => {
  const seenPlanIds = new Set<string>();
  const uniqueItems: Array<{ branchName: string; planId: string }> = [];

  for (const item of items) {
    const locatorKey = toPlanLocatorKey(item);
    if (seenPlanIds.has(locatorKey)) {
      continue;
    }
    seenPlanIds.add(locatorKey);
    uniqueItems.push(item);
  }

  return uniqueItems;
};

const dedupeLoadedPlans = (plans: ArchitectPlanRecord[]): ArchitectPlanRecord[] => {
  const byLocator = new Map<string, ArchitectPlanRecord>();
  for (const plan of plans) {
    const key = toPlanLocatorKey({ branchName: plan.targetBranch, planId: plan.id });
    if (!byLocator.has(key)) byLocator.set(key, plan);
  }
  return Array.from(byLocator.values());
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
      // Ignore unexpected metadata branch folders that do not match the supported Git workflow patterns.
    }
  }

  return Array.from(new Set(resolvedBranches));
};

export const createLoadImplementTaskCatalog = (
  dependencies: LoadImplementTaskCatalogDependencies = {
    getAppState: () => useAppStore.getState(),
    listArchitectPlans,
    getArchitectPlan,
    listArchitectPlanTargetBranches,
    getGitFlowBaseBranch,
    resolveTargetBranch,
    buildImplementTaskCatalog,
    updateArchitectPlan,
  }
) => {
  return async (fallbackTasks: Task[]): Promise<ImplementTaskCatalog> => {
    const appState = await dependencies.getAppState();
    const reconciliationProjectIds = resolveRelevantProjectIds(appState);
    const validProjectIds = collectKnownProjectIds(appState);
    const activeTargetBranch = resolveCandidateTargetBranches(
      [appState.activePlanContext?.targetBranch || null],
      dependencies.resolveTargetBranch
    )[0] || null;
    let plans: ArchitectPlanRecord[] = [];

    let discoveredTargetBranches: string[] = [];
    try {
      discoveredTargetBranches = await dependencies.listArchitectPlanTargetBranches();
    } catch {
      // Discovery is advisory; the active and Git-flow base branches remain valid fallbacks.
    }
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
                index: await dependencies.listArchitectPlans(
                  branchName,
                  false,
                  false,
                  { scopedProjectIdsHint: undefined }
                ),
              };
            } catch {
              return null;
            }
          })
        )
      ).filter((entry): entry is { branchName: string; index: Awaited<ReturnType<typeof listArchitectPlans>> } => Boolean(entry));
      if (candidateTargetBranches.length > 0 && planIndexes.length === 0) {
        throw new Error('Unable to load the Implement task catalog from any metadata branch.');
      }
      const executablePlanRefs = dedupePlanRefs(
        planIndexes.flatMap(({ branchName, index }) =>
          index.plans
            .filter((plan) => isExecutableImplementPlanStatus(plan.status))
            .map((plan) => ({
              branchName,
              planId: plan.id,
            }))
        )
      );
      const loadedPlans = await Promise.all(
        executablePlanRefs.map(async ({ branchName, planId }) => {
          try {
            const plan = await dependencies.getArchitectPlan(branchName, planId);
            return plan
              ? retargetPlanForExecution(plan, {
                  scopedProjectIds: reconciliationProjectIds,
                  knownProjectIds: validProjectIds,
                })
              : null;
          } catch {
            return null;
          }
        })
      );
      if (
        executablePlanRefs.length > 0 &&
        loadedPlans.every((plan) => plan === null)
      ) {
        throw new Error('Unable to load any referenced Architect plan for the Implement task catalog.');
      }
      plans = dedupeLoadedPlans(
        loadedPlans.filter((plan): plan is ArchitectPlanRecord => Boolean(plan && plan.status !== 'deleted')),
      );

    const activePlan = buildExecutableActivePlanRecord(appState);
    if (activePlan) {
      plans = upsertPlanRecord(
        plans,
        retargetPlanForExecution(activePlan, {
          scopedProjectIds: reconciliationProjectIds,
          knownProjectIds: validProjectIds,
        })
      );
    }
    plans = await Promise.all(plans.map(async (plan) => {
      const migration = migrateLegacyPlanExecutionModes(plan, appState);
      if (!migration.changed || !dependencies.updateArchitectPlan) {
        return migration.plan;
      }
      try {
        return await dependencies.updateArchitectPlan({
          branchName: migration.plan.targetBranch,
          planId: migration.plan.id,
          nodes: migration.plan.nodes,
          setActive: false,
        });
      } catch {
        // Keep the safe in-memory migration usable and retry persistence on the next refresh.
        return migration.plan;
      }
    }));
    const reconciledFallbackTasks = reconcileFallbackTasksForCurrentScope(
      fallbackTasks,
      reconciliationProjectIds,
      validProjectIds
    );

    const catalog = dependencies.buildImplementTaskCatalog({
      plans,
      fallbackTasks: reconciledFallbackTasks,
    });

    const runtimeEntries = (
      await Promise.all(
        plans.map(async (plan) => {
          const runtime = await readArchitectPlanRuntime({
            branchName: plan.targetBranch,
            planId: plan.id,
            projectIds: plan.projectIds,
          });
          return runtime ? ([toPlanLocatorKey({ branchName: plan.targetBranch, planId: plan.id }), runtime] as const) : null;
        }),
      )
    ).filter(
      (
        entry,
      ): entry is readonly [
        string,
        NonNullable<Awaited<ReturnType<typeof readArchitectPlanRuntime>>>,
      ] => entry !== null,
    );
    const runtimeByPlanId = new Map(runtimeEntries);

    return {
      ...catalog,
      tasks: catalog.tasks.map((task) => {
        if (!task.plan_id) {
          return task;
        }
        const runtime = runtimeByPlanId.get(toPlanLocatorKey({
          branchName: task.plan_storage_branch || task.plan_target_branch || '',
          planId: task.plan_id,
        }));
        if (!runtime) {
          return task;
        }
        const session =
          runtime.mergeWorkflows[
            task.task_source === 'plan_finalization'
              ? buildPlanFinalizationTaskId(task.plan_id)
              : getTaskBusinessId(task)
          ] || null;
        if (!session) {
          return task;
        }
        return {
          ...task,
          merge_workflow: session,
          merge_workflow_summary:
            task.merge_workflow_summary ||
            summarizePersistedMergeWorkflowSession(session),
        };
      }),
    };
  };
};

export const loadImplementTaskCatalog = createLoadImplementTaskCatalog();
