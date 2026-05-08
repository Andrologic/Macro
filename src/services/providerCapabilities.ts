export interface ProviderCapabilityProfile {
  providerId: string;
  providerType?: string;
  httpOnly: boolean;
  usesKeyring: boolean;
  usesLocalRuntime: boolean;
  supportsModelScan: boolean;
}

const DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES: ProviderCapabilityProfile = {
  providerId: 'custom',
  httpOnly: true,
  usesKeyring: true,
  usesLocalRuntime: false,
  supportsModelScan: true,
};

const BUILT_IN_PROVIDER_CAPABILITIES: Record<string, ProviderCapabilityProfile> = {
  'opencode-go': {
    providerId: 'opencode-go',
    providerType: 'openai',
    httpOnly: true,
    usesKeyring: true,
    usesLocalRuntime: false,
    supportsModelScan: true,
  },
  copilot: {
    providerId: 'copilot',
    providerType: 'copilot',
    httpOnly: false,
    usesKeyring: false,
    usesLocalRuntime: true,
    supportsModelScan: true,
  },
  chatgpt: {
    providerId: 'chatgpt',
    providerType: 'chatgpt',
    httpOnly: false,
    usesKeyring: true,
    usesLocalRuntime: false,
    supportsModelScan: true,
  },
};

export const resolveProviderCapabilities = (params: {
  providerId: string;
  providerType?: string;
  baseUrl?: string;
}): ProviderCapabilityProfile => {
  const providerId = params.providerId.trim().toLowerCase();
  const providerType = params.providerType?.trim().toLowerCase();
  const baseUrl = params.baseUrl?.trim().toLowerCase() ?? '';
  const builtIn = BUILT_IN_PROVIDER_CAPABILITIES[providerId];

  if (builtIn) {
    return builtIn;
  }

  if (baseUrl.includes('opencode.ai')) {
    return BUILT_IN_PROVIDER_CAPABILITIES['opencode-go'];
  }

  return {
    ...DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES,
    providerId,
    providerType,
  };
};
