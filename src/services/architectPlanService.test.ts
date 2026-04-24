import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
const actualTauriIpc = await import('./tauriIpc');
import type { ArchitectPlanRecord, ArchitectPlanSummary } from './architectPlanService';
import type { ValidProjectRegistrySnapshot } from './validProjectRegistry';
import { DEFAULT_NEW_PLAN_LABEL } from './architectPlanPresentation';

interface LocalStorageMock {
  clear: () => void;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
  readonly length: number;
}

const createLocalStorageMock = (): LocalStorageMock => {
  const store = new Map<string, string>();

  return {
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    get length() {
      return store.size;
    },
  };
};

const branchName = 'develop';
let importCounter = 0;

interface LoadArchitectPlanServiceOptions {
  tauriAvailable?: boolean;
  filesByWorkspacePath?: Record<string, Record<string, string>>;
  registrySnapshot?: ValidProjectRegistrySnapshot;
  workspaceRoot?: string;
}

const registerArchitectPlanMocks = (options: LoadArchitectPlanServiceOptions = {}) => {
  mock.restore();
  const workspaceFilesByWorkspacePath = options.filesByWorkspacePath ?? {};
  const normalizeMockPath = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '');
  const listWorkspaceDir = (workspacePath: string, dirPath: string) => {
    const workspaceFiles = workspaceFilesByWorkspacePath[workspacePath] ?? {};
    const normalizedDirPath = normalizeMockPath(dirPath);
    const prefix = normalizedDirPath.length > 0 ? `${normalizedDirPath}/` : '';
    const entries = new Map<
      string,
      {
        path: string;
        relative_path: string;
        name: string;
        kind: string;
        is_hidden: boolean;
        is_readonly: boolean;
      }
    >();

    Object.keys(workspaceFiles).forEach((rawPath) => {
      const normalizedPath = normalizeMockPath(rawPath);
      if (!normalizedPath.startsWith(prefix)) {
        return;
      }

      const remainder = normalizedPath.slice(prefix.length);
      if (!remainder) {
        return;
      }

      const [name, ...rest] = remainder.split('/').filter(Boolean);
      if (!name || entries.has(name)) {
        return;
      }

      entries.set(name, {
        path: `${normalizedDirPath}/${name}`,
        relative_path: name,
        name,
        kind: rest.length > 0 ? 'directory' : 'file',
        is_hidden: name.startsWith('.'),
        is_readonly: false,
      });
    });

    return Array.from(entries.values());
  };
  const tauriModule = () => ({
    ...actualTauriIpc,
    aiGetDevProviderOverrides: async () => null,
    isTauriAvailable: () => options.tauriAvailable === true,
    workspaceGetActiveRoot: async () => options.workspaceRoot ?? '/repos/web',
    fsReadFileWithOptions: async (params: { path: string; workspacePath?: string | null }) => {
      const workspacePath = params.workspacePath ?? '';
      const content = workspaceFilesByWorkspacePath[workspacePath]?.[normalizeMockPath(params.path)];
      if (typeof content !== 'string') {
        throw new Error(`Missing mocked file for ${workspacePath}:${params.path}`);
      }
      return { content };
    },
    fsWriteFile: async (params: {
      path: string;
      content: string;
      workspacePath?: string | null;
    }) => {
      const workspacePath = params.workspacePath ?? '';
      if (!workspaceFilesByWorkspacePath[workspacePath]) {
        workspaceFilesByWorkspacePath[workspacePath] = {};
      }
      const normalizedPath = normalizeMockPath(params.path);
      const created = !(normalizedPath in workspaceFilesByWorkspacePath[workspacePath]);
      workspaceFilesByWorkspacePath[workspacePath][normalizedPath] = params.content;
      return {
        path: normalizedPath,
        bytes_written: params.content.length,
        created,
        skipped: false,
      };
    },
    fsListDir: async (params: {
      path: string;
      workspacePath?: string | null;
    }) => {
      const workspacePath = params.workspacePath ?? '';
      return listWorkspaceDir(workspacePath, params.path);
    },
    fsDelete: async (params: {
      path: string;
      recursive?: boolean;
      workspacePath?: string | null;
    }) => {
      const workspacePath = params.workspacePath ?? '';
      const workspaceFiles = workspaceFilesByWorkspacePath[workspacePath] ?? {};
      const normalizedPath = normalizeMockPath(params.path);
      if (params.recursive) {
        Object.keys(workspaceFiles).forEach((rawPath) => {
          const candidatePath = normalizeMockPath(rawPath);
          if (candidatePath === normalizedPath || candidatePath.startsWith(`${normalizedPath}/`)) {
            delete workspaceFiles[candidatePath];
          }
        });
        return;
      }
      delete workspaceFiles[normalizedPath];
    },
  });
  mock.module('./tauriIpc', tauriModule);
  mock.module('./tauriIpc.ts', tauriModule);

  if (options.registrySnapshot) {
    const snapshot = options.registrySnapshot;
    const validProjectRegistryModule = () => ({
      isSyntheticProjectId: (value?: string | null) => Boolean(value && value.startsWith('session-project-')),
      loadValidProjectRegistrySnapshot: async () => snapshot,
      normalizeProjectRegistryPath: (value?: string | null) =>
        value ? value.trim().replace(/\\/g, '/').replace(/\/+$/, '') || null : null,
    });
    mock.module('./validProjectRegistry', validProjectRegistryModule);
    mock.module('./validProjectRegistry.ts', validProjectRegistryModule);
  }
};

const loadArchitectPlanService = async (options?: LoadArchitectPlanServiceOptions) => {
  registerArchitectPlanMocks(options);
  importCounter += 1;
  return import(`./architectPlanService.ts?local-test=${importCounter}`);
};

const seedLegacyPlan = (storage: LocalStorageMock, plan: ArchitectPlanRecord) => {
  const summary: ArchitectPlanSummary = {
    id: plan.id,
    slug: plan.slug,
    title: plan.title,
    label: plan.label,
    description: plan.description,
    status: plan.status,
    targetBranch: plan.targetBranch,
    conversationId: plan.conversationId,
    projectId: plan.projectId,
    projectIds: plan.projectIds,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    nodeCount: plan.nodes.length,
  };

  storage.setItem(
    `macro_architect_plan_index:${branchName}`,
    JSON.stringify({
      version: 2,
      activePlanId: plan.id,
      plans: [summary],
      reservedPlanSlugs: [plan.slug],
    })
  );
  storage.setItem(
    `macro_architect_plan:${branchName}:${plan.id}`,
    JSON.stringify(plan)
  );
};

describe('architectPlanService', () => {
  let storage: LocalStorageMock;
  let service: Awaited<ReturnType<typeof loadArchitectPlanService>>;

  beforeEach(async () => {
    storage = createLocalStorageMock();
    (globalThis as { window?: unknown }).window = {
      addEventListener: () => undefined,
      localStorage: storage,
      removeEventListener: () => undefined,
    };
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    service = await loadArchitectPlanService();
  });

  afterEach(() => {
    mock.restore();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('creates canonical plans without requiring a title and allows duplicate labels', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000000',
    });

    expect(created.id).toBe('1710000000000');
    expect(created.slug).toBe('1710000000000');
    expect(created.title).toBe('1710000000000');
    expect(created.label).toBeUndefined();

    const firstLabeled = await service.createArchitectPlan({
      branchName,
      planId: '1710000000001',
      title: 'Checkout refresh',
    });
    const secondLabeled = await service.createArchitectPlan({
      branchName,
      planId: '1710000000002',
      label: 'Checkout refresh',
    });

    expect(firstLabeled.title).toBe('1710000000001');
    expect(firstLabeled.slug).toBe('checkout-refresh');
    expect(firstLabeled.label).toBe('Checkout refresh');
    expect(secondLabeled.title).toBe('1710000000002');
    expect(secondLabeled.slug).toBe('checkout-refresh-2');
    expect(secondLabeled.label).toBe('Checkout refresh');

    const listed = await service.listArchitectPlans(branchName, true, true);
    expect(listed.plans.map((plan: ArchitectPlanSummary) => plan.id)).toEqual([
      '1710000000000',
      '1710000000001',
      '1710000000002',
    ]);
  });

  it('treats title updates as label updates for canonical plans', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000010',
      title: 'Initial label',
    });

    const updated = await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      title: 'Renamed label',
    });

    expect(updated.id).toBe('1710000000010');
    expect(updated.slug).toBe('initial-label');
    expect(updated.title).toBe('1710000000010');
    expect(updated.label).toBe('Renamed label');

    const cleared = await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      label: '',
    });

    expect(cleared.title).toBe('1710000000010');
    expect(cleared.slug).toBe('initial-label');
    expect(cleared.label).toBeUndefined();
  });

  it('allows renaming a draft plan slug before lock and releases the previous draft slug', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000012',
      title: 'Checkout refresh',
    });

    expect(created.slug).toBe('checkout-refresh');

    const renamed = await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      slug: 'checkout-rework',
    });

    expect(renamed.slug).toBe('checkout-rework');

    const reused = await service.createArchitectPlan({
      branchName,
      planId: '1710000000013',
      slug: 'checkout-refresh',
    });

    expect(reused.slug).toBe('checkout-refresh');
  });

  it('refuses to rename a plan slug after the plan is locked', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000014',
      slug: 'checkout-refresh',
    });

    await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      status: 'validated',
    });

    await expect(
      service.updateArchitectPlan({
        branchName,
        planId: created.id,
        slug: 'checkout-rework',
      })
    ).rejects.toThrow('Plan slug is immutable and cannot be changed after creation.');
  });

  it('refuses to archive canonical plans still named new plan', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000011',
      label: 'new plan',
    });

    await expect(service.archiveArchitectPlan(branchName, created.id)).rejects.toThrow(
      'Rename the plan before archiving it.'
    );

    const reloaded = await service.getArchitectPlan(branchName, created.id);
    expect(reloaded?.status).toBe('draft');

    await expect(
      service.updateArchitectPlan({
        branchName,
        planId: created.id,
        status: 'archived',
      })
    ).rejects.toThrow('Rename the plan before archiving it.');
  });

  it('allows archiving and deleting a renamed canonical plan', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000011-renamed',
      label: 'new plan',
    });

    const renamed = await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      label: 'Architecture scratchpad',
    });

    expect(renamed.label).toBe('Architecture scratchpad');

    const archived = await service.archiveArchitectPlan(branchName, created.id);
    expect(archived.status).toBe('archived');

    await expect(
      service.deleteArchitectPlan({
        branchName,
        planId: created.id,
      })
    ).resolves.toBeUndefined();

    const reloaded = await service.getArchitectPlan(branchName, created.id);
    expect(reloaded?.status).toBe('deleted');
  });

  it('allows explicitly expanding expected project ids on update', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000012',
      projectIds: ['web'],
    });

    const updated = await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      projectIds: ['web', 'api'],
      expectedProjectIds: ['web', 'api'],
    });

    expect(updated.projectIds).toEqual(['web', 'api']);
    expect(updated.expectedProjectIds).toEqual(['web', 'api']);

    const reloaded = await service.getArchitectPlan(branchName, created.id);
    expect(reloaded?.projectIds).toEqual(['web', 'api']);
    expect(reloaded?.expectedProjectIds).toEqual(['web', 'api']);
  });

  it('persists read-only context project ids separately from actionable project ids', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000013',
      projectIds: ['web'],
      contextProjectIds: ['docs'],
    });

    expect(created.projectIds).toEqual(['web']);
    expect(created.contextProjectIds).toEqual(['docs']);
    expect(created.expectedProjectIds).toEqual(['web', 'docs']);

    const updated = await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      projectIds: ['web', 'api'],
      expectedProjectIds: ['web', 'api'],
      contextProjectIds: ['docs', 'storybook'],
    });

    expect(updated.projectIds).toEqual(['web', 'api']);
    expect(updated.expectedProjectIds).toEqual(['web', 'api', 'docs', 'storybook']);
    expect(updated.contextProjectIds).toEqual(['docs', 'storybook']);

    const reloaded = await service.getArchitectPlan(branchName, created.id);
    expect(reloaded?.projectIds).toEqual(['web', 'api']);
    expect(reloaded?.expectedProjectIds).toEqual(['web', 'api', 'docs', 'storybook']);
    expect(reloaded?.contextProjectIds).toEqual(['docs', 'storybook']);

    const listed = await service.listArchitectPlans(branchName, true, true);
    expect(listed.plans.find((plan: ArchitectPlanSummary) => plan.id === created.id)?.contextProjectIds).toEqual([
      'docs',
      'storybook',
    ]);
  });

  it('hydrates legacy expected-only scope without letting stale expected ids expand modern plans', async () => {
    const legacyExpectedOnlyPlan: ArchitectPlanRecord = {
      id: 'legacy-expected-only',
      slug: 'legacy-expected-only',
      title: 'Legacy expected only',
      description: 'Old plan with no projectIds field.',
      status: 'draft',
      targetBranch: branchName,
      contextProjectIds: ['docs'],
      expectedProjectIds: ['web', 'docs'],
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
      nodes: [],
      predictedBranches: [],
    };
    seedLegacyPlan(storage, legacyExpectedOnlyPlan);

    const hydratedLegacy = await service.getArchitectPlan(branchName, legacyExpectedOnlyPlan.id);
    expect(hydratedLegacy?.projectIds).toEqual(['web']);
    expect(hydratedLegacy?.contextProjectIds).toEqual(['docs']);
    expect(hydratedLegacy?.expectedProjectIds).toEqual(['web', 'docs']);

    const staleExpectedPlan: ArchitectPlanRecord = {
      ...legacyExpectedOnlyPlan,
      id: 'stale-expected-modern',
      slug: 'stale-expected-modern',
      title: 'Stale expected modern',
      projectId: 'web',
      projectIds: ['web'],
      expectedProjectIds: ['web', 'docs', 'storybook'],
    };
    seedLegacyPlan(storage, staleExpectedPlan);

    const hydratedModern = await service.getArchitectPlan(branchName, staleExpectedPlan.id);
    expect(hydratedModern?.projectIds).toEqual(['web']);
    expect(hydratedModern?.contextProjectIds).toEqual(['docs']);
    expect(hydratedModern?.expectedProjectIds).toEqual(['web', 'docs']);
  });

  it('preserves legacy title rename behavior and uses stored slugs for branch naming', async () => {
    const legacyPlan: ArchitectPlanRecord = {
      id: 'legacy-plan',
      slug: 'checkout',
      title: 'Checkout',
      description: 'Legacy plan',
      status: 'validated',
      targetBranch: branchName,
      projectId: 'web',
      projectIds: ['web'],
      createdAt: '2026-03-15T00:00:00.000Z',
      updatedAt: '2026-03-15T00:00:00.000Z',
      nodes: [],
      predictedBranches: [],
    };

    seedLegacyPlan(storage, legacyPlan);

    const canonicalPlan = await service.createArchitectPlan({
      branchName,
      planId: '1710000000020',
      title: 'Checkout',
    });

    const loadedLegacyPlan = await service.getArchitectPlan(branchName, legacyPlan.id);
    expect(loadedLegacyPlan).not.toBeNull();
    expect(loadedLegacyPlan?.slug).toBe('checkout');
    expect(loadedLegacyPlan?.title).toBe('Checkout');

    const renamedLegacyPlan = await service.updateArchitectPlan({
      branchName,
      planId: legacyPlan.id,
      title: 'Checkout v2',
    });

    expect(renamedLegacyPlan.slug).toBe('checkout');
    expect(renamedLegacyPlan.title).toBe('Checkout v2');
    expect(service.toPlanIntegrationBranch(renamedLegacyPlan.slug)).toBe('plan/checkout');
    expect(service.toPlanIntegrationBranch(canonicalPlan.slug)).toBe('plan/checkout-2');

    const listed = await service.listArchitectPlans(branchName, true, true);
    expect(listed.plans.find((plan: ArchitectPlanSummary) => plan.id === legacyPlan.id)?.slug).toBe('checkout');
    expect(listed.plans.find((plan: ArchitectPlanSummary) => plan.id === canonicalPlan.id)?.slug).toBe('checkout-2');
  });

  it('returns no aggregated active plan when metadata scopes disagree on the active plan id', async () => {
    const registrySnapshot: ValidProjectRegistrySnapshot = {
      selectedGroupId: null,
      selectedProjectId: null,
      scopedProjectIds: [],
      actionableProjectIds: ['web', 'api'],
      readOnlyProjectIds: [],
      actionableProjectIdSet: new Set(['web', 'api']),
      readOnlyProjectIdSet: new Set<string>(),
      validProjectIds: ['web', 'api'],
      validProjectIdSet: new Set(['web', 'api']),
      repoPathByProjectId: new Map([
        ['web', '/repos/web'],
        ['api', '/repos/api'],
      ]),
      hasRegisteredProjects: true,
    };

    const buildSummary = (id: string, projectId: string): ArchitectPlanSummary => ({
      id,
      slug: id,
      title: id,
      label: id,
      description: '',
      status: 'draft',
      targetBranch: branchName,
      projectId,
      projectIds: [projectId],
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
      nodeCount: 0,
    });

    service = await loadArchitectPlanService({
      tauriAvailable: true,
      workspaceRoot: '/repos/web',
      registrySnapshot,
      filesByWorkspacePath: {
        '/repos/web': {
          'branches/develop/plans/index.json': JSON.stringify({
            version: 3,
            activePlanId: 'plan-a',
            plans: [buildSummary('plan-a', 'web')],
            reservedPlanSlugs: ['plan-a'],
          }),
        },
        '/repos/api': {
          'branches/develop/plans/index.json': JSON.stringify({
            version: 3,
            activePlanId: 'plan-b',
            plans: [buildSummary('plan-b', 'api')],
            reservedPlanSlugs: ['plan-b'],
          }),
        },
      },
    });

    const listed = await service.listArchitectPlans(branchName, true, true);

    expect(listed.activePlanId).toBeNull();
  });

  it('removes orphaned planned metadata while preserving executed task history', async () => {
    const registrySnapshot: ValidProjectRegistrySnapshot = {
      selectedGroupId: null,
      selectedProjectId: null,
      scopedProjectIds: [],
      actionableProjectIds: ['web'],
      readOnlyProjectIds: [],
      actionableProjectIdSet: new Set(['web']),
      readOnlyProjectIdSet: new Set<string>(),
      validProjectIds: ['web'],
      validProjectIdSet: new Set(['web']),
      repoPathByProjectId: new Map([['web', '/repos/web']]),
      hasRegisteredProjects: true,
    };
    const filesByWorkspacePath: Record<string, Record<string, string>> = {
      '/repos/web': {},
    };

    service = await loadArchitectPlanService({
      tauriAvailable: true,
      workspaceRoot: '/repos/web',
      registrySnapshot,
      filesByWorkspacePath,
    });

    await service.createArchitectPlan({
      branchName,
      planId: 'plan-task-metadata',
      projectIds: ['web'],
      nodes: [
        {
          id: 'task-keep',
          title: 'Keep planned file',
          description: 'Still in the plan',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'feature/keep-planned-file',
          projectId: 'web',
          projectIds: ['web'],
        },
        {
          id: 'task-remove',
          title: 'Remove planned file',
          description: 'Will disappear from the plan',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'feature/remove-planned-file',
          projectId: 'web',
          projectIds: ['web'],
        },
      ],
    });

    filesByWorkspacePath['/repos/web'][
      'branches/develop/plans/plan-task-metadata/tasks/task-remove/executed.md'
    ] = '# Executed task';

    await service.updateArchitectPlan({
      branchName,
      planId: 'plan-task-metadata',
      nodes: [
        {
          id: 'task-keep',
          title: 'Keep planned file',
          description: 'Still in the plan',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'feature/keep-planned-file',
          projectId: 'web',
          projectIds: ['web'],
        },
      ],
    });

    expect(
      filesByWorkspacePath['/repos/web'][
        'branches/develop/plans/plan-task-metadata/tasks/task-keep/planned.md'
      ]
    ).toContain('Keep planned file');
    expect(
      filesByWorkspacePath['/repos/web'][
        'branches/develop/plans/plan-task-metadata/tasks/task-remove/planned.md'
      ]
    ).toBeUndefined();
    expect(
      filesByWorkspacePath['/repos/web'][
        'branches/develop/plans/plan-task-metadata/tasks/task-remove/executed.md'
      ]
    ).toBe('# Executed task');
  });

  it('does not treat unscoped legacy plans as visible inside a selected project scope', () => {
    const legacyUnscopedPlan: ArchitectPlanSummary = {
      id: 'legacy-unscoped',
      slug: 'legacy-unscoped',
      title: 'legacy-unscoped',
      label: 'new plan',
      description: '',
      status: 'draft',
      targetBranch: branchName,
      projectId: undefined,
      projectIds: [],
      expectedProjectIds: [],
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
      nodeCount: 0,
    };

    expect(service.isArchitectPlanVisibleForScope(legacyUnscopedPlan, ['web'])).toBe(false);
    expect(service.isArchitectPlanVisibleForScope(legacyUnscopedPlan, [])).toBe(true);
    expect(service.planMatchesProjectId(legacyUnscopedPlan, 'web')).toBe(false);
  });

  it('does not bump revision when updating a plan with identical semantic content', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000990',
      label: 'Plan stable',
      description: 'Keep this plan unchanged.',
    });

    const updated = await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      label: 'Plan stable',
      description: 'Keep this plan unchanged.',
    });

    expect(updated.updatedAt).toBe(created.updatedAt);
    expect(updated.revision).toBe(created.revision);
  });

  it('does not bump revision when saving identical needs twice', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000991',
    });
    const needs = [
      {
        id: 'need-1',
        planId: created.id,
        title: 'Clarify economy',
        description: 'Need a stable loop for resources.',
        category: 'functional' as const,
        status: 'identified' as const,
        priority: 'high' as const,
        tags: ['economy'],
        createdAt: '2026-04-14T12:00:00.000Z',
        updatedAt: '2026-04-14T12:00:00.000Z',
      },
    ];

    await service.saveArchitectPlanNeeds(branchName, created.id, needs);
    const afterFirstSave = await service.getArchitectPlan(branchName, created.id);
    await service.saveArchitectPlanNeeds(branchName, created.id, needs);
    const afterSecondSave = await service.getArchitectPlan(branchName, created.id);

    expect(afterFirstSave?.updatedAt).toBe(afterSecondSave?.updatedAt);
    expect(afterFirstSave?.revision).toBe(afterSecondSave?.revision);
  });

  it('does not bump revision when saving an identical chat transcript twice', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000992',
    });
    const transcript = [
      {
        id: 'msg-1',
        role: 'assistant' as const,
        content: 'Quel est le cadrage produit ?',
        createdAt: '2026-04-14T12:05:00.000Z',
      },
    ];

    await service.saveArchitectPlanChatMessages(branchName, created.id, transcript);
    const afterFirstSave = await service.getArchitectPlan(branchName, created.id);
    await service.saveArchitectPlanChatMessages(branchName, created.id, transcript);
    const afterSecondSave = await service.getArchitectPlan(branchName, created.id);

    expect(afterFirstSave?.updatedAt).toBe(afterSecondSave?.updatedAt);
    expect(afterFirstSave?.revision).toBe(afterSecondSave?.revision);
  });

  it('persists lightweight need and chat counts in architect plan summaries', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000993',
    });

    await service.saveArchitectPlanNeeds(branchName, created.id, [
      {
        id: 'need-1',
        planId: created.id,
        title: 'Clarify retry UX',
        description: 'Need a clear retry loop for checkout.',
        category: 'functional',
        status: 'identified',
        priority: 'high',
        tags: ['checkout'],
        createdAt: '2026-04-14T12:00:00.000Z',
        updatedAt: '2026-04-14T12:00:00.000Z',
      },
    ]);
    await service.saveArchitectPlanChatMessages(branchName, created.id, [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'We should retry the payment intent.',
        createdAt: '2026-04-14T12:05:00.000Z',
      },
    ]);

    const listed = await service.listArchitectPlans(branchName, true, true);
    const summary = listed.plans.find(
      (plan: ArchitectPlanSummary) => plan.id === created.id,
    );

    expect(summary?.needCount).toBe(1);
    expect(summary?.chatMessageCount).toBe(1);
  });

  it('binds a blank plan conversation without loading or mutating blank content', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000994',
    });

    const bound = await service.bindArchitectPlanConversation({
      branchName,
      planId: created.id,
      conversationId: 'conv-blank',
    });

    expect(bound.conversationId).toBe('conv-blank');

    const listed = await service.listArchitectPlans(branchName, true, true);
    const summary = listed.plans.find(
      (plan: ArchitectPlanSummary) => plan.id === created.id,
    );
    const payload = await service.getArchitectPlanActivationPayload(
      branchName,
      created.id,
    );

    expect(summary?.conversationId).toBe('conv-blank');
    expect(summary?.needCount).toBe(0);
    expect(summary?.chatMessageCount).toBe(0);
    expect(payload?.conversationId).toBe('conv-blank');
    expect(payload?.needs).toHaveLength(0);
    expect(payload?.chatMessages).toHaveLength(0);
  });

  it('returns a blank fast-path activation payload for an untouched new plan', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000001994',
      label: DEFAULT_NEW_PLAN_LABEL,
    });

    const payload = await service.getArchitectPlanActivationPayload(
      branchName,
      created.id,
    );

    expect(payload?.resolutionMode).toBe('blank_fast_path');
    expect(payload?.plan.id).toBe(created.id);
    expect(payload?.needs).toHaveLength(0);
    expect(payload?.chatMessages).toHaveLength(0);
    expect(payload?.conversationId).toBeNull();
  });
});
