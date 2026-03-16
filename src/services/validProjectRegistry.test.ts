import { describe, expect, it } from 'bun:test';
import {
  buildValidProjectRegistrySnapshot,
  isSyntheticProjectId,
  normalizeProjectRegistryPath,
} from './validProjectRegistry';

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

describe('validProjectRegistry', () => {
  it('normalizes registry paths and recognizes synthetic project ids', () => {
    expect(normalizeProjectRegistryPath('C:\\dev\\macro\\')).toBe('C:/dev/macro');
    expect(normalizeProjectRegistryPath('   ')).toBeNull();
    expect(isSyntheticProjectId('session-project-123')).toBe(true);
    expect(isSyntheticProjectId('project-web')).toBe(false);
  });

  it('keeps only canonical registered project ids with concrete repository paths', () => {
    const snapshot = buildValidProjectRegistrySnapshot({
      projectGroups: [
        {
          id: 'group-main',
          name: 'Main',
          isOpen: true,
          projects: [
            makeProject('project-web', 'C:/dev/macro/web'),
            makeProject('project-api', 'C:\\dev\\macro\\api\\'),
            makeProject('session-project-1', 'C:/temp/session'),
            makeProject('project-empty', '   '),
            makeProject('project-web', 'C:/dev/macro/web-duplicate'),
          ],
        },
      ],
      selectedGroupId: 'group-main',
      selectedProjectId: 'session-project-1',
    });

    expect(snapshot.validProjectIds).toEqual(['project-web', 'project-api']);
    expect(snapshot.scopedProjectIds).toEqual(['project-web', 'project-api']);
    expect(snapshot.selectedProjectId).toBe('session-project-1');
    expect(snapshot.validProjectIdSet.has('session-project-1')).toBe(false);
    expect(snapshot.repoPathByProjectId.get('project-api')).toBe('C:/dev/macro/api');
    expect(snapshot.hasRegisteredProjects).toBe(true);
  });
});
