export type CitationType = 'web' | 'file' | 'document' | 'source_passage';
export type CitationScope = 'context' | 'source';
export type SourcePassageKind = 'interesting' | 'used';

export interface Citation {
  id: string;
  type: CitationType;
  scope: CitationScope;
  source: string;
  title: string;
  snippet?: string;
  content?: string;
  messageId: string;
  conversationId: string;
  timestamp: string;
  url?: string;
  favicon?: string;
  path?: string;
  language?: string;
  sizeBytes?: number;
  kind?: SourcePassageKind;
  reason?: string;
}
