import { expect, it } from 'bun:test';
import { createComposerTransaction, type ComposerState } from './composerTransaction';

const initial = (): ComposerState & { contextKey: string } => ({
  contextKey: 'conversation:a', revision: 3,
  draft: { text: 'Review', images: [], contextRefs: [] },
});
it('does not clear another conversation or a draft changed and then reverted', () => {
  const state = initial();
  const transaction = createComposerTransaction(state);
  expect(transaction.canClear(state)).toBe(true);
  expect(transaction.canClear({ ...state, contextKey: 'conversation:b' })).toBe(false);
  expect(transaction.canClear({ ...state, revision: 5 })).toBe(false);
  state.draft.text = 'A later message';
  expect(transaction.snapshot.text).toBe('Review');
  expect(transaction.canClear(state)).toBe(false);
});
it('restores only its own empty draft before acceptance', () => {
  const state = initial();
  const transaction = createComposerTransaction(state);
  const cleared = { ...state, revision: 4, draft: { text: '', images: [], contextRefs: [] } };
  expect(transaction.canRestore(cleared, state.contextKey)).toBe(false);
  transaction.markCleared(4);
  expect(transaction.canRestore(cleared, state.contextKey)).toBe(true);
  expect(transaction.canRestore({ ...cleared, revision: 6 }, state.contextKey)).toBe(false);
  expect(transaction.canRestore({ ...cleared, contextKey: 'conversation:b' }, state.contextKey)).toBe(false);
  expect(transaction.canRestore({ ...cleared, draft: state.draft }, state.contextKey)).toBe(false);
  transaction.accept();
  expect(transaction.canRestore(cleared, state.contextKey)).toBe(false);
});
