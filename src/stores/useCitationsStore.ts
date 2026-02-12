/**
 * Citations Store
 * Manages sources used in chat conversations (web pages, files, documents)
 */

import { create } from 'zustand';

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
  messageId: string;
  conversationId: string;
  timestamp: string;
  // Web-specific
  url?: string;
  favicon?: string;
  // File-specific
  path?: string;
  language?: string;
  // Source passage-specific
  kind?: SourcePassageKind;
  reason?: string;
}

interface CitationsState {
  citations: Citation[];
  
  // Actions
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
}

export const useCitationsStore = create<CitationsState>((set, get) => ({
  citations: [],

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
      if (existing) return existing.id;
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
    
    return id;
  },

  addSourcePassage: ({ conversationId, messageId, title, passage, source, url, kind = 'used', reason }) => {
    const id = `cite-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const normalizedTitle = title.trim();
    const normalizedPassage = passage.trim();
    const normalizedReason = typeof reason === 'string' ? reason.trim() : undefined;

    const existing = get().citations.find((c) =>
      c.conversationId === conversationId &&
      c.messageId === messageId &&
      c.type === 'source_passage' &&
      (c.kind || 'used') === kind &&
      c.title === normalizedTitle &&
      (c.snippet || '') === normalizedPassage
    );
    if (existing) return existing.id;

    const citation: Citation = {
      id,
      type: 'source_passage',
      scope: 'source',
      source: source || url || title,
      title: normalizedTitle,
      snippet: normalizedPassage,
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

    return id;
  },

  addWebCitations: (results, messageId, conversationId) => {
    const newCitations: Citation[] = results.map((result, index) => ({
      id: `cite-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 9)}`,
      type: 'web' as CitationType,
      scope: 'context' as CitationScope,
      source: result.url,
      title: result.title,
      snippet: result.snippet,
      url: result.url,
      messageId,
      conversationId,
      timestamp: new Date().toISOString(),
    }));

    set((state) => ({
      citations: [...state.citations, ...newCitations],
    }));
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

    set((state) => ({
      citations: state.citations.map((c) =>
        c.id === citationId
          ? {
              ...c,
              title: nextTitle,
              snippet: nextPassage,
              source: nextSource || nextUrl || nextTitle,
              url: nextUrl || undefined,
              kind: nextKind,
              reason: nextReason,
              timestamp: new Date().toISOString(),
            }
          : c
      ),
    }));

    return true;
  },

  removeCitation: (id) => {
    set((state) => ({
      citations: state.citations.filter((c) => c.id !== id),
    }));
  },

  clearConversationCitations: (conversationId) => {
    set((state) => ({
      citations: state.citations.filter((c) => c.conversationId !== conversationId),
    }));
  },

  pruneConversationSourceCitations: (conversationId, keepMessageIds) => {
    const keepSet = new Set(keepMessageIds);
    set((state) => ({
      citations: state.citations.filter((c) => {
        if (c.conversationId !== conversationId) return true;
        if (c.scope === 'context') return true;
        if (c.scope === 'source') return keepSet.has(c.messageId);
        return true;
      }),
    }));
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
