import type {
  ChatMessage,
  ConversationQuestionnaireDraft,
  ConversationQuestionnaireState,
  QuestionnairePayload,
  QuestionnaireResponseSummary,
  QuestionStep,
} from "../types";
import { parseMessageQuickReplies } from "./chatQuickReplies";

const QUESTIONNAIRE_CONTEXT_BLOCK_PATTERN =
  /<questionnaire_context>\s*([\s\S]*?)\s*<\/questionnaire_context>/i;
const QUESTIONNAIRE_RESPONSE_CONTEXT_BLOCK_PATTERN =
  /<questionnaire_response_context>\s*([\s\S]*?)\s*<\/questionnaire_response_context>/i;

export const QUESTION_TOOL_MAX_QUESTIONS = 5;
export const DEFAULT_QUESTIONNAIRE_INTRO =
  "I need a few clarifications before I continue.";
const DEFAULT_QUESTIONNAIRE_EMPTY_ANSWER = "No answer provided";

export interface ParsedAssistantQuestionnaireState {
  content: string;
  questionnaire?: QuestionnairePayload;
  requiresUserReply: boolean;
}

export interface ParsedUserQuestionnaireResponseState {
  content: string;
  questionnaireResponseSummary?: QuestionnaireResponseSummary;
}

const normalizeNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeQuestionStep = (rawStep: unknown, index: number): QuestionStep => {
  const step =
    rawStep && typeof rawStep === "object"
      ? (rawStep as Record<string, unknown>)
      : {};
  const id = normalizeNonEmptyString(step.id) ?? `question-${index + 1}`;
  const prompt = normalizeNonEmptyString(step.prompt);
  if (!prompt) {
    throw new Error(`Question ${index + 1} is missing a prompt.`);
  }

  if (!Array.isArray(step.choices) || step.choices.length !== 3) {
    throw new Error(
      `Question ${index + 1} must define exactly 3 suggested choices.`,
    );
  }

  const normalizedChoices = step.choices.map((choice, choiceIndex) => {
    const normalized = normalizeNonEmptyString(choice);
    if (!normalized) {
      throw new Error(
        `Question ${index + 1} choice ${choiceIndex + 1} must be a non-empty string.`,
      );
    }
    return normalized;
  }) as [string, string, string];

  return {
    id,
    prompt,
    choices: normalizedChoices,
    free_text_placeholder: normalizeNonEmptyString(step.free_text_placeholder) ?? undefined,
  };
};

const normalizeQuestionnairePayload = (
  raw: unknown,
  source: QuestionnairePayload["source"],
): QuestionnairePayload => {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawQuestions = Array.isArray(value.questions) ? value.questions : [];

  if (rawQuestions.length === 0) {
    throw new Error("Questionnaire payload must contain at least one question.");
  }
  if (rawQuestions.length > QUESTION_TOOL_MAX_QUESTIONS) {
    throw new Error(
      `Questionnaire payload cannot contain more than ${QUESTION_TOOL_MAX_QUESTIONS} questions.`,
    );
  }

  const questions = rawQuestions.map((question, index) =>
    normalizeQuestionStep(question, index),
  );
  const uniqueIds = new Set(questions.map((question) => question.id));
  if (uniqueIds.size !== questions.length) {
    throw new Error("Questionnaire question ids must be unique.");
  }

  return {
    intro: normalizeNonEmptyString(value.intro) ?? undefined,
    questions,
    source,
  };
};

export const validateQuestionToolArgs = (
  args: Record<string, unknown>,
): QuestionnairePayload => normalizeQuestionnairePayload(args, "tool");

export const buildQuestionnaireHiddenContextBlock = (
  payload: QuestionnairePayload,
): string => {
  return `<questionnaire_context>\n${JSON.stringify(payload)}\n</questionnaire_context>`;
};

const normalizeQuestionnaireResponseSummary = (
  raw: unknown,
): QuestionnaireResponseSummary => {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const assistantMessageId =
    normalizeNonEmptyString(value.assistantMessageId) ?? "unknown-assistant-message";
  const source =
    value.source === "tool" || value.source === "legacy_quick_replies"
      ? value.source
      : undefined;
  const originToolCallId = normalizeNonEmptyString(value.originToolCallId) ?? undefined;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems
    .map((rawItem, index) => {
      const item =
        rawItem && typeof rawItem === "object"
          ? (rawItem as Record<string, unknown>)
          : {};
      const prompt = normalizeNonEmptyString(item.prompt);
      const answer = normalizeNonEmptyString(item.answer);
      if (!prompt || !answer) {
        return null;
      }

      return {
        id: normalizeNonEmptyString(item.id) ?? `question-${index + 1}`,
        prompt,
        answer,
      };
    })
    .filter((item): item is QuestionnaireResponseSummary["items"][number] => item !== null);

  if (items.length === 0) {
    throw new Error("Questionnaire response summary must contain at least one answer.");
  }

  return {
    assistantMessageId,
    source,
    ...(originToolCallId ? { originToolCallId } : {}),
    items,
  };
};

export const parseQuestionnairePayloadFromHiddenContext = (
  hiddenContext?: string,
): QuestionnairePayload | undefined => {
  if (!hiddenContext) {
    return undefined;
  }

  const match = hiddenContext.match(QUESTIONNAIRE_CONTEXT_BLOCK_PATTERN);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    return normalizeQuestionnairePayload(JSON.parse(match[1]), "tool");
  } catch {
    return undefined;
  }
};

export const buildQuestionnaireResponseSummary = (
  assistantMessageId: string,
  payload: QuestionnairePayload,
  answersByStepId: Record<string, string>,
  options?: {
    originToolCallId?: string;
  },
): QuestionnaireResponseSummary => {
  const items = payload.questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    answer:
      normalizeNonEmptyString(answersByStepId[question.id]) ??
      DEFAULT_QUESTIONNAIRE_EMPTY_ANSWER,
  }));

  return {
    assistantMessageId,
    source: payload.source,
    ...(options?.originToolCallId ? { originToolCallId: options.originToolCallId } : {}),
    items,
  };
};

export const buildQuestionnaireResponseHiddenContextBlock = (
  summary: QuestionnaireResponseSummary,
): string =>
  `<questionnaire_response_context>\n${JSON.stringify(summary)}\n</questionnaire_response_context>`;

export const parseQuestionnaireResponseSummaryFromHiddenContext = (
  hiddenContext?: string,
): QuestionnaireResponseSummary | undefined => {
  if (!hiddenContext) {
    return undefined;
  }

  const match = hiddenContext.match(QUESTIONNAIRE_RESPONSE_CONTEXT_BLOCK_PATTERN);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    return normalizeQuestionnaireResponseSummary(JSON.parse(match[1]));
  } catch {
    return undefined;
  }
};

export const normalizeLegacyQuickRepliesToQuestionnaire = (
  content: string,
): QuestionnairePayload | undefined => {
  const parsed = parseMessageQuickReplies(content);
  if (!parsed.requiresUserReply || !parsed.choices || parsed.choices.length !== 3) {
    return undefined;
  }

  return {
    questions: [
      {
        id: "legacy-quick-replies",
        prompt:
          parsed.content.trim() || "Choose one of the suggested options to continue.",
        choices: [
          parsed.choices[0]!.text,
          parsed.choices[1]!.text,
          parsed.choices[2]!.text,
        ],
      },
    ],
    source: "legacy_quick_replies",
  };
};

export const parseAssistantQuestionnaireState = (
  content: string,
  hiddenContext?: string,
): ParsedAssistantQuestionnaireState => {
  const structuredQuestionnaire =
    parseQuestionnairePayloadFromHiddenContext(hiddenContext);
  if (structuredQuestionnaire) {
    return {
      content: content.trim(),
      questionnaire: structuredQuestionnaire,
      requiresUserReply: true,
    };
  }

  const parsedQuickReplies = parseMessageQuickReplies(content);
  const legacyQuestionnaire = normalizeLegacyQuickRepliesToQuestionnaire(content);
  return {
    content: parsedQuickReplies.content,
    questionnaire: legacyQuestionnaire,
    requiresUserReply: Boolean(legacyQuestionnaire),
  };
};

export const parseUserQuestionnaireResponseState = (
  content: string,
  hiddenContext?: string,
): ParsedUserQuestionnaireResponseState => {
  const questionnaireResponseSummary =
    parseQuestionnaireResponseSummaryFromHiddenContext(hiddenContext);

  return {
    content:
      normalizeNonEmptyString(content) ??
      (questionnaireResponseSummary
        ? buildQuestionnaireResponseVisibleContent(questionnaireResponseSummary)
        : ""),
    questionnaireResponseSummary,
  };
};

export const buildQuestionnaireAggregatedResponse = (
  payload: QuestionnairePayload,
  answersByStepId: Record<string, string>,
): string => {
  return payload.questions
    .map((question) => {
      const answer =
        normalizeNonEmptyString(answersByStepId[question.id]) ??
        DEFAULT_QUESTIONNAIRE_EMPTY_ANSWER;
      return `${question.prompt}: ${answer}`;
    })
    .join("\n");
};

export const buildQuestionnaireResponseVisibleContent = (
  summary: QuestionnaireResponseSummary,
): string =>
  summary.items.map((item) => `${item.prompt}: ${item.answer}`).join("\n");

export const buildQuestionnaireResponseToolOutput = (
  summary: QuestionnaireResponseSummary,
): string => {
  const lines = ["Questionnaire responses:"];
  summary.items.forEach((item) => {
    lines.push(`- ${item.prompt}: ${item.answer}`);
  });
  return lines.join("\n");
};

export const buildQuestionnaireFunctionCallOutputItem = (
  summary: QuestionnaireResponseSummary,
): unknown | undefined => {
  if (!summary.originToolCallId) {
    return undefined;
  }

  return {
    type: "function_call_output",
    call_id: summary.originToolCallId,
    output: buildQuestionnaireResponseToolOutput(summary),
  };
};

export const extractQuestionToolCallIdFromProviderInputItems = (
  items?: unknown[] | null,
): string | undefined => {
  if (!Array.isArray(items) || items.length === 0) {
    return undefined;
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || typeof item !== "object") {
      continue;
    }

    const callId =
      "call_id" in item && typeof item.call_id === "string" ? item.call_id : null;
    const type = "type" in item && typeof item.type === "string" ? item.type : null;
    const name = "name" in item && typeof item.name === "string" ? item.name : null;

    if (type === "function_call" && name === "question" && callId) {
      return callId;
    }
  }

  return undefined;
};

export const resolveActiveConversationQuestionnaire = (
  conversationId: string,
  messages: ChatMessage[],
  draft?: ConversationQuestionnaireDraft,
): ConversationQuestionnaireState | null => {
  let activeQuestionnaireMessage: ChatMessage | null = null;
  let sawUserReplyAfterQuestionnaire = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      sawUserReplyAfterQuestionnaire = true;
      continue;
    }
    if (!message.questionnaire) {
      continue;
    }
    if (!sawUserReplyAfterQuestionnaire) {
      activeQuestionnaireMessage = message;
      break;
    }
  }

  if (!activeQuestionnaireMessage?.questionnaire) {
    return null;
  }

  const questionnaire = activeQuestionnaireMessage.questionnaire;
  const questionCount = questionnaire.questions.length;
  if (questionCount === 0) {
    return null;
  }

  const safeDraft =
    draft?.assistantMessageId === activeQuestionnaireMessage.id ? draft : undefined;
  const currentStepIndex = Math.min(
    Math.max(safeDraft?.currentStepIndex ?? 0, 0),
    questionCount - 1,
  );
  const currentStep = questionnaire.questions[currentStepIndex]!;

  return {
    conversationId,
    taskId: activeQuestionnaireMessage.task_id || null,
    assistantMessageId: activeQuestionnaireMessage.id,
    originToolCallId: extractQuestionToolCallIdFromProviderInputItems(
      activeQuestionnaireMessage.provider_input_items,
    ),
    questionnaire,
    currentStepIndex,
    currentStep,
    answersByStepId: { ...(safeDraft?.answersByStepId ?? {}) },
    draftTextByStepId: { ...(safeDraft?.draftTextByStepId ?? {}) },
    totalSteps: questionCount,
    isLastStep: currentStepIndex === questionCount - 1,
  };
};
