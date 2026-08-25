import catalog from '../shared/ai/reasoningCatalog.json';
import type {
  ReasoningCapability,
  ReasoningCapabilitySource,
  ReasoningEffort,
  ReasoningTransportMode,
} from '../types';
import { lookupModelReasoningCatalogCapability } from './modelContextCatalog';

interface ReasoningCatalogEntry {
  id: string;
  provider_types: string[];
  model_patterns: string[];
  supported_efforts: string[];
  default_effort: string;
  configurable?: boolean;
  transport_mode?: ReasoningTransportMode;
}

interface ReasoningCatalogFile {
  version: number;
  entries: ReasoningCatalogEntry[];
}

const reasoningCatalog = catalog as ReasoningCatalogFile;

export const CANONICAL_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[];

const CANONICAL_EFFORT_ORDER = new Map<string, number>(
  CANONICAL_REASONING_EFFORTS.map((effort, index) => [effort, index]),
);

const SAFE_REASONING_EFFORT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const normalizeReasoningEffortValue = (value: unknown): ReasoningEffort | null =>
  typeof value === 'string' && SAFE_REASONING_EFFORT.test(value) ? value : null;

const EMPTY_REASONING_CAPABILITY: ReasoningCapability = {
  reasoningEfforts: [],
  defaultReasoningEffort: null,
  transportMode: 'none',
  configurable: false,
  source: 'none',
};

export const normalizeReasoningEfforts = (
  value?: readonly string[] | null,
): ReasoningEffort[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized = value
    .map((entry, inputIndex) => ({ effort: normalizeReasoningEffortValue(entry), inputIndex }))
    .filter((entry): entry is { effort: ReasoningEffort; inputIndex: number } => {
      if (entry.effort === null || seen.has(entry.effort)) return false;
      seen.add(entry.effort);
      return true;
    });

  return normalized
    .sort((left, right) => {
      const leftOrder = CANONICAL_EFFORT_ORDER.get(left.effort);
      const rightOrder = CANONICAL_EFFORT_ORDER.get(right.effort);
      if (leftOrder === undefined && rightOrder === undefined) {
        return left.inputIndex - right.inputIndex;
      }
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      return leftOrder - rightOrder;
    })
    .map(({ effort }) => effort);
};

const firstValidEffort = (
  preferred: string | null | undefined,
  efforts: readonly ReasoningEffort[],
): ReasoningEffort | null => {
  const normalizedPreferred = preferred?.trim();
  if (normalizedPreferred && efforts.includes(normalizedPreferred)) return normalizedPreferred;
  return efforts[0] ?? null;
};

const hasOpenRouterReasoningSupport = (supportedParameters?: readonly string[] | null): boolean => {
  if (!Array.isArray(supportedParameters)) return false;
  return supportedParameters.includes('reasoning') || supportedParameters.includes('reasoning_effort');
};

const matchesCatalogEntry = (
  providerType: string,
  modelId: string,
  entry: ReasoningCatalogEntry,
): boolean =>
  entry.provider_types.includes(providerType) &&
  entry.model_patterns.some((pattern) => new RegExp(pattern, 'i').test(modelId));

const resolveTransportMode = (
  providerType: string,
  modelId: string,
  configuredMode?: ReasoningTransportMode,
): ReasoningTransportMode => {
  if (providerType === 'openrouter') return 'openrouter_reasoning';
  if (configuredMode) return configuredMode;
  if (/deepseek/i.test(modelId)) return 'deepseek_thinking';
  if (/kimi|moonshot/i.test(modelId)) return 'kimi_fixed';
  return 'openai_effort';
};

const buildCapability = (params: {
  efforts: readonly string[];
  preferredDefault?: string | null;
  providerType: string;
  modelId: string;
  source: ReasoningCapabilitySource;
  configurable?: boolean;
  transportMode?: ReasoningTransportMode;
}): ReasoningCapability => {
  const reasoningEfforts = normalizeReasoningEfforts(params.efforts);
  if (reasoningEfforts.length === 0) return EMPTY_REASONING_CAPABILITY;
  return {
    reasoningEfforts,
    defaultReasoningEffort: firstValidEffort(params.preferredDefault, reasoningEfforts),
    transportMode: resolveTransportMode(params.providerType, params.modelId, params.transportMode),
    configurable: params.configurable ?? reasoningEfforts.length > 1,
    source: params.source,
  };
};

export const getReasoningCapabilityForModel = (params: {
  providerType?: string | null;
  providerId?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
  supportedParameters?: readonly string[] | null;
  supportedReasoningEfforts?: readonly string[] | null;
  defaultReasoningEffort?: string | null;
  manualReasoningEfforts?: readonly string[] | null;
  manualDefaultReasoningEffort?: string | null;
}): ReasoningCapability => {
  const providerType = params.providerType?.trim().toLowerCase();
  const modelId = params.modelId?.trim();
  if (!providerType || !modelId) return EMPTY_REASONING_CAPABILITY;

  const manualEfforts = normalizeReasoningEfforts(params.manualReasoningEfforts);
  if (manualEfforts.length > 0) {
    return buildCapability({
      efforts: manualEfforts,
      preferredDefault: params.manualDefaultReasoningEffort,
      providerType,
      modelId,
      source: 'manual_override',
      configurable: true,
    });
  }

  const directEfforts = normalizeReasoningEfforts(params.supportedReasoningEfforts);
  if (directEfforts.length > 0) {
    return buildCapability({
      efforts: directEfforts,
      preferredDefault: params.defaultReasoningEffort,
      providerType,
      modelId,
      source: 'provider_metadata',
    });
  }

  if (providerType === 'openrouter' && !hasOpenRouterReasoningSupport(params.supportedParameters)) {
    return EMPTY_REASONING_CAPABILITY;
  }

  const modelsDev = lookupModelReasoningCatalogCapability({
    providerType,
    providerId: params.providerId,
    baseUrl: params.baseUrl,
    modelId,
  });
  if (modelsDev && modelsDev.reasoningEfforts.length > 0) {
    return buildCapability({
      efforts: modelsDev.reasoningEfforts,
      preferredDefault: modelsDev.defaultReasoningEffort,
      providerType,
      modelId,
      source: 'models_dev',
      configurable: modelsDev.configurable,
      transportMode: modelsDev.transportMode,
    });
  }

  const matched = reasoningCatalog.entries.find((entry) =>
    matchesCatalogEntry(providerType, modelId, entry),
  );
  if (!matched) return EMPTY_REASONING_CAPABILITY;
  return buildCapability({
    efforts: matched.supported_efforts,
    preferredDefault: matched.default_effort,
    providerType,
    modelId,
    source: 'embedded_catalog',
    configurable: matched.configurable,
    transportMode: matched.transport_mode,
  });
};

export const getValidReasoningEffort = (
  capability: Pick<ReasoningCapability, 'reasoningEfforts' | 'defaultReasoningEffort'>,
  requested?: string | null,
): ReasoningEffort | null => {
  if (requested && capability.reasoningEfforts.includes(requested)) return requested;
  return capability.defaultReasoningEffort ?? capability.reasoningEfforts[0] ?? null;
};

export const getReasoningLabel = (effort: ReasoningEffort): string => {
  switch (effort) {
    case 'none': return 'None';
    case 'minimal': return 'Minimal';
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
    case 'xhigh': return 'X-High';
    case 'max': return 'Max';
    default: return effort;
  }
};
