import { captureComposerSnapshot, sameComposerSnapshot, type ComposerSnapshot } from './composerSubmission';

export interface ComposerState {
  contextKey: string | null;
  revision: number;
  draft: ComposerSnapshot;
}

/** Owns one submission, independently of React renders and later edits. */
export function createComposerTransaction(initial: ComposerState) {
  const snapshot = captureComposerSnapshot(initial.draft);
  let accepted = false;
  let clearedRevision: number | undefined;
  return {
    snapshot,
    accept() { accepted = true; },
    get accepted() { return accepted; },
    markCleared(revision: number) { clearedRevision = revision; },
    canClear(current: ComposerState) {
      return current.contextKey === initial.contextKey &&
        current.revision === initial.revision &&
        sameComposerSnapshot(current.draft, snapshot);
    },
    canRestore(current: ComposerState, conversationKey: string) {
      return !accepted && clearedRevision !== undefined &&
        current.revision === clearedRevision &&
        (current.contextKey === initial.contextKey || current.contextKey === conversationKey) &&
        current.draft.text.length === 0 &&
        current.draft.images.length === 0 &&
        current.draft.contextRefs.length === 0;
    },
  };
}
