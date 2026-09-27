import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  formatProjectRegistryRepairSummary,
  normalizeProjectRegistry,
  resolveCanonicalProject,
  resolveCanonicalProjectGroup,
  reconcileRememberedProjects,
} from './projectRegistry';

const makeProject = (id: string, path: string, name = id) => ({
  id,
  name,
  mountName: id,
  path,
  created_at: '2026-03-14T00:00:00.000Z',
  status: 'active' as const,
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
});

describe('projectRegistry', () => {
  let previousLanguage = 'en';

  beforeEach(() => {
    previousLanguage = document.documentElement.lang || 'en';
    document.documentElement.lang = 'fr';
  });

  afterEach(() => {
    document.documentElement.lang = previousLanguage;
  });

  it('deduplicates project paths and drops synthetic session entries', () => {
    const result = normalizeProjectRegistry({
      projectGroups: [
        {
          id: 'group-main',
          name: 'Main',
          isOpen: true,
          projects: [
            makeProject('project-web', 'C:/dev/app/web', 'Web'),
            makeProject('project-api', 'C:/dev/app/api', 'API'),
          ],
        },
        {
          id: 'group-duplicate',
          name: 'Duplicate',
          isOpen: true,
          projects: [makeProject('project-web-copy', 'C:\\dev\\app\\web', 'Web Copy')],
        },
        {
          id: 'session-group-1',
          name: 'Session',
          isOpen: true,
          projects: [makeProject('session-project-1', 'C:/temp/session', 'Session')],
        },
      ],
      selectedGroupId: 'group-duplicate',
      selectedProjectId: 'project-web-copy',
    });

    expect(result.projectGroups.map((group) => group.id)).toEqual(['group-main']);
    expect(result.projectGroups[0]?.projects.map((project) => project.id)).toEqual([
      'project-web',
      'project-api',
    ]);
    expect(result.selectedGroupId).toBe('group-main');
    expect(result.selectedProjectId).toBeNull();
    expect(result.report.duplicatePathsRemoved).toBe(1);
    expect(result.report.removedSyntheticGroups).toBe(1);
    expect(result.report.removedSyntheticProjects).toBe(0);
    expect(formatProjectRegistryRepairSummary(result.report)).toContain('Macro a réparé');
  });

  it('preserves case-sensitive POSIX paths as distinct projects', () => {
    const result = normalizeProjectRegistry({
      projectGroups: [
        {
          id: 'group-main',
          name: 'Main',
          isOpen: true,
          projects: [
            makeProject('project-upper', '/workspace/Macro', 'Macro'),
            makeProject('project-lower', '/workspace/macro', 'macro'),
          ],
        },
      ],
      selectedGroupId: 'group-main',
      selectedProjectId: null,
    });

    expect(result.projectGroups[0]?.projects.map((project) => project.id)).toEqual([
      'project-upper',
      'project-lower',
    ]);
    expect(result.report.duplicatePathsRemoved).toBe(0);
  });

  it('keeps all projects selected when only the group is restored', () => {
    const result = normalizeProjectRegistry({
      projectGroups: [
        {
          id: 'group-main',
          name: 'Main',
          isOpen: true,
          projects: [
            makeProject('project-web', 'C:/dev/app/web', 'Web'),
            makeProject('project-api', 'C:/dev/app/api', 'API'),
          ],
        },
      ],
      selectedGroupId: 'group-main',
      selectedProjectId: null,
    });

    expect(result.selectedGroupId).toBe('group-main');
    expect(result.selectedProjectId).toBeNull();
  });

  it('migrates singleton groups to standalone projects and repairs selection', () => {
    const result = normalizeProjectRegistry({
      projectGroups: [
        {
          id: 'group-single',
          name: 'Single',
          isOpen: true,
          projects: [makeProject('project-solo', 'C:/dev/app/solo', 'Solo')],
        },
      ],
      selectedGroupId: 'group-single',
      selectedProjectId: 'project-solo',
    });

    expect(result.projectGroups).toEqual([]);
    expect(result.standaloneProjects.map((project) => project.id)).toEqual(['project-solo']);
    expect(result.selectedGroupId).toBeNull();
    expect(result.selectedProjectId).toBe('project-solo');
  });

  it('reconciles remembered projects against the canonical registry', () => {
    const projectGroups = [
      {
        id: 'group-main',
        name: 'Main',
        isOpen: true,
        projects: [
          makeProject('project-web', 'C:/dev/app/web', 'Macro Web'),
          makeProject('project-api', 'C:/dev/app/api', 'Macro API'),
        ],
      },
    ];

    const remembered = reconcileRememberedProjects(projectGroups, [
      {
        projectId: 'project-web',
        groupId: 'old-group',
        name: 'Old Name',
        path: 'C:/dev/app/web',
        lastOpenedAt: '2026-03-14T00:00:00.000Z',
      },
      {
        projectId: 'missing-project',
        groupId: 'missing-group',
        name: 'Missing',
        path: 'C:/dev/app/missing',
        lastOpenedAt: '2026-03-14T00:00:00.000Z',
      },
    ]);

    expect(remembered).toEqual([
      {
        projectId: 'project-web',
        groupId: 'group-main',
        name: 'Macro Web',
        path: 'C:/dev/app/web',
        lastOpenedAt: '2026-03-14T00:00:00.000Z',
      },
    ]);
  });

  it('can preserve unmatched remembered projects as boot recovery hints', () => {
    const remembered = reconcileRememberedProjects(
      {
        standaloneProjects: [],
        projectGroups: [],
      },
      [
        {
          projectId: 'project-octan-sales-1780653766405',
          groupId: null,
          name: 'octan_sales',
          path: '/Users/oscarlahaie/github/octan_sales',
          lastOpenedAt: '2026-06-05T08:00:00.000Z',
        },
      ],
      { preserveUnmatched: true }
    );

    expect(remembered).toEqual([
      {
        projectId: 'project-octan-sales-1780653766405',
        groupId: null,
        name: 'octan_sales',
        path: '/Users/oscarlahaie/github/octan_sales',
        lastOpenedAt: '2026-06-05T08:00:00.000Z',
      },
    ]);
  });

  it('reconciles remembered standalone projects without a group id', () => {
    const remembered = reconcileRememberedProjects(
      {
        standaloneProjects: [makeProject('project-solo', 'C:/dev/app/solo', 'Solo')],
        projectGroups: [],
      },
      [
        {
          projectId: 'legacy-id',
          groupId: 'legacy-group',
          name: 'Old Name',
          path: 'C:/dev/app/solo',
          lastOpenedAt: '2026-03-14T00:00:00.000Z',
        },
      ]
    );

    expect(remembered).toEqual([
      {
        projectId: 'project-solo',
        groupId: null,
        name: 'Solo',
        path: 'C:/dev/app/solo',
        lastOpenedAt: '2026-03-14T00:00:00.000Z',
      },
    ]);
  });

  it('keeps Linux paths distinct inside WSL while folding Windows paths', () => {
    const result = normalizeProjectRegistry({
      standaloneProjects: [
        makeProject('upper', '//wsl$/Ubuntu/home/App'),
        makeProject('lower', '//wsl.localhost/ubuntu/home/app'),
        makeProject('duplicate', '//WSL.LOCALHOST/UBUNTU/home/App'),
        makeProject('windows', 'C:/App'),
        makeProject('windows-copy', 'c:/app'),
      ],
      projectGroups: [], selectedGroupId: null, selectedProjectId: 'lower',
    });
    expect(result.standaloneProjects.map((project) => project.id)).toEqual(['upper', 'lower', 'windows']);
    expect(result.selectedProjectId).toBe('lower');
  });

  it('requires exact IDs for homonymous projects and overlapping groups', () => {
    const group = { id: 'current', name: 'App', isOpen: true, projects: [makeProject('a', '/synthetic/a'), makeProject('c', '/synthetic/c')] };
    expect(resolveCanonicalProjectGroup([group], { id: 'old', name: 'App', projects: [makeProject('a', '/synthetic/a'), makeProject('b', '/synthetic/b')] })).toBeNull();
    expect(resolveCanonicalProject([group], { id: 'old-project', name: 'a', path: '/synthetic/old' })).toBeNull();
    expect(resolveCanonicalProjectGroup([group], group)?.id).toBe('current');
    expect(resolveCanonicalProject([group], group.projects[0])?.id).toBe('a');
  });

  it('rejects stale identifiers even when paths overlap', () => {
    const projectGroups = [
      {
        id: 'group-main',
        name: 'Main',
        isOpen: true,
        projects: [
          makeProject('project-web', 'C:/dev/app/web', 'Web'),
          makeProject('project-api', 'C:/dev/app/api', 'API'),
        ],
      },
    ];

    const resolvedGroup = resolveCanonicalProjectGroup(projectGroups, {
      id: 'group-duplicate',
      name: 'Duplicate',
      projects: [makeProject('project-web-copy', 'C:\\dev\\app\\web', 'Web Copy')],
    });
    const resolvedProject = resolveCanonicalProject(projectGroups, {
      id: 'project-web-copy',
      name: 'Web Copy',
      path: 'C:\\dev\\app\\web',
    });

    expect(resolvedGroup).toBeNull();
    expect(resolvedProject).toBeNull();
  });
});
