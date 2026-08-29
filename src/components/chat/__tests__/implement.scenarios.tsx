import { expect, it } from 'bun:test';
import { act, type ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import type {
  AppStoreState,
  MockChatState,
  TaskState,
} from '../ChatZone.test';

export type ImplementScenarioContext = {
  appState: AppStoreState;
  chatState: MockChatState;
  taskState: TaskState;
  composerEditorValue: string;
  readonly latestComposerProps: Record<string, unknown> | null;
  renderChatZone: () => ReactElement;
  requireContainer: () => HTMLDivElement;
  requireRoot: () => Root;
  setComposerText: (value: string) => Promise<HTMLTextAreaElement>;
  clickButtonWithText: (label: string) => Promise<void>;
  emitAppStore: () => void;
  emitChatStore: () => void;
  emitTaskStore: () => void;
  getConversationGoal: (conversationId: string) => unknown;
};

export const registerImplementScenarios = (context: ImplementScenarioContext) => {
  const {
    clickButtonWithText,
    renderChatZone,
    requireContainer,
    requireRoot,
    setComposerText,
  } = context;

  it('shows manual draft guidance above the composer only before the first message', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [{
        id: 'task-1',
        title: 'New feature',
        draft: true,
        task_source: 'standalone',
        standalone_kind: 'manual_feature',
        is_blocked: false,
        status: 'Pending',
        execution_targets: [{ projectId: 'project-1' }],
        project_ids: ['project-1'],
        project_id: 'project-1',
        plan_id: null,
        branch_name: '',
        dependencies: [],
        estimated_changes: [],
        description: '',
      }],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const notice = requireContainer().querySelector(
      '[data-testid="manual-draft-composer-notice"]',
    );
    const footer = requireContainer().querySelector('[data-tour-id="chat-footer"]');
    const composer = requireContainer().querySelector('[data-tour-id="chat-composer"]');
    expect(notice).not.toBeNull();
    expect(footer?.contains(notice)).toBe(false);
    const controlRow = requireContainer().querySelector('[data-tour-id="chat-control-row"]');
    expect(
      notice && controlRow
        ? Boolean(notice.compareDocumentPosition(controlRow) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false,
    ).toBe(true);
    expect(
      notice && composer
        ? Boolean(notice.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false,
    ).toBe(true);
    expect(requireContainer().querySelector('[data-chat-conversation-header]')?.contains(notice)).toBe(false);

    await act(async () => {
      context.chatState = {
        ...context.chatState,
        messages: [{
          id: 'msg-user-1',
          conversation_id: 'conv-1',
          role: 'user',
          content: 'Prépare cette fonctionnalité.',
          timestamp: '2026-08-29T00:00:00.000Z',
          task_id: 'task-1',
        }],
      };
      context.emitChatStore();
    });

    expect(requireContainer().querySelector(
      '[data-testid="manual-draft-composer-notice"]',
    )).toBeNull();
  });

  it('shows a read-only task todo dropdown in the Implement header', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'InProgress',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
          todos: [
            { id: 'todo-api', title: 'Wire checkout API', status: 'done' },
            {
              id: 'todo-tests',
              title: 'Update tests',
              description: 'Cover the checkout happy path.',
              status: 'in-progress',
            },
          ],
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const toggle = requireContainer().querySelector(
      '[data-testid="implement-task-todos-toggle"]'
    ) as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-label')).toBe('Show task checklist');
    expect(toggle?.querySelector('[data-icon="list-todo"]')).not.toBeNull();
    expect(toggle?.querySelector('[data-icon="chevron-down"]')).toBeNull();
    expect(requireContainer().textContent).toContain('Implement checkout');
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).toBeNull();

    await act(async () => {
      toggle?.click();
    });

    const dropdown = requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]');
    expect(dropdown).not.toBeNull();
    expect(dropdown?.getAttribute('role')).toBe('dialog');
    expect(dropdown?.className).toContain('max-h-');
    expect(
      dropdown?.querySelector('[data-testid="implement-task-todos-list"]')?.className
    ).toContain('overflow-y-auto');
    expect(dropdown?.textContent).toContain('1/2');
    expect(dropdown?.textContent).toContain('Wire checkout API');
    expect(dropdown?.textContent).toContain('Update tests');
    expect(dropdown?.textContent).not.toContain('Cover the checkout happy path.');
    expect(dropdown?.querySelectorAll('[data-implement-task-todo]')).toHaveLength(2);
    expect(dropdown?.querySelector('[data-todo-status-icon="done"]')).not.toBeNull();
    expect(dropdown?.querySelector('[data-todo-status-icon="in-progress"] .animate-spin')).not.toBeNull();

    await act(async () => {
      toggle?.click();
    });

    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).toBeNull();
  });

  it('closes the task todo dropdown on Escape and outside click', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'InProgress',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
          todos: [{ id: 'todo-api', title: 'Wire checkout API', status: 'pending' }],
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const toggle = requireContainer().querySelector(
      '[data-testid="implement-task-todos-toggle"]'
    ) as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle?.click();
    });
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).toBeNull();

    await act(async () => {
      toggle?.click();
    });
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).toBeNull();
  });

  it('hides the Implement header todo dropdown for tasks without stored todos', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Legacy checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'InProgress',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('Legacy checkout');
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-toggle"]')).toBeNull();
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-dropdown"]')).toBeNull();
  });

  it('hides the Implement header todo dropdown for standalone and finalization tasks', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'standalone-task',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'standalone-task',
          title: 'Standalone feature',
          draft: false,
          task_source: 'standalone',
          is_blocked: false,
          status: 'InProgress',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'manual',
          branch_name: 'feature/manual',
          dependencies: [],
          estimated_changes: [],
          description: 'Manual work.',
          todos: [{ id: 'todo-hidden', title: 'Hidden todo', status: 'pending' }],
        },
        {
          id: 'plan-finalization:plan-1',
          title: 'Finalize plan',
          draft: false,
          task_source: 'plan_finalization',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'develop',
          dependencies: [],
          estimated_changes: [],
          description: 'Merge the plan.',
          todos: [{ id: 'todo-hidden-final', title: 'Hidden final todo', status: 'pending' }],
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().querySelector('[data-testid="implement-task-todos-toggle"]')).toBeNull();

    await act(async () => {
      context.appState = { ...context.appState, selectedTaskId: 'plan-finalization:plan-1' };
      context.emitAppStore();
    });

    expect(requireContainer().textContent).toContain('Finalize plan');
    expect(requireContainer().querySelector('[data-testid="implement-task-todos-toggle"]')).toBeNull();
  });

  it('uses the bottom composer as the only kickoff input for planned tasks with an empty conversation', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('Task briefing');
    expect(requireContainer().textContent).toContain('Start execution');
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.disabled).toBe(false);
    expect(composer?.getAttribute('placeholder')).toBe('Optional guidance for this task kickoff');
    expect(requireContainer().querySelectorAll('textarea')).toHaveLength(1);
    expect(context.taskState.startTask).not.toHaveBeenCalled();
    expect(context.chatState.sendMessage).not.toHaveBeenCalled();
  });

  it('shows a locked Implement state for dependency-blocked tasks', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: true,
          blocked_by: ['Prepare checkout model'],
          status: 'Blocked',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: ['task-0'],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('Task blocked');
    expect(requireContainer().textContent).toContain('Blocked by: Prepare checkout model');
    expect(requireContainer().textContent).not.toContain('Task briefing');
    expect(requireContainer().textContent).not.toContain('Optional guidance for this task kickoff');
    expect(requireContainer().querySelector('[data-icon="lock"]')).not.toBeNull();
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.disabled).toBe(true);
    expect(composer?.getAttribute('placeholder')).toBe('Task blocked until prerequisites are completed');
    expect(context.taskState.startTask).not.toHaveBeenCalled();
    expect(context.chatState.sendMessage).not.toHaveBeenCalled();
  });

  it('routes the first planned task composer send through the kickoff flow', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    await act(async () => {
      context.composerEditorValue = 'Need to reuse checkout components.';
      const onTextChange = context.latestComposerProps?.onTextChange as
        | ((value: string) => void)
        | undefined;
      onTextChange?.(context.composerEditorValue);
    });

    const sendButton = requireContainer()
      .querySelector('span[data-icon="arrow-up"]')
      ?.closest('button') as HTMLButtonElement | null;
    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(false);

    await act(async () => {
      sendButton?.click();
    });

    expect(context.taskState.startTask).toHaveBeenCalledWith('task-1');
    expect(context.chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('DEVELOPER NOTES\nNeed to reuse checkout components.'),
      taskId: 'task-1',
    });
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer?.value).toBe('');
  });

  it('activates Goal mode during the first planned Implement task kickoff', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    await setComposerText('/goal Ship the checkout flow end to end');
    await clickButtonWithText('Start execution');

    expect(context.taskState.startTask).toHaveBeenCalledWith('task-1');
    expect(context.chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining(
        'DEVELOPER NOTES\nShip the checkout flow end to end',
      ),
      taskId: 'task-1',
    });
    expect(
      context.getConversationGoal('conv-1'),
    ).toMatchObject({
      objective: 'Ship the checkout flow end to end',
      providerId: 'provider-1',
      modelId: 'model-1',
      reasoningEffort: 'high',
      status: 'audit_pending',
    });
  });

  it('reuses the bottom composer text when clicking Start execution', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    await act(async () => {
      context.composerEditorValue = 'Focus on a minimal diff.';
      const onTextChange = context.latestComposerProps?.onTextChange as
        | ((value: string) => void)
        | undefined;
      onTextChange?.(context.composerEditorValue);
    });

    const startExecutionButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Start execution')
    );
    expect(startExecutionButton).toBeDefined();

    await act(async () => {
      startExecutionButton?.click();
    });

    expect(context.taskState.startTask).toHaveBeenCalledWith('task-1');
    expect(context.chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: expect.stringContaining('DEVELOPER NOTES\nFocus on a minimal diff.'),
      taskId: 'task-1',
    });
  });

  it('skips kickoff UI for standalone tasks with an empty conversation', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Quick export',
          draft: false,
          task_source: 'standalone',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: null,
          branch_name: 'feature/quick-export',
          dependencies: [],
          estimated_changes: [],
          description: 'Add CSV export from the table.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).not.toContain('Task briefing');
    expect(requireContainer().textContent).not.toContain('Start execution');
    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.disabled).toBe(false);
    expect(composer?.getAttribute('placeholder')).toBe('Type your message');
  });

  it('resets a newly selected standalone task to Build mode once', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      agentType: 'plan',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Quick export',
          draft: false,
          task_source: 'standalone',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: null,
          branch_name: 'feature/quick-export',
          dependencies: [],
          estimated_changes: [],
          description: 'Add CSV export from the table.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(context.appState.setAgentType).toHaveBeenCalledWith('build');
  });

  it('sends the first standalone task message directly from the composer', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Quick export',
          draft: false,
          task_source: 'standalone',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [{ projectId: 'project-1' }],
          project_ids: ['project-1'],
          project_id: 'project-1',
          plan_id: null,
          branch_name: 'feature/quick-export',
          dependencies: [],
          estimated_changes: [],
          description: 'Add CSV export from the table.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const composer = requireContainer().querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();

    await act(async () => {
      context.composerEditorValue = 'Implement the standalone feature directly.';
      const onTextChange = context.latestComposerProps?.onTextChange as
        | ((value: string) => void)
        | undefined;
      onTextChange?.(context.composerEditorValue);
    });

    const sendButton = requireContainer()
      .querySelector('span[data-icon="arrow-up"]')
      ?.closest('button') as HTMLButtonElement | null;
    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(false);

    await act(async () => {
      sendButton?.click();
    });

    expect(context.chatState.sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      content: 'Implement the standalone feature directly.',
      taskId: 'task-1',
      images: [],
    });
    expect(context.taskState.startTask).not.toHaveBeenCalled();
  });

  it('shows the focused project name instead of a multi-repository count in the kickoff summary', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-2',
      projectGroups: [
        {
          id: 'group-1',
          name: 'Platform',
          projects: [
            { id: 'project-1', name: 'Web' },
            { id: 'project-2', name: 'API' },
            { id: 'project-3', name: 'Worker' },
          ],
        },
      ],
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [
            { projectId: 'project-1' },
            { projectId: 'project-2' },
            { projectId: 'project-3' },
          ],
          project_ids: ['project-1', 'project-2', 'project-3'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('API');
    expect(requireContainer().textContent).not.toContain('3 repositories');
  });

  it('keeps a repository count in the kickoff summary when the scoped task still targets multiple repos', async () => {
    context.appState = {
      ...context.appState,
      mode: 'Implement',
      selectedTaskId: 'task-1',
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      projectGroups: [
        {
          id: 'group-1',
          name: 'Platform',
          projects: [
            { id: 'project-1', name: 'Web' },
            { id: 'project-2', name: 'API' },
            { id: 'project-3', name: 'Worker' },
          ],
        },
      ],
    };
    context.taskState = {
      ...context.taskState,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement checkout',
          draft: false,
          task_source: 'architect',
          is_blocked: false,
          status: 'Pending',
          execution_targets: [
            { projectId: 'project-1' },
            { projectId: 'project-2' },
            { projectId: 'project-3' },
          ],
          project_ids: ['project-1', 'project-2', 'project-3'],
          project_id: 'project-1',
          plan_id: 'plan-1',
          branch_name: 'feature/checkout',
          dependencies: [],
          estimated_changes: [],
          description: 'Wire the checkout flow.',
        },
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('3 repositories');
  });

};
