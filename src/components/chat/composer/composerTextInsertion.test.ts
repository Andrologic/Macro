import { describe, expect, it } from 'bun:test';
import { prepareContextualTextInsertion } from './composerTextInsertion';

describe('prepareContextualTextInsertion', () => {
  it('separates dictated text from surrounding words', () => {
    expect(prepareContextualTextInsertion({
      text: 'nouveau texte',
      before: 'Bonjour',
      after: 'monde',
    })).toBe(' nouveau texte ');
  });

  it('does not duplicate whitespace already around the selection', () => {
    expect(prepareContextualTextInsertion({
      text: '  Macro  ',
      before: 'Bonjour ',
      after: ' monde',
    })).toBe('Macro');
  });

  it('keeps punctuation attached to the preceding text', () => {
    expect(prepareContextualTextInsertion({
      text: ' !',
      before: 'Bonjour',
      after: '',
    })).toBe('!');
  });

  it('does not add a trailing space before closing punctuation', () => {
    expect(prepareContextualTextInsertion({
      text: 'Macro',
      before: 'Bonjour ',
      after: '.',
    })).toBe('Macro');
  });
});
