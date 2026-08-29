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
  gitSetupState: 'ready' as const,
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

  it('keeps direct-edit projects actionable without exposing a Git repository path', () => {
    const gitProject = makeProject('project-git', 'C:/dev/git');
    const directProject = {
      ...makeProject('project-direct', 'C:/dev/direct'),
      directEdit: true,
      gitSetupState: 'not_git' as const,
    };
    const snapshot = buildValidProjectRegistrySnapshot({
      projectGroups: [{
        id: 'group-mixed',
        name: 'Mixed',
        isOpen: true,
        projects: [gitProject, directProject],
      }],
      selectedGroupId: 'group-mixed',
      selectedProjectId: null,
    });

    expect(snapshot.scopedProjectIds).toEqual(['project-git', 'project-direct']);
    expect(snapshot.actionableProjectIds).toEqual(['project-git', 'project-direct']);
    expect(snapshot.readOnlyProjectIds).toEqual([]);
    expect(snapshot.repoPathByProjectId.get('project-git')).toBe('C:/dev/git');
    expect(snapshot.repoPathByProjectId.has('project-direct')).toBe(false);
    expect(snapshot.executionModeByProjectId.get('project-direct')).toBe('direct');
  });

  it('distinguishes an execution-blocked project from a manually read-only project', () => {
    const blockedProject = {
      ...makeProject('project-blocked', 'C:/dev/blocked'),
      directEdit: false,
      gitSetupState: 'not_git' as const,
      isReadOnly: true,
      userReadOnly: false,
    };
    const manualProject = {
      ...makeProject('project-manual', 'C:/dev/manual'),
      isReadOnly: true,
      userReadOnly: true,
    };

    const snapshot = buildValidProjectRegistrySnapshot({
      projectGroups: [{
        id: 'group-read-only',
        name: 'Read only',
        isOpen: true,
        projects: [blockedProject, manualProject],
      }],
      selectedGroupId: 'group-read-only',
      selectedProjectId: null,
    });

    expect(snapshot.readOnlyProjectIdSet.has('project-blocked')).toBe(true);
    expect(snapshot.manualReadOnlyProjectIdSet?.has('project-blocked')).toBe(false);
    expect(snapshot.manualReadOnlyProjectIdSet?.has('project-manual')).toBe(true);
  });
});
