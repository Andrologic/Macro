import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { useNotificationCenterStore } from '../../stores/useNotificationCenterStore';
import { openWorkflowNotificationContext } from '../../services/openWorkflowNotificationContext';
import type { TFunction } from 'i18next';
import type { ChatMessage, Conversation, PendingToolApproval } from '../../types';
import type { CatalogedImplementTask } from '../../services/implementTaskCatalog';

type StoreListener<T> = (nextState: T, previousState: T) => void;

interface TestAppState {
  mode: 'Architect' | 'Implement' | 'Chat';
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  standaloneProjects: Array<{ id: string }>;
  projectGroups: Array<{ id: string; projects: Array<{ id: string }> }>;
  setMode: ReturnType<typeof mock>;
  setSelectedGroup: ReturnType<typeof mock>;
  setSelectedTask: ReturnType<typeof mock>;
  switchProjectContext: ReturnType<typeof mock>;
  loadMacroProjectMetadataForSelection: ReturnType<typeof mock>;
  activateArchitectPlan: ReturnType<typeof mock>;
}

interface TestChatState {
  hydrationStatus?: 'idle' | 'hydrating' | 'ready';
  messageLoadStatusByConversationId?: Record<string, 'ready'>;
  messages: ChatMessage[];
  messagesByConversationId: Record<string, ChatMessage[]>;
  conversations: Conversation[];
  questionnaireDraftsByConversationId: Record<string, never>;
  pendingToolApprovalByConversationId: Record<string, PendingToolApproval | undefined>;
  selectedConversationId: string | null;
  selectConversation: ReturnType<typeof mock>;
  ensureConversationForCurrentMode: ReturnType<typeof mock>;
}

interface TestTaskState {
  isLoading?: boolean;
  tasks: CatalogedImplementTask[];
}

interface CapturedNotificationOptions {
  category: string;
  notificationKey: string;
  actions: Array<{ onClick: () => void | Promise<void> }>;
}

let appState: TestAppState;
let chatState: TestChatState;
let taskState: TestTaskState;
let navigationCalls: string[];
const chatListeners = new Set<StoreListener<TestChatState>>();
const taskListeners = new Set<StoreListener<TestTaskState>>();
const notifyActionRequired = mock(
  (_title: string, _options: CapturedNotificationOptions) => undefined,
);

const useAppStore = Object.assign(() => appState, {
  getState: () => appState,
});
const useChatStore = Object.assign(() => chatState, {
  getState: () => chatState,
  subscribe: (listener: StoreListener<TestChatState>) => {
    chatListeners.add(listener);
    return () => chatListeners.delete(listener);
  },
});
const useTaskStore = Object.assign(() => taskState, {
  getState: () => taskState,
  subscribe: (listener: StoreListener<TestTaskState>) => {
    taskListeners.add(listener);
    return () => taskListeners.delete(listener);
  },
});

mock.module('../../stores/useAppStore', () => ({ useAppStore }));
mock.module('../../stores/useChatStore', () => ({ useChatStore }));
mock.module('../../stores/useTaskStore', () => ({ useTaskStore }));
mock.module('../ui/toastService', () => ({
  notify: { actionRequired: notifyActionRequired, dismiss: mock(() => undefined) },
}));

const {
  subscribeToWorkflowAttentionNotifications,
  reconcileWorkflowAttentionNotifications,
} = await import('./WorkflowAttentionNotifications');

const t = ((key: string, fallback?: string, values?: Record<string, string>) => {
  let result = fallback ?? key;
  for (const [name, value] of Object.entries(values ?? {})) {
    result = result.replace(`{{${name}}}`, value);
  }
  return result;
}) as unknown as TFunction;

const makeConversation = (
  overrides: Partial<Conversation> = {},
): Conversation => ({
  id: 'conversation-1',
  title: 'Background conversation',
  scope_mode: 'Implement',
  task_id: 'task-1',
  group_id: 'group-1',
  project_id: 'project-1',
  last_message: '',
  message_count: 0,
  updated_at: '2026-09-04T10:00:00.000Z',
  is_unread: false,
  ...overrides,
});

const makeQuestionnaire = (conversation: Conversation): ChatMessage => ({
  id: 'question-1',
  task_id: conversation.task_id ?? '',
  conversation_id: conversation.id,
  role: 'assistant',
  content: 'Choose a scope.',
  timestamp: '2026-09-04T10:01:00.000Z',
  questionnaire: {
    questions: [
      {
        id: 'scope',
        prompt: 'Which scope?',
        choices: ['Small', 'Medium', 'Large'],
      },
    ],
  },
});

const makeApproval = (conversation: Conversation): PendingToolApproval => ({
  conversationId: conversation.id,
  assistantMessageId: 'assistant-1',
  toolCallId: 'tool-call-1',
  toolId: 'apply_patch',
  actionGroup: 'change',
  riskLevel: 'balanced',
  summary: 'Modify the workspace',
  rememberKey: 'change:workspace',
});

const makeTask = (status: CatalogedImplementTask['status']): CatalogedImplementTask =>
  ({
    id: 'task-1',
    title: 'Notification task',
    status,
    conversation_id: 'conversation-1',
  }) as CatalogedImplementTask;

const updateChatState = (patch: Partial<TestChatState>) => {
  const previousState = chatState;
  chatState = { ...chatState, ...patch };
  chatListeners.forEach((listener) => listener(chatState, previousState));
};

const updateTaskState = (tasks: CatalogedImplementTask[]) => {
  const previousState = taskState;
  taskState = { tasks };
  taskListeners.forEach((listener) => listener(taskState, previousState));
};

beforeEach(() => {
  useNotificationCenterStore.setState({ items: [] });
  chatListeners.clear();
  taskListeners.clear();
  notifyActionRequired.mockClear();
  navigationCalls = [];
  appState = {
    mode: 'Chat',
    selectedGroupId: 'group-current',
    selectedTaskId: null,
    selectedProjectId: 'project-current',
    standaloneProjects: [{ id: 'project-other' }, { id: 'project-current' }],
    projectGroups: [{ id: 'group-other', projects: [{ id: 'project-current' }] }],
    setMode: mock((mode: TestAppState['mode'], _options?: { ensureAutoPlan?: boolean }) => {
      navigationCalls.push('setMode');
      appState.mode = mode;
    }),
    setSelectedGroup: mock((
      groupId: string | null,
      _options?: { restoreProjectContext?: boolean; ensureAutoPlan?: boolean },
    ) => {
      navigationCalls.push('setSelectedGroup');
      appState.selectedGroupId = groupId;
    }),
    setSelectedTask: mock((taskId: string | null) => {
      navigationCalls.push('setSelectedTask');
      appState.selectedTaskId = taskId;
    }),
    switchProjectContext: mock(async () => {
      navigationCalls.push('switchProjectContext');
    }),
    loadMacroProjectMetadataForSelection: mock(async (options: {
      hydrateActivePlan?: boolean;
    }) => {
      navigationCalls.push(
        options.hydrateActivePlan === false ? 'loadCatalog' : 'hydratePlan',
      );
      return {
        snapshot: {
          scopedProjectIds: ['project-current'],
          visiblePlans: [
            {
              id: 'plan-owner',
              targetBranch: 'develop',
              conversationId: 'conversation-1',
            },
          ],
        },
      };
    }),
    activateArchitectPlan: mock(async () => {
      navigationCalls.push('activatePlan');
      return true;
    }),
  };
  chatState = {
    messages: [],
    messagesByConversationId: {},
    conversations: [],
    questionnaireDraftsByConversationId: {},
    pendingToolApprovalByConversationId: {},
    selectedConversationId: 'conversation-visible',
    selectConversation: mock(async () => {
      navigationCalls.push('selectConversation');
      return true;
    }),
    ensureConversationForCurrentMode: mock(async () => {
      navigationCalls.push('ensureConversation');
      return 'conversation-fallback';
    }),
  };
  taskState = { tasks: [makeTask('InProgress')] };
});

describe('workflow attention notification subscriptions', () => {
  it('uses the current conversation task identity instead of an obsolete notification context', async () => {
    const conversation = makeConversation();
    chatState.conversations = [conversation];
    const navigation = { kind: 'conversation' as const, requestKind: 'approval' as const, conversationId: conversation.id };
    chatState.conversations = [{ ...conversation, task_id: 'node-new' }];
    taskState.tasks = [{ ...makeTask('InProgress'), id: 'task:v1:branch:plan:node-new', node_id: 'node-new' }];
    await openWorkflowNotificationContext(navigation);
    expect(appState.setSelectedTask).toHaveBeenCalledWith('task:v1:branch:plan:node-new');
    expect(chatState.selectConversation).toHaveBeenCalledWith(conversation.id);
  });

  it('keeps navigation retryable while hydration or the task catalog is loading', async () => {
    chatState.hydrationStatus = 'hydrating';
    await expect(openWorkflowNotificationContext({ kind: 'review', taskId: 'task-1' })).rejects.toThrow('Loading...');
    chatState.hydrationStatus = 'ready';
    taskState.isLoading = true;
    await expect(openWorkflowNotificationContext({ kind: 'review', taskId: 'task-1' })).rejects.toThrow('Loading...');
    expect(navigationCalls).toEqual([]);
  });

  it('does not change selection when a conversation or task has been deleted', async () => {
    await openWorkflowNotificationContext({ kind: 'conversation', requestKind: 'questionnaire', conversationId: 'deleted' });
    await openWorkflowNotificationContext({ kind: 'review', taskId: 'deleted' });
    chatState.conversations = [makeConversation({ task_id: 'deleted' })];
    await openWorkflowNotificationContext({ kind: 'conversation', requestKind: 'questionnaire', conversationId: 'conversation-1' });
    expect(navigationCalls).toEqual([]);
  });

  it('restores a review through its current matching conversation, ignoring a stale stored association', async () => {
    taskState.tasks = [{ ...makeTask('InReview'), conversation_id: 'deleted' }];
    chatState.conversations = [makeConversation({ id: 'replacement' })];
    await openWorkflowNotificationContext({ kind: 'review', taskId: 'task-1' });
    expect(chatState.selectConversation).toHaveBeenCalledWith('replacement');
  });

  it('removes resolved calls to action after loaded state is known and leaves pending requests intact', () => {
    const conversation = makeConversation();
    const approval = makeApproval(conversation);
    const item = {
      id: 'workflow-attention:approval:conversation-1:tool-call-1',
      level: 'info' as const, variant: 'actionable' as const,
      category: 'task_attention_required' as const, title: 'Approval required',
      createdAt: '2026-09-04T10:00:00.000Z', readAt: null,
      workflowNavigation: { kind: 'conversation' as const, requestKind: 'approval' as const, conversationId: conversation.id },
    };
    useNotificationCenterStore.setState({ items: [item] });
    reconcileWorkflowAttentionNotifications();
    expect(useNotificationCenterStore.getState().items).toHaveLength(1);
    chatState = { ...chatState, hydrationStatus: 'ready', conversations: [conversation],
      messageLoadStatusByConversationId: { [conversation.id]: 'ready' },
      pendingToolApprovalByConversationId: { [conversation.id]: approval } };
    reconcileWorkflowAttentionNotifications();
    expect(useNotificationCenterStore.getState().items).toHaveLength(1);
    chatState.pendingToolApprovalByConversationId = {};
    reconcileWorkflowAttentionNotifications();
    expect(useNotificationCenterStore.getState().items).toEqual([]);
    useNotificationCenterStore.setState({ items: [item] });
    chatState.conversations = [];
    reconcileWorkflowAttentionNotifications();
    expect(useNotificationCenterStore.getState().items).toEqual([]);
    expect(notifyActionRequired).not.toHaveBeenCalled();
  });

  it('reconciles restored approvals before their conversation transcript is loaded', () => {
    const conversation = makeConversation();
    const item = {
      id: 'workflow-attention:approval:conversation-1:tool-call-1',
      level: 'info' as const, variant: 'actionable' as const,
      category: 'task_attention_required' as const, title: 'Approval required',
      createdAt: '2026-09-04T10:00:00.000Z', readAt: null,
      workflowNavigation: { kind: 'conversation' as const, requestKind: 'approval' as const, conversationId: conversation.id },
    };
    useNotificationCenterStore.setState({ items: [item] });
    chatState = { ...chatState, hydrationStatus: 'ready', conversations: [conversation],
      messageLoadStatusByConversationId: {},
      pendingToolApprovalByConversationId: { [conversation.id]: makeApproval(conversation) } };
    reconcileWorkflowAttentionNotifications();
    expect(useNotificationCenterStore.getState().items).toHaveLength(1);
    chatState.pendingToolApprovalByConversationId = {};
    reconcileWorkflowAttentionNotifications();
    expect(useNotificationCenterStore.getState().items).toEqual([]);
    expect(notifyActionRequired).not.toHaveBeenCalled();
  });

  it('keeps a restored questionnaire until its transcript is loaded', () => {
    const conversation = makeConversation();
    const item = {
      id: 'workflow-attention:questionnaire:conversation-1:question-1',
      level: 'info' as const, variant: 'actionable' as const,
      category: 'task_attention_required' as const, title: 'Question waiting',
      createdAt: '2026-09-04T10:00:00.000Z', readAt: null,
      workflowNavigation: { kind: 'conversation' as const, requestKind: 'questionnaire' as const, conversationId: conversation.id },
    };
    useNotificationCenterStore.setState({ items: [item] });
    chatState = { ...chatState, hydrationStatus: 'ready', conversations: [conversation], messageLoadStatusByConversationId: {} };
    reconcileWorkflowAttentionNotifications();
    expect(useNotificationCenterStore.getState().items).toHaveLength(1);
    chatState.messageLoadStatusByConversationId = { [conversation.id]: 'ready' };
    reconcileWorkflowAttentionNotifications();
    expect(useNotificationCenterStore.getState().items).toEqual([]);
  });

  it('emits one questionnaire notification and honors its explicit Architect group', async () => {
    const conversation = makeConversation({
      scope_mode: 'Architect',
      task_id: null,
      group_id: 'group-other',
      project_id: 'project-current',
    });
    chatState = { ...chatState, conversations: [conversation] };
    const unsubscribe = subscribeToWorkflowAttentionNotifications(t);
    const message = makeQuestionnaire(conversation);

    updateChatState({
      messages: [message],
      messagesByConversationId: { [conversation.id]: [message] },
    });

    expect(notifyActionRequired).toHaveBeenCalledTimes(1);
    const [, options] = notifyActionRequired.mock.calls[0]!;
    expect(options).toEqual(expect.objectContaining({
      category: 'task_attention_required',
      notificationKey: 'workflow-attention:questionnaire:conversation-1:question-1',
    }));
    await options.actions[0]!.onClick();
    expect(appState.setSelectedGroup).toHaveBeenCalledWith('group-other', {
      restoreProjectContext: false,
      ensureAutoPlan: false,
    });
    expect(appState.switchProjectContext).not.toHaveBeenCalled();
    expect(appState.setMode).toHaveBeenCalledWith('Architect', {
      ensureAutoPlan: false,
    });
    expect(appState.activateArchitectPlan).toHaveBeenCalledWith(
      'plan-owner',
      expect.objectContaining({
        targetBranch: 'develop',
        allowScopeSwitch: false,
      }),
    );
    expect(navigationCalls).toEqual([
      'setSelectedGroup',
      'setMode',
      'loadCatalog',
      'activatePlan',
      'ensureConversation',
      'selectConversation',
    ]);
    expect(chatState.ensureConversationForCurrentMode).toHaveBeenCalledTimes(1);
    expect(chatState.selectConversation).toHaveBeenCalledWith(conversation.id);
    unsubscribe();
  });

  it('routes a project-only Architect request through its project context', async () => {
    const conversation = makeConversation({
      scope_mode: 'Architect',
      task_id: null,
      group_id: null,
      project_id: 'project-other',
    });
    chatState = { ...chatState, conversations: [conversation] };
    const unsubscribe = subscribeToWorkflowAttentionNotifications(t);
    const message = makeQuestionnaire(conversation);
    updateChatState({
      messages: [message],
      messagesByConversationId: { [conversation.id]: [message] },
    });

    const [, options] = notifyActionRequired.mock.calls[0]!;
    await options.actions[0]!.onClick();

    expect(appState.switchProjectContext).toHaveBeenCalledWith('project-other', {
      restoreProjectContext: false,
      ensureAutoPlan: false,
    });
    expect(appState.setSelectedGroup).not.toHaveBeenCalled();
    expect(chatState.selectConversation).toHaveBeenCalledWith(conversation.id);
    unsubscribe();
  });

  it('emits one approval notification and routes its Implement action', async () => {
    const conversation = makeConversation();
    chatState = { ...chatState, conversations: [conversation] };
    const unsubscribe = subscribeToWorkflowAttentionNotifications(t);

    updateChatState({
      pendingToolApprovalByConversationId: {
        [conversation.id]: makeApproval(conversation),
      },
    });

    expect(notifyActionRequired).toHaveBeenCalledTimes(1);
    const [, options] = notifyActionRequired.mock.calls[0]!;
    expect(options).toEqual(expect.objectContaining({
      category: 'task_attention_required',
      notificationKey: 'workflow-attention:approval:conversation-1:tool-call-1',
    }));
    await options.actions[0]!.onClick();
    expect(appState.setMode).toHaveBeenCalledWith('Implement', {
      ensureAutoPlan: true,
    });
    expect(appState.setSelectedTask).toHaveBeenCalledWith('task-1');
    expect(chatState.selectConversation).toHaveBeenCalledWith(conversation.id);
    unsubscribe();
  });

  it('routes a Chat questionnaire without selecting a task or project', async () => {
    const conversation = makeConversation({
      scope_mode: 'Chat',
      task_id: null,
      group_id: null,
      project_id: null,
    });
    chatState = { ...chatState, conversations: [conversation] };
    const unsubscribe = subscribeToWorkflowAttentionNotifications(t);
    const message = makeQuestionnaire(conversation);

    updateChatState({
      messages: [message],
      messagesByConversationId: { [conversation.id]: [message] },
    });

    const [, options] = notifyActionRequired.mock.calls[0]!;
    await options.actions[0]!.onClick();

    expect(appState.setMode).toHaveBeenCalledWith('Chat', {
      ensureAutoPlan: true,
    });
    expect(appState.setSelectedTask).not.toHaveBeenCalled();
    expect(appState.switchProjectContext).not.toHaveBeenCalled();
    expect(chatState.selectConversation).toHaveBeenCalledWith(conversation.id);
    unsubscribe();
  });

  it('clears the selected task before opening a taskless Implement request', async () => {
    const conversation = makeConversation({ task_id: null });
    appState.selectedTaskId = 'task-current';
    chatState = { ...chatState, conversations: [conversation] };
    const unsubscribe = subscribeToWorkflowAttentionNotifications(t);

    updateChatState({
      pendingToolApprovalByConversationId: {
        [conversation.id]: makeApproval(conversation),
      },
    });

    const [, options] = notifyActionRequired.mock.calls[0]!;
    await options.actions[0]!.onClick();

    expect(appState.setSelectedTask).toHaveBeenCalledWith(null);
    expect(chatState.ensureConversationForCurrentMode).toHaveBeenCalled();
    expect(chatState.selectConversation).toHaveBeenCalledWith(conversation.id);
    unsubscribe();
  });

  it('emits one review notification and routes its action to the task', async () => {
    const conversation = makeConversation();
    chatState = { ...chatState, conversations: [conversation] };
    taskState = { tasks: [makeTask('InProgress')] };
    const unsubscribe = subscribeToWorkflowAttentionNotifications(t);

    updateTaskState([makeTask('InReview')]);

    expect(notifyActionRequired).toHaveBeenCalledTimes(1);
    const [, options] = notifyActionRequired.mock.calls[0]!;
    expect(options).toEqual(expect.objectContaining({
      category: 'task_attention_required',
      notificationKey: 'workflow-attention:review:task-1',
    }));
    await options.actions[0]!.onClick();
    expect(appState.setMode).toHaveBeenCalledWith('Implement');
    expect(appState.setSelectedTask).toHaveBeenCalledWith('task-1');
    expect(chatState.selectConversation).toHaveBeenCalledWith('conversation-1');
    unsubscribe();
  });

  it('routes a group-only Architect request without starting context restoration', async () => {
    const conversation = makeConversation({
      scope_mode: 'Architect',
      task_id: null,
      group_id: 'group-other',
      project_id: null,
    });
    chatState = { ...chatState, conversations: [conversation] };
    const unsubscribe = subscribeToWorkflowAttentionNotifications(t);
    const message = makeQuestionnaire(conversation);
    updateChatState({
      messages: [message],
      messagesByConversationId: { [conversation.id]: [message] },
    });

    const [, options] = notifyActionRequired.mock.calls[0]!;
    await options.actions[0]!.onClick();

    expect(appState.setSelectedGroup).toHaveBeenCalledWith('group-other', {
      restoreProjectContext: false,
      ensureAutoPlan: false,
    });
    expect(appState.setMode).toHaveBeenCalledWith('Architect', {
      ensureAutoPlan: false,
    });
    expect(chatState.selectConversation).toHaveBeenCalledWith(conversation.id);
    unsubscribe();
  });

  it('falls back to the current task conversation when a review conversation is stale', async () => {
    const conversation = makeConversation();
    chatState = {
      ...chatState,
      conversations: [conversation],
      selectConversation: mock(async () => false),
    };
    taskState = { tasks: [makeTask('InProgress')] };
    const unsubscribe = subscribeToWorkflowAttentionNotifications(t);
    updateTaskState([makeTask('InReview')]);

    const [, options] = notifyActionRequired.mock.calls[0]!;
    await options.actions[0]!.onClick();

    expect(chatState.ensureConversationForCurrentMode).toHaveBeenCalledTimes(2);
    expect(chatState.selectConversation).toHaveBeenCalledWith('conversation-1');
    unsubscribe();
  });

  it('does not emit an initial questionnaire that was already hydrated', () => {
    const conversation = makeConversation();
    const message = makeQuestionnaire(conversation);
    chatState = {
      ...chatState,
      conversations: [conversation],
      messages: [message],
      messagesByConversationId: { [conversation.id]: [message] },
    };
    const unsubscribe = subscribeToWorkflowAttentionNotifications(t);

    updateChatState({ messages: [...chatState.messages] });

    expect(notifyActionRequired).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('does not emit an initial approval that was already hydrated', () => {
    const conversation = makeConversation();
    chatState = {
      ...chatState,
      conversations: [conversation],
      pendingToolApprovalByConversationId: {
        [conversation.id]: makeApproval(conversation),
      },
    };
    const unsubscribe = subscribeToWorkflowAttentionNotifications(t);

    updateChatState({ messages: [] });

    expect(notifyActionRequired).not.toHaveBeenCalled();
    unsubscribe();
  });
});
