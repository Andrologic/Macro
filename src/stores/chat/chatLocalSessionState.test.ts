import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type {
  ChatMessage,
  ConversationQuestionnaireDraft,
  ConversationQuestionnaireState,
} from "../../types";
import {
  COMPOSER_DRAFTS_STORAGE_KEY,
  UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY,
  clearUnsavedAssistantResponsesForConversations,
  clearQuestionnaireDraftsForConversations,
  loadComposerDraftsFromStorage,
  loadMessageImagesFromStorage,
  loadQuestionnaireDraftsFromStorage,
  loadUnsavedAssistantResponsesFromStorage,
  removeUnsavedAssistantResponseFromStorage,
  saveComposerDraftsToStorage,
  saveMessageImagesToStorage,
  saveQuestionnaireDraftsToStorage,
  saveUnsavedAssistantResponseToStorage,
  setActiveQuestionnaireDraftStep,
  setQuestionnaireDraftForConversation,
  type MessageImageAttachment,
} from "./chatLocalSessionState";

class MemoryLocalStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

const installWindowStorage = (): MemoryLocalStorage => {
  const localStorage = new MemoryLocalStorage();
  Object.defineProperty(globalThis, "window", {
    value: { localStorage },
    configurable: true,
  });
  return localStorage;
};

const restoreWindow = () => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, "window");
};

const draft: ConversationQuestionnaireDraft = {
  mode: "pending_reply",
  assistantMessageId: "assistant-1",
  currentStepIndex: 0,
  answersByStepId: { q1: "yes" },
  draftTextByStepId: { q2: "draft" },
};

describe("chatLocalSessionState", () => {
  beforeEach(() => {
    installWindowStorage();
  });

  afterEach(() => {
    restoreWindow();
  });

  it("persists questionnaire drafts defensively", () => {
    saveQuestionnaireDraftsToStorage({ "conv-1": draft });
    expect(loadQuestionnaireDraftsFromStorage()).toEqual({ "conv-1": draft });

    window.localStorage.setItem(
      "macro_chat_questionnaire_drafts",
      JSON.stringify({
        valid: draft,
        invalid: { assistantMessageId: "assistant-2" },
      }),
    );

    expect(loadQuestionnaireDraftsFromStorage()).toEqual({ valid: draft });
  });

  it("updates questionnaire draft maps without mutating the previous value", () => {
    const withDraft = setQuestionnaireDraftForConversation({}, "conv-1", draft);
    const cleared = clearQuestionnaireDraftsForConversations(withDraft, [
      "conv-1",
    ]);

    expect(withDraft).toEqual({ "conv-1": draft });
    expect(cleared).toEqual({});
    expect(withDraft).toEqual({ "conv-1": draft });
  });

  it("derives an active step draft from questionnaire state", () => {
    const questionnaire = {
      conversationId: "conv-1",
      taskId: "task-1",
      mode: "editing_response",
      assistantMessageId: "assistant-1",
      responseMessageId: "response-1",
      questionnaire: { title: "Questions", steps: [] },
      currentStepIndex: 0,
      currentStep: { id: "q1", prompt: "Question?" },
      answersByStepId: { q1: "answer" },
      draftTextByStepId: { q2: "draft" },
      totalSteps: 2,
      isLastStep: false,
    } as unknown as ConversationQuestionnaireState;

    expect(setActiveQuestionnaireDraftStep({}, questionnaire, 1)).toEqual({
      "conv-1": {
        mode: "editing_response",
        assistantMessageId: "assistant-1",
        responseMessageId: "response-1",
        currentStepIndex: 1,
        answersByStepId: { q1: "answer" },
        draftTextByStepId: { q2: "draft" },
      },
    });
  });

  it("persists message images", () => {
    const image: MessageImageAttachment = {
      id: "image-1",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,abc",
      createdAt: "2026-05-16T10:00:00.000Z",
    };

    saveMessageImagesToStorage({ "message-1": [image] });

    expect(loadMessageImagesFromStorage()).toEqual({ "message-1": [image] });
  });

  it("keeps failed assistant responses in local recovery storage", () => {
    const message: ChatMessage = {
      id: "assistant-1",
      turn_id: "turn-1",
      task_id: "",
      conversation_id: "conv-1",
      role: "assistant",
      content: "Réponse à récupérer",
      timestamp: "2026-08-30T08:00:00.000Z",
      hidden_context: "contexte ".repeat(600),
      tool_traces: [],
      persistence_state: "failed",
      persistence_error: "SQLite indisponible",
    };

    expect(saveUnsavedAssistantResponseToStorage(message)).toBe(true);
    expect(loadUnsavedAssistantResponsesFromStorage()).toEqual([message]);

    expect(removeUnsavedAssistantResponseFromStorage(message.id)).toBe(true);
    expect(loadUnsavedAssistantResponsesFromStorage()).toEqual([]);
    expect(
      window.localStorage.getItem(UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY),
    ).toBeNull();
  });

  it("restores an interrupted retry as failed and prunes deleted conversations", () => {
    window.localStorage.setItem(
      UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY,
      JSON.stringify({
        "assistant-1": {
          id: "assistant-1",
          turn_id: "turn-1",
          task_id: "",
          conversation_id: "conv-1",
          role: "assistant",
          content: "Réponse locale",
          timestamp: "2026-08-30T08:00:00.000Z",
          persistence_state: "retrying",
          persistence_error: "Échec initial",
        },
        invalid: {
          id: "user-1",
          task_id: "",
          conversation_id: "conv-2",
          role: "user",
          content: "Ne pas restaurer",
          timestamp: "2026-08-30T08:01:00.000Z",
        },
      }),
    );

    expect(loadUnsavedAssistantResponsesFromStorage()).toEqual([
      expect.objectContaining({
        id: "assistant-1",
        persistence_state: "failed",
      }),
    ]);

    expect(clearUnsavedAssistantResponsesForConversations(["conv-1"])).toBe(true);
    expect(loadUnsavedAssistantResponsesFromStorage()).toEqual([]);
  });

  it("round-trips a composer draft with an image and a context reference", () => {
    saveComposerDraftsToStorage({
      "conversation:conv-a": {
        text: "Inspect the screenshot and README.",
        images: [{
          id: "image-1",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,AQID",
          width: 32,
          height: 24,
          createdAt: "2026-08-29T09:00:00.000Z",
        }],
        contextRefs: [{
          id: "file:README.md",
          kind: "file",
          title: "README.md",
          path: "C:/repo/README.md",
          relativePath: "README.md",
          projectId: "project-1",
        }],
      },
    });

    expect(loadComposerDraftsFromStorage()).toEqual({
      "conversation:conv-a": {
        text: "Inspect the screenshot and README.",
        images: [expect.objectContaining({ id: "image-1", width: 32, height: 24 })],
        contextRefs: [expect.objectContaining({
          id: "file:README.md",
          kind: "file",
          relativePath: "README.md",
        })],
      },
    });
  });

  it("ignores invalid composer draft storage without throwing", () => {
    window.localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
      "conversation:valid": {
        text: "Still valid",
        images: [],
        contextRefs: [],
      },
      "conversation:invalid-image": {
        text: "Must be ignored",
        images: [{
          id: "image-1",
          mimeType: "text/plain",
          dataUrl: "javascript:alert(1)",
          createdAt: "today",
        }],
        contextRefs: [],
      },
      "conversation:invalid-ref": {
        text: "Must also be ignored",
        images: [],
        contextRefs: [{ id: "unknown", kind: "unknown", title: "Unknown" }],
      },
    }));

    expect(loadComposerDraftsFromStorage()).toEqual({
      "conversation:valid": {
        text: "Still valid",
        images: [],
        contextRefs: [],
      },
    });

    window.localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, "not-json");
    expect(loadComposerDraftsFromStorage()).toEqual({});
  });
});
