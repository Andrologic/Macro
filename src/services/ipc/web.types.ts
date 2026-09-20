/** web IPC DTOs. Kept separate for generated Rust binding integration. */

export interface WebSearchSecretStatus {
  provider: 'tavily' | 'brave';
  hasSecret: boolean;
  secretRef: string;
}

export interface NativeWebSearchResult {
  url: string;
  title: string;
  snippet: string;
  score: number;
}

export interface NativeWebFetchResource {
  url: string;
  contentType: string | null;
  bodyBase64: string;
}
