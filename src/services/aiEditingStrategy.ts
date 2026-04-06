const PATCH_FIRST_PROVIDER_TYPES = new Set(["chatgpt", "openai", "openrouter"]);
const PATCH_FIRST_MODEL_PATTERN = /\b(gpt-5|gpt-4\.1|codex)\b/i;

export const shouldPreferApplyPatchForModel = (
  providerType?: string | null,
  modelId?: string | null,
): boolean => {
  if (!providerType || !PATCH_FIRST_PROVIDER_TYPES.has(providerType)) {
    return false;
  }

  if (!modelId) {
    return false;
  }

  return PATCH_FIRST_MODEL_PATTERN.test(modelId);
};

export const applyEditingStrategyToToolIds = (
  toolIds: string[],
  providerType?: string | null,
  modelId?: string | null,
): string[] => {
  const preferApplyPatch = shouldPreferApplyPatchForModel(
    providerType,
    modelId,
  );
  const filtered = toolIds.filter((toolId) => {
    if (preferApplyPatch) {
      return toolId !== "write" && toolId !== "edit";
    }
    return toolId !== "apply_patch";
  });

  return Array.from(new Set(filtered));
};
