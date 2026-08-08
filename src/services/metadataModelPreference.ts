import {
  PREF_KEYS,
  loadPersistedPreference,
  loadPreference,
  savePreference,
  subscribePreference,
} from './preferences';
import {
  normalizeMetadataModelConfig,
  type MetadataModelConfig,
  type MetadataModelConfigContext,
} from './metadataModelConfig';

const loadPersistedMetadataModelConfig = async (): Promise<MetadataModelConfig | null> => {
  const persisted = await loadPersistedPreference<MetadataModelConfig | null>(
    PREF_KEYS.METADATA_MODEL_CONFIG
  );
  if (persisted !== undefined) {
    return persisted;
  }

  const legacy = await loadPersistedPreference<MetadataModelConfig | null>(
    PREF_KEYS.SMART_COMMIT_MODEL_CONFIG
  );
  if (legacy !== undefined) {
    await savePreference(PREF_KEYS.METADATA_MODEL_CONFIG, legacy);
    return legacy;
  }

  return await loadPreference<MetadataModelConfig | null>(PREF_KEYS.METADATA_MODEL_CONFIG);
};

export const loadMetadataModelConfig = async (
  context?: MetadataModelConfigContext
): Promise<MetadataModelConfig | null> => {
  const persisted = await loadPersistedMetadataModelConfig();
  return context ? normalizeMetadataModelConfig(persisted, context) : persisted;
};

export const saveMetadataModelConfig = async (
  config: MetadataModelConfig | null,
  context?: MetadataModelConfigContext
): Promise<MetadataModelConfig | null> => {
  const normalized = context ? normalizeMetadataModelConfig(config, context) : config;
  await savePreference(PREF_KEYS.METADATA_MODEL_CONFIG, normalized);
  return normalized;
};

export const subscribeMetadataModelConfig = (
  listener: (value: MetadataModelConfig | null) => void
): (() => void) => subscribePreference<MetadataModelConfig | null>(
  PREF_KEYS.METADATA_MODEL_CONFIG,
  (value) => listener(value)
);
