import { describe, expect, it } from 'bun:test';
import { parseConversationGoalCommand } from './conversationGoalCommand';

describe('parseConversationGoalCommand', () => {
  it('extracts a goal objective without keeping the command prefix', () => {
    expect(parseConversationGoalCommand('/goal Corriger les erreurs de connexion')).toEqual({
      kind: 'activate',
      objective: 'Corriger les erreurs de connexion',
    });
  });

  it('reports a missing objective', () => {
    expect(parseConversationGoalCommand('  /goal  ')).toEqual({
      kind: 'missing_objective',
    });
  });

  it('leaves ordinary messages and similar prefixes untouched', () => {
    expect(parseConversationGoalCommand('/goals list')).toBeNull();
    expect(parseConversationGoalCommand('Explain /goal behavior')).toBeNull();
  });
});
