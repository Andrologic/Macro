import { describe, expect, it } from 'bun:test';
import type { Project, ProjectGroup } from '../../types';
import type { ArchitectPlanSummary } from '../../services/architectPlanService';
import type { ArchitectPlanCatalogBranch } from '../../services/macroProjectMetadataLoader';
import {
  buildArchitectNavigatorPlanEntries,
  buildArchitectNavigatorScopes,
  filterArchitectPlanEntriesByQuery,
  sanitizeArchitectNavigatorIds,
  toggleArchitectNavigatorScope,
} from './architectProjectNavigatorModel';

const project = (id: string, name = id): Project => ({ id, name } as Project);
const plan = (params: Partial<ArchitectPlanSummary> & Pick<ArchitectPlanSummary, 'id'>): ArchitectPlanSummary => ({
  slug: params.id,
  title: params.id,
  description: '',
  status: 'draft',
  targetBranch: 'develop',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  nodeCount: 0,
  ...params,
});

describe('architect project navigator model', () => {
  it('keeps project groups and standalone projects at one navigation level', () => {
    const projectGroups = [{
      id: 'group-1',
      name: 'Macro',
      isOpen: true,
      projects: [project('a'), project('b')],
    }] satisfies ProjectGroup[];

    expect(buildArchitectNavigatorScopes({
      projectGroups,
      standaloneProjects: [project('c', 'Standalone')],
    })).toMatchObject([
      { id: 'group:group-1', label: 'Macro', projectIds: ['a', 'b'] },
      { id: 'project:c', label: 'Standalone', projectIds: ['c'] },
    ]);
  });

  it('shows a multi-project plan once under its canonical group', () => {
    const scopes = buildArchitectNavigatorScopes({
      projectGroups: [{
        id: 'group-1',
        name: 'Macro',
        isOpen: true,
        projects: [project('a'), project('b')],
      }],
      standaloneProjects: [project('c')],
    });
    const branches: ArchitectPlanCatalogBranch[] = [{
      branchName: 'develop',
      activePlanId: null,
      error: null,
      plans: [plan({ id: 'shared', projectIds: ['a', 'b'] })],
    }];

    expect(buildArchitectNavigatorPlanEntries({ branches, scopes })).toMatchObject([
      { scopeId: 'group:group-1', projectCount: 2, branchName: 'develop' },
    ]);
  });

  it('keeps identical plan ids on separate branches addressable by locator', () => {
    const scopes = buildArchitectNavigatorScopes({
      projectGroups: [],
      standaloneProjects: [project('a')],
    });
    const branches: ArchitectPlanCatalogBranch[] = [
      {
        branchName: 'develop',
        activePlanId: null,
        error: null,
        plans: [plan({ id: 'same', projectId: 'a', updatedAt: '2026-08-01T00:00:00.000Z' })],
      },
      {
        branchName: 'release/next',
        activePlanId: null,
        error: null,
        plans: [plan({ id: 'same', projectId: 'a', title: 'Newest', updatedAt: '2026-08-02T00:00:00.000Z' })],
      },
    ];

    const entries = buildArchitectNavigatorPlanEntries({ branches, scopes });
    expect(entries.map((entry) => [entry.branchName, entry.plan.id])).toEqual([
      ['release/next', 'same'],
      ['develop', 'same'],
    ]);
    expect(new Set(entries.map((entry) => entry.locatorKey)).size).toBe(2);
  });

  it('sanitizes persisted ids against the current registry', () => {
    expect(sanitizeArchitectNavigatorIds(
      ['group:one', '', 'group:one', 12, 'project:gone'],
      new Set(['group:one']),
    )).toEqual(['group:one']);
  });

  it('toggles the same project row open and closed', () => {
    expect(toggleArchitectNavigatorScope([], 'project:macro')).toEqual(['project:macro']);
    expect(toggleArchitectNavigatorScope(['project:macro'], 'project:macro')).toEqual([]);
  });

  it('filters plan titles without case or accent sensitivity and preserves their order', () => {
    const scopes = buildArchitectNavigatorScopes({
      projectGroups: [],
      standaloneProjects: [project('a')],
    });
    const entries = buildArchitectNavigatorPlanEntries({
      scopes,
      branches: [{
        branchName: 'develop',
        activePlanId: null,
        error: null,
        plans: [
          plan({ id: 'first', title: 'Préparer le déploiement', projectId: 'a', updatedAt: '2026-08-03T00:00:00.000Z' }),
          plan({ id: 'second', title: 'Réparer la navigation', projectId: 'a', updatedAt: '2026-08-02T00:00:00.000Z' }),
        ],
      }],
    });

    expect(filterArchitectPlanEntriesByQuery(entries, 'DEPLOIEMENT').map((entry) => entry.plan.id)).toEqual(['first']);
    expect(filterArchitectPlanEntriesByQuery(entries, '').map((entry) => entry.plan.id)).toEqual(['first', 'second']);
    expect(filterArchitectPlanEntriesByQuery(entries, 'conversation')).toEqual([]);
  });
});
