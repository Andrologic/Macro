import { describe, expect, it } from 'bun:test';
import { isPrimaryComposerSubmitKey } from './composerSubmitKey';

describe('composer submit key', () => {
  it('reserves modified Enter combinations for secondary shortcuts', () => {
    expect(isPrimaryComposerSubmitKey({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: false })).toBe(true);
    expect(isPrimaryComposerSubmitKey({ shiftKey: false, metaKey: true, ctrlKey: false, altKey: false })).toBe(false);
    expect(isPrimaryComposerSubmitKey({ shiftKey: false, metaKey: false, ctrlKey: true, altKey: false })).toBe(false);
    expect(isPrimaryComposerSubmitKey({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: true })).toBe(false);
    expect(isPrimaryComposerSubmitKey({ shiftKey: true, metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
  });
});
