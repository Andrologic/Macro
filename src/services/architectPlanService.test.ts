import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
const actualTauriIpc = await import('./tauriIpc');
import type { ArchitectPlanRecord, ArchitectPlanSummary } from './architectPlanService';
import type { WorkspaceScope } from './tauriIpc';
import type { ValidProjectRegistrySnapshot } from './validProjectRegistry';
import { DEFAULT_NEW_PLAN_LABEL } from './architectPlanPresentation';
import { registerAppStateGetter } from './appStateRuntime';

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
  appSettings?: Map<string, string>;
  filesByWorkspacePath?: Record<string, Record<string, string>>;
  registrySnapshot?: ValidProjectRegistrySnapshot;
  workspaceRoot?: string;
  macroBranchCommitIfDirty?: typeof actualTauriIpc.macroBranchCommitIfDirty;
  workspaceScopeCalls?: Array<{
    operation: string;
    workspaceScope?: WorkspaceScope;
  }>;
  failWriteOnce?: (params: {
    path: string;
    workspacePath?: string | null;
    workspaceScope?: WorkspaceScope;
  }) => boolean;
}

const registerArchitectPlanMocks = (options: LoadArchitectPlanServiceOptions = {}) => {
  mock.restore();
  const appSettings = options.appSettings ?? new Map<string, string>();
  const configDocuments = new Map(['runtime', 'settings', 'agents', 'providers', 'tools', 'skills', 'git'].map((kind) => [kind, {
    kind,
    scope: { type: 'user' },
    value: { $schema: `./schemas/v1/${kind}.schema.json`, schemaVersion: 1 } as Record<string, unknown>,
    etag: `${kind}-etag-0`,
    readOnly: false,
    invalid: false,
    filePath: `${kind}.json`,
    diagnostics: [],
  }]));
  let configRevision = 0;
  let writeFailureTriggered = false;
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
    configGetDocument: async (kind: string) => configDocuments.get(kind),
    configGetSnapshot: async () => ({
      schemaVersion: 1,
      effective: Object.fromEntries(
        [...configDocuments.entries()].map(([kind, document]) => [kind, document.value]),
      ),
      documents: [...configDocuments.values()],
      provenance: [],
      diagnostics: [],
      pendingRestartPaths: [],
    }),
    configListPendingChanges: async () => [],
    configApplyPatch: async (request: {
      kind: string;
      patch: Array<{ op: string; path: string; value?: unknown }>;
    }) => {
      const current = configDocuments.get(request.kind);
      if (!current) throw new Error(`Missing configuration document ${request.kind}`);
      const value = { ...current.value };
      for (const operation of request.patch) {
        const key = operation.path.replace(/^\//, '').replaceAll('~1', '/').replaceAll('~0', '~');
        if (operation.op === 'remove') delete value[key];
        else value[key] = operation.value;
      }
      configRevision += 1;
      const document = { ...current, value, etag: `${request.kind}-etag-${configRevision}` };
      configDocuments.set(request.kind, document);
      return {
        status: 'applied',
        document,
        pendingChange: null,
        restartRequired: false,
      };
    },
    dbGetAppSetting: async (key: string) => {
      const value = appSettings.get(key);
      return value === undefined ? null : { key, value_json: value, updated_at: '' };
    },
    dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }: {
      key: string;
      expectedValueJson: string | null;
      valueJson: string;
    }) => {
      if ((appSettings.get(key) ?? null) !== expectedValueJson) {
        return { applied: false };
      }
      appSettings.set(key, valueJson);
      return { applied: true };
    },
    workspaceGetActiveRoot: async () => options.workspaceRoot ?? '/repos/web',
    macroBranchCommitIfDirty: options.macroBranchCommitIfDirty ?? (async () => ({
      branch: '@macro',
      state: 'clean',
      worktree_path: `${options.workspaceRoot ?? '/repos/web'}/.git/macro-metadata-worktree`,
      is_dirty: false,
      has_origin: false,
      has_upstream: false,
      ahead: 0,
      behind: 0,
      conflicted_files: [],
      committed: false,
      commit_hash: null,
      reason: null,
      next_action: null,
    })),
    fsReadFileWithOptions: async (params: {
      path: string;
      workspacePath?: string | null;
      workspaceScope?: WorkspaceScope;
    }) => {
      options.workspaceScopeCalls?.push({ operation: 'read', workspaceScope: params.workspaceScope });
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
      workspaceScope?: WorkspaceScope;
    }) => {
      options.workspaceScopeCalls?.push({ operation: 'write', workspaceScope: params.workspaceScope });
      if (!writeFailureTriggered && options.failWriteOnce?.(params)) {
        writeFailureTriggered = true;
        throw new Error('Injected replica write failure');
      }
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
      workspaceScope?: WorkspaceScope;
    }) => {
      options.workspaceScopeCalls?.push({ operation: 'list', workspaceScope: params.workspaceScope });
      const workspacePath = params.workspacePath ?? '';
      return listWorkspaceDir(workspacePath, params.path);
    },
    fsDelete: async (params: {
      path: string;
      recursive?: boolean;
      workspacePath?: string | null;
      workspaceScope?: WorkspaceScope;
    }) => {
      options.workspaceScopeCalls?.push({ operation: 'delete', workspaceScope: params.workspaceScope });
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
    const preferences = await import('./preferences');
    await preferences.savePreferences({
      [preferences.PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH]: 'develop',
      [preferences.PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH]: 'main',
    });
    service = await loadArchitectPlanService();
  });

  afterEach(() => {
    registerAppStateGetter(() => ({ standaloneProjects: [], projectGroups: [] }));
    mock.restore();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('allows main as the target branch in mainline mode', async () => {
    const preferences = await import('./preferences');
    await preferences.savePreferences({
      [preferences.PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH]: 'main',
      [preferences.PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH]: 'main',
    });

    expect(service.resolveTargetBranch('main')).toBe('main');
    expect(service.resolveTargetBranch('feature/foo')).toBe('feature/foo');
    expect(service.resolveTargetBranch('hotfix/foo')).toBe('hotfix/foo');
  });

  it('keeps legacy develop target branches readable in mainline mode', async () => {
    const preferences = await import('./preferences');
    await preferences.savePreferences({
      [preferences.PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH]: 'main',
      [preferences.PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH]: 'main',
    });

    expect(service.resolveTargetBranch('develop')).toBe('develop');
  });

  it('rejects release and bugfix target branches in mainline mode', async () => {
    const preferences = await import('./preferences');
    await preferences.savePreferences({
      [preferences.PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH]: 'main',
      [preferences.PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH]: 'main',
    });

    expect(() => service.resolveTargetBranch('release/foo')).toThrow(
      'Mainline workflow uses "main" as the development branch and only allows feature/* or hotfix/* work branches.'
    );
    expect(() => service.resolveTargetBranch('bugfix/foo')).toThrow(
      'Mainline workflow uses "main" as the development branch and only allows feature/* or hotfix/* work branches.'
    );
  });

  it('keeps typed Git workflow target branches available for develop-based projects', async () => {
    const preferences = await import('./preferences');
    await preferences.savePreferences({
      [preferences.PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH]: 'develop',
      [preferences.PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH]: 'main',
    });

    expect(service.resolveTargetBranch('release/foo')).toBe('release/foo');
    expect(service.resolveTargetBranch('hotfix/foo')).toBe('hotfix/foo');
    expect(service.resolveTargetBranch('bugfix/foo')).toBe('bugfix/foo');
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

  it('reserves distinct ids and slugs for concurrent plan creations', async () => {
    const [first, second] = await Promise.all([
      service.createArchitectPlan({ branchName, title: 'Concurrent plan' }),
      service.createArchitectPlan({ branchName, title: 'Concurrent plan' }),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(first.slug).toBe('concurrent-plan');
    expect(second.slug).toBe('concurrent-plan-2');

    const listed = await service.listArchitectPlans(branchName, true, true);
    expect(listed.plans.map((plan: ArchitectPlanSummary) => plan.id).sort()).toEqual(
      [first.id, second.id].sort()
    );
  });

  it('rejects one of two concurrent creations with the same explicit id', async () => {
    const results = await Promise.allSettled([
      service.createArchitectPlan({ branchName, planId: 'explicit-collision', title: 'First' }),
      service.createArchitectPlan({ branchName, planId: 'explicit-collision', title: 'Second' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: 'A plan with id "explicit-collision" already exists. Choose a different identifier.',
      }),
    });

    const listed = await service.listArchitectPlans(branchName, true, true);
    expect(
      listed.plans.filter((plan: ArchitectPlanSummary) => plan.id === 'explicit-collision')
    ).toHaveLength(1);
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

  it('allows safe metadata but rejects scope changes after draft status', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000015',
      slug: 'checkout-refresh',
      projectIds: ['web'],
    });

    await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      status: 'validated',
    });

    const relabeled = await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      label: 'Release checkout',
      description: 'Ready for implementation',
    });

    expect(relabeled.label).toBe('Release checkout');
    expect(relabeled.description).toBe('Ready for implementation');

    await expect(
      service.updateArchitectPlan({
        branchName,
        planId: created.id,
        projectIds: ['web', 'api'],
      })
    ).rejects.toThrow('Plan scope and Git workflow metadata are immutable after draft status.');
  });

  it('exposes delete only after a plan has been archived', () => {
    expect(service.getArchitectPlanCrudCapabilities({ status: 'draft' }).canDelete).toBe(false);
    expect(service.getArchitectPlanCrudCapabilities({ status: 'validated' }).canDelete).toBe(false);
    expect(service.getArchitectPlanCrudCapabilities({ status: 'in_progress' }).canDelete).toBe(false);
    expect(service.getArchitectPlanCrudCapabilities({ status: 'completed' }).canDelete).toBe(false);
    expect(service.getArchitectPlanCrudCapabilities({ status: 'archived' }).canDelete).toBe(true);
  });

  it('allows archiving and hard deleting canonical draft plans still named new plan', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000011',
      label: 'new plan',
    });

    const archived = await service.archiveArchitectPlan(branchName, created.id);
    expect(archived.status).toBe('archived');

    await expect(
      service.deleteArchitectPlan({
        branchName,
        planId: created.id,
        hardDelete: true,
      })
    ).resolves.toBeUndefined();

    const reloaded = await service.getArchitectPlan(branchName, created.id);
    expect(reloaded).toBeNull();
  });

  it('releases a draft plan slug after hard delete', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000011-delete-draft',
      slug: 'scratch-plan',
    });

    await service.deleteArchitectPlan({
      branchName,
      planId: created.id,
      hardDelete: true,
    });

    const recreated = await service.createArchitectPlan({
      branchName,
      planId: '1710000000011-delete-draft-recreated',
      slug: 'scratch-plan',
    });

    expect(recreated.slug).toBe('scratch-plan');
  });

  it('archives and restores non-draft canonical plans still named new plan', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000011-validated',
      label: 'new plan',
    });

    await service.updateArchitectPlan({
      branchName,
      planId: created.id,
      status: 'validated',
    });

    const archived = await service.archiveArchitectPlan(branchName, created.id);
    expect(archived.status).toBe('archived');
    expect(archived.archivedFromStatus).toBe('validated');
    expect(archived.archivedAt).toBeTruthy();

    const restored = await service.restoreArchitectPlan(branchName, created.id);
    expect(restored.status).toBe('validated');
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.archivedFromStatus).toBeUndefined();
  });

  it('allows archiving and hard deleting a renamed canonical plan', async () => {
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
        hardDelete: true,
      })
    ).resolves.toBeUndefined();

    const reloaded = await service.getArchitectPlan(branchName, created.id);
    expect(reloaded).toBeNull();
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

  it('normalizes typed Git workflow metadata with project-specific branch settings', async () => {
    const deps = {
      tauri: {
        ...actualTauriIpc,
        isTauriAvailable: () => false,
      } as any,
      getAppState: async () => ({
        projectGroups: [
          {
            id: 'workspace',
            name: 'Workspace',
            projects: [
              {
                id: 'mobile',
                name: 'Mobile',
                path: '/repos/mobile',
                gitFlowSettings: {
                  baseBranch: 'dev',
                  mainBranch: 'stable',
                  releaseBranchTemplate: 'ship/v{releaseSlug}',
                },
              },
            ],
          },
        ],
      }) as any,
    };

    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000015',
      slug: 'release-2-0-0',
      planKind: 'release',
      projectIds: ['mobile'],
      gitFlowPlan: {
        version: 1,
        planKind: 'release',
        slug: '2.0.0',
        projects: {
          mobile: {
            projectId: 'mobile',
            sourceBranch: '',
            integrationBranch: '',
            targetBranch: '',
            proposedVersion: '2.0.0',
          },
        },
      },
    }, deps);

    expect(created.planKind).toBe('release');
    expect(created.targetBranchesByProjectId?.mobile).toBe('stable');
    expect(created.gitFlowPlan?.projects.mobile).toMatchObject({
      sourceBranch: 'dev',
      integrationBranch: 'ship/v2.0.0',
      targetBranch: 'stable',
      backmergeBranch: 'dev',
      proposedVersion: '2.0.0',
    });
  });

  it('uses project development branches as effective feature plan targets even when storage branch is main', async () => {
    const preferences = await import('./preferences');
    await preferences.savePreferences({
      [preferences.PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH]: 'main',
      [preferences.PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH]: 'main',
    });

    const created = await service.createArchitectPlan({
      branchName: 'main',
      planId: '1710000000016',
      slug: 'feature-target-repair',
      planKind: 'feature',
      projectIds: ['web'],
    }, {
      tauri: {
        ...actualTauriIpc,
        isTauriAvailable: () => false,
      } as any,
      getAppState: async () => ({
        projectGroups: [
          {
            id: 'workspace',
            name: 'Workspace',
            projects: [
              {
                id: 'web',
                name: 'Web',
                path: '/repos/web',
                gitFlowSettings: {
                  baseBranch: 'develop',
                  mainBranch: 'master',
                  planBranchTemplate: 'plan/{planSlug}',
                  featureBranchTemplate: 'feature/{planSlug}/{featureSlug}',
                  standaloneFeatureBranchTemplate: 'feature/{featureSlug}',
                  releaseBranchTemplate: 'release/v{releaseSlug}',
                  hotfixBranchTemplate: 'hotfix/{hotfixSlug}',
                  bugfixBranchTemplate: 'bugfix/{bugfixSlug}',
                },
              },
            ],
          },
        ],
      }) as any,
    });

    expect(created.targetBranch).toBe('main');
    expect(created.targetBranchesByProjectId).toEqual({ web: 'develop' });
    expect(service.getArchitectPlanEffectiveTargetBranch(created)).toBe('develop');
    expect(service.getArchitectPlanEffectiveTargetBranchesByProjectId(
      {
        ...created,
        targetBranchesByProjectId: { web: 'master' },
      },
      {
        getProjectGitFlowSettings: () => ({
          baseBranch: 'develop',
          mainBranch: 'master',
        }),
      }
    )).toEqual({ web: 'develop' });
    expect(service.getArchitectPlanEffectiveTargetBranchesByProjectId(
      {
        ...created,
        planKind: 'bugfix',
        targetBranchesByProjectId: { web: 'master' },
      },
      {
        getProjectGitFlowSettings: () => ({
          baseBranch: 'develop',
          mainBranch: 'master',
        }),
      }
    )).toEqual({ web: 'develop' });
    expect(service.getArchitectPlanEffectiveTargetBranchesByProjectId(
      {
        ...created,
        planKind: 'release',
        targetBranchesByProjectId: { web: 'master' },
      },
      {
        getProjectGitFlowSettings: () => ({
          baseBranch: 'develop',
          mainBranch: 'master',
        }),
      }
    )).toEqual({ web: 'master' });
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
      workspacePathByProjectId: new Map([
        ['web', '/repos/web'],
        ['api', '/repos/api'],
      ]),
      gitFlowSettingsByProjectId: new Map(),
      executionModeByProjectId: new Map([
        ['web', 'git'],
        ['api', 'git'],
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

  it('persists and reloads a direct-only plan from the project workspace', async () => {
    registerAppStateGetter(() => ({
      standaloneProjects: [{
        id: 'docs',
        path: '/repos/docs',
        isReadOnly: false,
        gitSetupState: 'ready' as const,
        directEdit: false,
      }],
      projectGroups: [],
    }));
    const registrySnapshot: ValidProjectRegistrySnapshot = {
      selectedGroupId: null,
      selectedProjectId: 'docs',
      scopedProjectIds: ['docs'],
      actionableProjectIds: ['docs'],
      readOnlyProjectIds: [],
      actionableProjectIdSet: new Set(['docs']),
      readOnlyProjectIdSet: new Set<string>(),
      validProjectIds: ['docs'],
      validProjectIdSet: new Set(['docs']),
      repoPathByProjectId: new Map(),
      workspacePathByProjectId: new Map([['docs', '/repos/docs']]),
      gitFlowSettingsByProjectId: new Map(),
      executionModeByProjectId: new Map([['docs', 'direct']]),
      hasRegisteredProjects: true,
    };
    const filesByWorkspacePath: Record<string, Record<string, string>> = {
      '/repos/docs': {},
    };
    const macroBranchCommitIfDirty = mock(async () => ({
      branch: '@macro',
      state: 'clean' as const,
      worktree_path: '/repos/docs/.git/macro-metadata-worktree',
      is_dirty: false,
      has_origin: false,
      has_upstream: false,
      ahead: 0,
      behind: 0,
      conflicted_files: [],
      committed: false,
      commit_hash: null,
      reason: null,
      next_action: null,
      output: '',
      error: null,
    }));

    service = await loadArchitectPlanService({
      tauriAvailable: true,
      workspaceRoot: '/repos/docs',
      registrySnapshot,
      filesByWorkspacePath,
      macroBranchCommitIfDirty,
    });
    await service.createArchitectPlan({
      branchName,
      planId: 'direct-plan',
      projectIds: ['docs'],
      nodes: [{
        id: 'edit-docs',
        title: 'Edit docs',
        description: 'Update the guide',
        type: 'task',
        status: 'pending',
        dependencies: [],
        assignedBranch: '',
        projectId: 'docs',
        projectIds: ['docs'],
        executionModesByProjectId: { docs: 'direct' },
      }],
    });

    expect(filesByWorkspacePath['/repos/docs']['branches/develop/plans/direct-plan/plan.json'])
      .toContain('"docs": "direct"');
    expect(macroBranchCommitIfDirty).not.toHaveBeenCalled();

    storage.clear();
    const reloaded = await service.getArchitectPlan(branchName, 'direct-plan');

    expect(reloaded?.projectIds).toEqual(['docs']);
    expect(reloaded?.nodes[0]?.executionModesByProjectId).toEqual({ docs: 'direct' });

    macroBranchCommitIfDirty.mockClear();
    await service.commitArchitectPlanMetadata({
      branchName,
      planId: 'direct-plan',
      commitMessage: 'chore(metadata): finalize architect plan direct-plan',
    });
    expect(macroBranchCommitIfDirty).not.toHaveBeenCalled();
  });

  it('keeps persisted direct plan metadata in the project after Git is initialized', async () => {
    const appProject: {
      id: string;
      path: string;
      isReadOnly: boolean;
      gitSetupState: 'not_git' | 'ready';
      directEdit: boolean;
    } = {
      id: 'docs',
      path: '/repos/docs',
      isReadOnly: false,
      gitSetupState: 'not_git' as const,
      directEdit: true,
    };
    registerAppStateGetter(() => ({
      standaloneProjects: [appProject],
      projectGroups: [],
    }));
    const baseSnapshot: ValidProjectRegistrySnapshot = {
      selectedGroupId: null,
      selectedProjectId: 'docs',
      scopedProjectIds: ['docs'],
      actionableProjectIds: ['docs'],
      readOnlyProjectIds: [],
      actionableProjectIdSet: new Set(['docs']),
      readOnlyProjectIdSet: new Set<string>(),
      validProjectIds: ['docs'],
      validProjectIdSet: new Set(['docs']),
      repoPathByProjectId: new Map(),
      workspacePathByProjectId: new Map([['docs', '/repos/docs']]),
      gitFlowSettingsByProjectId: new Map(),
      executionModeByProjectId: new Map([['docs', 'direct']]),
      hasRegisteredProjects: true,
    };
    const filesByWorkspacePath: Record<string, Record<string, string>> = {
      '/repos/docs': {},
    };
    const workspaceScopeCalls: Array<{ operation: string; workspaceScope?: WorkspaceScope }> = [];
    const macroBranchCommitIfDirty = mock(async () => ({
      branch: '@macro',
      state: 'clean' as const,
      worktree_path: '/repos/docs/.git/macro-metadata-worktree',
      is_dirty: false,
      has_origin: false,
      has_upstream: false,
      ahead: 0,
      behind: 0,
      conflicted_files: [],
      committed: false,
      commit_hash: null,
      reason: null,
      next_action: null,
      output: '',
      error: null,
    }));
    service = await loadArchitectPlanService({
      tauriAvailable: true,
      workspaceRoot: '/repos/docs',
      registrySnapshot: baseSnapshot,
      filesByWorkspacePath,
      workspaceScopeCalls,
      macroBranchCommitIfDirty,
    });
    await service.createArchitectPlan({
      branchName,
      planId: 'transition-plan',
      projectIds: ['docs'],
      nodes: [{
        id: 'edit-docs',
        title: 'Edit docs',
        type: 'task',
        status: 'pending',
        dependencies: [],
        assignedBranch: '',
        projectId: 'docs',
        projectIds: ['docs'],
        executionModesByProjectId: { docs: 'direct' },
      }],
    });

    appProject.gitSetupState = 'ready';
    appProject.directEdit = false;
    const gitSnapshot: ValidProjectRegistrySnapshot = {
      ...baseSnapshot,
      repoPathByProjectId: new Map([['docs', '/repos/docs']]),
      executionModeByProjectId: new Map([['docs', 'git']]),
    };
    storage.clear();
    workspaceScopeCalls.length = 0;
    macroBranchCommitIfDirty.mockClear();
    service = await loadArchitectPlanService({
      tauriAvailable: true,
      workspaceRoot: '/repos/docs',
      registrySnapshot: gitSnapshot,
      filesByWorkspacePath,
      workspaceScopeCalls,
      macroBranchCommitIfDirty,
    });

    const reloaded = await service.getArchitectPlan(branchName, 'transition-plan');

    expect(reloaded?.nodes[0]?.executionModesByProjectId).toEqual({ docs: 'direct' });
    expect(workspaceScopeCalls.length).toBeGreaterThan(0);
    expect(workspaceScopeCalls.every((call) => call.workspaceScope === 'direct')).toBe(true);
    expect(macroBranchCommitIfDirty).not.toHaveBeenCalled();

    workspaceScopeCalls.length = 0;
    const activation = await service.getArchitectPlanActivationPayload(
      branchName,
      'transition-plan',
    );
    expect(activation?.plan.nodes[0]?.executionModesByProjectId).toEqual({ docs: 'direct' });
    expect(workspaceScopeCalls.length).toBeGreaterThan(0);
    expect(workspaceScopeCalls.every((call) => call.workspaceScope === 'direct')).toBe(true);
  });

  it('flushes task execution metadata only for persisted Git targets in a mixed plan', async () => {
    const projects = [
      {
        id: 'docs',
        path: '/repos/docs',
        isReadOnly: false,
        gitSetupState: 'not_git' as 'not_git' | 'ready',
        directEdit: true,
      },
      {
        id: 'api',
        path: '/repos/api',
        isReadOnly: false,
        gitSetupState: 'ready' as const,
        directEdit: false,
      },
    ];
    registerAppStateGetter(() => ({ standaloneProjects: projects, projectGroups: [] }));
    const initialSnapshot: ValidProjectRegistrySnapshot = {
      selectedGroupId: null,
      selectedProjectId: 'docs',
      scopedProjectIds: ['docs'],
      actionableProjectIds: ['docs', 'api'],
      readOnlyProjectIds: [],
      actionableProjectIdSet: new Set(['docs', 'api']),
      readOnlyProjectIdSet: new Set<string>(),
      validProjectIds: ['docs', 'api'],
      validProjectIdSet: new Set(['docs', 'api']),
      repoPathByProjectId: new Map([['api', '/repos/api']]),
      workspacePathByProjectId: new Map([
        ['docs', '/repos/docs'],
        ['api', '/repos/api'],
      ]),
      gitFlowSettingsByProjectId: new Map(),
      executionModeByProjectId: new Map([
        ['docs', 'direct'],
        ['api', 'git'],
      ]),
      hasRegisteredProjects: true,
    };
    const filesByWorkspacePath: Record<string, Record<string, string>> = {
      '/repos/docs': {},
      '/repos/api': {},
    };
    const macroBranchCommitIfDirty = mock(async ({ workspacePath }: { workspacePath?: string | null } = {}) => ({
      branch: '@macro',
      state: 'clean' as const,
      worktree_path: `${workspacePath}/.git/macro-metadata-worktree`,
      is_dirty: false,
      has_origin: false,
      has_upstream: false,
      ahead: 0,
      behind: 0,
      conflicted_files: [],
      committed: false,
      commit_hash: null,
      reason: null,
      next_action: null,
      output: '',
      error: null,
    }));
    service = await loadArchitectPlanService({
      tauriAvailable: true,
      workspaceRoot: '/repos/docs',
      registrySnapshot: initialSnapshot,
      filesByWorkspacePath,
      macroBranchCommitIfDirty,
    });
    await service.createArchitectPlan({
      branchName,
      planId: 'mixed-transition-plan',
      projectIds: ['docs', 'api'],
      nodes: [{
        id: 'mixed-task',
        title: 'Update docs and API',
        type: 'task',
        status: 'pending',
        dependencies: [],
        assignedBranch: '',
        projectId: 'docs',
        projectIds: ['docs', 'api'],
        executionModesByProjectId: { docs: 'direct', api: 'git' },
      }],
    });

    projects[0]!.gitSetupState = 'ready';
    projects[0]!.directEdit = false;
    const transitionedSnapshot: ValidProjectRegistrySnapshot = {
      ...initialSnapshot,
      repoPathByProjectId: new Map([
        ['docs', '/repos/docs'],
        ['api', '/repos/api'],
      ]),
      executionModeByProjectId: new Map([
        ['docs', 'git'],
        ['api', 'git'],
      ]),
    };
    storage.clear();
    macroBranchCommitIfDirty.mockClear();
    const { clearMacroMetadataCoordinatorForTests } = await import('./macroMetadataCoordinator');
    clearMacroMetadataCoordinatorForTests();
    service = await loadArchitectPlanService({
      tauriAvailable: true,
      workspaceRoot: '/repos/docs',
      registrySnapshot: transitionedSnapshot,
      filesByWorkspacePath,
      macroBranchCommitIfDirty,
    });

    await service.writeArchitectTaskExecution({
      branchName,
      planId: 'mixed-transition-plan',
      execution: {
        taskId: 'mixed-task',
        title: 'Update docs and API',
        completedAt: '2026-08-29T12:00:00.000Z',
        repositories: [{
          projectId: 'api',
          repoPath: '/repos/api',
          branchName: 'feature/mixed-task',
          planBranchName: 'plan/mixed-transition-plan',
        }],
      },
    });

    expect(macroBranchCommitIfDirty.mock.calls.map(([params]) => params?.workspacePath)).toEqual([
      '/repos/api',
    ]);
    expect(filesByWorkspacePath['/repos/docs'][
      'branches/develop/plans/mixed-transition-plan/tasks/mixed-task/executed.md'
    ]).toContain('Update docs and API');
  });

  it('recovers a mixed direct and Git replica mutation with the full workspace key', async () => {
    registerAppStateGetter(() => ({
      standaloneProjects: [
        {
          id: 'docs',
          path: '/repos/docs',
          isReadOnly: false,
          gitSetupState: 'not_git',
          directEdit: true,
        },
        {
          id: 'api',
          path: '/repos/api',
          isReadOnly: false,
          gitSetupState: 'ready',
          directEdit: false,
        },
      ],
      projectGroups: [],
    }));
    const registrySnapshot: ValidProjectRegistrySnapshot = {
      selectedGroupId: null,
      selectedProjectId: 'docs',
      scopedProjectIds: ['docs', 'api'],
      actionableProjectIds: ['docs', 'api'],
      readOnlyProjectIds: [],
      actionableProjectIdSet: new Set(['docs', 'api']),
      readOnlyProjectIdSet: new Set<string>(),
      validProjectIds: ['docs', 'api'],
      validProjectIdSet: new Set(['docs', 'api']),
      repoPathByProjectId: new Map([['api', '/repos/api']]),
      workspacePathByProjectId: new Map([
        ['docs', '/repos/docs'],
        ['api', '/repos/api'],
      ]),
      gitFlowSettingsByProjectId: new Map(),
      executionModeByProjectId: new Map([
        ['docs', 'direct'],
        ['api', 'git'],
      ]),
      hasRegisteredProjects: true,
    };
    const appSettings = new Map<string, string>();
    const filesByWorkspacePath: Record<string, Record<string, string>> = {
      '/repos/docs': {},
      '/repos/api': {},
    };

    service = await loadArchitectPlanService({
      tauriAvailable: true,
      appSettings,
      workspaceRoot: '/repos/docs',
      registrySnapshot,
      filesByWorkspacePath,
      failWriteOnce: ({ workspacePath }) => workspacePath === '/repos/api',
    });

    await expect(service.createArchitectPlan({
      branchName,
      planId: 'mixed-recovery-plan',
      projectIds: ['docs', 'api'],
      nodes: [{
        id: 'mixed-task',
        title: 'Update docs and API',
        type: 'task',
        status: 'pending',
        dependencies: [],
        assignedBranch: '',
        projectId: 'docs',
        projectIds: ['docs', 'api'],
        executionModesByProjectId: { docs: 'direct', api: 'git' },
      }],
    })).rejects.toThrow('Injected replica write failure');

    const pendingBeforeRecovery = JSON.parse(
      appSettings.get('pendingArchitectPlanReplicaMutations:v1') ?? '[]',
    ) as Array<{ workspaceKey: string }>;
    expect(pendingBeforeRecovery).toHaveLength(1);
    expect(pendingBeforeRecovery[0]?.workspaceKey).toBe('/repos/api|/repos/docs');

    service = await loadArchitectPlanService({
      tauriAvailable: true,
      appSettings,
      workspaceRoot: '/repos/docs',
      registrySnapshot,
      filesByWorkspacePath,
    });
    await service.listArchitectPlans(branchName, true, true);

    expect(JSON.parse(
      appSettings.get('pendingArchitectPlanReplicaMutations:v1') ?? '[]',
    )).toEqual([]);
    expect(JSON.parse(
      appSettings.get('pendingArchitectPlanReplicaMutationsQuarantine:v1') ?? '[]',
    )).toEqual([]);
    expect(filesByWorkspacePath['/repos/docs'][
      'branches/develop/plans/mixed-recovery-plan/plan.json'
    ]).toBeDefined();
    expect(filesByWorkspacePath['/repos/api'][
      'branches/develop/plans/mixed-recovery-plan/plan.json'
    ]).toBeDefined();
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
      workspacePathByProjectId: new Map([['web', '/repos/web']]),
      gitFlowSettingsByProjectId: new Map(),
      executionModeByProjectId: new Map([['web', 'git']]),
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

  it('treats physically available plan replicas as visible in the selected project scope', () => {
    const stalePlanFromSelectedRepo: ArchitectPlanSummary = {
      id: 'renamed-project-plan',
      slug: 'renamed-project-plan',
      title: 'Renamed project plan',
      label: 'Renamed project plan',
      description: '',
      status: 'draft',
      targetBranch: branchName,
      projectId: 'project-lplr-app-1780329499166',
      projectIds: ['project-lplr-app-1780329499166'],
      expectedProjectIds: ['project-lplr-app-1780329499166'],
      availableProjectIds: ['project-octan-sales-1780653766405'],
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
      nodeCount: 11,
    };

    expect(
      service.isArchitectPlanVisibleForScope(stalePlanFromSelectedRepo, [
        'project-octan-sales-1780653766405',
      ])
    ).toBe(true);
    expect(
      service.resolvePlanProjectContextId(
        stalePlanFromSelectedRepo,
        'project-octan-sales-1780653766405'
      )
    ).toBe('project-octan-sales-1780653766405');
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

  it('persists the lightweight chat count in architect plan summaries', async () => {
    const created = await service.createArchitectPlan({
      branchName,
      planId: '1710000000993',
    });

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
    expect(summary?.chatMessageCount).toBe(0);
    expect(payload?.conversationId).toBe('conv-blank');
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
    expect(payload?.chatMessages).toHaveLength(0);
    expect(payload?.conversationId).toBeNull();
  });
});
