import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type {
  ConversationQuestionnaireDraft,
  ConversationQuestionnaireState,
} from "../../types";
import {
  clearQuestionnaireDraftsForConversations,
  loadMessageImagesFromStorage,
  loadQuestionnaireDraftsFromStorage,
  saveMessageImagesToStorage,
  saveQuestionnaireDraftsToStorage,
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
});
