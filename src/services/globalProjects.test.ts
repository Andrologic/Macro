import { describe, expect, it } from 'bun:test';
import {
  getFocusedProjectIdForGroup,
  getRepositoryScopedProjectIds,
  getScopedArchitectContextProjectIds,
  getScopedGitActionableProjectIds,
  getScopedProjectIds,
  isProjectActionable,
  isProjectGitActionable,
  resolveExplicitProjectIdForGroup,
} from './globalProjects';

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

describe('globalProjects', () => {
  it('keeps the explicit group scope unfocused when no project was chosen', () => {
    expect(resolveExplicitProjectIdForGroup(projectGroups, 'group-main', null)).toBeNull();
  });

  it('still falls back to the first project when a view needs a concrete focus', () => {
    expect(getFocusedProjectIdForGroup(projectGroups, 'group-main', null)).toBe('project-web');
  });

  it('returns every project in the group for repository panels when no project is focused', () => {
    expect(getRepositoryScopedProjectIds(projectGroups, 'group-main', null)).toEqual([
      'project-web',
      'project-api',
    ]);
  });

  it('narrows repository panels to the focused project when it belongs to the group', () => {
    expect(getRepositoryScopedProjectIds(projectGroups, 'group-main', 'project-api')).toEqual([
      'project-api',
    ]);
  });

  it('falls back to the focused project when no group is selected', () => {
    expect(getRepositoryScopedProjectIds(projectGroups, null, 'project-web')).toEqual([
      'project-web',
    ]);
  });

  it('scopes a standalone project without a group to only that project', () => {
    expect(
      getScopedProjectIds(
        {
          standaloneProjects: [makeProject('project-solo', 'C:/dev/app/solo', 'Solo')],
          projectGroups,
        },
        null,
        'project-solo'
      )
    ).toEqual(['project-solo']);
  });

  it('ignores an out-of-group focused project for repository panels and keeps the group scope', () => {
    expect(getRepositoryScopedProjectIds(projectGroups, 'group-main', 'project-other')).toEqual([
      'project-web',
      'project-api',
    ]);
  });

  it('keeps direct-edit projects writable in Implement but context-only in Architect', () => {
    const directProject = {
      ...makeProject('project-direct', 'C:/dev/app/direct', 'Direct'),
      isReadOnly: false,
      directEdit: true,
      gitSetupState: 'not_git' as const,
    };
    const gitProject = {
      ...makeProject('project-git', 'C:/dev/app/git', 'Git'),
      isReadOnly: false,
      directEdit: false,
      gitSetupState: 'ready' as const,
    };
    const registry = {
      standaloneProjects: [],
      projectGroups: [{
        id: 'group-direct',
        name: 'Direct and Git',
        isOpen: true,
        projects: [directProject, gitProject],
      }],
    };

    expect(isProjectActionable(directProject)).toBe(true);
    expect(isProjectGitActionable(directProject)).toBe(false);
    expect(getScopedGitActionableProjectIds(registry, 'group-direct', null)).toEqual(['project-git']);
    expect(getScopedArchitectContextProjectIds(registry, 'group-direct', null)).toEqual(['project-direct']);
  });
});
