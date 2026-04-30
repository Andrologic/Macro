/**
 * Web Search Service
 * Provides web search capabilities using Tavily API (AI-optimized search)
 * Falls back to Brave Search API if Tavily is unavailable
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { WebSearchResult } from '../stores/useCitationsStore';

export type SearchProvider = 'tavily' | 'brave';

export interface WebSearchOptions {
  provider?: SearchProvider;
  tavilyApiKey?: string;
  braveApiKey?: string;
  maxResults?: number;
  includeRawContent?: boolean;
}

export interface WebFetchResult {
  url: string;
  title: string;
  snippet: string;
  content: string;
}

export interface TavilySearchResult {
  url: string;
  title: string;
  content: string;
  score?: number;
  raw_content?: string | null;
}

export interface TavilyResponse {
  results: TavilySearchResult[];
  answer?: string;
  query: string;
}

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  extra_snippets?: string[];
}

export interface BraveResponse {
  web?: {
    results: BraveSearchResult[];
  };
}

const clampSearchResultCount = (value: number): number => {
  if (!Number.isFinite(value)) return 5;
  return Math.min(20, Math.max(1, Math.round(value)));
};

/**
 * Perform a web search using the configured provider
 */
export async function webSearch(
  query: string,
  options: WebSearchOptions = {}
): Promise<WebSearchResult[]> {
  const {
    provider = 'tavily',
    tavilyApiKey,
    braveApiKey,
    maxResults = 5,
    includeRawContent = false,
  } = options;
  const resultCount = clampSearchResultCount(maxResults);

  if (provider === 'tavily' && tavilyApiKey) {
    return searchWithTavily(query, tavilyApiKey, resultCount, includeRawContent);
  } else if (provider === 'brave' && braveApiKey) {
    return searchWithBrave(query, braveApiKey, resultCount);
  }

  // Try Tavily first, then fall back to Brave
  if (tavilyApiKey) {
    try {
      return await searchWithTavily(query, tavilyApiKey, resultCount, includeRawContent);
    } catch (error) {
      console.warn('Tavily search failed, trying Brave:', error);
      if (braveApiKey) {
        return searchWithBrave(query, braveApiKey, resultCount);
      }
      throw error;
    }
  }

  if (braveApiKey) {
    return searchWithBrave(query, braveApiKey, resultCount);
  }

  throw new Error('No search API key configured. Please add a Tavily or Brave Search API key in settings.');
}

/**
 * Search using Tavily API (optimized for AI agents)
 * Documentation: https://docs.tavily.com/
 */
async function searchWithTavily(
  query: string,
  apiKey: string,
  maxResults: number,
  includeRawContent: boolean
): Promise<WebSearchResult[]> {
  const response = await tauriFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      include_raw_content: includeRawContent ? 'markdown' : false,
      include_answer: 'basic',
      include_favicon: false,
      search_depth: 'basic',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Tavily API error: ${response.status} - ${errorText}`);
  }

  const data: TavilyResponse = await response.json();

  return data.results.map((result) => ({
    url: result.url,
    title: result.title,
    snippet: (includeRawContent && result.raw_content ? result.raw_content : result.content) || '',
    score: result.score ?? 1,
  }));
}

/**
 * Search using Brave Search API
 * Documentation: https://brave.com/search/api/
 */
async function searchWithBrave(
  query: string,
  apiKey: string,
  maxResults: number
): Promise<WebSearchResult[]> {
  const response = await tauriFetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}&extra_snippets=true`,
    {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Brave Search API error: ${response.status} - ${errorText}`);
  }

  const data: BraveResponse = await response.json();

  if (!data.web?.results) {
    return [];
  }

  return data.web.results.map((result) => ({
    url: result.url,
    title: result.title,
    snippet: [result.description, ...(result.extra_snippets ?? [])]
      .filter((snippet) => typeof snippet === 'string' && snippet.trim().length > 0)
      .join('\n'),
    score: 1, // Brave doesn't provide scores
  }));
}

/**
 * Format search results as context for the LLM
 */
export function formatSearchResultsAsContext(results: WebSearchResult[]): string {
  if (results.length === 0) {
    return '';
  }

  const formattedResults = results
    .map((result, index) => {
      return `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.snippet}`;
    })
    .join('\n\n');

  return `Voici les résultats de recherche pertinents:\n\n${formattedResults}\n\nUtilise ces informations pour répondre à la question. Cite les sources avec [1], [2], etc. quand tu utilises des informations des résultats.`;
}

/**
 * Extract domain from URL for display
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '');
  } catch {
    return url;
  }
}

/**
 * Get favicon URL for a website
 */
export function getFaviconUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=16`;
  } catch {
    return '';
  }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function htmlToText(html: string): { title: string; content: string } {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { title: '', content: text };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  doc.querySelectorAll('script, style, noscript').forEach((node) => node.remove());

  const title = (doc.querySelector('title')?.textContent || '').trim();
  const main = doc.querySelector('main, article, [role="main"]') || doc.body;
  const content = (main?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, content };
}

export async function fetchWebPage(inputUrl: string): Promise<WebFetchResult> {
  const normalizedUrl = normalizeUrl(inputUrl);
  if (!normalizedUrl) {
    throw new Error('URL vide');
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new Error('URL invalide');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Seuls les liens HTTP/HTTPS sont supportes');
  }

  const response = await tauriFetch(normalizedUrl, {
    method: 'GET',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': 'Macro/1.0 (+https://macro.app)',
    },
  });

  if (!response.ok) {
    throw new Error(`Impossible de recuperer la page (${response.status})`);
  }

  const html = await response.text();
  const { title, content } = htmlToText(html);
  const snippet = content.slice(0, 350);

  return {
    url: normalizedUrl,
    title: title || extractDomain(normalizedUrl),
    snippet,
    content: content.slice(0, 12000),
  };
}

export default {
  webSearch,
  fetchWebPage,
  formatSearchResultsAsContext,
  extractDomain,
  getFaviconUrl,
};
