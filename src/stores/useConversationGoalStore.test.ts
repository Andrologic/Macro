import { beforeEach, describe, expect, it } from 'bun:test';
import type { ConversationGoalVerdict } from '../types';
import { useConversationGoalStore } from './useConversationGoalStore';

const achievedVerdict: ConversationGoalVerdict = {
  verdict: 'achieved',
  summary: 'All required outcomes are verified.',
  criteria: [],
  feedback: '',
  questionForUser: null,
  confidence: 0.96,
};

describe('useConversationGoalStore', () => {
  beforeEach(() => {
    useConversationGoalStore.setState({ goalsByConversationId: {} });
  });

  it('creates an active goal without accepting a caller-controlled status', () => {
    useConversationGoalStore.getState().activateGoal({
      conversationId: 'conversation-1',
      objective: '  Finish the migration  ',
    });

    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1'],
    ).toMatchObject({
      objective: 'Finish the migration',
      revision: 1,
      status: 'active_ready',
    });
  });

  it('only reaches achieved through an auditor verdict', () => {
    const store = useConversationGoalStore.getState();
    const goal = store.activateGoal({
      conversationId: 'conversation-1',
      objective: 'Ship it',
    });
    store.setOperationalStatus('conversation-1', 'paused');

    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1']?.status,
    ).toBe('paused');

    useConversationGoalStore
      .getState()
      .applyAuditorVerdictIfCurrent(
        'conversation-1',
        goal.goalId,
        goal.revision + 1,
        achievedVerdict,
      );

    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1']?.status,
    ).toBe('achieved');
  });

  it('does not let operational updates reopen an achieved goal', () => {
    const store = useConversationGoalStore.getState();
    const goal = store.activateGoal({
      conversationId: 'conversation-1',
      objective: 'Ship it',
    });
    store.applyAuditorVerdictIfCurrent(
      'conversation-1',
      goal.goalId,
      goal.revision,
      achievedVerdict,
    );
    useConversationGoalStore
      .getState()
      .setOperationalStatus('conversation-1', 'active_ready');

    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1']?.status,
    ).toBe('achieved');
  });

  it('applies an auditor verdict only to the expected goal revision', () => {
    const store = useConversationGoalStore.getState();
    const goal = store.activateGoal({
      conversationId: 'conversation-1',
      objective: 'Ship it',
    });

    expect(
      useConversationGoalStore.getState().applyAuditorVerdictIfCurrent(
        'conversation-1',
        goal.goalId,
        goal.revision + 1,
        achievedVerdict,
      ),
    ).toBe(false);
    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1'],
    ).toMatchObject({ revision: goal.revision, status: 'active_ready', auditCount: 0 });

    expect(
      useConversationGoalStore.getState().applyAuditorVerdictIfCurrent(
        'conversation-1',
        goal.goalId,
        goal.revision,
        achievedVerdict,
      ),
    ).toBe(true);
    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1'],
    ).toMatchObject({ revision: goal.revision + 1, status: 'achieved', auditCount: 1 });
  });

  it('does not expose a non-CAS auditor verdict action', () => {
    expect(useConversationGoalStore.getState()).not.toHaveProperty(
      'applyAuditorVerdict',
    );
  });

  it('rolls back a Goal edit without exposing the previous record to callers', () => {
    const store = useConversationGoalStore.getState();
    const previousGoal = store.activateGoal({
      conversationId: 'conversation-1',
      objective: 'Original objective',
    });
    const transaction = store.beginGoalEdit({
      conversationId: 'conversation-1',
      objective: 'Edited objective',
      expectedGoalId: previousGoal.goalId,
    });

    expect(transaction).not.toBeNull();
    expect(
      useConversationGoalStore.getState().settleGoalEdit(
        transaction?.transactionId ?? '',
        'rollback',
      ),
    ).toBe(true);
    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1'],
    ).toEqual(previousGoal);

    expect(useConversationGoalStore.getState()).not.toHaveProperty(
      'restoreGoalIfCurrent',
    );
  });

  it('settles Goal edits once and never rolls back over a newer Goal', () => {
    const store = useConversationGoalStore.getState();
    const previousGoal = store.activateGoal({
      conversationId: 'conversation-1',
      objective: 'Original objective',
    });
    const transaction = store.beginGoalEdit({
      conversationId: 'conversation-1',
      objective: 'Edited objective',
      expectedGoalId: previousGoal.goalId,
    });
    expect(transaction).not.toBeNull();

    const newerGoal = store.activateGoal({
      conversationId: 'conversation-1',
      objective: 'Newer objective',
    });
    expect(
      useConversationGoalStore.getState().settleGoalEdit(
        transaction?.transactionId ?? '',
        'rollback',
      ),
    ).toBe(false);
    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1'],
    ).toEqual(newerGoal);
    expect(
      useConversationGoalStore.getState().settleGoalEdit(
        transaction?.transactionId ?? '',
        'rollback',
      ),
    ).toBe(false);
  });

  it('commits a Goal edit without allowing a later rollback', () => {
    const store = useConversationGoalStore.getState();
    const previousGoal = store.activateGoal({
      conversationId: 'conversation-1',
      objective: 'Original objective',
    });
    const transaction = store.beginGoalEdit({
      conversationId: 'conversation-1',
      objective: 'Edited objective',
      expectedGoalId: previousGoal.goalId,
    });
    if (!transaction) throw new Error('Expected a Goal edit transaction');

    expect(
      store.settleGoalEdit(transaction.transactionId, 'commit'),
    ).toBe(true);
    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1'],
    ).toEqual(transaction.goal);
    expect(
      store.settleGoalEdit(transaction.transactionId, 'rollback'),
    ).toBe(false);
  });
});
