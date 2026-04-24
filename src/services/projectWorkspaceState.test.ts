import { describe, expect, it } from 'bun:test';
import { resolveProjectWorkspaceState } from './projectWorkspaceState';
import type { ProjectGroup } from '../types';

const makeProject = (
  id: string,
  options: { isReadOnly?: boolean } = {}
) => ({
  id,
  name: id,
  mountName: id,
  path: `/tmp/${id}`,
  created_at: '2026-04-24T00:00:00.000Z',
  status: 'active' as const,
  isReadOnly: options.isReadOnly,
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
});

const makeGroups = (): ProjectGroup[] => [
  {
    id: 'group-main',
    name: 'Main',
    isOpen: true,
    projects: [
      makeProject('project-api'),
      makeProject('project-docs', { isReadOnly: true }),
    ],
  },
];

describe('projectWorkspaceState', () => {
  it('reports noProjectAvailable when Macro has no registered subproject', () => {
    expect(
      resolveProjectWorkspaceState({
        projectGroups: [],
        selectedGroupId: null,
        selectedProjectId: null,
      }).kind
    ).toBe('noProjectAvailable');
  });

  it('reports noProjectSelected when the saved project selection is stale', () => {
    const state = resolveProjectWorkspaceState({
      projectGroups: makeGroups(),
      selectedGroupId: null,
      selectedProjectId: 'project-deleted',
    });

    expect(state.kind).toBe('noProjectSelected');
    expect(state.scopedProjectIds).toEqual([]);
  });

  it('keeps read-only scopes separate from missing workspace scopes', () => {
    const state = resolveProjectWorkspaceState({
      projectGroups: makeGroups(),
      selectedGroupId: null,
      selectedProjectId: 'project-docs',
    });

    expect(state.kind).toBe('readOnlyOnly');
    expect(state.readOnlyProjectIds).toEqual(['project-docs']);
  });

  it('reports ready when the selected scope contains an editable subproject', () => {
    const state = resolveProjectWorkspaceState({
      projectGroups: makeGroups(),
      selectedGroupId: 'group-main',
      selectedProjectId: null,
    });

    expect(state.kind).toBe('ready');
    expect(state.actionableProjectIds).toEqual(['project-api']);
    expect(state.readOnlyProjectIds).toEqual(['project-docs']);
  });
});
