import type { StrategyMutationPreview } from './architectStrategyMutationGuard';
import { getGitFlowBaseBranch, resolveTargetBranch, type ArchitectPlanRecord } from './architectPlanService';
import * as tauriIpc from './tauriIpc';
import { useAppStore } from '../stores/useAppStore';
import type { PersistedMergeWorkflowSession } from './mergeWorkflowPersistence';
import { filterNonWslProjectPaths } from './wslPaths';

const METADATA_WORKSPACE_SCOPE: tauriIpc.WorkspaceScope = 'metadata';

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
  workspacePath: string,
  runtimePath: string,
): Promise<ArchitectPlanRuntimeRecord | null> => {
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path: runtimePath,
      allowOutsideWorkspace: false,
      workspaceScope: METADATA_WORKSPACE_SCOPE,
      workspacePath,
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
  workspacePath: string,
  runtimePath: string,
  record: ArchitectPlanRuntimeRecord,
): Promise<void> => {
  await tauriIpc.fsWriteFile({
    path: runtimePath,
    content: JSON.stringify(record, null, 2),
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: METADATA_WORKSPACE_SCOPE,
    workspacePath,
  });
};

const resolveRuntimeWorkspacePaths = async (params: {
  projectIds?: string[] | null;
  repoPaths?: Array<string | null | undefined>;
}): Promise<string[]> => {
  const appState = useAppStore.getState();
  const appStateWithOptionalProjects = appState as unknown as {
    projects?: Array<{ id?: string; path?: string | null }>;
  };
  const projects = Array.isArray(appStateWithOptionalProjects.projects)
    ? appStateWithOptionalProjects.projects
    : [];
  const projectPaths = (params.projectIds || []).map((projectId) => {
    const project = typeof appState.getProjectById === 'function'
      ? appState.getProjectById(projectId)
      : projects.find((candidate) => candidate.id === projectId);

    return project?.path ?? null;
  });
  let activeRoot: string | null = null;
  if (tauriIpc.isTauriAvailable()) {
    try {
      activeRoot = await tauriIpc.workspaceGetActiveRoot();
    } catch {
      activeRoot = null;
    }
  }

  return filterNonWslProjectPaths(unique([...(params.repoPaths || []), ...projectPaths, activeRoot]));
};

export const readArchitectPlanRuntime = async (params: {
  branchName: string;
  planId: string;
  projectIds?: string[] | null;
  repoPaths?: Array<string | null | undefined>;
}): Promise<ArchitectPlanRuntimeRecord | null> => {
  if (!tauriIpc.isTauriAvailable()) {
    return null;
  }

  const runtimePath = getArchitectPlanRuntimePath(params.branchName, params.planId);
  const workspacePaths = await resolveRuntimeWorkspacePaths(params);

  for (const workspacePath of workspacePaths) {
    const record = await readRuntimeAtWorkspace(workspacePath, runtimePath);
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
  record: ArchitectPlanRuntimeRecord;
}): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) {
    return;
  }

  const runtimePath = getArchitectPlanRuntimePath(params.branchName, params.planId);
  const workspacePaths = await resolveRuntimeWorkspacePaths(params);
  if (workspacePaths.length === 0) {
    return;
  }

  await Promise.all(
    workspacePaths.map((workspacePath) =>
      writeRuntimeAtWorkspace(workspacePath, runtimePath, params.record),
    ),
  );
};

export const updateArchitectPlanRuntime = async (params: {
  branchName: string;
  plan: Pick<ArchitectPlanRecord, 'id' | 'projectIds' | 'projectId'>;
  repoPaths?: Array<string | null | undefined>;
  update: (record: ArchitectPlanRuntimeRecord) => ArchitectPlanRuntimeRecord | null;
}): Promise<ArchitectPlanRuntimeRecord | null> => {
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
    record: normalized,
  });

  return normalized;
};

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
