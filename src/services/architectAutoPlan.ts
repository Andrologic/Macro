import { getRegisteredAppStateSync } from './appStateRuntime';
import { createArchitectAutoPlanService } from './architectAutoPlanCore';
import { normalizeArchitectPlanKind } from './architectPlanKinds';
import {
  createArchitectPlan,
  deleteArchitectPlan,
  getArchitectPlan,
  getArchitectPlanChatMessages,
  getArchitectPlanNeeds,
  getArchitectPlanVisibleProjectIds,
  getGitFlowBaseBranch,
  listArchitectPlans,
  setActiveArchitectPlan,
  updateArchitectPlan,
} from './architectPlanService';
import {
  DEFAULT_NEW_PLAN_LABEL,
  getNextDefaultNewPlanLabel,
  getArchitectPlanEditableName,
  isDefaultNewPlanFamilyLabel,
  isDefaultNewPlanBaseLabel,
  isCanonicalArchitectPlan,
} from './architectPlanPresentation';

interface ArchitectAutoPlanProjectDescriptor {
  id: string;
  gitFlowSettings?: {
    baseBranch?: string | null;
  } | null;
}

interface ArchitectAutoPlanAppState {
  getProjectById?: (projectId: string) => ArchitectAutoPlanProjectDescriptor | undefined;
  projectGroups?: Array<{
    projects: ArchitectAutoPlanProjectDescriptor[];
  }>;
}

const findProjectInAppState = (
  appState: ArchitectAutoPlanAppState,
  projectId: string,
): ArchitectAutoPlanProjectDescriptor | undefined => {
  if (typeof appState.getProjectById === 'function') {
    const directMatch = appState.getProjectById(projectId);
    if (directMatch) {
      return directMatch;
    }
  }

  for (const group of appState.projectGroups || []) {
    const project = group.projects.find((candidate) => candidate.id === projectId);
    if (project) {
      return project;
    }
  }

  return undefined;
};

const resolveTargetBranchesByProjectId = (
  projectIds: string[],
): Record<string, string> => {
  const baseBranch = getGitFlowBaseBranch();
  let appState: ArchitectAutoPlanAppState | null = null;

  try {
    appState = getRegisteredAppStateSync<ArchitectAutoPlanAppState>();
  } catch {
    appState = null;
  }

  return Object.fromEntries(
    projectIds.map((projectId) => {
      const project = appState ? findProjectInAppState(appState, projectId) : undefined;
      const targetBranch = project?.gitFlowSettings?.baseBranch?.trim() || baseBranch;
      return [projectId, targetBranch];
    }),
  );
};

const createLazyArchitectAutoPlanService = () =>
  createArchitectAutoPlanService({
    DEFAULT_NEW_PLAN_LABEL,
    createArchitectPlan,
    deleteArchitectPlan,
    getArchitectPlan,
    getArchitectPlanChatMessages,
    getArchitectPlanEditableName,
    getArchitectPlanNeeds,
    getArchitectPlanVisibleProjectIds,
    getNextDefaultNewPlanLabel,
    isCanonicalArchitectPlan,
    isDefaultNewPlanFamilyLabel,
    isDefaultNewPlanBaseLabel,
    listArchitectPlans,
    getTargetBranchesByProjectId: resolveTargetBranchesByProjectId,
    setActiveArchitectPlan: async (branchName, planId) => {
      if (!planId) {
        return;
      }
      await setActiveArchitectPlan(branchName, planId);
    },
    updateArchitectPlan: async (params) => {
      const targetBranchesByProjectId =
        params.targetBranchesByProjectId ||
        (params.projectIds?.length ? resolveTargetBranchesByProjectId(params.projectIds) : undefined);
      return updateArchitectPlan({
        ...params,
        targetBranchesByProjectId,
      });
    },
  });

const withArchitectAutoPlanService = <T>(
  callback: (service: ReturnType<typeof createArchitectAutoPlanService>) => T,
): T => callback(createLazyArchitectAutoPlanService());

const pendingScopedBlankPlanEnsuresByKey = new Map<
  string,
  ReturnType<ReturnType<typeof createArchitectAutoPlanService>['ensureScopedBlankPlan']>
>();

const normalizeIdListForKey = (values?: string[]): string =>
  Array.from(
    new Set(
      (values || [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  )
    .sort((left, right) => left.localeCompare(right))
    .join(',');

const getEnsureScopedBlankPlanLockKey = (
  params: Parameters<ReturnType<typeof createArchitectAutoPlanService>['ensureScopedBlankPlan']>[0]
): string =>
  JSON.stringify({
    branchName: params.branchName.trim(),
    scopedProjectIds: normalizeIdListForKey(params.scopedProjectIds),
    contextProjectIds: normalizeIdListForKey(params.contextProjectIds),
    planKind: normalizeArchitectPlanKind(params.planKind || params.createPlanInput?.planKind),
  });

export const isArchitectPlanBlankDraft = (...args: Parameters<ReturnType<typeof createArchitectAutoPlanService>['isArchitectPlanBlankDraft']>) =>
  withArchitectAutoPlanService((service) => service.isArchitectPlanBlankDraft(...args));

export const isReusableBlankDraft = (...args: Parameters<ReturnType<typeof createArchitectAutoPlanService>['isReusableBlankDraft']>) =>
  withArchitectAutoPlanService((service) => service.isReusableBlankDraft(...args));

export const consolidateScopedBlankPlans = (...args: Parameters<ReturnType<typeof createArchitectAutoPlanService>['consolidateScopedBlankPlans']>) =>
  withArchitectAutoPlanService((service) => service.consolidateScopedBlankPlans(...args));

export const ensureScopedBlankPlan = (...args: Parameters<ReturnType<typeof createArchitectAutoPlanService>['ensureScopedBlankPlan']>) => {
  const [params] = args;
  if (params.trigger !== 'explicit_create') {
    return withArchitectAutoPlanService((service) => service.ensureScopedBlankPlan(...args));
  }

  const lockKey = getEnsureScopedBlankPlanLockKey(params);
  const pending = pendingScopedBlankPlanEnsuresByKey.get(lockKey);
  if (pending) {
    return pending;
  }

  const task = withArchitectAutoPlanService((service) => service.ensureScopedBlankPlan(...args));
  pendingScopedBlankPlanEnsuresByKey.set(lockKey, task);
  task.finally(() => {
    pendingScopedBlankPlanEnsuresByKey.delete(lockKey);
  });
  return task;
};

export const ensureProjectGroupPlan = (...args: Parameters<ReturnType<typeof createArchitectAutoPlanService>['ensureProjectGroupPlan']>) =>
  withArchitectAutoPlanService((service) => service.ensureProjectGroupPlan(...args));
