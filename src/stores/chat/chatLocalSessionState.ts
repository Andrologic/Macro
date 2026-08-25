import type {
  ConversationQuestionnaireDraft,
  ConversationQuestionnaireState,
} from "../../types";

export interface MessageImageAttachment {
  id: string;
  mimeType: string;
  dataUrl: string;
  width?: number;
  height?: number;
  createdAt: string;
}

export const EMPTY_MESSAGE_IMAGES: MessageImageAttachment[] = [];

const MESSAGE_IMAGES_STORAGE_KEY = "macro_chat_message_images";
const QUESTIONNAIRE_DRAFTS_STORAGE_KEY = "macro_chat_questionnaire_drafts";

const hasLocalStorage = (): boolean => typeof window !== "undefined";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isQuestionnaireDraft = (
  value: unknown,
): value is ConversationQuestionnaireDraft => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.mode === undefined ||
      value.mode === "pending_reply" ||
      value.mode === "editing_response") &&
    typeof value.assistantMessageId === "string" &&
    (value.responseMessageId === undefined ||
      typeof value.responseMessageId === "string") &&
    typeof value.currentStepIndex === "number" &&
    isRecord(value.answersByStepId) &&
    isRecord(value.draftTextByStepId)
  );
};

export const loadQuestionnaireDraftsFromStorage = (): Record<
  string,
  ConversationQuestionnaireDraft
> => {
  if (!hasLocalStorage()) return {};
  try {
    const raw = window.localStorage.getItem(QUESTIONNAIRE_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) =>
        isQuestionnaireDraft(value),
      ),
    ) as Record<string, ConversationQuestionnaireDraft>;
  } catch {
    return {};
  }
};

export const saveQuestionnaireDraftsToStorage = (
  draftsByConversationId: Record<string, ConversationQuestionnaireDraft>,
) => {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(
      QUESTIONNAIRE_DRAFTS_STORAGE_KEY,
      JSON.stringify(draftsByConversationId),
    );
  } catch {
    // Ignore storage errors.
  }
};

export const loadMessageImagesFromStorage = (): Record<
  string,
  MessageImageAttachment[]
> => {
  if (!hasLocalStorage()) return {};
  try {
    const raw = window.localStorage.getItem(MESSAGE_IMAGES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    return parsed as Record<string, MessageImageAttachment[]>;
  } catch {
    return {};
  }
};

export const saveMessageImagesToStorage = (
  imagesByMessageId: Record<string, MessageImageAttachment[]>,
) => {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(
      MESSAGE_IMAGES_STORAGE_KEY,
      JSON.stringify(imagesByMessageId),
    );
  } catch {
    // Ignore storage errors.
  }
};

export const setQuestionnaireDraftForConversation = (
  draftsByConversationId: Record<string, ConversationQuestionnaireDraft>,
  conversationId: string,
  draft: ConversationQuestionnaireDraft,
): Record<string, ConversationQuestionnaireDraft> => ({
  ...draftsByConversationId,
  [conversationId]: draft,
});

export const clearQuestionnaireDraftsForConversations = (
  draftsByConversationId: Record<string, ConversationQuestionnaireDraft>,
  conversationIds: string[],
): Record<string, ConversationQuestionnaireDraft> => {
  if (conversationIds.length === 0) {
    return draftsByConversationId;
  }
  const next = { ...draftsByConversationId };
  conversationIds.forEach((conversationId) => {
    delete next[conversationId];
  });
  return next;
};

export const setActiveQuestionnaireDraftStep = (
  draftsByConversationId: Record<string, ConversationQuestionnaireDraft>,
  activeQuestionnaire: ConversationQuestionnaireState,
  stepIndex: number,
): Record<string, ConversationQuestionnaireDraft> =>
  setQuestionnaireDraftForConversation(
    draftsByConversationId,
    activeQuestionnaire.conversationId,
    {
      mode: activeQuestionnaire.mode,
      assistantMessageId: activeQuestionnaire.assistantMessageId,
      responseMessageId: activeQuestionnaire.responseMessageId,
      currentStepIndex: stepIndex,
      answersByStepId: { ...activeQuestionnaire.answersByStepId },
      draftTextByStepId: { ...activeQuestionnaire.draftTextByStepId },
    },
  );
