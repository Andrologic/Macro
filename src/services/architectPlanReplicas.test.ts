import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

type MockProject = {
  id: string;
  name: string;
  mountName: string;
  path: string;
};

type MockAppState = {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  projectGroups: Array<{
    id: string;
    name: string;
    isOpen: boolean;
    projects: MockProject[];
  }>;
};

const projectGroups: MockAppState['projectGroups'] = [
  {
    id: 'group-main',
    name: 'Main',
    isOpen: true,
    projects: [
      { id: 'web', name: 'Web', mountName: 'web', path: '/repos/web' },
      { id: 'api', name: 'API', mountName: 'api', path: '/repos/api' },
    ],
  },
];

const appState: MockAppState = {
  selectedGroupId: 'group-main',
  selectedProjectId: 'web',
  projectGroups,
};

const workspaceFiles = new Map<string, Map<string, string>>();
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
  writeWorkspaceJson(workspacePath, `branches/develop/plans/${plan.id}/needs.json`, []);
};

const registerArchitectPlanMocks = () => {
  mock.restore();

  mock.module('./tauriIpc', () => ({
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
  }));

  mock.module('../stores/useAppStore', () => ({
    useAppStore: {
      getState: () => appState,
    },
  }));
};

const loadArchitectPlanService = async () => {
  registerArchitectPlanMocks();
  importCounter += 1;
  return import(`./architectPlanService.ts?replica-test=${importCounter}`);
};

describe('architectPlanService replicas', () => {
  beforeEach(() => {
    workspaceFiles.clear();
    originalConsoleInfo = console.info;
    console.info = () => undefined;
  });

  afterEach(() => {
    console.info = originalConsoleInfo;
    mock.restore();
  });

  it('creates the v3 replica layout with manifest and chat transcript files', async () => {
    const service = await loadArchitectPlanService();
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
    expect(webChat).toBe('');
    expect(apiChat).toBe('');
  });

  it('auto-heals synthetic session project ids without reporting missing replicas', async () => {
    const plan = buildPlan();
    seedReplica('/repos/web', plan);
    seedReplica('/repos/api', plan);

    const service = await loadArchitectPlanService();
    const loaded = await service.getArchitectPlan('develop', plan.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.projectIds).toEqual(['web', 'api']);
    expect(loaded?.nodes[0]?.projectIds).toEqual(['api']);
    expect(loaded?.predictedBranches).toEqual([]);

    const sanitizedWebPlan = JSON.parse(
      readWorkspaceFile('/repos/web', `branches/develop/plans/${plan.id}/plan.json`) || 'null'
    );
    const sanitizedApiPlan = JSON.parse(
      readWorkspaceFile('/repos/api', `branches/develop/plans/${plan.id}/plan.json`) || 'null'
    );
    const sanitizedWebIndex = JSON.parse(
      readWorkspaceFile('/repos/web', 'branches/develop/plans/index.json') || 'null'
    );

    expect(sanitizedWebPlan.projectIds).toEqual(['web', 'api']);
    expect(sanitizedApiPlan.projectIds).toEqual(['web', 'api']);
    expect(sanitizedWebPlan.predictedBranches).toEqual([]);
    expect(sanitizedWebIndex.plans[0].projectIds).toEqual(['web', 'api']);
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

    const service = await loadArchitectPlanService();

    let divergence: unknown;
    try {
      await service.getArchitectPlan('develop', oldest.id);
    } catch (error) {
      divergence = error;
    }

    expect(service.isArchitectPlanReplicaDivergenceError(divergence)).toBe(true);
    if (service.isArchitectPlanReplicaDivergenceError(divergence)) {
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

    const service = await loadArchitectPlanService();
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

    const service = await loadArchitectPlanService();

    let divergence: unknown;
    try {
      await service.getArchitectPlan('develop', webPlan.id);
    } catch (error) {
      divergence = error;
    }

    expect(service.isArchitectPlanReplicaDivergenceError(divergence)).toBe(true);
    if (service.isArchitectPlanReplicaDivergenceError(divergence)) {
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
});
