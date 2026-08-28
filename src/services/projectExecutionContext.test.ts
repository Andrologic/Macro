import { beforeEach, describe, expect, it, mock } from 'bun:test';

let importCounter = 0;

const loadProjectExecutionContext = async () => {
  mock.restore();
  importCounter += 1;
  return import(`./projectExecutionContext.ts?project-execution-context=${importCounter}`);
};

describe('resolveProjectExecutionContext', () => {
  const projects = [
    {
      id: 'macro-web',
      name: 'Macro Web',
      mountName: 'web',
      path: 'projects/macro-web',
      created_at: '2026-03-05T00:00:00.000Z',
      status: 'active' as const,
      userReadOnly: false,
      gitSetupState: 'ready' as const,
      isReadOnly: false,
      readOnlyReason: null,
      metadata: {
        description: '',
        tags: [],
        team_members: [],
        api_contracts: [],
        dependencies: [],
      },
    },
    {
      id: 'macro-api',
      name: 'Macro API',
      mountName: 'api',
      path: 'C:/dev/macro-api',
      created_at: '2026-03-05T00:00:00.000Z',
      status: 'active' as const,
      userReadOnly: false,
      gitSetupState: 'ready' as const,
      isReadOnly: false,
      readOnlyReason: null,
      metadata: {
        description: '',
        tags: [],
        team_members: [],
        api_contracts: [],
        dependencies: [],
      },
    },
  ];

  const projectGroups = [
    {
      id: 'macro-suite',
      name: 'Macro Suite',
      isOpen: true,
      projects,
    },
  ];

  beforeEach(() => {
    mock.restore();
  });

  it('uses the architect conversation group as the primary scope', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const context = resolveProjectExecutionContext({
      mode: 'Architect',
      projects,
      projectGroups,
      conversations: [
        {
          id: 'conv-1',
          title: 'Architect',
          description: '',
          scope_mode: 'Architect',
          task_id: null,
          group_id: 'macro-suite',
          project_id: 'macro-api',
          last_message: '',
          message_count: 0,
          updated_at: '2026-03-05T00:00:00.000Z',
          is_unread: false,
        },
      ],
      conversationId: 'conv-1',
      selectedGroupId: 'macro-suite',
      selectedProjectId: null,
    });

    expect(context.groupId).toBe('macro-suite');
    expect(context.groupName).toBe('Macro Suite');
    expect(context.projectId).toBe('macro-api');
    expect(context.projectIds).toEqual(['macro-web', 'macro-api']);
    expect(context.actionableProjectIds).toEqual(['macro-web', 'macro-api']);
    expect(context.contextProjectIds).toEqual([]);
    expect(context.focusedProjectId).toBe('macro-api');
    expect(context.virtualRootEnabled).toBe(true);
    expect(context.projectMounts).toEqual([
      {
        projectId: 'macro-web',
        groupId: 'macro-suite',
        mountName: 'web',
        displayName: 'Macro Web',
        workspacePath: 'projects/macro-web',
        isReadOnly: false,
        executionMode: 'git',
        executionModeReason: 'git_ready',
      },
      {
        projectId: 'macro-api',
        groupId: 'macro-suite',
        mountName: 'api',
        displayName: 'Macro API',
        workspacePath: 'C:/dev/macro-api',
        isReadOnly: false,
        executionMode: 'git',
        executionModeReason: 'git_ready',
      },
    ]);
    expect(context.workspacePathsByProjectId['macro-web']).toBe('projects/macro-web');
    expect(context.workspacePathsByProjectId['macro-api']).toBe('C:/dev/macro-api');
  });

  it('uses a selected standalone project as a ready single-project scope', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const standaloneProject = {
      ...projects[0],
      id: 'solo-app',
      name: 'Solo App',
      mountName: 'solo-app',
      path: '/repos/solo-app',
    };
    const context = resolveProjectExecutionContext({
      mode: 'Architect',
      projects: [standaloneProject],
      projectGroups: [],
      selectedGroupId: null,
      selectedProjectId: 'solo-app',
    });

    expect(context.groupId).toBeNull();
    expect(context.groupName).toBeNull();
    expect(context.projectId).toBe('solo-app');
    expect(context.projectIds).toEqual(['solo-app']);
    expect(context.actionableProjectIds).toEqual(['solo-app']);
    expect(context.focusedProjectId).toBe('solo-app');
    expect(context.virtualRootEnabled).toBe(false);
    expect(context.projectMounts).toEqual([
      {
        projectId: 'solo-app',
        groupId: null,
        mountName: 'solo-app',
        displayName: 'Solo App',
        workspacePath: '/repos/solo-app',
        isReadOnly: false,
        executionMode: 'git',
        executionModeReason: 'git_ready',
      },
    ]);
    expect(context.workspacePath).toBe('/repos/solo-app');
  });

  it('retargets a stale single-project task to the selected standalone project', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const standaloneProject = {
      ...projects[0],
      id: 'project-lplr-current',
      name: 'lplr-app',
      mountName: 'lplr-app',
      path: '/repos/lplr-app',
    };
    const context = resolveProjectExecutionContext({
      mode: 'Implement',
      projects: [standaloneProject],
      projectGroups: [],
      tasks: [
        {
          id: 'task-stale',
          project_id: 'project-lplr-app-1780237886690',
          project_ids: ['project-lplr-app-1780237886690'],
          assigned_branch: 'feature/catalogue',
          execution_targets: [
            {
              projectId: 'project-lplr-app-1780237886690',
              executionMode: 'git',
              branchName: 'feature/catalogue',
              worktreeKey: 'stale-worktree',
            },
          ],
        },
      ],
      selectedGroupId: null,
      selectedProjectId: 'project-lplr-current',
      selectedTaskId: 'task-stale',
    });

    expect(context.projectId).toBe('project-lplr-current');
    expect(context.projectIds).toEqual(['project-lplr-current']);
    expect(context.actionableProjectIds).toEqual(['project-lplr-current']);
    expect(context.workspacePath).toBe('/repos/lplr-app');
  });

  it('prefers the current registry path over stale task repoPath snapshots', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const standaloneProject = {
      ...projects[0],
      id: 'project-lplr-app-1780329499166',
      name: 'octan_sales',
      mountName: 'octan_sales',
      path: '/repos/octan_sales',
    };
    const context = resolveProjectExecutionContext({
      mode: 'Implement',
      projects: [standaloneProject],
      projectGroups: [],
      tasks: [
        {
          id: 'task-renamed',
          project_id: 'project-lplr-app-1780329499166',
          project_ids: ['project-lplr-app-1780329499166'],
          assigned_branch: 'feature/catalogue',
          execution_targets: [
            {
              projectId: 'project-lplr-app-1780329499166',
              executionMode: 'git',
              branchName: 'feature/catalogue',
              worktreeKey: 'branch-project-lplr-app-feature-catalogue',
              repoPath: '/repos/lplr-app',
            },
          ],
        },
      ],
      selectedGroupId: null,
      selectedProjectId: 'project-lplr-app-1780329499166',
      selectedTaskId: 'task-renamed',
    });

    expect(context.projectId).toBe('project-lplr-app-1780329499166');
    expect(context.workspacePath).toBe('/repos/octan_sales');
    expect(context.workspacePathsByProjectId).toEqual({
      'project-lplr-app-1780329499166': '/repos/octan_sales',
    });
  });

  it('does not expose a truly unknown task project without a valid fallback', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const context = resolveProjectExecutionContext({
      mode: 'Implement',
      projects: [projects[0]],
      projectGroups: [],
      tasks: [
        {
          id: 'task-unknown',
          project_id: 'missing-project',
          project_ids: ['missing-project'],
          assigned_branch: 'feature/missing',
        },
      ],
      selectedGroupId: null,
      selectedProjectId: null,
      selectedTaskId: 'task-unknown',
    });

    expect(context.projectId).toBeNull();
    expect(context.projectIds).toEqual([]);
    expect(context.workspacePath).toBeNull();
  });

  it('keeps a confirmed non-Git project read-only when direct editing is disabled', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const blockedProject = {
      ...projects[0],
      gitSetupState: 'not_git' as const,
      directEdit: false,
      isReadOnly: true,
    };
    const context = resolveProjectExecutionContext({
      mode: 'Implement',
      projects: [blockedProject],
      projectGroups: [],
      selectedProjectId: blockedProject.id,
    });

    expect(context.actionableProjectIds).toEqual([]);
    expect(context.contextProjectIds).toEqual([blockedProject.id]);
    expect(context.projectMounts[0]).toMatchObject({
      projectId: blockedProject.id,
      isReadOnly: true,
      executionMode: 'blocked',
    });
  });

  it('prefers task worktrees for targeted projects in implement mode', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const context = resolveProjectExecutionContext({
      mode: 'Implement',
      projects,
      projectGroups,
      tasks: [
        {
          id: 'task-1',
          project_id: 'macro-api',
          project_ids: ['macro-api', 'macro-web'],
          assigned_branch: 'feature/payments',
          execution_targets: [
            {
              projectId: 'macro-api',
              executionMode: 'git',
              branchName: 'feature/payments',
              worktreeKey: 'macro-api::feature/payments',
            },
            {
              projectId: 'macro-web',
              executionMode: 'git',
              branchName: 'feature/payments',
              worktreeKey: 'macro-web::feature/payments',
            },
          ],
        },
      ],
      conversations: [
        {
          id: 'conv-1',
          title: 'Task',
          description: '',
          task_id: 'task-1',
          group_id: 'macro-suite',
          project_id: 'macro-api',
          last_message: '',
          message_count: 0,
          updated_at: '2026-03-05T00:00:00.000Z',
          is_unread: false,
        },
      ],
      conversationId: 'conv-1',
      selectedGroupId: 'macro-suite',
      selectedTaskId: 'task-1',
      activeRepositoryPath: 'C:/worktrees/fallback',
      branchWorktrees: {
        'macro-api::feature/payments': 'C:/worktrees/macro-api-payments',
        'macro-web::feature/payments': 'C:/worktrees/macro-web-payments',
      },
    });

    expect(context.taskId).toBe('task-1');
    expect(context.projectId).toBe('macro-api');
    expect(context.focusedProjectId).toBe('macro-api');
    expect(context.virtualRootEnabled).toBe(true);
    expect(context.branchName).toBe('feature/payments');
    expect(context.actionableProjectIds).toEqual(['macro-api', 'macro-web']);
    expect(context.contextProjectIds).toEqual([]);
    expect(context.workspacePath).toBe('C:/worktrees/macro-api-payments');
    expect(context.workspacePathsByProjectId).toEqual({
      'macro-api': 'C:/worktrees/macro-api-payments',
      'macro-web': 'C:/worktrees/macro-web-payments',
    });
  });

  it('uses explicit workspace overrides ahead of task worktrees during merge workflows', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const context = resolveProjectExecutionContext({
      mode: 'Implement',
      projects,
      projectGroups,
      tasks: [
        {
          id: 'task-1',
          project_id: 'macro-api',
          project_ids: ['macro-api', 'macro-web'],
          assigned_branch: 'feature/payments',
          execution_targets: [
            {
              projectId: 'macro-api',
              executionMode: 'git',
              branchName: 'feature/payments',
              worktreeKey: 'macro-api::feature/payments',
            },
            {
              projectId: 'macro-web',
              executionMode: 'git',
              branchName: 'feature/payments',
              worktreeKey: 'macro-web::feature/payments',
            },
          ],
        },
      ],
      selectedGroupId: 'macro-suite',
      selectedProjectId: 'macro-api',
      selectedTaskId: 'task-1',
      activeRepositoryPath: 'C:/dev/macro-api',
      workspacePathOverridesByProjectId: {
        'macro-api': 'C:/dev/macro-api',
        'macro-web': 'projects/macro-web',
      },
      branchWorktrees: {
        'macro-api::feature/payments': 'C:/worktrees/macro-api-payments',
        'macro-web::feature/payments': 'C:/worktrees/macro-web-payments',
      },
    });

    expect(context.taskId).toBe('task-1');
    expect(context.workspacePath).toBe('C:/dev/macro-api');
    expect(context.workspacePathsByProjectId).toEqual({
      'macro-api': 'C:/dev/macro-api',
      'macro-web': 'projects/macro-web',
    });
    expect(context.projectMounts).toEqual([
      {
        projectId: 'macro-web',
        groupId: 'macro-suite',
        mountName: 'web',
        displayName: 'Macro Web',
        workspacePath: 'projects/macro-web',
        isReadOnly: false,
        executionMode: 'git',
        executionModeReason: 'persisted_git_target',
      },
      {
        projectId: 'macro-api',
        groupId: 'macro-suite',
        mountName: 'api',
        displayName: 'Macro API',
        workspacePath: 'C:/dev/macro-api',
        isReadOnly: false,
        executionMode: 'git',
        executionModeReason: 'persisted_git_target',
      },
    ]);
  });

  it('keeps writable context-only task repos readable but non-actionable', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const context = resolveProjectExecutionContext({
      mode: 'Implement',
      projects,
      projectGroups,
      tasks: [
        {
          id: 'task-1',
          project_id: 'macro-api',
          project_ids: ['macro-api'],
          context_project_ids: ['macro-web'],
          assigned_branch: 'feature/payments',
          execution_targets: [
            {
              projectId: 'macro-api',
              executionMode: 'git',
              branchName: 'feature/payments',
              worktreeKey: 'macro-api::feature/payments',
            },
          ],
        },
      ],
      selectedGroupId: 'macro-suite',
      selectedTaskId: 'task-1',
      branchWorktrees: {
        'macro-api::feature/payments': 'C:/worktrees/macro-api-payments',
      },
    });

    expect(context.projectIds).toEqual(['macro-api', 'macro-web']);
    expect(context.actionableProjectIds).toEqual(['macro-api']);
    expect(context.contextProjectIds).toEqual(['macro-web']);
    expect(context.workspacePathsByProjectId).toEqual({
      'macro-api': 'C:/worktrees/macro-api-payments',
      'macro-web': 'projects/macro-web',
    });
    expect(context.projectMounts.find((mount: { projectId: string }) => mount.projectId === 'macro-web')?.isReadOnly).toBe(true);
  });

  it('falls back to the selected project when an implement conversation has no task scope', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const context = resolveProjectExecutionContext({
      mode: 'Implement',
      projects,
      selectedProjectId: 'macro-web',
    });

    expect(context.groupId).toBeNull();
    expect(context.projectId).toBe('macro-web');
    expect(context.focusedProjectId).toBe('macro-web');
    expect(context.virtualRootEnabled).toBe(false);
    expect(context.actionableProjectIds).toEqual(['macro-web']);
    expect(context.contextProjectIds).toEqual([]);
    expect(context.projectMounts).toEqual([
      {
        projectId: 'macro-web',
        groupId: null,
        mountName: 'web',
        displayName: 'Macro Web',
        workspacePath: 'projects/macro-web',
        isReadOnly: false,
        executionMode: 'git',
        executionModeReason: 'git_ready',
      },
    ]);
    expect(context.defaultWorkspacePath).toBe('projects/macro-web');
  });

  it('uses durable conversation scope in chat mode and ignores global project selection', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const context = resolveProjectExecutionContext({
      mode: 'Chat',
      projects,
      projectGroups,
      selectedGroupId: 'macro-suite',
      selectedProjectId: 'macro-api',
      selectedTaskId: 'task-1',
      conversations: [
        {
          id: 'conv-1',
          title: 'Chat',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: 'macro-suite',
          project_id: 'macro-api',
          last_message: '',
          message_count: 0,
          updated_at: '2026-03-05T00:00:00.000Z',
          is_unread: false,
        },
      ],
      conversationId: 'conv-1',
    });

    expect(context).toEqual({
      groupId: 'macro-suite',
      groupName: 'Macro Suite',
      projectIds: ['macro-web', 'macro-api'],
      actionableProjectIds: ['macro-web', 'macro-api'],
      contextProjectIds: [],
      projectMounts: [
        {
          projectId: 'macro-web',
          groupId: 'macro-suite',
          mountName: 'web',
          displayName: 'Macro Web',
          workspacePath: 'projects/macro-web',
          isReadOnly: false,
          executionMode: 'git',
          executionModeReason: 'git_ready',
        },
        {
          projectId: 'macro-api',
          groupId: 'macro-suite',
          mountName: 'api',
          displayName: 'Macro API',
          workspacePath: 'C:/dev/macro-api',
          isReadOnly: false,
          executionMode: 'git',
          executionModeReason: 'git_ready',
        },
      ],
      focusedProjectId: 'macro-api',
      virtualRootEnabled: true,
      workspacePathsByProjectId: {
        'macro-web': 'projects/macro-web',
        'macro-api': 'C:/dev/macro-api',
      },
      defaultWorkspacePath: 'C:/dev/macro-api',
      projectId: 'macro-api',
      projectName: 'Macro API',
      taskId: null,
      branchName: null,
      workspacePath: 'C:/dev/macro-api',
    });
  });

  it('keeps an unscoped chat detached even when a project is selected globally', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const context = resolveProjectExecutionContext({
      mode: 'Chat',
      projects,
      projectGroups,
      selectedGroupId: 'macro-suite',
      selectedProjectId: 'macro-api',
      conversations: [
        {
          id: 'conv-1',
          title: 'Chat',
          description: '',
          scope_mode: 'Chat',
          task_id: null,
          group_id: null,
          project_id: null,
          last_message: '',
          message_count: 0,
          updated_at: '2026-03-05T00:00:00.000Z',
          is_unread: false,
        },
      ],
      conversationId: 'conv-1',
    });

    expect(context.projectIds).toEqual([]);
    expect(context.projectId).toBeNull();
    expect(context.workspacePath).toBeNull();
  });

  it('falls back to the primary project of the selected group when no focus repo is set', async () => {
    const { resolveProjectExecutionContext } = await loadProjectExecutionContext();
    const context = resolveProjectExecutionContext({
      mode: 'Architect',
      projects,
      projectGroups,
      selectedGroupId: 'macro-suite',
      selectedProjectId: null,
    });

    expect(context.groupId).toBe('macro-suite');
    expect(context.projectId).toBe('macro-web');
    expect(context.focusedProjectId).toBe('macro-web');
    expect(context.virtualRootEnabled).toBe(true);
    expect(context.actionableProjectIds).toEqual(['macro-web', 'macro-api']);
    expect(context.contextProjectIds).toEqual([]);
    expect(context.defaultWorkspacePath).toBe('projects/macro-web');
  });
});
