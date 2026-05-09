import {
  PREF_KEYS,
  loadPreference,
  savePreference,
  subscribePreference,
} from './preferences';
import {
  normalizeSmartCommitModelConfig,
  type SmartCommitModelConfig,
  type SmartCommitModelConfigContext,
} from './smartCommitModelConfig';

export const loadSmartCommitModelConfig = async (
  context?: SmartCommitModelConfigContext
): Promise<SmartCommitModelConfig | null> => {
  const persisted = await loadPreference<SmartCommitModelConfig | null>(
    PREF_KEYS.SMART_COMMIT_MODEL_CONFIG
  );
  return context ? normalizeSmartCommitModelConfig(persisted, context) : persisted;
};

export const saveSmartCommitModelConfig = async (
  config: SmartCommitModelConfig | null,
  context?: SmartCommitModelConfigContext
): Promise<SmartCommitModelConfig | null> => {
  const normalized = context ? normalizeSmartCommitModelConfig(config, context) : config;
  await savePreference(PREF_KEYS.SMART_COMMIT_MODEL_CONFIG, normalized);
  return normalized;
};

export const subscribeSmartCommitModelConfig = (
  listener: (value: SmartCommitModelConfig | null) => void
): (() => void) => subscribePreference<SmartCommitModelConfig | null>(
  PREF_KEYS.SMART_COMMIT_MODEL_CONFIG,
  (value) => listener(value)
);
