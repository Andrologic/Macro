import type { AppMode, ReasoningEffort } from "../../types";
import { normalizeReasoningEffort } from "./chatDbMappers";

export type AISelectionModeKey = "Chat" | "Architect" | "Implement";

export interface PersistedAISelection {
  providerId: string | null;
  modelId: string | null;
  reasoningEffort?: ReasoningEffort | null;
  updatedAt: string;
}

export interface PersistedAIProviderSelection {
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
  updatedAt: string;
}

export interface PersistedAIContextSelections {
  version: 2;
  modeSelections: Partial<Record<AISelectionModeKey, PersistedAISelection>>;
  conversationSelections: Record<string, PersistedAISelection>;
  providerSelectionsByConversationId: Record<
    string,
    Record<string, PersistedAIProviderSelection>
  >;
  providerSelectionsByMode: Partial<
    Record<AISelectionModeKey, Record<string, PersistedAIProviderSelection>>
  >;
}

export const EMPTY_AI_CONTEXT_SELECTIONS: PersistedAIContextSelections = {
  version: 2,
  modeSelections: {},
  conversationSelections: {},
  providerSelectionsByConversationId: {},
  providerSelectionsByMode: {},
};

const getSelectionModeKey = (mode: AppMode): AISelectionModeKey => {
  if (mode === "Chat") {
    return "Chat";
  }
  if (mode === "Architect") {
    return "Architect";
  }
  return "Implement";
};

const normalizePersistedSelection = (
  value: unknown,
): PersistedAISelection | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    providerId?: unknown;
    modelId?: unknown;
    reasoningEffort?: unknown;
    updatedAt?: unknown;
  };

  const providerId =
    candidate.providerId === null || typeof candidate.providerId === "string"
      ? candidate.providerId
      : null;
  const modelId =
    candidate.modelId === null || typeof candidate.modelId === "string"
      ? candidate.modelId
      : null;

  if (!providerId || !modelId) {
    return null;
  }

  return {
    providerId,
    modelId,
    reasoningEffort: normalizeReasoningEffort(candidate.reasoningEffort),
    updatedAt:
      typeof candidate.updatedAt === "string" &&
      candidate.updatedAt.trim().length > 0
        ? candidate.updatedAt
        : new Date().toISOString(),
  };
};

const normalizePersistedProviderSelection = (
  value: unknown,
): PersistedAIProviderSelection | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    modelId?: unknown;
    reasoningEffort?: unknown;
    updatedAt?: unknown;
  };

  if (typeof candidate.modelId !== "string" || !candidate.modelId.trim()) {
    return null;
  }

  return {
    modelId: candidate.modelId,
    reasoningEffort: normalizeReasoningEffort(candidate.reasoningEffort),
    updatedAt:
      typeof candidate.updatedAt === "string" &&
      candidate.updatedAt.trim().length > 0
        ? candidate.updatedAt
        : new Date().toISOString(),
  };
};

const normalizePersistedProviderSelectionMap = (
  value: unknown,
): Record<string, PersistedAIProviderSelection> => {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([providerId, selection]) => [
        providerId,
        normalizePersistedProviderSelection(selection),
      ])
      .filter((entry): entry is [string, PersistedAIProviderSelection] =>
        Boolean(entry[1]),
      ),
  );
};

export const normalizeAIContextSelections = (
  value: unknown,
): PersistedAIContextSelections => {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_AI_CONTEXT_SELECTIONS };
  }

  const raw = value as {
    version?: unknown;
    modeSelections?: unknown;
    conversationSelections?: unknown;
    providerSelectionsByConversationId?: unknown;
    providerSelectionsByMode?: unknown;
  };

  const modeSelections: Partial<
    Record<AISelectionModeKey, PersistedAISelection>
  > = {};
  if (raw.modeSelections && typeof raw.modeSelections === "object") {
    const modeMap = raw.modeSelections as Record<string, unknown>;
    for (const key of ["Chat", "Architect", "Implement"] as AISelectionModeKey[]) {
      const normalized = normalizePersistedSelection(modeMap[key]);
      if (normalized) {
        modeSelections[key] = normalized;
      }
    }
    if (!modeSelections.Chat) {
      const legacyChatSelection = normalizePersistedSelection(modeMap.ChatDebug);
      if (legacyChatSelection) {
        modeSelections.Chat = legacyChatSelection;
      }
    }
  }

  const conversationSelections: Record<string, PersistedAISelection> = {};
  if (
    raw.conversationSelections &&
    typeof raw.conversationSelections === "object"
  ) {
    for (const [conversationId, selection] of Object.entries(
      raw.conversationSelections as Record<string, unknown>,
    )) {
      const normalized = normalizePersistedSelection(selection);
      if (normalized) {
        conversationSelections[conversationId] = normalized;
      }
    }
  }

  const providerSelectionsByConversationId: Record<
    string,
    Record<string, PersistedAIProviderSelection>
  > = {};
  if (
    raw.providerSelectionsByConversationId &&
    typeof raw.providerSelectionsByConversationId === "object"
  ) {
    for (const [conversationId, selectionMap] of Object.entries(
      raw.providerSelectionsByConversationId as Record<string, unknown>,
    )) {
      const normalizedSelectionMap =
        normalizePersistedProviderSelectionMap(selectionMap);
      if (Object.keys(normalizedSelectionMap).length > 0) {
        providerSelectionsByConversationId[conversationId] =
          normalizedSelectionMap;
      }
    }
  }

  const providerSelectionsByMode: Partial<
    Record<AISelectionModeKey, Record<string, PersistedAIProviderSelection>>
  > = {};
  if (
    raw.providerSelectionsByMode &&
    typeof raw.providerSelectionsByMode === "object"
  ) {
    const rawModeSelections = raw.providerSelectionsByMode as Record<
      string,
      unknown
    >;
    for (const key of ["Chat", "Architect", "Implement"] as AISelectionModeKey[]) {
      const normalizedSelectionMap = normalizePersistedProviderSelectionMap(
        rawModeSelections[key],
      );
      if (Object.keys(normalizedSelectionMap).length > 0) {
        providerSelectionsByMode[key] = normalizedSelectionMap;
      }
    }
  }

  return {
    version: 2,
    modeSelections,
    conversationSelections,
    providerSelectionsByConversationId,
    providerSelectionsByMode,
  };
};

const toPersistedProviderSelection = (
  selection: PersistedAISelection,
): PersistedAIProviderSelection => ({
  modelId: selection.modelId!,
  reasoningEffort: selection.reasoningEffort ?? null,
  updatedAt: selection.updatedAt,
});

const toPersistedSelectionFromProvider = (
  providerId: string,
  selection: PersistedAIProviderSelection | null,
): PersistedAISelection | null => {
  if (!selection) {
    return null;
  }

  return {
    providerId,
    modelId: selection.modelId,
    reasoningEffort: selection.reasoningEffort ?? null,
    updatedAt: selection.updatedAt,
  };
};

const getConversationProviderSelection = (
  selections: PersistedAIContextSelections,
  conversationId: string | null,
  providerId: string,
): PersistedAISelection | null => {
  if (!conversationId) {
    return null;
  }

  return toPersistedSelectionFromProvider(
    providerId,
    selections.providerSelectionsByConversationId[conversationId]?.[
      providerId
    ] ?? null,
  );
};

const getModeProviderSelection = (
  selections: PersistedAIContextSelections,
  mode: AppMode,
  providerId: string,
): PersistedAISelection | null =>
  toPersistedSelectionFromProvider(
    providerId,
    selections.providerSelectionsByMode[getSelectionModeKey(mode)]?.[
      providerId
    ] ?? null,
  );

export const cloneAIContextSelections = (
  source: PersistedAIContextSelections,
): PersistedAIContextSelections => ({
  version: source.version,
  modeSelections: { ...source.modeSelections },
  conversationSelections: { ...source.conversationSelections },
  providerSelectionsByConversationId: Object.fromEntries(
    Object.entries(source.providerSelectionsByConversationId).map(
      ([conversationId, selectionMap]) => [conversationId, { ...selectionMap }],
    ),
  ),
  providerSelectionsByMode: Object.fromEntries(
    Object.entries(source.providerSelectionsByMode).map(
      ([modeKey, selectionMap]) => [modeKey, { ...selectionMap }],
    ),
  ) as PersistedAIContextSelections["providerSelectionsByMode"],
});

export const upsertSelectionForContext = (
  target: PersistedAIContextSelections,
  mode: AppMode,
  conversationId: string | null,
  selection: PersistedAISelection | null,
): boolean => {
  if (!selection?.providerId || !selection.modelId) {
    return false;
  }

  const providerId = selection.providerId;
  const modeKey = getSelectionModeKey(mode);
  target.modeSelections[modeKey] = selection;
  target.providerSelectionsByMode[modeKey] = {
    ...(target.providerSelectionsByMode[modeKey] ?? {}),
    [providerId]: toPersistedProviderSelection(selection),
  };

  if (conversationId) {
    target.conversationSelections[conversationId] = selection;
    target.providerSelectionsByConversationId[conversationId] = {
      ...(target.providerSelectionsByConversationId[conversationId] ?? {}),
      [providerId]: toPersistedProviderSelection(selection),
    };
  }

  return true;
};

const removeConversationSelection = (
  target: PersistedAIContextSelections,
  conversationId: string,
): boolean => {
  if (!target.conversationSelections[conversationId]) {
    return false;
  }

  delete target.conversationSelections[conversationId];
  return true;
};

const removeConversationProviderSelection = (
  target: PersistedAIContextSelections,
  conversationId: string,
  providerId: string,
): boolean => {
  const conversationSelections =
    target.providerSelectionsByConversationId[conversationId];
  if (!conversationSelections?.[providerId]) {
    return false;
  }

  delete conversationSelections[providerId];
  if (Object.keys(conversationSelections).length === 0) {
    delete target.providerSelectionsByConversationId[conversationId];
  }
  return true;
};

export const removeConversationSelectionData = (
  target: PersistedAIContextSelections,
  conversationId: string,
): boolean => {
  const removedConversationSelection = removeConversationSelection(
    target,
    conversationId,
  );
  const hadProviderSelections =
    Boolean(target.providerSelectionsByConversationId[conversationId]);
  if (hadProviderSelections) {
    delete target.providerSelectionsByConversationId[conversationId];
  }
  return removedConversationSelection || hadProviderSelections;
};

const removeModeSelection = (
  target: PersistedAIContextSelections,
  mode: AppMode,
): boolean => {
  const modeKey = getSelectionModeKey(mode);
  if (!target.modeSelections[modeKey]) {
    return false;
  }

  delete target.modeSelections[modeKey];
  return true;
};

const removeModeProviderSelection = (
  target: PersistedAIContextSelections,
  mode: AppMode,
  providerId: string,
): boolean => {
  const modeKey = getSelectionModeKey(mode);
  const modeSelections = target.providerSelectionsByMode[modeKey];
  if (!modeSelections?.[providerId]) {
    return false;
  }

  delete modeSelections[providerId];
  if (Object.keys(modeSelections).length === 0) {
    delete target.providerSelectionsByMode[modeKey];
  }
  return true;
};

export type AISelectionResolutionStep =
  | {
      kind: "candidate";
      selection: PersistedAISelection;
      invalidate: (target: PersistedAIContextSelections) => boolean;
    }
  | { kind: "provider_fallback"; providerId: string }
  | { kind: "global_fallback"; excludedProviderIds: string[] };

export const buildAISelectionRestorePlan = (params: {
  selections: PersistedAIContextSelections;
  mode: AppMode;
  conversationId: string | null;
  preferredProviderId?: string | null;
  currentSelection: PersistedAISelection | null;
  persistedConversationSelection: PersistedAISelection | null;
}): AISelectionResolutionStep[] => {
  const {
    selections,
    mode,
    conversationId,
    preferredProviderId,
    currentSelection,
    persistedConversationSelection,
  } = params;
  const steps: AISelectionResolutionStep[] = [];
  const seenSelectionKeys = new Set<string>();
  const seenFallbackProviders = new Set<string>();
  const modeKey = getSelectionModeKey(mode);
  const conversationSelection = conversationId
    ? selections.conversationSelections[conversationId] ?? null
    : null;
  const modeSelection = selections.modeSelections[modeKey] ?? null;
  const conversationProviderId =
    preferredProviderId ??
    persistedConversationSelection?.providerId ??
    conversationSelection?.providerId ??
    currentSelection?.providerId ??
    modeSelection?.providerId ??
    null;
  const modeProviderId =
    preferredProviderId ??
    modeSelection?.providerId ??
    currentSelection?.providerId ??
    persistedConversationSelection?.providerId ??
    conversationSelection?.providerId ??
    null;
  const fallbackProviderId =
    preferredProviderId ??
    persistedConversationSelection?.providerId ??
    currentSelection?.providerId ??
    conversationSelection?.providerId ??
    modeSelection?.providerId ??
    null;

  const pushCandidate = (
    selection: PersistedAISelection | null,
    invalidate: (target: PersistedAIContextSelections) => boolean,
  ) => {
    if (!selection?.providerId || !selection.modelId) {
      return;
    }
    if (preferredProviderId && selection.providerId !== preferredProviderId) {
      return;
    }

    const key = `${selection.providerId}::${selection.modelId}::${
      selection.reasoningEffort ?? ""
    }`;
    if (seenSelectionKeys.has(key)) {
      return;
    }

    seenSelectionKeys.add(key);
    seenFallbackProviders.add(selection.providerId);
    steps.push({ kind: "candidate", selection, invalidate });
  };

  pushCandidate(persistedConversationSelection, () => false);
  pushCandidate(conversationSelection, (target) =>
    conversationId
      ? removeConversationSelection(target, conversationId)
      : false,
  );

  if (conversationProviderId) {
    pushCandidate(
      getConversationProviderSelection(
        selections,
        conversationId,
        conversationProviderId,
      ),
      (target) =>
        conversationId
          ? removeConversationProviderSelection(
              target,
              conversationId,
              conversationProviderId,
            )
          : false,
    );
  }

  pushCandidate(modeSelection, (target) => removeModeSelection(target, mode));

  if (modeProviderId) {
    pushCandidate(
      getModeProviderSelection(selections, mode, modeProviderId),
      (target) => removeModeProviderSelection(target, mode, modeProviderId),
    );
  }

  if (fallbackProviderId) {
    seenFallbackProviders.add(fallbackProviderId);
    steps.push({ kind: "provider_fallback", providerId: fallbackProviderId });
  }

  steps.push({
    kind: "global_fallback",
    excludedProviderIds: Array.from(seenFallbackProviders),
  });

  return steps;
};

export const pruneAIContextSelections = (
  selections: PersistedAIContextSelections,
  conversationIds: Iterable<string>,
): PersistedAIContextSelections => {
  const existingConversationIds = new Set(conversationIds);
  const conversationSelections = Object.fromEntries(
    Object.entries(selections.conversationSelections).filter(([conversationId]) =>
      existingConversationIds.has(conversationId),
    ),
  );
  const providerSelectionsByConversationId = Object.fromEntries(
    Object.entries(selections.providerSelectionsByConversationId).filter(
      ([conversationId]) => existingConversationIds.has(conversationId),
    ),
  );

  const conversationSelectionsChanged =
    Object.keys(conversationSelections).length !==
    Object.keys(selections.conversationSelections).length;
  const providerSelectionsChanged =
    Object.keys(providerSelectionsByConversationId).length !==
    Object.keys(selections.providerSelectionsByConversationId).length;

  if (!conversationSelectionsChanged && !providerSelectionsChanged) {
    return selections;
  }

  return {
    ...selections,
    conversationSelections,
    providerSelectionsByConversationId,
  };
};
