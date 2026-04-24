import { describe, expect, it } from 'bun:test';
import type { Project, ProjectGroup } from '../types';
import { inferArchitectPlanProjectScope } from './architectProjectScopeResolver';

const createProject = (overrides: Partial<Project> & Pick<Project, 'id' | 'name' | 'mountName' | 'path'>): Project => ({
  id: overrides.id,
  name: overrides.name,
  mountName: overrides.mountName,
  path: overrides.path,
  created_at: overrides.created_at || '2026-04-23T00:00:00.000Z',
  status: overrides.status || 'active',
  userReadOnly: overrides.userReadOnly ?? false,
  gitSetupState: overrides.gitSetupState || 'ready',
  isReadOnly: overrides.isReadOnly ?? false,
  readOnlyReason: overrides.readOnlyReason ?? null,
  metadata: overrides.metadata || {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
});

const projectGroup: ProjectGroup = {
  id: 'macro-suite',
  name: 'Macro Suite',
  isOpen: true,
  projects: [
    createProject({
      id: 'mobile',
      name: 'Macro Mobile',
      mountName: 'mobile',
      path: '/repos/mobile',
    }),
    createProject({
      id: 'backend',
      name: 'Macro Backend',
      mountName: 'backend',
      path: '/repos/backend',
    }),
    createProject({
      id: 'web',
      name: 'Macro Web',
      mountName: 'web',
      path: '/repos/web',
    }),
  ],
};

const entriesByPath: Record<
  string,
  Array<{
    path: string;
    kind: string;
    relative_path: string;
    name: string;
    is_hidden: boolean;
    is_readonly: boolean;
  }>
> = {
  '/repos/mobile': [
    {
      path: '/repos/mobile/android',
      kind: 'directory',
      relative_path: 'android',
      name: 'android',
      is_hidden: false,
      is_readonly: false,
    },
    {
      path: '/repos/mobile/app.json',
      kind: 'file',
      relative_path: 'app.json',
      name: 'app.json',
      is_hidden: false,
      is_readonly: false,
    },
  ],
  '/repos/backend': [
    {
      path: '/repos/backend/prisma',
      kind: 'directory',
      relative_path: 'prisma',
      name: 'prisma',
      is_hidden: false,
      is_readonly: false,
    },
    {
      path: '/repos/backend/src/api',
      kind: 'directory',
      relative_path: 'src/api',
      name: 'api',
      is_hidden: false,
      is_readonly: false,
    },
  ],
  '/repos/web': [
    {
      path: '/repos/web/next.config.js',
      kind: 'file',
      relative_path: 'next.config.js',
      name: 'next.config.js',
      is_hidden: false,
      is_readonly: false,
    },
    {
      path: '/repos/web/src/app',
      kind: 'directory',
      relative_path: 'src/app',
      name: 'app',
      is_hidden: false,
      is_readonly: false,
    },
  ],
};

const tauriStub = {
  isTauriAvailable: () => true,
  fsListDir: async ({ path }: { path: string }) => entriesByPath[path] || [],
  fsReadFileWithOptions: async () => ({
    content: '{}',
    language: 'json',
    is_binary: false,
    size: 2,
    encoding: 'utf-8',
  }),
};

describe('inferArchitectPlanProjectScope', () => {
  it('infers actionable mobile and backend repos while leaving explicitly excluded web out of scope', async () => {
    const scope = await inferArchitectPlanProjectScope({
      activePlan: {
        status: 'draft',
        projectIds: [],
        contextProjectIds: [],
        title: 'Mini game mobile',
        label: 'Mini game mobile',
        description: 'Ajouter un mini-jeu pour mobile relié au backend, pas web.',
      },
      nodes: [
        {
          title: 'Construire le mini-jeu mobile',
          description: 'Prévoir aussi les endpoints backend nécessaires.',
          projectId: undefined,
          projectIds: undefined,
        },
      ],
      projectGroups: [projectGroup],
      selectedGroupId: 'macro-suite',
      tauri: tauriStub,
    });

    expect(scope.actionableProjectIds).toEqual(['mobile', 'backend']);
    expect(scope.contextProjectIds).toEqual([]);
    expect(scope.expectedProjectIds).toEqual(['mobile', 'backend']);
    expect(scope.reasonsByProjectId.mobile).toContain('plan brief');
    expect(scope.reasonsByProjectId.backend).toContain('plan brief');
    expect(scope.reasonsByProjectId.web).toBeUndefined();
  });

  it('preserves existing actionable and context scope additively after validation', async () => {
    const scope = await inferArchitectPlanProjectScope({
      activePlan: {
        status: 'validated',
        projectIds: ['web'],
        contextProjectIds: ['mobile'],
        title: 'API hardening',
        label: 'API hardening',
        description: 'Renforcer le backend.',
      },
      nodes: [
        {
          title: 'Durcir les endpoints',
          description: 'Travail backend seulement.',
          projectId: undefined,
          projectIds: undefined,
        },
      ],
      projectGroups: [projectGroup],
      selectedGroupId: 'macro-suite',
      tauri: tauriStub,
    });

    expect(scope.actionableProjectIds).toEqual(['web', 'backend']);
    expect(scope.contextProjectIds).toEqual(['mobile']);
    expect(scope.expectedProjectIds).toEqual(['web', 'backend', 'mobile']);
    expect(scope.reasonsByProjectId.web).toContain('already-actionable');
    expect(scope.reasonsByProjectId.mobile).toContain('existing context');
  });
});
