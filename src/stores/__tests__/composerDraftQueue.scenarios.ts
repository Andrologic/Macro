import { beforeEach, describe, expect, it } from 'bun:test';
import type { useChatStore as UseChatStore } from '../useChatStore';

interface ComposerDraftQueueScenarioContext {
  loadChatStore: () => Promise<{ useChatStore: typeof UseChatStore }>;
}

export const registerComposerDraftQueueScenarios = (
  context: ComposerDraftQueueScenarioContext,
) => {
  describe('useChatStore composer draft queue', () => {
    let useChatStore: typeof UseChatStore;

    beforeEach(async () => {
      ({ useChatStore } = await context.loadChatStore());
      useChatStore.setState((state) => ({
        ...state,
        pendingComposerDraftByConversationId: {},
      }));
    });

    it('records a draft prompt keyed by conversation id', () => {
      useChatStore.getState().setComposerDraft('conv-1', 'Resolve the merge blocker.');
      expect(
        useChatStore.getState().pendingComposerDraftByConversationId['conv-1'],
      ).toBe('Resolve the merge blocker.');
    });

    it('returns and removes the draft when consumed', () => {
      useChatStore.getState().setComposerDraft('conv-1', 'Draft text');

      const consumed = useChatStore.getState().consumeComposerDraft('conv-1');

      expect(consumed).toBe('Draft text');
      expect(
        useChatStore.getState().pendingComposerDraftByConversationId['conv-1'],
      ).toBeUndefined();
    });

    it('returns null and does not mutate state when no draft exists', () => {
      const before = useChatStore.getState().pendingComposerDraftByConversationId;
      const consumed = useChatStore.getState().consumeComposerDraft('missing-conv');

      expect(consumed).toBeNull();
      expect(useChatStore.getState().pendingComposerDraftByConversationId).toBe(before);
    });

    it('keeps drafts for other conversations isolated', () => {
      useChatStore.getState().setComposerDraft('conv-1', 'First draft');
      useChatStore.getState().setComposerDraft('conv-2', 'Second draft');

      useChatStore.getState().consumeComposerDraft('conv-1');

      const state = useChatStore.getState().pendingComposerDraftByConversationId;
      expect(state['conv-1']).toBeUndefined();
      expect(state['conv-2']).toBe('Second draft');
    });

    it('peekComposerDraft reads without consuming the draft', () => {
      useChatStore.getState().setComposerDraft('conv-1', 'Draft for review.');

      const peeked = useChatStore.getState().peekComposerDraft('conv-1');
      expect(peeked).toBe('Draft for review.');
      expect(useChatStore.getState().peekComposerDraft('conv-1')).toBe('Draft for review.');
      expect(
        useChatStore.getState().pendingComposerDraftByConversationId['conv-1'],
      ).toBe('Draft for review.');
    });

    it('peekComposerDraft returns null for an unknown conversation', () => {
      expect(useChatStore.getState().peekComposerDraft('missing')).toBeNull();
    });

    it('acknowledgeComposerDraft drops the draft without returning it', () => {
      useChatStore.getState().setComposerDraft('conv-1', 'Will be dropped.');

      const returned = useChatStore.getState().acknowledgeComposerDraft('conv-1');
      expect(returned).toBeUndefined();
      expect(
        useChatStore.getState().pendingComposerDraftByConversationId['conv-1'],
      ).toBeUndefined();
    });
  });
};
