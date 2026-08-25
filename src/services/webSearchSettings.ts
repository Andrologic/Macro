import { getEffectiveConfigDocument, patchUserConfigTopLevel } from './configDocuments';
import {
  isTauriAvailable,
  webSearchGetSecretStatus,
  webSearchSetSecret,
} from './tauriIpc';
import type { SearchProvider, WebSearchOptions } from './webSearch';

export const WEB_SEARCH_SETTINGS_KEY = 'macro_web_search_settings';

interface ToolsConfigDocument extends Record<string, unknown> {
  webSearch?: {
    enabled?: boolean;
    fetchEnabled?: boolean;
    provider?: string;
    secretRef?: string | null;
    maxResults?: number;
  };
}

export interface WebSearchSettings {
  provider: SearchProvider;
  enabled: boolean;
  fetchEnabled: boolean;
  maxResults: number;
  hasTavilySecret: boolean;
  hasBraveSecret: boolean;
  secretRef: string | null;
}

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  provider: 'tavily',
  enabled: false,
  fetchEnabled: true,
  maxResults: 5,
  hasTavilySecret: false,
  hasBraveSecret: false,
  secretRef: null,
};

let cachedSettings: WebSearchSettings = DEFAULT_WEB_SEARCH_SETTINGS;

const normalizeSettings = (
  value: ToolsConfigDocument['webSearch'],
  current: WebSearchSettings,
): WebSearchSettings => ({
  ...current,
  provider: value?.provider === 'brave' ? 'brave' : 'tavily',
  enabled: value?.enabled === true,
  fetchEnabled: value?.fetchEnabled !== false,
  maxResults: typeof value?.maxResults === 'number'
    ? Math.min(20, Math.max(1, Math.round(value.maxResults)))
    : 5,
  secretRef: typeof value?.secretRef === 'string' ? value.secretRef : null,
});

export function getWebSearchSettings(): WebSearchSettings {
  return cachedSettings;
}

export async function refreshWebSearchSettings(): Promise<WebSearchSettings> {
  const config = await getEffectiveConfigDocument<ToolsConfigDocument>('tools');
  let next = normalizeSettings(config.webSearch, cachedSettings);
  if (isTauriAvailable()) {
    const [tavily, brave] = await Promise.all([
      webSearchGetSecretStatus('tavily'),
      webSearchGetSecretStatus('brave'),
    ]);
    next = {
      ...next,
      hasTavilySecret: tavily.hasSecret,
      hasBraveSecret: brave.hasSecret,
    };
  }
  cachedSettings = next;
  return next;
}

export async function saveWebSearchSettings(
  settings: WebSearchSettings,
): Promise<WebSearchSettings> {
  const normalized = normalizeSettings(settings, settings);
  await patchUserConfigTopLevel('tools', 'webSearch', {
    enabled: normalized.enabled,
    fetchEnabled: normalized.fetchEnabled,
    provider: normalized.provider,
    secretRef: normalized.secretRef,
    maxResults: normalized.maxResults,
  });
  cachedSettings = normalized;
  return normalized;
}

export async function setWebSearchApiKey(
  provider: SearchProvider,
  value: string | null,
): Promise<WebSearchSettings> {
  const status = await webSearchSetSecret({ provider, value });
  const next: WebSearchSettings = {
    ...cachedSettings,
    enabled: status.hasSecret ? true : cachedSettings.enabled,
    secretRef: cachedSettings.provider === provider && status.hasSecret
      ? status.secretRef
      : cachedSettings.secretRef,
    hasTavilySecret: provider === 'tavily'
      ? status.hasSecret
      : cachedSettings.hasTavilySecret,
    hasBraveSecret: provider === 'brave'
      ? status.hasSecret
      : cachedSettings.hasBraveSecret,
  };
  if (!status.hasSecret && cachedSettings.provider === provider) {
    next.secretRef = null;
  }
  return saveWebSearchSettings(next);
}

export function getStreamingWebSearchConfig(): {
  enableWebSearch: boolean;
  enableWebFetch: boolean;
  webSearchOptions?: WebSearchOptions;
} {
  const settings = getWebSearchSettings();
  const configured = settings.provider === 'tavily'
    ? settings.hasTavilySecret
    : settings.hasBraveSecret;
  if (!settings.enabled || !configured) {
    return { enableWebSearch: false, enableWebFetch: settings.fetchEnabled };
  }

  return {
    enableWebSearch: true,
    enableWebFetch: settings.fetchEnabled,
    webSearchOptions: {
      provider: settings.provider,
      configured: true,
      maxResults: settings.maxResults,
    },
  };
}

export const resetWebSearchSettingsCacheForTests = (): void => {
  cachedSettings = DEFAULT_WEB_SEARCH_SETTINGS;
};
