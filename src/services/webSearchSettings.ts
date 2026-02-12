import type { SearchProvider, WebSearchOptions } from './webSearch';

export const WEB_SEARCH_SETTINGS_KEY = 'macro_web_search_settings';

export interface WebSearchSettings {
  tavilyApiKey: string;
  braveApiKey: string;
  provider: SearchProvider;
  enabled: boolean;
  fetchEnabled: boolean;
}

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  tavilyApiKey: '',
  braveApiKey: '',
  provider: 'tavily',
  enabled: true,
  fetchEnabled: true,
};

export function getWebSearchSettings(): WebSearchSettings {
  try {
    const raw = localStorage.getItem(WEB_SEARCH_SETTINGS_KEY);
    if (!raw) return DEFAULT_WEB_SEARCH_SETTINGS;

    const parsed = JSON.parse(raw) as Partial<WebSearchSettings>;
    return {
      tavilyApiKey: typeof parsed.tavilyApiKey === 'string' ? parsed.tavilyApiKey : '',
      braveApiKey: typeof parsed.braveApiKey === 'string' ? parsed.braveApiKey : '',
      provider: parsed.provider === 'brave' ? 'brave' : 'tavily',
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_WEB_SEARCH_SETTINGS.enabled,
      fetchEnabled:
        typeof parsed.fetchEnabled === 'boolean'
          ? parsed.fetchEnabled
          : DEFAULT_WEB_SEARCH_SETTINGS.fetchEnabled,
    };
  } catch (error) {
    console.error('Failed to load web search settings:', error);
    return DEFAULT_WEB_SEARCH_SETTINGS;
  }
}

export function saveWebSearchSettings(settings: WebSearchSettings): void {
  localStorage.setItem(WEB_SEARCH_SETTINGS_KEY, JSON.stringify(settings));
}

export function getStreamingWebSearchConfig(): {
  enableWebSearch: boolean;
  enableWebFetch: boolean;
  webSearchOptions?: WebSearchOptions;
} {
  const settings = getWebSearchSettings();
  const tavilyApiKey = settings.tavilyApiKey.trim();
  const braveApiKey = settings.braveApiKey.trim();
  const providerApiKey = settings.provider === 'tavily' ? tavilyApiKey : braveApiKey;

  if (!providerApiKey) {
    return { enableWebSearch: false, enableWebFetch: settings.fetchEnabled };
  }

  return {
    enableWebSearch: true,
    enableWebFetch: settings.fetchEnabled,
    webSearchOptions: {
      provider: settings.provider,
      tavilyApiKey,
      braveApiKey,
      maxResults: 5,
    },
  };
}
