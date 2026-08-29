import type { StrategyMutationPreview } from './architectStrategyMutationGuard';
import { getGitFlowBaseBranch, resolveTargetBranch, type ArchitectPlanRecord } from './architectPlanService';
import * as tauriIpc from './tauriIpc';
import { useAppStore } from '../stores/useAppStore';
import type { PersistedMergeWorkflowSession } from './mergeWorkflowPersistence';
import { filterNonWslProjectPaths } from './wslPaths';

const METADATA_WORKSPACE_SCOPE: tauriIpc.WorkspaceScope = 'metadata';
const runtimeMutationQueues = new Map<string, Promise<void>>();

type RuntimeWorkspaceTarget = {
  workspacePath: string;
  workspaceScope: tauriIpc.WorkspaceScope;
};

const serializeRuntimeMutation = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
  const previous = runtimeMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  runtimeMutationQueues.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (runtimeMutationQueues.get(key) === current) runtimeMutationQueues.delete(key);
  }
};

export interface ArchitectPlanRuntimeRecord {
  schemaVersion: 1;
  planId: string;
  updatedAt: string;
  mergeWorkflows: Record<string, PersistedMergeWorkflowSession>;
  strategyPreview: StrategyMutationPreview | null;
}

const sanitizeId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || `plan-${Date.now()}`;

const normalizeBranchName = (value?: string | null): string => {
  try {
    return resolveTargetBranch(value || getGitFlowBaseBranch());
  } catch {
    return getGitFlowBaseBranch();
  }
};

const unique = (items: Array<string | null | undefined>): string[] =>
  Array.from(
    new Set(
      items
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );

export const getArchitectPlanRuntimePath = (
  branchName: string,
  planId: string,
): string =>
  `branches/${normalizeBranchName(branchName)}/plans/${sanitizeId(planId)}/runtime.json`;

const emptyArchitectPlanRuntimeRecord = (
  planId: string,
): ArchitectPlanRuntimeRecord => ({
  schemaVersion: 1,
  planId,
  updatedAt: new Date().toISOString(),
  mergeWorkflows: {},
  strategyPreview: null,
});

const readRuntimeAtWorkspace = async (
  target: RuntimeWorkspaceTarget,
  runtimePath: string,
): Promise<ArchitectPlanRuntimeRecord | null> => {
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path: runtimePath,
      allowOutsideWorkspace: false,
      workspaceScope: target.workspaceScope,
      workspacePath: target.workspacePath,
    });
    const parsed = JSON.parse(file.content) as Partial<ArchitectPlanRuntimeRecord>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return {
      schemaVersion: 1,
      planId: typeof parsed.planId === 'string' ? parsed.planId : '',
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date().toISOString(),
      mergeWorkflows:
        parsed.mergeWorkflows && typeof parsed.mergeWorkflows === 'object'
          ? (parsed.mergeWorkflows as Record<string, PersistedMergeWorkflowSession>)
          : {},
      strategyPreview:
        parsed.strategyPreview && typeof parsed.strategyPreview === 'object'
          ? (parsed.strategyPreview as StrategyMutationPreview)
          : null,
    };
  } catch {
    return null;
  }
};

const writeRuntimeAtWorkspace = async (
  target: RuntimeWorkspaceTarget,
  runtimePath: string,
  record: ArchitectPlanRuntimeRecord,
): Promise<void> => {
  await tauriIpc.fsWriteFile({
    path: runtimePath,
    content: JSON.stringify(record, null, 2),
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: target.workspaceScope,
    workspacePath: target.workspacePath,
  });
};

const resolveRuntimeWorkspaceTargets = async (params: {
  projectIds?: string[] | null;
  repoPaths?: Array<string | null | undefined>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  allowFallbackPaths?: boolean;
}): Promise<RuntimeWorkspaceTarget[]> => {
  const appState = useAppStore.getState();
  const appStateWithOptionalProjects = appState as unknown as {
    projects?: Array<{ id?: string; path?: string | null }>;
  };
  const projects = Array.isArray(appStateWithOptionalProjects.projects)
    ? appStateWithOptionalProjects.projects
    : [];
  const registeredTargets = (params.projectIds || []).flatMap((projectId): RuntimeWorkspaceTarget[] => {
    const project = typeof appState.getProjectById === 'function'
      ? appState.getProjectById(projectId)
      : projects.find((candidate) => candidate.id === projectId);
    if (!project?.path || filterNonWslProjectPaths([project.path]).length === 0) {
      return [];
    }
    return [{
      workspacePath: project.path,
      workspaceScope: params.executionModesByProjectId?.[projectId] === 'direct'
        ? 'direct'
        : METADATA_WORKSPACE_SCOPE,
    }];
  });
  if (registeredTargets.length > 0) {
    return Array.from(new Map(
      registeredTargets.map((target) => [`${target.workspaceScope}:${target.workspacePath}`, target])
    ).values());
  }
  if (params.allowFallbackPaths === false) {
    return [];
  }
  let activeRoot: string | null = null;
  if (tauriIpc.isTauriAvailable()) {
    try {
      activeRoot = await tauriIpc.workspaceGetActiveRoot();
    } catch {
      activeRoot = null;
    }
  }

  return filterNonWslProjectPaths(unique([...(params.repoPaths || []), activeRoot])).map(
    (workspacePath) => ({ workspacePath, workspaceScope: METADATA_WORKSPACE_SCOPE })
  );
};

export const readArchitectPlanRuntime = async (params: {
  branchName: string;
  planId: string;
  projectIds?: string[] | null;
  repoPaths?: Array<string | null | undefined>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
}): Promise<ArchitectPlanRuntimeRecord | null> => {
  if (!tauriIpc.isTauriAvailable()) {
    return null;
  }

  const runtimePath = getArchitectPlanRuntimePath(params.branchName, params.planId);
  const workspaceTargets = await resolveRuntimeWorkspaceTargets(params);

  for (const target of workspaceTargets) {
    const record = await readRuntimeAtWorkspace(target, runtimePath);
    if (record) {
      return record.planId
        ? record
        : { ...record, planId: params.planId };
    }
  }

  return null;
};

export const writeArchitectPlanRuntime = async (params: {
  branchName: string;
  planId: string;
  projectIds?: string[] | null;
  repoPaths?: Array<string | null | undefined>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  record: ArchitectPlanRuntimeRecord;
}): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) {
    return;
  }

  const runtimePath = getArchitectPlanRuntimePath(params.branchName, params.planId);
  const workspaceTargets = await resolveRuntimeWorkspaceTargets({
    ...params,
    allowFallbackPaths: false,
  });
  if (workspaceTargets.length === 0) {
    return;
  }

  await Promise.all(
    workspaceTargets.map((target) =>
      writeRuntimeAtWorkspace(target, runtimePath, params.record),
    ),
  );
};

export const updateArchitectPlanRuntime = async (params: {
  branchName: string;
  plan: Pick<ArchitectPlanRecord, 'id' | 'projectIds' | 'projectId' | 'executionModesByProjectId'>;
  repoPaths?: Array<string | null | undefined>;
  update: (record: ArchitectPlanRuntimeRecord) => ArchitectPlanRuntimeRecord | null;
}): Promise<ArchitectPlanRuntimeRecord | null> => serializeRuntimeMutation(
  `${normalizeBranchName(params.branchName)}:${sanitizeId(params.plan.id)}`,
  async () => {
  const projectIds = [
    ...(params.plan.projectIds || []),
    ...(params.plan.projectId ? [params.plan.projectId] : []),
  ];
  const current =
    (await readArchitectPlanRuntime({
      branchName: params.branchName,
      planId: params.plan.id,
      projectIds,
      repoPaths: params.repoPaths,
      executionModesByProjectId: params.plan.executionModesByProjectId,
    })) || emptyArchitectPlanRuntimeRecord(params.plan.id);
  const updated = params.update(current);

  if (!updated) {
    return null;
  }

  const normalized: ArchitectPlanRuntimeRecord = {
    ...updated,
    schemaVersion: 1,
    planId: params.plan.id,
    updatedAt: new Date().toISOString(),
    mergeWorkflows: updated.mergeWorkflows || {},
    strategyPreview: updated.strategyPreview || null,
  };

  await writeArchitectPlanRuntime({
    branchName: params.branchName,
    planId: params.plan.id,
    projectIds,
    repoPaths: params.repoPaths,
    executionModesByProjectId: params.plan.executionModesByProjectId,
    record: normalized,
  });

    return normalized;
  },
);

export const persistArchitectPlanMergeWorkflowSession = async (params: {
  branchName: string;
  plan: Pick<ArchitectPlanRecord, 'id' | 'projectIds' | 'projectId'>;
  taskId: string;
  session: PersistedMergeWorkflowSession | null;
  repoPaths?: Array<string | null | undefined>;
}): Promise<ArchitectPlanRuntimeRecord | null> =>
  updateArchitectPlanRuntime({
    branchName: params.branchName,
    plan: params.plan,
    repoPaths: params.repoPaths,
    update: (record) => ({
      ...record,
      mergeWorkflows: params.session
        ? {
            ...record.mergeWorkflows,
            [params.taskId]: params.session,
          }
        : Object.fromEntries(
            Object.entries(record.mergeWorkflows).filter(
              ([taskId]) => taskId !== params.taskId,
            ),
          ),
    }),
  });

export const persistArchitectPlanStrategyPreview = async (params: {
  branchName: string;
  plan: Pick<ArchitectPlanRecord, 'id' | 'projectIds' | 'projectId'>;
  preview: StrategyMutationPreview | null;
  repoPaths?: Array<string | null | undefined>;
}): Promise<ArchitectPlanRuntimeRecord | null> =>
  updateArchitectPlanRuntime({
    branchName: params.branchName,
    plan: params.plan,
    repoPaths: params.repoPaths,
    update: (record) => ({
      ...record,
      strategyPreview: params.preview,
    }),
  });
