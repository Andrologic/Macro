import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  DbConversationCitation,
  DbUpsertConversationCitationInput,
} from '../services/tauriIpc';
import {
  persistConversationAttachments,
  prepareConversationAttachments,
} from '../services/conversationFileAttachments';
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

  it('propagates inventory failures to strict export callers instead of reporting an empty inventory', async () => {
    listConversationCitationsMock.mockImplementation(async () => { throw new Error('Inventory unavailable'); });
    await expect(useCitationsStore.getState().hydrateConversationCitations('conv', { throwOnError: true })).rejects.toThrow('Inventory unavailable');
    await expect(useCitationsStore.getState().hydrateConversationCitations('conv')).resolves.toBeUndefined();
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

  it('preserves a citation added while persisted citations are loading', async () => {
    let finishHydration: ((citations: DbConversationCitation[]) => void) | undefined;
    listConversationCitationsMock.mockImplementationOnce(
      () => new Promise<DbConversationCitation[]>((resolve) => {
        finishHydration = resolve;
      }),
    );

    const hydration = useCitationsStore
      .getState()
      .hydrateConversationCitations('chat-conv');
    await Promise.resolve();
    const addedId = useCitationsStore.getState().addCitation({
      type: 'file',
      scope: 'context',
      source: 'README.md',
      title: 'README.md',
      path: 'README.md',
      messageId: 'message-new',
      conversationId: 'chat-conv',
    });

    finishHydration?.([
      {
        id: 'cite-db',
        conversation_id: 'chat-conv',
        message_id: 'message-old',
        type: 'source_passage',
        scope: 'source',
        source: 'notes.md',
        title: 'Persisted source',
        snippet: 'Persisted passage',
        content: null,
        url: null,
        favicon: null,
        path: null,
        language: null,
        size_bytes: null,
        kind: 'used',
        reason: null,
        created_at: '2026-07-04T12:00:00Z',
        updated_at: '2026-07-04T12:01:00Z',
      },
    ]);
    await hydration;

    expect(useCitationsStore.getState().citations.map((citation) => citation.id)).toEqual([
      'cite-db',
      addedId,
    ]);
  });

  it('does not restore a citation removed while persisted citations are loading', async () => {
    const existing = {
      id: 'cite-db',
      type: 'source_passage' as const,
      scope: 'source' as const,
      source: 'notes.md',
      title: 'Persisted source',
      snippet: 'Persisted passage',
      messageId: 'message-old',
      conversationId: 'chat-conv',
      timestamp: '2026-07-04T12:01:00Z',
      kind: 'used' as const,
    };
    useCitationsStore.setState({ citations: [existing] });
    let finishHydration: ((citations: DbConversationCitation[]) => void) | undefined;
    listConversationCitationsMock.mockImplementationOnce(
      () => new Promise<DbConversationCitation[]>((resolve) => {
        finishHydration = resolve;
      }),
    );

    const hydration = useCitationsStore
      .getState()
      .hydrateConversationCitations('chat-conv');
    await Promise.resolve();
    useCitationsStore.getState().removeCitation(existing.id);
    finishHydration?.([
      {
        id: existing.id,
        conversation_id: existing.conversationId,
        message_id: existing.messageId,
        type: existing.type,
        scope: existing.scope,
        source: existing.source,
        title: existing.title,
        snippet: existing.snippet,
        content: null,
        url: null,
        favicon: null,
        path: null,
        language: null,
        size_bytes: null,
        kind: existing.kind,
        reason: null,
        created_at: existing.timestamp,
        updated_at: existing.timestamp,
      },
    ]);
    await hydration;

    expect(useCitationsStore.getState().citations).toEqual([]);
  });

  it('does not restore stale citations when an empty conversation is cleared during hydration', async () => {
    let finishHydration: ((citations: DbConversationCitation[]) => void) | undefined;
    listConversationCitationsMock.mockImplementationOnce(
      () => new Promise<DbConversationCitation[]>((resolve) => {
        finishHydration = resolve;
      }),
    );

    const hydration = useCitationsStore
      .getState()
      .hydrateConversationCitations('chat-conv');
    await Promise.resolve();
    useCitationsStore.getState().clearConversationCitations('chat-conv');
    finishHydration?.([
      {
        id: 'cite-stale',
        conversation_id: 'chat-conv',
        message_id: 'message-old',
        type: 'source_passage',
        scope: 'source',
        source: 'notes.md',
        title: 'Stale persisted source',
        snippet: 'This citation was deleted while hydration was pending.',
        content: null,
        url: null,
        favicon: null,
        path: null,
        language: null,
        size_bytes: null,
        kind: 'used',
        reason: null,
        created_at: '2026-07-04T12:00:00Z',
        updated_at: '2026-07-04T12:01:00Z',
      },
    ]);
    await hydration;

    expect(deleteConversationCitationsMock).toHaveBeenCalledWith('chat-conv');
    expect(useCitationsStore.getState().citations).toEqual([]);
  });

  it('does not restore a citation added and removed during the same hydration', async () => {
    let finishHydration: ((citations: DbConversationCitation[]) => void) | undefined;
    listConversationCitationsMock.mockImplementationOnce(
      () => new Promise<DbConversationCitation[]>((resolve) => {
        finishHydration = resolve;
      }),
    );

    const hydration = useCitationsStore
      .getState()
      .hydrateConversationCitations('chat-conv');
    await Promise.resolve();
    const citationId = useCitationsStore.getState().addCitation({
      type: 'file',
      scope: 'context',
      source: 'temporary.md',
      title: 'temporary.md',
      path: 'temporary.md',
      messageId: 'message-temporary',
      conversationId: 'chat-conv',
    });
    useCitationsStore.getState().removeCitation(citationId);
    finishHydration?.([
      {
        id: citationId,
        conversation_id: 'chat-conv',
        message_id: 'message-temporary',
        type: 'file',
        scope: 'context',
        source: 'temporary.md',
        title: 'temporary.md',
        snippet: null,
        content: null,
        url: null,
        favicon: null,
        path: 'temporary.md',
        language: null,
        size_bytes: null,
        kind: null,
        reason: null,
        created_at: '2026-07-04T12:00:00Z',
        updated_at: '2026-07-04T12:01:00Z',
      },
    ]);
    await hydration;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteConversationCitationMock).toHaveBeenCalledWith(citationId);
    expect(useCitationsStore.getState().citations).toEqual([]);
  });

  it('preserves a source edit when the persisted citation catalogue finishes loading', async () => {
    const existing = {
      id: 'cite-edit-during-hydration',
      type: 'source_passage' as const,
      scope: 'source' as const,
      source: 'notes.md',
      title: 'Persisted source',
      snippet: 'Original passage',
      messageId: 'message-old',
      conversationId: 'chat-conv',
      timestamp: '2026-07-04T12:01:00Z',
      kind: 'used' as const,
    };
    useCitationsStore.setState({ citations: [existing] });
    let finishHydration: ((citations: DbConversationCitation[]) => void) | undefined;
    listConversationCitationsMock.mockImplementationOnce(
      () => new Promise<DbConversationCitation[]>((resolve) => {
        finishHydration = resolve;
      }),
    );

    const hydration = useCitationsStore
      .getState()
      .hydrateConversationCitations('chat-conv');
    await Promise.resolve();
    expect(useCitationsStore.getState().updateSourcePassage({
      conversationId: 'chat-conv',
      citationId: existing.id,
      passage: 'Edited passage',
    })).toBe(true);
    finishHydration?.([{
      id: existing.id,
      conversation_id: existing.conversationId,
      message_id: existing.messageId,
      type: existing.type,
      scope: existing.scope,
      source: existing.source,
      title: existing.title,
      snippet: existing.snippet,
      content: null,
      url: null,
      favicon: null,
      path: null,
      language: null,
      size_bytes: null,
      kind: existing.kind,
      reason: null,
      created_at: existing.timestamp,
      updated_at: existing.timestamp,
    }]);
    await hydration;

    expect(useCitationsStore.getState().citations[0]).toMatchObject({
      id: existing.id,
      snippet: 'Edited passage',
      content: 'Edited passage',
    });
  });

  it('keeps a source edit when deferred citation content finishes loading', async () => {
    const existing = {
      id: 'cite-edit-during-content-load',
      type: 'source_passage' as const,
      scope: 'source' as const,
      source: 'notes.md',
      title: 'Persisted source',
      snippet: 'Original passage',
      messageId: 'message-old',
      conversationId: 'chat-conv',
      timestamp: '2026-07-04T12:01:00Z',
      kind: 'used' as const,
    };
    useCitationsStore.setState({ citations: [existing] });
    let finishContent: ((content: string | null) => void) | undefined;
    getConversationCitationContentMock.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => {
        finishContent = resolve;
      }),
    );

    const loading = useCitationsStore
      .getState()
      .ensureCitationContentLoaded(existing.id);
    await Promise.resolve();
    expect(useCitationsStore.getState().updateSourcePassage({
      conversationId: 'chat-conv',
      citationId: existing.id,
      passage: 'Edited passage',
    })).toBe(true);
    finishContent?.('Stale persisted passage');
    const loaded = await loading;

    expect(loaded?.content).toBe('Edited passage');
    expect(useCitationsStore.getState().citations[0]).toMatchObject({
      id: existing.id,
      snippet: 'Edited passage',
      content: 'Edited passage',
    });
  });

  it('does not restore a removed citation when deferred content finishes loading', async () => {
    const existing = {
      id: 'cite-delete-during-content-load',
      type: 'web' as const,
      scope: 'context' as const,
      source: 'https://example.com/article',
      title: 'Example',
      snippet: 'Short preview',
      messageId: 'message-old',
      conversationId: 'chat-conv',
      timestamp: '2026-07-04T12:01:00Z',
    };
    useCitationsStore.setState({ citations: [existing] });
    let finishContent: ((content: string | null) => void) | undefined;
    getConversationCitationContentMock.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => {
        finishContent = resolve;
      }),
    );

    const loading = useCitationsStore
      .getState()
      .ensureCitationContentLoaded(existing.id);
    await Promise.resolve();
    useCitationsStore.getState().removeCitation(existing.id);
    finishContent?.('Stale persisted page body');

    expect(await loading).toBeNull();
    expect(useCitationsStore.getState().citations).toEqual([]);
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

  it('deletes a citation only after its older upsert finishes', async () => {
    let finishUpsert: (() => void) | undefined;
    upsertConversationCitationMock.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        finishUpsert = resolve;
      });
      return input;
    });

    const id = useCitationsStore.getState().addCitation({
      type: 'file',
      scope: 'context',
      source: 'README.md',
      title: 'README.md',
      path: 'README.md',
      messageId: 'message-1',
      conversationId: 'chat-conv',
    });
    await Promise.resolve();
    useCitationsStore.getState().removeCitation(id);
    await Promise.resolve();

    expect(deleteConversationCitationMock).not.toHaveBeenCalled();

    finishUpsert?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteConversationCitationMock).toHaveBeenCalledWith(id);
    expect(useCitationsStore.getState().citations).toEqual([]);
  });

  it('awaits durable citation persistence before resolving', async () => {
    let finishPersistence: (() => void) | undefined;
    upsertConversationCitationMock.mockImplementationOnce(
      async (input: DbUpsertConversationCitationInput) => {
        await new Promise<void>((resolve) => {
          finishPersistence = resolve;
        });
        return input;
      },
    );

    let resolved = false;
    const persistence = useCitationsStore.getState().addCitationAndPersist({
      type: 'file',
      scope: 'context',
      source: 'tool-output://chat/tool.txt',
      title: 'Tool output',
      content: 'complete output',
      path: 'tool-output://chat/tool.txt',
      messageId: 'message-1',
      conversationId: 'chat-conv',
    }).then((id) => {
      resolved = true;
      return id;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    finishPersistence?.();
    const id = await persistence;
    expect(id).toMatch(/^cite-/);
    expect(resolved).toBe(true);
  });

  it('rejects failed durable citation persistence and removes the in-memory artifact', async () => {
    upsertConversationCitationMock.mockImplementationOnce(async () => {
      throw new Error('injected citation persistence failure');
    });

    await expect(
      useCitationsStore.getState().addCitationAndPersist({
        type: 'file',
        scope: 'context',
        source: 'tool-output://chat/tool.txt',
        title: 'Tool output',
        content: 'complete output',
        path: 'tool-output://chat/tool.txt',
        messageId: 'message-1',
        conversationId: 'chat-conv',
      }),
    ).rejects.toThrow('injected citation persistence failure');
    expect(useCitationsStore.getState().citations).toEqual([]);
  });

  it('does not restore a citation removed while durable persistence is pending', async () => {
    let rejectPersistence: ((error: Error) => void) | undefined;
    upsertConversationCitationMock.mockImplementationOnce(
      async () => new Promise<DbUpsertConversationCitationInput>((_resolve, reject) => {
        rejectPersistence = (error) => reject(error);
      }),
    );

    const persistence = useCitationsStore.getState().addCitationAndPersist({
      type: 'file',
      scope: 'context',
      source: 'tool-output://chat/tool.txt',
      title: 'Tool output',
      content: 'complete output',
      path: 'tool-output://chat/tool.txt',
      messageId: 'message-1',
      conversationId: 'chat-conv',
    });
    await Promise.resolve();
    const added = useCitationsStore.getState().citations[0];
    expect(added).toBeDefined();
    useCitationsStore.getState().removeCitation(added!.id);
    rejectPersistence?.(new Error('injected citation persistence failure after removal'));

    await expect(persistence).rejects.toThrow('injected citation persistence failure after removal');
    expect(useCitationsStore.getState().citations).toEqual([]);
  });

  it('does not roll back a newer citation edit when durable persistence rejects', async () => {
    let rejectPersistence: ((error: Error) => void) | undefined;
    upsertConversationCitationMock.mockImplementationOnce(
      async () => new Promise<DbUpsertConversationCitationInput>((_resolve, reject) => {
        rejectPersistence = (error) => reject(error);
      }),
    );

    const persistence = useCitationsStore.getState().addCitationAndPersist({
      type: 'source_passage',
      scope: 'source',
      source: 'notes.md',
      title: 'Original passage',
      snippet: 'Original passage',
      content: 'Original passage',
      messageId: 'message-1',
      conversationId: 'chat-conv',
      kind: 'used',
    });
    await Promise.resolve();
    const added = useCitationsStore.getState().citations[0];
    expect(added).toBeDefined();
    expect(useCitationsStore.getState().updateSourcePassage({
      conversationId: 'chat-conv',
      citationId: added!.id,
      passage: 'Edited passage',
    })).toBe(true);
    rejectPersistence?.(new Error('injected citation persistence failure after edit'));

    await expect(persistence).rejects.toThrow('injected citation persistence failure after edit');
    expect(useCitationsStore.getState().citations[0]).toMatchObject({
      id: added!.id,
      snippet: 'Edited passage',
      content: 'Edited passage',
    });
  });

  it('rehydrates and reads an artifact immediately after durable persistence resolves', async () => {
    let persisted: DbUpsertConversationCitationInput | null = null;
    upsertConversationCitationMock.mockImplementationOnce(async (input) => {
      persisted = input;
      return input;
    });

    const id = await useCitationsStore.getState().addCitationAndPersist({
      type: 'file',
      scope: 'context',
      source: 'tool-output://chat-conv/tool.txt',
      title: 'Tool output',
      snippet: 'bounded preview',
      content: 'complete persisted output',
      path: 'tool-output://chat-conv/tool.txt',
      sizeBytes: 25,
      messageId: 'message-1',
      conversationId: 'chat-conv',
    });
    expect(persisted).not.toBeNull();

    const persistedInput = persisted as unknown as DbUpsertConversationCitationInput;
    listConversationCitationsMock.mockImplementationOnce(async () => [
      {
        id: persistedInput.id,
        conversation_id: persistedInput.conversation_id,
        message_id: persistedInput.message_id,
        type: persistedInput.type,
        scope: persistedInput.scope,
        source: persistedInput.source,
        title: persistedInput.title,
        snippet: persistedInput.snippet ?? null,
        content: null,
        url: persistedInput.url ?? null,
        favicon: persistedInput.favicon ?? null,
        path: persistedInput.path ?? null,
        language: persistedInput.language ?? null,
        size_bytes: persistedInput.size_bytes ?? null,
        kind: persistedInput.kind ?? null,
        reason: persistedInput.reason ?? null,
        created_at: persistedInput.timestamp ?? '2026-08-23T00:00:00Z',
        updated_at: persistedInput.timestamp ?? '2026-08-23T00:00:00Z',
      },
    ]);
    getConversationCitationContentMock.mockImplementationOnce(
      async () => 'complete persisted output',
    );
    useCitationsStore.setState({ citations: [] });

    await useCitationsStore.getState().hydrateConversationCitations('chat-conv');
    const hydrated = useCitationsStore.getState().citations[0];
    expect(hydrated).toMatchObject({
      id,
      path: 'tool-output://chat-conv/tool.txt',
      content: undefined,
    });
    const loaded = await useCitationsStore.getState().ensureCitationContentLoaded(id);
    expect(loaded?.content).toBe('complete persisted output');
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

  it('keeps homonymous imported files distinct in memory and persistence', async () => {
    const prepared = await prepareConversationAttachments([
      new File(['first body'], 'duplicate.txt'),
      new File(['second body'], 'duplicate.txt'),
    ]);

    const ids = await persistConversationAttachments(
      prepared,
      'chat-conv',
      (citation) => useCitationsStore.getState().addCitationAndPersist(citation),
    );

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(useCitationsStore.getState().citations).toHaveLength(2);
    expect(useCitationsStore.getState().citations.map((citation) => citation.title)).toEqual([
      'duplicate.txt',
      'duplicate.txt',
    ]);
    expect(upsertConversationCitationMock.mock.calls.map(([input]) => input.path)).toEqual([
      expect.stringContaining('/duplicate.txt'),
      expect.stringContaining('/duplicate.txt'),
    ]);
    expect(new Set(upsertConversationCitationMock.mock.calls.map(([input]) => input.path)).size).toBe(2);
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
