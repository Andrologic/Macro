import catalog from '../shared/ai/reasoningCatalog.json';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ReasoningCapability {
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort | null;
}

interface ReasoningCatalogEntry {
  id: string;
  provider_types: string[];
  model_patterns: string[];
  supported_efforts: ReasoningEffort[];
  default_effort: ReasoningEffort;
}

interface ReasoningCatalogFile {
  version: number;
  entries: ReasoningCatalogEntry[];
}

const reasoningCatalog = catalog as ReasoningCatalogFile;

const EFFORT_SET = new Set<ReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

const EMPTY_REASONING_CAPABILITY: ReasoningCapability = {
  reasoningEfforts: [],
  defaultReasoningEffort: null,
};

const normalizeEfforts = (value?: readonly string[] | null): ReasoningEffort[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ReasoningEffort => EFFORT_SET.has(entry as ReasoningEffort));
};

const firstValidEffort = (preferred: string | null | undefined, efforts: readonly ReasoningEffort[]) => {
  if (preferred && efforts.includes(preferred as ReasoningEffort)) {
    return preferred as ReasoningEffort;
  }
  return efforts[0] ?? null;
};

const hasOpenRouterReasoningSupport = (supportedParameters?: readonly string[] | null): boolean => {
  if (!Array.isArray(supportedParameters)) return false;
  return supportedParameters.includes('reasoning') || supportedParameters.includes('reasoning_effort');
};

const matchesCatalogEntry = (
  providerType: string,
  modelId: string,
  entry: ReasoningCatalogEntry
): boolean =>
  entry.provider_types.includes(providerType) &&
  entry.model_patterns.some((pattern) => new RegExp(pattern, 'i').test(modelId));

export const getReasoningCapabilityForModel = (params: {
  providerType?: string | null;
  modelId?: string | null;
  supportedParameters?: readonly string[] | null;
  supportedReasoningEfforts?: readonly string[] | null;
  defaultReasoningEffort?: string | null;
}): ReasoningCapability => {
  const providerType = params.providerType?.trim().toLowerCase();
  const modelId = params.modelId?.trim();
  if (!providerType || !modelId) {
    return EMPTY_REASONING_CAPABILITY;
  }

  const directEfforts = normalizeEfforts(params.supportedReasoningEfforts);
  if (directEfforts.length > 0) {
    return {
      reasoningEfforts: directEfforts,
      defaultReasoningEffort: firstValidEffort(params.defaultReasoningEffort, directEfforts),
    };
  }

  if (providerType === 'openrouter' && !hasOpenRouterReasoningSupport(params.supportedParameters)) {
    return EMPTY_REASONING_CAPABILITY;
  }

  if (providerType === 'lmstudio' || providerType === 'ollama') {
    // We only surface effort levels for families with documented, stable effort support.
    const matched = reasoningCatalog.entries.find((entry) => matchesCatalogEntry(providerType, modelId, entry));
    if (!matched) {
      return EMPTY_REASONING_CAPABILITY;
    }
    return {
      reasoningEfforts: matched.supported_efforts,
      defaultReasoningEffort: firstValidEffort(matched.default_effort, matched.supported_efforts),
    };
  }

  const matched = reasoningCatalog.entries.find((entry) => matchesCatalogEntry(providerType, modelId, entry));
  if (!matched) {
    return EMPTY_REASONING_CAPABILITY;
  }

  return {
    reasoningEfforts: matched.supported_efforts,
    defaultReasoningEffort: firstValidEffort(matched.default_effort, matched.supported_efforts),
  };
};

export const getValidReasoningEffort = (
  capability: ReasoningCapability,
  requested?: string | null
): ReasoningEffort | null => {
  if (requested && capability.reasoningEfforts.includes(requested as ReasoningEffort)) {
    return requested as ReasoningEffort;
  }
  return capability.defaultReasoningEffort ?? capability.reasoningEfforts[0] ?? null;
};

export const getReasoningLabel = (effort: ReasoningEffort): string => {
  switch (effort) {
    case 'none':
      return 'None';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'X-High';
  }
};
