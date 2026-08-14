import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
const actualTauriIpc = await import('./tauriIpc');
import type { Project, ProjectGroup } from '../types';
import { buildValidProjectRegistrySnapshot } from './validProjectRegistry';

type MockAppState = {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  projectGroups: ProjectGroup[];
};

const makeProject = (id: string, name: string, mountName: string, path: string): Project => ({
  id,
  name,
  mountName,
  path,
  created_at: '2026-03-15T00:00:00.000Z',
  status: 'active',
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
});

const projectGroups: MockAppState['projectGroups'] = [
  {
    id: 'group-main',
    name: 'Main',
    isOpen: true,
    projects: [
      makeProject('web', 'Web', 'web', '/repos/web'),
      makeProject('api', 'API', 'api', '/repos/api'),
    ],
  },
];

const appState: MockAppState = {
  selectedGroupId: 'group-main',
  selectedProjectId: 'web',
  projectGroups,
};

const workspaceFiles = new Map<string, Map<string, string>>();
const appSettings = new Map<string, string>();
const commitSnapshots: Array<{
  workspacePath: string | null;
  files: Record<string, string>;
}> = [];
const workspaceWriteHooks: Array<(params: {
  path: string;
  content: string;
  workspacePath?: string | null;
}) => Promise<void> | void> = [];
const appSettingWriteHooks: Array<(params: { key: string; valueJson: string }) => Promise<void> | void> = [];
const commitHooks: Array<(workspacePath: string | null) => Promise<void> | void> = [];
const conversationMessages = new Map<
  string,
  Array<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    created_at: string;
  }>
>();
let importCounter = 0;
let originalConsoleInfo: typeof console.info;

const normalizeFsPath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');

const toWorkspaceKey = (workspacePath?: string | null): string =>
  (workspacePath && workspacePath.trim() ? workspacePath : '__workspace__')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');

const ensureWorkspace = (workspacePath?: string | null): Map<string, string> => {
  const key = toWorkspaceKey(workspacePath);
  const workspace = workspaceFiles.get(key);
  if (workspace) {
    return workspace;
  }
  const next = new Map<string, string>();
  workspaceFiles.set(key, next);
  return next;
};

const writeWorkspaceFile = (workspacePath: string | null | undefined, path: string, content: string): void => {
  ensureWorkspace(workspacePath).set(normalizeFsPath(path), content);
};

const writeWorkspaceJson = (workspacePath: string | null | undefined, path: string, value: unknown): void => {
  writeWorkspaceFile(workspacePath, path, JSON.stringify(value, null, 2));
};

const readWorkspaceFile = (workspacePath: string | null | undefined, path: string): string | null =>
  ensureWorkspace(workspacePath).get(normalizeFsPath(path)) ?? null;

const snapshotWorkspaceFiles = (workspacePath: string | null | undefined): Record<string, string> =>
  Object.fromEntries(ensureWorkspace(workspacePath).entries());

const deleteWorkspacePrefix = (workspacePath: string | null | undefined, path: string): void => {
  const prefix = normalizeFsPath(path);
  for (const key of ensureWorkspace(workspacePath).keys()) {
    if (key === prefix || key.startsWith(`${prefix}/`)) {
      ensureWorkspace(workspacePath).delete(key);
    }
  }
};

const listWorkspaceFiles = (
  workspacePath: string | null | undefined,
  path: string
): Array<{ kind: 'file'; relative_path: string }> => {
  const prefix = normalizeFsPath(path);
  const normalizedPrefix = prefix.length > 0 ? `${prefix}/` : '';
  return Array.from(ensureWorkspace(workspacePath).keys())
    .filter((key) => key.startsWith(normalizedPrefix))
    .map((key) => ({
      kind: 'file' as const,
      relative_path: key.slice(normalizedPrefix.length),
    }));
};

const buildPlan = (overrides: Record<string, unknown> = {}) => ({
  id: 'plan-1',
  slug: 'plan-1',
  title: 'plan-1',
  description: 'Replica test plan',
  status: 'validated',
  targetBranch: 'develop',
  conversationId: 'conversation-1',
  projectId: 'web',
  projectIds: ['web', 'api', 'session-project-ghost'],
  createdAt: '2026-03-15T00:00:00.000Z',
  updatedAt: '2026-03-15T00:00:00.000Z',
  nodes: [
    {
      id: 'task-api',
      title: 'Implement API',
      type: 'task',
      status: 'completed',
      dependencies: [],
      projectId: 'api',
      projectIds: ['api', 'session-project-ghost'],
    },
  ],
  predictedBranches: [
    {
      id: 'ghost-branch',
      name: 'feature/ghost',
      color: '#000000',
      parentBranch: 'plan/plan-1',
      projectId: 'session-project-ghost',
      taskIds: ['task-api'],
      status: 'planned',
    },
  ],
  ...overrides,
});

const chatLine = (message: {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}): string => `${JSON.stringify(message)}\n`;

const toSummary = (plan: ReturnType<typeof buildPlan>) => ({
  id: plan.id,
  slug: plan.slug,
  title: plan.title,
  label: (plan as { label?: string }).label,
  description: plan.description,
  status: plan.status,
  targetBranch: plan.targetBranch,
  conversationId: plan.conversationId,
  projectId: plan.projectId,
  projectIds: plan.projectIds,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
  nodeCount: Array.isArray(plan.nodes) ? plan.nodes.length : 0,
});

const seedReplica = (workspacePath: string, plan: ReturnType<typeof buildPlan>): void => {
  writeWorkspaceJson(workspacePath, 'branches/develop/plans/index.json', {
    version: 2,
    activePlanId: plan.id,
    plans: [toSummary(plan)],
    reservedPlanSlugs: [plan.slug],
  });
  writeWorkspaceJson(workspacePath, `branches/develop/plans/${plan.id}/plan.json`, plan);
};

const registerArchitectPlanMocks = () => {
  mock.restore();

  const tauriModule = () => ({
    ...actualTauriIpc,
    isTauriAvailable: () => true,
    workspaceGetActiveRoot: async () => '/repos/web',
    fsReadFileWithOptions: async ({
      path,
      workspacePath,
    }: {
      path: string;
      workspacePath?: string | null;
    }) => {
      const content = readWorkspaceFile(workspacePath, path);
      if (content === null) {
        throw new Error(`Missing file: ${workspacePath ?? 'local'}:${path}`);
      }
      return {
        content,
        language: path.endsWith('.json') ? 'json' : 'text',
        is_binary: false,
        size: content.length,
        encoding: 'utf-8',
      };
    },
    fsWriteFile: async ({
      path,
      content,
      workspacePath,
    }: {
      path: string;
      content: string;
      workspacePath?: string | null;
    }) => {
      for (const hook of workspaceWriteHooks) {
        await hook({ path, content, workspacePath });
      }
      writeWorkspaceFile(workspacePath, path, content);
      return {
        path,
        bytes_written: content.length,
        created: true,
      };
    },
    fsDelete: async ({
      path,
      workspacePath,
    }: {
      path: string;
      workspacePath?: string | null;
    }) => {
      deleteWorkspacePrefix(workspacePath, path);
    },
    fsListDir: async ({
      path,
      workspacePath,
    }: {
      path: string;
      workspacePath?: string | null;
    }) => listWorkspaceFiles(workspacePath, path),
    dbGetAppSetting: async (key: string) => {
      const value = appSettings.get(key);
      return value === undefined ? null : { key, value_json: value, updated_at: '2026-03-15T00:00:00.000Z' };
    },
    dbSetAppSetting: async ({ key, valueJson }: { key: string; valueJson: string }) => {
      for (const hook of appSettingWriteHooks) await hook({ key, valueJson });
      appSettings.set(key, valueJson);
    },
    listMessages: async (conversationId: string) => conversationMessages.get(conversationId) ?? [],
    macroBranchCommitIfDirty: async ({
      workspacePath,
    }: {
      workspacePath?: string | null;
    }) => {
      for (const hook of commitHooks) await hook(workspacePath ?? null);
      commitSnapshots.push({
        workspacePath: workspacePath ?? null,
        files: snapshotWorkspaceFiles(workspacePath),
      });
      return {
        committed: false,
        branch: 'develop',
        ahead: 0,
        behind: 0,
        hasConflicts: false,
        isDirty: false,
        output: '',
      };
    },
    macroBranchPush: async () => ({
      pushed: false,
      branch: 'develop',
      remote: 'origin',
      output: '',
    }),
  });

  mock.module('./tauriIpc', tauriModule);
  mock.module('./tauriIpc.ts', tauriModule);
};

const loadArchitectPlanService = async () => {
  registerArchitectPlanMocks();
  importCounter += 1;
  const serviceModule = await import(`./architectPlanService.ts?replica-test=${importCounter}`);
  const getAppState = () => appState;

  return {
    ...serviceModule,
    service: serviceModule.createArchitectPlanService({
      getAppState,
      loadRegistrySnapshot: async () =>
        buildValidProjectRegistrySnapshot({
          projectGroups: getAppState().projectGroups,
          selectedGroupId: getAppState().selectedGroupId,
          selectedProjectId: getAppState().selectedProjectId,
        }),
    }),
  };
};

describe('architectPlanService replicas', () => {
  beforeEach(() => {
    workspaceFiles.clear();
    appSettings.clear();
    commitSnapshots.length = 0;
    workspaceWriteHooks.length = 0;
    appSettingWriteHooks.length = 0;
    commitHooks.length = 0;
    conversationMessages.clear();
    originalConsoleInfo = console.info;
    console.info = () => undefined;
  });

  afterEach(() => {
    console.info = originalConsoleInfo;
    mock.restore();
  });

  it('creates the v3 replica layout with manifest and chat transcript files', async () => {
    const { service } = await loadArchitectPlanService();
    const created = await service.createArchitectPlan({
      branchName: 'develop',
      planId: 'plan-v3',
      title: 'Plan V3',
      projectIds: ['web', 'api'],
    });

    const webIndex = JSON.parse(
      readWorkspaceFile('/repos/web', 'branches/develop/plans/index.json') || 'null'
    );
    const apiIndex = JSON.parse(
      readWorkspaceFile('/repos/api', 'branches/develop/plans/index.json') || 'null'
    );
    const webManifest = JSON.parse(
      readWorkspaceFile('/repos/web', `branches/develop/plans/${created.id}/manifest.json`) || 'null'
    );
    const apiManifest = JSON.parse(
      readWorkspaceFile('/repos/api', `branches/develop/plans/${created.id}/manifest.json`) || 'null'
    );
    const webChat = readWorkspaceFile('/repos/web', `branches/develop/plans/${created.id}/chat.jsonl`);
    const apiChat = readWorkspaceFile('/repos/api', `branches/develop/plans/${created.id}/chat.jsonl`);

    expect(webIndex.version).toBe(3);
    expect(apiIndex.version).toBe(3);
    expect(webManifest.schemaVersion).toBe(3);
    expect(apiManifest.schemaVersion).toBe(3);
    expect(webManifest.expectedProjectIds).toEqual(['web', 'api']);
    expect(apiManifest.expectedProjectIds).toEqual(['web', 'api']);
    expect(webManifest.revision).toBe(1);
    expect(apiManifest.revision).toBe(1);
    expect(webChat).toBeNull();
    expect(apiChat).toBeNull();
  });

  it('auto-heals synthetic session project ids without reporting missing replicas', async () => {
    const webPlan = buildPlan({
      updatedAt: '2026-03-15T00:01:00.000Z',
    });
    const apiPlan = buildPlan({
      updatedAt: '2026-03-15T00:00:00.000Z',
    });
    seedReplica('/repos/web', webPlan);
    seedReplica('/repos/api', apiPlan);
    writeWorkspaceJson('/repos/web', `branches/develop/plans/${webPlan.id}/runtime.json`, {
      schemaVersion: 1,
      strategyPreview: null,
    });

    const { service } = await loadArchitectPlanService();
    const loaded = await service.getArchitectPlan('develop', webPlan.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.projectIds).toEqual(['web', 'api']);
    expect(loaded?.nodes[0]?.projectIds).toEqual(['api']);
    expect(loaded?.predictedBranches).toEqual([]);

    const sanitizedWebPlan = JSON.parse(
      readWorkspaceFile('/repos/web', `branches/develop/plans/${webPlan.id}/plan.json`) || 'null'
    );
    const sanitizedApiPlan = JSON.parse(
      readWorkspaceFile('/repos/api', `branches/develop/plans/${webPlan.id}/plan.json`) || 'null'
    );
    const sanitizedWebIndex = JSON.parse(
      readWorkspaceFile('/repos/web', 'branches/develop/plans/index.json') || 'null'
    );

    expect(sanitizedWebPlan.projectIds).toEqual(['web', 'api']);
    expect(sanitizedApiPlan.projectIds).toEqual(['web', 'api']);
    expect(sanitizedWebPlan.predictedBranches).toEqual([]);
    expect(sanitizedWebIndex.plans[0].projectIds).toEqual(['web', 'api']);
    expect(readWorkspaceFile('/repos/api', `branches/develop/plans/${webPlan.id}/runtime.json`)).toBeNull();
  });

  it('repairs divergent replicas with sanitized canonical metadata', async () => {
    const oldest = buildPlan({
      projectIds: ['web', 'api'],
      description: 'oldest',
      nodes: [
        {
          id: 'task-api',
          title: 'Implement API',
          type: 'task',
          status: 'completed',
          dependencies: [],
          projectId: 'api',
          projectIds: ['api'],
        },
      ],
      predictedBranches: [],
      updatedAt: '2026-03-15T00:00:00.000Z',
    });
    const newest = buildPlan({
      projectIds: ['web', 'api'],
      description: 'newest',
      nodes: [
        {
          id: 'task-api',
          title: 'Implement API',
          type: 'task',
          status: 'completed',
          dependencies: [],
          projectId: 'api',
          projectIds: ['api'],
        },
      ],
      predictedBranches: [],
      updatedAt: '2026-03-16T00:00:00.000Z',
    });
    seedReplica('/repos/web', oldest);
    seedReplica('/repos/api', newest);

    const { isArchitectPlanReplicaDivergenceError, service } = await loadArchitectPlanService();

    let divergence: unknown;
    try {
      await service.getArchitectPlan('develop', oldest.id);
    } catch (error) {
      divergence = error;
    }

    expect(isArchitectPlanReplicaDivergenceError(divergence)).toBe(true);
    if (isArchitectPlanReplicaDivergenceError(divergence)) {
      const divergenceError = divergence as {
        divergence: {
          reason: string;
        };
      };
      expect(divergenceError.divergence.reason).toBe('content_diverged');
    }

    const repaired = await service.repairArchitectPlanReplicas({
      branchName: 'develop',
      planId: oldest.id,
      strategy: 'newest',
    });

    expect(repaired.description).toBe('newest');
    expect(repaired.projectIds).toEqual(['web', 'api']);
    expect(repaired.predictedBranches).toEqual([]);

    const reloaded = await service.getArchitectPlan('develop', oldest.id);
    expect(reloaded?.description).toBe('newest');
    expect(reloaded?.projectIds).toEqual(['web', 'api']);

    const webPlan = readWorkspaceFile('/repos/web', `branches/develop/plans/${oldest.id}/plan.json`);
    const apiPlan = readWorkspaceFile('/repos/api', `branches/develop/plans/${oldest.id}/plan.json`);
    expect(webPlan).toBe(apiPlan);
  });

  it('loads a degraded plan state when a registered replica is missing and blocks writes', async () => {
    const plan = buildPlan({
      projectIds: ['web', 'api'],
      nodes: [
        {
          id: 'task-api',
          title: 'Implement API',
          type: 'task',
          status: 'completed',
          dependencies: [],
          projectId: 'api',
          projectIds: ['api'],
        },
      ],
      predictedBranches: [],
    });
    seedReplica('/repos/web', plan);

    const { service } = await loadArchitectPlanService();
    const loaded = await service.getArchitectPlan('develop', plan.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.replicationState).toBe('missing_projects');
    expect(loaded?.expectedProjectIds).toEqual(['web', 'api']);
    expect(loaded?.availableProjectIds).toEqual(['web']);
    expect(loaded?.missingProjectIds).toEqual(['api']);
    await expect(
      service.updateArchitectPlan({
        branchName: 'develop',
        planId: plan.id,
        description: 'blocked-write',
      })
    ).rejects.toThrow(/expected project replicas are missing: api/i);
  });

  it('does not let one registered replica prove availability for every project in plan metadata', async () => {
    const plan = buildPlan({
      projectIds: ['web', 'api'],
      nodes: [
        {
          id: 'task-api',
          title: 'Implement API',
          type: 'task',
          status: 'completed',
          dependencies: [],
          projectId: 'api',
          projectIds: ['api'],
        },
      ],
      predictedBranches: [],
    });
    seedReplica('/repos/api', plan);

    const { service } = await loadArchitectPlanService();
    const loaded = await service.getArchitectPlan('develop', plan.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.replicationState).toBe('missing_projects');
    expect(loaded?.expectedProjectIds).toEqual(['web', 'api']);
    expect(loaded?.availableProjectIds).toEqual(['api']);
    expect(loaded?.missingProjectIds).toEqual(['web']);
  });

  it('ignores operational runtime and chat files when checking replica content divergence', async () => {
    const plan = buildPlan({
      projectIds: ['web', 'api'],
      nodes: [],
      predictedBranches: [],
    });
    seedReplica('/repos/web', plan);
    seedReplica('/repos/api', plan);
    writeWorkspaceJson('/repos/web', `branches/develop/plans/${plan.id}/runtime.json`, {
      schemaVersion: 1,
      strategyPreview: null,
    });
    writeWorkspaceFile(
      '/repos/api',
      `branches/develop/plans/${plan.id}/chat.jsonl`,
      `${JSON.stringify({
        id: 'chat-1',
        role: 'assistant',
        content: 'Operational transcript only.',
        createdAt: '2026-03-15T00:01:00.000Z',
      })}\n`
    );

    const { service } = await loadArchitectPlanService();
    const loaded = await service.getArchitectPlan('develop', plan.id);

    expect(loaded?.id).toBe(plan.id);
    expect(loaded?.hasReplicaDivergence).toBe(false);
  });

  it('serializes chat saves with delete so replicas do not diverge', async () => {
    const plan = buildPlan({
      projectIds: ['web', 'api'],
      nodes: [],
      predictedBranches: [],
    });
    seedReplica('/repos/web', plan);
    seedReplica('/repos/api', plan);
    const message = {
      id: 'chat-1',
      role: 'assistant' as const,
      content: 'Persist this before delete.',
      createdAt: '2026-03-15T00:05:00.000Z',
    };

    const { service } = await loadArchitectPlanService();
    await Promise.all([
      service.saveArchitectPlanChatMessages('develop', plan.id, [message]),
      service.deleteArchitectPlan({
        branchName: 'develop',
        planId: plan.id,
      }),
    ]);

    const loaded = await service.getArchitectPlan('develop', plan.id);
    const webPlan = readWorkspaceFile('/repos/web', `branches/develop/plans/${plan.id}/plan.json`);
    const apiPlan = readWorkspaceFile('/repos/api', `branches/develop/plans/${plan.id}/plan.json`);
    const webChat = readWorkspaceFile('/repos/web', `branches/develop/plans/${plan.id}/chat.jsonl`);
    const apiChat = readWorkspaceFile('/repos/api', `branches/develop/plans/${plan.id}/chat.jsonl`);

    expect(loaded?.status).toBe('deleted');
    expect(webPlan).toBe(apiPlan);
    expect(webChat).toBe(apiChat);
    expect(webChat).toContain('Persist this before delete.');
  });

  it('syncs chat from a fresh replica snapshot after queued chat mutations', async () => {
    const plan = buildPlan({
      projectIds: ['web', 'api'],
      nodes: [],
      predictedBranches: [],
    });
    seedReplica('/repos/web', plan);
    seedReplica('/repos/api', plan);
    const oldMessage = {
      id: 'chat-old',
      role: 'assistant' as const,
      content: 'Database transcript wins.',
      createdAt: '2026-03-15T00:01:00.000Z',
    };
    const staleMessage = {
      id: 'chat-stale',
      role: 'assistant' as const,
      content: 'Queued stale transcript.',
      createdAt: '2026-03-15T00:02:00.000Z',
    };
    writeWorkspaceFile('/repos/web', `branches/develop/plans/${plan.id}/chat.jsonl`, chatLine(oldMessage));
    writeWorkspaceFile('/repos/api', `branches/develop/plans/${plan.id}/chat.jsonl`, chatLine(oldMessage));
    conversationMessages.set('conversation-1', [
      {
        id: oldMessage.id,
        role: oldMessage.role,
        content: oldMessage.content,
        created_at: oldMessage.createdAt,
      },
    ]);

    const { service } = await loadArchitectPlanService();
    await Promise.all([
      service.saveArchitectPlanChatMessages('develop', plan.id, [staleMessage]),
      service.syncArchitectPlanChatFromConversation({
        branchName: 'develop',
        planId: plan.id,
      }),
    ]);

    const webChat = readWorkspaceFile('/repos/web', `branches/develop/plans/${plan.id}/chat.jsonl`);
    const apiChat = readWorkspaceFile('/repos/api', `branches/develop/plans/${plan.id}/chat.jsonl`);
    expect(webChat).toBe(apiChat);
    expect(webChat).toContain('Database transcript wins.');
    expect(webChat).not.toContain('Queued stale transcript.');
  });

  it('binds conversations from a fresh queued plan state without erasing semantic updates', async () => {
    const plan = buildPlan({
      conversationId: undefined,
      description: '',
      projectIds: ['web', 'api'],
      nodes: [],
      predictedBranches: [],
    });
    seedReplica('/repos/web', plan);
    seedReplica('/repos/api', plan);
    const freshNode = {
      id: 'task-fresh',
      title: 'Fresh queued work',
      type: 'task' as const,
      status: 'pending' as const,
      dependencies: [],
      projectId: 'web',
      projectIds: ['web'],
    };
    let releaseWrites: () => void = () => undefined;
    let blockedWriteSeen = false;
    const releaseWritesPromise = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const firstPlanWriteBlocked = new Promise<void>((resolve) => {
      workspaceWriteHooks.push(async ({ path, content }) => {
        if (
          path === `branches/develop/plans/${plan.id}/plan.json` &&
          content.includes('"task-fresh"')
        ) {
          if (!blockedWriteSeen) {
            blockedWriteSeen = true;
            resolve();
          }
          await releaseWritesPromise;
        }
      });
    });

    const { service } = await loadArchitectPlanService();
    const updatePromise = service.updateArchitectPlan({
      branchName: 'develop',
      planId: plan.id,
      nodes: [freshNode],
      predictedBranches: [],
      projectId: 'web',
      projectIds: ['web', 'api'],
    });
    await firstPlanWriteBlocked;
    const bindPromise = service.bindArchitectPlanConversation({
      branchName: 'develop',
      planId: plan.id,
      conversationId: 'fresh-conversation',
    });
    releaseWrites();

    await Promise.all([updatePromise, bindPromise]);
    const loaded = await service.getArchitectPlan('develop', plan.id);
    const webPlan = JSON.parse(readWorkspaceFile('/repos/web', `branches/develop/plans/${plan.id}/plan.json`) || 'null');
    const apiPlan = JSON.parse(readWorkspaceFile('/repos/api', `branches/develop/plans/${plan.id}/plan.json`) || 'null');

    expect(loaded?.conversationId).toBe('fresh-conversation');
    expect(loaded?.nodes.map((node: { id: string }) => node.id)).toEqual(['task-fresh']);
    expect(webPlan.conversationId).toBe('fresh-conversation');
    expect(apiPlan.conversationId).toBe('fresh-conversation');
    expect(webPlan.nodes.map((node: { id: string }) => node.id)).toEqual(['task-fresh']);
    expect(apiPlan.nodes.map((node: { id: string }) => node.id)).toEqual(['task-fresh']);
  });

  it('finalizes an interrupted replicated update from every cross-scope cut point', async () => {
    const cutPoints = [
      { workspacePath: '/repos/web', suffix: '/plan.json' },
      { workspacePath: '/repos/web', suffix: '/index.json' },
      { workspacePath: '/repos/api', suffix: '/plan.json' },
      { workspacePath: '/repos/api', suffix: '/index.json' },
    ];

    for (const [index, cutPoint] of cutPoints.entries()) {
      workspaceFiles.clear();
      appSettings.clear();
      workspaceWriteHooks.length = 0;
      appSettingWriteHooks.length = 0;
      commitHooks.length = 0;
      const plan = buildPlan({ description: `before-${index}`, projectIds: ['web', 'api'] });
      seedReplica('/repos/web', plan);
      seedReplica('/repos/api', plan);
      const { service } = await loadArchitectPlanService();
      await service.getArchitectPlan('develop', plan.id);
      let injected = false;
      workspaceWriteHooks.push(({ path, workspacePath }) => {
        if (!injected && workspacePath === cutPoint.workspacePath && path.endsWith(cutPoint.suffix)) {
          injected = true;
          throw new Error(`injected-cut-${index}`);
        }
      });

      await expect(service.updateArchitectPlan({
        branchName: 'develop',
        planId: plan.id,
        description: `after-${index}`,
      })).rejects.toThrow(`injected-cut-${index}`);
      expect(Array.from(appSettings.keys())).toContain('pendingArchitectPlanReplicaMutations:v1');
      if (index === 0) {
        const healthyEntries = JSON.parse(appSettings.get('pendingArchitectPlanReplicaMutations:v1') || '[]');
        appSettings.set('pendingArchitectPlanReplicaMutations:v1', JSON.stringify([{
          ...healthyEntries[0],
          id: 'invalid-local-payload',
          payload: { targets: 'not-an-array' },
        }, ...healthyEntries]));
      }
      workspaceWriteHooks.length = 0;
      const { service: restartedService } = await loadArchitectPlanService();
      const recovered = await restartedService.getArchitectPlan('develop', plan.id);
      expect(recovered?.description).toBe(`after-${index}`);
      expect(readWorkspaceFile('/repos/web', `branches/develop/plans/${plan.id}/plan.json`))
        .toBe(readWorkspaceFile('/repos/api', `branches/develop/plans/${plan.id}/plan.json`));
      for (const workspacePath of ['/repos/web', '/repos/api']) {
        const scopeIndex = JSON.parse(readWorkspaceFile(workspacePath, 'branches/develop/plans/index.json') || '{}');
        expect(scopeIndex.plans[0]?.description).toBe(`after-${index}`);
      }
      expect(JSON.parse(appSettings.get('pendingArchitectPlanReplicaMutations:v1') || '[]')).toEqual([]);
      if (index === 0) {
        expect(JSON.parse(appSettings.get('pendingArchitectPlanReplicaMutationsQuarantine:v1') || '[]'))
          .toHaveLength(1);
      }
    }
  });

  it('keeps the intent durable across Git commit and journal-removal failures', async () => {
    for (const failure of ['commit', 'journal-removal'] as const) {
      workspaceFiles.clear();
      appSettings.clear();
      workspaceWriteHooks.length = 0;
      appSettingWriteHooks.length = 0;
      commitHooks.length = 0;
      commitSnapshots.length = 0;
      const plan = buildPlan({ description: `before-${failure}`, projectIds: ['web', 'api'] });
      seedReplica('/repos/web', plan);
      seedReplica('/repos/api', plan);
      const { service } = await loadArchitectPlanService();
      await service.getArchitectPlan('develop', plan.id);
      let injected = false;
      if (failure === 'commit') {
        commitHooks.push(() => {
          if (!injected) { injected = true; throw new Error('injected-commit'); }
        });
      } else {
        appSettingWriteHooks.push(({ key, valueJson }) => {
          if (!injected && key === 'pendingArchitectPlanReplicaMutations:v1' && valueJson === '[]') {
            injected = true;
            throw new Error('injected-journal-removal');
          }
        });
      }

      await expect(service.updateArchitectPlan({
        branchName: 'develop', planId: plan.id, description: `after-${failure}`,
      })).rejects.toThrow(`injected-${failure}`);
      expect(JSON.parse(appSettings.get('pendingArchitectPlanReplicaMutations:v1') || '[]')).toHaveLength(1);

      commitHooks.length = 0;
      appSettingWriteHooks.length = 0;
      const { service: restartedService } = await loadArchitectPlanService();
      const recovered = await restartedService.getArchitectPlan('develop', plan.id);
      expect(recovered?.description).toBe(`after-${failure}`);
      expect(commitSnapshots.some((snapshot) => snapshot.workspacePath === '/repos/web')).toBe(true);
      expect(commitSnapshots.some((snapshot) => snapshot.workspacePath === '/repos/api')).toBe(true);
      expect(JSON.parse(appSettings.get('pendingArchitectPlanReplicaMutations:v1') || '[]')).toEqual([]);
    }
  });

  it('serializes different plans on the same branch so index snapshots cannot overwrite each other', async () => {
    const first = buildPlan({ id: 'plan-a', slug: 'plan-a', title: 'plan-a', description: 'a-before', projectIds: ['web', 'api'] });
    const second = buildPlan({ id: 'plan-b', slug: 'plan-b', title: 'plan-b', description: 'b-before', projectIds: ['web', 'api'] });
    for (const workspacePath of ['/repos/web', '/repos/api']) {
      writeWorkspaceJson(workspacePath, 'branches/develop/plans/index.json', {
        version: 3,
        activePlanId: first.id,
        plans: [toSummary(first), toSummary(second)],
        reservedPlanSlugs: [first.slug, second.slug],
      });
      writeWorkspaceJson(workspacePath, `branches/develop/plans/${first.id}/plan.json`, first);
      writeWorkspaceJson(workspacePath, `branches/develop/plans/${second.id}/plan.json`, second);
    }
    const { service } = await loadArchitectPlanService();
    await service.getArchitectPlan('develop', first.id);
    await service.getArchitectPlan('develop', second.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blocked = false;
    workspaceWriteHooks.push(async ({ path, content }) => {
      if (!blocked && path.endsWith(`/plans/${first.id}/plan.json`) && content.includes('a-after')) {
        blocked = true;
        await gate;
      }
    });

    const firstUpdate = service.updateArchitectPlan({ branchName: 'develop', planId: first.id, description: 'a-after' });
    while (!blocked) await Promise.resolve();
    let secondFinished = false;
    const secondUpdate = service.updateArchitectPlan({ branchName: 'develop', planId: second.id, description: 'b-after' })
      .then((value: unknown) => { secondFinished = true; return value; });
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    release();
    await Promise.all([firstUpdate, secondUpdate]);

    for (const workspacePath of ['/repos/web', '/repos/api']) {
      const index = JSON.parse(readWorkspaceFile(workspacePath, 'branches/develop/plans/index.json') || '{}');
      expect(index.plans.map((plan: { id: string }) => plan.id).sort()).toEqual(['plan-a', 'plan-b']);
      expect(index.plans.find((plan: { id: string }) => plan.id === 'plan-a')?.description).toBe('a-after');
      expect(index.plans.find((plan: { id: string }) => plan.id === 'plan-b')?.description).toBe('b-after');
    }
  });

  it('does not replay or block on a transaction owned by another workspace', async () => {
    const plan = buildPlan({ projectIds: ['web', 'api'] });
    seedReplica('/repos/web', plan);
    seedReplica('/repos/api', plan);
    const foreign = {
      id: 'foreign-tx',
      workspaceKey: '/repos/other',
      branchName: 'develop',
      planId: 'foreign-plan',
      operation: 'update',
      phase: 'prepared',
      payload: { malformedForThisWorkspace: true },
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    };
    appSettings.set('pendingArchitectPlanReplicaMutations:v1', JSON.stringify([foreign]));

    const { service } = await loadArchitectPlanService();
    expect((await service.getArchitectPlan('develop', plan.id))?.id).toBe(plan.id);
    expect(JSON.parse(appSettings.get('pendingArchitectPlanReplicaMutations:v1') || '[]')).toEqual([foreign]);
  });

  it('keeps reporting true content divergence between repositories', async () => {
    const webPlan = buildPlan({
      projectIds: ['web', 'api'],
      description: 'web-copy',
    });
    const apiPlan = buildPlan({
      projectIds: ['web', 'api'],
      description: 'api-copy',
    });
    seedReplica('/repos/web', webPlan);
    seedReplica('/repos/api', apiPlan);

    const { isArchitectPlanReplicaDivergenceError, service } = await loadArchitectPlanService();

    let divergence: unknown;
    try {
      await service.getArchitectPlan('develop', webPlan.id);
    } catch (error) {
      divergence = error;
    }

    expect(isArchitectPlanReplicaDivergenceError(divergence)).toBe(true);
    if (isArchitectPlanReplicaDivergenceError(divergence)) {
      const divergenceError = divergence as {
        divergence: {
          reason: string;
          replicas: unknown[];
        };
      };
      expect(divergenceError.divergence.reason).toBe('content_diverged');
      expect(divergenceError.divergence.replicas).toHaveLength(2);
    }
  });

  it('reports runtime-only plan metadata as an orphan instead of generic missing state', async () => {
    writeWorkspaceJson('/repos/web', 'branches/develop/plans/index.json', {
      version: 3,
      activePlanId: 'plan-orphan',
      plans: [],
      reservedPlanSlugs: [],
    });
    writeWorkspaceJson('/repos/web', 'branches/develop/plans/plan-orphan/runtime.json', {
      taskId: 'task-1',
    });

    const { service } = await loadArchitectPlanService();
    const health = await service.inspectArchitectPlanMetadataHealth({
      branchName: 'develop',
      planId: 'plan-orphan',
    });

    expect(health.status).toBe('runtime_orphan');
    expect(health.orphanedReplicas).toHaveLength(1);
  });

  it('repairs runtime-only orphan metadata by removing the stale plan directory and index reference', async () => {
    writeWorkspaceJson('/repos/web', 'branches/develop/plans/index.json', {
      version: 3,
      activePlanId: 'plan-orphan',
      plans: [
        {
          id: 'plan-orphan',
          slug: 'plan-orphan',
          title: 'plan-orphan',
          description: '',
          status: 'validated',
          targetBranch: 'develop',
          projectId: 'web',
          projectIds: ['web'],
          createdAt: '2026-03-15T00:00:00.000Z',
          updatedAt: '2026-03-15T00:00:00.000Z',
          nodeCount: 1,
        },
      ],
      reservedPlanSlugs: ['plan-orphan'],
    });
    writeWorkspaceJson('/repos/web', 'branches/develop/plans/plan-orphan/runtime.json', {
      taskId: 'task-1',
    });

    const { service } = await loadArchitectPlanService();
    const repaired = await service.repairArchitectPlanMetadata({
      branchName: 'develop',
      planId: 'plan-orphan',
    });

    expect(repaired.statusBeforeRepair).toBe('runtime_orphan');
    expect(repaired.repairedPlan).toBeNull();
    expect(readWorkspaceFile('/repos/web', 'branches/develop/plans/plan-orphan/runtime.json')).toBeNull();
    const index = JSON.parse(readWorkspaceFile('/repos/web', 'branches/develop/plans/index.json') || '{}');
    expect(index.activePlanId).toBeNull();
    expect(index.plans).toEqual([]);
  });
});
