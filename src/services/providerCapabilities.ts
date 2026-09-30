export interface ProviderCapabilityProfile {
  providerId: string;
  providerType?: string;
  httpOnly: boolean;
  usesLocalSecretStore: boolean;
  usesLocalRuntime: boolean;
  supportsModelScan: boolean;
}

const OPENAI_COMPATIBLE: ProviderCapabilityProfile = {
  providerId: 'custom', providerType: 'openai', httpOnly: true,
  usesLocalSecretStore: true, usesLocalRuntime: false, supportsModelScan: true,
};
const PROFILES: Record<string, ProviderCapabilityProfile> = {
  'opencode-go': { ...OPENAI_COMPATIBLE, providerId: 'opencode-go' },
  copilot: {
    providerId: 'copilot', providerType: 'copilot', httpOnly: false,
    usesLocalSecretStore: false, usesLocalRuntime: true, supportsModelScan: true,
  },
  chatgpt: {
    providerId: 'chatgpt', providerType: 'chatgpt', httpOnly: false,
    usesLocalSecretStore: true, usesLocalRuntime: false, supportsModelScan: true,
  },
};

export const resolveProviderCapabilities = (params: {
  providerId: string;
  providerType?: string;
  baseUrl?: string;
}): ProviderCapabilityProfile => {
  const id = params.providerId.trim().toLowerCase();
  // Native dispatch uses the configured type. ID inference is only for callers
  // without that configuration, such as model discovery before provider setup.
  const type = params.providerType?.trim().toLowerCase() ||
    (id === 'copilot' || id === 'chatgpt' ? id : 'openai');
  if (type === 'copilot' || type === 'chatgpt') return { ...PROFILES[type] };
  if (type === 'openai' && (id === 'opencode-go' || params.baseUrl?.trim().toLowerCase().includes('opencode.ai'))) {
    return { ...PROFILES['opencode-go'] };
  }
  return { ...OPENAI_COMPATIBLE };
};
