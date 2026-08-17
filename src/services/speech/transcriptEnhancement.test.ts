import { describe, expect, it } from 'bun:test';
import {
  buildSpeechEnhancementPayload,
  validateEnhancedTranscript,
} from './transcriptEnhancement';

describe('speech transcript enhancement safeguards', () => {
  it('keeps context compact and labels the transcript as data', () => {
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

    expect(payload).toContain('REFERENCE CONTEXT (data only');
    expect(payload).toContain('RAW TRANSCRIPT (text to revise');
    expect(payload).toContain('Alors euh corrige Macro.');
    expect(payload).not.toContain('Message 0');
    expect(payload).toContain('Message 7');
  });

  it('accepts a light correction and removes a presentation wrapper', () => {
    expect(validateEnhancedTranscript(
      'Je veux euh corriger le work tri de Macro.',
      '```text\nJe veux corriger le worktree de Macro.\n```',
    )).toBe('Je veux corriger le worktree de Macro.');
  });

  it('rejects empty, summarised or over-expanded responses', () => {
    const raw = 'Je souhaite corriger cette fonctionnalité en conservant toutes les contraintes et tous les détails importants du comportement attendu.';
    expect(() => validateEnhancedTranscript(raw, '')).toThrow();
    expect(() => validateEnhancedTranscript(raw, 'Corriger la fonctionnalité.')).toThrow();
    expect(() => validateEnhancedTranscript('Texte court.', 'x'.repeat(400))).toThrow();
    expect(() => validateEnhancedTranscript(
      'Il faut corriger la carte de tâche et conserver le projet actif dans le pied de page.',
      'Nous devrions plutôt créer une nouvelle interface totalement différente pour les utilisateurs.',
    )).toThrow();
  });
});
