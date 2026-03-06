import { describe, expect, it } from 'bun:test';
import { resolveProjectExecutionContext } from './projectExecutionContext';

describe('resolveProjectExecutionContext', () => {
  const projects = [
    {
      id: 'macro',
      name: 'Macro',
      path: 'projects/macro',
      created_at: '2026-03-05T00:00:00.000Z',
      status: 'active' as const,
      metadata: {
        description: '',
        tags: [],
        team_members: [],
        api_contracts: [],
        dependencies: [],
      },
    },
    {
      id: 'smartcards',
      name: 'Smartcards',
      path: 'C:/dev/Smartcards',
      created_at: '2026-03-05T00:00:00.000Z',
      status: 'active' as const,
      metadata: {
        description: '',
        tags: [],
        team_members: [],
        api_contracts: [],
        dependencies: [],
      },
    },
  ];

  it('uses the architect conversation project before global selection fallbacks', () => {
    const context = resolveProjectExecutionContext({
      mode: 'Architect',
      projects,
      conversations: [
        {
          id: 'conv-1',
          title: 'Architect',
          description: '',
          task_id: null,
          project_id: 'smartcards',
          last_message: '',
          message_count: 0,
          updated_at: '2026-03-05T00:00:00.000Z',
          is_unread: false,
        },
      ],
      conversationId: 'conv-1',
      selectedProjectId: 'macro',
    });

    expect(context.projectId).toBe('smartcards');
    expect(context.projectName).toBe('Smartcards');
    expect(context.workspacePath).toBe('C:/dev/Smartcards');
  });

  it('prefers the implement worktree over the project repository root', () => {
    const context = resolveProjectExecutionContext({
      mode: 'Implement',
      projects,
      tasks: [
        {
          id: 'task-1',
          project_id: 'smartcards',
          assigned_branch: 'feature/payments',
        },
      ],
      conversations: [
        {
          id: 'conv-1',
          title: 'Task',
          description: '',
          task_id: 'task-1',
          project_id: 'smartcards',
          last_message: '',
          message_count: 0,
          updated_at: '2026-03-05T00:00:00.000Z',
          is_unread: false,
        },
      ],
      conversationId: 'conv-1',
      selectedProjectId: 'smartcards',
      selectedTaskId: 'task-1',
      activeRepositoryPath: 'C:/worktrees/fallback',
      branchWorktrees: {
        'feature/payments': 'C:/worktrees/smartcards-payments',
      },
    });

    expect(context.taskId).toBe('task-1');
    expect(context.branchName).toBe('feature/payments');
    expect(context.workspacePath).toBe('C:/worktrees/smartcards-payments');
  });

  it('falls back to the selected project when conversation context is empty', () => {
    const context = resolveProjectExecutionContext({
      mode: 'Debug',
      projects,
      selectedProjectId: 'macro',
    });

    expect(context.projectId).toBe('macro');
    expect(context.workspacePath).toBe('projects/macro');
  });
});
