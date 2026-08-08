/**
 * Citations Store
 * Manages sources used in chat conversations (web pages, files, documents)
 */

import { create } from 'zustand';
import * as tauriIpc from '../services/tauriIpc';

export type CitationType = 'web' | 'file' | 'document' | 'source_passage';
export type CitationScope = 'context' | 'source';
export type SourcePassageKind = 'interesting' | 'used';

export interface Citation {
  id: string;
  type: CitationType;
  scope: CitationScope;
  source: string; // URL for web, filename for files
  title: string;
  snippet?: string;
  content?: string;
  messageId: string;
  conversationId: string;
  timestamp: string;
  // Web-specific
  url?: string;
  favicon?: string;
  // File-specific
  path?: string;
  language?: string;
  sizeBytes?: number;
  // Source passage-specific
  kind?: SourcePassageKind;
  reason?: string;
}

interface CitationsState {
  citations: Citation[];
  
  // Actions
  hydrateConversationCitations: (conversationId: string) => Promise<void>;
  ensureCitationContentLoaded: (id: string) => Promise<Citation | null>;
  ensureConversationCitationContentsLoaded: (
    conversationId: string,
    filter?: (citation: Citation) => boolean,
  ) => Promise<Citation[]>;
  addCitation: (citation: Omit<Citation, 'id' | 'timestamp'>) => string;
  addSourcePassage: (payload: {
    conversationId: string;
    messageId: string;
    title: string;
    passage: string;
    source?: string;
    url?: string;
    kind?: SourcePassageKind;
    reason?: string;
  }) => string;
  addWebCitations: (results: WebSearchResult[], messageId: string, conversationId: string) => void;
  updateSourcePassage: (payload: {
    conversationId: string;
    citationId: string;
    title?: string;
    passage?: string;
    source?: string;
    url?: string;
    kind?: SourcePassageKind;
    reason?: string | null;
  }) => boolean;
  removeCitation: (id: string) => void;
  clearConversationCitations: (conversationId: string) => void;
  clearConversationCitationsBulk: (conversationIds: string[]) => void;
  pruneConversationSourceCitations: (conversationId: string, keepMessageIds: string[]) => void;
  getConversationCitations: (conversationId: string) => Citation[];
  getConversationContextCitations: (conversationId: string) => Citation[];
  getConversationSourceCitations: (conversationId: string) => Citation[];
  getConversationInterestingSourceCitations: (conversationId: string) => Citation[];
  getConversationUsedSourceCitations: (conversationId: string) => Citation[];
  getCitationsByType: (conversationId: string, type: CitationType) => Citation[];
}

// Web search result type for easy conversion
export interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  score?: number;
  favicon?: string;
}

const isCitationType = (value: string): value is CitationType =>
  value === 'web' || value === 'file' || value === 'document' || value === 'source_passage';

const isCitationScope = (value: string): value is CitationScope =>
  value === 'context' || value === 'source';

const isSourcePassageKind = (value: string | null | undefined): value is SourcePassageKind =>
  value === 'interesting' || value === 'used';

const mapDbCitation = (citation: tauriIpc.DbConversationCitation): Citation | null => {
  if (!isCitationType(citation.type) || !isCitationScope(citation.scope)) return null;
  return {
    id: citation.id,
    type: citation.type,
    scope: citation.scope,
    source: citation.source,
    title: citation.title,
    snippet: citation.snippet ?? undefined,
    content: citation.content ?? undefined,
    messageId: citation.message_id,
    conversationId: citation.conversation_id,
    timestamp: citation.updated_at || citation.created_at,
    url: citation.url ?? undefined,
    favicon: citation.favicon ?? undefined,
    path: citation.path ?? undefined,
    language: citation.language ?? undefined,
    sizeBytes: citation.size_bytes ?? undefined,
    kind: isSourcePassageKind(citation.kind) ? citation.kind : undefined,
    reason: citation.reason ?? undefined,
  };
};

const toDbCitationInput = (citation: Citation): tauriIpc.DbUpsertConversationCitationInput => ({
  id: citation.id,
  conversation_id: citation.conversationId,
  message_id: citation.messageId,
  type: citation.type,
  scope: citation.scope,
  source: citation.source,
  title: citation.title,
  snippet: citation.snippet ?? null,
  content: citation.content ?? null,
  url: citation.url ?? null,
  favicon: citation.favicon ?? null,
  path: citation.path ?? null,
  language: citation.language ?? null,
  size_bytes: citation.sizeBytes ?? null,
  kind: citation.kind ?? null,
  reason: citation.reason ?? null,
  timestamp: citation.timestamp,
});

const persistCitationAsync = (citation: Citation): void => {
  if (!tauriIpc.isTauriAvailable()) return;
  void tauriIpc.upsertConversationCitation(toDbCitationInput(citation)).catch((error) => {
    console.warn('[citations] Failed to persist citation:', error);
  });
};

const deletePersistedCitationAsync = (id: string): void => {
  if (!tauriIpc.isTauriAvailable()) return;
  void tauriIpc.deleteConversationCitation(id).catch((error) => {
    console.warn('[citations] Failed to delete persisted citation:', error);
  });
};

const deletePersistedConversationCitationsAsync = (conversationId: string): void => {
  if (!tauriIpc.isTauriAvailable()) return;
  void tauriIpc.deleteConversationCitations(conversationId).catch((error) => {
    console.warn('[citations] Failed to delete persisted conversation citations:', error);
  });
};

const contentLoadPromisesByCitationId = new Map<string, Promise<Citation | null>>();

export const useCitationsStore = create<CitationsState>((set, get) => ({
  citations: [],

  hydrateConversationCitations: async (conversationId) => {
    if (!tauriIpc.isTauriAvailable()) return;
    try {
      const loaded = (await tauriIpc.listConversationCitations(conversationId))
        .map(mapDbCitation)
        .filter((citation): citation is Citation => Boolean(citation));
      set((state) => ({
        citations: [
          ...state.citations.filter((citation) => citation.conversationId !== conversationId),
          ...loaded,
        ],
      }));
    } catch (error) {
      console.warn('[citations] Failed to hydrate conversation citations:', error);
    }
  },

  ensureCitationContentLoaded: async (id) => {
    const existing = get().citations.find((citation) => citation.id === id) ?? null;
    if (!existing) return null;
    if (typeof existing.content === 'string') return existing;
    if (!tauriIpc.isTauriAvailable()) return existing;

    const pending = contentLoadPromisesByCitationId.get(id);
    if (pending) return pending;

    const loadPromise = tauriIpc
      .getConversationCitationContent(id)
      .then((content) => {
        if (typeof content !== 'string') {
          return get().citations.find((citation) => citation.id === id) ?? null;
        }
        let updatedCitation: Citation | null = null;
        set((state) => ({
          citations: state.citations.map((citation) =>
            citation.id === id
              ? (updatedCitation = { ...citation, content })
              : citation
          ),
        }));
        return updatedCitation ?? get().citations.find((citation) => citation.id === id) ?? null;
      })
      .catch((error) => {
        console.warn('[citations] Failed to load citation content:', error);
        return get().citations.find((citation) => citation.id === id) ?? null;
      })
      .finally(() => {
        contentLoadPromisesByCitationId.delete(id);
      });

    contentLoadPromisesByCitationId.set(id, loadPromise);
    return loadPromise;
  },

  ensureConversationCitationContentsLoaded: async (conversationId, filter) => {
    const citations = get().citations.filter(
      (citation) =>
        citation.conversationId === conversationId &&
        (!filter || filter(citation)),
    );
    const loaded = await Promise.all(
      citations.map((citation) => get().ensureCitationContentLoaded(citation.id)),
    );
    return loaded.filter((citation): citation is Citation => Boolean(citation));
  },

  addCitation: (citationData) => {
    if (citationData.type === 'web' || citationData.type === 'file') {
      const existing = get().citations.find((c) => {
        if (c.conversationId !== citationData.conversationId) return false;
        if (c.scope !== citationData.scope || c.type !== citationData.type) return false;
        if (citationData.type === 'web') {
          return (c.url || c.source) === (citationData.url || citationData.source);
        }
        return (c.path || c.source) === (citationData.path || citationData.source);
      });
      if (existing) {
        const timestamp = new Date().toISOString();
        let updatedCitation: Citation | null = null;
        set((state) => ({
          citations: state.citations.map((citation) =>
            citation.id === existing.id
              ? (updatedCitation = {
                  ...citation,
                  ...citationData,
                  id: citation.id,
                  timestamp,
                  snippet: citationData.snippet ?? citation.snippet,
                  content: citationData.content ?? citation.content,
                  url: citationData.url ?? citation.url,
                  favicon: citationData.favicon ?? citation.favicon,
                  path: citationData.path ?? citation.path,
                  language: citationData.language ?? citation.language,
                  sizeBytes: citationData.sizeBytes ?? citation.sizeBytes,
                })
              : citation
          ),
        }));
        if (updatedCitation) persistCitationAsync(updatedCitation);
        return existing.id;
      }
    }

    const id = `cite-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const citation: Citation = {
      ...citationData,
      id,
      timestamp: new Date().toISOString(),
    };
    
    set((state) => ({
      citations: [...state.citations, citation],
    }));
    persistCitationAsync(citation);
    
    return id;
  },

  addSourcePassage: ({ conversationId, messageId, title, passage, source, url, kind = 'used', reason }) => {
    const id = `cite-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const normalizedTitle = title.trim();
    const normalizedPassage = passage.trim();
    const normalizedReason = typeof reason === 'string' ? reason.trim() : undefined;

    const existing = get().citations.find((c) =>
      c.conversationId === conversationId &&
      c.type === 'source_passage' &&
      c.title === normalizedTitle &&
      (c.snippet || '') === normalizedPassage
    );
    if (existing) {
      const existingKind = existing.kind || 'used';
      if (kind === 'used' && existingKind === 'interesting') {
        const timestamp = new Date().toISOString();
        let updatedCitation: Citation | null = null;
        set((state) => ({
          citations: state.citations.map((citation) =>
            citation.id === existing.id
              ? (updatedCitation = {
                  ...citation,
                  kind: 'used',
                  reason: normalizedReason || citation.reason,
                  timestamp,
                })
              : citation
          ),
        }));
        if (updatedCitation) persistCitationAsync(updatedCitation);
      }
      return existing.id;
    }

    const citation: Citation = {
      id,
      type: 'source_passage',
      scope: 'source',
      source: source || url || title,
      title: normalizedTitle,
      snippet: normalizedPassage,
      content: normalizedPassage,
      url,
      messageId,
      conversationId,
      kind,
      reason: normalizedReason || undefined,
      timestamp: new Date().toISOString(),
    };

    set((state) => ({
      citations: [...state.citations, citation],
    }));
    persistCitationAsync(citation);

    return id;
  },

  addWebCitations: (results, messageId, conversationId) => {
    results.forEach((result) => {
      get().addCitation({
        type: 'web',
        scope: 'context',
        source: result.url,
        title: result.title,
        snippet: result.snippet,
        url: result.url,
        favicon: result.favicon,
        messageId,
        conversationId,
      });
    });
  },

  updateSourcePassage: ({ conversationId, citationId, title, passage, source, url, kind, reason }) => {
    const citation = get().citations.find((c) => c.id === citationId);
    if (!citation) return false;
    if (citation.conversationId !== conversationId) return false;
    if (citation.scope !== 'source' || citation.type !== 'source_passage') return false;

    const nextTitle = typeof title === 'string' ? title.trim() : citation.title;
    const nextPassage = typeof passage === 'string' ? passage.trim() : (citation.snippet || '');
    const nextSource = typeof source === 'string' ? source.trim() : citation.source;
    const nextUrl = typeof url === 'string' ? url.trim() : citation.url;
    const nextKind = kind || citation.kind || 'used';
    const nextReason = reason === null
      ? undefined
      : typeof reason === 'string'
        ? (reason.trim() || undefined)
        : citation.reason;

    if (!nextTitle || !nextPassage) return false;

    let updatedCitation: Citation | null = null;
    set((state) => ({
      citations: state.citations.map((c) =>
        c.id === citationId
          ? (updatedCitation = {
              ...c,
              title: nextTitle,
              snippet: nextPassage,
              content: nextPassage,
              source: nextSource || nextUrl || nextTitle,
              url: nextUrl || undefined,
              kind: nextKind,
              reason: nextReason,
              timestamp: new Date().toISOString(),
            })
          : c
      ),
    }));
    if (updatedCitation) persistCitationAsync(updatedCitation);

    return true;
  },

  removeCitation: (id) => {
    set((state) => ({
      citations: state.citations.filter((c) => c.id !== id),
    }));
    deletePersistedCitationAsync(id);
  },

  clearConversationCitations: (conversationId) => {
    set((state) => ({
      citations: state.citations.filter((c) => c.conversationId !== conversationId),
    }));
    deletePersistedConversationCitationsAsync(conversationId);
  },

  clearConversationCitationsBulk: (conversationIds) => {
    if (conversationIds.length === 0) return;
    const ids = new Set(conversationIds);
    set((state) => ({
      citations: state.citations.filter((citation) => !ids.has(citation.conversationId)),
    }));
    conversationIds.forEach(deletePersistedConversationCitationsAsync);
  },

  pruneConversationSourceCitations: (conversationId, keepMessageIds) => {
    const keepSet = new Set(keepMessageIds);
    const removedIds = get().citations
      .filter((c) => c.conversationId === conversationId && c.scope === 'source' && !keepSet.has(c.messageId))
      .map((citation) => citation.id);
    set((state) => ({
      citations: state.citations.filter((c) => {
        if (c.conversationId !== conversationId) return true;
        if (c.scope === 'context') return true;
        if (c.scope === 'source') return keepSet.has(c.messageId);
        return true;
      }),
    }));
    removedIds.forEach(deletePersistedCitationAsync);
  },

  getConversationCitations: (conversationId) => {
    return get().citations.filter((c) => c.conversationId === conversationId);
  },

  getConversationContextCitations: (conversationId) => {
    return get().citations.filter(
      (c) => c.conversationId === conversationId && c.scope === 'context'
    );
  },

  getConversationSourceCitations: (conversationId) => {
    return get().citations.filter(
      (c) => c.conversationId === conversationId && c.scope === 'source'
    ).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  },

  getConversationInterestingSourceCitations: (conversationId) => {
    return get().citations.filter(
      (c) =>
        c.conversationId === conversationId &&
        c.scope === 'source' &&
        (c.kind || 'used') === 'interesting'
    ).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  },

  getConversationUsedSourceCitations: (conversationId) => {
    return get().citations.filter(
      (c) =>
        c.conversationId === conversationId &&
        c.scope === 'source' &&
        (c.kind || 'used') === 'used'
    ).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  },

  getCitationsByType: (conversationId, type) => {
    return get().citations.filter(
      (c) => c.conversationId === conversationId && c.type === type
    );
  },
}));

export default useCitationsStore;
