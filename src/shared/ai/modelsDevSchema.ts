// Only fields consumed by Macro are retained at the catalogue boundary.
export interface ModelsDevModel {
  id?: string;
  canonical_model_id?: string;
  name?: string;
  description?: string;
  family?: string;
  modalities?: { input?: string[] };
  tool_call?: boolean;
  reasoning?: boolean;
  reasoning_options?: { type: string; values?: string[]; default?: string }[];
  limit?: { context?: number; input?: number; output?: number };
  updatedAt?: string;
}

export interface ModelsDevProvider {
  id?: string;
  models: Record<string, ModelsDevModel>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const validCatalogDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

export const parseModelsDevProviders = (value: unknown): Record<string, ModelsDevProvider> | null => {
  if (!record(value) || Object.keys(value).length === 0) return null;
  const providers: Record<string, ModelsDevProvider> = Object.create(null);
  let usable = false;
  for (const [providerKey, provider] of Object.entries(value)) {
    if (!providerKey.trim() || !record(provider) || !record(provider.models) ||
      (provider.id !== undefined && typeof provider.id !== 'string')) return null;
    const models: Record<string, ModelsDevModel> = Object.create(null);
    for (const [key, model] of Object.entries(provider.models)) {
      if (!key.trim() || !record(model)) return null;
      const result: ModelsDevModel = {};
      for (const field of ['id', 'canonical_model_id', 'name', 'description', 'family'] as const) {
        if (model[field] !== undefined) {
          if (typeof model[field] !== 'string' || !model[field].trim()) return null;
          result[field] = model[field];
        }
      }
      if (model.tool_call !== undefined) {
        if (typeof model.tool_call !== 'boolean') return null;
        result.tool_call = model.tool_call;
      }
      if (model.modalities !== undefined) {
        if (!record(model.modalities)) return null;
        if (model.modalities.input !== undefined) {
          if (!Array.isArray(model.modalities.input) || model.modalities.input.some(
            (entry) => typeof entry !== 'string' || !entry.trim(),
          )) return null;
          result.modalities = { input: [...model.modalities.input] };
        }
      }
      if (model.limit !== undefined) {
        if (!record(model.limit)) return null;
        result.limit = {};
        for (const field of ['context', 'input', 'output'] as const) {
          const tokens = model.limit[field];
          if (tokens === undefined) continue;
          if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) return null;
          result.limit[field] = tokens;
        }
        if ((result.limit.context ?? 0) > 0) usable = true;
      }
      // Legacy v1 caches used an object here. Keep their limits, ignore that obsolete metadata.
      if (model.reasoning !== undefined) {
        if (typeof model.reasoning === 'boolean') result.reasoning = model.reasoning;
        else if (!record(model.reasoning)) return null;
      }
      if (model.reasoning_options !== undefined) {
        if (!Array.isArray(model.reasoning_options)) return null;
        result.reasoning_options = [];
        for (const option of model.reasoning_options) {
          if (!record(option) || typeof option.type !== 'string') return null;
          if (option.type !== 'effort') continue;
          if (!Array.isArray(option.values) || option.values.some((entry) => entry !== null && typeof entry !== 'string') ||
            (option.default !== undefined && typeof option.default !== 'string')) return null;
          result.reasoning_options.push({ type: 'effort', values: option.values.filter((entry): entry is string => typeof entry === 'string'),
            ...(typeof option.default === 'string' ? { default: option.default } : {}) });
        }
      }
      if (model.updatedAt !== undefined) {
        if (!validCatalogDate(model.updatedAt)) return null;
        result.updatedAt = model.updatedAt;
      }
      models[key] = result;
    }
    providers[providerKey] = { ...(provider.id ? { id: provider.id as string } : {}), models };
  }
  return usable ? providers : null;
};
