import { describe, expect, it } from "bun:test";

import {
  EMPTY_AI_CONTEXT_SELECTIONS,
  buildAISelectionRestorePlan,
  cloneAIContextSelections,
  normalizeAIContextSelections,
  pruneAIContextSelections,
  removeConversationSelectionData,
  upsertSelectionForContext,
  type PersistedAIContextSelections,
  type PersistedAISelection,
} from "./chatAISelectionState";

const selection = (
  providerId: string,
  modelId: string,
  reasoningEffort: PersistedAISelection["reasoningEffort"] = null,
): PersistedAISelection => ({
  providerId,
  modelId,
  reasoningEffort,
  updatedAt: "2026-08-11T10:00:00.000Z",
});

const emptySelections = (): PersistedAIContextSelections =>
  cloneAIContextSelections(EMPTY_AI_CONTEXT_SELECTIONS);

describe("chatAISelectionState", () => {
  it("normalizes persisted selections and migrates the legacy ChatDebug mode", () => {
    const normalized = normalizeAIContextSelections({
      version: 1,
      modeSelections: {
        ChatDebug: selection("provider-chat", "model-chat", "high"),
        Architect: { providerId: "provider-architect", modelId: null },
      },
      conversationSelections: {
        valid: selection("provider-conversation", "model-conversation"),
        invalid: { providerId: 42, modelId: "model-invalid" },
      },
      providerSelectionsByConversationId: {
        valid: {
          "provider-conversation": {
            modelId: "model-conversation",
            reasoningEffort: "medium",
            updatedAt: "2026-08-11T10:00:00.000Z",
          },
          invalid: { modelId: "" },
        },
      },
      providerSelectionsByMode: {
        Implement: {
          "provider-implement": {
            modelId: "model-implement",
            reasoningEffort: "unsupported",
            updatedAt: "2026-08-11T10:00:00.000Z",
          },
        },
      },
    });

    expect(normalized.version).toBe(2);
    expect(normalized.modeSelections).toEqual({
      Chat: selection("provider-chat", "model-chat", "high"),
    });
    expect(normalized.conversationSelections).toEqual({
      valid: selection("provider-conversation", "model-conversation"),
    });
    expect(normalized.providerSelectionsByConversationId).toEqual({
      valid: {
        "provider-conversation": {
          modelId: "model-conversation",
          reasoningEffort: "medium",
          updatedAt: "2026-08-11T10:00:00.000Z",
        },
      },
    });
    expect(
      normalized.providerSelectionsByMode.Implement?.["provider-implement"]
        ?.reasoningEffort,
    ).toBe("unsupported");
  });

  it("clones and updates a context without mutating the previous state", () => {
    const previous = emptySelections();
    const next = cloneAIContextSelections(previous);
    const chatSelection = selection("provider-1", "model-1", "medium");

    expect(
      upsertSelectionForContext(next, "Chat", "conversation-1", chatSelection),
    ).toBe(true);

    expect(previous).toEqual(EMPTY_AI_CONTEXT_SELECTIONS);
    expect(next.modeSelections.Chat).toEqual(chatSelection);
    expect(next.conversationSelections["conversation-1"]).toEqual(
      chatSelection,
    );
    expect(
      next.providerSelectionsByConversationId["conversation-1"]?.["provider-1"],
    ).toEqual({
      modelId: "model-1",
      reasoningEffort: "medium",
      updatedAt: "2026-08-11T10:00:00.000Z",
    });

    expect(removeConversationSelectionData(next, "conversation-1")).toBe(true);
    expect(next.conversationSelections).toEqual({});
    expect(next.providerSelectionsByConversationId).toEqual({});
  });

  it("builds the restore order and exposes targeted invalidation", () => {
    const selections = emptySelections();
    const conversationSelection = selection("provider-1", "model-stale");
    const providerSelection = selection("provider-1", "model-provider");
    const modeSelection = selection("provider-2", "model-mode");
    upsertSelectionForContext(
      selections,
      "Chat",
      "conversation-1",
      conversationSelection,
    );
    upsertSelectionForContext(
      selections,
      "Chat",
      null,
      modeSelection,
    );
    selections.providerSelectionsByConversationId["conversation-1"]![
      "provider-1"
    ] = {
      modelId: providerSelection.modelId!,
      reasoningEffort: null,
      updatedAt: providerSelection.updatedAt,
    };

    const steps = buildAISelectionRestorePlan({
      selections,
      mode: "Chat",
      conversationId: "conversation-1",
      currentSelection: null,
      persistedConversationSelection: selection("provider-1", "model-db"),
    });

    expect(
      steps.map((step) =>
        step.kind === "candidate"
          ? `${step.kind}:${step.selection.providerId}:${step.selection.modelId}`
          : step.kind === "provider_fallback"
            ? `${step.kind}:${step.providerId}`
            : step.kind,
      ),
    ).toEqual([
      "candidate:provider-1:model-db",
      "candidate:provider-1:model-stale",
      "candidate:provider-1:model-provider",
      "candidate:provider-2:model-mode",
      "provider_fallback:provider-1",
      "global_fallback",
    ]);

    const staleConversationStep = steps[1];
    expect(staleConversationStep?.kind).toBe("candidate");
    if (staleConversationStep?.kind === "candidate") {
      const target = cloneAIContextSelections(selections);
      expect(staleConversationStep.invalidate(target)).toBe(true);
      expect(target.conversationSelections["conversation-1"]).toBeUndefined();
      expect(
        target.providerSelectionsByConversationId["conversation-1"],
      ).toBeDefined();
    }
  });

  it("prunes orphaned conversation selections and preserves identity on no-op", () => {
    const selections = emptySelections();
    upsertSelectionForContext(
      selections,
      "Architect",
      "conversation-kept",
      selection("provider-1", "model-1"),
    );
    upsertSelectionForContext(
      selections,
      "Architect",
      "conversation-removed",
      selection("provider-2", "model-2"),
    );

    const pruned = pruneAIContextSelections(selections, ["conversation-kept"]);

    expect(pruned).not.toBe(selections);
    expect(Object.keys(pruned.conversationSelections)).toEqual([
      "conversation-kept",
    ]);
    expect(Object.keys(pruned.providerSelectionsByConversationId)).toEqual([
      "conversation-kept",
    ]);
    expect(
      pruneAIContextSelections(pruned, ["conversation-kept"]),
    ).toBe(pruned);
  });
});
