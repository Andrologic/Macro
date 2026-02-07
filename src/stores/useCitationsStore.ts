/**
 * Citations Store
 * Manages sources used in chat conversations (web pages, files, documents)
 */

import { create } from 'zustand';

export type CitationType = 'web' | 'file' | 'document';

export interface Citation {
  id: string;
  type: CitationType;
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
}

interface CitationsState {
  citations: Citation[];
  
  // Actions
  addCitation: (citation: Omit<Citation, 'id' | 'timestamp'>) => string;
  addWebCitations: (results: WebSearchResult[], messageId: string, conversationId: string) => void;
  removeCitation: (id: string) => void;
  clearConversationCitations: (conversationId: string) => void;
  getConversationCitations: (conversationId: string) => Citation[];
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

  addWebCitations: (results, messageId, conversationId) => {
    const newCitations: Citation[] = results.map((result, index) => ({
      id: `cite-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 9)}`,
      type: 'web' as CitationType,
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

  getConversationCitations: (conversationId) => {
    return get().citations.filter((c) => c.conversationId === conversationId);
  },

  getCitationsByType: (conversationId, type) => {
    return get().citations.filter(
      (c) => c.conversationId === conversationId && c.type === type
    );
  },
}));

export default useCitationsStore;
