import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { buildImplementKickoffPrompt } from '../implementKickoff';
import { PilotConversationSendPreflightRejection, PilotError, stableJson } from './protocol';
import { pilotStartRejection, PilotStartPreflightRejection } from './startEligibility';
import {
  assertPilotReservationCurrent,
  reservePilotAction,
  type PilotActionReservation,
} from './actionReservations';

export interface DesktopActionGuard {
  assertCurrent(): void;
  authorizeBeforeEffect(options?: {
    revision: 'expected' | 'consumed';
  }): Promise<void>;
}

export interface DesktopDecisionRef {
  conversation_id: string;
  assistant_message_id: string;
  task_id?: string;
}

export interface DesktopDecisionAnswer {
  step_id: string;
  answer: string;
}

export interface DesktopToolApprovalRef {
  conversation_id: string;
  assistant_message_id: string;
  tool_call_id: string;
}

export type DesktopToolApprovalPayload =
  | { verdict: 'approve'; grant_scope: 'once' | 'conversation' }
  | { verdict: 'deny'; reason?: string };

export interface DesktopActions {
  sendConversation(conversationId: string, content: string, guard: DesktopActionGuard): Promise<void>;
  start(taskId: string, guard: DesktopActionGuard): Promise<{
    conversationId: string;
    startedAt: string;
    assistantMessageId: string;
  }>;
  reply(
    taskId: string,
    conversationId: string,
    answer: string,
    guard: DesktopActionGuard,
  ): Promise<void>;
  answerDecision(
    ref: DesktopDecisionRef,
    answers: DesktopDecisionAnswer[],
    guard: DesktopActionGuard,
  ): Promise<void>;
  resolveApproval(
    ref: DesktopToolApprovalRef,
    payload: DesktopToolApprovalPayload,
    guard: DesktopActionGuard,
  ): Promise<void>;
  cancel(conversationId: string, guard: DesktopActionGuard): Promise<void>;
}

const invalidReference = (): never => {
  throw new PilotError('invalid_reference');
};

const unavailable = (): never => {
  throw new PilotError('unavailable');
};

const createEffectGate = (
  guard: DesktopActionGuard,
  reservation: PilotActionReservation,
) => {
  let authorized = false;
  return {
    assertPreparing: () => {
      assertPilotReservationCurrent(reservation);
      if (!authorized) guard.assertCurrent();
    },
    beforeEffect: async () => {
      assertPilotReservationCurrent(reservation);
      if (!authorized) {
        guard.assertCurrent();
        await guard.authorizeBeforeEffect({ revision: 'expected' });
        guard.assertCurrent();
        assertPilotReservationCurrent(reservation);
        authorized = true;
        return;
      }
      await guard.authorizeBeforeEffect({ revision: 'consumed' });
      assertPilotReservationCurrent(reservation);
    },
  };
};

const requireTaskConversation = (taskId: string, conversationId: string) => {
  const conversation = useChatStore.getState().conversations.find(
    (candidate) => candidate.id === conversationId,
  );
  if (!conversation || conversation.task_id !== taskId) return invalidReference();
  return conversation;
};

const requireConversationProvider = (
  conversation: ReturnType<typeof requireTaskConversation>,
): void => {
  if (!conversation.provider_id || !conversation.model_id) unavailable();
};

const projectScopeForTask = (task: ReturnType<typeof useTaskStore.getState>['tasks'][number]) => {
  const app = useAppStore.getState();
  const projectIds = Array.from(new Set([
    ...(task.execution_targets?.map((target) => target.projectId) ?? []),
    ...(task.project_ids ?? []),
    task.project_id,
  ].filter(Boolean)));
  return projectIds
    .map((projectId) => app.getProjectById(projectId)?.name ?? projectId)
    .join(', ');
};

export const desktopActions: DesktopActions = {
  sendConversation: async (conversationId, content, guard) => {
    if (!content.trim()) invalidReference();
    const reservation = reservePilotAction({ conversationId });
    const gate = createEffectGate(guard, reservation);
    let sendInvoked = false;
    try {
      gate.assertPreparing();
      const chat = useChatStore.getState();
      const conversation = chat.conversations.find(candidate => candidate.id === conversationId);
      if (!conversation || conversation.scope_mode !== 'Chat' || conversation.task_id) return invalidReference();
      requireConversationProvider(conversation);
      const configuration = (value: typeof conversation) => stableJson({
        scope: value.scope_mode, task: value.task_id, project: value.project_id, group: value.group_id,
        provider: value.provider_id, model: value.model_id, reasoning: value.reasoning_effort,
      });
      const expectedConfiguration = configuration(conversation);
      const assertTarget = () => {
        const current = useChatStore.getState();
        const target = current.conversations.find(candidate => candidate.id === conversationId);
        if (!target || configuration(target) !== expectedConfiguration) throw new PilotError('stale_revision');
        if (current.getActiveQuestionnaire(conversationId) || current.getPendingToolApproval(conversationId)) throw new PilotError('conflict');
      };
      assertTarget();
      const phase = chat.getConversationRuntime(conversationId).phase;
      if (phase !== 'idle' && phase !== 'error') throw new PilotError('conflict');
      await gate.beforeEffect();
      assertTarget();
      const phaseAfterAuthorization = useChatStore.getState().getConversationRuntime(conversationId).phase;
      if (phaseAfterAuthorization !== 'idle' && phaseAfterAuthorization !== 'error') throw new PilotError('conflict');
      sendInvoked = true;
      const result = await useChatStore.getState().sendMessage({
        conversationId, content: content.trim(), contextRefs: [],
        pilotTarget: { mode: 'Chat', actionToken: reservation.token, beforeEffect: async () => {
          assertTarget();
          await gate.beforeEffect();
          assertTarget();
        } },
      });
      if (result.status !== 'sent') unavailable();
    } catch (error) {
      if (!sendInvoked && error instanceof PilotError) throw new PilotConversationSendPreflightRejection(error.code);
      throw error;
    } finally { reservation.release(); }
  },
  start: async (taskId, guard) => {
    const reservation = reservePilotAction({ taskId });
    const gate = createEffectGate(guard, reservation);
    try {
      gate.assertPreparing();
      const task = useTaskStore.getState().getTaskById(taskId);
      const rejection = pilotStartRejection(task);
      if (rejection) throw new PilotStartPreflightRejection(rejection);

      await gate.beforeEffect();
      const conversation = await useChatStore
        .getState()
        .ensurePilotTaskConversation(taskId, reservation.token);
      reservation.reserveConversation(conversation.id);
      assertPilotReservationCurrent(reservation);
      requireConversationProvider(conversation);

      await useTaskStore.getState().startTask(taskId, {
        pilotActionToken: reservation.token,
        beforeEffect: gate.beforeEffect,
      });
      assertPilotReservationCurrent(reservation);
      const readyTask = useTaskStore.getState().getTaskById(taskId);
      if (!readyTask || readyTask.status !== 'InProgress' || readyTask.is_blocked) {
        return unavailable();
      }
      const currentConversation = requireTaskConversation(taskId, conversation.id);
      requireConversationProvider(currentConversation);

      const startedAt = new Date().toISOString();
      const result = await useChatStore.getState().sendMessage({
        conversationId: conversation.id,
        taskId,
        content: buildImplementKickoffPrompt({
          title: readyTask.title,
          description: readyTask.description,
          projectScope: projectScopeForTask(readyTask),
          branchName: readyTask.branch_name || readyTask.assigned_branch,
          dependencies: readyTask.dependencies,
          estimatedChanges: readyTask.estimated_changes,
        }),
        pilotTarget: {
          taskId,
          actionToken: reservation.token,
          beforeEffect: gate.beforeEffect,
        },
      });
      if (result.status !== 'sent' || !result.assistantMessageId) return unavailable();
      const assistantMessageId = result.assistantMessageId;
      return {
        conversationId: conversation.id,
        startedAt,
        assistantMessageId,
      };
    } finally {
      reservation.release();
    }
  },

  reply: async (taskId, conversationId, answer, guard) => {
    const normalizedAnswer = answer.trim();
    if (!normalizedAnswer) invalidReference();
    const reservation = reservePilotAction({ taskId, conversationId });
    const gate = createEffectGate(guard, reservation);
    try {
      gate.assertPreparing();
      const conversation = requireTaskConversation(taskId, conversationId);
      requireConversationProvider(conversation);
      await gate.beforeEffect();
      const result = await useChatStore.getState().sendMessage({
        conversationId,
        taskId,
        content: normalizedAnswer,
        pilotTarget: {
          taskId,
          actionToken: reservation.token,
          beforeEffect: gate.beforeEffect,
        },
      });
      if (result.status !== 'sent') unavailable();
    } finally {
      reservation.release();
    }
  },

  answerDecision: async (ref, answers, guard) => {
    const reservation = reservePilotAction({
      taskId: ref.task_id,
      conversationId: ref.conversation_id,
    });
    const gate = createEffectGate(guard, reservation);
    try {
      gate.assertPreparing();
      const questionnaire = useChatStore.getState().getActiveQuestionnaire(ref.conversation_id);
      if (!questionnaire || questionnaire.assistantMessageId !== ref.assistant_message_id) {
        return invalidReference();
      }
      if (ref.task_id && questionnaire.taskId !== ref.task_id) invalidReference();
      const supplied = new Map(answers.map((answer) => [answer.step_id, answer.answer]));
      if (supplied.size !== answers.length || supplied.size !== questionnaire.totalSteps) {
        invalidReference();
      }
      for (const step of questionnaire.questionnaire.questions) {
        if (!supplied.get(step.id)?.trim()) invalidReference();
      }

      await gate.beforeEffect();
      const chat = useChatStore.getState();
      for (let index = 0; index < questionnaire.questionnaire.questions.length; index += 1) {
        const step = questionnaire.questionnaire.questions[index]!;
        chat.setActiveQuestionnaireStep(ref.conversation_id, index);
        if (!chat.recordActiveQuestionnaireAnswer(ref.conversation_id, supplied.get(step.id)!)) {
          invalidReference();
        }
      }
      const result = await chat.submitActiveQuestionnaire(ref.conversation_id, {
        taskId: ref.task_id ?? questionnaire.taskId,
        pilotActionToken: reservation.token,
        beforeEffect: gate.beforeEffect,
      });
      if (!result || result.status !== 'sent') unavailable();
    } finally {
      reservation.release();
    }
  },

  resolveApproval: async (ref, payload, guard) => {
    const reservation = reservePilotAction({ conversationId: ref.conversation_id });
    const gate = createEffectGate(guard, reservation);
    try {
      gate.assertPreparing();
      const approval = useChatStore.getState().getPendingToolApproval(ref.conversation_id);
      if (
        !approval ||
        approval.assistantMessageId !== ref.assistant_message_id ||
        approval.toolCallId !== ref.tool_call_id ||
        approval.recoveryState === 'interrupted'
      ) {
        return invalidReference();
      }
      if (payload.verdict === 'approve' && payload.grant_scope === 'conversation' &&
        approval.canApproveForConversation === false) {
        invalidReference();
      }

      await gate.beforeEffect();
      const current = useChatStore.getState().getPendingToolApproval(ref.conversation_id);
      if (current !== approval) invalidReference();
      const chat = useChatStore.getState();
      const resolution = payload.verdict === 'deny'
        ? { kind: 'deny' as const, reason: payload.reason }
        : { kind: payload.grant_scope === 'conversation'
          ? 'allow_conversation' as const
          : 'allow_once' as const };
      const settled = await chat.resolvePendingToolApprovalForPilot({
        conversationId: ref.conversation_id,
        assistantMessageId: ref.assistant_message_id,
        toolCallId: ref.tool_call_id,
        resolution,
        pilotActionToken: reservation.token,
        beforeEffect: gate.beforeEffect,
      });
      if (
        settled.kind === 'expired' ||
        (payload.verdict === 'approve' && settled.kind === 'deny')
      ) {
        unavailable();
      }
    } finally {
      reservation.release();
    }
  },

  cancel: async (conversationId, guard) => {
    const reservation = reservePilotAction({ conversationId });
    const gate = createEffectGate(guard, reservation);
    try {
      gate.assertPreparing();
      const chat = useChatStore.getState();
      if (!chat.conversations.some((conversation) => conversation.id === conversationId)) {
        invalidReference();
      }
      const runtime = chat.getConversationRuntime(conversationId);
      if (runtime.phase !== 'preparing' && runtime.phase !== 'streaming') unavailable();
      await gate.beforeEffect();
      useChatStore.getState().stopConversationStream(conversationId, reservation.token);
    } finally {
      reservation.release();
    }
  },
};
