import { describe, expect, it } from 'bun:test';
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
    expect(result.selectedProjectId).toBe('project-web');
    expect(result.report.duplicatePathsRemoved).toBe(1);
    expect(result.report.removedSyntheticGroups).toBe(1);
    expect(result.report.removedSyntheticProjects).toBe(0);
    expect(formatProjectRegistryRepairSummary(result.report)).toContain('Macro a repare');
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

  it('resolves stale group and project identifiers back to canonical entries', () => {
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

    expect(resolvedGroup?.id).toBe('group-main');
    expect(resolvedProject?.id).toBe('project-web');
  });
});
