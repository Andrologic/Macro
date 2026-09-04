import { describe, expect, it } from 'bun:test';
import type {
  ChatMessage,
  Conversation,
  PendingToolApproval,
} from '../types';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import {
  detectNewChatAttentionEvents,
  detectNewReviewAttentionEvents,
  type WorkflowAttentionContext,
  type WorkflowChatAttentionState,
} from './workflowAttentionEvents';

const backgroundContext: WorkflowAttentionContext = {
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
  scope_mode: 'Implement',
  task_id: `task-${id}`,
  project_id: 'project-1',
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

  it('detects a transition to review without treating hydrated review tasks as new', () => {
    const previous = [makeTask('review', 'InProgress')];
    const next = [makeTask('review', 'InReview')];

    expect(
      detectNewReviewAttentionEvents(previous, next, backgroundContext, []),
    ).toEqual([
      expect.objectContaining({
        kind: 'review',
        key: 'workflow-attention:review:review',
        conversationId: 'conversation-review',
      }),
    ]);
    expect(
      detectNewReviewAttentionEvents([], next, backgroundContext, []),
    ).toEqual([]);
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
      mode: 'Implement',
      selectedTaskId: conversation.task_id,
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
      mode: 'Implement',
      selectedTaskId: conversation.task_id,
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

  it('does notify for a taskless Implement conversation while a task is selected', () => {
    const conversation = makeConversation('implement-taskless', {
      scope_mode: 'Implement',
      task_id: null,
    });
    const previous = makeChatState([conversation]);
    const next = makeChatState([conversation], {
      pendingToolApprovalByConversationId: {
        [conversation.id]: makeApproval(conversation.id),
      },
    });
    const selectedTaskContext: WorkflowAttentionContext = {
      mode: 'Implement',
      selectedTaskId: 'task-selected',
      selectedConversationId: conversation.id,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      scopedProjectIds: ['project-1'],
      tasks: [makeTask('selected', 'InProgress')],
    };

    expect(
      detectNewChatAttentionEvents(previous, next, selectedTaskContext),
    ).toEqual([expect.objectContaining({ kind: 'approval' })]);
  });

  it('recognizes a visible Implement conversation through its legacy node id', () => {
    const conversation = makeConversation('legacy-visible', {
      task_id: 'node-legacy',
    });
    const task = {
      ...makeTask('task:v1:develop:plan:node-legacy', 'InProgress'),
      node_id: 'node-legacy',
    };
    const previous = makeChatState([conversation]);
    const next = makeChatState([conversation], {
      pendingToolApprovalByConversationId: {
        [conversation.id]: makeApproval(conversation.id),
      },
    });
    const visibleContext: WorkflowAttentionContext = {
      mode: 'Implement',
      selectedTaskId: task.id,
      selectedConversationId: conversation.id,
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      scopedProjectIds: ['project-1'],
      tasks: [task],
    };

    expect(detectNewChatAttentionEvents(previous, next, visibleContext)).toEqual([]);
  });

  it('does not notify for a review already visible to the user', () => {
    const visibleReviewContext: WorkflowAttentionContext = {
      mode: 'Implement',
      selectedTaskId: 'visible',
      selectedConversationId: 'conversation-visible',
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-1',
      scopedProjectIds: ['project-1'],
      tasks: [makeTask('visible', 'InProgress')],
    };
    expect(
      detectNewReviewAttentionEvents(
        [makeTask('visible', 'InProgress')],
        [makeTask('visible', 'InReview')],
        visibleReviewContext,
        [makeConversation('visible')],
      ),
    ).toEqual([]);
  });

  it('does not notify for a visible review selected through its legacy node id', () => {
    const previousTask = {
      ...makeTask('task:v1:develop:plan:node-legacy', 'InProgress'),
      node_id: 'node-legacy',
    };
    const nextTask = { ...previousTask, status: 'InReview' as const };
    const context: WorkflowAttentionContext = {
      ...backgroundContext,
      mode: 'Implement',
      selectedTaskId: 'node-legacy',
      tasks: [nextTask],
    };

    expect(
      detectNewReviewAttentionEvents(
        [previousTask],
        [nextTask],
        context,
        [],
      ),
    ).toEqual([]);
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
