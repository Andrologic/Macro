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
});
