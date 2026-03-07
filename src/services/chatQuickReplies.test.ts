import { describe, expect, it } from 'bun:test';
import { parseMessageQuickReplies } from './chatQuickReplies';

describe('parseMessageQuickReplies', () => {
  it('extracts exactly three quick replies and removes the block from content', () => {
    const parsed = parseMessageQuickReplies([
      'Need one clarification before I continue.',
      '',
      '[quick-replies]',
      '- Use Stripe',
      '- Use Lemon Squeezy',
      '- Keep the current provider',
      '[/quick-replies]',
    ].join('\n'));

    expect(parsed.content).toBe('Need one clarification before I continue.');
    expect(parsed.allowFreeResponse).toBe(true);
    expect(parsed.choices?.map((choice) => choice.text)).toEqual([
      'Use Stripe',
      'Use Lemon Squeezy',
      'Keep the current provider',
    ]);
  });

  it('ignores malformed blocks that do not contain exactly three options', () => {
    const parsed = parseMessageQuickReplies([
      'Question',
      '',
      '[quick-replies]',
      '- Only one option',
      '[/quick-replies]',
    ].join('\n'));

    expect(parsed.content).toBe('Question');
    expect(parsed.choices).toBeUndefined();
  });
});
