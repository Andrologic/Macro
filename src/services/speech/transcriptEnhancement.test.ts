import { describe, expect, it } from 'bun:test';
import {
  buildSpeechEnhancementPayload,
  validateEnhancedTranscript,
} from './transcriptEnhancement';

describe('speech transcript enhancement safeguards', () => {
  it('keeps context compact and serializes the transcript as data', () => {
    const payload = buildSpeechEnhancementPayload('Alors euh corrige Macro.', {
      mode: 'Architect',
      language: 'fr',
      projectName: 'Macro',
      planName: 'Dictée vocale',
      draftText: 'Début du prompt',
      recentMessages: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Message ${index}`,
      })),
    });

    const parsed = JSON.parse(payload) as {
      transcript: string;
      context: { recentMessages: Array<{ role: string; content: string }> };
    };
    expect(parsed.transcript).toBe('Alors euh corrige Macro.');
    expect(parsed.context.recentMessages).toEqual([
      { role: 'user', content: 'Message 6' },
      { role: 'assistant', content: 'Message 7' },
    ]);
  });

  it('accepts a light correction and removes a presentation wrapper', () => {
    expect(validateEnhancedTranscript(
      '```json\n{"text":"Je veux corriger le worktree de Macro."}\n```',
    )).toBe('Je veux corriger le worktree de Macro.');
  });

  it('accepts substantial rewrites without length or token-overlap heuristics', () => {
    expect(validateEnhancedTranscript('Corriger la fonctionnalité sans perdre ses contraintes.')).toBe(
      'Corriger la fonctionnalité sans perdre ses contraintes.',
    );
    const expanded = 'Je souhaite corriger cette fonctionnalité, clarifier son comportement et conserver précisément les contraintes exprimées dans la demande initiale.';
    expect(validateEnhancedTranscript(expanded)).toBe(expanded);
  });

  it('removes provider reasoning before parsing the cleaned transcript', () => {
    expect(validateEnhancedTranscript(
      '<think>Je dois identifier le terme technique probable.</think>\n{"text":"Je veux corriger le worktree."}',
    )).toBe('Je veux corriger le worktree.');
  });

  it('falls back only when the model produces no usable transcript', () => {
    expect(() => validateEnhancedTranscript('')).toThrow(
      'The enhancement model returned an empty transcript.',
    );
    expect(() => validateEnhancedTranscript(
      '<think>Réflexion interrompue sans réponse finale.',
    )).toThrow('The enhancement model returned an empty transcript.');
  });
});
