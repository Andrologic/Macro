import type {
  ChatMessage,
  ConversationQuestionnaireDraft,
  ConversationQuestionnaireState,
  PersistedContextReference,
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
export const COMPOSER_DRAFTS_STORAGE_KEY = "macro_chat_composer_drafts_v1";
export const UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY =
  "macro_chat_unsaved_assistant_responses_v1";

const MAX_COMPOSER_DRAFTS = 50;
const MAX_COMPOSER_DRAFT_TEXT_LENGTH = 200_000;
const MAX_COMPOSER_DRAFT_IMAGES = 10;
const MAX_COMPOSER_DRAFT_IMAGE_DATA_URL_LENGTH = 10_000_000;
const MAX_COMPOSER_DRAFT_CONTEXT_REFS = 50;
const MAX_UNSAVED_ASSISTANT_RESPONSES = 25;
const MAX_UNSAVED_ASSISTANT_CONTENT_LENGTH = 4_000_000;
const MAX_UNSAVED_ASSISTANT_STORAGE_LENGTH = 4_000_000;
const MAX_SHORT_FIELD_LENGTH = 4_096;

export interface PersistedComposerDraft {
  text: string;
  images: MessageImageAttachment[];
  contextRefs: PersistedContextReference[];
}

const hasLocalStorage = (): boolean => typeof window !== "undefined";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const serializeBoundedUnsavedAssistantJson = (value: unknown): string | null => {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= MAX_UNSAVED_ASSISTANT_STORAGE_LENGTH
      ? serialized
      : null;
  } catch {
    return null;
  }
};

const isBoundedString = (value: unknown, maxLength = MAX_SHORT_FIELD_LENGTH): value is string =>
  typeof value === "string" && value.length <= maxLength;

const isOptionalBoundedString = (
  value: unknown,
  maxLength = MAX_SHORT_FIELD_LENGTH,
): value is string | undefined =>
  value === undefined || isBoundedString(value, maxLength);

const isOptionalNullableBoundedString = (
  value: unknown,
  maxLength = MAX_SHORT_FIELD_LENGTH,
): value is string | null | undefined =>
  value === undefined || value === null || isBoundedString(value, maxLength);

const isFinitePositiveDimension = (value: unknown): value is number | undefined =>
  value === undefined ||
  (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100_000);

const isMessageImageAttachment = (value: unknown): value is MessageImageAttachment => {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.id) &&
    isBoundedString(value.mimeType, 256) &&
    value.mimeType.startsWith("image/") &&
    isBoundedString(value.dataUrl, MAX_COMPOSER_DRAFT_IMAGE_DATA_URL_LENGTH) &&
    value.dataUrl.startsWith(`data:${value.mimeType};base64,`) &&
    isFinitePositiveDimension(value.width) &&
    isFinitePositiveDimension(value.height) &&
    isBoundedString(value.createdAt, 128)
  );
};

const CONTEXT_REF_KINDS = new Set([
  "plan-node",
  "predicted-branch",
  "skill",
  "file",
  "source",
]);

const isSkillLocation = (value: unknown): boolean =>
  isRecord(value) &&
  (value.kind === "local" || value.kind === "remote" || value.kind === "bundled") &&
  isBoundedString(value.uri);

const isSkillSource = (value: unknown): boolean =>
  isRecord(value) &&
  (value.kind === "global" || value.kind === "project") &&
  isBoundedString(value.rootPath) &&
  isOptionalBoundedString(value.namespace) &&
  isOptionalBoundedString(value.rootId) &&
  (value.priority === undefined ||
    (typeof value.priority === "number" && Number.isFinite(value.priority))) &&
  isOptionalNullableBoundedString(value.projectId) &&
  isOptionalNullableBoundedString(value.projectName) &&
  isOptionalBoundedString(value.skillRootPath);

const isPersistedContextReference = (
  value: unknown,
): value is PersistedContextReference => {
  if (!isRecord(value)) return false;
  if (
    !isBoundedString(value.id) ||
    !isBoundedString(value.kind, 64) ||
    !CONTEXT_REF_KINDS.has(value.kind) ||
    !isBoundedString(value.title) ||
    !isOptionalBoundedString(value.subtitle) ||
    !isOptionalNullableBoundedString(value.skillFilePath) ||
    !isOptionalBoundedString(value.contentHash) ||
    !isOptionalBoundedString(value.path) ||
    !isOptionalBoundedString(value.relativePath) ||
    !isOptionalNullableBoundedString(value.projectId) ||
    !isOptionalNullableBoundedString(value.projectName) ||
    !isOptionalBoundedString(value.snippet) ||
    !isOptionalBoundedString(value.sourceLabel) ||
    !isOptionalBoundedString(value.url)
  ) {
    return false;
  }
  return (
    (value.location === undefined || isSkillLocation(value.location)) &&
    (value.source === undefined || isSkillSource(value.source))
  );
};

const parseUnsavedAssistantResponse = (value: unknown): ChatMessage | null => {
  if (!isRecord(value) || serializeBoundedUnsavedAssistantJson(value) === null) {
    return null;
  }
  if (
    !isBoundedString(value.id) ||
    !isBoundedString(value.task_id) ||
    !isBoundedString(value.conversation_id) ||
    value.role !== "assistant" ||
    !isBoundedString(value.content, MAX_UNSAVED_ASSISTANT_CONTENT_LENGTH) ||
    !isBoundedString(value.timestamp, 128) ||
    !isOptionalNullableBoundedString(value.turn_id) ||
    !isOptionalBoundedString(
      value.hidden_context,
      MAX_UNSAVED_ASSISTANT_CONTENT_LENGTH,
    ) ||
    !isOptionalBoundedString(value.persistence_error) ||
    (value.tool_traces !== undefined && !Array.isArray(value.tool_traces)) ||
    (value.provider_input_items !== undefined && !Array.isArray(value.provider_input_items)) ||
    (value.provider_turn_state !== undefined && !isRecord(value.provider_turn_state)) ||
    (value.context_refs !== undefined &&
      (!Array.isArray(value.context_refs) ||
        !value.context_refs.every(isPersistedContextReference)))
  ) {
    return null;
  }

  return {
    ...(value as unknown as ChatMessage),
    role: "assistant",
    persistence_state: "failed",
    persistence_error:
      typeof value.persistence_error === "string" && value.persistence_error.trim()
        ? value.persistence_error
        : "This response has not been saved.",
  };
};

export const loadUnsavedAssistantResponsesFromStorage = (): ChatMessage[] => {
  if (!hasLocalStorage()) return [];
  try {
    const raw = window.localStorage.getItem(
      UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY,
    );
    if (!raw) return [];
    if (raw.length > MAX_UNSAVED_ASSISTANT_STORAGE_LENGTH) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return [];
    return Object.values(parsed)
      .slice(0, MAX_UNSAVED_ASSISTANT_RESPONSES)
      .map(parseUnsavedAssistantResponse)
      .filter((message): message is ChatMessage => message !== null);
  } catch {
    return [];
  }
};

const writeUnsavedAssistantResponsesToStorage = (
  messages: ChatMessage[],
): boolean => {
  if (!hasLocalStorage()) return false;
  try {
    if (messages.length === 0) {
      window.localStorage.removeItem(UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY);
      return true;
    }
    const serialized = serializeBoundedUnsavedAssistantJson(
      Object.fromEntries(messages.map((message) => [message.id, message])),
    );
    if (serialized === null) return false;
    window.localStorage.setItem(UNSAVED_ASSISTANT_RESPONSES_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
};

export const saveUnsavedAssistantResponseToStorage = (
  message: ChatMessage,
): boolean => {
  const existing = loadUnsavedAssistantResponsesFromStorage().filter(
    (candidate) => candidate.id !== message.id,
  );
  const failedMessage = parseUnsavedAssistantResponse({
    ...message,
    persistence_state: "failed",
  });
  if (!failedMessage) return false;
  return writeUnsavedAssistantResponsesToStorage(
    [...existing, failedMessage]
      .sort(
        (left, right) =>
          new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
      )
      .slice(-MAX_UNSAVED_ASSISTANT_RESPONSES),
  );
};

export const removeUnsavedAssistantResponseFromStorage = (
  messageId: string,
): boolean =>
  writeUnsavedAssistantResponsesToStorage(
    loadUnsavedAssistantResponsesFromStorage().filter(
      (message) => message.id !== messageId,
    ),
  );

export const clearUnsavedAssistantResponsesForConversations = (
  conversationIds: string[],
): boolean => {
  const ids = new Set(conversationIds);
  return writeUnsavedAssistantResponsesToStorage(
    loadUnsavedAssistantResponsesFromStorage().filter(
      (message) => !ids.has(message.conversation_id),
    ),
  );
};

const parseComposerDraft = (value: unknown): PersistedComposerDraft | null => {
  if (!isRecord(value)) return null;
  if (
    !isBoundedString(value.text, MAX_COMPOSER_DRAFT_TEXT_LENGTH) ||
    !Array.isArray(value.images) ||
    value.images.length > MAX_COMPOSER_DRAFT_IMAGES ||
    !value.images.every(isMessageImageAttachment) ||
    !Array.isArray(value.contextRefs) ||
    value.contextRefs.length > MAX_COMPOSER_DRAFT_CONTEXT_REFS ||
    !value.contextRefs.every(isPersistedContextReference)
  ) {
    return null;
  }
  return {
    text: value.text,
    images: value.images.map((image) => ({ ...image })),
    contextRefs: value.contextRefs.map((ref) => ({ ...ref })),
  };
};

export const loadComposerDraftsFromStorage = (): Record<
  string,
  PersistedComposerDraft
> => {
  if (!hasLocalStorage()) return {};
  try {
    const raw = window.localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const drafts: Array<[string, PersistedComposerDraft]> = [];
    for (const [contextKey, value] of Object.entries(parsed)) {
      if (drafts.length >= MAX_COMPOSER_DRAFTS) break;
      if (!contextKey || contextKey.length > MAX_SHORT_FIELD_LENGTH) continue;
      const draft = parseComposerDraft(value);
      if (draft) drafts.push([contextKey, draft]);
    }
    return Object.fromEntries(drafts);
  } catch {
    return {};
  }
};

export const saveComposerDraftsToStorage = (
  draftsByContextKey: Record<string, PersistedComposerDraft>,
): void => {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(
      COMPOSER_DRAFTS_STORAGE_KEY,
      JSON.stringify(draftsByContextKey),
    );
  } catch {
    // Keep the in-memory draft when local storage is unavailable or full.
  }
};

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
