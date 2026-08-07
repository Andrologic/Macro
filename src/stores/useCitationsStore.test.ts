import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  DbConversationCitation,
  DbUpsertConversationCitationInput,
} from '../services/tauriIpc';
import type { useCitationsStore as useCitationsStoreValue } from './useCitationsStore';

const listConversationCitationsMock = mock(
  async (_conversationId: string): Promise<DbConversationCitation[]> => [],
);
const getConversationCitationContentMock = mock(async (_id: string): Promise<string | null> => null);
const upsertConversationCitationMock = mock(
  async (input: DbUpsertConversationCitationInput) => input,
);
const deleteConversationCitationMock = mock(async (_id: string) => undefined);
const deleteConversationCitationsMock = mock(async (_conversationId: string) => undefined);

mock.module('../services/tauriIpc', () => ({
  isTauriAvailable: () => true,
  listConversationCitations: listConversationCitationsMock,
  getConversationCitationContent: getConversationCitationContentMock,
  upsertConversationCitation: upsertConversationCitationMock,
  deleteConversationCitation: deleteConversationCitationMock,
  deleteConversationCitations: deleteConversationCitationsMock,
}));

let importCounter = 0;
let useCitationsStore: typeof useCitationsStoreValue;

describe('useCitationsStore', () => {
  beforeEach(async () => {
    listConversationCitationsMock.mockReset();
    getConversationCitationContentMock.mockReset();
    upsertConversationCitationMock.mockReset();
    deleteConversationCitationMock.mockReset();
    deleteConversationCitationsMock.mockReset();
    listConversationCitationsMock.mockImplementation(async () => []);
    getConversationCitationContentMock.mockImplementation(async () => null);
    upsertConversationCitationMock.mockImplementation(
      async (input: DbUpsertConversationCitationInput) => input,
    );
    deleteConversationCitationMock.mockImplementation(async () => undefined);
    deleteConversationCitationsMock.mockImplementation(async () => undefined);
    ({ useCitationsStore } = await import(
      `./useCitationsStore.ts?citations-store-test=${++importCounter}`
    ));
    useCitationsStore.setState({ citations: [] });
  });

  it('hydrates persisted conversation citations from Tauri IPC without loading full content', async () => {
    listConversationCitationsMock.mockImplementationOnce(async () => [
      {
        id: 'cite-db',
        conversation_id: 'chat-conv',
        message_id: 'message-1',
        type: 'source_passage',
        scope: 'source',
        source: 'notes.md',
        title: 'Persisted source',
        snippet: 'Important persisted passage',
        content: null,
        url: null,
        favicon: null,
        path: 'notes.md',
        language: 'markdown',
        size_bytes: 28,
        kind: 'used',
        reason: 'Used earlier',
        created_at: '2026-07-04T12:00:00Z',
        updated_at: '2026-07-04T12:01:00Z',
      },
    ]);

    await useCitationsStore.getState().hydrateConversationCitations('chat-conv');

    expect(listConversationCitationsMock).toHaveBeenCalledWith('chat-conv');
    expect(useCitationsStore.getState().citations).toEqual([
      expect.objectContaining({
        id: 'cite-db',
        conversationId: 'chat-conv',
        messageId: 'message-1',
        type: 'source_passage',
        scope: 'source',
        source: 'notes.md',
        title: 'Persisted source',
        snippet: 'Important persisted passage',
        content: undefined,
        timestamp: '2026-07-04T12:01:00Z',
        kind: 'used',
        reason: 'Used earlier',
      }),
    ]);
  });

  it('loads full citation content lazily when requested', async () => {
    listConversationCitationsMock.mockImplementationOnce(async () => [
      {
        id: 'cite-db',
        conversation_id: 'chat-conv',
        message_id: 'message-1',
        type: 'web',
        scope: 'context',
        source: 'https://example.com/article',
        title: 'Example',
        snippet: 'Short preview',
        content: null,
        url: 'https://example.com/article',
        favicon: null,
        path: null,
        language: null,
        size_bytes: null,
        kind: null,
        reason: null,
        created_at: '2026-07-04T12:00:00Z',
        updated_at: '2026-07-04T12:01:00Z',
      },
    ]);
    getConversationCitationContentMock.mockImplementationOnce(
      async () => 'Full persisted page body',
    );

    await useCitationsStore.getState().hydrateConversationCitations('chat-conv');
    expect(useCitationsStore.getState().citations[0]?.content).toBeUndefined();

    const loaded = await useCitationsStore.getState().ensureCitationContentLoaded('cite-db');

    expect(getConversationCitationContentMock).toHaveBeenCalledWith('cite-db');
    expect(loaded?.content).toBe('Full persisted page body');
    expect(useCitationsStore.getState().citations[0]).toMatchObject({
      id: 'cite-db',
      content: 'Full persisted page body',
    });
  });

  it('does not reload citation content that is already in memory', async () => {
    const id = useCitationsStore.getState().addSourcePassage({
      conversationId: 'chat-conv',
      messageId: 'message-1',
      title: 'Finding',
      passage: 'Already loaded body',
      source: 'notes.md',
      kind: 'used',
    });

    const loaded = await useCitationsStore.getState().ensureCitationContentLoaded(id);

    expect(loaded?.content).toBe('Already loaded body');
    expect(getConversationCitationContentMock).not.toHaveBeenCalled();
  });

  it('persists newly added citations asynchronously without blocking the returned id', () => {
    const id = useCitationsStore.getState().addCitation({
      type: 'web',
      scope: 'context',
      source: 'https://example.com/article',
      title: 'Example',
      snippet: 'Example snippet',
      url: 'https://example.com/article',
      favicon: 'data:image/png;base64,abc',
      messageId: 'message-1',
      conversationId: 'chat-conv',
    });

    expect(id).toMatch(/^cite-/);
    expect(useCitationsStore.getState().citations).toHaveLength(1);
    expect(upsertConversationCitationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        conversation_id: 'chat-conv',
        message_id: 'message-1',
        type: 'web',
        scope: 'context',
        source: 'https://example.com/article',
        title: 'Example',
        snippet: 'Example snippet',
        url: 'https://example.com/article',
        favicon: 'data:image/png;base64,abc',
      }),
    );
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

  it('deduplicates web citations added from search results by conversation URL', () => {
    useCitationsStore.getState().addWebCitations(
      [
        {
          url: 'https://example.com/article',
          title: 'Original title',
          snippet: 'Original snippet',
          favicon: 'https://example.com/favicon.ico',
        },
      ],
      'message-1',
      'chat-conv',
    );

    useCitationsStore.getState().addWebCitations(
      [
        {
          url: 'https://example.com/article',
          title: 'Updated title',
          snippet: 'Updated snippet',
          favicon: 'https://example.com/new.ico',
        },
      ],
      'message-2',
      'chat-conv',
    );

    expect(useCitationsStore.getState().citations).toHaveLength(1);
    expect(useCitationsStore.getState().citations[0]).toMatchObject({
      title: 'Updated title',
      snippet: 'Updated snippet',
      favicon: 'https://example.com/new.ico',
      messageId: 'message-2',
    });
  });

  it('reclassifies duplicate source passages from interesting to used without creating duplicates', () => {
    const firstId = useCitationsStore.getState().addSourcePassage({
      conversationId: 'chat-conv',
      messageId: 'message-1',
      title: 'Finding',
      passage: 'The same passage can become useful later.',
      kind: 'interesting',
      reason: 'Worth saving',
    });

    const secondId = useCitationsStore.getState().addSourcePassage({
      conversationId: 'chat-conv',
      messageId: 'message-2',
      title: 'Finding',
      passage: 'The same passage can become useful later.',
      kind: 'used',
      reason: 'Used in the answer',
    });

    expect(secondId).toBe(firstId);
    expect(useCitationsStore.getState().citations).toHaveLength(1);
    expect(useCitationsStore.getState().citations[0]).toMatchObject({
      id: firstId,
      kind: 'used',
      reason: 'Used in the answer',
    });
  });

  it('keeps duplicate used source passages from being downgraded to interesting', () => {
    const firstId = useCitationsStore.getState().addSourcePassage({
      conversationId: 'chat-conv',
      messageId: 'message-1',
      title: 'Finding',
      passage: 'A used passage remains used.',
      kind: 'used',
      reason: 'Used in the answer',
    });

    const secondId = useCitationsStore.getState().addSourcePassage({
      conversationId: 'chat-conv',
      messageId: 'message-2',
      title: 'Finding',
      passage: 'A used passage remains used.',
      kind: 'interesting',
      reason: 'Looks interesting again',
    });

    expect(secondId).toBe(firstId);
    expect(useCitationsStore.getState().citations).toHaveLength(1);
    expect(useCitationsStore.getState().citations[0]).toMatchObject({
      id: firstId,
      kind: 'used',
      reason: 'Used in the answer',
    });
  });
});
