import { describe, expect, it } from 'bun:test';
import {
  SmartCommitMessageGenerationError,
  formatGeneratedCommitMessageForRepository,
  parseGeneratedCommitMessages,
  stripGeneratedCommitScopes,
  validateGeneratedCommitMessages,
} from './smartCommitMessageGenerator';
import { validateConventionalCommitMessage } from './conventionalCommit';

describe('smartCommitMessageGenerator', () => {
  it('validates conventional commit messages with the backend-compatible rule', () => {
    expect(validateConventionalCommitMessage('feat: add checkout').ok).toBe(true);
    expect(validateConventionalCommitMessage('fix(api): refresh checkout').ok).toBe(true);
    expect(validateConventionalCommitMessage('chore!: migrate metadata').ok).toBe(true);
    expect(validateConventionalCommitMessage('build(deps): update tauri').ok).toBe(true);
    expect(validateConventionalCommitMessage('ci: update release workflow').ok).toBe(true);
    expect(validateConventionalCommitMessage('revert: restore previous behavior').ok).toBe(true);

    expect(validateConventionalCommitMessage('add checkout').ok).toBe(false);
    expect(validateConventionalCommitMessage('add checkout').message).toContain('type: subject');
    expect(validateConventionalCommitMessage('fix(api: refresh checkout').message).toContain("close with ')'");
    expect(validateConventionalCommitMessage('feat:add checkout').message).toContain('type: subject');
    expect(validateConventionalCommitMessage('release: bump version').message).toContain('Commit type must be one of');
  });

  it('validates generated messages for the expected repositories', () => {
    const generated = validateGeneratedCommitMessages(
      {
        repositories: [
          {
            repositoryId: 'api',
            type: 'feat',
            scope: 'api',
            subject: 'improve checkout endpoints',
            body: 'Update checkout endpoints.',
          },
          {
            repositoryId: 'mobile',
            type: 'fix',
            scope: null,
            subject: 'wire checkout screen',
            body: 'Wire the checkout screen to the new flow.',
          },
        ],
      },
      ['api', 'mobile']
    );

    expect(formatGeneratedCommitMessageForRepository(generated, 'api')).toBe(
      'feat: improve checkout endpoints\n\nUpdate checkout endpoints.'
    );
    expect(formatGeneratedCommitMessageForRepository(generated, 'mobile')).toBe(
      'fix: wire checkout screen\n\nWire the checkout screen to the new flow.'
    );
  });

  it('rejects generated messages that miss a repository', () => {
    expect(() =>
      validateGeneratedCommitMessages(
        {
          repositories: [
            {
              repositoryId: 'api',
              type: 'feat',
              subject: 'improve checkout endpoints',
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
          repositories: [
            {
              repositoryId: 'api',
              type: 'feat',
              subject: 'improve checkout endpoints',
            },
            {
              repositoryId: 'web',
              type: 'fix',
              subject: 'handle web state',
            },
          ],
        },
        ['api', 'mobile']
      )
    ).toThrow('unexpected repository');
  });

  it('parses json embedded in provider prose', () => {
    const generated = parseGeneratedCommitMessages(
      'Here is the commit message:\n```json\n{"repositories":[{"repositoryId":"api","type":"fix","scope":null,"subject":"handle empty payload","body":null}]}\n```',
      ['api']
    );

    expect(formatGeneratedCommitMessageForRepository(generated, 'api')).toBe(
      'fix: handle empty payload'
    );
  });

  it('parses the valid json block when prose contains other brace pairs', () => {
    const generated = parseGeneratedCommitMessages(
      'I considered {type: fix}.\n```json\n{"repositories":[{"repositoryId":"api","type":"fix","scope":"git","subject":"handle generated commit parsing","body":null}]}\n```\nDone.',
      ['api']
    );

    expect(formatGeneratedCommitMessageForRepository(generated, 'api')).toBe(
      'fix: handle generated commit parsing'
    );
  });

  it('parses a root repository array when the provider omits the wrapper object', () => {
    const generated = parseGeneratedCommitMessages(
      '[{"repositoryId":"api","type":"docs","scope":"readme","subject":"clarify setup","body":null}]',
      ['api']
    );

    expect(formatGeneratedCommitMessageForRepository(generated, 'api')).toBe(
      'docs: clarify setup'
    );
  });

  it('parses a single plain conventional commit as a fallback', () => {
    const generated = parseGeneratedCommitMessages('refactor(core): simplify task state', ['api']);

    expect(formatGeneratedCommitMessageForRepository(generated, 'api')).toBe(
      'refactor: simplify task state'
    );
  });

  it('parses a single conventional commit line inside provider prose', () => {
    const generated = parseGeneratedCommitMessages(
      'Generated commit:\nfeat(changes): improve commit generation',
      ['api']
    );

    expect(formatGeneratedCommitMessageForRepository(generated, 'api')).toBe(
      'feat: improve commit generation'
    );
  });

  it('parses repository-prefixed plain conventional commits as a fallback', () => {
    const generated = parseGeneratedCommitMessages(
      [
        'api: fix(api): validate commit titles',
        'web - chore(ui): update commit modal',
      ].join('\n'),
      ['api', 'web']
    );

    expect(formatGeneratedCommitMessageForRepository(generated, 'api')).toBe(
      'fix: validate commit titles'
    );
    expect(formatGeneratedCommitMessageForRepository(generated, 'web')).toBe(
      'chore: update commit modal'
    );
  });

  it('removes every generated scope before formatting', () => {
    const sanitized = stripGeneratedCommitScopes(
      {
        repositories: [
          {
            repositoryId: 'project-a::feature-task',
            type: 'docs',
            scope: 'project-a',
            subject: 'clarify setup',
            body: null,
          },
          {
            repositoryId: 'project-b::feature-task',
            type: 'fix',
            scope: 'api',
            subject: 'handle empty response',
            body: null,
          },
        ],
      }
    );

    expect(formatGeneratedCommitMessageForRepository(sanitized, 'project-a::feature-task')).toBe(
      'docs: clarify setup'
    );
    expect(formatGeneratedCommitMessageForRepository(sanitized, 'project-b::feature-task')).toBe(
      'fix: handle empty response'
    );
  });

  it('keeps editable generated messages when a repository message is not conventional', () => {
    expect(() =>
      validateGeneratedCommitMessages(
        {
          repositories: [
            {
              repositoryId: 'api',
              type: 'release',
              subject: 'update checkout',
            },
          ],
        },
        ['api']
      )
    ).toThrow(SmartCommitMessageGenerationError);

    try {
      validateGeneratedCommitMessages(
        {
          repositories: [
            {
              repositoryId: 'api',
              type: 'release',
              subject: 'update checkout',
            },
          ],
        },
        ['api']
      );
    } catch (error) {
      expect(error).toBeInstanceOf(SmartCommitMessageGenerationError);
      expect((error as SmartCommitMessageGenerationError).generatedMessages?.repositories[0]?.subject)
        .toBe('update checkout');
    }
  });
});
