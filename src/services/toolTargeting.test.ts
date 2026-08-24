import { describe, expect, it } from 'bun:test';
import type { ProjectExecutionContext } from './projectExecutionContext';
import { resolveTerminalSessionProjectTarget } from './toolTargeting';

const createContext = (
  overrides: Partial<ProjectExecutionContext> = {}
): ProjectExecutionContext => ({
  groupId: 'group-1',
  groupName: 'Macro',
  projectIds: ['web', 'api'],
  actionableProjectIds: ['web'],
  contextProjectIds: ['api'],
  projectMounts: [
    {
      projectId: 'web',
      groupId: 'group-1',
      mountName: 'web',
      displayName: 'Web',
      workspacePath: '/repos/web',
      isReadOnly: false,
    },
    {
      projectId: 'api',
      groupId: 'group-1',
      mountName: 'api',
      displayName: 'API reference',
      workspacePath: '/repos/api',
      isReadOnly: true,
    },
  ],
  focusedProjectId: 'api',
  virtualRootEnabled: true,
  workspacePathsByProjectId: {
    web: '/repos/web',
    api: '/repos/api',
  },
  defaultWorkspacePath: '/repos/api',
  projectId: 'web',
  projectName: 'Web',
  taskId: 'task-1',
  branchName: 'feature/task-1',
  workspacePath: '/repos/web',
  ...overrides,
});

describe('resolveTerminalSessionProjectTarget', () => {
  it('keeps the focused read-only project instead of silently retargeting the mutation', () => {
    expect(resolveTerminalSessionProjectTarget(createContext(), null)).toEqual({
      projectId: 'api',
      readOnlyProjectLabel: 'API reference',
    });
  });

  it('lets an explicit project override the current focus', () => {
    expect(resolveTerminalSessionProjectTarget(createContext(), ' web ')).toEqual({
      projectId: 'web',
      readOnlyProjectLabel: null,
    });
  });

  it('fails closed when several actionable projects have no explicit or focused target', () => {
    const context = createContext({
      focusedProjectId: null,
      projectId: null,
      actionableProjectIds: ['web', 'api'],
    });

    expect(resolveTerminalSessionProjectTarget(context, null)).toEqual({
      projectId: null,
      readOnlyProjectLabel: null,
    });
  });
});
