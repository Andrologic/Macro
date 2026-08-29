import { beforeEach, describe, expect, it } from 'bun:test';
import { COMPOSER_DRAFTS_STORAGE_KEY } from '../chat/chatLocalSessionState';
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

    it('restores a complete task draft after recreating and initializing the store', async () => {
      const contextKey = 'context:Implement::task::task-a';
      useChatStore.getState().saveComposerDraftForContext(contextKey, {
        text: 'Inspect the pasted screenshot.',
        images: [{
          id: 'image-1',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AQID',
          width: 40,
          height: 30,
          createdAt: '2026-08-29T09:00:00.000Z',
        }],
        contextRefs: [{
          id: 'file:README.md',
          kind: 'file',
          title: 'README.md',
          data: {
            id: 'file:README.md',
            path: 'C:/repo/README.md',
            relativePath: 'README.md',
            projectId: 'project-1',
          },
        }],
      });

      ({ useChatStore } = await context.loadChatStore());
      await useChatStore.getState().initializeCritical();

      expect(useChatStore.getState().getComposerDraftForContext(contextKey)).toEqual({
        text: 'Inspect the pasted screenshot.',
        images: [expect.objectContaining({ id: 'image-1', width: 40, height: 30 })],
        contextRefs: [expect.objectContaining({
          id: 'file:README.md',
          kind: 'file',
          data: expect.objectContaining({ relativePath: 'README.md' }),
        })],
      });
    });

    it('keeps two persisted conversation drafts isolated', () => {
      useChatStore.getState().saveComposerDraftForContext('conversation:conv-a', {
        text: 'Draft A',
        images: [],
        contextRefs: [],
      });
      useChatStore.getState().saveComposerDraftForContext('conversation:conv-b', {
        text: 'Draft B',
        images: [],
        contextRefs: [],
      });

      expect(useChatStore.getState().getComposerDraftForContext('conversation:conv-a')?.text)
        .toBe('Draft A');
      expect(useChatStore.getState().getComposerDraftForContext('conversation:conv-b')?.text)
        .toBe('Draft B');
      const persisted = JSON.parse(
        window.localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY) ?? '{}',
      ) as Record<string, { text?: string }>;
      expect(persisted['conversation:conv-a']?.text).toBe('Draft A');
      expect(persisted['conversation:conv-b']?.text).toBe('Draft B');
    });

    it('ignores invalid persisted drafts while initializing', async () => {
      window.localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
        'context:broken': {
          text: 42,
          images: 'not-an-array',
          contextRefs: null,
        },
      }));

      ({ useChatStore } = await context.loadChatStore());
      await expect(useChatStore.getState().initializeCritical()).resolves.toBeUndefined();
      expect(useChatStore.getState().composerDraftsByContextKey).toEqual({});
      expect(useChatStore.getState().hydrationStatus).toBe('ready');
    });
  });
};
