import { beforeEach, describe, expect, it, mock } from 'bun:test';

let fetchMock: ReturnType<typeof mock>;
let importCounter = 0;

const loadWebSearch = async () => {
  mock.restore();
  fetchMock = mock();
  mock.module('@tauri-apps/plugin-http', () => ({
    fetch: fetchMock,
  }));
  importCounter += 1;
  return import(`./webSearch.ts?web-search-test=${importCounter}`);
};

const jsonResponse = (payload: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: mock(async () => payload),
  text: mock(async () => JSON.stringify(payload)),
});

const textResponse = (body: string, ok = true, status = 200) => ({
  ok,
  status,
  headers: new Headers({ 'content-type': 'text/html' }),
  text: mock(async () => body),
});

const binaryResponse = (bytes: Uint8Array, contentType: string, ok = true, status = 200) => ({
  ok,
  status,
  headers: new Headers({ 'content-type': contentType }),
  arrayBuffer: mock(async () =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  ),
});

describe('webSearch provider contracts', () => {
  beforeEach(() => {
    fetchMock = mock();
  });

  it('calls Tavily with the current search contract and maps raw content when requested', async () => {
    const { webSearch } = await loadWebSearch();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      query: 'macro rc',
      answer: 'Short answer',
      results: [
        {
          title: 'Macro release',
          url: 'https://example.com/macro',
          content: 'Summary snippet',
          raw_content: '# Full markdown content',
          score: 0.82,
        },
      ],
    }));

    const results = await webSearch('macro rc', {
      provider: 'tavily',
      tavilyApiKey: 'tvly-test',
      maxResults: 50,
      includeRawContent: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tvly-test',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({
      query: 'macro rc',
      max_results: 20,
      include_raw_content: 'markdown',
      include_answer: 'basic',
      include_favicon: false,
      search_depth: 'basic',
    });
    expect(results).toEqual([
      {
        title: 'Macro release',
        url: 'https://example.com/macro',
        snippet: '# Full markdown content',
        score: 0.82,
      },
    ]);
  });

  it('calls Brave Web Search with count bounds, subscription token, and extra snippets', async () => {
    const { webSearch } = await loadWebSearch();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      web: {
        results: [
          {
            title: 'Macro docs',
            url: 'https://example.com/docs',
            description: 'Primary snippet',
            extra_snippets: ['Alternative snippet'],
          },
        ],
      },
    }));

    const results = await webSearch('macro docs', {
      provider: 'brave',
      braveApiKey: 'brave-test',
      maxResults: 0,
    });

    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.search.brave.com/res/v1/web/search?q=macro%20docs&count=1&extra_snippets=true');
    expect(options).toEqual(expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({
        Accept: 'application/json',
        'X-Subscription-Token': 'brave-test',
      }),
    }));
    expect(results).toEqual([
      {
        title: 'Macro docs',
        url: 'https://example.com/docs',
        snippet: 'Primary snippet\nAlternative snippet',
        score: 1,
      },
    ]);
  });

  it('embeds fetched page favicons as data URLs', async () => {
    const { fetchWebPage } = await loadWebSearch();
    fetchMock
      .mockResolvedValueOnce(textResponse(`
        <html>
          <head>
            <title>Macro source</title>
            <link rel="icon" href="/assets/favicon.png" type="image/png">
          </head>
          <body><main>Useful page body for context.</main></body>
        </html>
      `))
      .mockResolvedValueOnce(binaryResponse(new Uint8Array([1, 2, 3, 4]), 'image/png'));

    const result = await fetchWebPage('https://example.com/article');

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://example.com/assets/favicon.png',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: expect.stringContaining('image/'),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        url: 'https://example.com/article',
        title: 'Macro source',
        snippet: 'Useful page body for context.',
        content: 'Useful page body for context.',
        favicon: 'data:image/png;base64,AQIDBA==',
      }),
    );
  });

  it('keeps page fetches successful when favicon fetching fails', async () => {
    const { fetchWebPage } = await loadWebSearch();
    fetchMock
      .mockResolvedValueOnce(textResponse(`
        <html>
          <head><title>No icon</title></head>
          <body><main>Context still matters.</main></body>
        </html>
      `))
      .mockResolvedValueOnce({ ok: false, status: 404, headers: new Headers() });

    const result = await fetchWebPage('https://example.com/no-icon');

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://example.com/favicon.ico',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.favicon).toBeUndefined();
    expect(result.content).toBe('Context still matters.');
  });
});
