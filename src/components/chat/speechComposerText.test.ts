import { describe, expect, it } from 'bun:test';
import {
  locateSpeechComposerInsertion,
  replaceSpeechComposerInsertion,
} from './speechComposerText';

describe('speech composer text', () => {
  it('locates a contextual insertion and replaces only the transcript', () => {
    const insertion = locateSpeechComposerInsertion(
      'Avant après',
      'Avant transcription brute après',
      'transcription brute',
    );

    expect(insertion).not.toBeNull();
    expect(replaceSpeechComposerInsertion(
      'Avant transcription brute après',
      insertion!,
      'transcription corrigée',
    )).toBe('Avant transcription corrigée après');
  });

  it('does not overwrite text that changed while cleanup was running', () => {
    const insertion = locateSpeechComposerInsertion('', 'texte brut', 'texte brut');

    expect(replaceSpeechComposerInsertion('texte modifié', insertion!, 'texte corrigé')).toBeNull();
  });
});
