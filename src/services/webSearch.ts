/**
 * Web Search Service
 * Provides web search capabilities using Tavily API (AI-optimized search)
 * Falls back to Brave Search API if Tavily is unavailable
 */

import { tauriFetch } from './tauriHttp';
import { WebSearchResult } from '../stores/useCitationsStore';
import { isTauriAvailable, webFetchExecute, webSearchExecute } from './tauriIpc';

export type SearchProvider = 'tavily' | 'brave';

export interface WebSearchOptions {
  provider?: SearchProvider;
  configured?: boolean;
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
  favicon?: string;
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

  if (options.configured && isTauriAvailable()) {
    return webSearchExecute({ query, includeRawContent });
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

const FALLBACK_FAVICON_PATH = '/favicon.ico';
const MAX_FAVICON_BYTES = 512 * 1024;

function resolveAbsoluteUrl(value: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(value, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function getFaviconCandidates(html: string, pageUrl: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (href: string | null | undefined) => {
    if (!href) return;
    const resolved = resolveAbsoluteUrl(href, pageUrl);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(resolved);
  };

  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel][href]'))
      .filter((link) => /\b(?:apple-touch-icon|icon|shortcut icon)\b/i.test(link.rel))
      .forEach((link) => addCandidate(link.getAttribute('href')));
  } else {
    const linkPattern = /<link\b[^>]*>/gi;
    const relPattern = /\brel\s*=\s*["']?([^"'\s>]+(?:\s+[^"'\s>]+)*)/i;
    const hrefPattern = /\bhref\s*=\s*["']?([^"'\s>]+)/i;
    for (const match of html.matchAll(linkPattern)) {
      const tag = match[0];
      const rel = tag.match(relPattern)?.[1] ?? '';
      if (!/\b(?:apple-touch-icon|icon|shortcut icon)\b/i.test(rel)) continue;
      addCandidate(tag.match(hrefPattern)?.[1]);
    }
  }

  addCandidate(FALLBACK_FAVICON_PATH);
  return candidates;
}

function guessFaviconMimeType(url: string): string | null {
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();

  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.ico')) return 'image/x-icon';
  return null;
}

function normalizeFaviconMimeType(contentType: string | null, url: string): string | null {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase() || '';
  if (normalized.startsWith('image/')) return normalized;

  const guessed = guessFaviconMimeType(url);
  if (
    guessed &&
    (!normalized ||
      normalized === 'application/octet-stream' ||
      normalized === 'binary/octet-stream' ||
      normalized === 'text/plain')
  ) {
    return guessed;
  }

  return null;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function fetchFaviconDataUrl(pageUrl: string, html: string): Promise<string | undefined> {
  for (const faviconUrl of getFaviconCandidates(html, pageUrl)) {
    try {
      const resource = await webFetchExecute({
        url: faviconUrl,
        resourceKind: 'favicon',
      });
      const bytes = base64ToBytes(resource.bodyBase64);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_FAVICON_BYTES) continue;
      const mimeType = normalizeFaviconMimeType(resource.contentType, resource.url);
      if (!mimeType) continue;
      return `data:${mimeType};base64,${resource.bodyBase64}`;
    } catch {
      // Favicons are decorative. Page fetching should still succeed without one.
    }
  }
  return undefined;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function htmlToText(html: string): { title: string; content: string } {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
      .replace(/\s+/g, ' ')
      .trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<title[\s\S]*?<\/title>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { title, content: text };
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
    throw new Error('Seuls les liens HTTP/HTTPS sont supportés');
  }
  if (!isTauriAvailable()) {
    throw new Error(
      'web_fetch nécessite le transport desktop sécurisé pour vérifier la destination réseau',
    );
  }
  const resource = await webFetchExecute({
    url: normalizedUrl,
    resourceKind: 'page',
  });
  const fetchedUrl = resource.url;
  const html = new TextDecoder().decode(base64ToBytes(resource.bodyBase64));
  const { title, content } = htmlToText(html);
  const snippet = content.slice(0, 350);
  const favicon = await fetchFaviconDataUrl(fetchedUrl, html);

  return {
    url: fetchedUrl,
    title: title || extractDomain(fetchedUrl),
    snippet,
    content: content.slice(0, 12000),
    favicon,
  };
}

export default {
  webSearch,
  fetchWebPage,
  formatSearchResultsAsContext,
  extractDomain,
  getFaviconUrl,
};
