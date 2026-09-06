import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createDeferred } from '../../test-utils/deferred';

const task = {
  id: 'task-1',
  task_source: 'architect',
  draft: false,
  status: 'Pending',
  is_blocked: false,
  title: 'Pilot actions',
  description: 'Connect Pilot to the desktop stores.',
  project_id: 'project-1',
  project_ids: ['project-1'],
  execution_targets: [],
  branch_name: 'feature/pilot-actions',
  assigned_branch: 'feature/pilot-actions',
  dependencies: [],
  estimated_changes: [],
};

const conversation = {
  id: 'conversation-1',
  task_id: task.id,
  provider_id: 'provider-1',
  model_id: 'model-1',
  reasoning_effort: null,
};

const startTask = mock(async (_taskId: string, options?: { beforeEffect?: () => Promise<void> }) => {
  await options?.beforeEffect?.();
  task.status = 'InProgress';
});
let providerStarts = 0;
const sendMessage = mock(async (payload: {
  pilotTarget?: { beforeEffect?: () => Promise<void> };
}) => {
  await payload.pilotTarget?.beforeEffect?.();
  providerStarts += 1;
  return {
    status: 'sent' as const,
    conversationId: conversation.id,
    turnId: 'turn-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
  };
});
const approveOnce = mock(() => undefined);
const approveConversation = mock(() => undefined);
const denyApproval = mock(() => undefined);
const resolveApproval = mock(async (params: {
  resolution: { kind: string };
  beforeEffect?: () => Promise<void>;
}) => {
  await params.beforeEffect?.();
  return params.resolution;
});
const stopConversationStream = mock(() => undefined);
const setQuestionnaireStep = mock(() => undefined);
const recordQuestionnaireAnswer = mock((_conversationId: string, _answer: string) => ({
  completed: false,
  state: null,
}));
const submitQuestionnaire = mock(async () => ({
  status: 'sent' as const,
  conversationId: conversation.id,
  turnId: 'turn-2',
  userMessageId: 'user-2',
  assistantMessageId: 'assistant-2',
}));

const taskState = {
  tasks: [task],
  getTaskById: (taskId: string) => taskId === task.id ? task : undefined,
  startTask,
};
const chatState = {
  conversations: [conversation],
  ensurePilotTaskConversation: mock(async () => conversation),
  sendMessage,
  getActiveQuestionnaire: mock(() => null as unknown),
  setActiveQuestionnaireStep: setQuestionnaireStep,
  recordActiveQuestionnaireAnswer: recordQuestionnaireAnswer,
  submitActiveQuestionnaire: submitQuestionnaire,
  getPendingToolApproval: mock(() => null as unknown),
  approvePendingToolApprovalOnce: approveOnce,
  approvePendingToolApprovalForConversation: approveConversation,
  denyPendingToolApproval: denyApproval,
  resolvePendingToolApprovalForPilot: resolveApproval,
  getConversationRuntime: mock(() => ({ phase: 'streaming' })),
  stopConversationStream,
};

mock.module('../../stores/useTaskStore', () => ({
  useTaskStore: { getState: () => taskState },
}));
mock.module('../../stores/useChatStore', () => ({
  useChatStore: { getState: () => chatState },
}));
mock.module('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      getProjectById: (projectId: string) => projectId === 'project-1'
        ? { id: projectId, name: 'Macro' }
        : undefined,
    }),
  },
}));

const { desktopActions } = await import('./desktopActions');
const { assertPilotConversationActionAllowed } = await import('./actionReservations');

const createGuard = () => ({
  assertCurrent: mock(() => undefined),
  authorizeBeforeEffect: mock(async (_options?: {
    revision: 'expected' | 'consumed';
  }) => undefined),
});

describe('Macro Pilot desktop actions', () => {
  beforeEach(() => {
    task.status = 'Pending';
    providerStarts = 0;
    startTask.mockClear();
    sendMessage.mockClear();
    approveOnce.mockClear();
    approveConversation.mockClear();
    denyApproval.mockClear();
    resolveApproval.mockClear();
    stopConversationStream.mockClear();
    setQuestionnaireStep.mockClear();
    recordQuestionnaireAnswer.mockClear();
    submitQuestionnaire.mockClear();
    chatState.getActiveQuestionnaire.mockImplementation(() => null);
    chatState.getPendingToolApproval.mockImplementation(() => null);
    chatState.getConversationRuntime.mockImplementation(() => ({ phase: 'streaming' }));
  });

  it('prepares the task and starts the existing provider stream', async () => {
    const guard = createGuard();
    await expect(desktopActions.start(task.id, guard)).resolves.toEqual({
      conversationId: conversation.id,
      startedAt: expect.any(String),
      assistantMessageId: 'assistant-1',
    });

    expect(startTask).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: conversation.id,
      taskId: task.id,
      pilotTarget: expect.objectContaining({ taskId: task.id }),
      content: expect.stringContaining('TASK CONTEXT'),
    }));
    expect(guard.authorizeBeforeEffect).toHaveBeenCalledTimes(3);
  });

  it('keeps local sends out while a remote reply is being authorized', async () => {
    const authorization = createDeferred<void>();
    const guard = {
      assertCurrent: mock(() => undefined),
      authorizeBeforeEffect: mock(() => authorization.promise),
    };
    const reply = desktopActions.reply(task.id, conversation.id, 'Continue.', guard);
    await Promise.resolve();

    expect(() => assertPilotConversationActionAllowed(conversation.id)).toThrow();
    authorization.resolve();
    await reply;
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Continue.',
      conversationId: conversation.id,
    }));
  });

  it('rechecks authorization after preparation and stops before the provider when revoked', async () => {
    let authorizationChecks = 0;
    const guard = {
      assertCurrent: mock(() => undefined),
      authorizeBeforeEffect: mock(async (_options?: {
        revision: 'expected' | 'consumed';
      }) => {
        authorizationChecks += 1;
        if (authorizationChecks === 2) {
          throw new Error('The Pilot session was revoked.');
        }
      }),
    };

    await expect(desktopActions.reply(
      task.id,
      conversation.id,
      'Continue.',
      guard,
    )).rejects.toThrow('revoked');

    expect(guard.authorizeBeforeEffect.mock.calls.map((call) => call[0])).toEqual([
      { revision: 'expected' },
      { revision: 'consumed' },
    ]);
    expect(providerStarts).toBe(0);
    expect(() => assertPilotConversationActionAllowed(conversation.id)).not.toThrow();
  });

  it('records every questionnaire answer before using the normal submit path', async () => {
    chatState.getActiveQuestionnaire.mockImplementation(() => ({
      conversationId: conversation.id,
      taskId: task.id,
      assistantMessageId: 'assistant-question',
      totalSteps: 2,
      questionnaire: {
        questions: [
          { id: 'scope', prompt: 'Scope?', choices: ['A', 'B', 'C'] },
          { id: 'risk', prompt: 'Risk?', choices: ['Low', 'Mid', 'High'] },
        ],
      },
    }));

    await desktopActions.answerDecision(
      {
        conversation_id: conversation.id,
        assistant_message_id: 'assistant-question',
        task_id: task.id,
      },
      [
        { step_id: 'scope', answer: 'B' },
        { step_id: 'risk', answer: 'Low' },
      ],
      createGuard(),
    );

    expect(recordQuestionnaireAnswer.mock.calls.map((call) => call[1])).toEqual(['B', 'Low']);
    expect(submitQuestionnaire).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ taskId: task.id }),
    );
  });

  it('resolves only the exact live tool request and never resumes an interrupted one', async () => {
    const approval = {
      conversationId: conversation.id,
      assistantMessageId: 'assistant-tool',
      toolCallId: 'call-1',
      canApproveForConversation: true,
    };
    chatState.getPendingToolApproval.mockImplementation(() => approval);
    await desktopActions.resolveApproval(
      {
        conversation_id: conversation.id,
        assistant_message_id: 'assistant-tool',
        tool_call_id: 'call-1',
      },
      { verdict: 'approve', grant_scope: 'conversation' },
      createGuard(),
    );
    expect(resolveApproval).toHaveBeenCalledWith(expect.objectContaining({
      assistantMessageId: 'assistant-tool',
      toolCallId: 'call-1',
      resolution: { kind: 'allow_conversation' },
    }));

    resolveApproval.mockImplementationOnce(async () => ({
      kind: 'deny',
      reason: 'The tool policy changed.',
    }));
    await expect(desktopActions.resolveApproval(
      {
        conversation_id: conversation.id,
        assistant_message_id: 'assistant-tool',
        tool_call_id: 'call-1',
      },
      { verdict: 'approve', grant_scope: 'once' },
      createGuard(),
    )).rejects.toMatchObject({ code: 'unavailable' });

    chatState.getPendingToolApproval.mockImplementation(() => ({
      ...approval,
      recoveryState: 'interrupted',
    }));
    await expect(desktopActions.resolveApproval(
      {
        conversation_id: conversation.id,
        assistant_message_id: 'assistant-tool',
        tool_call_id: 'call-1',
      },
      { verdict: 'deny' },
      createGuard(),
    )).rejects.toMatchObject({ code: 'invalid_reference' });
    expect(denyApproval).not.toHaveBeenCalled();
  });

  it('cancels the targeted conversation without consulting UI selection', async () => {
    await desktopActions.cancel(conversation.id, createGuard());
    expect(stopConversationStream).toHaveBeenCalledWith(
      conversation.id,
      expect.anything(),
    );
  });
});
