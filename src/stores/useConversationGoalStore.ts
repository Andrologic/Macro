import { create } from 'zustand';
import type {
  ConversationGoalOperationalStatus,
  ConversationGoalRecord,
  ConversationGoalVerdict,
  ReasoningEffort,
} from '../types';

interface ActivateConversationGoalInput {
  conversationId: string;
  objective: string;
  providerId?: string | null;
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}

interface ConversationGoalState {
  goalsByConversationId: Record<string, ConversationGoalRecord>;
  activateGoal: (input: ActivateConversationGoalInput) => ConversationGoalRecord;
  setOperationalStatus: (
    conversationId: string,
    status: ConversationGoalOperationalStatus,
    reason?: string | null,
  ) => void;
  applyAuditorVerdict: (
    conversationId: string,
    verdict: ConversationGoalVerdict,
  ) => void;
  clearGoal: (conversationId: string) => void;
}

const createGoalId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const updateGoal = (
  goal: ConversationGoalRecord,
  patch: Partial<ConversationGoalRecord>,
): ConversationGoalRecord => ({
  ...goal,
  ...patch,
  revision: goal.revision + 1,
  updatedAt: new Date().toISOString(),
});

export const useConversationGoalStore = create<ConversationGoalState>((set) => ({
  goalsByConversationId: {},

  activateGoal: (input) => {
    const now = new Date().toISOString();
    const goal: ConversationGoalRecord = {
      conversationId: input.conversationId,
      goalId: createGoalId(),
      revision: 1,
      status: 'active_ready',
      objective: input.objective.trim(),
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      createdAt: now,
      updatedAt: now,
      lastAuditedAt: null,
      lastExecutorTurnAt: null,
      awaitingUserSinceAt: null,
      executorTurnCount: 0,
      auditCount: 0,
      continuationCount: 0,
      latestVerdict: null,
      lastError: null,
    };

    set((state) => ({
      goalsByConversationId: {
        ...state.goalsByConversationId,
        [input.conversationId]: goal,
      },
    }));
    return goal;
  },

  setOperationalStatus: (conversationId, status, reason = null) => {
    set((state) => {
      const goal = state.goalsByConversationId[conversationId];
      if (!goal || goal.status === 'achieved') return state;

      const now = new Date().toISOString();
      return {
        goalsByConversationId: {
          ...state.goalsByConversationId,
          [conversationId]: updateGoal(goal, {
            status,
            lastError: status === 'error' ? reason : null,
            lastExecutorTurnAt:
              status === 'audit_pending' ? now : goal.lastExecutorTurnAt,
            executorTurnCount:
              status === 'audit_pending'
                ? goal.executorTurnCount + 1
                : goal.executorTurnCount,
          }),
        },
      };
    });
  },

  applyAuditorVerdict: (conversationId, verdict) => {
    set((state) => {
      const goal = state.goalsByConversationId[conversationId];
      if (!goal || goal.status === 'achieved') return state;

      const now = new Date().toISOString();
      const status: ConversationGoalRecord['status'] =
        verdict.verdict === 'achieved'
          ? 'achieved'
          : verdict.verdict === 'needs_user'
            ? 'awaiting_user'
            : verdict.verdict === 'continue'
              ? 'continuation_pending'
              : 'paused';

      return {
        goalsByConversationId: {
          ...state.goalsByConversationId,
          [conversationId]: updateGoal(goal, {
            status,
            latestVerdict: verdict,
            lastAuditedAt: now,
            awaitingUserSinceAt: status === 'awaiting_user' ? now : null,
            auditCount: goal.auditCount + 1,
            continuationCount:
              status === 'continuation_pending'
                ? goal.continuationCount + 1
                : goal.continuationCount,
            lastError: null,
          }),
        },
      };
    });
  },

  clearGoal: (conversationId) => {
    set((state) => {
      if (!state.goalsByConversationId[conversationId]) return state;
      const goalsByConversationId = { ...state.goalsByConversationId };
      delete goalsByConversationId[conversationId];
      return { goalsByConversationId };
    });
  },
}));
