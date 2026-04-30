import { beforeEach, describe, expect, it } from 'bun:test';
import type { useCitationsStore as useCitationsStoreValue } from './useCitationsStore';

let importCounter = 0;
let useCitationsStore: typeof useCitationsStoreValue;

describe('useCitationsStore', () => {
  beforeEach(async () => {
    ({ useCitationsStore } = await import(
      `./useCitationsStore.ts?citations-store-test=${++importCounter}`
    ));
    useCitationsStore.setState({ citations: [] });
  });

  it('returns a usable id and refreshes duplicate context file citations', () => {
    const firstId = useCitationsStore.getState().addCitation({
      type: 'file',
      scope: 'context',
      source: 'notes.md',
      title: 'notes.md',
      snippet: 'Old preview',
      content: 'Old full content',
      path: 'notes.md',
      sizeBytes: 4,
      messageId: 'manual-1',
      conversationId: 'chat-conv',
    });

    const secondId = useCitationsStore.getState().addCitation({
      type: 'file',
      scope: 'context',
      source: 'notes.md',
      title: 'notes.md',
      snippet: 'Updated preview',
      content: 'Updated full content',
      path: 'notes.md',
      sizeBytes: 20,
      messageId: 'manual-2',
      conversationId: 'chat-conv',
    });

    expect(secondId).toBe(firstId);
    expect(useCitationsStore.getState().citations).toHaveLength(1);
    expect(useCitationsStore.getState().citations[0]).toMatchObject({
      id: firstId,
      snippet: 'Updated preview',
      content: 'Updated full content',
      sizeBytes: 20,
      messageId: 'manual-2',
    });
  });

  it('returns a usable id and refreshes duplicate context URL citations', () => {
    const firstId = useCitationsStore.getState().addCitation({
      type: 'web',
      scope: 'context',
      source: 'https://example.com/article',
      title: 'Old title',
      snippet: 'Old snippet',
      url: 'https://example.com/article',
      messageId: 'manual-1',
      conversationId: 'chat-conv',
    });

    const secondId = useCitationsStore.getState().addCitation({
      type: 'web',
      scope: 'context',
      source: 'https://example.com/article',
      title: 'New title',
      snippet: 'New snippet',
      content: 'New page body',
      url: 'https://example.com/article',
      messageId: 'manual-2',
      conversationId: 'chat-conv',
    });

    expect(secondId).toBe(firstId);
    expect(useCitationsStore.getState().citations).toHaveLength(1);
    expect(useCitationsStore.getState().citations[0]).toMatchObject({
      id: firstId,
      title: 'New title',
      snippet: 'New snippet',
      content: 'New page body',
      messageId: 'manual-2',
    });
  });
});
