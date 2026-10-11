import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createDeferred } from '../../test-utils/deferred';
import { PilotKernel, type KernelDependencies } from './kernel';
import { object, PilotError, type Delivery, type Resource } from './protocol';
import taskFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/task.json';
import commandFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/task-reply-command.json';

const task = {
  id: 'task-eligibility',
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
  scope_mode: 'Implement',
  task_id: task.id as string | null,
  provider_id: 'provider-1',
  model_id: 'model-1',
  reasoning_effort: null,
};

const startTask = mock(async (_taskId: string, options?: {
  pilotActionToken?: symbol;
  beforeEffect?: () => Promise<void>;
}) => {
  await options?.beforeEffect?.();
  task.status = 'InProgress';
});
let providerStarts = 0;
let taskStatusPersistences = 0;
const retryTask = mock(async (_taskId: string, options?: {
  pilotActionToken?: symbol;
  beforeEffect?: () => Promise<void>;
}) => {
  await options?.beforeEffect?.();
  taskStatusPersistences += 1;
  task.status = 'InProgress';
});
const sendMessage = mock(async (payload: {
  pilotTarget?: {
    actionToken?: symbol;
    beforeEffect?: () => Promise<void>;
  };
}) => {
  if (task.status === 'AwaitingResponse') {
    await retryTask(task.id, {
      pilotActionToken: payload.pilotTarget?.actionToken,
      beforeEffect: payload.pilotTarget?.beforeEffect,
    });
  }
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
  retryTask,
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

const { createDesktopActions } = await import('./desktopActions');
const desktopActions = createDesktopActions({
  app: () => ({ getProjectById: (projectId: string) => projectId === 'project-1' ? { id: projectId, name: 'Macro' } : undefined }) as never,
  chat: () => chatState as never,
  tasks: () => taskState as never,
  taskLifecycle: (() => ({})) as never,
  taskCommandTargets: (() => []) as never,
});
const { assertPilotConversationActionAllowed } = await import('./actionReservations');

const createGuard = () => ({
  assertCurrent: mock(() => undefined),
  authorizeBeforeEffect: mock(async (_options?: {
    revision: 'expected' | 'consumed';
  }) => undefined),
});

const setupStartKernel = () => {
  let persisted: string | null = null;
  let executions = 0;
  // A stale/forged actionable projection exercises the desktop preflight too.
  const snapshot = { ...structuredClone(taskFixture), state: 'queued' } as Resource;
  delete snapshot.reply_context;
  snapshot.ref.task_id = task.id;
  const deps: KernelDependencies = {
    instanceId: snapshot.ref.instance_id,
    storage: { load: async () => persisted, compareAndSwap: async (previous, next) => {
      if (previous !== persisted) return false;
      persisted = next; return true;
    } },
    project: () => ({ snapshots: [snapshot], state: null }),
    authorize: async () => new Date(Date.now() + 5000).toISOString(),
    execute: async (_command, guard) => { executions++; return desktopActions.start(task.id, guard); },
  };
  const command = { ...commandFixture, kind: 'run.start', target: snapshot.ref,
    expected_revision: snapshot.revision, payload: { run_id: 'run:eligibility' } };
  const delivery: Delivery = { transport_version: '1.0', type: 'delivery', exchange_id: 'exchange:eligibility',
    delivery_id: 'delivery:eligibility', actor: command.issued_by, message: command };
  return { deps, delivery, get executions() { return executions; } };
};

describe('Macro Pilot desktop actions', () => {
  beforeEach(() => {
    conversation.scope_mode = 'Implement';
    conversation.task_id = task.id;
    task.status = 'Pending';
    task.draft = false;
    task.task_source = 'architect';
    task.is_blocked = false;
    providerStarts = 0;
    taskStatusPersistences = 0;
    startTask.mockClear();
    chatState.ensurePilotTaskConversation.mockClear();
    retryTask.mockClear();
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

  it('durably rejects ineligible starts through the real kernel and action without a phantom run', async () => {
    for (const exclusion of [{ draft: true }, { task_source: 'plan_finalization' }, { is_blocked: true }]) {
      Object.assign(task, { draft: false, task_source: 'architect', is_blocked: false }, exclusion);
      const env = setupStartKernel();
      const { deps, delivery } = env;
      const kernel = new PilotKernel(deps); await kernel.initialize();
      const first = await kernel.handle(delivery);
      expect(object(first.message).outcome).toBe('rejected');
      expect(object(object(first.message).error).code).toBe('is_blocked' in exclusion ? 'unavailable' : 'invalid_reference');
      expect(kernel.getKnownRuns()).toEqual([]);
      expect(kernel.indeterminate()).toEqual([]);
      const restarted = new PilotKernel(deps); await restarted.initialize();
      expect(await restarted.handle(delivery)).toEqual(first);
      expect(restarted.getKnownRuns()).toEqual([]);
      expect(restarted.indeterminate()).toEqual([]);
      const changed = structuredClone(delivery);
      changed.message.expected_revision = 99;
      expect(object(object((await restarted.handle(changed)).message).error).code).toBe('conflict');
      expect(env.executions).toBe(1);
      expect(startTask).not.toHaveBeenCalled();
      expect(chatState.ensurePilotTaskConversation).not.toHaveBeenCalled();
      expect(providerStarts).toBe(0);
    }
  });

  it('keeps a start failure after conversation preparation indeterminate across restart', async () => {
    const env = setupStartKernel();
    let conversationWrites = 0;
    chatState.ensurePilotTaskConversation.mockImplementationOnce(async () => {
      conversationWrites++;
      throw new PilotError('unavailable');
    });
    const kernel = new PilotKernel(env.deps); await kernel.initialize();
    expect(object(object((await kernel.handle(env.delivery)).message).error).code).toBe('conflict');
    expect(kernel.getKnownRuns()[0].interruptedAt).toBeString();
    const restarted = new PilotKernel(env.deps); await restarted.initialize();
    expect(restarted.indeterminate()).toHaveLength(1);
    await restarted.handle(env.delivery);
    expect(env.executions).toBe(1);
    expect(conversationWrites).toBe(1);
    expect(providerStarts).toBe(0);
  });

  it('prepares the task and starts the existing provider stream', async () => {
    const guard = createGuard();
    await expect(desktopActions.start(task.id, guard)).resolves.toEqual({
      conversationId: conversation.id,
      startedAt: expect.any(String),
      assistantMessageId: 'assistant-1',
    });

    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      pilotActionToken: expect.anything(),
    }));
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

  it('rechecks authorization before a retry transition and persists nothing when revoked', async () => {
    task.status = 'AwaitingResponse';
    let authorizationChecks = 0;
    const guard = {
      assertCurrent: mock(() => undefined),
      authorizeBeforeEffect: mock(async () => {
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

    expect(retryTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      pilotActionToken: expect.anything(),
      beforeEffect: expect.anything(),
    }));
    expect(taskStatusPersistences).toBe(0);
    expect(task.status).toBe('AwaitingResponse');
    expect(providerStarts).toBe(0);
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


describe('explicit Chat conversation sending', () => {
  beforeEach(() => {
    conversation.scope_mode = 'Chat'; conversation.task_id = null;
    conversation.model_id = 'model-1';
    chatState.getConversationRuntime.mockImplementation(() => ({ phase: 'idle' }));
    chatState.getActiveQuestionnaire.mockImplementation(() => null);
    chatState.getPendingToolApproval.mockImplementation(() => null);
    sendMessage.mockClear(); providerStarts = 0;
  });
  it('rejects pending decisions and target configuration changes during authorization', async () => {
    const guard = { assertCurrent: () => undefined, authorizeBeforeEffect: async () => undefined };
    chatState.getActiveQuestionnaire.mockImplementation(() => ({ assistantMessageId: 'pending' }));
    await expect(desktopActions.sendConversation(conversation.id, 'Next', guard)).rejects.toThrow('conflict');
    chatState.getActiveQuestionnaire.mockImplementation(() => null);
    guard.authorizeBeforeEffect = async () => { conversation.model_id = 'changed-model'; };
    await expect(desktopActions.sendConversation(conversation.id, 'Next', guard)).rejects.toThrow('stale_revision');
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('reauthorizes after preparation and refuses revoked sessions before provider effects', async () => {
    let checks = 0;
    const guard = { assertCurrent: () => undefined, authorizeBeforeEffect: async () => {
      if (++checks === 2) throw new PilotError('forbidden');
    } };
    await expect(desktopActions.sendConversation(conversation.id, 'Next', guard)).rejects.toThrow('forbidden');
    expect(checks).toBe(2); expect(providerStarts).toBe(0);
  });
  it('sends to the reserved Chat with an explicit mode and no active composer context', async () => {
    conversation.scope_mode = 'Chat'; conversation.task_id = null;
    chatState.getConversationRuntime.mockImplementation(() => ({ phase: 'idle' }));
    chatState.getActiveQuestionnaire.mockImplementation(() => null);
    chatState.getPendingToolApproval.mockImplementation(() => null);
    sendMessage.mockClear();
    const guard = { assertCurrent: () => undefined, authorizeBeforeEffect: async () => undefined };
    await desktopActions.sendConversation(conversation.id, ' Next message ', guard);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ conversationId: conversation.id, content: 'Next message', contextRefs: [], pilotTarget: { mode: 'Chat' } });
  });
  it('rejects a busy conversation before invoking send', async () => {
    conversation.scope_mode = 'Chat'; conversation.task_id = null;
    chatState.getConversationRuntime.mockImplementation(() => ({ phase: 'streaming' }));
    sendMessage.mockClear();
    const guard = { assertCurrent: () => undefined, authorizeBeforeEffect: async () => undefined };
    await expect(desktopActions.sendConversation(conversation.id, 'Next', guard)).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
