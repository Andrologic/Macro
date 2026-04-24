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
      },
      {
        projectId: 'macro-api',
        groupId: 'macro-suite',
        mountName: 'api',
        displayName: 'Macro API',
        workspacePath: 'C:/dev/macro-api',
        isReadOnly: false,
      },
    ]);
    expect(context.workspacePathsByProjectId['macro-web']).toBe('projects/macro-web');
    expect(context.workspacePathsByProjectId['macro-api']).toBe('C:/dev/macro-api');
  });

  it('prefers task worktrees for targeted subprojects in implement mode', async () => {
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
              branchName: 'feature/payments',
              worktreeKey: 'macro-api::feature/payments',
            },
            {
              projectId: 'macro-web',
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
      },
    ]);
    expect(context.defaultWorkspacePath).toBe('projects/macro-web');
  });

  it('returns an empty execution context in chat mode even when a project is selected', async () => {
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

    expect(context).toEqual({
      groupId: null,
      groupName: null,
      projectIds: [],
      actionableProjectIds: [],
      contextProjectIds: [],
      projectMounts: [],
      focusedProjectId: null,
      virtualRootEnabled: false,
      workspacePathsByProjectId: {},
      defaultWorkspacePath: null,
      projectId: null,
      projectName: null,
      taskId: null,
      branchName: null,
      workspacePath: null,
    });
  });

  it('falls back to the primary subproject of the selected global project when no focus repo is set', async () => {
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
