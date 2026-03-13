import { aiGetDevProviderOverrides, isTauriAvailable } from './tauriIpc';

export interface AIProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface AIConfigFile {
  providers?: Record<string, AIProviderConfig>;
}

const normalizeProviderKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

let cachedConfig: AIConfigFile | null = null;
let loadingConfig: Promise<AIConfigFile | null> | null = null;

const normalizeBaseUrl = (value?: string) => {
  if (!value) return undefined;
  return value.endsWith('/') ? value.slice(0, -1) : value;
};

export const loadAIConfigFile = async (): Promise<AIConfigFile | null> => {
  if (cachedConfig) return cachedConfig;
  if (loadingConfig) return loadingConfig;

  if (!isTauriAvailable()) {
    return null;
  }

  loadingConfig = aiGetDevProviderOverrides()
    .then((data) => {
      cachedConfig = data;
      return data;
    })
    .catch(() => null)
    .finally(() => {
      loadingConfig = null;
    });

  return loadingConfig;
};

export const getProviderConfig = async (providerId: string): Promise<AIProviderConfig> => {
  const fileConfig = await loadAIConfigFile();
  const providerConfig = findProviderConfig(fileConfig, providerId) ?? {};

  return {
    apiKey: providerConfig.apiKey,
    baseUrl: normalizeBaseUrl(providerConfig.baseUrl),
  };
};

export const findProviderConfig = (
  fileConfig: AIConfigFile | null,
  providerId: string,
  providerName?: string
): AIProviderConfig | undefined => {
  const providers = fileConfig?.providers;
  if (!providers) return undefined;

  const directMatch = providers[providerId];
  if (directMatch) return directMatch;

  if (providerName) {
    const byName = providers[providerName];
    if (byName) return byName;
  }

  const normalizedId = normalizeProviderKey(providerId);
  const normalizedName = providerName ? normalizeProviderKey(providerName) : null;

  const entry = Object.entries(providers).find(([key]) => {
    const normalizedKey = normalizeProviderKey(key);
    return normalizedKey === normalizedId || (normalizedName !== null && normalizedKey === normalizedName);
  });

  return entry?.[1];
};
