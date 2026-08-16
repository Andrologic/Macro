import { MACRO_AI_SPEECH_PROVIDER_ID } from '../../config/macroAi';
import type { SpeechProviderConfig } from '../../types';

export const resolveSpeechProviderSelection = (
  providers: readonly SpeechProviderConfig[],
  persistedProviderId?: string | null,
): string | null => {
  const enabledProviders = providers.filter((provider) => provider.isEnabled);
  const preferredProviderId = persistedProviderId ?? MACRO_AI_SPEECH_PROVIDER_ID;
  if (enabledProviders.some((provider) => provider.id === preferredProviderId)) {
    return preferredProviderId;
  }
  return enabledProviders.find((provider) => provider.id === MACRO_AI_SPEECH_PROVIDER_ID)?.id
    ?? enabledProviders[0]?.id
    ?? null;
};
