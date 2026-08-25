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

interface BeginConversationGoalEditInput extends ActivateConversationGoalInput {
  expectedGoalId: string;
}

interface ConversationGoalEditTransaction {
  transactionId: string;
  goal: ConversationGoalRecord;
}

interface PendingConversationGoalEdit {
  conversationId: string;
  previousGoal: ConversationGoalRecord;
  replacementGoalId: string;
}

interface ConversationGoalState {
  goalsByConversationId: Record<string, ConversationGoalRecord>;
  activateGoal: (input: ActivateConversationGoalInput) => ConversationGoalRecord;
  beginGoalEdit: (
    input: BeginConversationGoalEditInput,
  ) => ConversationGoalEditTransaction | null;
  settleGoalEdit: (
    transactionId: string,
    outcome: 'commit' | 'rollback',
  ) => boolean;
  setOperationalStatus: (
    conversationId: string,
    status: ConversationGoalOperationalStatus,
    reason?: string | null,
  ) => void;
  applyAuditorVerdictIfCurrent: (
    conversationId: string,
    goalId: string,
    expectedRevision: number,
    verdict: ConversationGoalVerdict,
  ) => boolean;
  clearGoal: (conversationId: string) => void;
}

const createGoalId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const pendingGoalEdits = new Map<string, PendingConversationGoalEdit>();

const createGoal = (
  input: ActivateConversationGoalInput,
): ConversationGoalRecord => {
  const now = new Date().toISOString();
  return {
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
};

const updateGoal = (
  goal: ConversationGoalRecord,
  patch: Partial<ConversationGoalRecord>,
): ConversationGoalRecord => ({
  ...goal,
  ...patch,
  revision: goal.revision + 1,
  updatedAt: new Date().toISOString(),
});

const applyVerdictToGoal = (
  goal: ConversationGoalRecord,
  verdict: ConversationGoalVerdict,
): ConversationGoalRecord => {
  const now = new Date().toISOString();
  const status: ConversationGoalRecord['status'] =
    verdict.verdict === 'achieved'
      ? 'achieved'
      : verdict.verdict === 'needs_user'
        ? 'awaiting_user'
        : verdict.verdict === 'continue'
          ? 'continuation_pending'
          : 'paused';

  return updateGoal(goal, {
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
  });
};

export const useConversationGoalStore = create<ConversationGoalState>((set) => ({
  goalsByConversationId: {},

  activateGoal: (input) => {
    const goal = createGoal(input);

    set((state) => ({
      goalsByConversationId: {
        ...state.goalsByConversationId,
        [input.conversationId]: goal,
      },
    }));
    return goal;
  },

  beginGoalEdit: (input) => {
    let transaction: ConversationGoalEditTransaction | null = null;
    set((state) => {
      const previousGoal = state.goalsByConversationId[input.conversationId];
      if (!previousGoal || previousGoal.goalId !== input.expectedGoalId) {
        return state;
      }

      const goal = createGoal(input);
      const transactionId = createGoalId();
      pendingGoalEdits.set(transactionId, {
        conversationId: input.conversationId,
        previousGoal,
        replacementGoalId: goal.goalId,
      });
      transaction = { transactionId, goal };
      return {
        goalsByConversationId: {
          ...state.goalsByConversationId,
          [input.conversationId]: goal,
        },
      };
    });
    return transaction;
  },

  settleGoalEdit: (transactionId, outcome) => {
    const pendingEdit = pendingGoalEdits.get(transactionId);
    if (!pendingEdit) return false;
    pendingGoalEdits.delete(transactionId);

    let settled = false;
    set((state) => {
      const currentGoal = state.goalsByConversationId[pendingEdit.conversationId];
      if (!currentGoal || currentGoal.goalId !== pendingEdit.replacementGoalId) {
        return state;
      }
      settled = true;
      if (outcome === 'commit') return state;
      return {
        goalsByConversationId: {
          ...state.goalsByConversationId,
          [pendingEdit.conversationId]: pendingEdit.previousGoal,
        },
      };
    });
    return settled;
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

  applyAuditorVerdictIfCurrent: (
    conversationId,
    goalId,
    expectedRevision,
    verdict,
  ) => {
    let applied = false;
    set((state) => {
      const goal = state.goalsByConversationId[conversationId];
      if (
        !goal ||
        goal.status === 'achieved' ||
        goal.goalId !== goalId ||
        goal.revision !== expectedRevision
      ) {
        return state;
      }
      applied = true;
      return {
        goalsByConversationId: {
          ...state.goalsByConversationId,
          [conversationId]: applyVerdictToGoal(goal, verdict),
        },
      };
    });
    return applied;
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
