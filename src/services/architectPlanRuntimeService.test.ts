import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { Project } from '../types';
import { useAppStore } from '../stores/useAppStore';
import type { ArchitectPlanRuntimeRecord } from './architectPlanRuntimeService';

const actualTauriIpc = await import('./tauriIpc');

type WorkspaceScope = 'metadata' | 'direct';
type FileRecord = { content: string; revision: string };
type FileTarget = { workspaceScope: WorkspaceScope; workspacePath: string; path: string };
type WriteCall = FileTarget & { content: string; expectedRevision: string };
type ReadParams = { path?: string; workspaceScope?: string; workspacePath?: string | null };
type WriteParams = ReadParams & { content: string; expectedRevision?: string | null };

const RUNTIME_PATH = 'branches/develop/plans/plan-1/runtime.json';
const JOURNAL_KEY = 'planRuntimeReplication:v1:plan:v1:develop:plan-1';
const files = new Map<string, FileRecord>();
const appSettings = new Map<string, string>();
const readFailures = new Map<string, unknown>();
const failNextWrites = new Set<string>();
const loseNextWriteResponses = new Set<string>();
const writeGates = new Map<string, Promise<void>>();
const writeCalls: WriteCall[] = [];
const casCalls: Array<{ key: string; expectedValueJson: string | null; valueJson: string }> = [];
let revisionCounter = 0;
let runtimeImportCounter = 0;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type DelayedFirstCas = {
  gate: Deferred;
  started: boolean;
  released: boolean;
  fastRejectionReturned: boolean;
};

let delayedFirstCas: DelayedFirstCas | null = null;

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for the mocked runtime state.');
};

const fileKey = ({ workspaceScope, workspacePath, path }: FileTarget): string =>
  `${workspaceScope}:${workspacePath}:${path}`;

const target = (workspacePath: string, workspaceScope: WorkspaceScope = 'metadata'): FileTarget => ({
  workspaceScope,
  workspacePath,
  path: RUNTIME_PATH,
});

const requireTarget = (params: ReadParams): FileTarget => {
  if (!params.path || !params.workspaceScope || !params.workspacePath) {
    throw new Error('The runtime mock requires workspaceScope, workspacePath, and path.');
  }
  if (params.workspaceScope !== 'metadata' && params.workspaceScope !== 'direct') {
    throw new Error(`Unexpected workspace scope: ${params.workspaceScope}`);
  }
  return {
    path: params.path,
    workspaceScope: params.workspaceScope,
    workspacePath: params.workspacePath,
  };
};

const nextRevision = (): string => `revision-${++revisionCounter}`;

const createTauriModule = () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  workspaceGetActiveRoot: async () => 'C:/repo-a',
  fsReadFileWithOptions: async (params: ReadParams) => {
    const fileTarget = requireTarget(params);
    const key = fileKey(fileTarget);
    const failure = readFailures.get(key);
    if (failure !== undefined) throw failure;
    const file = files.get(key);
    if (!file) {
      throw { code: 'FilesystemNotFound', message: `Missing runtime file: ${key}` };
    }
    return {
      content: file.content,
      language: 'json',
      is_binary: false,
      size: file.content.length,
      encoding: 'utf-8',
      revision: file.revision,
    };
  },
  fsWriteFile: async (params: WriteParams) => {
    const fileTarget = requireTarget(params);
    if (!params.content || typeof params.expectedRevision !== 'string') {
      throw new Error('The runtime mock requires content and expectedRevision.');
    }
    const key = fileKey(fileTarget);
    writeCalls.push({
      ...fileTarget,
      expectedRevision: params.expectedRevision,
      content: params.content,
    });
    const gate = writeGates.get(key);
    if (gate) await gate;
    if (failNextWrites.delete(key)) {
      throw new Error(`Injected runtime write failure for ${key}`);
    }
    const current = files.get(key);
    const currentRevision = current?.revision ?? 'absent';
    if (currentRevision !== params.expectedRevision) {
      throw {
        code: 'FilesystemRevisionConflict',
        message: `Expected ${params.expectedRevision}, found ${currentRevision}`,
      };
    }
    const revision = nextRevision();
    files.set(key, { content: params.content, revision });
    if (loseNextWriteResponses.delete(key)) {
      throw new Error(`Lost runtime write response for ${key}`);
    }
    return {
      path: fileTarget.path,
      bytes_written: params.content.length,
      created: current === undefined,
      skipped: false,
    };
  },
  dbGetAppSetting: async (key: string) => {
    const value = appSettings.get(key);
    return value === undefined
      ? null
      : { key, value_json: value, updated_at: '2026-09-16T00:00:00.000Z' };
  },
  dbCompareAndSwapAppSetting: async (params: {
    key: string;
    expectedValueJson: string | null;
    valueJson: string;
  }) => {
    casCalls.push(params);
    if (delayedFirstCas) {
      if (!delayedFirstCas.started) {
        delayedFirstCas.started = true;
        await delayedFirstCas.gate.promise;
        delayedFirstCas.released = true;
      } else if (!delayedFirstCas.released && !delayedFirstCas.fastRejectionReturned) {
        delayedFirstCas.fastRejectionReturned = true;
        return { applied: false };
      } else if (!delayedFirstCas.released) {
        await delayedFirstCas.gate.promise;
      }
    }
    const current = appSettings.get(params.key) ?? null;
    if (current !== params.expectedValueJson) return { applied: false };
    appSettings.set(params.key, params.valueJson);
    return { applied: true };
  },
});

mock.module('./tauriIpc', createTauriModule);
mock.module('./tauriIpc.ts', createTauriModule);

const loadRuntimeService = async () => {
  runtimeImportCounter += 1;
  return import(`./architectPlanRuntimeService.ts?runtime-test=${runtimeImportCounter}`);
};

const makeProject = (id: string, path: string): Project => ({
  id,
  name: id,
  mountName: id,
  path,
  created_at: '2026-09-16T00:00:00.000Z',
  status: 'active',
  gitSetupState: 'ready',
  directEdit: false,
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
});

const configureProjects = (projects: Project[]): void => {
  useAppStore.setState({ standaloneProjects: projects, projectGroups: [] });
};

const planFor = (projectIds: string[]) => ({
  id: 'plan-1',
  projectIds,
});

const makeMergeSession = (taskId: string) => ({
  kind: 'task_completion' as const,
  phase: 'ready' as const,
  taskStatus: 'InProgress' as const,
  startedAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:01:00.000Z',
  lastLoadedAt: '2026-09-16T00:01:00.000Z',
  message: `Session ${taskId}`,
  repositories: [{
    id: `${taskId}-repo`,
    projectId: 'project-a',
    repoPath: 'C:/repo-a',
    repositoryRootPath: 'C:/repo-a',
    integrationWorktreePath: null,
    sourceBranchName: `feature/${taskId}`,
    targetBranchName: 'develop',
    state: 'pending' as const,
    hadChangesAtStart: true,
    mergeAppliedAt: null,
    blockingKind: null,
    blockingReason: null,
    conflictFiles: [],
    dirtyFiles: [],
    mergeInProgress: false,
    ahead: 0,
    behind: 0,
    isSourcePublished: false,
    mergeStrategy: 'merge_commit' as const,
    recommendedAction: null,
    availableActions: [],
  }],
});

const makeStrategyPreview = (planId = 'plan-1') => {
  const node = {
    id: 'node-1',
    title: 'Preview node',
    type: 'task' as const,
    status: 'pending' as const,
    dependencies: [],
    projectId: 'project-a',
    projectIds: ['project-a'],
  };
  return {
    planId,
    planTitle: 'Runtime test plan',
    source: 'strategy_update' as const,
    status: 'valid' as const,
    requiresPreview: true,
    repairAttempted: false,
    baseRevision: 1,
    targetBranch: 'develop',
    nextPlanStatus: 'validated' as const,
    autoProvisionBranches: false,
    metadataUpdate: { description: 'Preview description' },
    resolvedProjectIds: ['project-a'],
    targetBranchesByProjectId: { 'project-a': 'develop' },
    planNodes: [node],
    predictedBranches: [{
      id: 'branch-1',
      name: 'feature/node-1',
      color: '#3b82f6',
      parentBranch: 'develop',
      projectId: 'project-a',
      taskIds: ['node-1'],
      status: 'pending' as const,
    }],
    frozenNodes: [{
      id: 'node-1',
      title: 'Preview node',
      reason: 'completed' as const,
      status: 'completed' as const,
      dependencies: [],
      projectIds: ['project-a'],
      node: { ...node, status: 'completed' as const },
    }],
    rewrittenPendingNodes: [],
    newNodes: [{ id: 'node-1', title: 'Preview node' }],
    removedPendingNodes: [],
    conflicts: [],
  };
};

const makeRuntimeRecord = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1 as const,
  generation: 1,
  planId: 'plan-1',
  updatedAt: '2026-09-16T00:00:00.000Z',
  mergeWorkflows: {},
  strategyPreview: null,
  ...overrides,
});

const seedRuntime = (
  workspacePath: string,
  record: unknown,
  workspaceScope: WorkspaceScope = 'metadata',
): void => {
  const file = target(workspacePath, workspaceScope);
  files.set(fileKey(file), {
    content: typeof record === 'string' ? record : JSON.stringify(record, null, 2),
    revision: `seed-${++revisionCounter}`,
  });
};

const persistedRecord = (workspacePath: string, workspaceScope: WorkspaceScope = 'metadata') => {
  const file = files.get(fileKey(target(workspacePath, workspaceScope)));
  return file ? JSON.parse(file.content) : null;
};

const journal = (): Record<string, unknown> | null => {
  const raw = appSettings.get(JOURNAL_KEY);
  return raw ? JSON.parse(raw) as Record<string, unknown> : null;
};

const resetMockState = (): void => {
  files.clear();
  appSettings.clear();
  readFailures.clear();
  failNextWrites.clear();
  loseNextWriteResponses.clear();
  writeGates.clear();
  writeCalls.length = 0;
  casCalls.length = 0;
  revisionCounter = 0;
  delayedFirstCas = null;
};

afterEach(() => {
  resetMockState();
  useAppStore.setState({ standaloneProjects: [], projectGroups: [] });
});

describe('architectPlanRuntimeService', () => {
  it('serializes concurrent read-modify-write updates and preserves valid sibling sessions', async () => {
    configureProjects([makeProject('project-a', 'C:/repo-a')]);
    seedRuntime('C:/repo-a', makeRuntimeRecord({ strategyPreview: makeStrategyPreview() }));
    const runtime = await loadRuntimeService();
    const base = { branchName: 'develop', plan: planFor(['project-a']) };

    await Promise.all([
      runtime.updateArchitectPlanRuntime({
        ...base,
        update: (record: ArchitectPlanRuntimeRecord) => ({
          ...record,
          mergeWorkflows: { ...record.mergeWorkflows, first: makeMergeSession('first') },
        }),
      }),
      runtime.updateArchitectPlanRuntime({
        ...base,
        update: (record: ArchitectPlanRuntimeRecord) => ({
          ...record,
          mergeWorkflows: { ...record.mergeWorkflows, second: makeMergeSession('second') },
        }),
      }),
    ]);

    const persisted = persistedRecord('C:/repo-a');
    expect(Object.keys(persisted.mergeWorkflows).sort()).toEqual(['first', 'second']);
    expect(persisted.mergeWorkflows.first.repositories[0].repoPath).toBe('C:/repo-a');
    expect(persisted.strategyPreview.planId).toBe('plan-1');
    expect(persisted.generation).toBe(3);
  });

  it('keeps a persisted direct plan runtime in the project .macro scope after Git appears', async () => {
    configureProjects([{
      ...makeProject('project-direct', 'C:/direct-project'),
      name: 'Direct project',
      mountName: 'direct-project',
      directEdit: true,
    }]);
    const runtime = await loadRuntimeService();

    await runtime.updateArchitectPlanRuntime({
      branchName: 'develop',
      plan: {
        id: 'plan-direct',
        projectIds: ['project-direct'],
        executionModesByProjectId: { 'project-direct': 'direct' },
      },
      repoPaths: ['C:/old-direct-project'],
      update: (record: ArchitectPlanRuntimeRecord) => record,
    });

    const directFile = files.get(fileKey({
      workspaceScope: 'direct',
      workspacePath: 'C:/direct-project',
      path: 'branches/develop/plans/plan-direct/runtime.json',
    }));
    expect(directFile).toBeDefined();
    expect(files.has(fileKey({
      workspaceScope: 'metadata',
      workspacePath: 'C:/direct-project',
      path: 'branches/develop/plans/plan-direct/runtime.json',
    }))).toBe(false);
    expect(JSON.parse(directFile!.content).planId).toBe('plan-direct');
  });

  it('preserves direct scope through the strategy preview persistence wrapper', async () => {
    configureProjects([{
      ...makeProject('project-direct', 'C:/direct-project'),
      name: 'Direct project',
      mountName: 'direct-project',
      directEdit: true,
    }]);
    const runtime = await loadRuntimeService();

    await runtime.persistArchitectPlanStrategyPreview({
      branchName: 'develop',
      plan: {
        id: 'plan-direct-wrapper',
        projectIds: ['project-direct'],
        executionModesByProjectId: { 'project-direct': 'direct' },
      },
      preview: null,
    });

    const directFile = files.get(fileKey({
      workspaceScope: 'direct',
      workspacePath: 'C:/direct-project',
      path: 'branches/develop/plans/plan-direct-wrapper/runtime.json',
    }));
    expect(directFile).toBeDefined();
    expect(JSON.parse(directFile!.content)).toMatchObject({
      schemaVersion: 1,
      planId: 'plan-direct-wrapper',
      strategyPreview: null,
    });
  });

  it.each([
    ['a filesystem read error', 'read-error'],
    ['invalid JSON', '{ not json'],
    ['an invalid runtime schema', JSON.stringify({ schemaVersion: 2, planId: 'plan-1' })],
  ])('rejects %s without writing or losing the existing bytes', async (_label, content) => {
    configureProjects([makeProject('project-a', 'C:/repo-a')]);
    seedRuntime('C:/repo-a', content);
    if (content === 'read-error') {
      readFailures.set(fileKey(target('C:/repo-a')), {
        code: 'FilesystemUnavailable',
        message: 'The workspace read failed',
      });
    }
    const before = files.get(fileKey(target('C:/repo-a')))!;
    const runtime = await loadRuntimeService();

    await expect(runtime.updateArchitectPlanRuntime({
      branchName: 'develop',
      plan: planFor(['project-a']),
      update: (record: ArchitectPlanRuntimeRecord) => ({
        ...record,
        mergeWorkflows: { ...record.mergeWorkflows, new: makeMergeSession('new') },
      }),
    })).rejects.toThrow();

    expect(writeCalls).toHaveLength(0);
    expect(casCalls).toHaveLength(0);
    expect(files.get(fileKey(target('C:/repo-a')))).toEqual(before);
    expect(appSettings.size).toBe(0);
  });

  it('recovers a partial replication after a fresh module context', async () => {
    configureProjects([
      makeProject('project-a', 'C:/repo-a'),
      makeProject('project-b', 'C:/repo-b'),
    ]);
    const failingTarget = fileKey(target('C:/repo-b'));
    failNextWrites.add(failingTarget);
    const firstRuntime = await loadRuntimeService();

    await expect(firstRuntime.updateArchitectPlanRuntime({
      branchName: 'develop',
      plan: planFor(['project-a', 'project-b']),
      update: (record: ArchitectPlanRuntimeRecord) => ({
        ...record,
        mergeWorkflows: { ...record.mergeWorkflows, first: makeMergeSession('first') },
      }),
    })).rejects.toThrow('Injected runtime write failure');

    expect(persistedRecord('C:/repo-a').mergeWorkflows.first).toBeDefined();
    expect(persistedRecord('C:/repo-b')).toBeNull();
    expect(journal()?.pending).toBeDefined();

    const restartedRuntime = await loadRuntimeService();
    const recovered = await restartedRuntime.readArchitectPlanRuntime({
      branchName: 'develop',
      planId: 'plan-1',
      projectIds: ['project-a', 'project-b'],
    });

    expect(recovered?.mergeWorkflows.first).toBeDefined();
    expect(persistedRecord('C:/repo-a')).toEqual(persistedRecord('C:/repo-b'));
    expect(journal()).toEqual({ generation: 1, pending: null });
  });

  it('reconciles a write that succeeded before its response was lost', async () => {
    configureProjects([makeProject('project-a', 'C:/repo-a')]);
    loseNextWriteResponses.add(fileKey(target('C:/repo-a')));
    const runtime = await loadRuntimeService();

    const result = await runtime.updateArchitectPlanRuntime({
      branchName: 'develop',
      plan: planFor(['project-a']),
      update: (record: ArchitectPlanRuntimeRecord) => ({
        ...record,
        mergeWorkflows: { ...record.mergeWorkflows, recovered: makeMergeSession('recovered') },
      }),
    });

    expect(result?.mergeWorkflows.recovered).toBeDefined();
    expect(persistedRecord('C:/repo-a').mergeWorkflows.recovered).toBeDefined();
    expect(journal()).toEqual({ generation: 1, pending: null });
  });

  it('refuses divergent legacy replicas without a replication intent and preserves both files', async () => {
    configureProjects([
      makeProject('project-a', 'C:/repo-a'),
      makeProject('project-b', 'C:/repo-b'),
    ]);
    const left = makeRuntimeRecord({ mergeWorkflows: { left: makeMergeSession('left') } });
    const right = makeRuntimeRecord({ mergeWorkflows: { right: makeMergeSession('right') } });
    seedRuntime('C:/repo-a', left);
    seedRuntime('C:/repo-b', right);
    const before = [files.get(fileKey(target('C:/repo-a'))), files.get(fileKey(target('C:/repo-b')))];
    const runtime = await loadRuntimeService();

    await expect(runtime.updateArchitectPlanRuntime({
      branchName: 'develop',
      plan: planFor(['project-a', 'project-b']),
      update: (record: ArchitectPlanRuntimeRecord) => ({ ...record, strategyPreview: makeStrategyPreview() }),
    })).rejects.toThrow('replicas diverged');

    expect(writeCalls).toHaveLength(0);
    expect(appSettings.size).toBe(0);
    expect([files.get(fileKey(target('C:/repo-a'))), files.get(fileKey(target('C:/repo-b')))]).toEqual(before);
  });

  it('keeps the runtime content independent from the order of project roots', async () => {
    configureProjects([
      makeProject('project-a', 'C:/repo-a'),
      makeProject('project-b', 'C:/repo-b'),
    ]);
    const runtime = await loadRuntimeService();
    await runtime.updateArchitectPlanRuntime({
      branchName: 'develop',
      plan: planFor(['project-a', 'project-b']),
      update: (record: ArchitectPlanRuntimeRecord) => ({
        ...record,
        mergeWorkflows: { ...record.mergeWorkflows, stable: makeMergeSession('stable') },
      }),
    });

    await runtime.updateArchitectPlanRuntime({
      branchName: 'develop',
      plan: planFor(['project-b', 'project-a']),
      update: (record: ArchitectPlanRuntimeRecord) => ({
        ...record,
        strategyPreview: makeStrategyPreview(),
      }),
    });

    const left = persistedRecord('C:/repo-a');
    const right = persistedRecord('C:/repo-b');
    expect(left).toEqual(right);
    expect(left.mergeWorkflows.stable).toBeDefined();
    expect(left.strategyPreview.planId).toBe('plan-1');
  });

  it('refuses to reinitialize missing replicas after a completed durable generation', async () => {
    configureProjects([makeProject('project-a', 'C:/repo-a')]);
    const runtime = await loadRuntimeService();
    const params = { branchName: 'develop', plan: planFor(['project-a']) };
    await runtime.updateArchitectPlanRuntime({
      ...params,
      update: (record: ArchitectPlanRuntimeRecord) => ({ ...record, strategyPreview: makeStrategyPreview() }),
    });
    files.clear();
    writeCalls.length = 0;
    await expect(runtime.updateArchitectPlanRuntime({
      ...params,
      update: (record: ArchitectPlanRuntimeRecord) => ({ ...record, mergeWorkflows: {} }),
    })).rejects.toThrow('older than the completed replication journal');
    expect(writeCalls).toHaveLength(0);
    expect(journal()?.generation).toBe(1);
  });

  it('settles every replica write after an early failure before releasing the mutation queue', async () => {
    configureProjects([
      makeProject('project-a', 'C:/repo-a'),
      makeProject('project-b', 'C:/repo-b'),
    ]);
    const gate = deferred();
    failNextWrites.add(fileKey(target('C:/repo-a')));
    writeGates.set(fileKey(target('C:/repo-b')), gate.promise);
    const runtime = await loadRuntimeService();
    const params = { branchName: 'develop', plan: planFor(['project-a', 'project-b']) };
    let firstSettled = false;
    const first = runtime.updateArchitectPlanRuntime({
      ...params,
      update: (record: ArchitectPlanRuntimeRecord) => ({
        ...record, mergeWorkflows: { ...record.mergeWorkflows, first: makeMergeSession('first') },
      }),
    }).catch((error: unknown) => { firstSettled = true; return error; });
    await waitFor(() => writeCalls.length === 2);
    let secondStarted = false;
    const second = runtime.updateArchitectPlanRuntime({
      ...params,
      update: (record: ArchitectPlanRuntimeRecord) => {
        secondStarted = true;
        return { ...record, strategyPreview: makeStrategyPreview() };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstSettled).toBe(false);
    expect(secondStarted).toBe(false);
    gate.resolve();
    expect(await first).toBeInstanceOf(Error);
    await second;
    expect(persistedRecord('C:/repo-a')).toEqual(persistedRecord('C:/repo-b'));
    expect(persistedRecord('C:/repo-a').mergeWorkflows.first).toBeDefined();
    expect(persistedRecord('C:/repo-a').strategyPreview.planId).toBe('plan-1');
  });

  it('waits for a competing delayed write after a fast CAS rejection before mutating again', async () => {
    configureProjects([makeProject('project-a', 'C:/repo-a')]);
    const casGate = deferred();
    const writeGate = deferred();
    delayedFirstCas = {
      gate: casGate,
      started: false,
      released: false,
      fastRejectionReturned: false,
    };
    writeGates.set(fileKey(target('C:/repo-a')), writeGate.promise);
    const firstRuntime = await loadRuntimeService();
    const secondRuntime = await loadRuntimeService();
    const firstUpdate = firstRuntime.updateArchitectPlanRuntime({
      branchName: 'develop',
      plan: planFor(['project-a']),
      update: (record: ArchitectPlanRuntimeRecord) => ({
        ...record,
        mergeWorkflows: { ...record.mergeWorkflows, first: makeMergeSession('first') },
      }),
    });
    await waitFor(() => delayedFirstCas?.started === true);

    const secondUpdate = secondRuntime.updateArchitectPlanRuntime({
      branchName: 'develop',
      plan: planFor(['project-a']),
      update: (record: ArchitectPlanRuntimeRecord) => ({
        ...record,
        mergeWorkflows: { ...record.mergeWorkflows, second: makeMergeSession('second') },
      }),
    });
    await waitFor(() => delayedFirstCas?.fastRejectionReturned === true);
    let secondSettled = false;
    void secondUpdate.finally(() => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeCalls).toHaveLength(0);
    expect(secondSettled).toBe(false);

    casGate.resolve();
    await waitFor(() => writeCalls.length > 0);
    expect(secondSettled).toBe(false);
    writeGate.resolve();
    await firstUpdate;
    await secondUpdate;

    const persisted = persistedRecord('C:/repo-a');
    expect(Object.keys(persisted.mergeWorkflows).sort()).toEqual(['first', 'second']);
    expect(journal()).toEqual({ generation: 2, pending: null });
  });
});
