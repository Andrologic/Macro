import type { StrategyMutationPreview } from './architectStrategyMutationGuard';
import { getGitFlowBaseBranch, resolveTargetBranch, type ArchitectPlanRecord } from './architectPlanService';
import * as tauriIpc from './tauriIpc';
import { useAppStore } from '../stores/useAppStore';
import type { PersistedMergeWorkflowSession } from './mergeWorkflowPersistence';
import { filterNonWslProjectPaths } from './wslPaths';
import { toServiceError } from './contracts/errors';
import { toPlanLocatorKey } from './durableIdentity';

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
  generation?: number;
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

type RuntimeSnapshot = {
  target: RuntimeWorkspaceTarget;
  record: ArchitectPlanRuntimeRecord | null;
  revision: string;
};

type RuntimeJournal = {
  generation: number;
  pending: {
    record: ArchitectPlanRuntimeRecord;
    replicas: Array<{ target: RuntimeWorkspaceTarget; revision: string }>;
  } | null;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Key order is not a replica revision. Preserve all fields while comparing JSON.
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  isObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
);

const validateRuntime = (value: unknown, planId: string): ArchitectPlanRuntimeRecord => {
  if (!isObject(value) || value.schemaVersion !== 1 || value.planId !== planId ||
    typeof value.updatedAt !== 'string' || !isObject(value.mergeWorkflows) ||
    (value.strategyPreview !== null && !isObject(value.strategyPreview)) ||
    (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || Number(value.generation) < 0))) {
    throw new Error('Invalid plan runtime. Existing data was preserved.');
  }
  for (const session of Object.values(value.mergeWorkflows)) {
    if (!isObject(session) || !['task_completion', 'plan_finalization'].includes(String(session.kind)) ||
      !Array.isArray(session.repositories) || typeof session.phase !== 'string' ||
      typeof session.taskStatus !== 'string' || typeof session.startedAt !== 'string' ||
      typeof session.updatedAt !== 'string' || session.repositories.some((repo: unknown) =>
        !isObject(repo) || typeof repo.id !== 'string' || typeof repo.projectId !== 'string' ||
        typeof repo.repoPath !== 'string' || typeof repo.sourceBranchName !== 'string' ||
        typeof repo.targetBranchName !== 'string' || !Array.isArray(repo.conflictFiles) ||
        !['pending', 'merged', 'blocked', 'no_changes'].includes(String(repo.state))
      )) {
      throw new Error('Invalid merge session in plan runtime. Existing data was preserved.');
    }
  }
  if (isObject(value.strategyPreview) &&
    (value.strategyPreview.planId !== planId || !Array.isArray(value.strategyPreview.planNodes))) {
    throw new Error('Invalid strategy preview in plan runtime. Existing data was preserved.');
  }
  return value as unknown as ArchitectPlanRuntimeRecord;
};

const readRuntimeAtWorkspace = async (
  target: RuntimeWorkspaceTarget,
  runtimePath: string,
  planId: string,
): Promise<RuntimeSnapshot> => {
  let file: tauriIpc.FsFileContentDto;
  try {
    file = await tauriIpc.fsReadFileWithOptions({
      path: runtimePath,
      allowOutsideWorkspace: false,
      ...target,
    });
  } catch (error) {
    if (toServiceError(error).code === 'FilesystemNotFound') {
      return { target, record: null, revision: 'absent' };
    }
    throw error;
  }
  const record = validateRuntime(JSON.parse(file.content), planId);
  if (!file.revision) throw new Error('Plan runtime read did not include a file revision.');
  return { target, record, revision: file.revision };
};

const runtimeJournalKey = (branchName: string, planId: string): string =>
  `planRuntimeReplication:v1:${toPlanLocatorKey({ branchName: normalizeBranchName(branchName), planId })}`;

const readRuntimeJournal = async (key: string, planId: string): Promise<{ raw: string | null; journal: RuntimeJournal }> => {
  const raw = (await tauriIpc.dbGetAppSetting(key))?.value_json ?? null;
  if (raw === null) return { raw, journal: { generation: 0, pending: null } };
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed) || !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 0 ||
    (parsed.pending !== null && !isObject(parsed.pending))) {
    throw new Error('Invalid runtime replication journal. Recovery is blocked.');
  }
  if (isObject(parsed.pending)) {
    const record = validateRuntime(parsed.pending.record, planId);
    if (record.generation !== parsed.generation || !Array.isArray(parsed.pending.replicas) || !parsed.pending.replicas.length ||
      parsed.pending.replicas.some((replica: unknown) => !isObject(replica) || !isObject(replica.target) ||
        typeof replica.target.workspacePath !== 'string' || !['metadata', 'direct'].includes(String(replica.target.workspaceScope)) ||
        typeof replica.revision !== 'string')) {
      throw new Error('Invalid runtime replication intent. Recovery is blocked.');
    }
  }
  return { raw, journal: parsed as unknown as RuntimeJournal };
};

const targetKey = (target: RuntimeWorkspaceTarget): string => `${target.workspaceScope}:${target.workspacePath}`;

const recoverRuntimeReplication = async (
  key: string, runtimePath: string, planId: string, targets: RuntimeWorkspaceTarget[],
): Promise<void> => {
  const { raw, journal } = await readRuntimeJournal(key, planId);
  if (!journal.pending) return;
  const pending = journal.pending;
  const allowed = new Set(targets.map(targetKey));
  if (pending.replicas.some(({ target }) => !allowed.has(targetKey(target)))) {
    throw new Error('Runtime replication requires its original project roots before recovery.');
  }
  // Settle every write before another mutation can proceed. Each write also fences
  // other windows/processes, and a lost response can be reconciled by content.
  const results = await Promise.allSettled(pending.replicas.map(async ({ target, revision }) => {
    const snapshot = await readRuntimeAtWorkspace(target, runtimePath, planId);
    if (canonicalJson(snapshot.record) === canonicalJson(pending.record)) return;
    if (snapshot.revision !== revision) throw new Error('Runtime replica changed outside the pending mutation.');
    try {
      await tauriIpc.fsWriteFile({
        path: runtimePath, content: JSON.stringify(pending.record, null, 2), createDirs: true,
        allowOutsideWorkspace: false, ...target, expectedRevision: revision,
      });
    } catch (error) {
      const after = await readRuntimeAtWorkspace(target, runtimePath, planId);
      if (canonicalJson(after.record) !== canonicalJson(pending.record)) throw error;
    }
  }));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  const result = await tauriIpc.dbCompareAndSwapAppSetting({
    key, expectedValueJson: raw, valueJson: JSON.stringify({ generation: journal.generation, pending: null }),
  });
  if (!result.applied) {
    const latest = await readRuntimeJournal(key, planId);
    if (latest.journal.generation === journal.generation && latest.journal.pending) {
      throw new Error('Runtime replication completion could not be confirmed.');
    }
  }
};

const readCoherentRuntime = async (
  targets: RuntimeWorkspaceTarget[], runtimePath: string, planId: string, completedGeneration: number,
) => {
  const snapshots = await Promise.all(targets.map((target) => readRuntimeAtWorkspace(target, runtimePath, planId)));
  const present = snapshots.filter((snapshot) => snapshot.record !== null);
  const current = present[0]?.record ?? null;
  if ((current?.generation ?? 0) < completedGeneration) {
    throw new Error('Plan runtime replicas are older than the completed replication journal. Existing data was preserved.');
  }
  if (present.some(({ record }) => canonicalJson(record) !== canonicalJson(current))) {
    throw new Error('Plan runtime replicas diverged. Existing data was preserved.');
  }
  return { snapshots, current };
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
      throw new Error(`Project ${projectId} is unavailable for runtime replication.`);
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

  const key = runtimeJournalKey(params.branchName, params.planId);
  return serializeRuntimeMutation(key, async () => {
    await recoverRuntimeReplication(key, runtimePath, params.planId, workspaceTargets);
    const { journal } = await readRuntimeJournal(key, params.planId);
    return (await readCoherentRuntime(workspaceTargets, runtimePath, params.planId, journal.generation)).current;
  });
};

export const updateArchitectPlanRuntime = async (params: {
  branchName: string;
  plan: Pick<ArchitectPlanRecord, 'id' | 'projectIds' | 'projectId' | 'executionModesByProjectId'>;
  repoPaths?: Array<string | null | undefined>;
  update: (record: ArchitectPlanRuntimeRecord) => ArchitectPlanRuntimeRecord | null;
}): Promise<ArchitectPlanRuntimeRecord | null> => {
  if (!tauriIpc.isTauriAvailable()) return null;
  const planId = params.plan.id;
  const runtimePath = getArchitectPlanRuntimePath(params.branchName, planId);
  const key = runtimeJournalKey(params.branchName, planId);
  return serializeRuntimeMutation(key, async () => {
    const projectIds = unique([...(params.plan.projectIds || []), params.plan.projectId]);
    const targets = await resolveRuntimeWorkspaceTargets({
      projectIds, executionModesByProjectId: params.plan.executionModesByProjectId, allowFallbackPaths: false,
    });
    if (!targets.length) throw new Error('No project root is available for runtime persistence.');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await recoverRuntimeReplication(key, runtimePath, planId, targets);
      const { raw, journal } = await readRuntimeJournal(key, planId);
      if (journal.pending) continue;
      const { snapshots, current } = await readCoherentRuntime(targets, runtimePath, planId, journal.generation);
      const updated = params.update(current ?? emptyArchitectPlanRuntimeRecord(planId));
      if (!updated) return null;
      const generation = Math.max(journal.generation, current?.generation ?? 0) + 1;
      const record = validateRuntime({ ...updated, schemaVersion: 1, planId, generation, updatedAt: new Date().toISOString() }, planId);
      const next: RuntimeJournal = {
        generation, pending: { record, replicas: snapshots.map(({ target, revision }) => ({ target, revision })) },
      };
      const claimed = await tauriIpc.dbCompareAndSwapAppSetting({ key, expectedValueJson: raw, valueJson: JSON.stringify(next) });
      if (!claimed.applied) continue;
      await recoverRuntimeReplication(key, runtimePath, planId, targets);
      return record;
    }
    throw new Error('Plan runtime changed repeatedly. Retry the operation.');
  });
};

export const persistArchitectPlanMergeWorkflowSession = async (params: {
  branchName: string;
  plan: Pick<ArchitectPlanRecord, 'id' | 'projectIds' | 'projectId' | 'executionModesByProjectId'>;
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
  plan: Pick<ArchitectPlanRecord, 'id' | 'projectIds' | 'projectId' | 'executionModesByProjectId'>;
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
