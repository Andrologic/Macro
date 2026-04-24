import { describe, expect, it } from 'bun:test';
import {
  formatGeneratedCommitMessageForRepository,
  validateGeneratedCommitMessages,
} from './smartCommitMessageGenerator';

describe('smartCommitMessageGenerator', () => {
  it('validates generated messages for the expected repositories', () => {
    const generated = validateGeneratedCommitMessages(
      {
        title: 'feat: improve checkout',
        repositories: [
          {
            repositoryId: 'api',
            body: 'Update checkout endpoints.',
          },
          {
            repositoryId: 'mobile',
            subject: 'Mobile polish',
            body: 'Wire the checkout screen to the new flow.',
          },
        ],
      },
      ['api', 'mobile']
    );

    expect(formatGeneratedCommitMessageForRepository(generated, 'api')).toBe(
      'feat: improve checkout\n\nUpdate checkout endpoints.'
    );
    expect(formatGeneratedCommitMessageForRepository(generated, 'mobile')).toBe(
      'feat: improve checkout\n\nMobile polish\n\nWire the checkout screen to the new flow.'
    );
  });

  it('rejects generated messages that miss a repository', () => {
    expect(() =>
      validateGeneratedCommitMessages(
        {
          title: 'feat: improve checkout',
          repositories: [
            {
              repositoryId: 'api',
              body: 'Update checkout endpoints.',
            },
          ],
        },
        ['api', 'mobile']
      )
    ).toThrow('missing repositories');
  });

  it('rejects generated messages that mention an out-of-scope repository', () => {
    expect(() =>
      validateGeneratedCommitMessages(
        {
          title: 'feat: improve checkout',
          repositories: [
            {
              repositoryId: 'api',
              body: 'Update checkout endpoints.',
            },
            {
              repositoryId: 'web',
              body: 'Unexpected web changes.',
            },
          ],
        },
        ['api', 'mobile']
      )
    ).toThrow('unexpected repository');
  });
});
