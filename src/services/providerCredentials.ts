import type { ProviderConfig } from '../types';

const LINKED_PROVIDER_TYPES = new Set(['chatgpt', 'copilot']);

export const isLinkedProviderType = (providerType?: string | null): boolean =>
  !!providerType && LINKED_PROVIDER_TYPES.has(providerType);

export const providerHasAuthSession = (
  provider: Pick<ProviderConfig, 'providerType' | 'authStatus'>
): boolean => {
  if (provider.providerType === 'chatgpt') {
    return ['authenticated', 'refreshing', 'expired'].includes(provider.authStatus ?? '');
  }

  if (provider.providerType === 'copilot') {
    return provider.authStatus === 'connected';
  }

  return false;
};

export const providerHasUsableCredentials = (
  provider: Pick<
    ProviderConfig,
    'isEnabled' | 'isLocal' | 'apiKey' | 'hasStoredApiKey' | 'providerType' | 'authStatus'
  >
): boolean => {
  const hasApiKey =
    !isLinkedProviderType(provider.providerType) &&
    (!!provider.hasStoredApiKey || !!provider.apiKey?.trim());
  return !!provider.isEnabled && (!!provider.isLocal || hasApiKey || providerHasAuthSession(provider));
};
