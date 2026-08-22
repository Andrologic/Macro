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
    store.activateGoal({ conversationId: 'conversation-1', objective: 'Ship it' });
    store.setOperationalStatus('conversation-1', 'paused');

    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1']?.status,
    ).toBe('paused');

    useConversationGoalStore
      .getState()
      .applyAuditorVerdict('conversation-1', achievedVerdict);

    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1']?.status,
    ).toBe('achieved');
  });

  it('does not let operational updates reopen an achieved goal', () => {
    const store = useConversationGoalStore.getState();
    store.activateGoal({ conversationId: 'conversation-1', objective: 'Ship it' });
    store.applyAuditorVerdict('conversation-1', achievedVerdict);
    useConversationGoalStore
      .getState()
      .setOperationalStatus('conversation-1', 'active_ready');

    expect(
      useConversationGoalStore.getState().goalsByConversationId['conversation-1']?.status,
    ).toBe('achieved');
  });
});
