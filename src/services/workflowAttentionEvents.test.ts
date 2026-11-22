import { describe, expect, it } from 'bun:test';
import type {
  ChatMessage,
  Conversation,
  PendingToolApproval,
} from '../types';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import {
  detectNewConversationAttentionEvents,
  getActiveChatAttentionKeys,
  type ConversationAttentionContext,
} from './conversationAttention';
import {
  detectNewChatAttentionEvents,
  detectNewReviewAttentionEvents,
  type WorkflowAttentionContext,
  type WorkflowChatAttentionState,
} from './workflowAttentionEvents';

const backgroundContext: WorkflowAttentionContext = {
  appForeground: true,
  mode: 'Chat',
  selectedTaskId: null,
  selectedConversationId: 'conversation-visible',
  selectedGroupId: null,
  selectedProjectId: null,
  scopedProjectIds: [],
  tasks: [],
};

const makeConversation = (
  id: string,
  overrides: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: `Conversation ${id}`,
  scope_mode: 'Chat',
  task_id: null,
  project_id: null,
  last_message: '',
  message_count: 0,
  updated_at: '2026-09-04T10:00:00.000Z',
  is_unread: false,
  ...overrides,
});

const makeChatState = (
  conversations: Conversation[],
  overrides: Partial<WorkflowChatAttentionState> = {},
): WorkflowChatAttentionState => ({
  messages: [],
  messagesByConversationId: {},
  conversations,
  questionnaireDraftsByConversationId: {},
  pendingToolApprovalByConversationId: {},
  ...overrides,
});

const makeQuestionnaireMessage = (conversationId: string): ChatMessage => ({
  id: 'question-1',
  task_id: `task-${conversationId}`,
  conversation_id: conversationId,
  role: 'assistant',
  content: 'I need a choice.',
  timestamp: '2026-09-04T10:01:00.000Z',
  questionnaire: {
    questions: [
      {
        id: 'scope',
        prompt: 'Which scope should I use?',
        choices: ['Small', 'Medium', 'Large'],
      },
    ],
  },
});

const makeApproval = (conversationId: string): PendingToolApproval => ({
  conversationId,
  assistantMessageId: 'assistant-1',
  toolCallId: 'tool-call-1',
  toolId: 'apply_patch',
  actionGroup: 'change',
  riskLevel: 'balanced',
  summary: 'Modify src/App.tsx',
  rememberKey: 'modify:src/App.tsx',
});

const makeTask = (
  id: string,
  status: CatalogedImplementTask['status'],
): CatalogedImplementTask =>
  ({
    id,
    title: `Task ${id}`,
    status,
    conversation_id: `conversation-${id}`,
  }) as CatalogedImplementTask;

describe('workflow attention events', () => {
  it('notifies for selected questionnaires and approvals when the window is inactive', () => {
    const conversation = makeConversation('visible', { scope_mode: 'Chat', task_id: null });
    const previous = makeChatState([conversation]);
    const next = makeChatState([conversation], {
      messages: [makeQuestionnaireMessage(conversation.id)],
      pendingToolApprovalByConversationId: { [conversation.id]: makeApproval(conversation.id) },
    });
    const context: ConversationAttentionContext = {
      appForeground: false,
      mode: 'Chat',
      selectedConversationId: conversation.id,
      selectedGroupId: null,
      selectedProjectId: null,
      scopedProjectIds: [],
    };
    const events = detectNewConversationAttentionEvents(previous, next, context);
    expect(events.map((event) => event.kind)).toEqual(['questionnaire', 'approval']);
    expect(events.map((event) => event.key)).toEqual([...getActiveChatAttentionKeys(next)]);
    expect(detectNewConversationAttentionEvents(next, next, context)).toEqual([]);
    expect(detectNewConversationAttentionEvents(previous, next, { ...context, appForeground: true })).toEqual([]);
  });

  it('retired Implement selections do not mask real Chat attention', () => {
    const legacy = makeConversation('legacy', { scope_mode: 'Implement', task_id: 'legacy-task' });
    const chat = makeConversation('chat');
    const task = makeTask('legacy-task', 'InProgress');
    const context: WorkflowAttentionContext = {
      ...backgroundContext,
      mode: 'Implement',
      selectedTaskId: task.id,
      selectedConversationId: legacy.id,
      tasks: [task],
    };
    const previous = makeChatState([legacy, chat]);
    const next = makeChatState([legacy, chat], {
      pendingToolApprovalByConversationId: { legacy: makeApproval(legacy.id), chat: makeApproval(chat.id) },
    });
    expect(detectNewConversationAttentionEvents(previous, next, context).map(event => event.conversationId))
      .toEqual([legacy.id, chat.id]);
    expect(detectNewChatAttentionEvents(previous, next, context)).toEqual([
      expect.objectContaining({ kind: 'approval', conversationId: chat.id }),
    ]);
    expect(detectNewReviewAttentionEvents([task], [{ ...task, status: 'InReview' }], context, [legacy]))
      .toEqual([]);
  });

  it('does not emit requests restored during startup or lazy message loading', () => {
    const conversation = makeConversation('old');
    const previous = makeChatState([conversation]);
    const next = makeChatState([conversation], { messages: [makeQuestionnaireMessage(conversation.id)] });
    expect(detectNewChatAttentionEvents({ ...previous, hydrationStatus: 'hydrating' }, { ...next, hydrationStatus: 'ready' }, backgroundContext)).toEqual([]);
    expect(detectNewChatAttentionEvents({ ...previous, messageLoadStatusByConversationId: { old: 'loading' } }, { ...next, messageLoadStatusByConversationId: { old: 'ready' } }, backgroundContext)).toEqual([]);
  });

  it('detects a new questionnaire once', () => {
    const conversation = makeConversation('questionnaire');
    const previous = makeChatState([conversation]);
    const message = makeQuestionnaireMessage(conversation.id);
    const next = makeChatState([conversation], {
      messages: [message],
      messagesByConversationId: { [conversation.id]: [message] },
    });

    expect(detectNewChatAttentionEvents(previous, next, backgroundContext)).toEqual([
      expect.objectContaining({
        kind: 'questionnaire',
        key: 'workflow-attention:questionnaire:questionnaire:question-1',
        prompt: 'Which scope should I use?',
      }),
    ]);
    expect(detectNewChatAttentionEvents(next, next, backgroundContext)).toEqual([]);
  });

  it('detects a second questionnaire in the same conversation', () => {
    const conversation = makeConversation('questionnaire');
    const firstMessage = makeQuestionnaireMessage(conversation.id);
    const secondMessage = {
      ...makeQuestionnaireMessage(conversation.id),
      id: 'question-2',
      timestamp: '2026-09-04T10:02:00.000Z',
    };
    const previous = makeChatState([conversation], {
      messages: [firstMessage],
      messagesByConversationId: { [conversation.id]: [firstMessage] },
    });
    const next = makeChatState([conversation], {
      messages: [firstMessage, secondMessage],
      messagesByConversationId: {
        [conversation.id]: [firstMessage, secondMessage],
      },
    });

    expect(detectNewChatAttentionEvents(previous, next, backgroundContext)).toEqual([
      expect.objectContaining({
        kind: 'questionnaire',
        key: 'workflow-attention:questionnaire:questionnaire:question-2',
      }),
    ]);
  });

  it('detects a new tool approval once', () => {
    const conversation = makeConversation('approval');
    const previous = makeChatState([conversation]);
    const approval = makeApproval(conversation.id);
    const next = makeChatState([conversation], {
      pendingToolApprovalByConversationId: { [conversation.id]: approval },
    });

    expect(detectNewChatAttentionEvents(previous, next, backgroundContext)).toEqual([
      expect.objectContaining({
        kind: 'approval',
        key: 'workflow-attention:approval:approval:tool-call-1',
        summary: 'Modify src/App.tsx',
      }),
    ]);
    expect(detectNewChatAttentionEvents(next, next, backgroundContext)).toEqual([]);

    const replacement = {
      ...approval,
      toolCallId: 'tool-call-2',
      summary: 'Run the next protected action',
    };
    const replaced = makeChatState([conversation], {
      pendingToolApprovalByConversationId: { [conversation.id]: replacement },
    });
    expect(detectNewChatAttentionEvents(next, replaced, backgroundContext)).toEqual([
      expect.objectContaining({
        kind: 'approval',
        key: 'workflow-attention:approval:approval:tool-call-2',
      }),
    ]);
  });

  it('does not notify for a questionnaire already visible to the user', () => {
    const conversation = makeConversation('visible');
    const message = makeQuestionnaireMessage(conversation.id);
    const previous = makeChatState([conversation]);
    const next = makeChatState([conversation], {
      messages: [message],
      messagesByConversationId: { [conversation.id]: [message] },
    });
    const visibleContext: WorkflowAttentionContext = {
      appForeground: true,
      mode: 'Chat',
      selectedTaskId: null,
      selectedConversationId: conversation.id,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      scopedProjectIds: ['project-1'],
      tasks: [makeTask('task-visible', 'InProgress')],
    };

    expect(detectNewChatAttentionEvents(previous, next, visibleContext)).toEqual([]);
  });

  it('does not notify for an approval already visible to the user', () => {
    const conversation = makeConversation('visible');
    const previous = makeChatState([conversation]);
    const next = makeChatState([conversation], {
      pendingToolApprovalByConversationId: {
        [conversation.id]: makeApproval(conversation.id),
      },
    });
    const visibleContext: WorkflowAttentionContext = {
      appForeground: true,
      mode: 'Chat',
      selectedTaskId: null,
      selectedConversationId: conversation.id,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      scopedProjectIds: ['project-1'],
      tasks: [makeTask('task-visible', 'InProgress')],
    };

    expect(detectNewChatAttentionEvents(previous, next, visibleContext)).toEqual([]);
  });

  it('does notify when an Architect conversation id is stale for the active scope', () => {
    const conversation = makeConversation('architect', {
      scope_mode: 'Architect',
      task_id: null,
      group_id: 'group-old',
      project_id: 'project-old',
    });
    const message = makeQuestionnaireMessage(conversation.id);
    const previous = makeChatState([conversation]);
    const next = makeChatState([conversation], {
      messages: [message],
      messagesByConversationId: { [conversation.id]: [message] },
    });
    const staleContext: WorkflowAttentionContext = {
      appForeground: true,
      mode: 'Architect',
      selectedTaskId: null,
      selectedConversationId: conversation.id,
      selectedGroupId: 'group-new',
      selectedProjectId: 'project-new',
      scopedProjectIds: ['project-new'],
      tasks: [],
    };

    expect(detectNewChatAttentionEvents(previous, next, staleContext)).toEqual([
      expect.objectContaining({ kind: 'questionnaire' }),
    ]);
  });

  it('does notify when an explicit Architect group conflicts with the active group', () => {
    const conversation = makeConversation('architect-conflict', {
      scope_mode: 'Architect',
      task_id: null,
      group_id: 'group-old',
      project_id: 'project-new',
    });
    const message = makeQuestionnaireMessage(conversation.id);
    const previous = makeChatState([conversation]);
    const next = makeChatState([conversation], {
      messages: [message],
      messagesByConversationId: { [conversation.id]: [message] },
    });
    const conflictingContext: WorkflowAttentionContext = {
      appForeground: true,
      mode: 'Architect',
      selectedTaskId: null,
      selectedConversationId: conversation.id,
      selectedGroupId: 'group-new',
      selectedProjectId: 'project-new',
      scopedProjectIds: ['project-new'],
      tasks: [],
    };

    expect(
      detectNewChatAttentionEvents(previous, next, conflictingContext),
    ).toEqual([expect.objectContaining({ kind: 'questionnaire' })]);
  });

  it('does not notify when a questionnaire is resolved', () => {
    const conversation = makeConversation('resolved');
    const message = makeQuestionnaireMessage(conversation.id);
    const previous = makeChatState([conversation], {
      messages: [message],
      messagesByConversationId: { [conversation.id]: [message] },
    });
    const userReply: ChatMessage = {
      id: 'reply-1',
      task_id: `task-${conversation.id}`,
      conversation_id: conversation.id,
      role: 'user',
      content: 'Small',
      timestamp: '2026-09-04T10:02:00.000Z',
    };
    const next = makeChatState([conversation], {
      messages: [message, userReply],
      messagesByConversationId: { [conversation.id]: [message, userReply] },
    });

    expect(detectNewChatAttentionEvents(previous, next, backgroundContext)).toEqual([]);
  });

  it('does not notify when an approval is resolved', () => {
    const conversation = makeConversation('resolved');
    const previous = makeChatState([conversation], {
      pendingToolApprovalByConversationId: {
        [conversation.id]: makeApproval(conversation.id),
      },
    });
    const next = makeChatState([conversation]);

    expect(detectNewChatAttentionEvents(previous, next, backgroundContext)).toEqual([]);
  });
});
